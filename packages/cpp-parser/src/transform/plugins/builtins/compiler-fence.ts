/** A measured compiler-ordering boundary after two existing link-clear stores. */
import { NodeKind } from '../../../ast/kinds.js';
import type { AnyNode, AssignExpr, BinaryExpr, CompoundStmt, CStyleCastExpr, Expression, ExprStmt, FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, MemberExpr, ParenExpr, UnaryExpr, VariableDecl } from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import { createExprShape } from './expr-shape.js';
import { localTypesOf } from './compare-form.js';
import { shapeOfNode } from './call-arg-cast.js';

interface Field { name: string; offset: number; size: number; type: string; bitSize?: number }
export interface CompilerFenceTables {
  structFields?: Record<string, Record<string, string>>;
  structLayouts?: Record<string, ReadonlyArray<Field>>;
  unionNames?: string[];
  typedefTargets?: Record<string, string>;
}
const unwrap = (e: Expression): Expression => {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
};
const key = (e: AnyNode): string => emit(e).replace(/\s+/g, '');
const isZero = (e: Expression): boolean => {
  const x = unwrap(e);
  if (x.kind === NodeKind.CStyleCastExpr) return isZero((x as CStyleCastExpr).expression);
  return x.kind === NodeKind.NullptrLiteral || (x.kind === NodeKind.IntegerLiteral && (x as IntegerLiteralExpr).value === 0n);
};
function clear(s: AnyNode): MemberExpr | undefined {
  if (s.kind !== NodeKind.ExprStmt) return undefined;
  const a = unwrap((s as ExprStmt).expression) as AssignExpr;
  if (a.kind !== NodeKind.AssignExpr || a.operator !== '=' || !isZero(a.right)) return undefined;
  const m = unwrap(a.left);
  return m.kind === NodeKind.MemberExpr ? m as MemberExpr : undefined;
}
function member(e: Expression): MemberExpr | undefined {
  const m = unwrap(e) as MemberExpr;
  return m.kind === NodeKind.MemberExpr && m.isArrow && m.member.kind === NodeKind.Identifier
    && unwrap(m.object).kind === NodeKind.Identifier ? m : undefined;
}
function testedPointer(e: Expression): MemberExpr | undefined {
  const x = unwrap(e);
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '!') return member((x as UnaryExpr).operand);
  if (x.kind === NodeKind.BinaryExpr && ['==', '!='].includes((x as BinaryExpr).operator)) {
    const b = x as BinaryExpr;
    return isZero(b.right) ? member(b.left) : isZero(b.left) ? member(b.right) : undefined;
  }
  return member(x);
}

/** On refusal the function is untouched. The barrier evaluates no source expression. */
export function fenceLinkStores(fn: FunctionDecl, targets: readonly string[], index: number | undefined, tables?: CompilerFenceTables): string | undefined {
  if (!fn.body) return 'no body';
  const want = targets.map(t => t.replace(/\s+/g, ''));
  if (want.length !== 2 || want[0] === want[1] || want.some(t => !/^[A-Za-z_]\w*->[A-Za-z_]\w*$/.test(t))) return 'two distinct direct pointer members required';
  const hits: Array<{ block: CompoundStmt; at: number; left: MemberExpr; right: MemberExpr }> = [];
  for (const block of findNodesByKind(fn.body, NodeKind.CompoundStmt) as CompoundStmt[]) {
    for (let at = 0; at + 1 < block.statements.length; ++at) {
      const left = clear(block.statements[at]), right = clear(block.statements[at + 1]);
      if (left && right && key(left) === want[0] && key(right) === want[1]) hits.push({ block, at, left, right });
    }
  }
  if (index !== undefined && (!Number.isSafeInteger(index) || index < 1)) return 'invalid store-run index';
  if (index === undefined && hits.length !== 1) return `${hits.length} matching store runs; select one explicitly`;
  const h = hits[(index ?? 1) - 1];
  if (!h) return 'no matching store run';
  const a = member(h.left), b = member(h.right);
  if (!a || !b || key(a.object) !== key(b.object)) return 'stores must share one named pointer';
  const p = unwrap(a.object) as Identifier;
  const types = localTypesOf(fn), declared = types.get(p.name);
  const count = fn.parameters.filter(v => v.name?.name === p.name).length
    + (findNodesByKind(fn.body, NodeKind.VariableDecl) as VariableDecl[]).filter(v => v.name.name === p.name).length;
  if (!declared || count !== 1 || /\bvolatile\b|&/.test(emit(declared as AnyNode))) return 'one nonvolatile local or parameter pointer required';
  const shapeOf = createExprShape(types, { structFields: tables?.structFields ?? {}, resolve: n => tables?.typedefTargets?.[n] });
  const owner = shapeOf(p);
  if (!owner || owner.stars !== 1 || tables?.unionNames?.includes(owner.base)) return 'known nonunion pointee required';
  const layout = tables?.structLayouts?.[owner.base], fields = tables?.structFields?.[owner.base];
  if (!layout || !fields) return 'no owning field layout';
  const primitiveZero = (e: Expression): boolean => {
    const x = unwrap(e);
    if (x.kind !== NodeKind.CStyleCastExpr) return isZero(x);
    const c = x as CStyleCastExpr, t = shapeOfNode(c.type, 0, n => tables?.typedefTargets?.[n]);
    // A class conversion of literal zero need not produce a null pointer.
    return !!t && (t.stars > 0 || /^(?:bool|(?:unsigned |signed )?(?:char|short(?: int)?|int|long(?: int)?))$/.test(t.base)) && primitiveZero(c.expression);
  };
  for (const at of [h.at, h.at + 1]) {
    const a = unwrap((h.block.statements[at] as ExprStmt).expression) as AssignExpr;
    if (!primitiveZero(a.right)) return 'clear value is not a primitive zero';
  }
  const field = (m: MemberExpr): Field | undefined => {
    const matches = layout.filter(f => f.name === m.member.name), f = matches.length === 1 ? matches[0] : undefined;
    const s = shapeOf(m);
    return f && Number.isSafeInteger(f.offset) && f.offset >= 0 && [4, 8].includes(f.size) && !f.bitSize
      && !/\b(?:const|volatile)\b|[\[\]()&]/.test(f.type)
      && f.type.replace(/\s+/g, '') === fields[f.name]?.replace(/\s+/g, '') && s && s.stars > 0 ? f : undefined;
  };
  const next = h.block.statements[h.at + 2];
  if (next?.kind !== NodeKind.IfStmt || (next as IfStmt).init) return 'store pair must immediately precede a pointer test';
  const read = testedPointer((next as IfStmt).condition);
  if (!read || key(read.object) !== p.name) return 'following test must read the same object';
  const condition = unwrap((next as IfStmt).condition);
  if (condition.kind === NodeKind.BinaryExpr) {
    const b = condition as BinaryExpr;
    if (!primitiveZero(member(b.left) ? b.right : b.left)) return 'test value is not a primitive zero';
  }
  const fs = [field(a), field(b), field(read)];
  if (fs.some(f => !f)) return 'known unqualified pointer fields required';
  for (let i = 0; i < fs.length; ++i) for (let j = i + 1; j < fs.length; ++j) {
    if (fs[i]!.offset < fs[j]!.offset + fs[j]!.size && fs[j]!.offset < fs[i]!.offset + fs[i]!.size) return 'fields overlap';
  }
  h.block.statements.splice(h.at + 2, 0, Stmt.expr(Expr.call('D2_COMPILER_FENCE', [])));
  return undefined;
}
