/** Restore a measured group of cases which already take the terminal default path. */
import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, CaseStmt, CompoundStmt, CStyleCastExpr, DefaultStmt, Expression, FunctionDecl, Identifier, IntegerLiteralExpr, ReturnStmt, Statement, SwitchStmt, UnaryExpr, VariableDecl } from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { Expr } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import { createExprShape } from './expr-shape.js';
import { localTypesOf } from './compare-form.js';
import { calleeName, shapeOfNode } from './call-arg-cast.js';
import type { SelectArgumentOptions } from './select-argument.js';

const norm = (s: string) => s.replace(/\s+/g, '').replace(/(?<![\w:])(?:::)?(?:[A-Za-z_]\w*::)+(?=[A-Za-z_~])/g, '');
const unwrap = (e: Expression): Expression => { while (e.kind === NodeKind.ParenExpr) e = e.expression; return e; };
type Range = readonly [bigint, bigint];
const ranges: Record<string, Range> = {
  bool: [0n, 1n], char: [-128n, 127n], 'signed char': [-128n, 127n], 'unsigned char': [0n, 255n],
  short: [-32768n, 32767n], 'unsigned short': [0n, 65535n],
  int: [-0x80000000n, 0x7fffffffn], 'unsigned int': [0n, 0xffffffffn],
  long: [-0x80000000n, 0x7fffffffn], 'unsigned long': [0n, 0xffffffffn],
  'long long': [-(1n << 63n), (1n << 63n) - 1n], 'unsigned long long': [0n, (1n << 64n) - 1n],
};

/** Numeric spellings only; range and enum-label collisions are checked at the switch. */
export function switchDefaultValue(s: string): bigint | undefined {
  if (!/^-?(?:0x[\da-f]+|0|[1-9]\d*)$/i.test(s)) return undefined;
  const value = s[0] === '-' ? -BigInt(s.slice(1)) : BigInt(s);
  return value >= -(1n << 63n) && value < (1n << 64n) ? value : undefined;
}

export function restoreSwitchDefault(fn: FunctionDecl, expr: string, values: readonly string[], index: number | undefined, tables: SelectArgumentOptions = {}): string | undefined {
  if (!fn.body) return 'no body';
  const wanted = values.map(switchDefaultValue);
  if (!wanted.length || wanted.some(v => v === undefined) || new Set(wanted).size !== wanted.length) return 'distinct integral case values required';
  if (index !== undefined && (!Number.isSafeInteger(index) || index < 1)) return 'invalid switch occurrence';
  const parents = new Map<ASTNode, ASTNode>();
  const visit = (node: ASTNode) => {
    for (const [key, value] of Object.entries(node)) {
      if (['location', 'leadingTrivia', 'trailingTrivia'].includes(key)) continue;
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) if (child && typeof child === 'object' && typeof child.kind === 'string') {
        parents.set(child, node); visit(child);
      }
    }
  };
  visit(fn);
  const switches = (findNodesByKind(fn.body, NodeKind.SwitchStmt) as SwitchStmt[]).filter(s => norm(emit(s.condition)) === norm(expr));
  if (index === undefined && switches.length !== 1) return `${switches.length} matching switches; select one explicitly`;
  const sw = switches[(index ?? 1) - 1];
  if (!sw || sw.body.kind !== NodeKind.CompoundStmt) return 'no matching compound switch';
  for (let p = parents.get(sw); p && p !== fn; p = parents.get(p)) {
    if (p.kind === NodeKind.FunctionDecl || p.kind === NodeKind.LambdaExpr) return 'nested function switch';
  }
  const body = sw.body as CompoundStmt;
  const types = localTypesOf(fn);
  const counts = new Map<string, number>();
  for (const p of fn.parameters) if (p.name) counts.set(p.name.name, (counts.get(p.name.name) ?? 0) + 1);
  for (const d of findNodesByKind(fn.body, NodeKind.VariableDecl) as VariableDecl[]) counts.set(d.name.name, (counts.get(d.name.name) ?? 0) + 1);
  for (const id of findNodesByKind(sw.condition, NodeKind.Identifier) as Identifier[]) if ((counts.get(id.name) ?? 0) > 1) return 'ambiguous selector declaration';
  const resolve = (name: string) => tables.typedefTargets?.[name];
  const shapeOf = createExprShape(types, { ...tables, returnTypes: tables.functionReturnTypes, resolve });
  const shape = shapeOf(sw.condition);
  if (!shape || shape.stars !== 0 || !ranges[shape.base]) return 'known integral selector required';
  // bool and narrow integer selectors undergo integral promotion before cases convert.
  const range = ['bool', 'char', 'signed char', 'unsigned char', 'short', 'unsigned short'].includes(shape.base) ? ranges.int : ranges[shape.base];
  const inRange = (v: bigint) => v >= range[0] && v <= range[1];
  if (!wanted.every(v => inRange(v!))) return 'case value outside promoted selector range';

  const constant = (expression: Expression): bigint | undefined => {
    const e = unwrap(expression);
    if (e.kind === NodeKind.IntegerLiteral) return (e as IntegerLiteralExpr).value;
    if (e.kind === NodeKind.BoolLiteral) return e.value ? 1n : 0n;
    if (e.kind === NodeKind.UnaryExpr && ['+', '-'].includes((e as UnaryExpr).operator)) {
      const u = e as UnaryExpr, n = constant(u.operand);
      return n === undefined ? undefined : u.operator === '-' ? -n : n;
    }
    if (e.kind === NodeKind.CStyleCastExpr) {
      const c = e as CStyleCastExpr, t = shapeOfNode(c.type, 0, resolve), n = constant(c.expression), r = t?.stars === 0 ? ranges[t.base] : undefined;
      return n !== undefined && r && n >= r[0] && n <= r[1] ? n : undefined;
    }
    if (e.kind === NodeKind.Identifier || e.kind === NodeKind.QualifiedId) {
      const name = calleeName(e);
      if (!name || types.has(name) || tables.globalTypes?.[name] || tables.enclosingVarTypes?.[name]) return undefined;
      const value = tables.enumValues?.[name];
      return Number.isSafeInteger(value) ? BigInt(value!) : undefined;
    }
    return undefined;
  };
  // Labels in a nested switch belong to it; nested/hidden labels in other
  // control flow are refused rather than mistaken for a flat case group.
  const ownLabels: ASTNode[] = [];
  const ownWalk = (node: ASTNode) => {
    if (node.kind === NodeKind.SwitchStmt && node !== sw) return;
    if (node.kind === NodeKind.CaseStmt || node.kind === NodeKind.DefaultStmt) ownLabels.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (['location', 'leadingTrivia', 'trailingTrivia'].includes(key)) continue;
      for (const child of Array.isArray(value) ? value : [value]) if (child && typeof child === 'object' && typeof child.kind === 'string') ownWalk(child);
    }
  };
  ownWalk(body);
  const flat = body.statements.filter(s => s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt);
  if (ownLabels.length !== flat.length || !flat.some(s => s.kind === NodeKind.CaseStmt)) return 'flat existing case labels required';
  const seen = new Set<bigint>();
  for (const label of flat) if (label.kind === NodeKind.CaseStmt) {
    const value = constant((label as CaseStmt).value);
    if (value === undefined || !inRange(value) || seen.has(value)) return 'unresolved or duplicate existing case';
    seen.add(value);
  }
  if (wanted.some(v => seen.has(v!))) return 'case already exists, including enum aliases';
  if ([NodeKind.GotoStmt, NodeKind.LabelStmt].some(k => findNodesByKind(body, k).length)) return 'label or goto in switch';
  if ((findNodesByKind(body, NodeKind.VariableDecl) as VariableDecl[]).some(v => v.specifiers.includes('static'))) return 'static declaration in switch';
  // A new label must not cross an unbraced declaration's initialization.
  const unsafeScope = (s: Statement): boolean => s.kind === NodeKind.DeclStmt || ((s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) && unsafeScope(s.statement));
  if (body.statements.some(unsafeScope)) return 'declaration at switch scope';
  const returnShape = shapeOfNode(fn.returnType, 0, resolve);
  const isVoid = returnShape?.stars === 0 && returnShape.base === 'void';
  const terminal = (s: Statement | undefined): ReturnStmt | undefined => {
    while (s?.kind === NodeKind.CompoundStmt && s.statements.length === 1) s = s.statements[0];
    if (s?.kind !== NodeKind.ReturnStmt) return undefined;
    if (!s.value) return isVoid ? s : undefined;
    return returnShape?.stars === 0 && ranges[returnShape.base] && constant(s.value) !== undefined ? s : undefined;
  };
  const defaults = flat.filter(s => s.kind === NodeKind.DefaultStmt) as DefaultStmt[];
  if (defaults.length > 1) return 'multiple defaults';
  let fallback: ReturnStmt | undefined, insertAt = body.statements.length;
  if (defaults.length) {
    fallback = terminal(defaults[0].statement);
    insertAt = body.statements.indexOf(defaults[0]);
  } else {
    const parent = parents.get(sw);
    if (parent?.kind === NodeKind.CompoundStmt) {
      const b = parent as CompoundStmt;
      fallback = terminal(b.statements[b.statements.indexOf(sw) + 1]);
    }
    if (!fallback && isVoid) {
      let child: ASTNode = sw, end = true;
      for (let p = parents.get(child); p && p !== fn; child = p, p = parents.get(p)) {
        if (p.kind === NodeKind.CompoundStmt) {
          const b = p as CompoundStmt, at = b.statements.indexOf(child as Statement);
          if (at < 0 || b.statements.slice(at + 1).some(s => s.kind !== NodeKind.NullStmt)) { end = false; break; }
        } else if (p.kind !== NodeKind.IfStmt) { end = false; break; }
      }
      if (end) fallback = { kind: NodeKind.ReturnStmt } as ReturnStmt;
    }
  }
  if (!fallback) return 'no primitive constant return or terminal void default';
  const literal = (n: bigint): Expression => {
    if (n === -(1n << 63n)) return Expr.binary(Expr.intLiteral(n + 1n), '-', Expr.intLiteral(1));
    const e = Expr.intLiteral(n, n > (1n << 63n) - 1n ? 16 : 10);
    if (n > (1n << 63n) - 1n) { e.suffix = 'ULL'; e.raw += 'ULL'; }
    return e;
  };
  const labels = wanted.map((value, i) => ({
    kind: NodeKind.CaseStmt, value: literal(value!),
    statement: i === wanted.length - 1 ? structuredClone(fallback) : { kind: NodeKind.NullStmt },
  } as CaseStmt));
  body.statements.splice(insertAt, 0, ...labels);
  return undefined;
}
