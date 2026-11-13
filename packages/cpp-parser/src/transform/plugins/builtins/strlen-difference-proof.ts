/** Type and evaluation-order proof for cancelling an end-minus-start string scan. */
import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AnyNode, BinaryExpr, CallExpr, ConditionalExpr, CStyleCastExpr, DeclStmt,
  Expression, ExprStmt, FunctionDecl, Identifier, MemberExpr, ParenExpr, Statement,
  TypeNode, TypedefDecl, UnaryExpr, VariableDecl, AssignExpr,
} from '../../../ast/nodes.js';
import { emit } from '../../../emit/index.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { calleeName, isWordIntegerShape, SCALAR_BASES, shapeOfSpelling, type TypeShape } from './call-arg-cast.js';
import { collectLocalStructs } from './expr-shape.js';

export interface StrlenProofOptions {
  typedefTargets?: Record<string, string>;
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  functionParamTypes?: Record<string, string[]>;
  varArgFunctions?: string[];
}

const unwrap = (expr: Expression): Expression => {
  while (expr.kind === NodeKind.ParenExpr) expr = (expr as ParenExpr).expression;
  return expr;
};
type DeclaredType = TypeNode | string;
const spelling = (t: DeclaredType): string => typeof t === 'string' ? t : emit(t as AnyNode);
const scalar = (s: TypeShape | null): s is TypeShape => !!s && (s.stars > 0 || SCALAR_BASES.has(s.base) && s.base !== 'void');

export function createStrlenProof(ast: ASTNode, fn: FunctionDecl, opts: StrlenProofOptions) {
  const aliases: Record<string, string> = {};
  const ambiguous = new Set<string>();
  const aliasNames = new Set<string>();
  for (const d of [...findNodesByKind(ast, NodeKind.TypedefDecl), ...findNodesByKind(ast, NodeKind.TypeAliasDecl)] as TypedefDecl[]) {
    const name = d.name.name;
    if (aliasNames.has(name)) ambiguous.add(name);
    aliasNames.add(name);
    aliases[name] = spelling(d.type);
  }
  // Expand BEFORE canonicalising: canonicalBase otherwise erases volatile and may
  // replace a familiar alias such as BOOL before its actual declaration is read.
  function expand(s: string, seen = new Set<string>()): string | null {
    let failed = false;
    const out = s.replace(/\b[A-Za-z_]\w*\b/g, name => {
      if (ambiguous.has(name)) { failed = true; return name; }
      const target = aliases[name] ?? opts.typedefTargets?.[name];
      if (!target || target.trim() === name || target.trim() === `struct ${name}`) return name;
      if (seen.has(name) || seen.size >= 16) { failed = true; return name; }
      const expanded = expand(target, new Set([...seen, name]));
      if (expanded === null) failed = true;
      return expanded ?? name;
    });
    return failed ? null : out;
  }
  const resolvedTypes = new Map<DeclaredType, string | null>();
  function resolved(t: DeclaredType | undefined): string | null {
    if (t === undefined) return null;
    if (!resolvedTypes.has(t)) resolvedTypes.set(t, expand(spelling(t)));
    return resolvedTypes.get(t) ?? null;
  }
  function shape(t: DeclaredType | undefined): TypeShape | null {
    const s = resolved(t);
    if (s === null || /\bvolatile\b/.test(s)) return null;
    return shapeOfSpelling(s.replace(/\b(const|restrict)\b/g, ' '));
  }

  const locals = new Map<string, TypeNode>();
  const duplicates = new Set<string>();
  const addLocal = (name: string, type: TypeNode) => {
    if (locals.has(name)) duplicates.add(name);
    locals.set(name, type);
  };
  for (const p of fn.parameters) if (p.name) addLocal(p.name.name, p.type);
  if (fn.body) for (const v of findNodesByKind(fn.body, NodeKind.VariableDecl) as VariableDecl[]) addLocal(v.name.name, v.type);
  const globals: Record<string, DeclaredType> = {};
  if (ast.kind === NodeKind.TranslationUnit) {
    for (const d of (ast as unknown as { declarations: ASTNode[] }).declarations) {
      if (d.kind === NodeKind.VariableDecl) globals[(d as VariableDecl).name.name] = (d as VariableDecl).type;
    }
  }
  const namedType = (name: string): DeclaredType | undefined => duplicates.has(name) ? undefined
    : locals.get(name) ?? opts.enclosingVarTypes?.[name] ?? globals[name] ?? opts.globalTypes?.[name];
  const structs = collectLocalStructs(ast);
  function memberType(e: MemberExpr): DeclaredType | undefined {
    const root = unwrap(e.object);
    if (root.kind !== NodeKind.Identifier || e.member.kind !== NodeKind.Identifier) return undefined;
    const obj = shape(namedType((root as Identifier).name));
    if (!obj || obj.stars !== (e.isArrow ? 1 : 0)) return undefined;
    return structs.has(obj.base) ? structs.get(obj.base)?.get(e.member.name) : opts.structFields?.[obj.base]?.[e.member.name];
  }
  const charPointer = (s: TypeShape | null): boolean => !!s && s.stars === 1 && s.base === 'char';
  function baseKey(expr: Expression): string | null {
    const e = unwrap(expr);
    if (e.kind === NodeKind.Identifier) return charPointer(shape(namedType(e.name))) ? e.name : null;
    if (e.kind !== NodeKind.MemberExpr) return null;
    const t = memberType(e as MemberExpr), text = t === undefined ? null : resolved(t);
    // An array's address is fixed within its object. A pointer-valued member is
    // not the same proof; leave that wider aliasing problem to a separate pass.
    if (!text || !/^[^\[\]]+\[[^\[\]]+\]\s*$/.test(text) || !charPointer(shape(t))) return null;
    const m = e as MemberExpr;
    return `${(unwrap(m.object) as Identifier).name}${m.isArrow ? '->' : '.'}${(m.member as Identifier).name}`;
  }

  // Return a built-in scalar/pointer shape only when evaluating this expression
  // cannot call, write, read volatile storage, or invoke an overloaded operator.
  function pureValue(expr: Expression): TypeShape | null {
    const e = unwrap(expr);
    if (e.kind === NodeKind.Identifier) {
      const s = shape(namedType((e as Identifier).name));
      return scalar(s) ? s : null;
    }
    if (e.kind === NodeKind.MemberExpr) {
      const s = shape(memberType(e as MemberExpr));
      return scalar(s) ? s : null;
    }
    if ([NodeKind.IntegerLiteral, NodeKind.FloatingLiteral, NodeKind.BoolLiteral, NodeKind.CharLiteral, NodeKind.NullptrLiteral].includes(e.kind)) {
      return { base: 'int', stars: 0, isConst: false };
    }
    if (e.kind === NodeKind.StringLiteral) return { base: 'char', stars: 1, isConst: true };
    if (e.kind === NodeKind.CStyleCastExpr) {
      const c = e as CStyleCastExpr, s = shape(c.type);
      return pureValue(c.expression) && scalar(s) ? s : null;
    }
    if (e.kind === NodeKind.BinaryExpr) {
      const b = e as BinaryExpr, l = pureValue(b.left), r = pureValue(b.right);
      if (!l || !r || b.operator === '.*' || b.operator === '->*') return null;
      if (b.operator === '+' && l.stars > 0 && r.stars === 0) return l;
      if (b.operator === '+' && r.stars > 0 && l.stars === 0) return r;
      if (b.operator === '-' && l.stars > 0 && r.stars === 0) return l;
      return { base: 'int', stars: 0, isConst: false };
    }
    if (e.kind === NodeKind.UnaryExpr) {
      const u = e as UnaryExpr, inner = pureValue(u.operand);
      if (!inner || !['+', '-', '!', '~', '*', '&'].includes(u.operator)) return null;
      if (u.operator === '*') {
        const s = { ...inner, stars: inner.stars - 1 };
        return inner.stars > 0 && scalar(s) ? s : null;
      }
      if (u.operator === '&') return { ...inner, stars: inner.stars + 1 };
      return { base: 'int', stars: 0, isConst: false };
    }
    if (e.kind === NodeKind.ConditionalExpr) {
      const c = e as ConditionalExpr;
      return pureValue(c.condition) && pureValue(c.thenExpr) && pureValue(c.elseExpr) ? pureValue(c.thenExpr) : null;
    }
    return null;
  }
  const functions = new Map<string, { params: DeclaredType[]; variadic: boolean }>();
  const declarations = ast.kind === NodeKind.FunctionDecl ? [ast as FunctionDecl] : [];
  declarations.push(...findNodesByKind(ast, NodeKind.FunctionDecl) as FunctionDecl[]);
  const overloaded = new Set<string>();
  for (const d of declarations) {
    const name = calleeName(d.name as Expression);
    if (!name) continue;
    // Multiple declarations may select an overload with class conversions.
    if (functions.has(name)) overloaded.add(name);
    functions.set(name, { params: d.parameters.map(p => p.type), variadic: d.isVariadic });
  }
  function safeConsumer(st: Statement, heads: Expression[]): boolean {
    if (st.kind === NodeKind.DeclStmt && !(st as DeclStmt).declarations.every(d =>
      d.kind === NodeKind.VariableDecl && scalar(shape((d as VariableDecl).type)))) return false;
    if (st.kind === NodeKind.ExprStmt) {
      const e = unwrap((st as ExprStmt).expression);
      if (e.kind === NodeKind.CallExpr) {
        const c = e as CallExpr, name = calleeName(c.callee);
        if (!name || namedType(name) || locals.has(name) || overloaded.has(name)) return false;
        const sig = functions.get(name) ?? (opts.functionParamTypes?.[name]
          ? { params: opts.functionParamTypes[name], variadic: opts.varArgFunctions?.includes(name) ?? false } : undefined);
        return !!sig && (sig.variadic ? c.arguments.length >= sig.params.length : c.arguments.length === sig.params.length)
          && sig.params.every(t => scalar(shape(t))) && c.arguments.every(a => !!pureValue(a));
      }
      if (e.kind === NodeKind.AssignExpr) {
        const a = e as AssignExpr;
        return a.operator === '=' && unwrap(a.left).kind === NodeKind.Identifier
          && !!pureValue(a.left) && !!pureValue(a.right);
      }
    }
    return heads.every(e => !!pureValue(e));
  }
  function differenceCast(left: Expression, right: Expression): TypeNode | null {
    const l = unwrap(left), r = unwrap(right);
    if (l.kind !== NodeKind.CStyleCastExpr || r.kind !== NodeKind.CStyleCastExpr) return null;
    const a = shape((l as CStyleCastExpr).type), b = shape((r as CStyleCastExpr).type);
    return a && b && isWordIntegerShape(a) && isWordIntegerShape(b) && a.base === b.base
      ? (l as CStyleCastExpr).type : null;
  }
  return {
    baseKey, safeConsumer, differenceCast,
    pointer: (name: string) => !duplicates.has(name) && charPointer(shape(namedType(name))),
  };
}
