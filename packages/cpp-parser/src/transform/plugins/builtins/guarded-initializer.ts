/** Delay a private scalar copy until its sole guarded lifetime starts. */
import { NodeKind as K, isType } from '../../../ast/kinds.js';
import type { AnyNode, ASTNode, AssignExpr, BinaryExpr, CompoundStmt, CStyleCastExpr, DeclStmt, Expression, ExprStmt, FunctionDecl, Identifier, IfStmt, MemberExpr, Statement, UnaryExpr, VariableDecl } from '../../../ast/nodes.js';
import { getChildren } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { cloneNode } from '../../transformer.js';

interface Tables { structFields?: Record<string, Record<string, string>>; unionNames?: readonly string[] }
interface Binding { type: string; local?: VariableDecl; topIndex: number }
const strip = (s: string) => s.replace(/\b(?:struct|class)\s+/g, '').replace(/\s+/g, '').replace(/^::/, '');
const integers = new Set(['bool', 'char', 'signedchar', 'unsignedchar', 'byte', 'BYTE', 'short', 'shortint', 'signedshort', 'signedshortint', 'unsignedshort', 'unsignedshortint', 'int', 'signed', 'signedint', 'unsigned', 'unsignedint', 'long', 'longint', 'signedlong', 'unsignedlong', 'longlong', 'unsignedlonglong', 'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int32_t', 'uint32_t', 'int64_t', 'uint64_t', 'intptr_t', 'uintptr_t', 'size_t', 'ptrdiff_t', 'BOOL', 'DWORD', 'WORD', 'UINT', 'LONG', 'ULONG', 'USHORT', 'UCHAR']);
const scalar = (type: string | undefined): boolean => {
  if (!type || /\bvolatile\b|[&()[\]<>]/.test(type)) return false;
  const t = strip(type.replace(/\bconst\b/g, ''));
  return integers.has(t) || /^(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*\*+$/.test(t);
};
const unwrap = (e: Expression): Expression => { while (e.kind === K.ParenExpr) e = e.expression; return e; };
const nameOf = (e: Expression): string | undefined => { const n = unwrap(e); return n.kind === K.Identifier ? n.name : undefined; };
function nodes(n: ASTNode): ASTNode[] { return [n, ...getChildren(n).flatMap(nodes)]; }
function uses(n: ASTNode, name: string): boolean {
  if (n.kind === K.Identifier) return (n as Identifier).name === name;
  if (n.kind === K.MemberExpr) return uses((n as MemberExpr).object, name);
  if (n.kind === K.VariableDecl) { const v = n as VariableDecl; return !!v.initializer && uses(v.initializer, name); }
  return getChildren(n).some(c => uses(c, name));
}

/** Returns a refusal without mutating; commits only after a unique complete proof. */
export function guardInitializer(fn: FunctionDecl, name: string, tables: Tables = {}): string | undefined {
  if (!fn.body) return 'no function body';
  const unsafe = new Set([K.GotoStmt, K.LabelStmt, K.CaseStmt, K.DefaultStmt, K.TryStmt, K.SehTryStmt,
    K.LambdaExpr, K.FunctionDecl, K.ClassDecl, K.StructDecl, K.UnionDecl, K.EnumDecl,
    K.TypedefDecl, K.TypeAliasDecl, K.UsingDecl, K.UsingDirective, K.Error, K.AsmDecl, K.PpConditionalStmt]);
  const all = nodes(fn.body);
  if (all.some(n => unsafe.has(n.kind))) return 'control entry, local types or opaque syntax in function';
  const bindings = new Map<string, Binding[]>();
  const add = (name: string, b: Binding) => bindings.set(name, [...(bindings.get(name) ?? []), b]);
  for (const p of fn.parameters) if (p.name && !p.isVariadic) add(p.name.name, { type: emit(p.type), topIndex: -1 });
  for (const n of all) if (n.kind === K.VariableDecl) {
    const v = n as VariableDecl;
    const topIndex = fn.body.statements.findIndex(s => s.kind === K.DeclStmt && (s as DeclStmt).declarations.includes(v));
    add(v.name.name, { type: emit(v.type), local: v, topIndex });
  }
  if ([...bindings.values()].some(b => b.length !== 1)) return 'a binding is shadowed';
  const one = (n: string): Binding | undefined => bindings.get(n)?.[0];
  const dest = one(name);
  if (!dest?.local || dest.topIndex < 0 || dest.local.specifiers.length || /\b(?:const|volatile)\b/.test(dest.type) || !scalar(dest.type)) return 'destination is not a top-level ordinary integer or pointer local';
  const declaredTypes = [...fn.parameters.map(p => emit(p.type)), ...all.filter(n => isType(n.kind)).map(n => emit(n as AnyNode))];
  const word = new RegExp(`\\b${name}\\b`);
  if (declaredTypes.some(t => word.test(t))) return 'destination is mentioned in type syntax';

  // Preserve namespaces. A class named Other::uint16_t is not the SDK typedef.
  const typeOf = (e: Expression): string | undefined => {
    e = unwrap(e);
    if (e.kind === K.Identifier) return one(e.name)?.type;
    if (e.kind !== K.MemberExpr || e.member.kind !== K.Identifier) return undefined;
    const base = typeOf(e.object);
    if (!base || /\bvolatile\b|[&()[\]<>]/.test(base)) return undefined;
    let owner = strip(base.replace(/\bconst\b/g, ''));
    if (e.isArrow) { if (!owner.endsWith('*')) return undefined; owner = owner.slice(0, -1); }
    if (owner.includes('*') || tables.unionNames?.includes(owner)) return undefined;
    return tables.structFields?.[owner]?.[e.member.name];
  };
  const pure = (e: Expression): boolean => {
    e = unwrap(e);
    switch (e.kind) {
      case K.IntegerLiteral: case K.BoolLiteral: case K.CharLiteral: case K.NullptrLiteral: return true;
      case K.Identifier: case K.MemberExpr: return scalar(typeOf(e));
      case K.CStyleCastExpr: case K.StaticCastExpr: case K.ReinterpretCastExpr: case K.ConstCastExpr:
        return scalar(emit(e.type)) && pure(e.expression);
      case K.UnaryExpr: return ['!', '~', '+', '-'].includes(e.operator) && pure(e.operand);
      case K.BinaryExpr:
        return ['==', '!=', '<', '<=', '>', '>=', '&&', '||', '+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'].includes(e.operator) && pure(e.left) && pure(e.right);
      default: return false;
    }
  };
  const parents = new Map<ASTNode, ASTNode>();
  const record = (n: ASTNode) => { for (const c of getChildren(n)) { parents.set(c, n); record(c); } }; record(fn.body);
  const valueParent = (n: ASTNode): [ASTNode, ASTNode | undefined] => {
    let p = parents.get(n); while (p?.kind === K.ParenExpr) { n = p; p = parents.get(n); } return [n, p];
  };
  const standalone = (n: ASTNode) => { const [v, p] = valueParent(n); return p?.kind === K.ExprStmt && (p as ExprStmt).expression === v; };
  // Every use must consume V's value, never bind an unknown reference to V's slot.
  // In particular an untyped F(V), class initializer, return or reference cast refuses.
  for (const n of all) if (n.kind === K.Identifier && (n as Identifier).name === name) {
    const [v, p] = valueParent(n);
    if (!p) return 'unknown destination use';
    if (p.kind === K.VariableDecl && (p as VariableDecl).name === n) continue;
    if (p.kind === K.MemberExpr) {
      const m = p as MemberExpr;
      if (m.member === n || (m.object === v && m.isArrow && strip(dest.type).endsWith('*'))) continue;
    }
    if (p.kind === K.UnaryExpr || p.kind === K.PostfixExpr) {
      const a = p as UnaryExpr;
      if (['*', '!', '~', '+', '-'].includes(a.operator)) continue;
      if (['++', '--'].includes(a.operator) && standalone(p)) continue;
    }
    if (p.kind === K.BinaryExpr && pure(p as BinaryExpr)) continue;
    if (p.kind === K.AssignExpr) {
      const a = p as AssignExpr;
      if (a.left === v && standalone(p) && (a.operator === '=' || pure(a.right))) continue;
      if (a.right === v && scalar(typeOf(a.left))) continue;
    }
    if ([K.CStyleCastExpr, K.StaticCastExpr, K.ReinterpretCastExpr, K.ConstCastExpr].includes(p.kind)) {
      if (scalar(emit((p as CStyleCastExpr).type))) continue;
    }
    if ([K.IfStmt, K.WhileStmt, K.DoWhileStmt, K.ForStmt].includes(p.kind) && (p as IfStmt).condition === v) continue;
    return 'destination may escape or has an unevaluated/unknown use';
  }

  const st = fn.body.statements;
  const sites: Array<{ index: number; statement: Statement; guard: IfStmt; source: string }> = [];
  for (let i = 0; i + 1 < st.length; i++) {
    const statement = st[i]; let rhs: Expression | undefined;
    if (statement.kind === K.DeclStmt) {
      const ds = (statement as DeclStmt).declarations;
      if (ds.length === 1 && ds[0] === dest.local && !dest.local.directInit && !dest.local.copyListInit && dest.local.initializer && dest.local.initializer.kind !== K.InitListExpr) rhs = dest.local.initializer;
    } else if (statement.kind === K.ExprStmt) {
      const e = unwrap((statement as ExprStmt).expression);
      if (e.kind === K.AssignExpr && e.operator === '=' && nameOf(e.left) === name) rhs = e.right;
    }
    const source = rhs && nameOf(rhs), b = source && one(source), next = st[i + 1];
    if (!source || source === name || !b || strip(b.type) !== strip(dest.type) || /\b(?:const|volatile)\b/.test(b.type) || !scalar(b.type)) continue;
    if (b.local && (b.topIndex < 0 || b.topIndex >= i || !b.local.initializer || b.local.specifiers.length)) continue;
    if (dest.topIndex > i || next.kind !== K.IfStmt) continue;
    const guard = next as IfStmt;
    if (guard.init || guard.isConstexpr || guard.elseBranch || !pure(guard.condition)) continue;
    if (!uses(guard.thenBranch, name) || st.slice(i + 2).some(s => uses(s, name))) continue;
    sites.push({ index: i, statement, guard, source });
  }
  if (sites.length !== 1) return `found ${sites.length} private copy/guard sites`;
  const { index, statement, guard, source } = sites[0];
  const condition = cloneNode(guard.condition);
  const rewrite = (e: Expression): void => {
    switch (e.kind) {
      case K.Identifier: if (e.name === name) e.name = source; break;
      case K.ParenExpr: rewrite(e.expression); break;
      case K.MemberExpr: rewrite(e.object); break;
      case K.BinaryExpr: rewrite(e.left); rewrite(e.right); break;
      case K.UnaryExpr: rewrite(e.operand); break;
      case K.CStyleCastExpr: case K.StaticCastExpr: case K.ReinterpretCastExpr: case K.ConstCastExpr: rewrite(e.expression); break;
    }
  }; rewrite(condition);
  guard.condition = condition;
  const body = guard.thenBranch.kind === K.CompoundStmt ? (guard.thenBranch as CompoundStmt).statements : [guard.thenBranch];
  guard.thenBranch = { kind: K.CompoundStmt, statements: [statement, ...body] } as CompoundStmt;
  st.splice(index, 1);
  return undefined;
}
