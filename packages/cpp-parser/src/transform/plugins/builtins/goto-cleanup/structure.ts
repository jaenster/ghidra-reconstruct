/**
 * The structurer (design step 6): a goto into ANOTHER block - the label sits in a sibling
 * arm, or further up, not in a list that encloses the goto - becomes the block itself.
 *
 *   if (a) { X; L: W; } else { Y; if (c) goto L; }        // MSVC merged two copies of W
 *     ->  if (a) { X; W; } else { Y; if (c) { W; } }
 *
 * The block T after the label (to the end of its list, or to the next `case`) is put at the
 * goto site, and the goto goes. Two things must hold:
 *
 *   - Evidence that the source had T there (copy-policy.ts). One goto and nothing falling
 *     into the label is a MOVE: T is the only copy and nothing is duplicated. Otherwise the
 *     tail must be an evidenced copy (E3 halt, E4 terminator, E6 short cross-jumped tail);
 *     a tail with no evidence keeps its goto.
 *   - T must continue where the goto site continues. Falling off T reaches E_T (the
 *     statement after T's list, the loop's continue point, the next arm, or the function's
 *     end); falling off the site reaches C_site. When they are the same place nothing more
 *     is needed. When they are not, the jump that reaches E_T from the site is appended if
 *     C has one - `break` (E_T is the follow of the site's innermost loop or switch),
 *     `continue` (the site's innermost loop's continue point), `return;` (the end of a void
 *     function) - and otherwise the goto stays. A T that cannot fall through needs neither.
 *
 *   `if (c) goto L; R` where R runs to the end of the list and T continues where the list
 *   does becomes `if (c) { T } else { R }` - no new jump - rather than `if (c) { T; break; } R`.
 *
 * Every candidate is the WHOLE function body before and after, put through the same
 * `accept()` as every other handler: the reachability net, then the validator's proof that
 * the new body is an unfolding of the old (cfg/equivalence.ts). Anything it cannot prove
 * keeps its goto. This file never decides correctness; it only proposes.
 *
 * A loop's own control (a jump to its head or increment, an exit past its follow) is tried
 * first, per label, by loops.ts (step 7). A goto from inside a loop or switch that sits in
 * an earlier statement of the label's list is a loop exit and is structured here as a
 * crossing. Not here (step 8): condition DAG folding and the lemma passes.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, GotoStmt, IfStmt, LabelStmt, Statement,
} from '../../../../ast/nodes.js';
import { Stmt } from '../../../../ast/factory.js';
import { updateNode } from '../../../transformer.js';
import {
  type Cont, type LabelSlot, type Path,
  LOOPS, after, anyStmt, binders, comparePaths, contKey, dropLabel, emitText, fallsThrough, findLabel, freeJumps,
  getAt, gotoPaths, holdsFreeCase, isCaseLike, isPrefix, jumpFor, key, sameArm, sameBinder, setAt, setList, walk,
} from './paths.js';
import { deepCloneStatements, isSimpleLabelName, negateCondition } from './helpers.js';
import { countGotosInStatements } from './analysis.js';
import { announceCopy, gotoSitesFor, judgeCopy, labelFallthrough, type EvidenceClass } from './copy-policy.js';
import { recordStat } from './stats.js';
import { exitHoist, exitMove, exitSwap, rotateEntry, headContinue, latchFor, type LoopRewrite } from './loops.js';

const LOOP_REWRITES: ((body: CompoundStmt, name: string, ctx: StructureContext) => LoopRewrite | null)[] = [
  (b, n) => headContinue(b, n),
  (b, n, c) => latchFor(b, n, c),
  (b, n, c) => exitSwap(b, n, c),
  (b, n, c) => exitMove(b, n, c),
  (b, n, c) => exitHoist(b, n, c),
  (b, n, c) => rotateEntry(b, n, c),
];
import { gotoReport } from './report.js';
import { dagFold } from './conds.js';
import { switchTree } from './switchtree.js';


export interface StructureContext {
  noreturn: ReadonlySet<string>;
  voidFn: boolean;
  /** The function's parameter names: locals to the entry lemma unless their address is taken. */
  params?: ReadonlySet<string>;
  /** Proves and keeps a candidate (process.ts `accept`), or returns null. */
  accept: (before: Statement[], after: Statement[], handler: string, proofBefore?: Statement[], merge?: boolean) => Statement[] | null;
}

/**
 * Put `block` where the goto at `site` is. Returns the new body, or null when the block
 * cannot continue where the site does.
 */
function placeAt(body: ASTNode, site: Path, block: Statement[], endsAt: Cont | null, ctx: StructureContext, anchor: GotoStmt): ASTNode | null {
  const last = site[site.length - 1];
  const pp = site.slice(0, -1);
  const parent = getAt(body, pp);
  const trivia = anchor.leadingTrivia ?? [];

  // `if (c) goto L;` (the goto alone in a then-branch) with no else.
  let ifPath: Path | null = null;
  if (parent.kind === NodeKind.IfStmt && last.f === 'thenBranch' && !(parent as IfStmt).elseBranch) ifPath = pp;
  if (parent.kind === NodeKind.CompoundStmt && (parent as CompoundStmt).statements.length === 1 && pp.length > 0
    && pp[pp.length - 1].f === 'thenBranch') {
    const gp = getAt(body, pp.slice(0, -1));
    if (gp.kind === NodeKind.IfStmt && !(gp as IfStmt).elseBranch) ifPath = pp.slice(0, -1);
  }

  const withJump = (from: Path, cont: Cont): Statement[] | null => {
    if (!endsAt || contKey(endsAt) === contKey(cont)) return block;
    const j = jumpFor(body, from, endsAt, ctx.voidFn);
    return j ? [...block, j] : null;
  };

  if (ifPath && ifPath.length > 0 && ifPath[ifPath.length - 1].f === 'statements') {
    const listPath = ifPath.slice(0, -1);
    const j = ifPath[ifPath.length - 1].i!;
    const list = (getAt(body, listPath) as CompoundStmt).statements;
    const ifs = list[j] as IfStmt;
    const R = list.slice(j + 1);
    // if (c) { T } else { R }: T and R both continue where the list does.
    if (endsAt && R.length && !holdsFreeCase(R)
      && contKey(endsAt) === contKey(after(body, listPath)) && contKey(after(body, ifPath)) !== contKey(endsAt)) {
      if (block.length === 0) {
        // Nothing to put there: the goto only skipped R.
        const els = Stmt.compound(R);
        els.location = R[0].location;
        const nif = updateNode(ifs, { condition: negateCondition(ifs.condition), thenBranch: els, elseBranch: null });
        return setList(body, listPath, [...list.slice(0, j), nif]);
      }
      const then = Stmt.compound(block);
      then.location = anchor.location;
      then.leadingTrivia = trivia;
      const els = Stmt.compound(R);
      els.location = R[0].location;
      const nif = updateNode(ifs, { thenBranch: then, elseBranch: els });
      return setList(body, listPath, [...list.slice(0, j), nif]);
    }
  }

  if (block.length === 0 && !endsAt) return null;

  if (last.f === 'statements') {
    // A bare goto in a list: the block takes its place.
    const list = (parent as CompoundStmt).statements;
    const placed = withJump(site, after(body, site));
    if (!placed || (placed.length === 0 && ifPath)) return null;
    if (placed.length && trivia.length) placed[0] = { ...placed[0], leadingTrivia: [...trivia, ...(placed[0].leadingTrivia ?? [])] } as Statement;
    return setList(body, pp, [...list.slice(0, last.i!), ...placed, ...list.slice(last.i! + 1)]);
  }

  // The goto is a branch of an if (or a label/case's statement): a compound replaces it.
  const placed = withJump(site, after(body, site));
  if (!placed || placed.length === 0) return null;
  const blk = Stmt.compound(placed);
  blk.location = anchor.location;
  blk.leadingTrivia = trivia;
  return setAt(body, site, blk);
}

/** Try to structure every goto to `name`. Returns the new body or null. */
function structureLabel(body: CompoundStmt, name: string, ctx: StructureContext): { body: CompoundStmt; cls: EvidenceClass; sites: number; tail: Statement[] } | null {
  const slot = findLabel(body, name);
  if (!slot) return null;
  const sites = gotoPaths(body, name);
  if (sites.length === 0) return null;
  // A goto from inside its own tail is a loop, not an arm crossing; one from the list that
  // holds the label (or from inside an earlier statement of it) is a forward skip, which
  // the forward handlers own - neither is a crossing.
  const list = (getAt(body, slot.list) as CompoundStmt).statements;
  // A goto from inside a loop or switch in an earlier statement of the label's list is a
  // loop (or switch) EXIT to a block past its follow: it cannot be a skip (falling off a
  // loop body continues the loop), so it is structured here like a crossing - T goes into
  // the loop at the goto, when T continues where the site can reach (a T that cannot fall
  // through, or one ending the function), as a move or an evidenced copy.
  for (const s of sites) {
    if (isPrefix(slot.list, s) && sameArm(list, s[slot.list.length].i!, slot.k) && !crossesBreakable(body as ASTNode, slot.list, s)) return null;
  }

  const T: Statement[] = [slot.inner, ...list.slice(slot.k + 1, slot.m)].filter(s => s.kind !== NodeKind.NullStmt);
  if (holdsFreeCase(T)) return null;
  const falls = T.length === 0 || fallsThrough(T[T.length - 1], ctx.noreturn);
  const cutByCase = slot.m < list.length;
  const endsAt: Cont | null = falls ? (cutByCase ? { k: 'pos', list: slot.list, i: slot.m } : after(body, slot.list)) : null;
  // A tail that falls into the next arm is left to switch handling.
  if (endsAt && cutByCase) return null;
  // A break/continue in T must bind to the same statement at every site.
  const fj = freeJumps(T);
  if (fj.brk || fj.cont) {
    const here = binders(body as ASTNode, [...slot.list, { f: 'statements', i: slot.k }]);
    for (const s of sites) {
      const there = binders(body as ASTNode, s);
      if (fj.brk && !sameBinder(here.breakable, there.breakable)) return null;
      if (fj.cont && !sameBinder(here.loop, there.loop)) return null;
    }
  }

  const hasCase = slot.wrappers.some(w => isCaseLike(w as ASTNode));
  const lf = labelFallthrough(body.statements, name, s => fallsThrough(s, ctx.noreturn));
  const hasFallthrough = lf.hasFallthrough || hasCase;
  // Nothing to copy (an empty tail), or one goto and nothing falling in: the block ends up
  // in one place either way - a retarget or a MOVE, no evidence needed.
  const isMove = T.length === 0 || (sites.length === 1 && !hasFallthrough);

  let cls: EvidenceClass;
  if (isMove) {
    // A move duplicates nothing, so labels may move with T. A declaration may not when T is
    // cut at a case: a later arm could name it.
    if (cutByCase && T.some(s => s.kind === NodeKind.DeclStmt)) return null;
    cls = 'move';
  } else {
    const judged = judgeCopy(T, {
      sites: gotoSitesFor(body.statements, name), hasFallthrough, fallthroughPrefix: lf.prefix, noreturn: ctx.noreturn,
      label: name, region: body.statements, tailInRegion: T,
    });
    if (judged === null || judged === 'none' || judged === 'move') return null;
    // A copied goto is one more goto; a copied top-level declaration is a second definition.
    if (anyStmt(T, n => n.kind === NodeKind.GotoStmt || n.kind === NodeKind.LabelStmt)) return null;
    if (T.some(s => s.kind === NodeKind.DeclStmt)) return null;
    cls = judged;
  }

  // Place T at each site, last site first, so the paths of earlier sites stay valid.
  let cur: ASTNode = body as ASTNode;
  const ordered = [...sites].sort((a, b) => comparePaths(b, a));
  let placed = 0;
  for (const site of ordered) {
    const g = getAt(cur, site) as GotoStmt;
    const block = isMove ? [...T] : deepCloneStatements(T);
    const next = placeAt(cur, site, block, endsAt, ctx, g);
    if (!next) {
      if (isMove && T.length) return null;
      continue;
    }
    cur = next;
    placed++;
  }
  if (placed === 0) return null;

  // The original: deleted when nothing falls into it and no goto to it is left; otherwise it
  // stays, without our label once no goto to it is left.
  const counts = countGotosInStatements((cur as CompoundStmt).statements);
  const left = counts.get(name) ?? 0;
  const s2 = findLabel(cur as CompoundStmt, name);
  if (!s2) return null;
  const list2 = (getAt(cur, s2.list) as CompoundStmt).statements;
  if (left === 0) {
    const othersLive = s2.wrappers.some(w => w.kind === NodeKind.LabelStmt && (w as LabelStmt).label.name !== name
      && (counts.get((w as LabelStmt).label.name) ?? 0) > 0);
    if (!hasFallthrough && !othersLive) {
      cur = setList(cur, s2.list, [...list2.slice(0, s2.k), ...list2.slice(s2.m)]);
    } else {
      const nl = [...list2];
      nl[s2.k] = dropLabel(list2[s2.k], name);
      cur = setList(cur, s2.list, nl);
    }
  } else if (isMove && T.length) {
    return null;
  }
  return { body: cur as CompoundStmt, cls, sites: placed, tail: T };
}

/** A loop or switch body lies between the list at `listPath` and `site`. */
function crossesBreakable(root: ASTNode, listPath: Path, site: Path): boolean {
  for (let d = listPath.length + 1; d < site.length; d++) {
    if (site[d].f !== 'body') continue;
    const k = getAt(root, site.slice(0, d)).kind;
    if (LOOPS.has(k) || k === NodeKind.SwitchStmt) return true;
  }
  return false;
}

/** One join sunk into the arms before it: what was copied, how many times, and why. */
interface Sunk { cls: EvidenceClass; tail: Statement[]; copies: number }

/**
 * Make falling off the list at `from` reach the label: at each level between `from` and the
 * label's list, the statements J after the enclosing if (the JOIN of its arms) are sunk
 * into every arm that can fall off its end, an if with no else getting `else { J }`.
 *
 *   if (a) { ..if (c) goto L; R } else { Y }  J;  L:
 *     ->  if (a) { ..if (c) goto L; R; J } else { Y; J }  L:
 *
 * after which the goto only skips (skipLabel). That is MSVC's tail merge undone: J sat once
 * after the if because the compiler merged its copies at the end of each arm. One arm that
 * can fall through means J moves (no copy); several need the copy policy's evidence, the
 * arm ends being the sites. Returns null when a level crosses a loop or switch body (falling
 * off it does not reach what follows), or the policy declines.
 */
function sinkToLabel(body: ASTNode, from: Path, slot: LabelSlot, name: string, ctx: StructureContext): { body: ASTNode; sunk: Sunk[] } | null {
  let cur = body;
  let at = from;
  const sunk: Sunk[] = [];
  for (let guard = 0; guard < 32; guard++) {
    if (key(at) === key(slot.list)) return { body: cur, sunk };
    // Up to the nearest enclosing list, through if arms, compounds and labels only.
    let d = at.length;
    while (d > 0 && at[d - 1].f !== 'statements') {
      const st = at[d - 1].f;
      const owner = getAt(cur, at.slice(0, d - 1));
      if (st === 'body' || isCaseLike(owner)) return null;
      d--;
    }
    if (d === 0) return null;
    const listPath = at.slice(0, d - 1);
    const j = at[d - 1].i!;
    const list = (getAt(cur, listPath) as CompoundStmt).statements;
    const atSlot = key(listPath) === key(slot.list);
    if (atSlot && j >= slot.k) return null;
    const end = atSlot ? slot.k : list.length;
    const J = list.slice(j + 1, end).filter(x => x.kind !== NodeKind.NullStmt);
    const S = list[j];
    if (J.length) {
      if (S.kind !== NodeKind.IfStmt && S.kind !== NodeKind.CompoundStmt) return null;
      if (holdsFreeCase(J)) return null;
      // The arms J is reached from: a block, or every arm of an if / else if / else chain
      // (null: the chain has no final else, so J is also reached when no arm is taken).
      const arms: { get: Statement | null; prefix: string }[] = [];
      if (S.kind === NodeKind.CompoundStmt) {
        arms.push({ get: S, prefix: 'block' });
      } else {
        let e: Statement | null = S;
        let i = 0;
        while (e && e.kind === NodeKind.IfStmt) { arms.push({ get: (e as IfStmt).thenBranch, prefix: `t:${i++}` }); e = (e as IfStmt).elseBranch; }
        arms.push({ get: e, prefix: 'else' });
      }
      const falling = arms.filter(a => a.get === null || fallsThrough(a.get, ctx.noreturn));
      if (!falling.length) return null;
      let cls: EvidenceClass;
      if (falling.length === 1) {
        if (atSlot && J.some(x => x.kind === NodeKind.DeclStmt)) return null;
        cls = 'move';
      } else {
        const prefixes = falling.map(a => a.get === null ? `f:${a.prefix}` : armPrefix(a.get));
        // The join's end is the label the skip jumps to: those gotos are the jumps being
        // structured, so they never count as another way into it (copy-policy A2).
        const judged = judgeCopy(J, {
          sites: prefixes.map(prefix => ({ prefix })), hasFallthrough: false, noreturn: ctx.noreturn,
          label: name, region: (cur as CompoundStmt).statements, tailInRegion: J, sunkJoin: true,
        });
        if (judged === null || judged === 'none' || judged === 'move') return null;
        if (anyStmt(J, n => n.kind === NodeKind.GotoStmt || n.kind === NodeKind.LabelStmt)) return null;
        if (J.some(x => x.kind === NodeKind.DeclStmt)) return null;
        cls = judged;
      }
      const copyFor = (first: boolean) => (cls === 'move' || first ? [...J] : deepCloneStatements(J));
      const append = (arm: Statement | null, first: boolean): Statement => {
        const extra = copyFor(first);
        if (arm === null) { const b = Stmt.compound(extra); b.location = J[0].location; return b; }
        if (arm.kind === NodeKind.CompoundStmt) return updateNode(arm as CompoundStmt, { statements: [...(arm as CompoundStmt).statements, ...extra] });
        const b = Stmt.compound([arm, ...extra]);
        b.location = arm.location;
        return b;
      };
      let newS: Statement;
      let firstUsed = false;
      const use = () => { const f = !firstUsed; firstUsed = true; return f; };
      if (S.kind === NodeKind.CompoundStmt) {
        newS = append(S, use());
      } else {
        const chain: IfStmt[] = [];
        let e: Statement | null = S;
        while (e && e.kind === NodeKind.IfStmt) { chain.push(e as IfStmt); e = (e as IfStmt).elseBranch; }
        const lastElse = e === null || fallsThrough(e, ctx.noreturn) ? append(e, use()) : e;
        const go = (i: number): Statement => {
          const c = chain[i];
          const t = fallsThrough(c.thenBranch, ctx.noreturn) ? append(c.thenBranch, use()) : c.thenBranch;
          const el = i + 1 < chain.length ? go(i + 1) : lastElse;
          return updateNode(c, { thenBranch: t, elseBranch: el });
        };
        newS = go(0);
      }
      sunk.push({ cls, tail: J, copies: falling.length });
      cur = setList(cur, listPath, [...list.slice(0, j), newS, ...list.slice(end)]);
    }
    at = listPath;
    // Inside the label's own list the label now follows S directly.
    if (atSlot) return { body: cur, sunk };
  }
  return null;
}

/** The prefix of an arm's end, as copy-policy encodes a statement prefix. */
function armPrefix(arm: Statement): string {
  let s = arm;
  while (s.kind === NodeKind.CompoundStmt && (s as CompoundStmt).statements.length) {
    const l = (s as CompoundStmt).statements;
    s = l[l.length - 1];
  }
  try { return 's:' + emitText(s); } catch { return 's:?' + Math.random(); }
}

/**
 * A goto that only SKIPS: `if (c) goto L; R` where falling off R reaches L (R is the rest
 * of its list, and every list it sits in ends right before L) becomes `if (!c) { R }`. No
 * copy - the RETARGET primitive - so it needs no evidence. The forward handlers do this for
 * a goto in L's own list; here the goto may sit any number of blocks deeper.
 */
function skipLabel(body: CompoundStmt, name: string, ctx: StructureContext): { body: CompoundStmt; sites: number; sunk: Sunk[] } | null {
  const slot = findLabel(body, name);
  if (!slot) return null;
  const slotList = (getAt(body, slot.list) as CompoundStmt).statements;
  const sites = gotoPaths(body, name)
    .filter(s => isPrefix(slot.list, s) && sameArm(slotList, s[slot.list.length].i!, slot.k))
    .sort((a, b) => comparePaths(b, a));
  let cur: ASTNode = body as ASTNode;
  let done = 0;
  const sunk: Sunk[] = [];
  for (const site of sites) {
    const s = findLabel(cur as CompoundStmt, name);
    if (!s) return null;
    const target = contKey({ k: 'pos', list: s.list, i: s.k });
    // The goto alone in the then-branch of an if with no else, the if in a list.
    let ifPath = site.slice(0, -1);
    let parent = getAt(cur, ifPath);
    if (parent.kind === NodeKind.CompoundStmt) {
      if ((parent as CompoundStmt).statements.length !== 1 || ifPath[ifPath.length - 1]?.f !== 'thenBranch') continue;
      ifPath = ifPath.slice(0, -1);
      parent = getAt(cur, ifPath);
    } else if (site[site.length - 1].f !== 'thenBranch') continue;
    if (parent.kind !== NodeKind.IfStmt || (parent as IfStmt).elseBranch || ifPath[ifPath.length - 1]?.f !== 'statements') continue;
    const listPath = ifPath.slice(0, -1);
    const j = ifPath[ifPath.length - 1].i!;
    const list = (getAt(cur, listPath) as CompoundStmt).statements;
    const sameList = key(listPath) === key(s.list);
    if (sameList && j > s.k) continue;
    const end = sameList ? s.k : list.length;
    const R = list.slice(j + 1, end);
    if (R.length === 0 || holdsFreeCase(R)) continue;
    if (sameList && R.some(x => x.kind === NodeKind.DeclStmt)) continue;
    if (!sameList && contKey(after(cur, listPath)) !== target) {
      // Statements between the goto's block and the label: sink them into the arms first.
      // One site per candidate - the sinking is judged and proven with the skip it enables.
      if (done || sunk.length) continue;
      const r = sinkToLabel(cur, listPath, s, name, ctx);
      if (!r || !r.sunk.length) continue;
      const list2 = (getAt(r.body, listPath) as CompoundStmt).statements;
      const s3 = findLabel(r.body as CompoundStmt, name);
      if (!s3 || contKey(after(r.body, listPath)) !== contKey({ k: 'pos', list: s3.list, i: s3.k })) continue;
      const ifs2 = list2[j] as IfStmt;
      const R2 = list2.slice(j + 1);
      if (R2.length === 0 || holdsFreeCase(R2)) continue;
      const blk2 = Stmt.compound(R2);
      blk2.location = R2[0].location;
      const nif2 = updateNode(ifs2, { condition: negateCondition(ifs2.condition), thenBranch: blk2, elseBranch: null });
      cur = setList(r.body, listPath, [...list2.slice(0, j), nif2]);
      sunk.push(...r.sunk);
      done++;
      break;
    }
    const ifs = parent as IfStmt;
    const blk = Stmt.compound(R);
    blk.location = R[0].location;
    const nif = updateNode(ifs, { condition: negateCondition(ifs.condition), thenBranch: blk, elseBranch: null });
    cur = setList(cur, listPath, [...list.slice(0, j), nif, ...list.slice(end)]);
    done++;
  }
  if (!done) return null;
  if ((countGotosInStatements((cur as CompoundStmt).statements).get(name) ?? 0) === 0) {
    const s2 = findLabel(cur as CompoundStmt, name)!;
    const l2 = [...(getAt(cur, s2.list) as CompoundStmt).statements];
    l2[s2.k] = dropLabel(l2[s2.k], name);
    cur = setList(cur, s2.list, l2);
  }
  return { body: cur as CompoundStmt, sites: done, sunk };
}

/** Labels of the body in order, each with its gotos. */
function labelNames(body: CompoundStmt): string[] {
  const names: string[] = [];
  walk(body as ASTNode, n => { if (n.kind === NodeKind.LabelStmt) names.push((n as LabelStmt).label.name); });
  const counts = countGotosInStatements(body.statements);
  // Only Ghidra's own labels: a user label (`ERROR`, a source name) is kept as written,
  // exactly as the other handlers keep it.
  return names.filter(n => isSimpleLabelName(n) && (counts.get(n) ?? 0) > 0);
}

/**
 * Structure the arm crossings of one function body. Each accepted rewrite is proven on the
 * whole body. Labels are tried in sweeps: a label refused in one sweep is tried again only
 * after a later rewrite in the same sweep changed the body.
 */
/** A compare tree whose default edges are the gotos to this label (switchtree.ts). */
function trySwitchTree(cur: CompoundStmt, name: string, ctx: StructureContext): CompoundStmt | null {
  let st: ReturnType<typeof switchTree>;
  try { st = switchTree(cur, name, ctx); } catch { st = null; }
  if (!st) return null;
  recordStat('switchTree', st.sites);
  gotoReport({ event: 'structure', label: name, cls: 'switchTree', sites: st.sites });
  return st.body;
}

/** A goto that finishes a condition (conds.ts): the label's arm is the shared true edge. */
function tryFold(cur: CompoundStmt, name: string, ctx: StructureContext): CompoundStmt | null {
  let df: ReturnType<typeof dagFold>;
  try { df = dagFold(cur, name, ctx); } catch { df = null; }
  if (!df) return null;
  const kept = ctx.accept(cur.statements, df.body.statements, 'structure:dagFold');
  if (!kept) return null;
  recordStat('dagFold', df.sites);
  gotoReport({ event: 'structure', label: name, cls: 'dagFold', sites: df.sites });
  return updateNode(cur, { statements: kept });
}

/**
 * The rewrites that read a goto as part of a test, before the handlers: a compare tree's
 * default edges and a goto that only finishes a condition. A copying handler would
 * otherwise take the label's block to each site first.
 */
export function foldConditions(body: CompoundStmt, ctx: StructureContext): CompoundStmt | null {
  let cur = body;
  let changed = false;
  for (let sweep = 0; sweep < 64; sweep++) {
    let progressed = false;
    for (const name of labelNames(cur)) {
      const t = trySwitchTree(cur, name, ctx);
      if (t) { cur = t; changed = progressed = true; continue; }
      const f = tryFold(cur, name, ctx);
      if (f) { cur = f; changed = progressed = true; }
    }
    if (!progressed) break;
  }
  return changed ? cur : null;
}

export function structureBody(body: CompoundStmt, ctx: StructureContext): CompoundStmt | null {
  let cur = body;
  let changed = false;
  for (let sweep = 0; sweep < 64; sweep++) {
    let progressed = false;
    for (const name of labelNames(cur)) {
      // A loop's own control first (loops.ts): a jump to its head, its increment, or past
      // the exit MSVC laid out after it.
      let looped = false;
      for (const make of LOOP_REWRITES) {
        let lr: LoopRewrite | null;
        try { lr = make(cur, name, ctx); } catch { lr = null; }
        if (!lr) continue;
        if (lr.copy) announceCopy('structure-loop', name, lr.copy.cls, lr.copy.tail, lr.copy.copies);
        const kept = ctx.accept(cur.statements, lr.body.statements, `structure:${lr.kind}`, lr.before?.statements);
        if (!kept) continue;
        recordStat(lr.kind, lr.sites);
        if (lr.before) recordStat('latchForLemma', lr.sites);
        gotoReport({ event: 'structure', label: name, cls: lr.kind, sites: lr.sites, lemma: !!lr.before });
        cur = updateNode(cur, { statements: kept });
        changed = progressed = looped = true;
        break;
      }
      if (looped) continue;
      const switched = trySwitchTree(cur, name, ctx);
      if (switched) { cur = switched; changed = progressed = true; continue; }
      const folded = tryFold(cur, name, ctx);
      if (folded) { cur = folded; changed = progressed = true; continue; }
      let sk: ReturnType<typeof skipLabel>;
      try { sk = skipLabel(cur, name, ctx); } catch { sk = null; }
      if (sk) {
        for (const j of sk.sunk) announceCopy('structure-sink', name, j.cls, j.tail, j.cls === 'move' ? 1 : j.copies);
        const kept = ctx.accept(cur.statements, sk.body.statements, sk.sunk.length ? 'structure:sink' : 'structure:skip');
        if (kept) {
          recordStat('structureSkip', sk.sites);
          gotoReport({ event: 'structure', label: name, cls: 'skip', sites: sk.sites });
          cur = updateNode(cur, { statements: kept });
          changed = progressed = true;
        }
      }
      let r: ReturnType<typeof structureLabel>;
      try { r = structureLabel(cur, name, ctx); } catch { r = null; }
      if (!r) continue;
      if (r.cls !== 'move') announceCopy('structure', name, r.cls, r.tail, r.sites);
      else if (r.tail.length) announceCopy('structure', name, 'move', r.tail, 1);
      const kept = ctx.accept(cur.statements, r.body.statements, `structure:${r.cls}`);
      if (!kept) continue;
      recordStat('structureArm', r.sites);
      gotoReport({ event: 'structure', label: name, cls: r.cls, sites: r.sites });
      cur = updateNode(cur, { statements: kept });
      changed = progressed = true;
    }
    if (!progressed) break;
  }
  return changed ? cur : null;
}
