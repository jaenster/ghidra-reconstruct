/** Opt-in final signed-int += literal lifetime, with no observable slot identity. */
import { NodeKind as K } from '../../../ast/kinds.js';
import type { ASTNode, AssignExpr, BinaryExpr, CallExpr, DeclStmt, Expression, ExprStmt, FunctionDecl, Identifier, Statement, VariableDecl } from '../../../ast/nodes.js';
import { getChildren } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { parse } from '../../../parser/index.js';
import { isKeywordString } from '../../../lexer/keywords.js';
import { calleeName, scopedLookup } from './call-arg-cast.js';

export interface CompoundSplitTables {
  typedefTargets?: Record<string, string>;
  functionParamTypes?: Record<string, string[]>;
  enclosingSegments?: readonly string[];
  globalTypes?: Record<string, string>;
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const unwrap = (e: Expression): Expression => { while (e.kind === K.ParenExpr) e = e.expression; return e; };
function nodes(n: ASTNode): ASTNode[] { return [n, ...getChildren(n).flatMap(nodes)]; }
const intNames = new Set(['int', 'signed', 'signed int']);
const valueNames = new Set(['bool', 'char', 'signed char', 'unsigned char', 'short', 'short int', 'signed short', 'unsigned short', 'unsigned short int',
  ...intNames, 'unsigned', 'unsigned int', 'long', 'long int', 'unsigned long', 'unsigned long int', 'long long', 'long long int', 'unsigned long long',
  'unsigned long long int', 'float', 'double', 'long double', 'wchar_t']);

/** Refuses without mutation. The caller supplies a copied function, like other forms. */
export function splitCompoundAdd(fn: FunctionDecl, name: string, type: string, rename: string, tables: CompoundSplitTables = {}): string | undefined {
  if (!fn.body) return 'no function body';
  const st = fn.body.statements, all = nodes(fn.body);
  const opaque = new Set([K.GotoStmt, K.LabelStmt, K.CaseStmt, K.DefaultStmt, K.SwitchStmt, K.ForStmt, K.WhileStmt, K.DoWhileStmt,
    K.TryStmt, K.SehTryStmt, K.LambdaExpr, K.FunctionDecl, K.ClassDecl, K.StructDecl, K.UnionDecl, K.EnumDecl,
    K.TypedefDecl, K.TypeAliasDecl, K.UsingDecl, K.UsingDirective, K.AsmDecl, K.Error, K.PpConditionalStmt]);
  if (all.some(n => opaque.has(n.kind))) return 'compound split needs flat control and no local types or opaque syntax';
  const resolve = (spelling: string, seen = new Set<string>(), allowConst = true): string | undefined => {
    const t = norm(spelling);
    if (/[&*()[\]<>]|\bvolatile\b/.test(t) || (!allowConst && /\bconst\b/.test(t)) || seen.has(t)) return undefined;
    const v = norm(t.replace(/\bconst\b/g, ''));
    if (valueNames.has(v)) return v;
    const target = tables.typedefTargets?.[v];
    if (!target) return undefined;
    seen.add(t); return resolve(target, seen, allowConst);
  };
  const ordinaryInt = (t: string) => intNames.has(resolve(t, new Set(), false) ?? '');
  if (!ordinaryInt(type)) return 'compound split output is not a proven ordinary int';
  const locals = all.filter(n => n.kind === K.VariableDecl) as VariableDecl[];
  const counts = new Map<string, number>();
  for (const p of fn.parameters) if (p.name) counts.set(p.name.name, (counts.get(p.name.name) ?? 0) + 1);
  for (const d of locals) counts.set(d.name.name, (counts.get(d.name.name) ?? 0) + 1);
  if ([...counts.values()].some(n => n !== 1)) return 'a binding is shadowed';
  // No aggregate/array slot, pointer local, reference, static or nested local can
  // expose an adjacent frame slot to a call. This mode deliberately stays flat.
  if (locals.some(d => d.specifiers.length || d.attributes?.length || !ordinaryInt(emit(d.type))
    || !st.some(s => s.kind === K.DeclStmt && (s as DeclStmt).declarations.includes(d)))) return 'compound split needs top-level ordinary int locals';
  const source = locals.find(d => d.name.name === name);
  if (!source || fn.parameters.some(p => p.name?.name === name) || !source.initializer || source.initializer.kind === K.InitListExpr || source.directInit || source.copyListInit) return 'source is not an initialized ordinary int local';
  if (!/^[A-Za-z_]\w*$/.test(rename) || isKeywordString(rename) || all.some(n => n.kind === K.Identifier && (n as Identifier).name === rename)
    || tables.globalTypes?.[rename] || tables.functionParamTypes?.[rename] || tables.typedefTargets?.[rename]) return 'new local name is not fresh';
  const hasName = (n: ASTNode, target: string): boolean => n.kind === K.Identifier ? (n as Identifier).name === target : getChildren(n).some(c => hasName(c, target));
  if (hasName(source.initializer, name)) return 'source initializer reads its uninitialized slot';
  const parent = new Map<ASTNode, ASTNode>();
  for (const n of all) for (const c of getChildren(n)) parent.set(c, n);
  // Taking even another local's address could expose this slot by a frame offset.
  if (all.some(n => n.kind === K.UnaryExpr && (n as Expression & { operator: string }).operator === '&')) return 'an address can expose the frame';
  const topStore = (s: Statement): AssignExpr | undefined => {
    if (s.kind !== K.ExprStmt) return undefined;
    const e = unwrap((s as ExprStmt).expression);
    return e.kind === K.AssignExpr ? e as AssignExpr : undefined;
  };
  const sites = st.flatMap((s, i) => { const a = topStore(s); return a?.operator === '+=' && unwrap(a.left).kind === K.Identifier
    && (unwrap(a.left) as Identifier).name === name ? [{ index: i, store: a }] : []; });
  if (sites.length !== 1) return 'no unique top-level compound-add lifetime';
  const { index, store } = sites[0];
  const declared = st.findIndex(s => s.kind === K.DeclStmt && (s as DeclStmt).declarations.includes(source));
  if (declared >= index) return 'source declaration does not precede the compound store';
  const rhs = unwrap(store.right);
  const literal = rhs.kind === K.UnaryExpr && rhs.operator === '-' ? unwrap(rhs.operand) : rhs;
  if (literal.kind !== K.IntegerLiteral || literal.suffix || literal.value > 0x7fffffffn) return 'compound add needs a signed-int literal';
  if (rhs !== literal && (rhs.kind !== K.UnaryExpr || rhs.operator !== '-')) return 'compound add needs a signed-int literal';
  // Every local that reaches a call must be passed by a known primitive VALUE
  // contract. An unknown call, int&, alias to a reference or shadowed callee refuses.
  const localNames = new Set(locals.map(d => d.name.name));
  const primitiveIntExpr = (e: Expression): boolean => {
    e = unwrap(e);
    if (e.kind === K.IntegerLiteral) return !e.suffix && e.value <= 0x7fffffffn;
    if (e.kind === K.Identifier) {
      const local = locals.find(d => d.name.name === e.name), param = fn.parameters.find(p => p.name?.name === e.name);
      return !!(local || param) && ordinaryInt(emit((local ?? param)!.type));
    }
    if (e.kind === K.UnaryExpr) return ['-', '+', '!'].includes(e.operator) && primitiveIntExpr(e.operand);
    return e.kind === K.BinaryExpr && ['+', '-', '*', '<', '<=', '>', '>=', '==', '!='].includes(e.operator)
      && primitiveIntExpr(e.left) && primitiveIntExpr(e.right);
  };
  const callSafe = (call: CallExpr): boolean => {
    const key = calleeName(call.callee);
    if (!key || counts.has(key)) return false;
    const params = scopedLookup(tables.functionParamTypes ?? {}, key, tables.enclosingSegments ?? []);
    return !!params && params.length === call.arguments.length && call.arguments.every((a, i) =>
      ![...localNames].some(n => hasName(a, n)) || !!resolve(params[i]));
  };
  if (all.some(n => n.kind === K.CallExpr && [...localNames].some(v => hasName(n, v)) && !callSafe(n as CallExpr))) return 'a local may bind an unknown or reference call argument';
  const tail = st.slice(index + 1);
  let reads = 0;
  for (let i = 0; i < tail.length; i++) {
    const s = tail[i];
    if (s.kind === K.ReturnStmt && !s.value && i === tail.length - 1) continue;
    if (s.kind !== K.ExprStmt || unwrap(s.expression).kind !== K.CallExpr) return 'compound lifetime must end in plain calls';
    const call = unwrap(s.expression) as CallExpr;
    if (!callSafe(call)) return 'compound lifetime has an uncertain call contract';
    for (const a of call.arguments) if (hasName(a, name)) {
      const e = unwrap(a); if (e.kind !== K.Identifier || e.name !== name) return 'compound result is not a whole value argument'; reads++;
    }
  }
  if (!reads) return 'compound lifetime has no value use';
  // Check all earlier uses for an implicit reference binding or an unevaluated
  // observation. The suffix is already restricted to known by-value calls.
  for (const n of all) if (n.kind === K.Identifier && (n as Identifier).name === name) {
    let value = n, p = parent.get(value);
    while (p?.kind === K.ParenExpr) { value = p; p = parent.get(value); }
    if (p === source && source.name === n) continue;
    if (p === store && store.left === value) continue;
    if (p?.kind === K.CallExpr && (p as CallExpr).arguments.includes(value as Expression) && callSafe(p as CallExpr)) continue;
    if (p?.kind === K.BinaryExpr && primitiveIntExpr(p as BinaryExpr)) continue;
    return 'compound source has a slot-sensitive or unknown use';
  }
  const parsed = parse(`void __split_add() { ${type} ${rename} = ${name} + (${emit(store.right)}); }`);
  const declaration = (parsed.declarations[0] as FunctionDecl).body!.statements[0];
  if (declaration?.kind !== K.DeclStmt || declaration.declarations.length !== 1) return 'fresh declaration did not parse';
  const fresh = declaration.declarations[0];
  if (fresh.kind !== K.VariableDecl || fresh.name.name !== rename) return 'fresh declaration did not parse';
  st[index] = declaration;
  for (const s of tail) for (const n of nodes(s)) if (n.kind === K.Identifier && (n as Identifier).name === name) (n as Identifier).name = rename;
  return undefined;
}
