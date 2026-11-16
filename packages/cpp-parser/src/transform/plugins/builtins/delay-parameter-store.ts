import { NodeKind as K } from '../../../ast/kinds.js';
import type { ASTNode, AnyNode, CallExpr, Expression, FunctionDecl, Identifier } from '../../../ast/nodes.js';
import { getChildren } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { calleeName, scopedLookup } from './call-arg-cast.js';
import type { SelectArgumentOptions } from './select-argument.js';
import { descendants, privateValueEnv, spelling, unparen } from './private-value-env.js';

/** The rejected path observes neither an unescaped parameter's overwrite nor its value. */
export function delayParameterStore(fn: FunctionDecl, name: string, condition: string, tables: SelectArgumentOptions): string | undefined {
  const env = privateValueEnv(fn, tables);
  if (!env || !fn.body) return 'delayed store needs unambiguous bindings and no alternate entries or opaque syntax';
  const parameter = fn.parameters.find(p => p.name?.name === name);
  const type = parameter && env.resolve(emit(parameter.type), false);
  if (!type || !['int', 'unsigned int'].includes(type)) return 'delayed slot is not an ordinary 32-bit by-value parameter';
  const st = fn.body.statements;
  const sites = st.flatMap((s, i) => {
    if (s.kind !== K.ExprStmt) return [];
    const e = unparen(s.expression), guard = st[i + 1];
    return e.kind === K.AssignExpr && e.operator === '=' && unparen(e.left).kind === K.Identifier && (unparen(e.left) as Identifier).name === name
      && guard?.kind === K.IfStmt && spelling(guard.condition) === condition.replace(/\s+/g, '') ? [{ i, store: e, guard }] : [];
  });
  if (sites.length !== 1) return 'no unique parameter store immediately before that guard';
  const { i, store, guard } = sites[0];
  if (guard.init || guard.elseBranch) return 'delayed store needs an early-return guard without else';
  const rhs = unparen(store.right), sourceType = rhs.kind === K.Identifier && env.typeOf(rhs);
  if (!sourceType || !['int', 'unsigned int'].includes(env.resolve(sourceType) ?? '')) return 'delayed value is not a plain 32-bit integer binding';
  const mentions = (n: ASTNode): boolean => n.kind === K.Identifier ? (n as Identifier).name === name : getChildren(n).some(mentions);
  if (mentions(guard.condition) || !env.numeric(guard.condition)
    || descendants(guard.condition).some(n => n.kind === K.MemberExpr)) return 'guard may observe the slot or have effects';
  const returned = guard.thenBranch.kind === K.CompoundStmt ? guard.thenBranch.statements : [guard.thenBranch];
  if (returned.length !== 1 || returned[0].kind !== K.ReturnStmt) return 'guard does not return immediately';
  const value = returned[0].value && unparen(returned[0].value);
  if (!value || (value.kind !== K.IntegerLiteral && value.kind !== K.BoolLiteral)) return 'guard must return a constant value';
  const parents = new Map<ASTNode, AnyNode>();
  for (const n of env.all) for (const c of getChildren(n)) parents.set(c, n as AnyNode);
  const valueCall = (call: CallExpr, argument: Expression): boolean => {
    const key = calleeName(call.callee);
    if (!key || env.counts.has(key)) return false;
    const params = scopedLookup(tables.functionParamTypes ?? {}, key, tables.enclosingSegments ?? []), index = call.arguments.indexOf(argument);
    return !!params && index >= 0 && env.integer(params[index]);
  };
  // A reference binding in the prefix could expose the old parameter value to the
  // returning path or to a destructor. Explicit and implicit references both refuse.
  for (const statement of st.slice(0, i)) for (const n of descendants(statement)) {
    if (n.kind !== K.Identifier || (n as Identifier).name !== name) continue;
    let current: ASTNode = n, p = parents.get(current);
    if (p?.kind === K.MemberExpr && p.member === n) continue; // A field name is not the parameter binding.
    while (p && (p.kind === K.ParenExpr || p.kind === K.CStyleCastExpr || p.kind === K.BinaryExpr)) {
      if (p.kind !== K.ParenExpr && !env.numeric(p as Expression)) return 'an earlier use may select an overload or conversion';
      current = p; p = parents.get(current);
    }
    if (p?.kind === K.CallExpr && valueCall(p, current as Expression)) continue;
    if (p?.kind === K.AssignExpr && p.operator === '=' && p.right === current && env.integer(env.typeOf(p.left))) continue;
    if (p?.kind === K.VariableDecl && p.initializer === current && env.integer(emit(p.type)) && !p.directInit && !p.copyListInit) continue;
    if (p?.kind === K.ExprStmt && env.numeric(current as Expression)) continue;
    return 'an earlier use may expose the parameter slot';
  }
  const statement = st.splice(i, 1)[0];
  st.splice(i + 1, 0, statement);
  return undefined;
}
