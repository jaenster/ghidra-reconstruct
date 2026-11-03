/**
 * Offset Induction Index Plugin
 *
 * VC8 strength-reduces a loop that walks two arrays with one index. The source
 *
 *   for (i = 0; i < (sgptDataTable->nTxtStatesSize + 31) / 32; i++)
 *     if (pStatesData->nStateBitmask[i] & pFlags[i]) return 1;
 *
 * compiles to one pointer that steps, and the second array reached from it through
 * the constant distance between the two (`SUB EDI, EBX` ... `MOV EDX, [EDI + ECX]`).
 * Ghidra prints that machine form back (STATES_HasMatchingStateFlag, 0063a130):
 *
 *   nStateOffset = nStateFlags - (int)pStatesData;
 *   do {
 *     if (pStatesData->nStateBitmask[0] & *(uint *)(nStateOffset + (int)pStatesData)) ...
 *     i = i + 1;
 *     pStatesData = (D2StatesDataTbls *)((int)pStatesData + 4);
 *   } while (i < nDwordCount);
 *
 * Compiled again, the printed form makes VC8 pick other registers for the function and
 * for every caller of it. This pass writes the indexed loop back.
 *
 * A loop is rewritten only when the indexed form has the same value at every access:
 *
 *  - the loop is a do-while whose body is a block with no `continue` of its own and no
 *    label, so every iteration runs each top-level statement of the body in order;
 *  - a counter `c` is stepped by one, once, by a top-level statement of the body, is
 *    written nowhere else in the loop, and enters the loop with one constant value c0
 *    (the only definition outside the loop that reaches it). A counter that counts down
 *    from a constant N > 0 to zero (`c--; } while (c != 0)`) and is read nowhere but by
 *    its own step and test, inside the loop or after it, first becomes `c = 0 ...
 *    c++; } while (c < N)`: the loop runs the same N times;
 *  - a pointer `P` is stepped by a constant byte stride S, once, by a top-level
 *    statement of the body, and is written nowhere else in the loop; no read after the
 *    loop sees a stepped value (every use of the step's definition is inside the loop);
 *  - every `off` read as `off + (int)P` is reached only by one definition
 *    `off = X - (int)P` outside the loop, between which and the loop P is not written,
 *    X is a local, a parameter or an address constant that nothing in the loop or on the
 *    way into it writes, and every use of that definition is such a sum;
 *  - neither P, c, off nor X has its address taken.
 *
 * Then in iteration k (from 0) P holds P0 + k*S before its step and P0 + (k+1)*S after
 * it, and c holds c0 + k before its step and c0 + k + 1 after it; so at a top-level
 * statement t, P - P0 is S * (c - c0 - [t after c's step] + [t after P's step]). The
 * sum `off + (int)P` is X + that, and P itself is P0 + that, where P0 is P with its step
 * deleted. Each access is rewritten through the access type's size, which must divide S:
 *
 *   *(T *)(off + (int)P)   ->  ((T *)X)[j]          (X itself where it is a T *)
 *   (T *)(off + (int)P)    ->  &((T *)X)[j]
 *   *P, P->f, P[k], P      ->  P[j], P[j].f, P[k + j], (P + j)      S = n * sizeof(*P)
 *   P->a[k]                ->  P->a[k + j]                          S = n * sizeof(a[0])
 *
 * The definition of `off` and the step of P go.
 *
 * The bound. VC8 computes a loop-invariant bound once, in a register; Ghidra prints it
 * as a variable set ahead of the loop (`nDwordCount = ...; nDwordCount = nDwordCount /
 * 32;`) or recomputed in the body just before the test. The source spelled it in the
 * test, and the variable form makes VC8 hold one more value and pick other registers.
 * A variable read by the loop test (and the guard ahead of the loop) is replaced by the
 * expression it holds when that expression has no side effects, every use of the
 * definition(s) is that test or guard, and nothing writes what it reads on the way to
 * the test or anywhere around the loop (memory reads are only kept if the loop and the
 * way into it neither call nor store).
 *
 * The for loop. `c = c0; if (G) { do { B; c++; } while (c < E); }`, G being `c0 < E`,
 * and `c = c0; do { B; c++; } while (c < K)`, c0 < K constants, are `for (c = c0; c <
 * E; c++) { B }`: the for loop runs the same test at the same point. Other loops stay
 * do-while loops, indexed.
 *
 * String copies (`do { ch = *P; *(char *)(off + (int)P) = ch; P++; } while (ch)`) have no
 * counter and are not touched: VC8 inlined them from strcpy, not from a loop.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CompoundStmt, CStyleCastExpr, DeclStmt, DoWhileStmt, Expression,
  ExprStmt, ForStmt, FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, MemberExpr, ParameterDecl,
  ParenExpr, PostfixExpr, Statement, SubscriptExpr, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { emit } from '../../../emit/index.js';
import { cloneNode, createTransformer, nodesEqual, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { buildFunctionFlow, ENTRY_DEF, type FunctionFlow } from '../../cfg/index.js';

export interface OffsetInductionIndexOptions extends PluginOptions {
  /** Aggregate name -> its fields in offset order. */
  structLayouts?: Record<string, Array<{ name: string; offset: number; size: number; type: string; bitSize?: number }>>;
  /** Aggregate name -> size in bytes. */
  aggregateSizes?: Record<string, number>;
  /** Typedef name -> what it stands for. */
  typedefTargets?: Record<string, string>;
  /** Parameter and enclosing names -> declared spelling. */
  enclosingVarTypes?: Record<string, string>;
}

// ============================================
// TYPES AND SIZES
// ============================================

const SCALAR_SIZE: Record<string, number> = {
  'char': 1, 'signed char': 1, 'unsigned char': 1, 'bool': 1, 'int8_t': 1, 'uint8_t': 1, 'byte': 1, 'BYTE': 1,
  'undefined': 1, 'undefined1': 1, 'CHAR': 1, 'UCHAR': 1, 'BOOLEAN': 1,
  'short': 2, 'unsigned short': 2, 'wchar_t': 2, 'int16_t': 2, 'uint16_t': 2, 'WORD': 2, 'ushort': 2,
  'undefined2': 2, 'SHORT': 2, 'USHORT': 2, 'WCHAR': 2,
  'int': 4, 'unsigned int': 4, 'long': 4, 'unsigned long': 4, 'int32_t': 4, 'uint32_t': 4, 'uint': 4,
  'DWORD': 4, 'BOOL': 4, 'LONG': 4, 'ULONG': 4, 'UINT': 4, 'INT': 4, 'float': 4, 'undefined4': 4,
  'intptr_t': 4, 'uintptr_t': 4, 'size_t': 4, 'ulong': 4,
  'long long': 8, 'unsigned long long': 8, 'int64_t': 8, 'uint64_t': 8, 'double': 8, 'undefined8': 8,
  'QWORD': 8, 'LONGLONG': 8, 'ULONGLONG': 8, '__int64': 8,
};

/** Integer types a pointer is cast to for byte arithmetic. */
const ADDRESS_INTS = new Set(['int', 'unsigned int', 'uint', 'int32_t', 'uint32_t', 'intptr_t', 'uintptr_t', 'DWORD', 'long', 'unsigned long', 'ulong', 'LONG', 'ULONG', 'UINT']);
/** Integer types a counter may have. */
const COUNTER_INTS = new Set(['int', 'unsigned int', 'uint', 'int32_t', 'uint32_t', 'DWORD', 'long', 'unsigned long', 'short', 'unsigned short', 'int16_t', 'uint16_t', 'char', 'signed char', 'unsigned char', 'uint8_t', 'int8_t', 'BYTE', 'WORD', 'size_t', 'ulong', 'ushort', 'byte', 'UINT', 'LONG', 'ULONG']);

const normSpelling = (s: string): string => s.replace(/\s+/g, ' ').replace(/\s*\*/g, '*').replace(/^(const|volatile) /, '').replace(/^(struct|union|enum|class) /, '').trim();
const typeSpelling = (t: TypeNode): string => normSpelling(emit(t as unknown as Parameters<typeof emit>[0]));

interface Ctx {
  layouts: NonNullable<OffsetInductionIndexOptions['structLayouts']>;
  sizes: Record<string, number>;
  typedefs: Record<string, string>;
}

function resolve(ctx: Ctx, s: string): string {
  let cur = normSpelling(s);
  for (let i = 0; i < 8; i++) {
    const t = ctx.typedefs[cur] ?? ctx.typedefs[cur.split('::').pop()!];
    if (!t) break;
    cur = normSpelling(t);
  }
  return cur;
}

function sizeOf(ctx: Ctx, spelling: string): number | null {
  const s = resolve(ctx, spelling);
  if (s.endsWith('*')) return 4;
  const arr = /^(.*)\[(\d+|0x[0-9a-fA-F]+)\]$/.exec(s);
  if (arr) {
    const e = sizeOf(ctx, arr[1]);
    return e === null ? null : e * Number(arr[2]);
  }
  if (SCALAR_SIZE[s] !== undefined) return SCALAR_SIZE[s];
  const bare = s.split('::').pop()!;
  if (SCALAR_SIZE[bare] !== undefined) return SCALAR_SIZE[bare];
  const agg = ctx.sizes[s] ?? ctx.sizes[bare];
  return typeof agg === 'number' && agg > 0 ? agg : null;
}

/** The pointee spelling of a pointer spelling, or null. */
function pointee(ctx: Ctx, spelling: string): string | null {
  const s = resolve(ctx, spelling);
  return s.endsWith('*') ? normSpelling(s.slice(0, -1)) : null;
}

/** The element spelling of an array field `f` of aggregate `agg`, or null. */
function arrayFieldElement(ctx: Ctx, agg: string, field: string): string | null {
  const a = resolve(ctx, agg);
  const fields = ctx.layouts[a] ?? ctx.layouts[a.split('::').pop()!];
  const f = fields?.find(x => x.name === field);
  if (!f || f.bitSize !== undefined) return null;
  const m = /^(.*)\[(\d+|0x[0-9a-fA-F]+)\]$/.exec(normSpelling(f.type));
  return m ? normSpelling(m[1]) : null;
}

// ============================================
// EXPRESSION HELPERS
// ============================================

function strip(e: Expression): Expression {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as ParenExpr).expression;
  return x;
}

function identName(e: Expression | null | undefined): string | null {
  if (!e) return null;
  const x = strip(e);
  return x.kind === NodeKind.Identifier ? (x as Identifier).name : null;
}

function literalValue(e: Expression | null | undefined): bigint | null {
  if (!e) return null;
  const x = strip(e);
  if (x.kind === NodeKind.IntegerLiteral) return (x as IntegerLiteralExpr).value;
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
    const v = literalValue((x as UnaryExpr).operand);
    return v === null ? null : -v;
  }
  return null;
}

/** `(int)name` (any address-sized integer cast) -> name. */
function intCastOf(e: Expression): string | null {
  const x = strip(e);
  if (x.kind !== NodeKind.CStyleCastExpr) return null;
  const c = x as CStyleCastExpr;
  if (!ADDRESS_INTS.has(typeSpelling(c.type))) return null;
  return identName(c.expression);
}

/** `off + (int)P` or `(int)P + off` -> { off, P }. */
function offsetSum(e: Expression): { off: string; ptr: string } | null {
  const x = strip(e);
  if (x.kind !== NodeKind.BinaryExpr || (x as BinaryExpr).operator !== '+') return null;
  const b = x as BinaryExpr;
  const lo = identName(b.left), rp = intCastOf(b.right);
  if (lo && rp) return { off: lo, ptr: rp };
  const ro = identName(b.right), lp = intCastOf(b.left);
  if (ro && lp) return { off: ro, ptr: lp };
  return null;
}

function walk(n: unknown, fn: (node: ASTNode, parent: ASTNode | null, key: string) => void, parent: ASTNode | null = null, key = ''): void {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { for (const c of n) walk(c, fn, parent, key); return; }
  const node = n as ASTNode;
  if (typeof (node as { kind?: unknown }).kind !== 'string') return;
  fn(node, parent, key);
  for (const k of Object.keys(node)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
    const v = (node as unknown as Record<string, unknown>)[k];
    if (v && typeof v === 'object') walk(v, fn, node, k);
  }
}

function identifiersIn(n: unknown, name?: string): Identifier[] {
  const out: Identifier[] = [];
  walk(n, (node, parent, key) => {
    if (node.kind !== NodeKind.Identifier || (name !== undefined && (node as Identifier).name !== name)) return;
    // A member name or a qualifier segment is not a variable.
    if (parent && ((parent.kind === NodeKind.MemberExpr && key === 'member') || parent.kind === NodeKind.QualifiedId)) return;
    out.push(node as Identifier);
  });
  return out;
}

/** Side-effect free: no call, assignment, increment, comma or `new`. */
function isPure(e: unknown): boolean {
  let ok = true;
  walk(e, node => {
    switch (node.kind) {
      case NodeKind.CallExpr: case NodeKind.AssignExpr: case NodeKind.PostfixExpr: case NodeKind.CommaExpr:
      case NodeKind.NewExpr: case NodeKind.DeleteExpr: case NodeKind.LambdaExpr:
        ok = false; break;
      case NodeKind.UnaryExpr: {
        const op = (node as UnaryExpr).operator;
        if (op === '++' || op === '--') ok = false;
        break;
      }
      default: break;
    }
  });
  return ok;
}

const LOOP_KINDS = new Set<string>([NodeKind.ForStmt, NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForRangeStmt]);

/**
 * A `continue` of the loop `body` belongs to, any label, or a case label of a switch
 * outside `body`: each enters or leaves an iteration somewhere other than its ends.
 */
function hasOwnContinueOrLabel(body: unknown): boolean {
  let found = false;
  const visit = (x: unknown, inLoop: boolean, inSwitch: boolean): void => {
    if (found || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) { for (const c of x) visit(c, inLoop, inSwitch); return; }
    const node = x as ASTNode;
    if (typeof (node as { kind?: unknown }).kind !== 'string') return;
    if (node.kind === NodeKind.LabelStmt || (node.kind === NodeKind.ContinueStmt && !inLoop) ||
        ((node.kind === NodeKind.CaseStmt || node.kind === NodeKind.DefaultStmt) && !inSwitch)) { found = true; return; }
    const loop = inLoop || LOOP_KINDS.has(node.kind);
    const sw = inSwitch || node.kind === NodeKind.SwitchStmt;
    for (const k of Object.keys(node)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      visit((node as unknown as Record<string, unknown>)[k], loop, sw);
    }
  };
  visit(body, false, false);
  return found;
}

/** A self step of `v` by +-1, or null. */
function counterStep(st: Statement): { name: string; delta: 1 | -1 } | null {
  if (st.kind !== NodeKind.ExprStmt) return null;
  const e = strip((st as ExprStmt).expression);
  if (e.kind === NodeKind.PostfixExpr || (e.kind === NodeKind.UnaryExpr && ['++', '--'].includes((e as UnaryExpr).operator))) {
    const op = (e as PostfixExpr | UnaryExpr).operator;
    const n = identName((e as PostfixExpr).operand);
    return n ? { name: n, delta: op === '++' ? 1 : -1 } : null;
  }
  if (e.kind === NodeKind.AssignExpr) {
    const a = e as AssignExpr;
    const n = identName(a.left);
    if (!n) return null;
    if ((a.operator === '+=' || a.operator === '-=') && literalValue(a.right) === 1n) return { name: n, delta: a.operator === '+=' ? 1 : -1 };
    if (a.operator === '=') {
      const r = strip(a.right);
      if (r.kind !== NodeKind.BinaryExpr) return null;
      const b = r as BinaryExpr;
      if (b.operator === '+' && identName(b.left) === n && literalValue(b.right) === 1n) return { name: n, delta: 1 };
      if (b.operator === '+' && identName(b.right) === n && literalValue(b.left) === 1n) return { name: n, delta: 1 };
      if (b.operator === '-' && identName(b.left) === n && literalValue(b.right) === 1n) return { name: n, delta: -1 };
      if (b.operator === '+' && identName(b.left) === n && literalValue(b.right) === -1n) return { name: n, delta: -1 };
    }
  }
  return null;
}

/** A pointer step of a pointer-typed local by a constant: its byte stride, or null. */
function pointerStep(ctx: Ctx, st: Statement, typeOf: (n: string) => string | undefined): { name: string; stride: number } | null {
  if (st.kind !== NodeKind.ExprStmt) return null;
  const e = strip((st as ExprStmt).expression);
  const elemOf = (n: string): number | null => {
    const t = typeOf(n);
    const p = t ? pointee(ctx, t) : null;
    return p ? sizeOf(ctx, p) : null;
  };
  if (e.kind === NodeKind.PostfixExpr || (e.kind === NodeKind.UnaryExpr && ['++', '--'].includes((e as UnaryExpr).operator))) {
    const op = (e as PostfixExpr | UnaryExpr).operator;
    const n = identName((e as PostfixExpr).operand);
    if (!n) return null;
    const sz = elemOf(n);
    return sz ? { name: n, stride: op === '++' ? sz : -sz } : null;
  }
  if (e.kind !== NodeKind.AssignExpr) return null;
  const a = e as AssignExpr;
  const n = identName(a.left);
  if (!n) return null;
  if (a.operator === '+=' || a.operator === '-=') {
    const k = literalValue(a.right);
    const sz = elemOf(n);
    if (k === null || !sz) return null;
    return { name: n, stride: Number(k) * sz * (a.operator === '+=' ? 1 : -1) };
  }
  if (a.operator !== '=') return null;
  let r = strip(a.right);
  // P = (T *)((int)P + k): byte arithmetic, cast back to P's own type.
  if (r.kind === NodeKind.CStyleCastExpr) {
    const c = r as CStyleCastExpr;
    const t = typeOf(n);
    if (!t || resolve(ctx, typeSpelling(c.type)) !== resolve(ctx, t)) return null;
    const inner = strip(c.expression);
    if (inner.kind !== NodeKind.BinaryExpr) return null;
    const b = inner as BinaryExpr;
    if (b.operator !== '+' && b.operator !== '-') return null;
    if (intCastOf(b.left) !== n) return null;
    const k = literalValue(b.right);
    if (k === null) return null;
    return { name: n, stride: Number(k) * (b.operator === '+' ? 1 : -1) };
  }
  // P = P + k
  if (r.kind === NodeKind.BinaryExpr) {
    const b = r as BinaryExpr;
    if ((b.operator === '+' || b.operator === '-') && identName(b.left) === n) {
      const k = literalValue(b.right), sz = elemOf(n);
      if (k === null || !sz) return null;
      return { name: n, stride: Number(k) * sz * (b.operator === '+' ? 1 : -1) };
    }
  }
  return null;
}

function intLit(v: bigint | number): IntegerLiteralExpr {
  const value = BigInt(v);
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const raw = abs < 10n ? abs.toString() : '0x' + abs.toString(16);
  return { kind: NodeKind.IntegerLiteral, value: abs, suffix: '', base: abs < 10n ? 10 : 16, raw, leadingTrivia: [], trailingTrivia: [] } as unknown as IntegerLiteralExpr;
}

function ident(name: string): Identifier {
  return { kind: NodeKind.Identifier, name, leadingTrivia: [], trailingTrivia: [] } as unknown as Identifier;
}

function bin(left: Expression, operator: BinaryExpr['operator'], right: Expression): BinaryExpr {
  return { kind: NodeKind.BinaryExpr, operator, left, right, leadingTrivia: [], trailingTrivia: [] } as unknown as BinaryExpr;
}

function paren(e: Expression): Expression {
  const x = strip(e);
  if (x.kind === NodeKind.Identifier || x.kind === NodeKind.IntegerLiteral || x.kind === NodeKind.SubscriptExpr ||
      x.kind === NodeKind.MemberExpr || x.kind === NodeKind.CallExpr) return x;
  return { kind: NodeKind.ParenExpr, expression: x, leadingTrivia: [], trailingTrivia: [] } as unknown as ParenExpr;
}

/** `c + k` scaled by `m`: the iteration index expression. */
function indexExpr(counter: string, k: bigint, m: bigint): Expression {
  let e: Expression = ident(counter);
  if (k > 0n) e = bin(e, '+', intLit(k));
  else if (k < 0n) e = bin(e, '-', intLit(-k));
  if (m !== 1n) e = bin(paren(e), '*', intLit(m));
  return e;
}

/** `base[k] -> base[k + idx]`, folding a literal k. */
function addIndex(k: Expression, idx: Expression): Expression {
  const kv = literalValue(k);
  if (kv === 0n) return idx;
  return bin(paren(k), '+', paren(idx));
}

// ============================================
// THE REWRITE
// ============================================

interface Located {
  stmt: Statement;
  list: Statement[];
  index: number;
  /** The statement whose list this is the body of (a compound's owner), for guard matching. */
  owner: ASTNode | null;
}

/** Every statement with the list it sits in. */
function locateStatements(body: CompoundStmt): Map<Statement, Located> {
  const out = new Map<Statement, Located>();
  const visitList = (list: Statement[], owner: ASTNode | null): void => {
    list.forEach((s, index) => {
      out.set(s, { stmt: s, list, index, owner });
      visitStmt(s);
    });
  };
  const visitStmt = (s: Statement | null | undefined): void => {
    if (!s) return;
    switch (s.kind) {
      case NodeKind.CompoundStmt: visitList((s as CompoundStmt).statements, s); break;
      case NodeKind.IfStmt: {
        const i = s as IfStmt;
        visitBranch(i.thenBranch, s);
        if (i.elseBranch) visitBranch(i.elseBranch, s);
        break;
      }
      case NodeKind.WhileStmt: case NodeKind.DoWhileStmt: case NodeKind.ForStmt: case NodeKind.ForRangeStmt:
        visitBranch((s as { body: Statement }).body, s);
        break;
      case NodeKind.SwitchStmt: visitBranch((s as { body: Statement }).body, s); break;
      case NodeKind.LabelStmt: case NodeKind.CaseStmt: case NodeKind.DefaultStmt: {
        const inner = (s as { statement?: Statement }).statement;
        if (inner) visitStmt(inner);
        break;
      }
      default: break;
    }
  };
  const visitBranch = (b: Statement, owner: ASTNode): void => {
    if (b.kind === NodeKind.CompoundStmt) visitList((b as CompoundStmt).statements, owner);
    else visitStmt(b);
  };
  visitList(body.statements, null);
  return out;
}

class Refuse extends Error {}
const TRACE = typeof process !== 'undefined' && process.env?.OFFSET_INDUCTION_TRACE === '1';
const refuse = (why: string): never => {
  if (TRACE) (globalThis as { process?: { stderr: { write(s: string): void } } }).process?.stderr.write(`[offset-induction] ${why}\n`);
  throw new Refuse(why);
};

interface FnState {
  ctx: Ctx;
  fnBody: CompoundStmt;
  locals: Set<string>;
  types: Map<string, string>;
  /** Variables a definition of which this pass removed. */
  removed: Set<string>;
}

function buildState(ctx: Ctx, fn: FunctionDecl, o: OffsetInductionIndexOptions, body: CompoundStmt): FnState {
  const types = new Map<string, string>();
  for (const [n, t] of Object.entries(o.enclosingVarTypes ?? {})) types.set(n, normSpelling(t));
  for (const p of fn.parameters ?? []) {
    const pd = p as ParameterDecl;
    if (pd.name) types.set(pd.name.name, typeSpelling(pd.type));
  }
  walk(body, node => {
    if (node.kind === NodeKind.VariableDecl) {
      const v = node as VariableDecl;
      if (!types.has(v.name.name) || !(fn.parameters ?? []).some(p => (p as ParameterDecl).name?.name === v.name.name)) {
        types.set(v.name.name, typeSpelling(v.type));
      }
    }
  });
  const locals = new Set<string>();
  for (const p of fn.parameters ?? []) { const n = (p as ParameterDecl).name?.name; if (n) locals.add(n); }
  walk(body, node => { if (node.kind === NodeKind.VariableDecl) locals.add((node as VariableDecl).name.name); });
  return { ctx, fnBody: body, locals, types, removed: new Set() };
}

/** All statements inside `s` (deep), `s` included. */
function statementsIn(s: Statement): Statement[] {
  const out: Statement[] = [];
  walk(s, node => {
    if (/Stmt$/.test(node.kind) || node.kind === NodeKind.DeclStmt) out.push(node as Statement);
  });
  return out;
}

/** Remove a statement from its list, keeping its leading comments on what follows. */
function removeStmt(loc: Located): void {
  const lead = loc.stmt.leadingTrivia ?? [];
  const keep = lead.filter(t => /Comment/.test(String((t as { kind: string }).kind)));
  loc.list.splice(loc.index, 1);
  if (keep.length > 0 && loc.list[loc.index]) {
    const next = loc.list[loc.index];
    next.leadingTrivia = [...keep, ...(next.leadingTrivia ?? [])];
  }
}

/** Remove a definition statement: an expression statement, or a single declaration's initialiser. */
function removeDefinition(st: FnState, stmt: Statement, name: string): void {
  st.removed.add(name);
  const loc = locateStatements(st.fnBody).get(stmt);
  if (!loc) refuse('definition not found');
  if (stmt.kind === NodeKind.ExprStmt) { removeStmt(loc!); return; }
  if (stmt.kind === NodeKind.DeclStmt) {
    const d = stmt as DeclStmt;
    const v = d.declarations.find(x => x.kind === NodeKind.VariableDecl && (x as VariableDecl).name.name === name) as VariableDecl | undefined;
    if (!v) refuse('declaration not found');
    v!.initializer = null;
    // A declaration nothing mentions any more goes.
    const mentions = identifiersIn(st.fnBody, name).filter(i => i !== v!.name);
    if (mentions.length === 0 && d.declarations.length === 1) removeStmt(loc!);
    return;
  }
  refuse('unsupported definition statement');
}

/** The loop's nodes: every statement inside it, and its test. */
function loopNodes(flow: FunctionFlow, loop: DoWhileStmt | ForStmt): Set<number> {
  const out = new Set<number>();
  for (const s of statementsIn(loop)) {
    const n = flow.nodeOf(s);
    if (n !== undefined) out.add(n);
  }
  return out;
}

/** The node control enters the body at: the first top-level statement the graph holds. */
function entryNode(flow: FunctionFlow, top: Statement[]): number {
  for (const s of top) {
    const n = flow.nodeOf(s);
    if (n !== undefined) return n;
    if (s.kind !== NodeKind.DeclStmt && s.kind !== NodeKind.NullStmt) refuse('body entry not modelled');
  }
  return refuse('empty body');
}

/** The single definition of `v` from outside the loop that reaches `node`. */
function outsideDef(flow: FunctionFlow, node: number, v: string, inside: Set<number>): number {
  const defs = [...flow.reaching(node, v)].filter(d => !inside.has(d));
  if (defs.length !== 1 || defs[0] === ENTRY_DEF) refuse(`${v}: not one definition into the loop`);
  return defs[0];
}

function stmtOfNode(flow: FunctionFlow, body: CompoundStmt, node: number): Statement {
  for (const s of statementsIn(body)) if (flow.nodeOf(s) === node) return s;
  return refuse('node without statement');
}

/**
 * Rewrite one do-while. Mutates the (cloned) function body; returns true when it did.
 * Throws Refuse, before any mutation, where the loop does not qualify.
 */
function rewriteLoop(st: FnState, loop: DoWhileStmt): boolean {
  const { ctx, fnBody, locals, types } = st;
  if (loop.body.kind !== NodeKind.CompoundStmt) refuse('body not a block');
  const top = (loop.body as CompoundStmt).statements;
  if (hasOwnContinueOrLabel(loop.body)) refuse('continue or label in body');
  const typeOf = (n: string) => (locals.has(n) ? types.get(n) : undefined);

  const flow = buildFunctionFlow(fnBody.statements, locals);
  const inside = loopNodes(flow, loop);
  const cond = flow.nodeOf(loop);
  if (cond === undefined) refuse('loop test not modelled');
  const entry = entryNode(flow, top);

  // Writes of a name anywhere in the loop.
  const writesIn = (v: string): number => {
    let n = 0;
    walk(loop, node => {
      if (node.kind === NodeKind.AssignExpr && identName((node as AssignExpr).left) === v) n++;
      if ((node.kind === NodeKind.PostfixExpr || (node.kind === NodeKind.UnaryExpr && ['++', '--'].includes((node as UnaryExpr).operator))) &&
          identName((node as PostfixExpr).operand) === v) n++;
      if (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '&' && identName((node as UnaryExpr).operand) === v) n += 100;
    });
    return n;
  };

  // --- the counter ---------------------------------------------------------------
  const c = strip(loop.condition);
  let counter: { name: string; delta: 1 | -1; index: number } | null = null;
  for (let i = 0; i < top.length; i++) {
    const s = counterStep(top[i]);
    if (!s || !locals.has(s.name) || flow.isEscaped(s.name)) continue;
    const t = typeOf(s.name);
    if (!t || !COUNTER_INTS.has(resolve(ctx, t))) continue;
    if (writesIn(s.name) !== 1) continue;
    if (s.delta === 1 && c.kind === NodeKind.BinaryExpr && (c as BinaryExpr).operator === '<' && identName((c as BinaryExpr).left) === s.name) { counter = { ...s, index: i }; break; }
    if (s.delta === -1 && isNonZeroTest(c, s.name)) { counter = { ...s, index: i }; break; }
  }
  if (!counter) refuse('no counter');
  const cv = counter!.name;
  const cStepNode = flow.nodeOf(top[counter!.index])!;
  const cInit = outsideDef(flow, entry, cv, inside);
  const cDef = flow.definition(cInit, cv);
  const c0 = cDef?.killing ? literalValue(cDef.rhs) : null;
  if (c0 === null) refuse('counter does not enter with a constant');
  if (counter!.delta === -1) {
    if (c0! <= 0n) refuse('count-down from a non-positive constant');
    // Read only by its own step and test: nowhere else in the loop, never after it.
    const own = identifiersIn(top[counter!.index], cv).length + identifiersIn(loop.condition, cv).length;
    if (identifiersIn(loop, cv).length !== own) refuse('count-down counter read in the body');
    for (const d of [cInit, cStepNode]) for (const u of flow.usesOf(d, cv)) if (!inside.has(u)) refuse('count-down counter read after the loop');
  }

  // --- the pointer and its offsets ----------------------------------------------------
  let chosen: { ptr: string; stride: number; index: number; offs: Map<string, number> } | null = null;
  for (let i = 0; i < top.length && !chosen; i++) {
    const ps = pointerStep(ctx, top[i], typeOf);
    if (!ps || ps.stride <= 0 || !locals.has(ps.name) || flow.isEscaped(ps.name)) continue;
    if (writesIn(ps.name) !== 1) continue;
    const offs = new Map<string, number>();
    walk(loop, node => {
      if (node.kind !== NodeKind.BinaryExpr) return;
      const s = offsetSum(node as Expression);
      if (s && s.ptr === ps.name && locals.has(s.off)) offs.set(s.off, -1);
    });
    if (offs.size === 0) continue;
    chosen = { ptr: ps.name, stride: ps.stride, index: i, offs };
  }
  if (!chosen) refuse('no offset pair');
  const P = chosen!.ptr, S = BigInt(chosen!.stride);
  const pStepNode = flow.nodeOf(top[chosen!.index])!;
  for (const u of flow.usesOf(pStepNode, P)) if (!inside.has(u)) refuse('stepped pointer read after the loop');

  // Each offset: one definition `off = X - (int)P` outside the loop, every use a sum.
  const bases = new Map<string, { def: number; stmt: Statement; base: Expression }>();
  const inPlaceOffsets = new Set<string>();
  for (const off of chosen!.offs.keys()) {
    if (flow.isEscaped(off)) refuse('offset escapes');
    if (writesIn(off) !== 0) refuse('offset written in the loop');
    const def = outsideDef(flow, entry, off, inside);
    for (const d of flow.reaching(entry, off)) if (inside.has(d)) refuse('offset defined in the loop');
    const dd = flow.definition(def, off);
    const defStmt = stmtOfNode(flow, fnBody, def);
    let X: Expression;
    if (dd?.killing && dd.rhs) {
      const rhs = strip(dd.rhs);
      if (rhs.kind !== NodeKind.BinaryExpr || (rhs as BinaryExpr).operator !== '-' || intCastOf((rhs as BinaryExpr).right) !== P) refuse('offset not X - (int)P');
      X = strip((rhs as BinaryExpr).left);
    } else {
      // `off -= (int)P`: X is off's own value before it, which off keeps once the statement goes.
      const e = defStmt.kind === NodeKind.ExprStmt ? strip((defStmt as ExprStmt).expression) : null;
      if (!e || e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '-=' || identName((e as AssignExpr).left) !== off ||
          intCastOf((e as AssignExpr).right) !== P) refuse('offset definition not a plain assignment');
      X = ident(off);
      inPlaceOffsets.add(off);
    }
    if (!isPure(X)) refuse('offset base has side effects');
    // X: a local or parameter (through an integer cast), or an address constant.
    const xVars = identifiersIn(X).map(i => i.name);
    for (const v of xVars) {
      if (locals.has(v)) {
        if (flow.isEscaped(v)) refuse('offset base escapes');
      } else if (!isAddressConstant(X)) refuse('offset base reads memory');
    }
    // P0: P not written between the definition and the loop.
    if (flow.writtenBetween(def, entry, [P])) refuse('pointer written before the loop');
    const localX = xVars.filter(v => locals.has(v));
    if (localX.length > 0 && (flow.writtenBetween(def, entry, localX) || writesAny(st, loop, localX))) refuse('offset base written');
    // Every use of the definition is a sum in this loop, and every identifier `off` in the loop is one.
    for (const u of flow.usesOf(def, off)) if (!inside.has(u)) refuse('offset read outside the loop');
    let sums = 0;
    walk(loop, node => {
      if (node.kind !== NodeKind.BinaryExpr) return;
      const s = offsetSum(node as Expression);
      if (s && s.off === off) { if (s.ptr !== P) refuse('offset summed with another pointer'); sums++; }
    });
    if (identifiersIn(loop, off).length !== sums) refuse('offset read other than as a sum');
    bases.set(off, { def, stmt: defStmt, base: X });
  }

  // --- plan every rewrite before changing anything ----------------------------------
  const tC = counter!.index, tP = chosen!.index;
  const k0 = counter!.delta === 1 ? -c0! : 0n;
  // A step ahead of the statements that never read the counter moves to the end of the
  // body, where the for loop has it: the rewritten indices are the only reads then.
  const others = top.filter((_, t) => t !== tC);
  const moveStep = tC !== top.length - 1 && identifiersIn(others, cv).length === 0 &&
    flow.usesOf(cStepNode, cv).every(u => inside.has(u));
  const afterStep = (t: number): bigint => (moveStep ? (t === top.length ? 1n : 0n) : (t > tC ? 1n : 0n));
  const posOf = (t: number): bigint => k0 - afterStep(t) + (t > tP ? 1n : 0n);
  const pType = typeOf(P)!;
  const pElem = pointee(ctx, pType)!;
  const pElemSize = sizeOf(ctx, pElem);

  type Edit = () => void;
  const edits: Edit[] = [];
  const handled = new Set<Identifier>();

  const sites: Array<{ t: number; root: unknown }> = top.map((s, t) => ({ t, root: s }));
  sites.push({ t: top.length, root: loop.condition });
  for (const { t, root } of sites) {
    if (t === tP) continue;
    const pos = posOf(t);
    walk(root, (node, parent, key) => {
      // *(T *)(off + (int)P), (T *)(off + (int)P)
      if (node.kind === NodeKind.CStyleCastExpr) {
        const cst = node as CStyleCastExpr;
        const s = offsetSum(cst.expression);
        if (!s || s.ptr !== P || !bases.has(s.off)) return;
        const tSpell = typeSpelling(cst.type);
        const elem = pointee(ctx, tSpell);
        const esz = elem ? sizeOf(ctx, elem) : null;
        if (!elem || !esz || S % BigInt(esz) !== 0n) refuse('access size does not divide the stride');
        const X = bases.get(s.off)!.base;
        const xBase = baseAs(ctx, X, tSpell, typeOf, cst.type);
        const idx = indexExpr(cv, pos, S / BigInt(esz!));
        for (const id of identifiersIn(cst.expression)) handled.add(id);
        const deref = parent && parent.kind === NodeKind.UnaryExpr && (parent as UnaryExpr).operator === '*';
        const target = deref ? parent! : node;
        const sub: SubscriptExpr = { kind: NodeKind.SubscriptExpr, array: xBase, index: idx, leadingTrivia: [], trailingTrivia: [] } as unknown as SubscriptExpr;
        const replacement: Expression = deref ? sub : ({ kind: NodeKind.UnaryExpr, operator: '&', operand: sub, leadingTrivia: [], trailingTrivia: [] } as unknown as UnaryExpr);
        edits.push(() => replaceInPlace(target, replacement));
        return;
      }
      if (node.kind !== NodeKind.Identifier || (node as Identifier).name !== P || handled.has(node as Identifier)) return;
      if (parent && ((parent.kind === NodeKind.MemberExpr && key === 'member') || parent.kind === NodeKind.QualifiedId)) return;
      // P itself.
      handled.add(node as Identifier);
      // P->a[k] with an array field whose element divides the stride.
      if (parent && parent.kind === NodeKind.MemberExpr && (parent as MemberExpr).isArrow) {
        const m = parent as MemberExpr;
        const fieldName = (m.member as Identifier).name;
        const arrElem = fieldName ? arrayFieldElement(ctx, pElem, fieldName) : null;
        const grand = memberParent.get(m);
        if (arrElem && grand && grand.kind === NodeKind.SubscriptExpr && (grand as SubscriptExpr).array === m) {
          const esz = sizeOf(ctx, arrElem);
          if (!esz || S % BigInt(esz) !== 0n) refuse('array field element does not divide the stride');
          const sub = grand as SubscriptExpr;
          const idx = indexExpr(cv, pos, S / BigInt(esz!));
          edits.push(() => { sub.index = addIndex(sub.index, idx); });
          return;
        }
        if (!pElemSize || S % BigInt(pElemSize) !== 0n) refuse('pointee size does not divide the stride');
        const idx = indexExpr(cv, pos, S / BigInt(pElemSize!));
        edits.push(() => {
          const sub = { kind: NodeKind.SubscriptExpr, array: ident(P), index: idx, leadingTrivia: [], trailingTrivia: [] } as unknown as SubscriptExpr;
          m.object = sub; m.isArrow = false;
        });
        return;
      }
      if (!pElemSize || S % BigInt(pElemSize) !== 0n) refuse('pointee size does not divide the stride');
      const idx = indexExpr(cv, pos, S / BigInt(pElemSize!));
      if (parent && parent.kind === NodeKind.UnaryExpr && (parent as UnaryExpr).operator === '*') {
        const u = parent as UnaryExpr;
        edits.push(() => replaceInPlace(u, { kind: NodeKind.SubscriptExpr, array: ident(P), index: idx, leadingTrivia: [], trailingTrivia: [] } as unknown as SubscriptExpr));
        return;
      }
      if (parent && parent.kind === NodeKind.SubscriptExpr && (parent as SubscriptExpr).array === node) {
        const sub = parent as SubscriptExpr;
        edits.push(() => { sub.index = addIndex(sub.index, idx); });
        return;
      }
      if (parent && (parent.kind === NodeKind.AssignExpr && (parent as AssignExpr).left === node)) refuse('pointer written');
      if (parent && parent.kind === NodeKind.UnaryExpr && (parent as UnaryExpr).operator === '&') refuse('pointer address taken');
      const id = node as Identifier;
      edits.push(() => replaceInPlace(id, paren(bin(ident(P), '+', idx))));
    });
  }

  // The plan holds: apply it.
  applying = true;
  // Count-down counter first becomes the count-up one.
  if (counter!.delta === -1) {
    const initStmt = stmtOfNode(flow, fnBody, cInit);
    setDefinitionRhs(initStmt, cv, intLit(0));
    replaceInPlace(top[tC], { ...(top[tC] as ExprStmt), expression: { kind: NodeKind.PostfixExpr, operator: '++', operand: ident(cv), leadingTrivia: [], trailingTrivia: [] } } as unknown as ExprStmt);
    loop.condition = bin(ident(cv), '<', intLit(c0!));
  }
  for (const e of edits) e();
  // The offset definitions, then the pointer step.
  const stepStmt = top[tP];
  for (const [off, b] of bases) {
    if (!inPlaceOffsets.has(off)) { removeDefinition(st, b.stmt, off); continue; }
    const loc = locateStatements(fnBody).get(b.stmt);
    if (!loc) refuse('offset statement not found');
    removeStmt(loc!);
  }
  const bodyTop = (loop.body as CompoundStmt).statements;
  const si = bodyTop.indexOf(stepStmt);
  if (si >= 0) removeStmt({ stmt: stepStmt, list: bodyTop, index: si, owner: loop });
  if (moveStep) {
    const cStmt = top[tC];
    const ci = bodyTop.indexOf(cStmt);
    if (ci >= 0) { bodyTop.splice(ci, 1); bodyTop.push(cStmt); }
  }
  return true;
}

// Set once rewriteLoop starts changing the body.
let applying = false;

// Parent links for member expressions, rebuilt per rewrite (see rewriteFunction).
let memberParent = new Map<ASTNode, ASTNode>();

function isNonZeroTest(c: Expression, v: string): boolean {
  if (identName(c) === v) return true;
  if (c.kind !== NodeKind.BinaryExpr) return false;
  const b = c as BinaryExpr;
  if (b.operator === '!=' && ((identName(b.left) === v && literalValue(b.right) === 0n) || (identName(b.right) === v && literalValue(b.left) === 0n))) return true;
  // Counting down by one from a positive constant: `0 < c` and `c > 0` stop at the same zero.
  if (b.operator === '>' && identName(b.left) === v && literalValue(b.right) === 0n) return true;
  if (b.operator === '<' && identName(b.right) === v && literalValue(b.left) === 0n) return true;
  return false;
}

/** A name no function declares: written, for writtenBetween, by every call and store. */
const MEMORY = '<memory>';

/** The names an expression reads, plus MEMORY when it reads through a pointer or a global. */
function readsOf(e: Expression, locals: ReadonlySet<string>): string[] {
  const names = identifiersIn(e).map(i => i.name);
  let memory = names.some(n => !locals.has(n));
  walk(e, node => {
    if ((node.kind === NodeKind.MemberExpr && (node as MemberExpr).isArrow) || node.kind === NodeKind.SubscriptExpr ||
        (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '*')) memory = true;
  });
  return memory ? [...names, MEMORY] : names;
}

/** Whether a node calls, or stores anywhere but into a local variable. */
function touchesMemory(flow: FunctionFlow, nodes: Iterable<number>, locals: ReadonlySet<string>): boolean {
  const localTarget = (e: Expression): boolean => {
    let x = strip(e);
    while (x.kind === NodeKind.MemberExpr && !(x as MemberExpr).isArrow) x = strip((x as MemberExpr).object);
    return x.kind === NodeKind.Identifier && locals.has((x as Identifier).name);
  };
  for (const n of nodes) {
    for (const e of flow.ownExprs(n)) {
      let hit = false;
      walk(e, node => {
        if (node.kind === NodeKind.CallExpr || node.kind === NodeKind.NewExpr || node.kind === NodeKind.DeleteExpr) hit = true;
        else if (node.kind === NodeKind.AssignExpr && !localTarget((node as AssignExpr).left)) hit = true;
        else if ((node.kind === NodeKind.PostfixExpr || (node.kind === NodeKind.UnaryExpr && ['++', '--'].includes((node as UnaryExpr).operator))) &&
          !localTarget((node as PostfixExpr).operand)) hit = true;
      });
      if (hit) return true;
    }
  }
  return false;
}

/**
 * Can what `reads` names change between `from` and `to` (a cycle when they are equal)?
 * MEMORY in `reads` stands for any memory: a call or a store through a pointer changes it.
 */
function changedBetween(flow: FunctionFlow, from: number, to: number, reads: string[], locals: ReadonlySet<string>): boolean {
  const names = reads.filter(r => r !== MEMORY);
  if (names.length > 0 && flow.writtenBetween(from, to, names)) return true;
  return reads.includes(MEMORY) && touchesMemory(flow, flow.nodesBetween(from, to), locals);
}

/** `&global`, `&global.field`, a literal: an address no store moves. */
function isAddressConstant(e: Expression): boolean {
  const x = strip(e);
  if (x.kind === NodeKind.CStyleCastExpr) return isAddressConstant((x as CStyleCastExpr).expression);
  if (x.kind === NodeKind.IntegerLiteral) return true;
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '&') {
    let y = strip((x as UnaryExpr).operand);
    while (y.kind === NodeKind.MemberExpr && !(y as MemberExpr).isArrow) y = strip((y as MemberExpr).object);
    return y.kind === NodeKind.Identifier;
  }
  return false;
}

function writesAny(st: FnState, loop: ASTNode, vars: string[]): boolean {
  const flow = buildFunctionFlow(st.fnBody.statements, st.locals);
  const nodes = loopNodes(flow, loop as DoWhileStmt);
  for (const n of nodes) for (const v of vars) if (flow.writes(n).has(v)) return true;
  return false;
}

/** The offset base as a `T *` for `((T *)X)[j]`: X itself where it already is one. */
function baseAs(ctx: Ctx, X: Expression, tSpell: string, typeOf: (n: string) => string | undefined, castType: TypeNode): Expression {
  let inner = strip(X);
  // Drop an integer cast: `(int)pGfxFlags`.
  if (inner.kind === NodeKind.CStyleCastExpr && ADDRESS_INTS.has(typeSpelling((inner as CStyleCastExpr).type))) inner = strip((inner as CStyleCastExpr).expression);
  const n = identName(inner);
  const t = n ? typeOf(n) : undefined;
  if (t && resolve(ctx, t) === resolve(ctx, tSpell)) return cloneNode(inner);
  return paren({ kind: NodeKind.CStyleCastExpr, type: cloneNode(castType), expression: cloneNode(paren(inner)), leadingTrivia: [], trailingTrivia: [] } as unknown as CStyleCastExpr);
}

/** Replace a node's contents with another's, keeping the object (and its parent's link). */
function replaceInPlace(target: ASTNode, replacement: ASTNode): void {
  const lead = target.leadingTrivia, trail = target.trailingTrivia;
  for (const k of Object.keys(target)) delete (target as unknown as Record<string, unknown>)[k];
  Object.assign(target, replacement);
  if (lead && lead.length) target.leadingTrivia = lead;
  if (trail && trail.length) target.trailingTrivia = trail;
}

function setDefinitionRhs(stmt: Statement, v: string, rhs: Expression): void {
  if (stmt.kind === NodeKind.ExprStmt) {
    const a = strip((stmt as ExprStmt).expression) as AssignExpr;
    a.right = rhs;
    return;
  }
  if (stmt.kind === NodeKind.DeclStmt) {
    const d = (stmt as DeclStmt).declarations.find(x => (x as VariableDecl).name?.name === v) as VariableDecl;
    d.initializer = rhs;
    return;
  }
  refuse('counter definition');
}

// ============================================
// BOUND AND FOR LOOP
// ============================================

/**
 * Replace each local the loop test's bound reads by the value it holds, where that is
 * the same value at the test. Returns whether anything changed.
 */
function inlineBound(st: FnState, loop: DoWhileStmt, guard: IfStmt | null): boolean {
  const c = strip(loop.condition);
  if (c.kind !== NodeKind.BinaryExpr || (c as BinaryExpr).operator !== '<') return false;
  let changed = false;
  for (let round = 0; round < 4; round++) {
    const flow = buildFunctionFlow(st.fnBody.statements, st.locals);
    const inside = loopNodes(flow, loop);
    const condNode = flow.nodeOf(loop)!;
    const guardNode = guard ? flow.nodeOf(guard) : undefined;
    const bound = (strip(loop.condition) as BinaryExpr).right;
    let did = false;
    for (const id of identifiersIn(bound)) {
      const v = id.name;
      if (!st.locals.has(v) || flow.isEscaped(v)) continue;
      const defs = [...flow.reaching(condNode, v)];
      if (defs.length !== 1 || defs[0] === ENTRY_DEF) continue;
      const def = defs[0];
      const dd = flow.definition(def, v);
      if (!dd?.killing || !dd.rhs || !isPure(dd.rhs)) continue;
      if (identifiersIn(dd.rhs, v).length > 0) {
        // `n = n / 32` after `n = E`: compose when the first feeds only the second.
        continue;
      }
      const uses = flow.usesOf(def, v);
      const allowed = new Set<number>([condNode]);
      if (!inside.has(def) && guardNode !== undefined) allowed.add(guardNode);
      if (uses.some(u => !allowed.has(u))) continue;
      // Exactly one read of v at each allowed node, and the guard (if read there) is reached by the same def.
      if (guardNode !== undefined && uses.includes(guardNode)) {
        const g = [...flow.reaching(guardNode, v)];
        if (g.length !== 1 || g[0] !== def) continue;
      }
      const reads = readsOf(dd.rhs, st.locals);
      // Defined in the body: the value at the test is the value of that iteration's
      // definition. Ahead of the loop: it must hold through every iteration.
      if (changedBetween(flow, def, condNode, reads, st.locals)) continue;
      if (!inside.has(def) && changedBetween(flow, condNode, condNode, reads, st.locals)) continue;
      if (guardNode !== undefined && uses.includes(guardNode) && changedBetween(flow, def, guardNode, reads, st.locals)) continue;
      const value = dd.rhs;
      const subst = (root: Expression): void => {
        for (const x of identifiersIn(root, v)) replaceInPlace(x, paren(cloneNode(value)));
      };
      subst((strip(loop.condition) as BinaryExpr).right);
      if (guard && guardNode !== undefined && uses.includes(guardNode)) subst(guard.condition);
      removeDefinition(st, stmtOfNode(flow, st.fnBody, def), v);
      did = changed = true;
      break;
    }
    if (did) continue;
    // Compose `n = E; n = f(n);` when the first definition is read only by the second.
    let composed = false;
    for (const id of identifiersIn(bound)) {
      const v = id.name;
      if (!st.locals.has(v) || flow.isEscaped(v)) continue;
      const defs = [...flow.reaching(condNode, v)];
      if (defs.length !== 1 || defs[0] === ENTRY_DEF) continue;
      const d1 = defs[0];
      const r1 = flow.definition(d1, v);
      if (!r1?.killing || !r1.rhs || !isPure(r1.rhs) || identifiersIn(r1.rhs, v).length === 0) continue;
      const d0s = [...flow.reaching(d1, v)];
      if (d0s.length !== 1 || d0s[0] === ENTRY_DEF) continue;
      const d0 = d0s[0];
      const r0 = flow.definition(d0, v);
      if (!r0?.killing || !r0.rhs || !isPure(r0.rhs) || identifiersIn(r0.rhs, v).length > 0) continue;
      if (flow.usesOf(d0, v).some(u => u !== d1)) continue;
      const reads = readsOf(r0.rhs, st.locals);
      if (changedBetween(flow, d0, d1, reads, st.locals)) continue;
      const value = r0.rhs;
      for (const x of identifiersIn(r1.rhs, v)) replaceInPlace(x, paren(cloneNode(value)));
      removeDefinition(st, stmtOfNode(flow, st.fnBody, d0), v);
      composed = changed = true;
      break;
    }
    if (!composed) break;
  }
  // The guard's own locals, each read by the guard alone: `if (0 < n / 32)` after
  // `n = E` is `if (0 < E / 32)`, the test the for loop makes.
  if (guard) {
    for (let round = 0; round < 4; round++) {
      const flow = buildFunctionFlow(st.fnBody.statements, st.locals);
      const guardNode = flow.nodeOf(guard);
      if (guardNode === undefined) break;
      let did = false;
      for (const id of identifiersIn(guard.condition)) {
        const v = id.name;
        if (!st.locals.has(v) || flow.isEscaped(v)) continue;
        const defs = [...flow.reaching(guardNode, v)];
        if (defs.length !== 1 || defs[0] === ENTRY_DEF) continue;
        const def = defs[0];
        const dd = flow.definition(def, v);
        if (!dd?.killing || !dd.rhs || !isPure(dd.rhs) || identifiersIn(dd.rhs, v).length > 0) continue;
        if (flow.usesOf(def, v).some(u => u !== guardNode)) continue;
        const reads = readsOf(dd.rhs, st.locals);
        if (changedBetween(flow, def, guardNode, reads, st.locals)) continue;
        for (const x of identifiersIn(guard.condition, v)) replaceInPlace(x, paren(cloneNode(dd.rhs)));
        removeDefinition(st, stmtOfNode(flow, st.fnBody, def), v);
        did = changed = true;
        break;
      }
      if (!did) break;
    }
  }
  return changed;
}

/**
 * `c = c0; if (c0 < E) { do { B; c++; } while (c < E); }` or `c = c0; do { ... } while
 * (c < K)` -> `for (c = c0; c < E; c++) { B }`. Returns whether it did.
 */
function toForLoop(st: FnState, loop: DoWhileStmt): boolean {
  const top = (loop.body as CompoundStmt).statements;
  if (top.length < 1) return false;
  const last = top[top.length - 1];
  const step = counterStep(last);
  const c = strip(loop.condition);
  if (!step || step.delta !== 1 || c.kind !== NodeKind.BinaryExpr || (c as BinaryExpr).operator !== '<' || identName((c as BinaryExpr).left) !== step.name) return false;
  const v = step.name;
  const bound = (c as BinaryExpr).right;
  if (!isPure(bound)) return false;
  const locs = locateStatements(st.fnBody);
  const here = locs.get(loop);
  if (!here) return false;

  const initOf = (s: Statement | undefined): bigint | null => {
    if (!s) return null;
    if (s.kind === NodeKind.ExprStmt) {
      const a = strip((s as ExprStmt).expression);
      if (a.kind === NodeKind.AssignExpr && (a as AssignExpr).operator === '=' && identName((a as AssignExpr).left) === v) return literalValue((a as AssignExpr).right);
    }
    if (s.kind === NodeKind.DeclStmt) {
      const d = (s as DeclStmt).declarations;
      if (d.length === 1 && (d[0] as VariableDecl).name?.name === v) return literalValue((d[0] as VariableDecl).initializer as Expression);
    }
    return null;
  };

  let replaceLoc: Located;
  let init: Statement;
  let c0: bigint | null;
  if (here.list.length === 1 && here.owner && here.owner.kind === NodeKind.IfStmt && (here.owner as IfStmt).elseBranch === null &&
      (here.owner as IfStmt).thenBranch.kind === NodeKind.CompoundStmt) {
    const ifs = here.owner as IfStmt;
    const ifLoc = locs.get(ifs);
    if (!ifLoc || ifLoc.index === 0) return false;
    init = ifLoc.list[ifLoc.index - 1];
    c0 = initOf(init);
    if (c0 === null) return false;
    // G is the test with c0 for c.
    const g = strip(ifs.condition);
    if (g.kind !== NodeKind.BinaryExpr) return false;
    const gb = g as BinaryExpr;
    const ok = (gb.operator === '<' && literalValue(gb.left) === c0 && nodesEqual(strip(gb.right), strip(bound))) ||
      (gb.operator === '>' && literalValue(gb.right) === c0 && nodesEqual(strip(gb.left), strip(bound)));
    if (!ok) return false;
    replaceLoc = ifLoc;
  } else {
    if (here.index === 0) return false;
    init = here.list[here.index - 1];
    c0 = initOf(init);
    const k = literalValue(bound);
    if (c0 === null || k === null || !(c0 < k)) return false;
    replaceLoc = here;
  }

  // A declaring initialisation keeps its declaration; the for loop assigns.
  let forInit: Statement;
  if (init.kind === NodeKind.DeclStmt) {
    const d = (init as DeclStmt).declarations[0] as VariableDecl;
    forInit = { kind: NodeKind.ExprStmt, expression: { kind: NodeKind.AssignExpr, operator: '=', left: ident(v), right: cloneNode(d.initializer as Expression), leadingTrivia: [], trailingTrivia: [] }, leadingTrivia: [], trailingTrivia: [] } as unknown as ExprStmt;
    d.initializer = null;
  } else {
    forInit = init;
    const initLoc = locs.get(init)!;
    initLoc.list.splice(initLoc.index, 1);
    if (replaceLoc.list === initLoc.list && replaceLoc.index > initLoc.index) replaceLoc = { ...replaceLoc, index: replaceLoc.index - 1 };
  }
  const forStmt: ForStmt = {
    kind: NodeKind.ForStmt,
    init: forInit,
    condition: loop.condition,
    increment: (last as ExprStmt).expression,
    body: { ...(loop.body as CompoundStmt), statements: top.slice(0, -1) },
    leadingTrivia: replaceLoc.stmt.leadingTrivia ?? [],
    trailingTrivia: replaceLoc.stmt.trailingTrivia ?? [],
  } as unknown as ForStmt;
  replaceLoc.list[replaceLoc.index] = forStmt;
  return true;
}

// ============================================
// DRIVER
// ============================================

/** A declaration without initialiser of a variable this pass stopped reading, that nothing mentions now. */
function dropUnusedDeclarations(st: FnState): void {
  for (const name of st.removed) {
    const locs = locateStatements(st.fnBody);
    for (const [stmt, loc] of locs) {
      if (stmt.kind !== NodeKind.DeclStmt) continue;
      const ds = (stmt as DeclStmt).declarations;
      if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) continue;
      const v = ds[0] as VariableDecl;
      if (v.name.name !== name || v.initializer) continue;
      if (identifiersIn(st.fnBody, name).filter(i => i !== v.name).length > 0) continue;
      removeStmt(loc);
      break;
    }
  }
}

function enclosingGuard(st: FnState, loop: DoWhileStmt): IfStmt | null {
  const here = locateStatements(st.fnBody).get(loop);
  if (!here || here.list.length !== 1 || !here.owner || here.owner.kind !== NodeKind.IfStmt) return null;
  const ifs = here.owner as IfStmt;
  return ifs.elseBranch === null ? ifs : null;
}

export function rewriteOffsetInductions(fn: FunctionDecl, o: OffsetInductionIndexOptions, ctx: Ctx): CompoundStmt | null {
  if (!fn.body) return null;
  // Cheap gate: the function holds a `x - (int)y` and a do-while.
  let gate = false, hasLoop = false;
  walk(fn.body, node => {
    if (node.kind === NodeKind.DoWhileStmt) hasLoop = true;
    if (node.kind === NodeKind.BinaryExpr && (node as BinaryExpr).operator === '-' && intCastOf((node as BinaryExpr).right)) gate = true;
  });
  if (!gate || !hasLoop) return null;

  const body = cloneNode(fn.body as CompoundStmt);
  const st = buildState(ctx, fn, o, body);
  let changed = false;
  const done = new Set<DoWhileStmt>();
  for (let round = 0; round < 16; round++) {
    const loops: DoWhileStmt[] = [];
    walk(body, node => { if (node.kind === NodeKind.DoWhileStmt && !done.has(node as DoWhileStmt)) loops.push(node as DoWhileStmt); });
    let progressed = false;
    for (const loop of loops) {
      memberParent = new Map();
      walk(loop, (node, parent) => { if (parent && node.kind === NodeKind.MemberExpr) memberParent.set(node, parent); });
      try {
        const snapshot = cloneNode(body);
        applying = false;
        try {
          if (!rewriteLoop(st, loop)) continue;
        } catch (e) {
          // A refusal after an edit started would leave a half-rewritten body: restore it.
          if (!(e instanceof Refuse)) throw e;
          if (applying) body.statements = snapshot.statements;
          throw e;
        }
        rewrittenLoops.add(loop);
        changed = progressed = true;
        // More pointers of the same loop are rewritten in later rounds; the bound and
        // the for loop once none is left.
        break;
      } catch (e) {
        if (!(e instanceof Refuse)) throw e;
      }
    }
    if (progressed) continue;
    break;
  }
  if (!changed) return null;
  // Every loop that was rewritten: its bound, then the for loop.
  const loops: DoWhileStmt[] = [];
  walk(body, node => { if (node.kind === NodeKind.DoWhileStmt) loops.push(node as DoWhileStmt); });
  for (const loop of loops) {
    if (!rewrittenLoops.has(loop)) continue;
    try {
      inlineBound(st, loop, enclosingGuard(st, loop));
    } catch (e) {
      if (!(e instanceof Refuse)) throw e;
    }
    toForLoop(st, loop);
  }
  dropUnusedDeclarations(st);
  return body;
}

// Loops this pass indexed, by identity within one function's rewrite.
let rewrittenLoops = new WeakSet<DoWhileStmt>();

function createOffsetInductionIndexTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as OffsetInductionIndexOptions;
  const ctx: Ctx = { layouts: o.structLayouts ?? {}, sizes: o.aggregateSizes ?? {}, typedefs: o.typedefTargets ?? {} };
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      rewrittenLoops = new WeakSet();
      const body = rewriteOffsetInductions(fn, o, ctx);
      return body ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const offsetInductionIndexPlugin: TransformPlugin = {
  id: 'offset-induction-index',
  name: 'Offset Induction Index',
  description: 'A strength-reduced two-array loop (off = a - (int)b; ... *(off + (int)b) ...; b++) -> the indexed loop a[i], b[i]',
  version: '1.0.0',
  defaultEnabled: true,
  // Before rotated-for-loop (56) and early-return (60) reshape the guard, and before
  // arith-idioms (619) folds a composed bound's division.
  priority: 55.5,
  tags: ['fidelity', 'loops'],
  createTransformer: createOffsetInductionIndexTransformer,
};
