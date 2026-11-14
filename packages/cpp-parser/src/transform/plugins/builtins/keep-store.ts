/**
 * Keep an existing, overwritten zero store for an opt-in VC8 form.
 *
 * Storm's six list initializers contain `p->prev = 0; p->next = 0; p->prev = p;`.
 * VC8 drops the first store, although the original executes it. Qualifying only
 * that destination access as volatile retains the instruction without adding,
 * moving, or widening a store. This is not an automatic tree-wide transform:
 * a per-function form still needs native-byte/oracle evidence.
 */
import { NodeKind } from '../../../ast/kinds.js';
import type { AnyNode, AssignExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl, Identifier, IntegerLiteralExpr, MemberExpr, ParenExpr, UnaryExpr, VariableDecl } from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { createExprShape } from './expr-shape.js';
import { localTypesOf } from './compare-form.js';

interface Field { name: string; offset: number; size: number; type: string; bitSize?: number }
export interface KeepStoreTables {
  structFields?: Record<string, Record<string, string>>;
  structLayouts?: Record<string, ReadonlyArray<Field>>;
  typedefTargets?: Record<string, string>;
}
const unparen = (e: Expression): Expression => {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
};
const key = (n: AnyNode): string => emit(n).replace(/\s+/g, '');
const zero = (e: Expression): boolean => unparen(e).kind === NodeKind.IntegerLiteral && (unparen(e) as IntegerLiteralExpr).value === 0n;
const store = (s: AnyNode): AssignExpr | undefined => {
  if (s.kind !== NodeKind.ExprStmt) return undefined;
  const e = unparen((s as ExprStmt).expression);
  return e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=' ? e as AssignExpr : undefined;
};
const member = (e: Expression): MemberExpr | undefined => {
  const m = unparen(e);
  return m.kind === NodeKind.MemberExpr && (m as MemberExpr).isArrow && (m as MemberExpr).member.kind === NodeKind.Identifier
    && unparen((m as MemberExpr).object).kind === NodeKind.Identifier ? m as MemberExpr : undefined;
};
const INTEGER = /^(?:bool|char|signed char|unsigned char|short|short int|unsigned short|unsigned short int|int|unsigned int|long|unsigned long|int8_t|uint8_t|int16_t|uint16_t|int32_t|uint32_t|intptr_t|uintptr_t|size_t|DWORD|BOOL)$/;

/** Mutates only on success. A refusal leaves the body untouched. */
export function keepZeroStore(fn: FunctionDecl, expr: string, index: number, tables?: KeepStoreTables): string | undefined {
  const hits: Array<{ block: CompoundStmt; at: number; assignment: AssignExpr; lhs: MemberExpr }> = [];
  if (!fn.body) return 'no body';
  for (const b of findNodesByKind(fn.body, NodeKind.CompoundStmt) as CompoundStmt[]) {
    for (let at = 0; at < b.statements.length; ++at) {
      const a = store(b.statements[at]);
      const lhs = a && member(a.left);
      if (a && lhs && key(lhs) === expr.replace(/\s+/g, '') && zero(a.right)) hits.push({ block: b, at, assignment: a, lhs });
    }
  }
  const h = hits[index - 1];
  if (!h) return 'no matching plain member zero store';
  const p = unparen(h.lhs.object) as Identifier;
  const types = localTypesOf(fn);
  const declared = types.get(p.name);
  const count = fn.parameters.filter(v => v.name?.name === p.name).length
    + (findNodesByKind(fn.body, NodeKind.VariableDecl) as VariableDecl[]).filter(v => v.name.name === p.name).length;
  if (!declared || count !== 1 || /\b(?:const|volatile)\b|&/.test(emit(declared as AnyNode))) return 'pointer must have one unqualified local or parameter declaration';
  const shapeOf = createExprShape(types, { structFields: tables?.structFields ?? {}, resolve: n => tables?.typedefTargets?.[n] });
  const shape = shapeOf(p);
  if (!shape || shape.stars !== 1) return 'not a pointer to one known aggregate';
  const fields = tables?.structFields?.[shape.base], layout = tables?.structLayouts?.[shape.base];
  if (!fields || !layout) return 'no owning field layout';
  const field = (m: MemberExpr): Field | undefined => {
    const matches = layout.filter(f => f.name === m.member.name);
    const f = matches.length === 1 ? matches[0] : undefined;
    const t = shapeOf(m);
    return f && Number.isSafeInteger(f.offset) && f.offset >= 0 && Number.isSafeInteger(f.size) && f.size > 0 && !(f.bitSize && f.bitSize > 0)
      && fields[f.name] && f.type.replace(/\s+/g, '') === fields[f.name].replace(/\s+/g, '')
      && !/\b(?:const|volatile)\b|[\[\]()&]/.test(f.type)
      && t && (t.stars > 0 || (t.stars === 0 && INTEGER.test(t.base))) ? f : undefined;
  };
  const target = field(h.lhs);
  if (!target) return 'not a known non-bitfield scalar member';
  // The emitted body may still write `list->head.next` beside `p->prev`, where
  // the immediately preceding declaration proved `p = &list->head`. This one
  // alias has no intervening write or hidden pointer load; an arbitrary q does.
  let alias: string | undefined;
  const previous = h.block.statements[h.at - 1];
  if (previous?.kind === NodeKind.DeclStmt) {
    const declarations = (previous as DeclStmt).declarations;
    const d = declarations.length === 1 && declarations[0].kind === NodeKind.VariableDecl ? declarations[0] as VariableDecl : undefined;
    const init = d?.initializer ? unparen(d.initializer as Expression) : undefined;
    const object = init?.kind === NodeKind.UnaryExpr && (init as UnaryExpr).operator === '&' ? member((init as UnaryExpr).operand) : undefined;
    const root = object && unparen(object.object) as Identifier | undefined;
    const owner = root && shapeOf(root);
    const objectShape = object && shapeOf(object);
    const ownerField = object && owner?.stars === 1 ? tables?.structLayouts?.[owner.base]?.filter(f => f.name === object.member.name) : undefined;
    if (d?.name.name === p.name && object && root && types.has(root.name)
        && !/\b(?:const|volatile)\b|&/.test(emit(types.get(root.name)! as AnyNode))
        && objectShape?.stars === 0 && objectShape.base === shape.base
        && ownerField?.length === 1 && !ownerField[0].bitSize
        && !/\b(?:const|volatile)\b/.test(ownerField[0].type)) alias = key(object);
  }
  let overwritten = false;
  for (let at = h.at + 1; at < h.block.statements.length; ++at) {
    const a = store(h.block.statements[at]);
    const left = a && unparen(a.left);
    const lhs = left?.kind === NodeKind.MemberExpr && (left as MemberExpr).member.kind === NodeKind.Identifier ? left as MemberExpr : undefined;
    // Only same-object scalar stores, with no reads through memory, may intervene.
    // Calls, pointer updates, branches, labels and exits all end the proof.
    const sameObject = lhs && ((lhs.isArrow && key(lhs.object) === p.name) || (!lhs.isArrow && alias !== undefined && key(unparen(lhs.object)) === alias));
    if (!a || !lhs || !sameObject) return 'no uninterrupted same-object store run';
    const f = field(lhs);
    const rhs = unparen(a.right);
    if (!f || !(zero(rhs) || (rhs.kind === NodeKind.Identifier && (rhs as Identifier).name === p.name))) return 'store run reads or computes another value';
    if (lhs.member.name === h.lhs.member.name) { overwritten = true; break; }
    if (f.offset < target.offset + target.size && target.offset < f.offset + f.size) return 'intervening field overlaps the destination';
  }
  if (!overwritten) return 'zero is not overwritten in the store run';
  const parsed = parse(`void f() { ((volatile ${shape.base}*)${p.name})->${h.lhs.member.name} = 0; }`).declarations[0] as FunctionDecl;
  const replacement = store(parsed.body!.statements[0]);
  if (!replacement) return 'cannot spell destination access';
  h.assignment.left = replacement.left;
  return undefined;
}
