/**
 * In Place Operand Plugin
 *
 * A value worked on once before its one use is worked on in the variable that holds it.
 * The decompiler prints the operation where the value is used,
 *
 *     int nPos = D2WINTEXTBOX_RefreshScrollbar(gpScrollbar);       nPos += nDelta;
 *     D2WINTEXTBOX_SetScrollbarPosition(gpScrollbar, nPos + nDelta); -> SetScrollbarPosition(gpScrollbar, nPos);
 *
 * or through a second variable, `nTarget = GetTargetX(p); nDelta = nTarget - pGame->dwFrame;`
 * for `nDelta = GetTargetX(p); nDelta -= pGame->dwFrame;`. VC8 compiles the printed form into
 * a register of its own (`lea edx, [eax+ecx]`, `mov esi, [edi+0xa8]; sub esi, eax`); the
 * original works in the call result's register (`add eax, [ebp+8]`, CHARSEL_ScrollCharList
 * 00439e60; `mov esi, eax; sub esi, [edi+0xa8]`, Missiles_SrvDmgFunc_SynergyCappedPoisonLength
 * 005ad530; `or al, 3`, LinkPortal 0056cf40).
 *
 * Two statements, `x = A;` (or `T x = A;`) and S right after it:
 *   - A is a call, and S names x once, in `x OP e`, OP one of + - | & ^, standing as a whole
 *     argument of a call: then `x OP= e;` goes between them and S reads x (the "operand"
 *     form);
 *   - or S is `y = x OP e;` with y another local: then the first statement assigns A to y,
 *     and S becomes `y OP= e;` (the "result" form).
 * Required: x (and y) are locals whose address is never taken, by the function's dataflow
 * the value the first statement gives x reaches S and no other statement, and only it; e
 * calls and writes nothing and names neither x nor y; x and y are 32-bit integers of one
 * signedness and e a constant below 2^31 or a parameter of that kind (the result form: any
 * expression), or, in the operand form, x is an unsigned 8- or 16-bit integer, OP is | & or
 * ^ and e a constant that fits it.
 *
 * Value-preserving: the operation is made on the same values in the same order (A, then e),
 * and its result has x's type in either form: a 32-bit `x OP e` converts back to the same
 * bits, and `|`, `&`, `^` of a narrow unsigned x with a constant that fits it stay in range.
 * x is read nowhere after S, so holding the result in x changes no other read.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl,
  Identifier, ParameterDecl, ParenExpr, QualifiedType, Statement, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { typeNodeName } from './call-arg-cast.js';
import { buildFunctionFlow, type FunctionFlow } from '../../cfg/dataflow.js';

export interface InPlaceOperandOptions extends PluginOptions {
  onSite?: (e: { variable: string; operator: string; form: 'operand' | 'result' }) => void;
}

const SIGNED = new Set(['int', 'signed int', 'int32_t', 'INT', 'LONG', 'long', 'BOOL']);
const UNSIGNED = new Set(['unsigned int', 'uint32_t', 'DWORD', 'UINT', 'ULONG', 'unsigned long']);
const NARROW: Record<string, bigint> = {
  'unsigned char': 0xffn, 'uint8_t': 0xffn, 'BYTE': 0xffn, 'UCHAR': 0xffn,
  'unsigned short': 0xffffn, 'uint16_t': 0xffffn, 'WORD': 0xffffn, 'USHORT': 0xffffn,
};
const OPS = new Set(['+', '-', '|', '&', '^']);

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function spelling(t: TypeNode | undefined): string | undefined {
  if (!t) return undefined;
  while (t.kind === NodeKind.QualifiedType) t = (t as QualifiedType).type;
  if (t.kind === NodeKind.BuiltinType) {
    const b = t as unknown as { name: string; modifiers?: string[] };
    return [...(b.modifiers ?? []), b.name].join(' ');
  }
  if (t.kind === NodeKind.TypedefType) return typeNodeName((t as unknown as { name: unknown }).name);
  return undefined;
}

const groupOf = (s: string | undefined): 'signed' | 'unsigned' | null =>
  !s ? null : SIGNED.has(s) ? 'signed' : UNSIGNED.has(s) ? 'unsigned' : null;

function identName(e: Expression | null | undefined): string | null {
  if (!e) return null;
  const u = unwrap(e);
  return u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
}

function literal(e: Expression): bigint | null {
  const u = unwrap(e);
  if (u.kind !== NodeKind.IntegerLiteral) return null;
  const l = u as unknown as { value: bigint; suffix?: string };
  return l.suffix ? null : l.value;
}

function definitionOf(s: Statement): { name: string; value: Expression } | null {
  if (s.kind === NodeKind.ExprStmt) {
    const e = unwrap((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    const n = identName((e as AssignExpr).left);
    return n ? { name: n, value: (e as AssignExpr).right } : null;
  }
  if (s.kind === NodeKind.DeclStmt) {
    const d = (s as DeclStmt).declarations;
    if (d.length !== 1 || d[0].kind !== NodeKind.VariableDecl) return null;
    const v = d[0] as VariableDecl;
    if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr || v.directInit) return null;
    return { name: v.name.name, value: v.initializer as Expression };
  }
  return null;
}

function mentions(n: ASTNode, name: string): Identifier[] {
  const out: Identifier[] = [];
  for (const m of traverseAST(n)) if (m.kind === NodeKind.Identifier && (m as Identifier).name === name) out.push(m as Identifier);
  return out;
}

function pure(n: ASTNode): boolean {
  for (const m of traverseAST(n)) {
    if (m.kind === NodeKind.CallExpr || m.kind === NodeKind.AssignExpr || m.kind === NodeKind.PostfixExpr
      || m.kind === NodeKind.NewExpr || m.kind === NodeKind.DeleteExpr) return false;
    if (m.kind === NodeKind.UnaryExpr && ['++', '--'].includes((m as UnaryExpr).operator)) return false;
  }
  return true;
}

interface Facts { types: Map<string, TypeNode>; locals: Set<string>; params: Set<string>; addressed: Set<string>; count: Map<string, number> }

function factsOf(fn: FunctionDecl, body: CompoundStmt): Facts {
  const types = new Map<string, TypeNode>();
  const dup = new Set<string>();
  const locals = new Set<string>();
  const params = new Set<string>();
  const add = (n: string, t: TypeNode) => { if (types.has(n)) dup.add(n); types.set(n, t); };
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) { add(p.name.name, p.type); params.add(p.name.name); }
  const addressed = new Set<string>();
  const count = new Map<string, number>();
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      params.delete(v.name.name);
      if (v.specifiers.includes('static') || v.specifiers.includes('extern')) addressed.add(v.name.name);
      add(v.name.name, v.type);
      locals.add(v.name.name);
      if (v.type?.kind === NodeKind.ArrayType) addressed.add(v.name.name);
    }
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      for (const m of traverseAST((n as UnaryExpr).operand)) if (m.kind === NodeKind.Identifier) addressed.add((m as Identifier).name);
    }
    if (n.kind === NodeKind.Identifier) count.set((n as Identifier).name, (count.get((n as Identifier).name) ?? 0) + 1);
  }
  for (const d of dup) { types.delete(d); locals.delete(d); params.delete(d); }
  return { types, locals, params, addressed, count };
}

/** The call argument that is `x OP e` (x on the left), and its call; null unless exactly one. */
function operandArgument(s: Statement, x: string): { bin: BinaryExpr; call: CallExpr; index: number } | null {
  let found: { bin: BinaryExpr; call: CallExpr; index: number } | null = null;
  for (const n of traverseAST(s)) {
    if (n.kind !== NodeKind.CallExpr) continue;
    const c = n as CallExpr;
    c.arguments.forEach((a, i) => {
      const u = unwrap(a);
      if (u.kind === NodeKind.BinaryExpr && OPS.has((u as BinaryExpr).operator) && identName((u as BinaryExpr).left) === x) {
        found = found ? { bin: u as BinaryExpr, call: c, index: -1 } : { bin: u as BinaryExpr, call: c, index: i };
      }
    });
  }
  return found && (found as { index: number }).index >= 0 ? found : null;
}

/**
 * Whether `e` may stand on the right of `x OP=` for an x of spelling `sx`: a constant, or a
 * parameter of x's kind. A local the function computed is held in a register of its own,
 * and the original often adds into that one (`nWeaponBonus + nToHit`,
 * SKILLS_ApplySkillToHitAndDamage 0056c600, matches as printed).
 */
function fitsWord(e: Expression, sx: string, facts: Facts): boolean {
  const v = literal(e);
  if (v !== null) return v >= 0n && v < 0x80000000n;
  const n = identName(e);
  return !!n && facts.params.has(n) && !facts.addressed.has(n) && groupOf(spelling(facts.types.get(n))) === groupOf(sx);
}

function isCall(e: Expression): boolean {
  let u = unwrap(e);
  while (u.kind === NodeKind.CStyleCastExpr) u = unwrap((u as unknown as { expression: Expression }).expression);
  return u.kind === NodeKind.CallExpr;
}

function rewriteBlock(block: CompoundStmt, facts: Facts, flow: FunctionFlow, report: InPlaceOperandOptions['onSite']): boolean {
  const list = block.statements;
  for (let i = 0; i + 1 < list.length; i++) {
    const d = definitionOf(list[i]);
    if (!d) continue;
    const x = d.name;
    const sx = spelling(facts.types.get(x));
    if (!facts.locals.has(x) || facts.addressed.has(x) || flow.isEscaped(x) || !sx) continue;
    const s = list[i + 1];
    if (mentions(s, x).length !== 1) continue;
    const nd = flow.nodeOf(list[i]), ns = flow.nodeOf(s);
    if (nd === undefined || ns === undefined) continue;
    const uses = flow.usesOf(nd, x);
    if (uses.length !== 1 || uses[0] !== ns || flow.reaching(ns, x).size !== 1) continue;

    // The result form: `y = x OP e;`.
    const sd = s.kind === NodeKind.ExprStmt ? definitionOf(s) : null;
    if (sd && sd.name !== x) {
      const r = unwrap(sd.value);
      const y = sd.name;
      if (r.kind === NodeKind.BinaryExpr && OPS.has((r as BinaryExpr).operator) && identName((r as BinaryExpr).left) === x) {
        const b = r as BinaryExpr;
        const sy = spelling(facts.types.get(y));
        if (!facts.locals.has(y) || facts.addressed.has(y) || flow.isEscaped(y)) continue;
        if (!groupOf(sx) || groupOf(sx) !== groupOf(sy)) continue;
        if (!pure(b.right) || mentions(b.right, x).length || mentions(b.right, y).length) continue;
        const first = Stmt.expr(Expr.assign(Expr.identifier(y), cloneNode(d.value) as Expression));
        first.leadingTrivia = list[i].leadingTrivia;
        first.location = list[i].location;
        const second = Stmt.expr(Expr.assign(Expr.identifier(y), cloneNode(b.right) as Expression, `${b.operator}=` as '+='));
        second.leadingTrivia = s.leadingTrivia;
        second.location = s.location;
        const repl: Statement[] = [];
        // x's declaration stays, bare, when anything else names x.
        if (list[i].kind === NodeKind.DeclStmt && (facts.count.get(x) ?? 0) > 2) {
          const v = (list[i] as DeclStmt).declarations[0] as VariableDecl;
          repl.push({ ...(list[i] as DeclStmt), declarations: [{ ...v, initializer: null }], leadingTrivia: [] } as DeclStmt);
        }
        list.splice(i, 2, ...repl, first, second);
        report?.({ variable: y, operator: b.operator, form: 'result' });
        return true;
      }
      continue;
    }

    // The operand form: `f(.., x OP e, ..)`, x holding a call's result.
    if (!isCall(d.value)) continue;
    const arg = operandArgument(s, x);
    if (!arg) continue;
    const b = arg.bin;
    if (!pure(b.right) || mentions(b.right, x).length) continue;
    const narrow = NARROW[sx];
    if (narrow !== undefined) {
      const v = literal(b.right);
      if (!['|', '&', '^'].includes(b.operator) || v === null || v < 0n || v > narrow) continue;
    } else if (!groupOf(sx) || !fitsWord(b.right, sx, facts)) continue;
    // Moved ahead of S, e is read before S's other arguments: they may not call or write.
    if (!arg.call.arguments.every(pure) || !pure(arg.call.callee)) continue;
    const step = Stmt.expr(Expr.assign(Expr.identifier(x), cloneNode(b.right) as Expression, `${b.operator}=` as '+='));
    step.location = s.location;
    arg.call.arguments[arg.index] = Expr.identifier(x);
    list.splice(i + 1, 0, step);
    report?.({ variable: x, operator: b.operator, form: 'operand' });
    return true;
  }
  return false;
}

function rewriteFunction(fn: FunctionDecl, onSite?: InPlaceOperandOptions['onSite']): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const body = cloneNode(fn.body) as CompoundStmt;
  if ([...traverseAST(body)].some(n => n.kind === NodeKind.TryStmt || n.kind === NodeKind.ForRangeStmt
    || n.kind === NodeKind.LabelStmt || n.kind === NodeKind.GotoStmt)) return undefined;
  let changed = false;
  for (let round = 0; round < 64; round++) {
    const facts = factsOf(fn, body);
    const flow = buildFunctionFlow(body.statements, new Set(facts.types.keys()));
    let done = false;
    for (const n of traverseAST(body)) {
      if (n.kind !== NodeKind.CompoundStmt) continue;
      if (rewriteBlock(n as CompoundStmt, facts, flow, onSite)) { done = true; break; }
    }
    if (!done) break;
    changed = true;
  }
  return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
}

export const inPlaceOperandPlugin: TransformPlugin = {
  id: 'in-place-operand',
  name: 'In Place Operand',
  description: 'A value worked on once before its one use is worked on in place with a compound assignment',
  version: '1.0.0',
  defaultEnabled: true,
  // Right after accumulate-sum (989.95), on the final statements.
  priority: 989.951,
  tags: ['matching'],
  createTransformer: (options: InPlaceOperandOptions = {}) => createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options.onSite);
    },
  }),
};
