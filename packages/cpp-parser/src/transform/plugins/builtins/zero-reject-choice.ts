/** A zero rejection followed by one of two calls, sharing an existing tail. */
import { NodeKind as K } from '../../../ast/kinds.js';
import type { ASTNode, CompoundStmt, Expression, ExprStmt, FunctionDecl, GotoStmt, Identifier, IfStmt, LabelStmt, ReturnStmt, Statement, VariableDecl } from '../../../ast/nodes.js';
import { getChildren } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { cloneNode } from '../../transformer.js';
import { calleeName } from './call-arg-cast.js';

interface Tables {
  functionReturnTypes?: Record<string, string>;
  functionParamTypes?: Record<string, string[]>;
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  enclosingSegments?: readonly string[];
}

// Only language builtin types: an unqualified SDK-looking typedef can be hidden
// by an enclosing class/alias, and this form needs no such type inference.
const integers = new Set(['bool', 'char', 'signedchar', 'unsignedchar', 'short', 'shortint', 'signedshort', 'signedshortint', 'unsignedshort', 'unsignedshortint', 'int', 'signed', 'signedint', 'unsigned', 'unsignedint', 'long', 'longint', 'signedlong', 'signedlongint', 'unsignedlong', 'unsignedlongint', 'longlong', 'longlongint', 'signedlonglong', 'signedlonglongint', 'unsignedlonglong', 'unsignedlonglongint']);
const unwrap = (e: Expression): Expression => { while (e.kind === K.ParenExpr) e = e.expression; return e; };
const id = (e: Expression, name: string) => { const n = unwrap(e); return n.kind === K.Identifier && n.name === name; };
const zero = (e: Expression) => { const n = unwrap(e); return n.kind === K.IntegerLiteral && n.value === 0n; };
function zeroTest(e: Expression, name: string): boolean {
  const n = unwrap(e);
  return n.kind === K.UnaryExpr && n.operator === '!' && id(n.operand, name)
    || n.kind === K.BinaryExpr && n.operator === '==' && ((id(n.left, name) && zero(n.right)) || (zero(n.left) && id(n.right, name)));
}
const statements = (s: Statement): Statement[] => s.kind === K.CompoundStmt ? s.statements : [s];
const plainIf = (s: Statement | null): s is IfStmt => !!s && s.kind === K.IfStmt && !s.init && !s.isConstexpr;
const callStatement = (s: Statement): s is ExprStmt => s.kind === K.ExprStmt && unwrap(s.expression).kind === K.CallExpr;
const compound = (stmts: Statement[]): CompoundStmt => ({ kind: K.CompoundStmt, statements: stmts }) as CompoundStmt;
function nodes(n: ASTNode): ASTNode[] { return [n, ...getChildren(n).flatMap(nodes)]; }

/** Checks the whole site before changing any statement. */
export function zeroRejectChoice(fn: FunctionDecl, first: string, second: string, tables: Tables = {}): string | undefined {
  if (!fn.body || first === second) return 'distinct integer bindings and a body are required';
  const all = nodes(fn.body);
  const opaque = new Set([K.LambdaExpr, K.FunctionDecl, K.ClassDecl, K.StructDecl, K.UnionDecl, K.EnumDecl,
    K.TypedefDecl, K.TypeAliasDecl, K.UsingDecl, K.UsingDirective, K.TryStmt, K.SehTryStmt,
    K.Error, K.AsmDecl, K.PpConditionalStmt, K.CoAwaitExpr, K.CoYieldExpr, K.CoReturnStmt]);
  if (all.some(n => opaque.has(n.kind))) return 'local types, nested functions or opaque control flow';
  const bindings = new Map<string, Array<{ type: string; ordinary: boolean; topIndex: number }>>();
  const add = (name: string, type: string, ordinary: boolean, topIndex: number) => bindings.set(name, [...(bindings.get(name) ?? []), { type, ordinary, topIndex }]);
  for (const p of fn.parameters) if (p.name && !p.isVariadic) add(p.name.name, emit(p.type), true, -1);
  for (const n of all) if (n.kind === K.VariableDecl) {
    const v = n as VariableDecl;
    const topIndex = fn.body.statements.findIndex(s => s.kind === K.DeclStmt && s.declarations.includes(v));
    add(v.name.name, emit(v.type), v.specifiers.length === 0 && topIndex >= 0, topIndex);
  }
  for (const name of [first, second]) {
    const bs = bindings.get(name);
    if (bs?.length !== 1 || !bs[0].ordinary || /\bvolatile\b|[&*()[\]<>:]/.test(bs[0].type)
      || !integers.has(bs[0].type.replace(/\bconst\b/g, '').replace(/\s+/g, ''))) return 'tests need unique ordinary nonvolatile integer bindings';
  }
  // Require declared direct functions. An untyped F() could be a callable object
  // or a source macro rather than a call whose full-expression lifetime is known.
  const typedCall = (s: ExprStmt): boolean => {
    const e = unwrap(s.expression); if (e.kind !== K.CallExpr) return false;
    const callee = unwrap(e.callee);
    if (callee.kind !== K.Identifier && callee.kind !== K.QualifiedId) return false;
    const name = calleeName(callee); if (!name || bindings.has(name)) return false;
    const root = name.startsWith('::'), bare = name.replace(/^::/, '');
    const scopes = root ? [] : tables.enclosingSegments ?? [];
    for (let depth = scopes.length; depth >= 0; depth--) {
      const key = [...scopes.slice(0, depth), bare].join('::');
      if (tables.globalTypes?.[key] || tables.enclosingVarTypes?.[key]) return false;
      if (tables.functionReturnTypes?.[key] !== undefined) {
        const parameters = tables.functionParamTypes?.[key];
        return !!parameters && parameters.length === e.arguments.length && !parameters.some(t => t.includes('...'));
      }
    }
    return false;
  };

  const st = fn.body.statements;
  const sites: Array<{ index: number; outer: IfStmt; zeroReturn: ReturnStmt; zeroCall: ExprStmt; nonzeroCall: ExprStmt; secondZero: Expression }> = [];
  for (let i = 0; i + 2 < st.length; i++) {
    if ([first, second].some(name => bindings.get(name)![0].topIndex >= i)) continue;
    const outer = st[i]; if (!plainIf(outer) || !zeroTest(outer.condition, first) || !outer.elseBranch) continue;
    const then = statements(outer.thenBranch), otherwise = statements(outer.elseBranch);
    if (then.length !== 1 || otherwise.length !== 1 || !plainIf(then[0]) || !plainIf(otherwise[0])) continue;
    const a = then[0], b = otherwise[0];
    if (a.elseBranch || b.elseBranch || !zeroTest(a.condition, second) || !zeroTest(b.condition, second)) continue;
    const rejection = statements(a.thenBranch), zeroBranch = statements(b.thenBranch);
    if (rejection.length !== 1 || rejection[0].kind !== K.ReturnStmt || zeroBranch.length !== 2 || !callStatement(zeroBranch[0]) || !typedCall(zeroBranch[0]) || zeroBranch[1].kind !== K.GotoStmt) continue;
    const nonzero = st[i + 1], label = st[i + 2];
    if (!callStatement(nonzero) || !typedCall(nonzero) || label.kind !== K.LabelStmt) continue;
    const target = (zeroBranch[1] as GotoStmt).label.name;
    if ((label as LabelStmt).label.name !== target || all.filter(n => n.kind === K.LabelStmt && (n as LabelStmt).label.name === target).length !== 1) continue;
    sites.push({ index: i, outer, zeroReturn: rejection[0] as ReturnStmt, zeroCall: zeroBranch[0], nonzeroCall: nonzero, secondZero: a.condition });
  }
  if (sites.length !== 1) return `found ${sites.length} zero-rejection/call-choice sites`;
  const { index, outer, zeroReturn, zeroCall, nonzeroCall, secondZero } = sites[0];
  // Only primitive local/parameter values are reread. Nothing with effects runs
  // between the two tests, so the extra second read cannot observe a new value.
  const rejection = { kind: K.IfStmt, condition: { kind: K.BinaryExpr, operator: '&&', left: cloneNode(outer.condition), right: cloneNode(secondZero) }, thenBranch: compound([zeroReturn]), elseBranch: null, isConstexpr: false } as IfStmt;
  const choice = { kind: K.IfStmt, condition: { kind: K.Identifier, name: second } as Identifier, thenBranch: compound([nonzeroCall]), elseBranch: compound([zeroCall]), isConstexpr: false } as IfStmt;
  // Keep the shared label and every other incoming goto intact. The branch
  // bodies contain only their call, so moving the calls changes no local lifetime.
  st.splice(index, 2, rejection, choice);
  return undefined;
}
