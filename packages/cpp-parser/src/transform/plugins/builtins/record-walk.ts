/**
 * A typed record view over a byte cursor carried through variable-sized records.
 * This is an opt-in source form, not a tree-wide optimization. The cursor keeps
 * the existing interior field address, including its host-layout-dependent
 * offset, and the existing late size expression. No memory operation moves.
 */
import { NodeKind, isType } from '../../../ast/kinds.js';
import type {
  AnyNode, ASTNode, AssignExpr, BinaryExpr, CallExpr, CommaExpr, CompoundStmt,
  ConditionalExpr, CStyleCastExpr, Expression, ExprStmt, ForStmt,
  FunctionDecl, Identifier, MemberExpr, Statement, SubscriptExpr, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { getChildren, traverseAST } from '../../../ast/visitor.js';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { cloneNode } from '../../transformer.js';
import { buildFunctionFlow, ENTRY_DEF } from '../../cfg/dataflow.js';
import { createExprShape } from './expr-shape.js';
import { localTypesOf } from './compare-form.js';
import { calleeName, scopedLookup, shapeOfSpelling, unwrapParens, type TypeShape } from './call-arg-cast.js';

interface Field { name: string; offset: number; size: number; type: string; bitSize?: number }
export interface RecordWalkTables {
  typedefTargets?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  structLayouts?: Record<string, ReadonlyArray<Field>>;
  /** Names actually declared by the header emitter, including unnamed byte aliases. */
  aggregateMembers?: Record<string, readonly string[]>;
  unionNames?: readonly string[];
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  functionParamTypes?: Record<string, string[]>;
  enclosingSegments?: readonly string[];
}
const un = unwrapParens;
const text = (n: ASTNode): string => emit(n as AnyNode).replace(/\s+/g, '');
const id = (e: Expression | null | undefined): string | undefined => {
  const x = e && un(e); return x?.kind === NodeKind.Identifier ? (x as Identifier).name : undefined;
};
const store = (s: Statement): AssignExpr | undefined => {
  const e = s.kind === NodeKind.ExprStmt ? un((s as ExprStmt).expression) : undefined;
  return e?.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=' ? e as AssignExpr : undefined;
};
const BYTE = new Set(['char', 'signed char', 'unsigned char']);
const INTEGER = /^(?:bool|char|signed char|unsigned char|short|unsigned short|int|unsigned int|long|unsigned long|long long|unsigned long long|__int64|unsigned __int64|intptr_t|uintptr_t|size_t|ptrdiff_t)$/;
const nameExpr = (name: string): Identifier => ({ kind: NodeKind.Identifier, name } as Identifier);
function containsName(root: ASTNode | null | undefined, name: string): boolean {
  if (!root || isType(root.kind)) return false;
  if (root.kind === NodeKind.Identifier) return (root as Identifier).name === name;
  return getChildren(root).some(child => !(root.kind === NodeKind.MemberExpr && child === (root as MemberExpr).member) && containsName(child, name));
}
/** Whether an expression can bind a reference to the pointer variable itself. */
function canAlias(e: ASTNode, name: string): boolean {
  if (e.kind === NodeKind.ParenExpr) return canAlias(un(e as Expression), name);
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name === name;
  if (e.kind === NodeKind.ConditionalExpr) {
    const c = e as ConditionalExpr; return canAlias(c.thenExpr, name) || canAlias(c.elseExpr, name);
  }
  if (e.kind === NodeKind.CommaExpr) {
    const parts = (e as CommaExpr).expressions; return !!parts.length && canAlias(parts[parts.length - 1], name);
  }
  if (e.kind === NodeKind.AssignExpr) return canAlias((e as AssignExpr).left, name);
  if (e.kind === NodeKind.UnaryExpr && ['++', '--'].includes((e as UnaryExpr).operator))
    return canAlias((e as UnaryExpr).operand, name);
  if (e.kind === NodeKind.InitListExpr) return getChildren(e).some(child => canAlias(child, name));
  return false;
}
function member(e: Expression, p: string): MemberExpr | undefined {
  const m = un(e);
  return m.kind === NodeKind.MemberExpr && (m as MemberExpr).isArrow && id((m as MemberExpr).object) === p
    && (m as MemberExpr).member.kind === NodeKind.Identifier ? m as MemberExpr : undefined;
}

/** Mutates only after every proof has succeeded; returns the reason on refusal. */
export function recordWalk(fn: FunctionDecl, pointer: string, index: number, tables?: RecordWalkTables): string | undefined {
  if (!fn.body) return 'no body';
  const all = [...traverseAST(fn.body)];
  // These can hide writes, reference bindings or entries from the statement CFG.
  const opaque = new Set([NodeKind.AsmDecl, NodeKind.TryStmt, NodeKind.SehTryStmt, NodeKind.PpConditionalStmt,
    NodeKind.LambdaExpr, NodeKind.CoAwaitExpr, NodeKind.CoYieldExpr, NodeKind.CoReturnStmt,
    NodeKind.StructDecl, NodeKind.ClassDecl, NodeKind.UnionDecl, NodeKind.TypedefDecl, NodeKind.TypeAliasDecl,
    NodeKind.ReferenceType, NodeKind.RValueReferenceType]);
  if (all.some(n => opaque.has(n.kind))) return 'opaque control, local type or reference binding';
  const types = localTypesOf(fn), declared = types.get(pointer);
  const parameters = fn.parameters.filter(p => p.name?.name === pointer);
  const declarations = all.filter(n => n.kind === NodeKind.VariableDecl && (n as VariableDecl).name.name === pointer) as VariableDecl[];
  if (!declared || parameters.length + declarations.length !== 1 || declarations.some(d => d.specifiers.length))
    return 'pointer must have one automatic local or parameter declaration';
  const resolve = (name: string) => tables?.typedefTargets?.[name];
  const qualifiers = (spelling: string, pattern: RegExp): boolean => {
    const seen = new Set<string>(), todo = [spelling];
    while (todo.length) {
      const s = todo.pop()!; if (pattern.test(s)) return true;
      for (const word of s.match(/[A-Za-z_]\w*/g) ?? []) if (!seen.has(word)) {
        seen.add(word); const target = resolve(word); if (target) todo.push(target);
      }
    }
    return false;
  };
  const qualified = (s: string) => qualifiers(s, /\b(?:const|volatile)\b|&/);
  if (qualified(emit(declared as AnyNode))) return 'qualified pointer';
  const shape = createExprShape(types, { ...tables, returnTypes: tables?.functionReturnTypes, resolve });
  const ps = shape(nameExpr(pointer));
  if (!ps || ps.stars !== 1 || ps.isConst || !tables?.structLayouts?.[ps.base]
    || tables.unionNames?.includes(ps.base)) return 'no known record layout';
  const layout = tables.structLayouts[ps.base];
  const byteField = (m: MemberExpr): string | undefined => {
    const name = (m.member as Identifier).name;
    let fields = layout.filter(f => f.name === name);
    if (!fields.length) {
      // Only the emitter's actual, one-byte unnamed filler members qualify.
      const match = /^field_0x([0-9a-f]+)$/.exec(name);
      if (!match || !tables.aggregateMembers?.[ps.base]?.includes(name)) return undefined;
      const offset = Number.parseInt(match[1], 16);
      fields = layout.filter(f => f.offset <= offset && offset < f.offset + f.size);
      if (fields.length !== 1 || fields[0].name || fields[0].offset !== offset
        || fields[0].size !== 1 || !/^undefined1?$/.test(fields[0].type) || fields[0].bitSize != null) return undefined;
      return 'unsigned char';
    }
    if (fields.length !== 1) return undefined;
    const f = fields[0];
    if (f.size !== 1 || f.bitSize != null || qualified(f.type) || /[\[\]()]/.test(f.type)) return undefined;
    const spelling = tables.structFields?.[ps.base]?.[name];
    const type = shapeOfSpelling(f.type, resolve), declaredType = spelling && shapeOfSpelling(spelling, resolve);
    return spelling && !qualified(spelling) && type?.stars === 0 && BYTE.has(type.base)
      && declaredType && declaredType.stars === 0 && declaredType.base === type.base ? type.base : undefined;
  };
  const byteAddress = (e: Expression): { member: MemberExpr; base: string } | undefined => {
    let x = un(e), castBase: string | undefined;
    while (x.kind === NodeKind.CStyleCastExpr) {
      const c = x as CStyleCastExpr, s = shape(c);
      if (qualified(emit(c.type as AnyNode)) || s?.stars !== 1 || !BYTE.has(s.base)
        || castBase && castBase !== s.base) return undefined;
      castBase = s.base; x = un(c.expression);
    }
    const m = x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '&' ? member((x as UnaryExpr).operand, pointer) : undefined;
    const base = m && byteField(m);
    return m && base && (!castBase || castBase === base) ? { member: m, base } : undefined;
  };
  const lvalueType = (e: Expression): string | undefined => {
    const x = un(e), name = id(x);
    if (name) {
      const local = types.get(name);
      return local ? emit(local as AnyNode) : tables.globalTypes?.[name] ?? tables.enclosingVarTypes?.[name];
    }
    if (x.kind === NodeKind.MemberExpr) {
      const m = x as MemberExpr, object = shape(m.object);
      if (object && object.stars === (m.isArrow ? 1 : 0) && m.member.kind === NodeKind.Identifier)
        return tables.structFields?.[object.base]?.[(m.member as Identifier).name];
    }
    if (x.kind === NodeKind.SubscriptExpr) {
      const base = lvalueType((x as SubscriptExpr).array);
      if (!base || qualified(base)) return undefined;
      // An element of a raw pointer array is a value assignment. Arrays of
      // references cannot be declared; other unknown/operator[] cases refuse.
      if (/\[[^\]]*\]$/.test(base)) return base.replace(/\s*\[[^\]]*\]$/, '');
      if (base.trim().endsWith('*')) return base.trim().slice(0, -1);
    }
    return undefined;
  };
  const candidates: Array<{ block: CompoundStmt; at: number; loop: ForStmt; tail: AssignExpr }> = [];
  for (const n of all) if (n.kind === NodeKind.CompoundStmt) {
    const block = n as CompoundStmt;
    block.statements.forEach((s, at) => {
      if (s.kind !== NodeKind.ForStmt || (s as ForStmt).body.kind !== NodeKind.CompoundStmt) return;
      const loop = s as ForStmt, body = loop.body as CompoundStmt;
      const tail = body.statements.length ? store(body.statements[body.statements.length - 1]) : undefined;
      if (tail && id(tail.left) === pointer) candidates.push({ block, at, loop, tail });
    });
  }
  if (!candidates.length || !index && candidates.length !== 1 || index > candidates.length) return 'no unique selected record loop';
  const { block, at, loop, tail } = candidates[(index || 1) - 1];
  const body = loop.body as CompoundStmt;
  if (containsName(loop.condition, pointer) || containsName(loop.increment, pointer) || containsName(loop.init, pointer))
    return 'loop control names the record pointer';
  const bodyNodes = new Set([...traverseAST(body)]);
  const controls = new Set([NodeKind.LabelStmt, NodeKind.GotoStmt, NodeKind.CaseStmt, NodeKind.DefaultStmt,
    NodeKind.BreakStmt, NodeKind.ContinueStmt, NodeKind.ForStmt, NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForRangeStmt]);
  if ([...bodyNodes].some(n => controls.has(n.kind))) return 'loop has another entry or nested control';
  const cast = un(tail.right);
  if (cast.kind !== NodeKind.CStyleCastExpr) return 'advance is not a record pointer cast';
  const cs = shape(cast);
  if (!cs || cs.stars !== 1 || cs.base !== ps.base || qualified(emit((cast as CStyleCastExpr).type as AnyNode))) return 'advance changes record type';
  const add = un((cast as CStyleCastExpr).expression);
  if (add.kind !== NodeKind.BinaryExpr || (add as BinaryExpr).operator !== '+') return 'advance is not an interior byte address plus a size';
  const b = add as BinaryExpr;
  const left = byteAddress(b.left), right = byteAddress(b.right);
  if (!!left === !!right) return 'advance has no unique byte field address';
  const address = (left ?? right)!, step = left ? b.right : b.left;
  const ss = shape(step);
  if (!(ss?.stars === 0 && INTEGER.test(ss.base)) && un(step).kind !== NodeKind.IntegerLiteral)
    return 'unknown integer size expression';
  const stores: Array<{ at: number; assignment: AssignExpr }> = [];
  body.statements.slice(0, -1).forEach((s, at) => {
    const a = store(s), lhs = a && member(a.left, pointer), addr = a && byteAddress(a.right);
    if (!a || !lhs || !addr || text(addr.member) !== text(address.member) || addr.base !== address.base) return;
    const f = layout.filter(f => f.name === (lhs.member as Identifier).name);
    const type = f.length === 1 ? shapeOfSpelling(f[0].type, resolve) : null;
    const spelling = tables.structFields?.[ps.base]?.[(lhs.member as Identifier).name];
    const declaredType = spelling && shapeOfSpelling(spelling, resolve);
    if (f.length === 1 && f[0].size > 0 && f[0].bitSize == null && !qualified(f[0].type) && type?.stars === 1
      && spelling && !qualified(spelling) && declaredType?.stars === 1 && declaredType.base === type.base
      && (type.base === address.base || type.base === 'void')) stores.push({ at, assignment: a });
  });
  if (stores.length !== 1) return 'no unique interior-address member store';
  // Direct writes, implicit reference calls and aggregate initialization can
  // change/observe a local without a written &P. Do not rely on spelling alone.
  for (const n of all) {
    if (bodyNodes.has(n) && n.kind === NodeKind.AssignExpr && id((n as AssignExpr).left) === pointer && n !== tail)
      return 'another record pointer write';
    if (bodyNodes.has(n) && (n.kind === NodeKind.UnaryExpr || n.kind === NodeKind.PostfixExpr)
      && ['++', '--'].includes((n as UnaryExpr).operator) && id((n as UnaryExpr).operand) === pointer) return 'record pointer increment';
    if (n.kind === NodeKind.AssignExpr && canAlias((n as AssignExpr).right, pointer)) {
      // A class assignment may call operator=(Record*&), even without a written
      // call or &P. A declared raw pointer target proves a value copy.
      const spelling = lvalueType((n as AssignExpr).left);
      if (!spelling || qualified(spelling) || !shapeOfSpelling(spelling, resolve)?.stars)
        return 'pointer may bind through an assignment';
    }
    if (n.kind === NodeKind.NewExpr && containsName(n, pointer)) return 'pointer may bind through allocation';
    if (n.kind === NodeKind.VariableDecl) {
      const d = n as VariableDecl, type = shapeOfSpelling(emit(d.type as AnyNode), resolve);
      if (d.initializer && canAlias(d.initializer, pointer) && !type?.stars) return 'pointer may bind through an aggregate initializer';
    }
    if (n.kind === NodeKind.CallExpr) {
      const call = n as CallExpr;
      for (let i = 0; i < call.arguments.length; ++i) if (canAlias(call.arguments[i], pointer)) {
        const name = calleeName(call.callee);
        const spelling = name && tables.functionParamTypes ? scopedLookup(tables.functionParamTypes, name, tables.enclosingSegments ?? [])?.[i] : undefined;
        const formal = spelling ? shapeOfSpelling(spelling, resolve) : null;
        if (!spelling || qualifiers(spelling, /&/) || !formal || !(formal.stars > 0 || formal.stars === 0 && formal.base === 'bool'))
          return 'pointer may bind by reference at a call';
      }
    }
  }
  const pointerNames = new Set([...types].filter(([,t]) => shapeOfSpelling(emit(t as AnyNode), resolve)?.stars).map(([name]) => name));
  const flow = buildFunctionFlow(fn.body.statements, new Set(types.keys()), { pointers: pointerNames, shortCircuitConditions: true });
  if (flow.isEscaped(pointer)) return 'record pointer escapes';
  const loopNode = flow.nodeOf(loop), tailNode = flow.nodeOf(body.statements[body.statements.length - 1]);
  if (loopNode === undefined || tailNode === undefined) return 'loop is not in the CFG';
  const reaching = flow.reaching(loopNode, pointer);
  if (!reaching.size || [...reaching].some(n => n === ENTRY_DEF ? !parameters.length : !flow.definition(n, pointer)?.killing || !flow.definition(n, pointer)?.rhs))
    return 'record pointer may be indeterminate before the first condition';
  const loopNodes = new Set(flow.cfg.nodes.filter(n => n.stmt && bodyNodes.has(n.stmt) || n.expr && bodyNodes.has(n.expr)).map(n => n.id));
  if (flow.usesOf(tailNode, pointer).some(n => !loopNodes.has(n))) return 'advanced pointer is read outside the loop';
  // All checks precede mutation. Separate declaration/assignment avoids adding
  // an initializer that a pre-existing goto could skip in this statement list.
  const used = new Set(all.filter(n => n.kind === NodeKind.Identifier).map(n => (n as Identifier).name));
  for (const p of fn.parameters) if (p.name) used.add(p.name.name);
  let cursor = 'pRecordCursor'; for (let n = 2; used.has(cursor); ++n) cursor = `pRecordCursor${n}`;
  const template = parse(`void f() { ${address.base}* ${cursor}; ${cursor} = (${address.base}*)p; }`).declarations[0] as FunctionDecl;
  const declaration = template.body!.statements[0], before = template.body!.statements[1] as ExprStmt;
  const initial = (before.expression as AssignExpr).right as CStyleCastExpr;
  initial.expression = nameExpr(pointer);
  const exprStmt = (expression: Expression): ExprStmt => ({ kind: NodeKind.ExprStmt, expression, location: loop.location } as ExprStmt);
  const assignment = (left: Expression, right: Expression, operator: '=' | '+=' = '='): AssignExpr => ({ kind: NodeKind.AssignExpr, left, right, operator } as AssignExpr);
  const bind = cloneNode(cast as CStyleCastExpr); bind.expression = nameExpr(cursor);
  const hit = stores[0];
  body.statements.splice(hit.at, 0, exprStmt(assignment(nameExpr(cursor), cloneNode(hit.assignment.right))));
  hit.assignment.right = nameExpr(cursor);
  body.statements[body.statements.length - 1] = exprStmt(assignment(nameExpr(cursor), cloneNode(step), '+='));
  body.statements.unshift(exprStmt(assignment(nameExpr(pointer), bind)));
  block.statements.splice(at, 0, declaration, before);
  return undefined;
}
