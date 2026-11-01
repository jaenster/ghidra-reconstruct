/**
 * What a null-guarded field read returns for a null pointer, read off the original's own
 * bodies.
 *
 * The source reads many fields through a getter that tests the pointer first: D2Client keeps
 * three of them out of line (GetGUID 00451f50 `p ? p->nUnitGUID : -1`, GetClassId 00451f60
 * `p ? p->nClassId : -1`, GetAnimMode 00451f70 `p ? p->eAnimMode : Death`), and inlined copies
 * survive in the decompile wherever the value is used rather than compared:
 *
 *   eUnitType = UNIT_COUNT;                       if (pUnit == NULL) { nGUID = -1; eType = UNIT_COUNT; }
 *   if (pUnit != NULL) eUnitType = pUnit->eUnitType;   else { nGUID = pUnit->nUnitGUID; eType = pUnit->eUnitType; }
 *
 * Compared with a constant K, `(p ? p->f : D) == K` is `p && p->f == K` whenever D != K, and
 * that is what the decompiler prints; VC8 compiles the two differently (a register load and
 * CMP for the getter, a CMP against memory for the `&&`). `compare-form` writes the getter
 * back where the instructions show the load, and takes D from here: a field gets a default
 * only when every body that reads it this way agrees on one value.
 *
 * Evidence, per function, with p a parameter or local of pointer type and C a constant (an
 * integer literal, a negated one, or an enumerator the caller can value):
 *   - a one-parameter function `if (p == 0) return C; return p->f;` (or `p != 0` first, or
 *     `return p ? p->f : C;`);
 *   - `v = C; if (p != 0) { v = p->f; }`, the two statements adjacent;
 *   - `if (p == 0) { ...; v = C; ... } else { ...; v = p->f; ... }` (either test), each arm only
 *     assignments, v the same lvalue in both.
 * The key is the pointee's type and the member path below the arrow (`D2UnitStrc|eUnitType`,
 * `D2UnitStrc|eAnimMode.ePlayerMode`).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  AssignExpr, BinaryExpr, CompoundStmt, ConditionalExpr, CStyleCastExpr, Expression, ExprStmt, FunctionDecl,
  Identifier, IfStmt, IntegerLiteralExpr, MemberExpr, ParameterDecl, PointerType, QualifiedType, ReturnStmt,
  Statement, TypeNode, UnaryExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { localTypesOf } from './compare-form.js';
import { sameExpr } from './rotated-for-loop.js';

/** A field's null default: its value, and the enumerator it was spelled with, if any. */
export interface NullGetterDefault {
  value: number;
  name?: string;
}

/** Key -> default, for the fields whose evidence agrees. */
export type NullGetterTable = Record<string, NullGetterDefault>;

/** One body's reading of a field through a null test. */
export interface NullGetterEvidence {
  key: string;
  value: number;
  name?: string;
  /** `getter` for an out-of-line function, `inline` for a copy inside a body. */
  form: 'getter' | 'inline';
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as unknown as { expression: Expression }).expression;
  return e;
}

function unwrapCasts(e: Expression): Expression {
  let x = unwrap(e);
  while (x.kind === NodeKind.CStyleCastExpr) x = unwrap((x as CStyleCastExpr).expression);
  return x;
}

/** The value of a null constant: `0`, `(T *)0x0`, `NULL`, `nullptr`. */
function isNullConstant(e: Expression): boolean {
  const x = unwrapCasts(e);
  if (x.kind === NodeKind.NullptrLiteral) return true;
  if (x.kind === NodeKind.IntegerLiteral) return (x as IntegerLiteralExpr).value === 0n;
  return x.kind === NodeKind.Identifier && (x as Identifier).name === 'NULL';
}

/** `p == 0` / `!p` (null true) or `p != 0` / `p` (null false), p a plain name. */
export function nullTest(cond: Expression): { p: Identifier; nullWhenTrue: boolean } | null {
  const c = unwrap(cond);
  if (c.kind === NodeKind.Identifier) return { p: c as Identifier, nullWhenTrue: false };
  if (c.kind === NodeKind.UnaryExpr && (c as UnaryExpr).operator === '!') {
    const o = unwrap((c as UnaryExpr).operand);
    return o.kind === NodeKind.Identifier ? { p: o as Identifier, nullWhenTrue: true } : null;
  }
  if (c.kind !== NodeKind.BinaryExpr) return null;
  const b = c as BinaryExpr;
  if (b.operator !== '==' && b.operator !== '!=') return null;
  const l = unwrap(b.left);
  if (l.kind !== NodeKind.Identifier || !isNullConstant(b.right)) return null;
  return { p: l as Identifier, nullWhenTrue: b.operator === '==' };
}

/** `p->a.b.c` as its root `p` (a plain name) and the path `a.b.c`; null for any other shape. */
export function fieldRead(e: Expression): { p: Identifier; path: string[] } | null {
  const path: string[] = [];
  let x = unwrap(e);
  for (;;) {
    if (x.kind !== NodeKind.MemberExpr) return null;
    const m = x as MemberExpr;
    if (m.member.kind !== NodeKind.Identifier) return null;
    path.unshift((m.member as Identifier).name);
    const o = unwrap(m.object);
    if (m.isArrow) {
      return o.kind === NodeKind.Identifier ? { p: o as Identifier, path } : null;
    }
    x = o;
  }
}

/** The struct a pointer type points to, as spelled; null when it is not a single pointer. */
export function pointeeName(t: TypeNode | undefined): string | null {
  if (!t) return null;
  let x: TypeNode = t;
  while (x.kind === NodeKind.QualifiedType) x = (x as QualifiedType).type;
  if (x.kind !== NodeKind.PointerType) return null;
  let p = (x as PointerType).pointee;
  while (p.kind === NodeKind.QualifiedType) p = (p as QualifiedType).type;
  if (p.kind === NodeKind.PointerType) return null;
  const name = emit(p).replace(/\s+/g, ' ').trim().replace(/^(?:struct|union|class) /, '');
  return /^[A-Za-z_][\w:]*$/.test(name) ? name : null;
}

/** A constant's value and enumerator name; null when it is not one. */
export function constantValue(e: Expression, enumValue: (name: string) => number | undefined): NullGetterDefault | null {
  let x = unwrapCasts(e);
  let neg = false;
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') { neg = true; x = unwrapCasts((x as UnaryExpr).operand); }
  if (x.kind === NodeKind.IntegerLiteral) {
    const v = (x as IntegerLiteralExpr).value;
    if (typeof v !== 'bigint' || v > 0xffffffffn) return null;
    // A cast literal is its 32-bit pattern; -1 and 0xffffffff are the same default.
    const n = Number(BigInt.asIntN(32, neg ? -v : v));
    return { value: n };
  }
  if (!neg && x.kind === NodeKind.Identifier) {
    const name = (x as Identifier).name;
    const v = enumValue(name);
    return v === undefined ? null : { value: v, name };
  }
  return null;
}

function stmts(s: Statement | null): Statement[] {
  if (!s) return [];
  return s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s];
}

function assignOf(s: Statement): AssignExpr | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  return e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=' ? e as AssignExpr : null;
}

function returnOf(s: Statement | undefined): Expression | null {
  return s && s.kind === NodeKind.ReturnStmt ? (s as ReturnStmt).value : null;
}

/** Every null-guarded field read in `fn` that carries a constant default. */
export function nullGetterEvidence(fn: FunctionDecl, enumValue: (name: string) => number | undefined): NullGetterEvidence[] {
  if (!fn.body) return [];
  const types = localTypesOf(fn);
  const out: NullGetterEvidence[] = [];
  const add = (p: Identifier, path: string[], c: Expression, form: NullGetterEvidence['form']) => {
    const s = pointeeName(types.get(p.name));
    const v = constantValue(c, enumValue);
    if (!s || !v) return;
    out.push({ key: `${s}|${path.join('.')}`, value: v.value, ...(v.name ? { name: v.name } : {}), form });
  };

  // An out-of-line getter: one pointer parameter, the body its test and two returns.
  const params = fn.parameters as ParameterDecl[];
  const body = (fn.body as CompoundStmt).statements.filter(s => s.kind !== NodeKind.DeclStmt);
  if (params.length === 1 && params[0].name) {
    const pn = params[0].name.name;
    const read = (e: Expression | null) => {
      const r = e ? fieldRead(e) : null;
      return r && r.p.name === pn ? r : null;
    };
    if (body.length === 2 && body[0].kind === NodeKind.IfStmt && !(body[0] as IfStmt).elseBranch) {
      const ifs = body[0] as IfStmt;
      const t = nullTest(ifs.condition);
      const arm = stmts(ifs.thenBranch);
      const armRet = arm.length === 1 ? returnOf(arm[0]) : null;
      const tail = returnOf(body[1]);
      if (t && t.p.name === pn && armRet && tail) {
        const r = read(t.nullWhenTrue ? tail : armRet);
        if (r) add(r.p, r.path, t.nullWhenTrue ? armRet : tail, 'getter');
      }
    } else if (body.length === 1) {
      const v = returnOf(body[0]);
      const c = v ? unwrap(v) : null;
      if (c && c.kind === NodeKind.ConditionalExpr) {
        const ce = c as ConditionalExpr;
        const t = nullTest(ce.condition);
        const r = t && t.p.name === pn ? read(t.nullWhenTrue ? ce.elseExpr : ce.thenExpr) : null;
        if (t && r) add(r.p, r.path, t.nullWhenTrue ? ce.thenExpr : ce.elseExpr, 'getter');
      }
    }
  }

  // Inlined copies.
  for (const blk of findNodesByKind(fn.body, NodeKind.CompoundStmt)) {
    const list = (blk as CompoundStmt).statements;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.kind !== NodeKind.IfStmt) continue;
      const ifs = s as IfStmt;
      const t = nullTest(ifs.condition);
      if (!t) continue;
      if (!ifs.elseBranch) {
        // `v = C; if (p != 0) { v = p->f; }`
        if (t.nullWhenTrue || i === 0) continue;
        const arm = stmts(ifs.thenBranch);
        const set = arm.length === 1 ? assignOf(arm[0]) : null;
        const pre = assignOf(list[i - 1]);
        if (!set || !pre || !sameExpr(set.left, pre.left)) continue;
        const r = fieldRead(set.right);
        if (r && r.p.name === t.p.name) add(r.p, r.path, pre.right, 'inline');
        continue;
      }
      // `if (p == 0) { v = C; ... } else { v = p->f; ... }`
      const nullArm = stmts(t.nullWhenTrue ? ifs.thenBranch : ifs.elseBranch).map(assignOf);
      const readArm = stmts(t.nullWhenTrue ? ifs.elseBranch : ifs.thenBranch).map(assignOf);
      if (nullArm.some(a => !a) || readArm.some(a => !a)) continue;
      for (const a of readArm as AssignExpr[]) {
        const r = fieldRead(a.right);
        if (!r || r.p.name !== t.p.name) continue;
        const d = (nullArm as AssignExpr[]).filter(n => sameExpr(n.left, a.left));
        if (d.length === 1) add(r.p, r.path, d[0].right, 'inline');
      }
    }
  }
  return out;
}

/**
 * The table from all evidence: a key whose evidence names more than one value gets no entry.
 * The enumerator spelling is taken from an out-of-line getter first.
 */
export function nullGetterTable(evidence: Iterable<NullGetterEvidence>): { table: NullGetterTable; conflicts: string[] } {
  const seen = new Map<string, { values: Set<number>; best?: NullGetterEvidence; count: number }>();
  for (const e of evidence) {
    const s = seen.get(e.key) ?? { values: new Set<number>(), count: 0 };
    s.values.add(e.value);
    s.count++;
    if (e.name && (!s.best || (s.best.form === 'inline' && e.form === 'getter') || !s.best.name)) s.best = e;
    else if (!s.best) s.best = e;
    seen.set(e.key, s);
  }
  const table: NullGetterTable = {};
  const conflicts: string[] = [];
  for (const [key, s] of seen) {
    if (s.values.size !== 1) { conflicts.push(key); continue; }
    const value = [...s.values][0];
    table[key] = { value, ...(s.best?.name ? { name: s.best.name } : {}) };
  }
  return { table, conflicts };
}
