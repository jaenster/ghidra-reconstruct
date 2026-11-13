/**
 * Param Slot Local Plugin
 *
 * VC8 packs a local into the stack slot of a parameter it has already loaded into a
 * register. Ghidra cannot split a stack parameter, so it prints the parameter's register
 * copy as a second variable and the packed local under the parameter's own name. In
 * Skills_SrvDoFunc_037_ChargeRelease_MultiElementScatter (005d4e70) eSkill is loaded into
 * EDI at entry and its slot then receives the Y coordinate:
 *
 *   21  mov edi, dword ptr [ebp + 8]       ; eSkill, kept in EDI
 *   6c  lea edx, [ebp + 8]                 ; &nTargetY, an out argument in eSkill's slot
 *
 * and Ghidra prints
 *
 *   eSkillSaved = eSkill;
 *   ...SKILLASS_GetChargeUpMissile(pUnit, eSkill);
 *   bHasPos = SKILLS_GetTargetOrCursorPos(pGame, pUnit, &nTargetX, &eSkill);
 *   ...D2GetSkillCalc(pUnit, ..., eSkillSaved, nSkillLvl);
 *   SKILLASS_SpawnMissileRing(..., nTargetX, eSkill, eSkillSaved, ...);
 *
 * Compiled as printed, `&eSkill` makes the parameter address-taken, eSkillSaved needs a home
 * of its own and the frame grows. INVENTORY_CheckBeltSlotAndGetItem (0063c830) is the byte
 * form: a char out argument in the high byte of pInventory's slot,
 * `(char*)((int)&pInventory + 3)` and `pInventory._3_1_`.
 *
 * The source had a parameter and a separate local. This pass gives them back:
 *
 *   ...SKILLASS_GetChargeUpMissile(pUnit, eSkill);
 *   bHasPos = SKILLS_GetTargetOrCursorPos(pGame, pUnit, &nTargetX, &eSkillSlot);
 *   ...D2GetSkillCalc(pUnit, ..., eSkill, nSkillLvl);
 *   SKILLASS_SpawnMissileRing(..., nTargetX, eSkillSlot, eSkill, ...);
 *
 * Only when all of this holds:
 *  - P is a stack parameter (not one the convention passes in ECX/EDX);
 *  - a top-level statement `S = P;` or `T S = P;` copies it, S a local of P's declared type,
 *    declared once, written only there, its address never taken, and neither P nor S is
 *    named before that statement;
 *  - the first later statement that names P other than as a plain read is a top-level
 *    statement passing P's address (whole, or one byte of it) as a call argument, and names
 *    P nowhere else; between the copy and it P is only read;
 *  - every later mention of P is of that same form (whole P, or that byte of it);
 *  - S is read after that statement: the entry value and the packed local are live at
 *    once, two variables, as the original's register and slot show.
 * Then the reads of S read the entry value P still holds (nothing writes P any more), and
 * every mention of P from the address argument on names the local. The one assumption is
 * the original source's: the call writes the local it is given the address of.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CStyleCastExpr, CallExpr, CompoundStmt, DeclStmt, ExprStmt, Expression,
  FunctionDecl, Identifier, IntegerLiteralExpr, MemberExpr, ParenExpr, PointerType, PostfixExpr, Statement,
  TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { Decl, Expr, Stmt } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import { cloneNode, createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface ParamSlotLocalOptions extends PluginOptions {}

function unwrap(e: ASTNode): ASTNode {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as ParenExpr).expression;
  return x;
}

function isId(e: ASTNode | null | undefined, name: string): boolean {
  return !!e && unwrap(e).kind === NodeKind.Identifier && (unwrap(e) as Identifier).name === name;
}

function intValue(e: ASTNode): number | null {
  const x = unwrap(e);
  return x.kind === NodeKind.IntegerLiteral ? Number((x as IntegerLiteralExpr).value) : null;
}

const typeText = (t: TypeNode) => emit(t as never).replace(/\s+/g, '');

/** `(char*)((int)&P + k)`: the address of byte k of P; returns k and the pointer type. */
function byteAddress(e: ASTNode, p: string): { k: number; type: PointerType } | null {
  const c = unwrap(e);
  if (c.kind !== NodeKind.CStyleCastExpr) return null;
  const cast = c as CStyleCastExpr;
  if (cast.type.kind !== NodeKind.PointerType) return null;
  const sum = unwrap(cast.expression);
  if (sum.kind !== NodeKind.BinaryExpr || (sum as BinaryExpr).operator !== '+') return null;
  const k = intValue((sum as BinaryExpr).right);
  if (k === null || k < 1 || k > 3) return null;
  let base = unwrap((sum as BinaryExpr).left);
  if (base.kind === NodeKind.CStyleCastExpr) base = unwrap((base as CStyleCastExpr).expression);
  if (base.kind !== NodeKind.UnaryExpr || (base as UnaryExpr).operator !== '&' || !isId((base as UnaryExpr).operand, p)) return null;
  const pointee = (cast.type as PointerType).pointee;
  if (!/^(unsignedchar|char|signedchar|uint8_t|int8_t|byte|BYTE|undefined1)$/.test(typeText(pointee))) return null;
  return { k, type: cast.type as PointerType };
}

/** `*(T*)((char*)&P + k)` or `P._k_1_`: byte k of P read or written as a value. */
function byteValue(e: ASTNode, p: string): { k: number; type: TypeNode | null } | null {
  const x = unwrap(e);
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') {
    const a = byteAddress((x as UnaryExpr).operand, p);
    return a ? { k: a.k, type: a.type.pointee } : null;
  }
  if (x.kind === NodeKind.MemberExpr) {
    const m = x as MemberExpr;
    const mn = (m.member as Identifier).name;
    const g = typeof mn === 'string' ? /^_(\d)_1_$/.exec(mn) : null;
    if (!m.isArrow && g && isId(m.object, p)) return { k: Number(g[1]), type: null };
  }
  return null;
}

type Form = { kind: 'whole' } | { kind: 'byte'; k: number };

interface Mention { node: ASTNode; form: Form; address: boolean; read: boolean }

/**
 * Every mention of `p` in `root`, outermost form first: a byte address, a byte value, `&P`,
 * or a bare P (read when it is not the target of an assignment or ++/--).
 */
function mentions(root: ASTNode, p: string): Mention[] | null {
  const out: Mention[] = [];
  let bad = false;
  const visit = (n: ASTNode, parent: ASTNode | null) => {
    if (bad) return;
    const ba = byteAddress(n, p);
    if (ba) { out.push({ node: n, form: { kind: 'byte', k: ba.k }, address: true, read: false }); return; }
    const bv = byteValue(n, p);
    if (bv) { out.push({ node: n, form: { kind: 'byte', k: bv.k }, address: false, read: !writes(parent, n) }); return; }
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&' && isId((n as UnaryExpr).operand, p)) {
      out.push({ node: n, form: { kind: 'whole' }, address: true, read: false });
      return;
    }
    if (n.kind === NodeKind.Identifier && (n as Identifier).name === p) {
      out.push({ node: n, form: { kind: 'whole' }, address: false, read: !writes(parent, n) });
      return;
    }
    if (n.kind === NodeKind.MemberExpr && isId((n as MemberExpr).object, p)) {
      // `P->f` reads P; `P.f` touches part of it, which no form here accounts for.
      if (!(n as MemberExpr).isArrow) { bad = true; return; }
      out.push({ node: unwrap((n as MemberExpr).object), form: { kind: 'whole' }, address: false, read: true });
      return;
    }
    for (const c of kids(n)) visit(c, n);
  };
  visit(root, null);
  return bad ? null : out;
}

/** Is `n` written by its parent: the left of an assignment, or the operand of ++/--? */
function writes(parent: ASTNode | null, n: ASTNode): boolean {
  if (!parent) return false;
  if (parent.kind === NodeKind.AssignExpr) return (parent as AssignExpr).left === n;
  if (parent.kind === NodeKind.UnaryExpr || parent.kind === NodeKind.PostfixExpr) {
    const op = (parent as UnaryExpr | PostfixExpr).operator;
    return (op === '++' || op === '--') && (parent as UnaryExpr).operand === n;
  }
  return false;
}

function kids(n: ASTNode): ASTNode[] {
  const out: ASTNode[] = [];
  for (const key of Object.keys(n)) {
    if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia') continue;
    const v = (n as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c === 'object' && 'kind' in c) out.push(c as ASTNode); }
    else if (v && typeof v === 'object' && 'kind' in (v as object)) out.push(v as ASTNode);
  }
  return out;
}

/** `S = P;` or `T S = P;` at the top level: the copy's target name, or null. */
function copyTarget(s: Statement, p: string): string | null {
  if (s.kind === NodeKind.ExprStmt) {
    const e = unwrap((s as ExprStmt).expression);
    if (e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=' && isId((e as AssignExpr).right, p)) {
      const l = unwrap((e as AssignExpr).left);
      return l.kind === NodeKind.Identifier ? (l as Identifier).name : null;
    }
  }
  if (s.kind === NodeKind.DeclStmt) {
    const ds = (s as DeclStmt).declarations;
    if (ds.length === 1 && ds[0].kind === NodeKind.VariableDecl) {
      const v = ds[0] as VariableDecl;
      if (v.initializer && isId(v.initializer, p)) return v.name.name;
    }
  }
  return null;
}

/** The single non-static declaration of local `name`, or null. */
function soleDecl(body: CompoundStmt, name: string): VariableDecl | null {
  let found: VariableDecl | null = null;
  let n = 0;
  for (const x of traverseAST(body)) {
    if (x.kind === NodeKind.VariableDecl && (x as VariableDecl).name.name === name) { found = x as VariableDecl; n++; }
  }
  if (n !== 1 || !found || found.specifiers.some(s => s === 'static' || s === 'extern')) return null;
  return found;
}

function named(root: ASTNode, name: string): boolean {
  for (const x of traverseAST(root)) if (x.kind === NodeKind.Identifier && (x as Identifier).name === name) return true;
  return false;
}

/** Writes and address-takes of `s` in `root` (anything but a plain read). */
function nonReads(root: ASTNode, s: string): number {
  const m = mentions(root, s);
  if (!m) return Infinity;
  return m.filter(x => x.address || !x.read || x.form.kind !== 'whole').length;
}

/** Parameters that arrive on the stack, by the convention's register assignment. */
function stackParams(fn: FunctionDecl): string[] {
  const names = fn.parameters.map(p => p.name?.name ?? '');
  const skip = fn.callingConvention === '__fastcall' ? 2 : 0;
  return names.slice(skip).filter(n => n !== '');
}

function rewriteFunction(fn: FunctionDecl): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  let cur = fn;
  let changed = false;
  for (const p of stackParams(fn)) {
    const next = rewriteParam(cur, p);
    if (next) { cur = next; changed = true; }
  }
  return changed ? cur : undefined;
}

function rewriteParam(fn: FunctionDecl, p: string): FunctionDecl | undefined {
  const body = fn.body!;
  const stmts = body.statements;
  const param = fn.parameters.find(x => x.name?.name === p)!;

  const i = stmts.findIndex(s => copyTarget(s, p) !== null);
  if (i < 0) return undefined;
  const s = copyTarget(stmts[i], p)!;
  if (s === p || fn.parameters.some(x => x.name?.name === s)) return undefined;
  for (let k = 0; k < i; k++) if (named(stmts[k], p) || named(stmts[k], s)) return undefined;

  const sDecl = soleDecl(body, s);
  if (!sDecl || typeText(sDecl.type) !== typeText(param.type)) return undefined;
  // S is written only by the copy (its declaration's initializer or the one assignment).
  const sWrites = stmts.reduce((n, st, k) => n + (k === i ? 0 : nonReads(st, s)), 0);
  if (sWrites !== 0) return undefined;
  if (stmts[i].kind === NodeKind.ExprStmt && sDecl.initializer) return undefined;

  // The address argument: the first later statement naming P other than by a plain read.
  let j = -1;
  for (let k = i + 1; k < stmts.length; k++) {
    const m = mentions(stmts[k], p);
    if (!m) return undefined;
    if (m.some(x => x.address || !x.read || x.form.kind !== 'whole')) { j = k; break; }
  }
  if (j < 0) return undefined;
  const mj = mentions(stmts[j], p)!;
  if (mj.length !== 1 || !mj[0].address) return undefined;
  const site = mj[0];
  if (!isCallArgument(stmts[j], site.node) || !unconditional(stmts[j], site.node)) return undefined;
  const form = site.form;

  // Every later mention is of the same form.
  const later: Mention[] = [];
  for (let k = j + 1; k < stmts.length; k++) {
    const m = mentions(stmts[k], p);
    if (!m) return undefined;
    for (const x of m) {
      if (x.form.kind !== form.kind || (form.kind === 'byte' && (x.form as { k: number }).k !== form.k)) return undefined;
      later.push(x);
    }
  }
  // Two variables: S is read after the address argument.
  if (!stmts.slice(j + 1).some(st => named(st, s))) return undefined;

  const local = freshName(fn, `${p}Slot`);
  let localType: TypeNode;
  if (form.kind === 'whole') localType = cloneNode(param.type);
  else localType = cloneNode(byteAddress(site.node, p)!.type.pointee);

  const replace = new Map<ASTNode, Expression>();
  for (const x of [site, ...later]) {
    if (x.address) {
      const addr = Expr.addressOf(Expr.identifier(local));
      replace.set(x.node, form.kind === 'byte' ? Expr.cast(cloneNode(byteAddress(x.node, p)!.type), addr) : addr);
    } else if (form.kind === 'byte') {
      const bv = byteValue(x.node, p)!;
      const same = !bv.type || typeText(bv.type) === typeText(localType);
      replace.set(x.node, same ? Expr.identifier(local) : Expr.paren(Expr.cast(cloneNode(bv.type!), Expr.identifier(local))));
    } else {
      replace.set(x.node, Expr.identifier(local));
    }
  }

  const rewrite = (n: ASTNode): ASTNode => {
    const r = replace.get(n);
    if (r) return r;
    if (n.kind === NodeKind.Identifier && (n as Identifier).name === s) return Expr.identifier(p);
    let changed = false;
    const copy: Record<string, unknown> = { ...(n as unknown as Record<string, unknown>) };
    for (const key of Object.keys(copy)) {
      if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia') continue;
      const v = copy[key];
      if (Array.isArray(v)) {
        const nv = v.map(c => (c && typeof c === 'object' && 'kind' in c) ? rewrite(c as ASTNode) : c);
        if (nv.some((c, idx) => c !== v[idx])) { copy[key] = nv; changed = true; }
      } else if (v && typeof v === 'object' && 'kind' in (v as object)) {
        const nv = rewrite(v as ASTNode);
        if (nv !== v) { copy[key] = nv; changed = true; }
      }
    }
    return changed ? copy as unknown as ASTNode : n;
  };

  const out: Statement[] = [];
  stmts.forEach((st, k) => {
    if (k === i) {
      out.push(Stmt.declStmt([Decl.variable(local, localType)]));
      return;
    }
    // The S declaration goes; the copy removed it as a statement above.
    if (st.kind === NodeKind.DeclStmt && (st as DeclStmt).declarations.length === 1
      && (st as DeclStmt).declarations[0] === sDecl) return;
    out.push(rewrite(st) as Statement);
  });
  if (out.length === stmts.length && stmts[i].kind === NodeKind.ExprStmt) {
    // S was declared somewhere other than as a top-level statement of its own.
    return undefined;
  }
  return updateNode(fn, { body: updateNode(body, { statements: out } as Partial<CompoundStmt>) } as Partial<FunctionDecl>);
}

/**
 * Does `stmt` evaluate `target` every time it runs: an expression or declaration statement
 * with no `?:`, `&&` or `||` between it and the target?
 */
function unconditional(stmt: Statement, target: ASTNode): boolean {
  if (stmt.kind !== NodeKind.ExprStmt && stmt.kind !== NodeKind.DeclStmt) return false;
  const path = (n: ASTNode): ASTNode[] | null => {
    if (n === target) return [n];
    for (const c of kids(n)) {
      const r = path(c);
      if (r) return [n, ...r];
    }
    return null;
  };
  const chain = path(stmt);
  if (!chain) return false;
  return !chain.some(n => n.kind === NodeKind.ConditionalExpr
    || (n.kind === NodeKind.BinaryExpr && ((n as BinaryExpr).operator === '&&' || (n as BinaryExpr).operator === '||')));
}

/** Is `arg` (possibly cast) one of the arguments of a call inside `root`? */
function isCallArgument(root: ASTNode, arg: ASTNode): boolean {
  for (const x of traverseAST(root)) {
    if (x.kind !== NodeKind.CallExpr) continue;
    for (const a of (x as CallExpr).arguments) {
      let e: ASTNode = a;
      for (;;) {
        if (e === arg) return true;
        const u = unwrap(e);
        if (u === arg) return true;
        if (u.kind !== NodeKind.CStyleCastExpr) break;
        e = (u as CStyleCastExpr).expression;
      }
    }
  }
  return false;
}

function freshName(fn: FunctionDecl, base: string): string {
  let name = base;
  for (let n = 2; named(fn, name); n++) name = `${base}${n}`;
  return name;
}

function createParamSlotLocalTransformer(_options: ParamSlotLocalOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node);
    },
  });
}

export const paramSlotLocalPlugin: TransformPlugin = {
  id: 'param-slot-local',
  name: 'Param Slot Local',
  description: 'A local VC8 packed into a loaded parameter\'s stack slot gets its own variable back; the parameter\'s register copy becomes the parameter again',
  version: '1.0.0',
  defaultEnabled: true,
  // Late, on the statements the structural passes left: after early-return flattened the
  // guards, so the address argument is a top-level statement; before frame-group-locals.
  priority: 940,
  tags: ['matching'],
  createTransformer: createParamSlotLocalTransformer,
};

export { createParamSlotLocalTransformer };
