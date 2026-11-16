/** Move a private count increment across a proven ordinary non-null getter read. */
import { NodeKind } from '../../../ast/kinds.js';
import type { AnyNode, ASTNode, AssignExpr, Expression, ForStmt, FunctionDecl, IfStmt, Statement, TypeNode, VariableDecl } from '../../../ast/nodes.js';
import { getChildren } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { cloneNode } from '../../transformer.js';
import { calleeName } from './call-arg-cast.js';

export interface PrecountTables {
  typedefTargets?: Record<string, string>;
  aggregateMembers?: Record<string, string[]>;
  /** Produced from the current callee body and concrete structure field, never its name. */
  nonNullFieldRead?: (callee: string, argumentCount: number) => {
    parameterType: string; returnType: string; fieldType: string;
    member: string; offset: number; functionAddress: string;
  } | null;
}
const unparen = (input: Expression): Expression => {
  let e = input;
  while (e.kind === NodeKind.ParenExpr) e = e.expression;
  return e;
};
const id = (e: Expression): string | null => {
  const n = unparen(e); return n.kind === NodeKind.Identifier ? n.name : null;
};
const text = (n: ASTNode): string => emit(n as never).replace(/\s+/g, '');
function* walk(n: ASTNode): Generator<AnyNode> { yield n as AnyNode; for (const c of getChildren(n)) yield* walk(c); }
const mentions = (n: ASTNode, name: string): number => [...walk(n)].filter(x => x.kind === NodeKind.Identifier && x.name === name).length;
const zero = (e: Expression): boolean => {
  const n = unparen(e);
  return n.kind === NodeKind.IntegerLiteral && n.value === 0n && !n.suffix;
};
const rawPointer = (s: string): string | null => {
  if (/\b(?:volatile|const)\b/.test(s)) return null;
  const t = s.replace(/\b(?:struct|class)\b/g, '').replace(/\s+/g, '').replace(/^::/, '');
  return /^(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*\*{1,2}$/.test(t) ? t : null;
};
function word(s: string, tables: PrecountTables | undefined, seen = new Set<string>()): boolean {
  s = s.trim().replace(/\s+/g, ' ');
  if (seen.has(s) || tables?.aggregateMembers?.[s]) return false;
  const target = tables?.typedefTargets?.[s];
  if (target !== undefined) { seen.add(s); return word(target, tables, seen); }
  return ['int', 'signed', 'signed int', 'int32_t'].includes(s);
}
const only = (s: Statement): Statement[] => s.kind === NodeKind.CompoundStmt ? s.statements : [s];
function nonzero(e: Expression, expected: Expression): boolean {
  const n = unparen(e);
  if (text(n) === text(unparen(expected))) return true;
  return n.kind === NodeKind.BinaryExpr && n.operator === '!='
    && ((text(unparen(n.left)) === text(unparen(expected)) && zero(n.right))
      || (zero(n.left) && text(unparen(n.right)) === text(unparen(expected))));
}
function assignment(e: Expression, name: string): AssignExpr | null {
  const n = unparen(e);
  return n.kind === NodeKind.AssignExpr && n.operator === '=' && id(n.left) === name ? n : null;
}
function commaParts(input: Expression | null): [Expression, Expression] | null {
  if (!input) return null;
  const e = unparen(input);
  if (e.kind === NodeKind.BinaryExpr && String(e.operator) === ',') return [e.left, e.right];
  if (e.kind === NodeKind.CommaExpr && e.expressions.length === 2) return [e.expressions[0], e.expressions[1]];
  return null;
}

/** Proof first; only the accepted loop's three expressions are then replaced. */
export function precount(fn: FunctionDecl, counter: string, cursor: string, tables?: PrecountTables): string | undefined {
  if (!fn.body || !tables?.nonNullFieldRead || counter === cursor) return 'no body, distinct locals or getter evidence';
  const nodes = [...walk(fn.body)];
  const forbidden = new Set([NodeKind.Error, NodeKind.GotoStmt, NodeKind.LabelStmt, NodeKind.CaseStmt, NodeKind.DefaultStmt,
    NodeKind.LambdaExpr, NodeKind.AsmDecl, NodeKind.TryStmt, NodeKind.SehTryStmt, NodeKind.TypedefDecl, NodeKind.UsingDecl,
    NodeKind.UsingDirective, NodeKind.ClassDecl, NodeKind.StructDecl, NodeKind.UnionDecl, NodeKind.EnumDecl, NodeKind.FunctionDecl]);
  if (nodes.some(n => forbidden.has(n.kind))) return 'opaque control, error or local binding';
  const types = new Map<string, TypeNode>(), duplicates = new Set<string>();
  const add = (name: string, type: TypeNode) => { if (types.has(name)) duplicates.add(name); types.set(name, type); };
  for (const p of fn.parameters) if (p.name) add(p.name.name, p.type);
  const declarations = nodes.filter(n => n.kind === NodeKind.VariableDecl) as VariableDecl[];
  for (const d of declarations) { add(d.name.name, d.type); if (d.specifiers.length || d.attributes.length) duplicates.add(d.name.name); }
  const spelling = (name: string): string => !duplicates.has(name) && types.has(name) ? emit(types.get(name)! as never).trim() : '';
  const local = (name: string): VariableDecl | undefined => {
    const ds = declarations.filter(d => d.name.name === name);
    return ds.length === 1 && !duplicates.has(name) && fn.body!.statements.some(s => s.kind === NodeKind.DeclStmt && s.declarations.includes(ds[0])) ? ds[0] : undefined;
  };
  const count = local(counter), current = local(cursor);
  if (!count?.initializer || !zero(count.initializer) || count.directInit || !word(spelling(counter), tables)
      || !word(emit(fn.returnType), tables) || !current || current.initializer || current.directInit) return 'counter or cursor is not one plain initialized local';
  const cursorType = rawPointer(spelling(cursor));
  if (!cursorType || cursorType.endsWith('**')) return 'cursor is not a raw nonvolatile object pointer';
  const final = fn.body.statements.at(-1);
  if (final?.kind !== NodeKind.ReturnStmt || !final.value || id(final.value) !== counter || mentions(fn.body, counter) !== 3) return 'counter has an observable or additional use';
  const loops = nodes.filter(n => n.kind === NodeKind.ForStmt && commaParts(n.condition)
    && mentions(commaParts(n.condition)![0], counter)) as ForStmt[];
  if (loops.length !== 1) return `${loops.length} matching loops`;
  const loop = loops[0];
  if (!loop.init || loop.init.kind !== NodeKind.ExprStmt || !commaParts(loop.condition)
      || !loop.increment || only(loop.body).length) return 'loop is not an empty assignment walk';
  const [increment, test] = commaParts(loop.condition)!, inc = unparen(increment);
  if (!((inc.kind === NodeKind.PostfixExpr || inc.kind === NodeKind.UnaryExpr) && inc.operator === '++' && id(inc.operand) === counter)) return 'condition does not increment only the counter';
  const init = assignment(loop.init.expression, cursor), update = assignment(loop.increment, cursor);
  if (!init || !update || !nonzero(test, init.left) || mentions(fn.body, cursor) !== 5) return 'cursor has another use or a different test';
  const first = unparen(init.right), next = unparen(update.right);
  if (first.kind !== NodeKind.CallExpr || next.kind !== NodeKind.CallExpr || first.arguments.length !== 1 || next.arguments.length !== 1
      || id(next.arguments[0]) !== cursor) return 'walk does not use two unary getter calls';
  const callee = calleeName(first.callee);
  if (!callee || callee !== calleeName(next.callee) || types.has(callee.split('::')[0])) return 'callee is computed, shadowed or differs';
  const fact = tables.nonNullFieldRead(callee, 1);
  if (!fact || fact.parameterType !== cursorType || fact.returnType !== cursorType || fact.fieldType !== cursorType) return 'callee has no compatible ordinary non-null field read';
  const bucket = unparen(first.arguments[0]);
  if (mentions(bucket, counter) || mentions(bucket, cursor)) return 'getter argument depends on a moved local';
  let argumentType: string | null = null;
  if (bucket.kind === NodeKind.Identifier) argumentType = rawPointer(spelling(bucket.name));
  else if (bucket.kind === NodeKind.SubscriptExpr && id(bucket.array)) {
    const base = rawPointer(spelling(id(bucket.array)!));
    const index = unparen(bucket.index);
    if (base?.endsWith('**') && ((index.kind === NodeKind.IntegerLiteral && !index.suffix)
        || (index.kind === NodeKind.Identifier && word(spelling(index.name), tables)))) argumentType = base.slice(0, -1);
  }
  if (argumentType !== cursorType) return 'getter argument is not a plain typed pointer read';
  const guards = nodes.filter(n => n.kind === NodeKind.IfStmt && !n.init && !n.isConstexpr && !n.elseBranch
    && only(n.thenBranch).length === 1 && only(n.thenBranch)[0] === loop && nonzero(n.condition, bucket)) as IfStmt[];
  if (guards.length !== 1) return 'initial getter argument lacks an immediate non-null guard';
  // A later declaration can hide a parameter or be out of scope at the read. Require
  // every argument binding to be a parameter or an earlier root declaration.
  const bodyPrefix = fn.body.statements.slice(0, fn.body.statements.findIndex(s => s.kind !== NodeKind.DeclStmt));
  if (![count, current].every(d => bodyPrefix.some(s => s.kind === NodeKind.DeclStmt && s.declarations.includes(d)))) return 'locals are not declared at function entry';
  for (const n of walk(bucket)) if (n.kind === NodeKind.Identifier && !fn.parameters.some(p => p.name?.name === n.name)
      && !bodyPrefix.some(s => s.kind === NodeKind.DeclStmt && s.declarations.some(d => d.kind === NodeKind.VariableDecl && d.name.name === n.name))) return 'argument binding is not established before the loop';
  const comma = (left: Expression, right: Expression): Expression => ({
    kind: NodeKind.CommaExpr, expressions: [left, right], location: loop.location, leadingTrivia: [], trailingTrivia: [],
  });
  loop.init.expression = comma(cloneNode(increment), init);
  loop.condition = cloneNode(test);
  loop.increment = comma(cloneNode(increment), update);
  return undefined;
}
