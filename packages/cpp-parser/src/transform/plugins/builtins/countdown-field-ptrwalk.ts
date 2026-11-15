/** The measured scalar-field walk of a positive, bounded record countdown. */
import { NodeKind, isType } from '../../../ast/kinds.js';
import type {
  ASTNode, AnyNode, CompoundStmt, DoWhileStmt, Expression, ExprStmt, FunctionDecl,
  Identifier, MemberExpr, ParameterDecl, Statement, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { getChildren, traverseAST } from '../../../ast/visitor.js';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { isKeywordString } from '../../../lexer/keywords.js';
import type { Vc8Form, Vc8FormTables } from './vc8-form.js';

type Form = Extract<Vc8Form, { op: 'ptrwalk' }>;
class Refused extends Error {}
const fail = (why: string): never => { throw new Refused(why); };
const unwrap = (node: Expression): Expression => node.kind === NodeKind.ParenExpr ? unwrap(node.expression) : node;
const id = (node: Expression, name: string): boolean => {
  const n = unwrap(node); return n.kind === NodeKind.Identifier && n.name === name;
};
const literal = (node: Expression): bigint | undefined => {
  const n = unwrap(node); return n.kind === NodeKind.IntegerLiteral ? n.value : undefined;
};
const spelling = (node: ASTNode): string => emit(node as never).replace(/\s+/g, ' ').replace(/\s*\*\s*/g, '*').trim();
const WORDS = new Set(['int', 'unsigned int', 'int32_t', 'uint32_t', 'uint', 'DWORD', 'LONG', 'ULONG']);
const SCALARS: Record<string, number> = {
  char: 1, 'signed char': 1, 'unsigned char': 1, byte: 1, BYTE: 1, int8_t: 1, uint8_t: 1,
  short: 2, 'unsigned short': 2, int16_t: 2, uint16_t: 2,
  int: 4, 'unsigned int': 4, int32_t: 4, uint32_t: 4, float: 4, double: 8,
};
function resolved(raw: string, tables?: Vc8FormTables): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  const seen = new Set<string>();
  while (tables?.typedefTargets?.[text]) {
    if (seen.has(text)) fail('cyclic typedef');
    seen.add(text); text = tables.typedefTargets[text].replace(/\s+/g, ' ').trim();
  }
  return text.replace(/\s*\*\s*/g, '*');
}
function count(root: ASTNode, name: string): number {
  if (root.kind === NodeKind.MemberExpr) return count((root as MemberExpr).object, name);
  if (root.kind === NodeKind.QualifiedId) return 0;
  if (root.kind === NodeKind.Identifier) return (root as Identifier).name === name ? 1 : 0;
  return getChildren(root).reduce((n, child) => n + count(child, name), 0);
}
function valueNames(root: ASTNode): string[] {
  if (isType(root.kind)) return [];
  if (root.kind === NodeKind.MemberExpr) return valueNames((root as MemberExpr).object);
  if (root.kind === NodeKind.QualifiedId) return [spelling(root)];
  if (root.kind === NodeKind.Identifier) return [(root as Identifier).name];
  return getChildren(root).flatMap(valueNames);
}
function statement(source: string): Statement {
  return (parse(`void __walk() { ${source} }`).declarations[0] as FunctionDecl).body!.statements[0];
}
function decrement(statement: Statement, name: string): boolean {
  if (statement.kind !== NodeKind.ExprStmt) return false;
  const e = unwrap(statement.expression);
  if (e.kind === NodeKind.PostfixExpr || e.kind === NodeKind.UnaryExpr) return e.operator === '--' && id(e.operand, name);
  return e.kind === NodeKind.AssignExpr && e.operator === '-=' && id(e.left, name) && literal(e.right) === 1n;
}
function descendingIndex(expr: Expression, counter: string, start: bigint): boolean {
  const e = unwrap(expr);
  if (e.kind !== NodeKind.BinaryExpr) return false;
  if (e.operator === '-') return literal(e.left) === start && id(e.right, counter);
  if (e.operator !== '+') return false;
  const negative = (x: Expression): boolean => {
    const n = unwrap(x); return n.kind === NodeKind.UnaryExpr && n.operator === '-' && id(n.operand, counter);
  };
  return (negative(e.left) && literal(e.right) === start) || (literal(e.left) === start && negative(e.right));
}
function test(expr: Expression, counter: string): boolean {
  const e = unwrap(expr);
  return id(e, counter) || (e.kind === NodeKind.BinaryExpr && e.operator === '!=' &&
    ((id(e.left, counter) && literal(e.right) === 0n) || (literal(e.left) === 0n && id(e.right, counter))));
}
function rewrite(root: ASTNode, targets: Set<ASTNode>, name: string): ASTNode {
  if (targets.has(root)) return {
    kind: NodeKind.UnaryExpr, operator: '*',
    operand: { kind: NodeKind.Identifier, name, leadingTrivia: [], trailingTrivia: [] } as Identifier,
    leadingTrivia: root.leadingTrivia, trailingTrivia: root.trailingTrivia, location: root.location,
  } as UnaryExpr;
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(root)) {
    if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia') continue;
    const visit = (child: unknown): unknown => child && typeof child === 'object' && 'kind' in child
      ? rewrite(child as ASTNode, targets, name) : child;
    const next = Array.isArray(value) ? value.map(visit) : visit(value);
    if (Array.isArray(value) ? (next as unknown[]).some((x, i) => x !== value[i]) : next !== value) {
      out ??= { ...root }; out[key] = next;
    }
  }
  return out ? out as unknown as ASTNode : root;
}

/** No edit is made until the complete candidate and all its uses have been checked. */
export function countdownFieldPtrwalk(fn: FunctionDecl, form: Form, tables?: Vc8FormTables): { applied: true } | { why: string } {
  try {
    const { counter, array, name } = form;
    if (isKeywordString(name)) fail('pointer name is a keyword');
    const all = [...traverseAST(fn.body!)] as AnyNode[];
    if (all.some(n => [NodeKind.GotoStmt, NodeKind.LabelStmt].includes(n.kind))) fail('external or labelled control flow');
    const declarations = all.filter((n): n is VariableDecl => n.kind === NodeKind.VariableDecl);
    const params = fn.parameters as ParameterDecl[];
    const named = (n: string): number => declarations.filter(d => d.name.name === n).length + params.filter(p => p.name?.name === n).length;
    if (named(counter) !== 1 || named(array) !== 1 || named(name) !== 0 || count(fn.body!, name)) fail('shadowed, missing or occupied name');
    if ([...declarations, ...params].some(d => new RegExp(`\\b${name}\\b`).test(spelling(d.type)))) fail('pointer name hides a type');
    const parameter = params.find(p => p.name?.name === array);
    if (!parameter) fail('record base is not a pointer parameter');
    const pointer = resolved(spelling(parameter.type), tables);
    if (!pointer.endsWith('*') || /\b(?:const|volatile)\b|&/.test(pointer)) fail('record base is not a plain nonvolatile pointer');
    const record = resolved(pointer.slice(0, -1), tables);
    if (tables?.unionNames?.includes(record)) fail('union member lifetime');
    const layout = tables?.structLayouts?.[record]; const size = tables?.typeSize?.(record) ?? tables?.aggregateSizes?.[record];
    const scalar = resolved(form.type, tables); const elementSize = SCALARS[scalar];
    if (!layout || !size || !Number.isSafeInteger(size) || !elementSize || size % elementSize || size <= 0) fail('unknown record stride or scalar type');
    if (all.some(n => n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&' &&
      (id((n as UnaryExpr).operand, counter) || id((n as UnaryExpr).operand, array)))) fail('counter or base address escapes');
    if (declarations.some(d => /&/.test(spelling(d.type)) && d.initializer &&
      (count(d.initializer, counter) || count(d.initializer, array)))) fail('reference binding');
    const candidates: Array<{ block: CompoundStmt; at: number; loop: DoWhileStmt; targets: Set<ASTNode>; field: string }> = [];
    for (const b of all.filter((n): n is CompoundStmt => n.kind === NodeKind.CompoundStmt)) {
      for (let at = 1; at < b.statements.length; at++) {
        const s = b.statements[at]; if (s.kind !== NodeKind.DoWhileStmt || !test(s.condition, counter) || s.body.kind !== NodeKind.CompoundStmt) continue;
        const d = b.statements[at - 1]; if (d.kind !== NodeKind.DeclStmt || d.declarations.length !== 1) continue;
        const decl = d.declarations[0]; if (decl.kind !== NodeKind.VariableDecl || decl.name.name !== counter || !decl.initializer) continue;
        if (decl.specifiers.length || decl.attributes.length || decl.directInit || decl.copyListInit || decl.bitWidth) fail('counter is not an ordinary automatic scalar');
        const start = literal(decl.initializer); if (start === undefined || start < 1n || start > 0x7fffffffn || !WORDS.has(resolved(spelling(decl.type), tables))) continue;
        const body = s.body; const tail = body.statements.at(-1); if (!tail || !decrement(tail, counter)) continue;
        const nodes = [...traverseAST(body)] as AnyNode[];
        if (nodes.some(n => [NodeKind.CallExpr, NodeKind.NewExpr, NodeKind.DeleteExpr, NodeKind.ReturnStmt,
          NodeKind.BreakStmt, NodeKind.ContinueStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt, NodeKind.WhileStmt, NodeKind.DoWhileStmt,
          NodeKind.SwitchStmt, NodeKind.TryStmt, NodeKind.SehTryStmt, NodeKind.AsmDecl, NodeKind.LambdaExpr,
          NodeKind.StaticCastExpr, NodeKind.DynamicCastExpr, NodeKind.ReinterpretCastExpr,
          NodeKind.ConstCastExpr, NodeKind.FunctionalCastExpr].includes(n.kind))) fail('calls, nested or escaping control flow');
        for (const used of new Set(valueNames(body))) {
          if (used === array || used === counter) continue;
          const local = declarations.find(d => d.name.name === used) ?? params.find(p => p.name?.name === used);
          const type = local ? spelling(local.type) : tables?.globalTypes?.[used];
          if (!type || !SCALARS[resolved(type, tables)]) fail('unknown or nonprimitive value in loop');
        }
        for (const n of nodes) {
          if (n.kind === NodeKind.VariableDecl && (!SCALARS[resolved(spelling(n.type), tables)] ||
            n.specifiers.length || n.attributes.length)) fail('nontrivial loop local');
          if (n.kind === NodeKind.CStyleCastExpr && !SCALARS[resolved(spelling(n.type), tables)]) fail('nonprimitive cast');
          if (n.kind === NodeKind.AssignExpr && (id(n.left, counter) || id(n.left, array)) && n !== (tail as ExprStmt).expression) fail('counter or base is written');
          if ((n.kind === NodeKind.PostfixExpr || n.kind === NodeKind.UnaryExpr) && ['++', '--'].includes(n.operator) &&
            (id(n.operand, counter) || id(n.operand, array)) && n !== (tail as ExprStmt).expression) fail('counter or base is stepped');
        }
        const targets = new Set<ASTNode>(); let field: string | undefined;
        for (const n of nodes) {
          if (n.kind !== NodeKind.MemberExpr || n.isArrow || n.member.kind !== NodeKind.Identifier) continue;
          const sub = unwrap(n.object); if (sub.kind !== NodeKind.SubscriptExpr || !id(sub.array, array) || !descendingIndex(sub.index, counter, start)) continue;
          if (field && field !== n.member.name) fail('more than one record member'); field = n.member.name; targets.add(n);
        }
        if (!field || !targets.size || count(body, array) !== targets.size || count(body, counter) !== targets.size + 1) fail('unaccounted counter or base use');
        const entries = layout.filter(f => f.name === field); if (entries.length !== 1) fail('ambiguous field layout');
        const entry = entries[0];
        if (entry.bitSize !== undefined || entry.size !== elementSize || resolved(entry.type, tables) !== scalar ||
          entry.offset < 0 || entry.offset % elementSize || entry.offset + entry.size > size) fail('field does not match scalar stride');
        const first = body.statements[0]; const evaluated = first?.kind === NodeKind.IfStmt ? first.condition
          : first?.kind === NodeKind.ExprStmt ? first.expression : undefined;
        if (!evaluated || ![...traverseAST(evaluated)].some(n => targets.has(n)) || ([...traverseAST(evaluated)] as AnyNode[]).some(n =>
          n.kind === NodeKind.ConditionalExpr || (n.kind === NodeKind.BinaryExpr && ['&&', '||'].includes(n.operator)))) fail('first field access is conditional');
        candidates.push({ block: b, at, loop: s, targets, field });
      }
    }
    const hit = form.index === 0 ? (candidates.length === 1 ? candidates[0] : fail(`${candidates.length} countdown field walks`))
      : candidates[form.index - 1] ?? fail('no selected countdown field walk');
    const body = rewrite(hit.loop.body, hit.targets, name) as CompoundStmt;
    body.statements.splice(body.statements.length - 1, 0, statement(`${name} += ${size / elementSize};`));
    hit.loop.body = body;
    hit.block.statements.splice(hit.at - 1, 0, statement(`${form.type}* ${name} = &${array}[0].${hit.field};`));
    return { applied: true };
  } catch (e) {
    if (e instanceof Refused) return { why: e.message };
    throw e;
  }
}
