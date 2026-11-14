/**
 * Shift Def Plugin
 *
 * A call result the source shifted once, where it was stored, comes out of the decompiler
 * with the shift at every read: the decompiler forwards `v >> 8` into each use.
 * GetCurrentLifePercentage (00621f20):
 *
 *     int nCurHp = STATSEX_GetCurrentStat(pUnit, UNITSTAT_hitpoints, 0);
 *     int32_t nMaxHp = GetTxtMaxHp(pUnit);
 *     if (nMaxHp >> 8) {
 *       return (nCurHp >> 8) * 100 / (nMaxHp >> 8);
 *     }
 *
 * The original shifts each result as it comes back (`mov esi, eax; ... sar esi, 8` before the
 * second call) and keeps only the shifted value; written as above VC8 keeps the unshifted one
 * across the call and shifts at each read. The shift moves back into the definition:
 *
 *     int nCurHp = STATSEX_GetCurrentStat(pUnit, UNITSTAT_hitpoints, 0) >> 8;
 *     int32_t nMaxHp = GetTxtMaxHp(pUnit) >> 8;
 *     if (nMaxHp) {
 *       return nCurHp * 100 / nMaxHp;
 *     }
 *
 * Made for a local v when all of these hold, else nothing changes:
 *  - v is declared once in the body with a 32-bit integer type T (int, int32_t, uint32_t,
 *    unsigned int, long, unsigned long, DWORD, LONG, UINT, ULONG), not static, extern,
 *    volatile or a reference, and its address is never taken;
 *  - v is written exactly once, by its initialiser or by one statement `v = E;`, and E is a
 *    call (casts and parentheses around it allowed);
 *  - every other mention of v is the left operand of `>>` whose right operand is the same
 *    integer constant K, 0 < K < 32;
 *  - every read comes after the write in the text, and none sits in a loop the write is
 *    not in: the original shifted a value read in a loop at each iteration (004afb60),
 *    not once before it.
 *
 * Value-preserving: before, v holds (T)E and each read is v >> K, a value of type T (T is
 * its own promoted type). After, v holds (T)((T)E >> K): the shift of a T value fits in T,
 * so the conversion is exact and v holds exactly what each read computed, of the same type.
 * The cast `(T)` is written only when the callee's declared return type is not T. Nothing
 * else reads v, so no other value changes; the call itself still runs where it ran.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CStyleCastExpr, DeclStmt, ExprStmt, Expression,
  FunctionDecl, Identifier, IntegerLiteralExpr, ParenExpr, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { getChildren, traverseAST } from '../../../ast/visitor.js';
import { Expr } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { bareName, calleeName } from './call-arg-cast.js';

export interface ShiftDefOptions extends PluginOptions {
  /** Function name (qualified or bare) -> declared return type. */
  functionReturnTypes?: Record<string, string>;
  onSite?: (e: { line: number; name: string; shift: number; reads: number }) => void;
}

const WORD_TYPES = new Set([
  'int', 'signed', 'signed int', 'unsigned', 'unsigned int', 'int32_t', 'uint32_t', 'long', 'signed long',
  'unsigned long', 'long int', 'unsigned long int', 'DWORD', 'LONG', 'UINT', 'ULONG',
]);
const SIGNED_TYPES = new Set(['int', 'signed', 'signed int', 'int32_t', 'long', 'signed long', 'long int', 'LONG']);

const LOOPS = new Set<string>([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt]);

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** The spelled type, or null for anything but a plain (unqualified, non-pointer) type name. */
function typeText(t: TypeNode): string | null {
  const s = emit(t as never).replace(/\s+/g, ' ').trim();
  return /^[A-Za-z_][\w ]*$/.test(s) ? s : null;
}

/** The call E is, through casts and parentheses, or null. */
function callOf(e: Expression): CallExpr | null {
  let x = unwrap(e);
  while (x.kind === NodeKind.CStyleCastExpr) x = unwrap((x as CStyleCastExpr).expression);
  return x.kind === NodeKind.CallExpr ? x as CallExpr : null;
}

function constantOf(e: Expression): number | null {
  const x = unwrap(e);
  if (x.kind !== NodeKind.IntegerLiteral) return null;
  const v = Number((x as IntegerLiteralExpr).value);
  return Number.isInteger(v) && v > 0 && v < 32 ? v : null;
}

interface Site {
  decl: VariableDecl;
  type: string;
  /** The write: the declaration itself, or the assignment statement. */
  write: VariableDecl | ExprStmt;
  value: Expression;
  /** Each read's `v >> K` node. */
  reads: BinaryExpr[];
  shift: number;
}

function rewriteFunction(fn: FunctionDecl, opts: ShiftDefOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const body = cloneNode(fn.body);

  // Parents, for the read test and the loop test.
  const parent = new Map<ASTNode, ASTNode>();
  for (const n of traverseAST(body)) for (const k of getChildren(n)) parent.set(k, n);
  const viaParens = (n: ASTNode): ASTNode | undefined => {
    let p = parent.get(n);
    while (p && p.kind === NodeKind.ParenExpr) p = parent.get(p);
    return p;
  };
  const loopsOf = (n: ASTNode): Set<ASTNode> => {
    const out = new Set<ASTNode>();
    for (let p = parent.get(n); p; p = parent.get(p)) if (LOOPS.has(p.kind)) out.add(p);
    return out;
  };

  // Every declaration by name: a name declared twice (shadowing) or as a parameter is left alone.
  const decls = new Map<string, VariableDecl | null>();
  for (const p of fn.parameters) {
    const n = (p as unknown as { name?: Identifier | null }).name;
    if (n) decls.set(n.name, null);
  }
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.VariableDecl) continue;
    const v = n as VariableDecl;
    decls.set(v.name.name, decls.has(v.name.name) ? null : v);
  }

  const sites: Site[] = [];
  for (const [name, decl] of decls) {
    if (!decl) continue;
    if (decl.specifiers.some(s => (s as string) === 'static' || (s as string) === 'extern' || s === 'thread_local')) continue;
    const type = typeText(decl.type);
    if (!type || !WORD_TYPES.has(type)) continue;

    let write: VariableDecl | ExprStmt | null = null;
    let value: Expression | null = null;
    let writes = 0;
    if (decl.initializer) {
      if (decl.initializer.kind === NodeKind.InitListExpr) continue;
      write = decl; value = decl.initializer as Expression; writes++;
    }
    const reads: BinaryExpr[] = [];
    let shift: number | null = null;
    let ok = true;
    for (const n of traverseAST(body)) {
      if (!ok) break;
      if (n.kind !== NodeKind.Identifier || (n as Identifier).name !== name || n === decl.name) continue;
      const p = viaParens(n);
      if (p && p.kind === NodeKind.AssignExpr && unwrap((p as AssignExpr).left) === n) {
        const a = p as AssignExpr;
        const stmt = viaParens(a);
        if (a.operator !== '=' || !stmt || stmt.kind !== NodeKind.ExprStmt) { ok = false; break; }
        write = stmt as ExprStmt; value = a.right; writes++;
        continue;
      }
      if (p && p.kind === NodeKind.BinaryExpr && (p as BinaryExpr).operator === '>>' && unwrap((p as BinaryExpr).left) === n) {
        const k = constantOf((p as BinaryExpr).right);
        if (k === null || (shift !== null && k !== shift)) { ok = false; break; }
        shift = k;
        reads.push(p as BinaryExpr);
        continue;
      }
      ok = false;
    }
    if (!ok || writes !== 1 || !write || !value || shift === null || reads.length === 0) continue;
    if (!callOf(value)) continue;
    // The value's own text must not name v (it cannot: a call result, but the arguments could).
    if ([...traverseAST(value)].some(x => x.kind === NodeKind.Identifier && (x as Identifier).name === name)) continue;
    // Every read comes after the write in the text: the write is the one value v ever holds.
    const at = (n: ASTNode) => n.location ? n.location.start.line * 100000 + n.location.start.column : -1;
    if (at(write) < 0 || reads.some(r => at(r) <= at(write!))) continue;
    const writeLoops = loopsOf(write);
    if (reads.some(r => [...loopsOf(r)].some(l => !writeLoops.has(l)))) continue;
    sites.push({ decl, type, write, value, reads, shift });
  }
  if (sites.length === 0) return undefined;

  for (const s of sites) {
    // The shifted value, converted to T first unless the callee is declared to return T.
    const call = callOf(s.value)!;
    const callee = calleeName(call.callee);
    const ret = callee ? opts.functionReturnTypes?.[callee] ?? opts.functionReturnTypes?.[bareName(callee)] : undefined;
    const sameType = unwrap(s.value) === call && ret !== undefined && ret.replace(/\s+/g, ' ').trim() === s.type;
    const sameSign = sameType || (ret !== undefined && unwrap(s.value) === call
      && WORD_TYPES.has(ret.replace(/\s+/g, ' ').trim()) && SIGNED_TYPES.has(ret.replace(/\s+/g, ' ').trim()) === SIGNED_TYPES.has(s.type));
    const base = sameSign ? cloneNode(unwrap(s.value)) : Expr.cast(cloneNode(s.decl.type), Expr.paren(cloneNode(s.value)));
    const shifted = Expr.binary(base, '>>', cloneNode(unwrap(s.reads[0].right)));
    if (s.write.kind === NodeKind.VariableDecl) {
      (s.write as VariableDecl).initializer = shifted;
    } else {
      const a = unwrap((s.write as ExprStmt).expression) as AssignExpr;
      a.right = shifted;
    }
    // Each read `v >> K` becomes `v`, in place.
    for (const r of s.reads) {
      const v = unwrap(r.left) as Identifier;
      const keep = { location: r.location, leadingTrivia: (r as { leadingTrivia?: unknown }).leadingTrivia, trailingTrivia: (r as { trailingTrivia?: unknown }).trailingTrivia };
      for (const k of Object.keys(r)) delete (r as unknown as Record<string, unknown>)[k];
      Object.assign(r, { kind: NodeKind.Identifier, name: v.name } as Identifier, keep);
    }
    opts.onSite?.({ line: s.decl.location?.start.line ?? 0, name: s.decl.name.name, shift: s.shift, reads: s.reads.length });
  }
  return updateNode(fn, { body } as Partial<FunctionDecl>);
}

export function shiftDef_forTest(fn: FunctionDecl, opts: ShiftDefOptions = {}): FunctionDecl {
  return rewriteFunction(fn, opts) ?? fn;
}

export function createShiftDefTransformer(options: ShiftDefOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  });
}

export const shiftDefPlugin: TransformPlugin = {
  id: 'shift-def',
  name: 'Shift Def',
  description: 'A call result every read shifts by one constant is shifted once, where it is stored',
  version: '1.0.0',
  defaultEnabled: true,
  // With the statement lists and the locals final, beside copy-coalesce (62.75).
  priority: 62.8,
  tags: ['matching'],
  createTransformer: createShiftDefTransformer,
};
