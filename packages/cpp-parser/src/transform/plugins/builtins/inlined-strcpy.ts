/**
 * Inlined Strcpy Plugin
 *
 * VC8 /O2 expands `strcpy` inline as a byte loop, and the decompiler prints the loop
 * (SOUND_LoadWavFile, 00514e10):
 *
 *     int nNameOffset = (int)pWavEntry - (int)szText;
 *     do {
 *       cFilenameChar = *szText;                  =>   strcpy((char*)pWavEntry, szText);
 *       szText[nNameOffset] = cFilenameChar;
 *       szText++;
 *     } while (cFilenameChar != '\0');
 *
 * The loop compiles back to another loop: a second induction variable, the offset kept in a
 * register, the bounds tested in another place. The call compiles to the original's
 * `sub edx, eax; mov cl, [eax]; mov [edx+eax], cl; inc eax; test cl, cl; jne`.
 *
 * Only that shape is the intrinsic: one pointer stepping through the source and the store
 * at a fixed offset from it, `c = *S; S[D] = c; S++;`, with D a local defined once before
 * the loop as `D = A - (int)S`; it becomes `strcpy((char *)(A), S)` and the definition of D
 * goes. A loop with two pointers, `c = *S; *T = c; S++; T++;`, is a loop in the original
 * source: its two increments are the original's (D2WINACCOUNTLIST_GetSelectedAccountName,
 * 005079c0, `mov al, [ecx]; mov [edx], al; add ecx, 1; add edx, 1`), and the call there
 * compiles to the offset form instead.
 *
 * Value-preserving: strcpy writes the bytes the loop writes, to the same addresses, and
 * stops after the same terminator. Required:
 *   - S, c and D are locals or parameters whose address is never taken; S points to a
 *     one-byte type and c is a one-byte integer, so each iteration copies one byte and the
 *     condition tests it (`c != '\0'`, `c != 0` or `c`);
 *   - neither S nor c is read after the loop on any path (cfg/dataflow.ts): strcpy leaves
 *     them as they were before the loop, the loop leaves them advanced;
 *   - D is read only in the loop, its definition is the only one reaching the loop, nothing
 *     writes S or a variable A names between the two, and A reads no memory and calls
 *     nothing, so A at the loop equals A at the definition; then S + D = A at the entry.
 * Without the declarations of the variables nothing changes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CompoundStmt, CStyleCastExpr, DeclStmt, DoWhileStmt, Expression, ExprStmt,
  FunctionDecl, Identifier, ParameterDecl, ParenExpr, PointerType, PostfixExpr, QualifiedType, Statement,
  SubscriptExpr, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import { Expr, Stmt, Type } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { typeNodeName } from './call-arg-cast.js';
import { buildFunctionFlow, ENTRY_DEF, type FunctionFlow } from '../../cfg/dataflow.js';

export interface InlinedStrcpyOptions extends PluginOptions {
  onSite?: (e: { function: string }) => void;
}

const BYTE_TYPEDEFS = new Set(['char', 'signed char', 'unsigned char', 'uint8_t', 'int8_t', 'BYTE', 'CHAR', 'UCHAR', 'byte']);

function strip(t: TypeNode): TypeNode {
  while (t.kind === NodeKind.QualifiedType) t = (t as QualifiedType).type;
  return t;
}

function isByteType(t: TypeNode | undefined): boolean {
  if (!t) return false;
  t = strip(t);
  if (t.kind === NodeKind.BuiltinType) {
    const b = t as unknown as { name?: string; spelling?: string; keywords?: string[] };
    const name = b.name ?? b.spelling ?? (b.keywords ?? []).join(' ');
    return name === 'char' || name === 'signed char' || name === 'unsigned char';
  }
  if (t.kind === NodeKind.TypedefType) {
    const n = typeNodeName((t as unknown as { name: unknown }).name);
    return n !== undefined && BYTE_TYPEDEFS.has(n);
  }
  return false;
}

function isBytePointer(t: TypeNode | undefined): boolean {
  if (!t) return false;
  t = strip(t);
  return t.kind === NodeKind.PointerType && isByteType((t as PointerType).pointee);
}

function isPlainChar(t: TypeNode | undefined): boolean {
  if (!t) return false;
  t = strip(t);
  if (t.kind !== NodeKind.PointerType) return false;
  const p = strip((t as PointerType).pointee);
  if (p.kind !== NodeKind.BuiltinType) return false;
  const b = p as unknown as { name?: string; spelling?: string; keywords?: string[] };
  return (b.name ?? b.spelling ?? (b.keywords ?? []).join(' ')) === 'char';
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function identName(e: Expression | null | undefined): string | null {
  if (!e) return null;
  const u = unwrap(e);
  return u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
}

/** `*S` or `S[0]`: S. */
function derefOf(e: Expression): string | null {
  const u = unwrap(e);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '*') return identName((u as UnaryExpr).operand);
  if (u.kind === NodeKind.SubscriptExpr) {
    const s = u as SubscriptExpr;
    const i = unwrap(s.index);
    if (i.kind === NodeKind.IntegerLiteral && (i as unknown as { value: bigint }).value === 0n) return identName(s.array);
  }
  return null;
}

function assignOf(s: Statement): AssignExpr | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  return e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=' ? e as AssignExpr : null;
}

/** `S++;`, `++S;`, `S += 1;` or `S = S + 1;`: S. */
function incrementOf(s: Statement): string | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind === NodeKind.PostfixExpr && (e as PostfixExpr).operator === '++') return identName((e as PostfixExpr).operand);
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '++') return identName((e as UnaryExpr).operand);
  if (e.kind === NodeKind.AssignExpr) {
    const a = e as AssignExpr;
    const one = (x: Expression) => { const u = unwrap(x); return u.kind === NodeKind.IntegerLiteral && (u as unknown as { value: bigint }).value === 1n; };
    if (a.operator === '+=' && one(a.right)) return identName(a.left);
    if (a.operator === '=') {
      const r = unwrap(a.right);
      if (r.kind === NodeKind.BinaryExpr && (r as BinaryExpr).operator === '+' && one((r as BinaryExpr).right)
        && identName((r as BinaryExpr).left) === identName(a.left)) return identName(a.left);
    }
  }
  return null;
}

/** `c != '\0'`, `c != 0`, `c`: c. */
function nonZeroTest(e: Expression): string | null {
  const u = unwrap(e);
  if (u.kind === NodeKind.Identifier) return (u as Identifier).name;
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '!=') {
    const b = u as BinaryExpr;
    const r = unwrap(b.right);
    const zero = (r.kind === NodeKind.IntegerLiteral && (r as unknown as { value: bigint }).value === 0n)
      || (r.kind === NodeKind.CharLiteral && /^'\\0'$|^'\\x0+'$/.test(String((r as unknown as { raw?: string; value?: unknown }).raw ?? '')))
      || (r.kind === NodeKind.CharLiteral && Number((r as unknown as { value?: unknown }).value) === 0);
    if (zero) return identName(b.left);
  }
  return null;
}

/** An integer cast of S: `(int)S`, `(intptr_t)S`, `(uintptr_t)S`. */
function isIntCastOf(e: Expression, s: string): boolean {
  const u = unwrap(e);
  if (u.kind !== NodeKind.CStyleCastExpr) return false;
  const c = u as CStyleCastExpr;
  const t = strip(c.type);
  const name = t.kind === NodeKind.BuiltinType
    ? ((t as unknown as { name?: string; spelling?: string; keywords?: string[] }).name ?? (t as unknown as { spelling?: string }).spelling ?? ((t as unknown as { keywords?: string[] }).keywords ?? []).join(' '))
    : typeNodeName((t as unknown as { name: unknown }).name);
  if (!name || !['int', 'intptr_t', 'uintptr_t', 'uint32_t', 'int32_t', 'unsigned int', 'size_t'].includes(name)) return false;
  return identName(c.expression) === s;
}

/** No call, no write, no memory read: identifiers, constants, casts, arithmetic, `&global`. */
function isRegisterExpr(e: Expression): boolean {
  for (const n of traverseAST(e)) {
    switch (n.kind) {
      case NodeKind.CallExpr: case NodeKind.AssignExpr: case NodeKind.PostfixExpr: case NodeKind.CommaExpr:
      case NodeKind.SubscriptExpr: case NodeKind.ConditionalExpr:
        return false;
      case NodeKind.MemberExpr:
        return false;
      case NodeKind.UnaryExpr: {
        const op = (n as UnaryExpr).operator;
        if (op === '*' || op === '++' || op === '--') return false;
        break;
      }
      default: break;
    }
  }
  return true;
}

function identsOf(e: ASTNode): string[] {
  const out: string[] = [];
  for (const n of traverseAST(e)) if (n.kind === NodeKind.Identifier) out.push((n as Identifier).name);
  return out;
}

interface Local { type: TypeNode; decl: VariableDecl | ParameterDecl }

function localsOf(fn: FunctionDecl): { locals: Map<string, Local>; addressed: Set<string>; mentions: Map<string, number> } {
  const locals = new Map<string, Local>();
  const dup = new Set<string>();
  const add = (n: string, l: Local) => { if (locals.has(n)) dup.add(n); locals.set(n, l); };
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) add(p.name.name, { type: p.type, decl: p });
  const addressed = new Set<string>();
  const mentions = new Map<string, number>();
  for (const n of traverseAST(fn.body!)) {
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      add(v.name.name, { type: v.type, decl: v });
      if (v.type?.kind === NodeKind.ArrayType) addressed.add(v.name.name);
    }
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      for (const m of traverseAST((n as UnaryExpr).operand)) if (m.kind === NodeKind.Identifier) addressed.add((m as Identifier).name);
    }
    if (n.kind === NodeKind.Identifier) mentions.set((n as Identifier).name, (mentions.get((n as Identifier).name) ?? 0) + 1);
  }
  for (const d of dup) locals.delete(d);
  return { locals, addressed, mentions };
}

function ident(name: string): Identifier {
  return Expr.identifier(name);
}

function charPtrType(): TypeNode {
  return Type.pointer(Type.char());
}

interface Match {
  loop: DoWhileStmt;
  src: string;
  dst: Expression;
  /** Statement defining the offset, removed with the loop. */
  offsetDef?: Statement;
  offsetName: string;
  vars: string[];
}

/** Every statement a node of the flow stands for, under a loop. */
function loopNodes(flow: FunctionFlow, loop: DoWhileStmt): Set<number> | null {
  const out = new Set<number>();
  const self = flow.nodeOf(loop);
  if (self === undefined) return null;
  out.add(self);
  for (const n of traverseAST(loop.body)) {
    const id = flow.nodeOf(n as Statement);
    if (id !== undefined) out.add(id);
  }
  return out;
}

function deadAfter(flow: FunctionFlow, inLoop: Set<number>, loop: DoWhileStmt, vars: string[]): boolean {
  for (const v of vars) {
    for (const s of [loop, ...traverseAST(loop.body)] as ASTNode[]) {
      const id = flow.nodeOf(s as Statement);
      if (id === undefined || !flow.definition(id, v)) continue;
      if (flow.usesOf(id, v).some(u => !inLoop.has(u))) return false;
    }
  }
  return true;
}

function matchLoop(loop: DoWhileStmt, ctx: Ctx): Match | null {
  if (loop.body.kind !== NodeKind.CompoundStmt) return null;
  const body = (loop.body as CompoundStmt).statements;
  if (body.length !== 3) return null;
  const load = assignOf(body[0]);
  if (!load) return null;
  const c = identName(load.left);
  const s = derefOf(load.right);
  if (!c || !s || c === s || nonZeroTest(loop.condition) !== c) return null;
  const store = assignOf(body[1]);
  if (!store || identName(store.right) !== c) return null;
  const okLocal = (n: string) => ctx.locals.has(n) && !ctx.addressed.has(n);
  if (!okLocal(c) || !okLocal(s) || !isByteType(ctx.locals.get(c)!.type) || !isBytePointer(ctx.locals.get(s)!.type)) return null;

  if (incrementOf(body[2]) !== s) return null;
  const sub = unwrap(store.left);
  if (sub.kind !== NodeKind.SubscriptExpr || identName((sub as SubscriptExpr).array) !== s) return null;
  const d = identName((sub as SubscriptExpr).index);
  if (!d || d === s || d === c || !okLocal(d)) return null;
  return { loop, src: s, dst: ident(d), offsetName: d, vars: [s, c] };
}

interface Ctx {
  locals: Map<string, Local>;
  addressed: Set<string>;
  mentions: Map<string, number>;
  flow: FunctionFlow;
}

/** For the offset shape: the definition `D = A - (int)S` reaching the loop, and A. */
function offsetBase(m: Match, ctx: Ctx): { def: Statement; base: Expression } | null {
  const flow = ctx.flow;
  const stmts = (m.loop.body as CompoundStmt).statements;
  const at = flow.nodeOf(stmts[1]);
  const entry = flow.nodeOf(stmts[0]);
  if (at === undefined || entry === undefined) return null;
  const reaching = [...flow.reaching(at, m.offsetName!)];
  if (reaching.length !== 1 || reaching[0] === ENTRY_DEF) return null;
  const defId = reaching[0];
  const def = flow.definition(defId, m.offsetName!);
  if (!def || !def.killing || !def.rhs) return null;
  if (flow.usesOf(defId, m.offsetName!).some(u => u !== at)) return null;
  const rhs = unwrap(def.rhs);
  if (rhs.kind !== NodeKind.BinaryExpr || (rhs as BinaryExpr).operator !== '-' || !isIntCastOf((rhs as BinaryExpr).right, m.src)) return null;
  const base = (rhs as BinaryExpr).left;
  if (!isRegisterExpr(base)) return null;
  const names = identsOf(base).filter(n => ctx.locals.has(n));
  if (names.some(n => ctx.addressed.has(n))) return null;
  // Nothing on the way from the definition into the loop's first statement changes S or A.
  if (flow.writtenBetween(defId, entry, [m.src, ...names])) return null;
  const stmt = cfgStmt(flow, defId);
  if (!stmt) return null;
  // The definition is its own statement, writing nothing else.
  if (stmt.kind === NodeKind.DeclStmt) {
    if ((stmt as DeclStmt).declarations.length !== 1) return null;
  } else {
    const a = assignOf(stmt);
    if (!a || identName(a.left) !== m.offsetName) return null;
  }
  // D is mentioned by the definition and the loop only (and a bare declaration).
  return { def: stmt, base };
}

function cfgStmt(flow: FunctionFlow, id: number): Statement | null {
  const n = flow.cfg.nodes[id] as unknown as { stmt?: Statement };
  return n?.stmt ?? null;
}

/** `(int)X` -> `X` when X is a `char *` local, `(char *)X` for another pointer, else `(char *)(A)`. */
function asDestination(base: Expression, ctx: Ctx): Expression {
  const u = unwrap(base);
  if (u.kind === NodeKind.CStyleCastExpr) {
    const inner = identName((u as CStyleCastExpr).expression);
    if (inner && ctx.locals.has(inner) && isPlainChar(ctx.locals.get(inner)!.type)) return ident(inner);
    return Expr.cast(charPtrType(), (u as CStyleCastExpr).expression);
  }
  return Expr.cast(charPtrType(), Expr.paren(base));
}

function asCharPtr(name: string, ctx: Ctx): Expression {
  if (isPlainChar(ctx.locals.get(name)!.type)) return ident(name);
  return Expr.cast(charPtrType(), ident(name));
}

/**
 * Remove the offset's definition. A declaration of an offset the function names again (a
 * later assignment) keeps the bare declaration.
 */
function dropDefinition(root: ASTNode, def: Statement, name: string, mentions: Map<string, number>): void {
  // The definition and the loop's subscript are the two mentions of a single-use offset.
  if (def.kind === NodeKind.DeclStmt && (mentions.get(name) ?? 0) > 2) {
    const v = (def as DeclStmt).declarations[0] as VariableDecl;
    replaceStmt(root, def, { ...def, declarations: [{ ...v, initializer: null }] } as DeclStmt);
    return;
  }
  removeStmt(root, def);
}

function replaceStmt(root: ASTNode, target: Statement, by: Statement): void {
  for (const n of traverseAST(root)) {
    if (n.kind !== NodeKind.CompoundStmt) continue;
    const list = (n as CompoundStmt).statements;
    const i = list.indexOf(target);
    if (i >= 0) { list[i] = by; return; }
  }
}

function removeStmt(root: ASTNode, target: Statement): boolean {
  for (const n of traverseAST(root)) {
    if (n.kind !== NodeKind.CompoundStmt) continue;
    const list = (n as CompoundStmt).statements;
    const i = list.indexOf(target);
    if (i >= 0) { list.splice(i, 1); return true; }
  }
  return false;
}

function rewriteFunction(fn: FunctionDecl, onSite?: InlinedStrcpyOptions['onSite']): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const fname = (fn as unknown as { name?: { name?: string } }).name?.name ?? '';
  let body = cloneNode(fn.body) as CompoundStmt;
  let changed = false;
  // One site per round: the flow is rebuilt after every rewrite.
  for (let round = 0; round < 16; round++) {
    const facts = localsOf({ ...fn, body } as FunctionDecl);
    if ([...traverseAST(body)].some(n => n.kind === NodeKind.TryStmt || n.kind === NodeKind.ForRangeStmt)) break;
    const flow = buildFunctionFlow(body.statements, new Set(facts.locals.keys()));
    const ctx: Ctx = { ...facts, flow };
    let done = false;
    for (const n of traverseAST(body)) {
      if (n.kind !== NodeKind.DoWhileStmt) continue;
      const m = matchLoop(n as DoWhileStmt, ctx);
      if (!m) continue;
      const inLoop = loopNodes(flow, m.loop);
      if (!inLoop || !deadAfter(flow, inLoop, m.loop, m.vars)) continue;
      const ob = offsetBase(m, ctx);
      if (!ob) continue;
      const dst = asDestination(ob.base, ctx);
      m.offsetDef = ob.def;
      const stmt = Stmt.expr(Expr.call('strcpy', [dst, asCharPtr(m.src, ctx)]));
      (stmt as unknown as { leadingTrivia: unknown }).leadingTrivia = m.loop.leadingTrivia;
      let replaced = false;
      for (const b of traverseAST(body)) {
        if (b.kind !== NodeKind.CompoundStmt) continue;
        const list = (b as CompoundStmt).statements;
        const i = list.indexOf(m.loop);
        if (i >= 0) { list[i] = stmt; replaced = true; break; }
      }
      if (!replaced) continue;
      dropDefinition(body, m.offsetDef, m.offsetName!, facts.mentions);
      changed = true;
      done = true;
      onSite?.({ function: fname });
      break;
    }
    if (!done) break;
  }
  return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
}

function createInlinedStrcpyTransformer(options: InlinedStrcpyOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options.onSite);
    },
  });
}

export const inlinedStrcpyPlugin: TransformPlugin = {
  id: 'inlined-strcpy',
  name: 'Inlined Strcpy',
  description: 'The byte loop VC8 expands strcpy into becomes the strcpy call',
  version: '1.0.0',
  defaultEnabled: true,
  // On the final statements: after the loop and index passes, which may still rename or
  // reshape the loop's induction variables.
  priority: 989.9,
  tags: ['matching'],
  createTransformer: createInlinedStrcpyTransformer,
};

export function inlinedStrcpy_forTest(fn: FunctionDecl): FunctionDecl {
  return rewriteFunction(fn) ?? fn;
}
