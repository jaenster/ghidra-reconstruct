/**
 * Call Result Divide Plugin
 *
 * Text centred on a label halves the label's measured width. Where the source halves it in
 * the assignment, `nLabelWidth = DRAW_text0(wszBuf) / 2;`, VC8 divides the result at once:
 * `call; cdq; sub eax, edx`, ahead of the next call's argument pushes. The decompiler moves
 * the division to the one use, `DRAW_text(..., 0x108 - nLabelWidth / 2, ...)`, and VC8 then
 * schedules it among those pushes (`call; cdq; push 0; sub eax, edx`; DRAW_UI_HelpXpac
 * 00495410, Help.cpp's 0x108 and 0x23c labels). The other labels of the same function divide
 * among the pushes in the original too, so the printed text cannot tell them apart.
 *
 * The call-divides facts (reconstruct extract/call-divides.ts) list, per line, the calls whose
 * next instructions in the original are CDQ and the division's first step (SUB EAX,EDX for 2,
 * AND EDX,k-1 for a larger power of two). Where `v = f(...)` (or `T v = f(...)`) on such a line
 * with f the call and k the divisor is followed by a statement whose only mention of v is
 * `v / k`, the division moves into the assignment and the use reads v:
 *
 *     v = f(a);  g(c - v / 2);     ->     v = f(a) / 2;  g(c - v);
 *
 * Value-preserving: v is a local whose address is never taken, every mention of v in the
 * function is in statements of this one block, and the next mention after the use, when
 * there is one, is a statement `v = E;` that does not read v; with none, the block is not a
 * loop body that mentions v before the assignment. So the value the assignment stores is read
 * by the use alone, and `f(a) / k` there is the value `v / k` had. The division stays the
 * signed integer division the decompiler printed. No goto or label in the function.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, DeclStmt, Expression, ExprStmt,
  FunctionDecl, Identifier, IntegerLiteralExpr, ParenExpr, Statement, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { placed } from './access-order-evidence.js';
import { calleeName } from './call-arg-cast.js';

/** A call the original divides by `k` right after it returns. */
export interface CallDivideFact {
  /** The callee's name as the decompile prints it (last component). */
  name: string;
  k: number;
}

export interface CallResultDivideOptions extends PluginOptions {
  /** Parsed-text line -> the calls on it whose result the original divides at once. */
  divides?: ReadonlyMap<number, readonly CallDivideFact[]>;
  onSite?: (e: { line: number; name: string; k: number }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function isName(e: Expression | null | undefined, name: string): boolean {
  if (!e) return false;
  const x = unwrap(e);
  return x.kind === NodeKind.Identifier && (x as Identifier).name === name;
}

const LOOPS = new Set<string>([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt]);

/** The written variable, call and statement line of `v = f(...);` or `T v = f(...);`. */
function callAssign(s: Statement): { name: string; call: CallExpr; set: (e: Expression) => Statement } | null {
  if (!placed(s)) return null;
  if (s.kind === NodeKind.ExprStmt) {
    const e = unwrap((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    const a = e as AssignExpr;
    const l = unwrap(a.left), r = unwrap(a.right);
    if (l.kind !== NodeKind.Identifier || r.kind !== NodeKind.CallExpr) return null;
    return {
      name: (l as Identifier).name, call: r as CallExpr,
      set: v => updateNode(s as ExprStmt, { expression: updateNode(a, { right: v } as Partial<AssignExpr>) } as Partial<ExprStmt>),
    };
  }
  if (s.kind === NodeKind.DeclStmt) {
    const d = s as DeclStmt;
    if (d.declarations.length !== 1 || d.declarations[0].kind !== NodeKind.VariableDecl) return null;
    const v = d.declarations[0] as VariableDecl;
    if (!v.initializer || v.specifiers.length > 0) return null;
    const r = unwrap(v.initializer as Expression);
    if (r.kind !== NodeKind.CallExpr) return null;
    return {
      name: v.name.name, call: r as CallExpr,
      set: e => updateNode(d, { declarations: [updateNode(v, { initializer: e } as Partial<VariableDecl>)] } as Partial<DeclStmt>),
    };
  }
  return null;
}

/** Every Identifier node named `name` under `n`. */
function mentions(n: ASTNode, name: string): Identifier[] {
  const out: Identifier[] = [];
  for (const x of traverseAST(n)) if (x.kind === NodeKind.Identifier && (x as Identifier).name === name) out.push(x as Identifier);
  return out;
}

/** The single `v / k` in `s` when it is s's only mention of v, else null. */
function onlyDivide(s: Statement, name: string, k: number): BinaryExpr | null {
  if (mentions(s, name).length !== 1) return null;
  for (const x of traverseAST(s)) {
    if (x.kind !== NodeKind.BinaryExpr) continue;
    const b = x as BinaryExpr;
    if (b.operator !== '/' || !isName(b.left, name)) continue;
    const r = unwrap(b.right);
    if (r.kind === NodeKind.IntegerLiteral && (r as IntegerLiteralExpr).value === BigInt(k)) return b;
  }
  return null;
}

/** `v = E;` at statement level with E not reading v. */
function plainWrite(s: Statement, name: string): boolean {
  if (s.kind !== NodeKind.ExprStmt) return false;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return false;
  const a = e as AssignExpr;
  return isName(a.left, name) && mentions(a.right, name).length === 0;
}

function rewriteFunction(fn: FunctionDecl, opts: CallResultDivideOptions): ASTNode | undefined {
  const divides = opts.divides;
  if (!divides || !fn.body) return undefined;
  // Blocks that are a loop's body, or inside one; and whether the function jumps.
  const inLoop = new Set<ASTNode>();
  let jumps = false;
  for (const n of traverseAST(fn.body)) {
    if (n.kind === NodeKind.GotoStmt || n.kind === NodeKind.LabelStmt) jumps = true;
    if (LOOPS.has(n.kind)) for (const m of traverseAST(n)) if (m.kind === NodeKind.CompoundStmt) inLoop.add(m);
  }
  if (jumps) return undefined;
  // Locals: declared in the body, never address-taken.
  const locals = new Set<string>();
  for (const n of traverseAST(fn.body)) if (n.kind === NodeKind.VariableDecl) locals.add((n as VariableDecl).name.name);
  const addressed = new Set<string>();
  for (const n of traverseAST(fn.body)) {
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      const o = unwrap((n as UnaryExpr).operand);
      if (o.kind === NodeKind.Identifier) addressed.add((o as Identifier).name);
    }
  }
  const total = (name: string) => mentions(fn.body!, name).length;

  const edits = new Map<Statement, Statement>();
  for (const n of traverseAST(fn.body)) {
    if (n.kind !== NodeKind.CompoundStmt) continue;
    const list = (n as CompoundStmt).statements;
    for (let i = 0; i + 1 < list.length; i++) {
      const s1 = list[i];
      const ca = callAssign(s1);
      if (!ca || !locals.has(ca.name) || addressed.has(ca.name)) continue;
      const facts = divides.get(s1.location.start.line);
      const callee = calleeName(ca.call.callee)?.split('::').pop();
      if (!facts || !callee || s1.location.end.line !== s1.location.start.line) continue;
      const fit = facts.filter(f => f.name === callee);
      if (fit.length !== 1) continue;
      if (mentions(ca.call, ca.name).length > 0) continue;
      const k = fit[0].k;
      const s2 = list[i + 1];
      const div = onlyDivide(s2, ca.name, k);
      if (!div) continue;
      // Every mention of v sits in this block's statements.
      let here = 0;
      for (const s of list) here += mentions(s, ca.name).length;
      if (here !== total(ca.name)) continue;
      // The next mention after s2 is a plain write; with none, no reuse through a loop.
      let next: Statement | undefined;
      for (let j = i + 2; j < list.length; j++) if (mentions(list[j], ca.name).length > 0) { next = list[j]; break; }
      if (next ? !plainWrite(next, ca.name) : inLoop.has(n) && list.slice(0, i).some(s => mentions(s, ca.name).length > 0)) continue;
      edits.set(s1, ca.set(Expr.binary(ca.call, '/', div.right)));
      const replaceDiv = (x: ASTNode): ASTNode => {
        if (x === div) return div.left;
        const c = { ...x } as unknown as Record<string, unknown>;
        for (const [key, v] of Object.entries(c)) {
          if (key === 'location') continue;
          if (Array.isArray(v)) c[key] = v.map(y => y && typeof y === 'object' && 'kind' in y ? replaceDiv(y as ASTNode) : y);
          else if (v && typeof v === 'object' && 'kind' in (v as object)) c[key] = replaceDiv(v as ASTNode);
        }
        return c as unknown as ASTNode;
      };
      edits.set(s2, replaceDiv(s2) as Statement);
      opts.onSite?.({ line: s1.location.start.line, name: ca.name, k });
      i++;
    }
  }
  if (edits.size === 0) return undefined;
  const apply = (x: ASTNode): ASTNode => {
    const e = edits.get(x as Statement);
    if (e) return e;
    const c = { ...x } as unknown as Record<string, unknown>;
    let changed = false;
    for (const [key, v] of Object.entries(c)) {
      if (key === 'location') continue;
      if (Array.isArray(v)) {
        const nv = v.map(y => y && typeof y === 'object' && 'kind' in y ? apply(y as ASTNode) : y);
        if (nv.some((y, j) => y !== v[j])) { c[key] = nv; changed = true; }
      } else if (v && typeof v === 'object' && 'kind' in (v as object)) {
        const nv = apply(v as ASTNode);
        if (nv !== v) { c[key] = nv; changed = true; }
      }
    }
    return changed ? c as unknown as ASTNode : x;
  };
  return apply(fn);
}

export const callResultDividePlugin: TransformPlugin = {
  id: 'call-result-divide',
  name: 'Call Result Divide',
  description: 'A call result the original divides at once is divided in its assignment',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 59.66,
  tags: ['matching'],
  createTransformer: (options: CallResultDivideOptions = {}): Transformer => createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  }),
};
