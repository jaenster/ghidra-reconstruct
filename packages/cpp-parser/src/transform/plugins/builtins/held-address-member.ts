/**
 * Held Address Member Plugin
 *
 * A member function inlined on a sub-object addresses every member through its `this`, the
 * sub-object's address, which VC8 keeps in one register. The decompiler hands that address
 * back as a local, `p = &pThis->m_terminator`, but prints some of the members through the
 * outer object again (the Storm TSList destructor, which ends in the terminator link's
 * Unlink; Destructor_Unreferenced 0044fc20, CELLIST::Destructor 00602b20):
 *
 *     TSLink<T>* pTVar1 = &pThis->m_terminator;
 *     ...
 *     pTVar1->m_prevlink->m_next = pThis->m_terminator.m_next;
 *     pTVar1->m_prevlink = 0;
 *     pThis->m_terminator.m_next = 0;
 *
 * Compiled as printed, VC8 addresses those members off the outer object (`[esi + 8]`) and
 * keeps the outer object in a callee-saved register of its own; the original addresses them
 * off the link (`[eax + 4]`). Written through the local, the function compiles as the
 * original: `pTVar1->m_next`.
 *
 * Shape: a local declared `T* p = &E;` (or assigned `p = &E;` once, its only assignment),
 * where E is a member path `r->f1.f2...` or `r.f1.f2...` off a parameter or local r. Every
 * later `E.m` in the function (the same path, then `.m`) becomes `p->m`. p is not assigned
 * again, nor is r anywhere after the definition, and neither has its address taken.
 *
 * Value-preserving: E's address depends on r's value only (the path dereferences nothing but
 * r), r does not change after the definition, so `&E` is p's value at every later point and
 * `E.m` is `p->m`. p's type is the decompiler's type for `&E` (the declaration compiles), so
 * the member named is the same one.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl, Identifier,
  MemberExpr, ParenExpr, Statement, UnaryExpr, VariableDecl, PostfixExpr, CStyleCastExpr, PointerType,
  TypeNode,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { placed, type AccessOrderEvidence } from './access-order-evidence.js';

/** One `=` of a line: a MOV to memory off `reg` + `disp` (`s`), or an LEA into `reg` (`l`). */
export interface StoreBaseFact {
  ord: number;
  kind: 's' | 'l';
  reg: string;
  disp: number;
}

export interface HeldAddressMemberOptions extends PluginOptions {
  /** Parsed-text line -> the registers its `=` tokens store off or LEA into (reconstruct
   *  extract/store-bases.ts). Absent: only the NextLink evidence applies. */
  storeBases?: ReadonlyMap<number, readonly StoreBaseFact[]>;
  /** The store widths per line, for a link held at an integer type (`uint32_t *`). */
  accessOrder?: AccessOrderEvidence;
  onSite?: (e: { function: string; name: string; uses: number }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** E's root variable, when E is `r->f1.f2...` or `r.f1.f2...` with plain identifier members. */
function pathRoot(e: Expression): string | null {
  let cur = unwrap(e);
  if (cur.kind !== NodeKind.MemberExpr) return null;
  while (cur.kind === NodeKind.MemberExpr) {
    const m = cur as MemberExpr;
    if (m.member.kind !== NodeKind.Identifier) return null;
    const obj = unwrap(m.object);
    if (m.isArrow) {
      // The one dereference allowed is the root's own value (`this` included, which nothing
      // writes and whose address cannot be taken).
      if (obj.kind === NodeKind.ThisExpr) return 'this';
      return obj.kind === NodeKind.Identifier ? (obj as Identifier).name : null;
    }
    cur = obj;
  }
  return cur.kind === NodeKind.Identifier ? (cur as Identifier).name : null;
}

/** `T* p = &E;` / `p = &E;`, or the same through a cast `(U *)&E`: p and E. */
function definition(s: Statement): { name: string; path: Expression; decl: boolean; cast: TypeNode | null; type: TypeNode | null } | null {
  let name: string; let init: Expression | null | undefined; let decl = false; let type: TypeNode | null = null;
  if (s.kind === NodeKind.DeclStmt) {
    const d = (s as DeclStmt).declarations;
    if (d.length !== 1 || d[0].kind !== NodeKind.VariableDecl) return null;
    const v = d[0] as VariableDecl;
    if (!v.initializer || v.directInit || v.copyListInit || v.specifiers.length > 0) return null;
    name = v.name.name; init = v.initializer as Expression; decl = true; type = v.type;
  } else if (s.kind === NodeKind.ExprStmt) {
    const e = unwrap((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    const l = unwrap((e as AssignExpr).left);
    if (l.kind !== NodeKind.Identifier) return null;
    name = (l as Identifier).name; init = (e as AssignExpr).right;
  } else return null;
  let u = unwrap(init as Expression);
  let cast: TypeNode | null = null;
  if (u.kind === NodeKind.CStyleCastExpr) { cast = (u as CStyleCastExpr).type; u = unwrap((u as CStyleCastExpr).expression); }
  if (u.kind !== NodeKind.UnaryExpr || (u as UnaryExpr).operator !== '&') return null;
  const path = unwrap((u as UnaryExpr).operand);
  return pathRoot(path) ? { name, path, decl, cast, type } : null;
}

function isName(e: Expression, n: string): boolean {
  const u = unwrap(e);
  return u.kind === NodeKind.Identifier && (u as Identifier).name === n;
}

/** Nodes that write or take the address of variable n. */
function writes(root: ASTNode, n: string): ASTNode[] {
  const out: ASTNode[] = [];
  for (const m of traverseAST(root)) {
    if (m.kind === NodeKind.AssignExpr && isName((m as AssignExpr).left, n)) out.push(m);
    else if (m.kind === NodeKind.UnaryExpr) {
      const u = m as UnaryExpr;
      if (['&', '++', '--'].includes(u.operator) && isName(u.operand, n)) out.push(m);
    } else if (m.kind === NodeKind.PostfixExpr && isName((m as PostfixExpr).operand, n)) out.push(m);
  }
  return out;
}

/** `D2_StormNextLink(p, ...)`. */
function nextLinkOn(m: ASTNode, p: string): boolean {
  if (m.kind !== NodeKind.CallExpr) return false;
  const c = m as CallExpr;
  const callee = unwrap(c.callee);
  return callee.kind === NodeKind.Identifier && (callee as Identifier).name === 'D2_StormNextLink'
    && c.arguments.length > 0 && isName(c.arguments[0] as Expression, p);
}

/** How many locals named n root declares. */
function declCount(root: ASTNode, n: string): number {
  let k = 0;
  for (const m of traverseAST(root)) if (m.kind === NodeKind.VariableDecl && (m as VariableDecl).name.name === n) k++;
  return k;
}

const INTEGER_WIDTH: Record<string, number> = {
  uint8_t: 1, int8_t: 1, char: 1, uint16_t: 2, int16_t: 2, short: 2, uint32_t: 4, int32_t: 4, int: 4, uint: 4,
};

/** The width of `T` in a `T *` spelled with a plain integer builtin; undefined otherwise. */
function pointeeWidth(t: TypeNode | null): number | undefined {
  if (!t || t.kind !== NodeKind.PointerType) return undefined;
  return INTEGER_WIDTH[emit((t as PointerType).pointee as never).replace(/\s+/g, ' ').trim()];
}

/** The line's `=` facts when statement s is alone on its line with exactly one `=`. */
function lineFacts<T>(s: Statement, m: ReadonlyMap<number, readonly T[]> | undefined): { line: number; facts: readonly T[] } | null {
  if (!m || !placed(s) || s.location.start.line !== s.location.end.line) return null;
  if ([...traverseAST(s)].filter(n => n.kind === NodeKind.AssignExpr).length + (s.kind === NodeKind.DeclStmt ? 1 : 0) !== 1) return null;
  const facts = m.get(s.location.start.line);
  return facts ? { line: s.location.start.line, facts } : null;
}

/**
 * Rewrite the stores `E.m = v;` after the definition whose MOV the original addresses off
 * the register the definition's LEA wrote; the count rewritten. Through the local's own type
 * (`p->m`) when it is the type of `&E`; through an integer pointer (`uint32_t *p = (uint32_t
 * *)&E`) as `p[disp / w]` when the store is one element of it and v is an integer literal.
 */
function heldStores(
  defNode: Statement, def: { name: string; cast: TypeNode | null; type: TypeNode | null; decl: boolean },
  key: string, after: Statement[], opts: HeldAddressMemberOptions,
): number {
  const lf = lineFacts(defNode, opts.storeBases);
  const lea = lf?.facts.find(f => (f as StoreBaseFact).ord === 0 && (f as StoreBaseFact).kind === 'l') as StoreBaseFact | undefined;
  if (!lea) return 0;
  const width = def.cast ? (def.decl ? pointeeWidth(def.type) : undefined) : undefined;
  if (def.cast && width === undefined) return 0;
  let n = 0;
  const visit = (node: ASTNode): void => {
    if (node.kind === NodeKind.CompoundStmt) { for (const s of (node as CompoundStmt).statements as Statement[]) visit(s); return; }
    for (const c of Object.values(node)) {
      if (Array.isArray(c)) { for (const x of c) if (x && typeof x === 'object' && 'kind' in x) visit(x as ASTNode); }
      else if (c && typeof c === 'object' && 'kind' in (c as object) && c !== node.location) visit(c as ASTNode);
    }
    if (node.kind !== NodeKind.ExprStmt) return;
    const st = node as ExprStmt;
    const e = unwrap(st.expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return;
    const a = e as AssignExpr;
    const l = unwrap(a.left);
    if (l.kind !== NodeKind.MemberExpr || (l as MemberExpr).isArrow) return;
    const m = l as MemberExpr;
    if (m.member.kind !== NodeKind.Identifier || emit(unwrap(m.object) as never).replace(/\s+/g, '') !== key) return;
    const sf = lineFacts(st, opts.storeBases);
    const store = sf?.facts.find(f => (f as StoreBaseFact).ord === 0) as StoreBaseFact | undefined;
    if (!store || store.kind !== 's' || store.reg !== lea.reg) return;
    if (!def.cast) {
      a.left = Expr.member(Expr.identifier(def.name), cloneNode(m.member) as Identifier, true);
      n++;
      return;
    }
    const size = opts.accessOrder?.stores.get(st.location.start.line);
    const v = unwrap(a.right);
    if (!size || size.length !== 1 || size[0].size !== width || store.disp % width! !== 0) return;
    if (v.kind !== NodeKind.IntegerLiteral) return;
    a.left = Expr.subscript(Expr.identifier(def.name), Expr.intLiteral(store.disp / width!, 10));
    n++;
  };
  for (const s of after) visit(s);
  return n;
}

function rewriteFunction(fn: FunctionDecl, opts: HeldAddressMemberOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const fname = (fn as unknown as { name?: { name?: string } }).name?.name ?? '';
  const body = cloneNode(fn.body) as CompoundStmt;
  let changed = false;
  for (const n of [...traverseAST(body)]) {
    if (n.kind !== NodeKind.CompoundStmt) continue;
    const list = (n as CompoundStmt).statements as Statement[];
    for (let i = 0; i < list.length; i++) {
      const def = definition(list[i]);
      if (!def) continue;
      const root = pathRoot(def.path)!;
      if (root === def.name) continue;
      const defNode = list[i];
      // p: this one definition only, address never taken, not shadowed.
      const pw = writes(body, def.name).filter(w => !(defNode.kind === NodeKind.ExprStmt && unwrap((defNode as ExprStmt).expression) === w));
      if (pw.length) continue;
      // Neither is shadowed by a second declaration; no label after the definition (a jump in
      // could skip it).
      if (declCount(body, def.name) > 1 || declCount(body, root) > 1) continue;
      const after = list.slice(i + 1);
      if (after.some(s => [...traverseAST(s)].some(m => m.kind === NodeKind.LabelStmt))) continue;
      // r: never written after the definition, its address never taken.
      if (after.some(s => writes(s, root).length)) continue;
      if (writes(body, root).some(w => w.kind === NodeKind.UnaryExpr && (w as UnaryExpr).operator === '&')) continue;
      // The link is the `this` of an inlined TSLink member: its NextLink is called on it.
      // Without that, the stores the original addresses off the register its LEA put the
      // link in (the store-bases facts) are the ones written through the local.
      const key = emit(def.path as never).replace(/\s+/g, '');
      // A link off `this` keeps to the evidence too: the member function's own `this` is no
      // local a NextLink call proves the original held the link apart from.
      const nextLink = after.some(s => [...traverseAST(s)].some(m => nextLinkOn(m, def.name)));
      if (!nextLink || (root === 'this' && !def.cast)) {
        const k = heldStores(defNode, def, key, after, opts);
        if (k) { changed = true; opts.onSite?.({ function: fname, name: def.name, uses: k }); }
        continue;
      }
      if (def.cast || root === 'this') continue;
      let uses = 0;
      const rewrite = (s: ASTNode): ASTNode => {
        if (s.kind === NodeKind.MemberExpr) {
          const m = s as MemberExpr;
          if (!m.isArrow && emit(unwrap(m.object) as never).replace(/\s+/g, '') === key) {
            uses++;
            return Expr.member(Expr.identifier(def.name), cloneNode(m.member) as Identifier, true);
          }
        }
        for (const [k, v] of Object.entries(s)) {
          if (Array.isArray(v)) (s as unknown as Record<string, unknown>)[k] = v.map(x => x && typeof x === 'object' && 'kind' in x ? rewrite(x as ASTNode) : x);
          else if (v && typeof v === 'object' && 'kind' in (v as object)) (s as unknown as Record<string, unknown>)[k] = rewrite(v as ASTNode);
        }
        return s;
      };
      for (let j = i + 1; j < list.length; j++) list[j] = rewrite(list[j]) as Statement;
      if (uses) {
        changed = true;
        opts.onSite?.({ function: fname, name: def.name, uses });
      }
    }
  }
  return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
}

export const heldAddressMemberPlugin: TransformPlugin = {
  id: 'held-address-member',
  name: 'Held Address Member',
  description: 'A member of a sub-object whose address a local holds is addressed through the local',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 989.994,
  tags: ['matching'],
  createTransformer: (options: HeldAddressMemberOptions = {}): Transformer => createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  }),
};
