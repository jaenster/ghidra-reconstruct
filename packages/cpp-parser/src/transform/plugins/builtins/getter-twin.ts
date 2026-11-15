/**
 * Getter Twin Plugin
 *
 * Some small getters were defined in a header the callers' modules included, so the
 * callers expanded them in place, while one out-of-line copy survives at its address for
 * the callers that did not. GetQuestBitBuffer (00543520, D2Game::Quests::QUESTS) is one:
 *
 *     return GetPlayerData(pUnit)->pQuestRecord[pGame->nDifficulty];
 *
 * The quest callbacks in the A*Q* units hold that body inline. The decompiler prints it
 * with the player-data pointer in a local of its own, and VC8, compiling the local, colours
 * the registers otherwise than the original's inlined call did: CUBE_SpecialOutput_CowPortal
 * 00594140, Q09_CheckBookOfSkillAndSound 00598fa0 and four more match once each site calls
 * an inline twin of the getter. The codegen finds such getters from their decompile
 * (codegen/getter-twins.ts) and defines each twin, forced inline, in its unit's inline
 * header; this pass writes the call:
 *
 *     pPlayerData = GetPlayerData(pPlayer);
 *     BVar1 = GetQuestState(pPlayerData->pQuestRecord[pGame->nDifficulty], 7, 0x10);
 *         ->
 *     BVar1 = GetQuestState(QUESTS::GetQuestBitBufferInline(pGame, pPlayer), 7, 0x10);
 *
 * A site is the getter's expression `F(a)->M[b->N]`, with `a` and `b` arguments that
 * neither call nor write (a local, a parameter, a member chain of one), either whole or with
 * the call held in a local V:
 *
 *   - every store to V is `V = F(a)` (or V's initializer), immediately followed in the same
 *     block by the one statement that reads it, once, as `V->M[b->N]`;
 *   - V is read nowhere else and its address is never taken.
 *
 * The call then moves from its own statement into the reading one, past nothing: that
 * statement may evaluate nothing besides the twin's arguments that calls or writes, other
 * than the one call whose argument list holds the site (and a store of that call's
 * result). V's declaration goes once nothing names it.
 *
 * Value-preserving: the twin computes exactly the expression it replaces, with the same
 * argument values, and the getter's call runs at the same point relative to every other
 * call and store.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl, Identifier,
  IfStmt, LabelStmt, MemberExpr, ParenExpr, ReturnStmt, Statement, SubscriptExpr, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { Expr } from '../../../ast/factory.js';
import { getChildren, traverseAST } from '../../../ast/visitor.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import { bareName, calleeName } from './call-arg-cast.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import type { BranchLayoutEvidence } from './branch-layout/evidence.js';

/** A getter `return F(p[i0], ...)->M[p[k]->N];` and the twin a site calls instead. */
export interface GetterTwin {
  /** The twin's name as a call spells it, qualified (`D2Game::Quests::QUESTS::GetQuestBitBufferInline`). */
  call: string;
  /** The getter's parameter count; the twin takes the same parameters. */
  params: number;
  /** The called function's bare name (`GetPlayerData`). */
  callee: string;
  /** For each of the callee's arguments, the getter parameter it passes. */
  calleeArgs: number[];
  /** The member subscripted (`pQuestRecord`). */
  member: string;
  /** The getter parameter the index is read from. */
  indexParam: number;
  /** The member of that parameter the index is (`nDifficulty`). */
  indexMember: string;
}

export interface GetterTwinOptions extends PluginOptions {
  twins?: GetterTwin[];
  /** Code offsets per line of the parsed text (branch-layout/evidence.ts); orders a held site against its index's store. */
  branchLayout?: BranchLayoutEvidence | null;
  onSite?: (e: { line: number; call: string; held: string | null }) => void;
}

type N = ASTNode & Record<string, any>;

function unparen(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

const isId = (e: ASTNode | null | undefined, name?: string): e is Identifier =>
  !!e && e.kind === NodeKind.Identifier && (name === undefined || (e as Identifier).name === name);

/** An argument that neither calls nor writes: a name, or a member chain of one. */
function pureOperand(e: Expression): boolean {
  const x = unparen(e);
  if (x.kind === NodeKind.Identifier || x.kind === NodeKind.QualifiedId) return true;
  if (x.kind === NodeKind.MemberExpr) return pureOperand((x as MemberExpr).object);
  return false;
}

/** Whether n calls, stores, or steps anything. */
function hasEffect(n: ASTNode): boolean {
  for (const k of traverseAST(n)) {
    if (k.kind === NodeKind.CallExpr || k.kind === NodeKind.AssignExpr || k.kind === NodeKind.PostfixExpr
      || k.kind === NodeKind.NewExpr || k.kind === NodeKind.DeleteExpr) return true;
    if (k.kind === NodeKind.UnaryExpr && ((k as UnaryExpr).operator === '++' || (k as UnaryExpr).operator === '--')) return true;
  }
  return false;
}

/** `F(args)` as the twin's callee: the arguments by the getter's parameter positions. */
function matchCall(e: Expression, t: GetterTwin): Expression[] | null {
  const x = unparen(e);
  if (x.kind !== NodeKind.CallExpr) return null;
  const c = x as CallExpr;
  const name = calleeName(c.callee);
  if (!name || bareName(name) !== t.callee || c.arguments.length !== t.calleeArgs.length) return null;
  const bound: (Expression | undefined)[] = new Array(t.params).fill(undefined);
  for (let i = 0; i < c.arguments.length; i++) {
    const a = c.arguments[i];
    if (!pureOperand(a)) return null;
    bound[t.calleeArgs[i]] = a;
  }
  return bound as Expression[];
}

/** `B->M[b->N]`: B and the bound index parameter b, or null. */
function matchRead(e: Expression, t: GetterTwin): { base: Expression; index: Expression } | null {
  const x = unparen(e);
  if (x.kind !== NodeKind.SubscriptExpr) return null;
  const s = x as SubscriptExpr;
  const arr = unparen(s.array);
  if (arr.kind !== NodeKind.MemberExpr || !(arr as MemberExpr).isArrow || !isId((arr as MemberExpr).member, t.member)) return null;
  const idx = unparen(s.index);
  if (idx.kind !== NodeKind.MemberExpr || !(idx as MemberExpr).isArrow || !isId((idx as MemberExpr).member, t.indexMember)) return null;
  const b = (idx as MemberExpr).object;
  if (!pureOperand(b)) return null;
  return { base: (arr as MemberExpr).object, index: b };
}

function twinCall(t: GetterTwin, args: Expression[]): Expression {
  return Expr.call(Expr.qualifiedId(t.call.split('::')), args.map(a => cloneNode(a)));
}

/** Every node of the statement the twin's call would be evaluated beside, except the site. */
function statementCalm(stmt: Statement, site: ASTNode): boolean {
  // The one call whose argument list holds the site, and the store of its result, may
  // stay; nothing else may call or write.
  let host: CallExpr | null = null;
  for (const k of traverseAST(stmt)) {
    if (k.kind === NodeKind.CallExpr && (k as CallExpr).arguments.some(a => unparen(a) === site)) host = k as CallExpr;
  }
  const visit = (n: ASTNode): boolean => {
    if (n === site) return true;
    if (n === host) {
      if (hasEffect(host.callee)) return false;
      return host.arguments.every(a => unparen(a) === site ? true : !hasEffect(a));
    }
    if (n.kind === NodeKind.CallExpr || n.kind === NodeKind.PostfixExpr || n.kind === NodeKind.NewExpr || n.kind === NodeKind.DeleteExpr) return false;
    if (n.kind === NodeKind.UnaryExpr && ((n as UnaryExpr).operator === '++' || (n as UnaryExpr).operator === '--')) return false;
    if (n.kind === NodeKind.AssignExpr) {
      const a = n as AssignExpr;
      // `x = host(...)`: a store to a plain local of the host call's result.
      if (a.operator !== '=' || !isId(unparen(a.left)) || unparen(a.right) !== host) return false;
      return visit(a.right);
    }
    if (n.kind === NodeKind.CompoundStmt) return false;
    return getChildren(n).every(visit);
  };
  return visit(stmt);
}

/** The expression a statement evaluates, as the slot a held site may sit in. */
function evaluated(s: Statement): ASTNode | null {
  switch (s.kind) {
    case NodeKind.ExprStmt: return s;
    case NodeKind.ReturnStmt: return (s as ReturnStmt).value ? s : null;
    case NodeKind.IfStmt: return (s as IfStmt).init ? null : (s as IfStmt).condition;
    case NodeKind.DeclStmt: return (s as DeclStmt).declarations.length === 1 ? s : null;
    default: return null;
  }
}

/** The lowest code offset the lines of a statement print; null when they print none. */
function lowOffset(s: Statement, ev: BranchLayoutEvidence): number | null {
  if (!s.location) return null;
  let low: number | null = null;
  for (let l = s.location.start.line; l <= s.location.end.line; l++) {
    for (const o of ev.lines.get(l) ?? []) if (low === null || o < low) low = o;
  }
  return low;
}

/**
 * The index `b->N` reads a local b stored by the statement right before the held store, and
 * the original's code for the held call starts ahead of that store's (Q05_Callback13_PlayerStartedGame
 * 00595860: `mov eax, [edx+0xc]` for the call's argument before `mov esi, [edx]` for pGame).
 * The twin takes b as an argument and VC8 then evaluates the store first, so the site keeps
 * its call in its own statement, where VC8 schedules the argument's load first as well.
 */
function indexStoredAfter(st: readonly Statement[], i: number, index: Expression, ev: BranchLayoutEvidence | null | undefined): boolean {
  if (!ev || i === 0) return false;
  // The twin's index argument: b itself (the getter reads b->N).
  const b = unparen(index);
  if (b.kind !== NodeKind.Identifier) return false;
  const prev = heldOrStore(st[i - 1]);
  if (prev !== (b as Identifier).name) return false;
  const a = lowOffset(st[i], ev), p = lowOffset(st[i - 1], ev);
  return a !== null && p !== null && a < p;
}

/** `v = e;` or `T v = e;`: v, else null. */
function heldOrStore(s: Statement): string | null {
  if (s.kind === NodeKind.ExprStmt) {
    const e = unparen((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    const l = unparen((e as AssignExpr).left);
    return l.kind === NodeKind.Identifier ? (l as Identifier).name : null;
  }
  if (s.kind === NodeKind.DeclStmt) {
    const ds = (s as DeclStmt).declarations;
    return ds.length === 1 && ds[0].kind === NodeKind.VariableDecl && (ds[0] as VariableDecl).initializer ? (ds[0] as VariableDecl).name.name : null;
  }
  return null;
}

/** `V = F(a);` or `T V = F(a);`: the held local and the call. */
function heldStore(s: Statement): { name: string; call: Expression; decl: VariableDecl | null } | null {
  if (s.kind === NodeKind.ExprStmt) {
    const e = unparen((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=' || !isId(unparen((e as AssignExpr).left))) return null;
    return { name: (unparen((e as AssignExpr).left) as Identifier).name, call: (e as AssignExpr).right, decl: null };
  }
  if (s.kind === NodeKind.DeclStmt && (s as DeclStmt).declarations.length === 1) {
    const v = (s as DeclStmt).declarations[0] as VariableDecl;
    if (v.kind !== NodeKind.VariableDecl || !v.initializer || v.initializer.kind === NodeKind.InitListExpr) return null;
    return { name: v.name.name, call: v.initializer as Expression, decl: v };
  }
  return null;
}

function rewriteFunction(fn: FunctionDecl, opts: GetterTwinOptions): FunctionDecl | undefined {
  const twins = opts.twins ?? [];
  if (!fn.body || twins.length === 0) return undefined;
  const body = cloneNode(fn.body) as CompoundStmt;
  let changed = 0;

  // Names read anywhere (as identifiers) and whose address is taken.
  // A declaration's own name is not a use of it.
  const declNames = (root: ASTNode): Set<ASTNode> => {
    const s = new Set<ASTNode>();
    for (const k of traverseAST(root)) if (k.kind === NodeKind.VariableDecl) s.add((k as VariableDecl).name);
    return s;
  };
  const uses = (root: ASTNode, name: string): number => {
    const own = declNames(root);
    let n = 0;
    for (const k of traverseAST(root)) if (isId(k, name) && !own.has(k)) n++;
    return n;
  };
  const reads = new Map<string, number>();
  const addressed = new Set<string>();
  const own = declNames(body);
  for (const k of traverseAST(body)) {
    if (k.kind === NodeKind.Identifier && !own.has(k)) reads.set((k as Identifier).name, (reads.get((k as Identifier).name) ?? 0) + 1);
    if (k.kind === NodeKind.UnaryExpr && (k as UnaryExpr).operator === '&' && isId(unparen((k as UnaryExpr).operand))) {
      addressed.add((unparen((k as UnaryExpr).operand) as Identifier).name);
    }
  }
  for (const p of fn.parameters ?? []) if (p.name) addressed.add(typeof p.name === 'string' ? p.name : (p.name as Identifier).name);

  // 1. Whole sites: F(a)->M[b->N].
  const replaceIn = (n: N, match: (e: Expression) => Expression | null): void => {
    for (const key of Object.keys(n)) {
      const v = n[key];
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (v[i] && typeof v[i] === 'object' && typeof v[i].kind === 'string') {
            const r = match(v[i]);
            if (r) v[i] = r; else replaceIn(v[i], match);
          }
        }
      } else if (v && typeof v === 'object' && typeof v.kind === 'string' && key !== 'parent') {
        const r = match(v);
        if (r) n[key] = r; else replaceIn(v, match);
      }
    }
  };
  replaceIn(body as N, (e: Expression) => {
    if (e.kind !== NodeKind.SubscriptExpr) return null;
    for (const t of twins) {
      const r = matchRead(e, t);
      if (!r) continue;
      const bound = matchCall(r.base, t);
      if (!bound) continue;
      if (bound[t.indexParam] !== undefined) continue;
      bound[t.indexParam] = r.index;
      if (bound.some(b => b === undefined)) continue;
      changed++;
      opts.onSite?.({ line: 0, call: t.call, held: null });
      return twinCall(t, bound);
    }
    return null;
  });

  // 2. Held sites, per local: every store a held call read once by the next statement.
  const blocks: CompoundStmt[] = [];
  for (const k of traverseAST(body)) if (k.kind === NodeKind.CompoundStmt) blocks.push(k as CompoundStmt);
  type Pair = { block: CompoundStmt; at: number; twin: GetterTwin; bound: Expression[]; site: SubscriptExpr; decl: VariableDecl | null };
  const pairs = new Map<string, Pair[]>();
  const refused = new Set<string>();
  for (const block of blocks) {
    const st = block.statements;
    for (let i = 0; i < st.length; i++) {
      // A labelled store keeps its label on the statement that reads it.
      const h = heldStore(st[i].kind === NodeKind.LabelStmt ? (st[i] as LabelStmt).statement : st[i]);
      if (!h || addressed.has(h.name)) continue;
      let twin: GetterTwin | undefined;
      let bound: Expression[] | null = null;
      for (const t of twins) { bound = matchCall(h.call, t); if (bound) { twin = t; break; } }
      if (!twin || !bound) continue;
      const next = st[i + 1];
      // A label on the reading statement would let a jump read V without the store.
      const slot = next && next.kind !== NodeKind.LabelStmt ? evaluated(next) : null;
      if (!slot) { refused.add(h.name); continue; }
      // The one read of V in the next statement, as V->M[b->N].
      let site: SubscriptExpr | null = null;
      let count = 0;
      count = uses(slot, h.name);
      for (const k of traverseAST(slot)) {
        if (k.kind !== NodeKind.SubscriptExpr) continue;
        const r = matchRead(k as Expression, twin);
        if (r && isId(unparen(r.base), h.name)) site = k as SubscriptExpr;
      }
      if (!site || count !== 1) { refused.add(h.name); continue; }
      const r = matchRead(site, twin)!;
      const b = bound.slice();
      if (b[twin.indexParam] !== undefined) { refused.add(h.name); continue; }
      b[twin.indexParam] = r.index;
      if (b.some(x => x === undefined)) { refused.add(h.name); continue; }
      // The arguments are not V itself and are not written by the reading statement.
      if (b.some(x => [...traverseAST(x)].some(k => isId(k, h.name)))) { refused.add(h.name); continue; }
      if (!statementCalm(next, unparen(site as Expression))) { refused.add(h.name); continue; }
      if (indexStoredAfter(st, i, r.index, opts.branchLayout)) continue;
      const list = pairs.get(h.name) ?? [];
      list.push({ block, at: i, twin, bound: b, site, decl: h.decl });
      pairs.set(h.name, list);
    }
  }
  // Without a jump the top-level block runs in order: a plain store there whose read is the
  // last time the function names V is a value nothing else reads, whatever V held before.
  const jumps = [...traverseAST(body)].some(k => k.kind === NodeKind.GotoStmt || k.kind === NodeKind.LabelStmt);
  const lastAtTop = (name: string, p: Pair): boolean =>
    !jumps && p.block === body && !p.decl && p.block.statements.slice(p.at + 2).every(s => uses(s, name) === 0);
  for (const [name, all] of pairs) {
    let list = all;
    // Each pair accounts for two uses, the store's and the read's; a declaration with an
    // initializer for one, the read.
    const accounted = list.reduce((n, p) => n + (p.decl ? 1 : 2), 0);
    if (refused.has(name) || (reads.get(name) ?? 0) !== accounted) {
      list = list.filter(p => lastAtTop(name, p));
      if (list.length === 0) continue;
    }
    // Apply from the back of each block so earlier indices stay valid.
    const ordered = [...list].sort((a, b) => (a.block === b.block ? b.at - a.at : 0));
    for (const p of ordered) {
      const replacement = twinCall(p.twin, p.bound);
      const st = p.block.statements;
      replaceIn(st[p.at + 1] as N, e => (e === p.site ? replacement : null));
      if (st[p.at].kind === NodeKind.LabelStmt) {
        (st[p.at] as LabelStmt).statement = st[p.at + 1];
        st.splice(p.at + 1, 1);
      } else {
        st.splice(p.at, 1);
      }
      changed++;
      opts.onSite?.({ line: 0, call: p.twin.call, held: name });
    }
    // The declaration goes once nothing names V.
    if (uses(body, name) === 0) {
      for (const k of traverseAST(body)) {
        if (k.kind !== NodeKind.CompoundStmt) continue;
        const s = (k as CompoundStmt).statements;
        for (let i = s.length - 1; i >= 0; i--) {
          const d = s[i];
          if (d.kind !== NodeKind.DeclStmt) continue;
          const ds = (d as DeclStmt).declarations;
          const keep = ds.filter(v => !(v.kind === NodeKind.VariableDecl && (v as VariableDecl).name.name === name && !(v as VariableDecl).initializer));
          if (keep.length === ds.length) continue;
          if (keep.length === 0) s.splice(i, 1); else (d as DeclStmt).declarations = keep;
        }
      }
    }
  }
  if (!changed) return undefined;
  return updateNode(fn, { body } as Partial<FunctionDecl>);
}

function createGetterTwinTransformer(options: GetterTwinOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  });
}

export const getterTwinPlugin: TransformPlugin = {
  id: 'getter-twin',
  name: 'Getter Twin',
  description: 'Writes a getter the callers expanded in place as a call to its forced-inline twin',
  version: '1.0.0',
  defaultEnabled: true,
  // After decl-init-merge (60) joined the held store to its declaration and the record
  // getter passes (60.5-60.56); before field-pointer-fold (62.5) and decl-order-fix.
  priority: 60.58,
  tags: ['matching'],
  createTransformer: createGetterTwinTransformer,
};
