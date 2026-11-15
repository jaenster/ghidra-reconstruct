/** A field store moved across a disjoint field test, copied onto both return paths. */
import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, AssignExpr, CompoundStmt, ExprStmt, Expression, FunctionDecl, Identifier, IfStmt, MemberExpr, ParameterDecl, ReturnStmt, UnaryExpr, VariableDecl } from '../../../ast/nodes.js';
import { emit } from '../../../emit/index.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { Stmt } from '../../../ast/factory.js';
import { cloneNode } from '../../transformer.js';
import { unwrapParens } from './call-arg-cast.js';

interface Field { name: string; offset: number; size: number; type: string; bitSize?: number }
export interface GuardStoreTables {
  targetPointerSize?: number;
  structLayouts?: Record<string, readonly Field[]>;
  aggregateSizes?: Record<string, number>;
  unionNames?: readonly string[];
}
interface Binding { type: string; local?: VariableDecl; parameter?: ParameterDecl }
const text = (n: ASTNode): string => emit(n as never).replace(/\s+/g, '');
const id = (e: Expression): string | undefined => {
  const n = unwrapParens(e); return n.kind === NodeKind.Identifier ? (n as Identifier).name : undefined;
};
function arrow(e: Expression): { object: string; field: string } | undefined {
  const n = unwrapParens(e); if (n.kind !== NodeKind.MemberExpr) return undefined;
  const m = n as MemberExpr, object = id(m.object);
  return m.isArrow && object && m.member.kind === NodeKind.Identifier ? { object, field: (m.member as Identifier).name } : undefined;
}
function scalarSize(type: string): number | undefined {
  const t = type.trim().replace(/\s+/g, ' ');
  if (/^(?:bool|byte|BYTE|char|signed char|unsigned char|int8_t|uint8_t)$/.test(t)) return 1;
  if (/^(?:short|short int|unsigned short|unsigned short int|int16_t|uint16_t|WORD|USHORT)$/.test(t)) return 2;
  if (/^(?:int|unsigned int|long|unsigned long|int32_t|uint32_t|BOOL|DWORD)$/.test(t)) return 4;
  return undefined;
}

/** Mutates only after a unique site and its field/alias proof have been checked. */
export function duplicateStoreBeforeReturnGuard(fn: FunctionDecl, want: string, tables?: GuardStoreTables): boolean {
  const ptr = tables?.targetPointerSize;
  if (!fn.body || text(fn.returnType) !== 'void' || (ptr !== 4 && ptr !== 8)) return false;
  if ([NodeKind.GotoStmt, NodeKind.LabelStmt, NodeKind.SwitchStmt, NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.LambdaExpr, NodeKind.FunctionDecl]
    .some(k => findNodesByKind(fn.body!, k).length)) return false;
  const locals = findNodesByKind(fn.body, NodeKind.VariableDecl) as VariableDecl[];
  const bindings = new Map<string, Binding[]>();
  for (const [decl, parameter] of [...fn.parameters.map(p => [p, true] as const), ...locals.map(v => [v, false] as const)]) {
    if (!decl.name) continue;
    const name = decl.name.name, list = bindings.get(name) ?? [];
    list.push({ type: emit(decl.type), ...(parameter ? { parameter: decl as ParameterDecl } : { local: decl as VariableDecl }) });
    bindings.set(name, list);
  }
  const one = (name: string): Binding | undefined => bindings.get(name)?.length === 1 ? bindings.get(name)![0] : undefined;
  const stable = (name: string): boolean => {
    if (!one(name)) return false;
    for (const a of findNodesByKind(fn.body!, NodeKind.AssignExpr) as AssignExpr[]) if (id(a.left) === name) return false;
    for (const n of [...findNodesByKind(fn.body!, NodeKind.UnaryExpr), ...findNodesByKind(fn.body!, NodeKind.PostfixExpr)] as UnaryExpr[]) {
      if (['&', '++', '--'].includes(n.operator) && id(n.operand) === name) return false;
    }
    return true;
  };
  const declaredBefore = (binding: Binding, block: CompoundStmt, index: number): boolean => {
    if (binding.parameter) return true;
    return !!binding.local?.initializer && block.statements.slice(0, index).some(s => s.kind === NodeKind.DeclStmt &&
      (s as unknown as { declarations: VariableDecl[] }).declarations.includes(binding.local!));
  };
  const field = (type: string, name: string): Field | undefined => {
    if (tables?.unionNames?.includes(type)) return undefined;
    const layout = tables?.structLayouts?.[type] ?? [], found = layout.filter(f => f.name === name), size = tables?.aggregateSizes?.[type];
    if (found.length !== 1 || !Number.isSafeInteger(size)) return undefined;
    const f = found[0];
    if (f.bitSize !== undefined || !Number.isSafeInteger(f.offset) || !Number.isSafeInteger(f.size) || f.offset < 0 || f.size <= 0 || f.offset + f.size > size!) return undefined;
    if (layout.some(g => g !== f && g.offset < f.offset + f.size && f.offset < g.offset + g.size)) return undefined;
    return f;
  };
  const hits: { block: CompoundStmt; index: number; guard: IfStmt; store: ExprStmt }[] = [];
  const blocks = new Set([fn.body, ...findNodesByKind(fn.body, NodeKind.CompoundStmt) as CompoundStmt[]]);
  for (const block of blocks) for (let i = 0; i + 1 < block.statements.length; i++) {
    const s = block.statements[i], next = block.statements[i + 1];
    if (s.kind !== NodeKind.ExprStmt || next.kind !== NodeKind.IfStmt) continue;
    const e = unwrapParens((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || text(e) !== want) continue;
    const store = e as AssignExpr, guard = next as IfStmt;
    if (store.operator !== '=' || guard.init || guard.elseBranch) continue;
    const branch = guard.thenBranch.kind === NodeKind.CompoundStmt ? (guard.thenBranch as CompoundStmt).statements : [guard.thenBranch];
    if (branch.length !== 1 || branch[0].kind !== NodeKind.ReturnStmt || (branch[0] as ReturnStmt).value) continue;
    const condition = unwrapParens(guard.condition);
    if (condition.kind !== NodeKind.UnaryExpr || (condition as UnaryExpr).operator !== '!') continue;
    const test = arrow((condition as UnaryExpr).operand); if (!test) continue;
    let destination = arrow(store.left), alias: Binding | undefined;
    const lhs = unwrapParens(store.left);
    if (!destination && lhs.kind === NodeKind.UnaryExpr && (lhs as UnaryExpr).operator === '*') {
      const name = id((lhs as UnaryExpr).operand); if (!name || !stable(name)) continue;
      alias = one(name); if (!alias?.local?.initializer || !declaredBefore(alias, block, i)) continue;
      const init = unwrapParens(alias.local.initializer as Expression);
      if (init.kind !== NodeKind.UnaryExpr || (init as UnaryExpr).operator !== '&') continue;
      destination = arrow((init as UnaryExpr).operand);
    }
    if (!destination || destination.object !== test.object || !stable(destination.object)) continue;
    const object = one(destination.object), pointee = object?.type.trim().match(/^(?:::)?([A-Za-z_]\w*)\s*\*$/)?.[1];
    const receiverAt = alias ? block.statements.findIndex(s => s.kind === NodeKind.DeclStmt &&
      (s as unknown as { declarations: VariableDecl[] }).declarations.includes(alias!.local!)) : i;
    // The alias must have captured this binding, not a global hidden by a later local.
    if (!object || !pointee || !declaredBefore(object, block, receiverAt)) continue;
    const a = field(pointee, destination.field), b = field(pointee, test.field);
    if (!a || !b || a.size !== ptr || !/^(?:::)?[A-Za-z_]\w*\s*\*$/.test(a.type.trim()) || scalarSize(b.type) !== b.size) continue;
    if (a.offset < b.offset + b.size && b.offset < a.offset + a.size) continue;
    if (alias && alias.type.replace(/\s+/g, '') !== a.type.replace(/\s+/g, '') + '*') continue;
    const rhsName = id(store.right), rhs = rhsName && one(rhsName);
    if (!rhsName || !rhs || !stable(rhsName) || !declaredBefore(rhs, block, i) || rhs.type.replace(/\s+/g, '') !== a.type.replace(/\s+/g, '')) continue;
    hits.push({ block, index: i, guard, store: s as ExprStmt });
  }
  if (hits.length !== 1) return false;
  const { block, index, guard, store } = hits[0], copy = cloneNode(guard);
  if (copy.thenBranch.kind === NodeKind.CompoundStmt) (copy.thenBranch as CompoundStmt).statements.unshift(cloneNode(store));
  else copy.thenBranch = Stmt.block([cloneNode(store), copy.thenBranch]);
  block.statements.splice(index, 2, copy, cloneNode(store));
  return true;
}
