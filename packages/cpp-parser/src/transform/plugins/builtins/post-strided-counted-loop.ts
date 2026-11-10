/**
 * After strided-access folds a scaled byte offset into `rows[i]`, the loop may
 * have only one counter left. Early-return has already made its first test a
 * guard. Recover the counted for loop only when skipping it is the function's
 * entire early-exit path.
 */
import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, BuiltinType, CompoundStmt, DeclStmt, DoWhileStmt, Expression, ExprStmt,
  ForStmt, FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, MemberExpr,
  ReturnStmt, Statement, TypeNode, TypedefType, VariableDecl,
} from '../../../ast/nodes.js';
import { findNodesByKind, getChildren } from '../../../ast/visitor.js';
import { TriviaKind } from '../../../lexer/trivia.js';
import { createTransformer, updateNode } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { sameExpr } from './rotated-for-loop.js';
import { createExprShape } from './expr-shape.js';
import { localTypesOf } from './compare-form.js';

interface PostStridedCountedLoopOptions extends PluginOptions {
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
}

const INTEGRAL_BOUNDS = new Set([
  'char', 'signed char', 'unsigned char', 'short', 'unsigned short',
  'int', 'unsigned int', 'long', 'unsigned long', 'long long', 'unsigned long long',
  'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int32_t', 'uint32_t', 'int64_t', 'uint64_t',
  'size_t', 'ssize_t', 'intptr_t', 'uintptr_t',
]);

// Moving the final step to a for-increment runs it after the body scope closes.
// A class local's destructor could read the counter before that increment.
const TRIVIAL_BODY_TYPES = new Set([
  ...INTEGRAL_BOUNDS, 'bool', 'float', 'double', 'long double',
]);

function trivialBodyLocal(v: VariableDecl): boolean {
  if (v.type.kind === NodeKind.BuiltinType) {
    const t = v.type as BuiltinType;
    return TRIVIAL_BODY_TYPES.has([...t.modifiers, t.name].join(' ').trim());
  }
  if (v.type.kind === NodeKind.TypedefType) {
    const name = (v.type as TypedefType).name;
    // These standard integer aliases denote scalar objects even when no project
    // typedef fact was collected. Other aliases may hide a class destructor.
    return name.kind === NodeKind.Identifier && TRIVIAL_BODY_TYPES.has(name.name);
  }
  return false;
}

function isName(e: Expression, name: string): boolean {
  return e.kind === NodeKind.Identifier && (e as Identifier).name === name;
}

function zero(e: Expression): boolean {
  return e.kind === NodeKind.IntegerLiteral &&
    (e as IntegerLiteralExpr).value === 0n && !(e as IntegerLiteralExpr).suffix;
}

function hasComment(n: ASTNode): boolean {
  return [...(n.leadingTrivia ?? []), ...(n.trailingTrivia ?? [])]
    .some(t => t.kind === TriviaKind.LineComment || t.kind === TriviaKind.BlockComment);
}

function hasCommentDeep(n: ASTNode): boolean {
  return hasComment(n) || getChildren(n).some(hasCommentDeep);
}

/** A plain field read; evaluation cannot call code or change another value. */
function plainBound(e: Expression): boolean {
  if (e.kind === NodeKind.Identifier) return true;
  return e.kind === NodeKind.MemberExpr && plainBound((e as MemberExpr).object);
}

function volatileSpelling(spelling: string, aliases: Record<string, string> | undefined, seen = new Set<string>()): boolean {
  if (/\bvolatile\b/.test(spelling)) return true;
  for (const name of spelling.match(/[A-Za-z_][A-Za-z_0-9:]*/g) ?? []) {
    const alias = aliases?.[name];
    if (!alias) continue;
    // An unresolved cycle is not proof of nonvolatile storage.
    if (seen.has(name)) return true;
    const next = new Set(seen);
    next.add(name);
    if (volatileSpelling(alias, aliases, next)) return true;
  }
  return false;
}

function volatileType(t: TypeNode, aliases: Record<string, string> | undefined): boolean {
  const q = t as TypeNode & { qualifiers?: string[]; modifiers?: string[] };
  if (t.kind === NodeKind.TypedefType) {
    const name = (t as TypedefType).name;
    if (name.kind !== NodeKind.Identifier || !aliases?.[name.name] ||
        volatileSpelling(name.name, aliases)) return true;
  }
  return !!q.qualifiers?.includes('volatile') || !!q.modifiers?.includes('volatile') ||
    getChildren(t).some(c => volatileType(c as TypeNode, aliases));
}

/** Require an exact typed storage path; a field-name fallback is insufficient. */
function plainNonvolatileStorage(
  e: Expression, fn: FunctionDecl, options: PostStridedCountedLoopOptions,
  shapeOf: ReturnType<typeof createExprShape>,
): boolean {
  const locals = localTypesOf(fn);
  if (e.kind === NodeKind.Identifier) {
    const name = (e as Identifier).name;
    const local = locals.get(name);
    if (local) return !volatileType(local, options.typedefTargets);
    const spelling = options.enclosingVarTypes?.[name] ?? options.globalTypes?.[name];
    return !!spelling && !volatileSpelling(spelling, options.typedefTargets);
  }
  if (e.kind !== NodeKind.MemberExpr) return false;
  const m = e as MemberExpr;
  if (m.isArrow || m.object.kind !== NodeKind.Identifier || m.member.kind !== NodeKind.Identifier) return false;
  const owner = (m.object as Identifier).name;
  const ownerSpelling = options.enclosingVarTypes?.[owner] ?? options.globalTypes?.[owner];
  if (!ownerSpelling || volatileSpelling(ownerSpelling, options.typedefTargets)) return false;
  const ownerType = shapeOf(m.object);
  if (!ownerType || ownerType.stars !== 0) return false;
  const fieldSpelling = options.structFields?.[ownerType.base]?.[(m.member as Identifier).name];
  return !!fieldSpelling && !volatileSpelling(fieldSpelling, options.typedefTargets);
}

function voidReturn(s: Statement): boolean {
  if (s.kind === NodeKind.ReturnStmt) return (s as ReturnStmt).value === null;
  return s.kind === NodeKind.CompoundStmt && (s as CompoundStmt).statements.length === 1 &&
    voidReturn((s as CompoundStmt).statements[0]);
}

function unsafeLoopControl(n: ASTNode): boolean {
  if ([NodeKind.ContinueStmt, NodeKind.BreakStmt, NodeKind.GotoStmt, NodeKind.LabelStmt].includes(n.kind)) return true;
  return getChildren(n).some(unsafeLoopControl);
}

function declaresName(n: ASTNode, name: string): boolean {
  if (n.kind === NodeKind.VariableDecl && (n as VariableDecl).name.name === name) return true;
  return getChildren(n).some(c => declaresName(c, name));
}

function boundRoot(e: Expression): string | null {
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name;
  return e.kind === NodeKind.MemberExpr ? boundRoot((e as MemberExpr).object) : null;
}

function counterStep(s: Statement, name: string): Expression | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = (s as ExprStmt).expression;
  if (e.kind === NodeKind.PostfixExpr && (e as { operator: string; operand: Expression }).operator === '++' &&
      isName((e as { operand: Expression }).operand, name)) return e;
  if (e.kind !== NodeKind.AssignExpr) return null;
  const a = e as { operator: string; left: Expression; right: Expression };
  if (!isName(a.left, name)) return null;
  if (a.operator === '+=') return zeroOrOne(a.right) ? e : null;
  if (a.operator !== '=' || a.right.kind !== NodeKind.BinaryExpr) return null;
  const b = a.right as BinaryExpr;
  return b.operator === '+' && isName(b.left, name) && zeroOrOne(b.right) ? e : null;
}

function zeroOrOne(e: Expression): boolean {
  return e.kind === NodeKind.IntegerLiteral &&
    (e as IntegerLiteralExpr).value === 1n && !(e as IntegerLiteralExpr).suffix;
}

function rewrite(fn: FunctionDecl, options: PostStridedCountedLoopOptions): CompoundStmt | null {
  const body = fn.body!;
  // Most functions have no such trailing guarded loop. Delay collecting all local types.
  let shapeOf: ReturnType<typeof createExprShape> | undefined;
  const stmts = body.statements;
  for (let i = 0; i + 2 < stmts.length; i++) {
    const guard = stmts[i], init = stmts[i + 1], loop = stmts[i + 2];
    if (guard.kind !== NodeKind.IfStmt || init.kind !== NodeKind.DeclStmt || loop.kind !== NodeKind.DoWhileStmt) continue;
    if ([guard, init, loop].some(hasCommentDeep)) continue;
    const ifs = guard as IfStmt, decl = init as DeclStmt, dw = loop as DoWhileStmt;
    if (ifs.elseBranch !== null || ifs.init || !voidReturn(ifs.thenBranch) ||
        decl.declarations.length !== 1 || decl.declarations[0].kind !== NodeKind.VariableDecl) continue;
    // The only remaining work after the loop is the same void return as the guard.
    if (!stmts.slice(i + 3).every(voidReturn)) continue;
    const v = decl.declarations[0] as VariableDecl;
    if (!v.name || !v.initializer || !zero(v.initializer)) continue;
    // The for form reinitializes on every call; static/thread-local storage does not.
    if (v.specifiers.length > 0 || volatileType(v.type, options.typedefTargets)) continue;
    // A final `i++` can bind to a body-local i while the condition reads the outer i.
    if (declaresName(dw.body, v.name.name)) continue;
    if (dw.condition.kind !== NodeKind.BinaryExpr) continue;
    const test = dw.condition as BinaryExpr;
    if (test.operator !== '<' || !isName(test.left, v.name.name) || !plainBound(test.right)) continue;
    // localTypesOf is function-wide. A body-local declaration can shadow a global or
    // parameter only inside the body and falsely type the guard/condition outside it.
    const root = boundRoot(test.right);
    if (!root || declaresName(fn.body, root)) continue;
    // A member's owner may instead be a parameter shadowing a known global. The
    // member-storage gate below only proves the global's type, so refuse that case.
    if (test.right.kind === NodeKind.MemberExpr && fn.parameters.some(p => p.name?.name === root)) continue;
    // `if (bound <= 0) return;` is not the inverse of `0 < bound` for NaN:
    // the original do-while runs once, while a for loop would skip it.
    shapeOf ??= createExprShape(localTypesOf(fn), {
      globalTypes: options.globalTypes,
      enclosingVarTypes: options.enclosingVarTypes,
      structFields: options.structFields,
      fieldTypes: options.fieldTypes,
      resolve: name => options.typedefTargets?.[name],
    });
    // The source form in #94 uses a plain signed int index. A class can overload
    // `<`, and an unsigned index against a negative signed bound changes the first test.
    const counterType = shapeOf(v.name);
    if (!counterType || counterType.stars !== 0 || counterType.base !== 'int') continue;
    const boundType = shapeOf(test.right);
    if (!boundType || boundType.stars !== 0 || !INTEGRAL_BOUNDS.has(boundType.base) ||
        !plainNonvolatileStorage(test.right, fn, options, shapeOf)) continue;
    if (ifs.condition.kind !== NodeKind.BinaryExpr) continue;
    const stop = ifs.condition as BinaryExpr;
    const sameStop = (stop.operator === '<=' && sameExpr(stop.left, test.right) && zero(stop.right)) ||
      (stop.operator === '>=' && zero(stop.left) && sameExpr(stop.right, test.right));
    if (!sameStop || dw.body.kind !== NodeKind.CompoundStmt || unsafeLoopControl(dw.body)) continue;
    if (findNodesByKind(dw.body, NodeKind.VariableDecl).some(n => !trivialBodyLocal(n as VariableDecl))) continue;
    const inside = (dw.body as CompoundStmt).statements;
    if (inside.length === 0 || hasComment(inside[inside.length - 1])) continue;
    const step = counterStep(inside[inside.length - 1], v.name.name);
    if (!step) continue;
    const next: ForStmt = {
      kind: NodeKind.ForStmt, init, condition: dw.condition, increment: step,
      body: updateNode(dw.body as CompoundStmt, { statements: inside.slice(0, -1) }),
      location: guard.location, leadingTrivia: guard.leadingTrivia ?? [], trailingTrivia: loop.trailingTrivia ?? [],
    } as ForStmt;
    return updateNode(body, { statements: [...stmts.slice(0, i), next, ...stmts.slice(i + 3)] });
  }
  return null;
}

export const postStridedCountedLoopPlugin: TransformPlugin = {
  id: 'post-strided-counted-loop',
  name: 'Post Strided Counted Loop',
  description: 'Recover a for loop after strided-access removes a scaled byte counter',
  version: '0.1.0',
  defaultEnabled: true,
  priority: 69.6,
  tags: ['fidelity', 'loops'],
  createTransformer: (options?: PluginOptions) => createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const body = rewrite(fn, (options ?? {}) as PostStridedCountedLoopOptions);
      return body ? updateNode(fn, { body }) : undefined;
    },
  }),
};
