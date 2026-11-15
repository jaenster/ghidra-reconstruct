/**
 * Link Select Tail Plugin
 *
 * Storm's `TSList<T>::Next(T* p)` picks a link and reads its next word once:
 *
 *     TSLink<T>* pLink = p ? (TSLink<T>*)((char*)p + m_linkoffset) : &m_terminator;
 *     intptr_t n = pLink->m_next;
 *     return (T*)(n <= 0 ? 0 : n);
 *
 * VC8 tail-duplicates the read and the select into both ways of the test, so the original
 * has two return copies that end in the same select (`xor; test; setle; sub; and`) and differ
 * only in how the link's address is formed (`mov; add` against `lea`). The decompiler prints
 * the copies as two returns (TSExplicitList<SGAMEDATA>::Next 0052e530):
 *
 *     if (p) return (T*)(*(uint32_t*)(A) <= 0 ? 0 : *(uint32_t*)(A));
 *     intptr_t n = this->m_terminator.m_next;
 *     return (T*)(n <= 0 ? 0 : n);
 *
 * with A the address of the link's next word, and compiled as printed VC8 keeps one select
 * per return. Where the original's return facts show the two copies ending in the same
 * instructions ahead of their epilogues (at least three of them: the select itself), the two
 * ways are written as the one link pick above, the address of the link being A less the four
 * bytes of the link's prev word. The same holds for the join the passes may already have made,
 * `if (p) n = *(..)(A); else n = this->m_terminator.m_next; return (T*)(n <= 0 ? 0 : n);`.
 *
 * Value-preserving: with p set, the link is at A - 4 and its m_next (offset 4) is the word at
 * A, the value both forms select on; without p it is the terminator's m_next, as printed.
 * A reads `m_linkoffset` of the list whose terminator the other way reads.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, CompoundStmt, ConditionalExpr, CStyleCastExpr, DeclStmt, Expression, ExprStmt, AssignExpr,
  FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, MemberExpr, ParenExpr, PointerType, ReturnStmt, Statement,
  UnaryExpr, VariableDecl, TypeNode,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { Decl, Expr, Stmt, Type } from '../../../ast/factory.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { sameExpr } from './rotated-for-loop.js';
import { LayoutReader, type BranchLayoutEvidence } from './branch-layout/evidence.js';

export interface LinkSelectTailOptions extends PluginOptions {
  /** The original's addresses and return copies, keyed by line of the parsed text. */
  branchLayout?: BranchLayoutEvidence | null;
  onSite?: (e: { line: number; form: 'returns' | 'join' }) => void;
}

const unparen = (e: Expression): Expression => {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
};

const uncast = (e: Expression): Expression => {
  for (;;) {
    e = unparen(e);
    if (e.kind !== NodeKind.CStyleCastExpr) return e;
    e = (e as CStyleCastExpr).expression;
  }
};

function memberName(e: Expression): string | null {
  const u = unparen(e);
  if (u.kind !== NodeKind.MemberExpr) return null;
  const m = (u as MemberExpr).member;
  return m.kind === NodeKind.Identifier ? (m as Identifier).name : null;
}

/** `L.m_terminator.m_next` (either arrow): L, else null. */
function terminatorRead(e: Expression): Expression | null {
  const u = uncast(e);
  if (memberName(u) !== 'm_next') return null;
  const t = unparen((u as MemberExpr).object);
  if (memberName(t) !== 'm_terminator' || (u as MemberExpr).isArrow) return null;
  return t;
}

/** The list a terminator member expression belongs to, spelled as an `L.` / `L->` base. */
function listOf(term: Expression): { object: Expression; isArrow: boolean } {
  const m = unparen(term) as MemberExpr;
  return { object: m.object, isArrow: m.isArrow };
}

/** `*(T*)(A)`, T a 4-byte integer type: A, else null. */
function wordLoad(e: Expression): Expression | null {
  const u = unparen(e);
  if (u.kind !== NodeKind.UnaryExpr || (u as UnaryExpr).operator !== '*') return null;
  const c = unparen((u as UnaryExpr).operand);
  if (c.kind !== NodeKind.CStyleCastExpr) return null;
  const t = (c as CStyleCastExpr).type;
  if (t.kind !== NodeKind.PointerType) return null;
  const p = (t as PointerType).pointee;
  const raw = p.kind === NodeKind.BuiltinType || p.kind === NodeKind.TypedefType ? (p as unknown as { name: unknown }).name : '';
  const name = typeof raw === 'string' ? raw : (raw as Identifier | null)?.name ?? '';
  if (!['uint32_t', 'int32_t', 'intptr_t', 'uintptr_t', 'int', 'uint', 'DWORD', 'unsigned int'].includes(name)) return null;
  return (c as CStyleCastExpr).expression;
}

/** A reads `m_linkoffset` of the list L (same base as the terminator read). */
function readsLinkOffset(a: Expression, list: { object: Expression; isArrow: boolean }): boolean {
  for (const n of traverseAST(a)) {
    if (n.kind !== NodeKind.MemberExpr) continue;
    const m = n as MemberExpr;
    if (m.member.kind !== NodeKind.Identifier || (m.member as Identifier).name !== 'm_linkoffset') continue;
    if (m.isArrow === list.isArrow && sameExpr(m.object, list.object)) return true;
  }
  return false;
}

/** `(int)x <= 0 ? 0 : x` (x through casts): x, else null. */
function select(e: Expression): Expression | null {
  const u = uncast(e);
  if (u.kind !== NodeKind.ConditionalExpr) return null;
  const c = u as ConditionalExpr;
  const cond = unparen(c.condition);
  if (cond.kind !== NodeKind.BinaryExpr || (cond as BinaryExpr).operator !== '<=') return null;
  const b = cond as BinaryExpr;
  const zero = (x: Expression) => { const v = uncast(x); return v.kind === NodeKind.IntegerLiteral && BigInt((v as IntegerLiteralExpr).value) === 0n; };
  if (!zero(b.right) || !zero(c.thenExpr)) return null;
  const x = uncast(c.elseExpr);
  if (!sameExpr(uncast(b.left), x)) return null;
  return x;
}

const isEpilogue = (m: string) => /^(POP|RET|LEAVE|MOV\/ESP)/.test(m);

/** Both return copies end in the same instructions ahead of the epilogue, at least three. */
function sharedSelectTail(reader: LayoutReader): boolean {
  const copies = reader.copies();
  if (copies.length !== 2) return false;
  const [a, b] = copies.map(c => c.insns.filter(m => !isEpilogue(m)));
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n >= 3 && n < a.length && n < b.length;
}

function bodyOf(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? [...(s as CompoundStmt).statements] : [s];
}

/** `v = e;` or `T v = e;`: the pair, else null. */
function assignment(s: Statement): { name: string; value: Expression; decl: VariableDecl | null } | null {
  if (s.kind === NodeKind.ExprStmt) {
    const e = unparen((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    const l = unparen((e as AssignExpr).left);
    return l.kind === NodeKind.Identifier ? { name: (l as Identifier).name, value: (e as AssignExpr).right, decl: null } : null;
  }
  if (s.kind === NodeKind.DeclStmt) {
    const ds = (s as DeclStmt).declarations;
    if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return null;
    const d = ds[0] as VariableDecl;
    if (!d.initializer || d.initializer.kind === NodeKind.InitListExpr) return null;
    return { name: d.name.name, value: d.initializer as Expression, decl: d };
  }
  return null;
}

/** `T v;` without initialiser: v, else null. */
function bareDecl(s: Statement): string | null {
  if (s.kind !== NodeKind.DeclStmt) return null;
  const ds = (s as DeclStmt).declarations;
  if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return null;
  const d = ds[0] as VariableDecl;
  return d.initializer ? null : d.name.name;
}

/**
 * The value a run of statements ending in `return sel(x)` selects on, x a load through
 * the list (`p` way) or the terminator's next (other way): the selected expression with
 * locals substituted, the local holding it (if any) and the return's cast type.
 */
function selectedValue(stmts: Statement[]): { value: Expression; local: string | null; ret: ReturnStmt } | null {
  if (stmts.length === 0 || stmts[stmts.length - 1].kind !== NodeKind.ReturnStmt) return null;
  const ret = stmts[stmts.length - 1] as ReturnStmt;
  if (!ret.value) return null;
  const x = select(ret.value);
  if (!x) return null;
  const pre = stmts.slice(0, -1);
  if (x.kind === NodeKind.Identifier) {
    const v = (x as Identifier).name;
    const rest = pre.filter(s => bareDecl(s) !== v);
    if (rest.length !== 1) return null;
    const a = assignment(rest[0]);
    if (!a || a.name !== v) return null;
    return { value: a.value, local: v, ret };
  }
  if (pre.some(s => bareDecl(s) === null)) return null;
  return { value: x, local: null, ret };
}

function linkType(fn: FunctionDecl): TypeNode | null {
  const r = fn.returnType;
  if (!r || r.kind !== NodeKind.PointerType) return null;
  return Type.template(Expr.identifier('TSLink'), [cloneNode((r as PointerType).pointee) as TypeNode]);
}

function rewrite(fn: FunctionDecl, reader: LayoutReader, opts: LinkSelectTailOptions): Statement[] | null {
  const stmts = fn.body!.statements;
  // Leading bare declarations may stay; the last two shapes are the site.
  let i = 0;
  while (i < stmts.length && bareDecl(stmts[i]) !== null) i++;
  const lead = stmts.slice(0, i);
  const tail = stmts.slice(i);
  if (tail.length === 0 || tail[0].kind !== NodeKind.IfStmt) return null;
  const ifs = tail[0] as IfStmt;
  if (ifs.init) return null;
  const p = unparen(ifs.condition);
  if (p.kind !== NodeKind.Identifier) return null;
  let viaP: Expression | null = null, viaT: Expression | null = null, name: string | null = null;
  let ret: ReturnStmt | null = null;
  let form: 'returns' | 'join';
  if (!ifs.elseBranch) {
    const a = selectedValue(bodyOf(ifs.thenBranch));
    const b = selectedValue(tail.slice(1));
    if (!a || !b) return null;
    viaP = a.value; viaT = b.value; name = b.local ?? a.local; ret = b.ret;
    form = 'returns';
  } else {
    if (tail.length !== 2) return null;
    const ta = bodyOf(ifs.thenBranch), ea = bodyOf(ifs.elseBranch);
    if (ta.length !== 1 || ea.length !== 1) return null;
    const a = assignment(ta[0]), b = assignment(ea[0]);
    if (!a || !b || a.decl || b.decl || a.name !== b.name) return null;
    const r = tail[1];
    if (r.kind !== NodeKind.ReturnStmt || !(r as ReturnStmt).value) return null;
    const x = select((r as ReturnStmt).value!);
    if (!x || x.kind !== NodeKind.Identifier || (x as Identifier).name !== a.name) return null;
    viaP = a.value; viaT = b.value; name = a.name; ret = r as ReturnStmt;
    form = 'join';
  }
  const term = terminatorRead(viaT!);
  const addr = term ? wordLoad(viaP!) : null;
  if (!term || !addr) return null;
  const list = listOf(term);
  if (!readsLinkOffset(addr, list)) return null;
  // The tested pointer is what the link address is formed from.
  if (![...traverseAST(addr)].some(n => n.kind === NodeKind.Identifier && (n as Identifier).name === (p as Identifier).name)) return null;
  if (!sharedSelectTail(reader)) return null;
  const lt = linkType(fn);
  if (!lt) return null;
  const used = new Set<string>();
  for (const n of traverseAST(fn.body!)) if (n.kind === NodeKind.Identifier) used.add((n as Identifier).name);
  let linkName = 'pLink';
  for (let k = 2; used.has(linkName); k++) linkName = `pLink${k}`;
  const valueName = name ?? 'nNext';
  if (!name && used.has(valueName)) return null;
  // (TSLink<T>*)((char*)(A) - 4) : &L.m_terminator
  const linkOf = Expr.cast(Type.pointer(cloneNode(lt) as TypeNode),
    Expr.paren(Expr.sub(Expr.cast(Type.pointer(Type.char()), Expr.paren(cloneNode(addr) as Expression)), Expr.intLiteral(4))));
  const pick = Expr.conditional(cloneNode(p) as Expression, linkOf, Expr.addressOf(cloneNode(unparen(term)) as Expression));
  const linkDecl = Stmt.declStmt([Decl.variable(linkName, Type.pointer(lt), pick)]);
  const read = Expr.member(Expr.identifier(linkName), 'm_next', true);
  // The value is the link's signed word: a leading declaration of the local (of whatever
  // type a pass gave it) goes, and the local is declared intptr_t where it is read.
  const valueStmt = Stmt.declStmt([Decl.variable(valueName, Type.typedef('intptr_t'), read)]);
  const keptLead = lead.filter(s => bareDecl(s) !== valueName);
  // return CAST(v <= 0 ? 0 : v), the cast of the printed return.
  const v = () => Expr.identifier(valueName);
  const sel = Expr.paren(Expr.conditional(Expr.binary(v(), '<=', Expr.intLiteral(0)), Expr.intLiteral(0), v()));
  const rv = unparen(ret!.value!);
  const value = rv.kind === NodeKind.CStyleCastExpr ? Expr.cast(cloneNode((rv as CStyleCastExpr).type) as TypeNode, sel) : sel;
  const out: Statement[] = [...keptLead, { ...linkDecl, location: ifs.location } as Statement, valueStmt,
    updateNode(ret!, { value } as Partial<ReturnStmt>)];
  opts.onSite?.({ line: ifs.location?.start.line ?? 0, form });
  return out;
}

function createLinkSelectTailTransformer(options: LinkSelectTailOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body || !options.branchLayout) return undefined;
      const reader = new LayoutReader(options.branchLayout, fn.body);
      const out = rewrite(fn, reader, options);
      if (!out) return undefined;
      return updateNode(fn, { body: updateNode(fn.body, { statements: out } as Partial<CompoundStmt>) } as Partial<FunctionDecl>);
    },
  });
}

export const linkSelectTailPlugin: TransformPlugin = {
  id: 'link-select-tail',
  name: 'Link Select Tail',
  description: 'A TSList::Next whose two returns VC8 tail-duplicated from one link pick is written as that pick',
  version: '1.0.0',
  defaultEnabled: true,
  // With the late matching shapes, after shared-tail-join (989.981) and before bool-select-form (989.99).
  priority: 989.985,
  tags: ['matching'],
  createTransformer: (options: LinkSelectTailOptions = {}) => createLinkSelectTailTransformer(options),
};
