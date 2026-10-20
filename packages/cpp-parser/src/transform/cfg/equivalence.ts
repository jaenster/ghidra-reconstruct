/**
 * The translation validator: is the rewritten region an UNFOLDING of the original?
 *
 * Every structural rewrite the goto passes make is one of: move a block, copy a block so it
 * has fewer predecessors, or replace a jump by `break`/`continue`/`return`/fallthrough that
 * reaches the same place. None of them may change what the program does. This file proves
 * that for one candidate, or refuses it.
 *
 * ## The theorem
 *
 * Lower both regions to branch CFGs (`bcfg.ts`), contract the scaffolding, and build the
 * relation R between their nodes by a simultaneous walk from the entries. The candidate is
 * accepted iff every related pair agrees:
 *
 *   - entry with entry, and every named entry (a label targeted from outside, a case label
 *     whose switch is outside) with the entry of the same name - neither side may have one
 *     the other lacks;
 *   - work with work of the same key, successors related;
 *   - test with test on the same atom, true successor with true, false with false;
 *   - dispatch with dispatch on the same scrutinee, the same case values, each case's
 *     successor related, and the defaults related;
 *   - exit with exit, follow with follow, noreturn with noreturn, spin with spin, and
 *     external with external of the same name.
 *
 * Both programs are deterministic, so by induction on path length every execution of the
 * candidate performs the same work and evaluates the same atoms, in the same order and the
 * same number of times, and leaves the region the same way, as the original. R may relate one
 * original node to several copies - that is what an unfolding IS - and several originals
 * with identical text to one node; both are sound under A2 (see bcfg.ts). Because R is built
 * from the entries outward and every successor of a related pair is related, everything the
 * original could reach is reached by the candidate: deleted live code is refused for free.
 *
 * A1 (scope) is then checked over R: for every related pair, each name the statement uses
 * must resolve, inside the region, to related declarations (or to none on both sides).
 *
 * ## Threaded tests (A4)
 *
 * MSVC threads jumps: where the source tests `c` twice with nothing between that could
 * change it (`if (a && c) T; if (c || d) W;`), or tests a variable it has just stored a
 * constant into (`mode = BAD; break;` out of a loop, then `if (mode == BAD) break;`), the
 * binary skips the second test on the paths where its outcome is known. The decompile then
 * has one test where the source had two. The candidate may restore the second test: a test
 * on the CANDIDATE side whose outcome is fixed by the facts its path has collected is
 * followed by that outcome without being related to anything in the original. Facts, along
 * one path of the candidate:
 *
 *   - a pure atom evaluated earlier, with its outcome (`c` was true);
 *   - `L = K;` with K a literal 0..127 and L pure gives L's value; a later `L == K2` (or
 *     `L` as a truth value) is then decided;
 *
 * and every work node, every impure test and every dispatch forgets them all (a store is
 * forgotten and then becomes the one fact). A fact is only used where every name the test
 * reads binds to the same declaration as where the fact was made.
 *
 * A4 (purity): re-evaluating a pure atom with nothing in between gives the same value, and a
 * store of K to a pure lvalue L makes L == K until the next work - L's own address does not
 * depend on the location the store writes. Narrowing: K is in range of every integer type.
 * Only ever used on the candidate side: the original never gains a test it did not have.
 *
 * What is NOT proven: anything else that needs a value fact - a flag variable, a deleted
 * assignment the loop exit makes redundant. Those are refused here; a pass that wants them
 * needs a named lemma (section 3.1 of the design).
 */

import type { ASTNode, Expression, Statement } from '../../ast/nodes.js';
import { NodeKind } from '../../ast/kinds.js';
import { countGotoTargets } from './labels.js';
import {
  buildBcfg, isPureExpr, lookup, nodeText, resolver, usedNames, Unsupported,
  type Bcfg, type BcfgOptions, type BNode, type Scope,
} from './bcfg.js';

/** A value fact along one candidate path (A4). */
interface Fact { key: string; truth?: boolean; lit?: bigint; scope: Scope | null; origin: ASTNode }

function strip(e: Expression): Expression {
  while (e && e.kind === NodeKind.ParenExpr) e = (e as unknown as { expression: Expression }).expression;
  return e;
}

function literal(e: Expression): bigint | null {
  e = strip(e);
  if (e.kind === NodeKind.IntegerLiteral) return (e as unknown as { value: bigint }).value;
  if (e.kind === NodeKind.BoolLiteral) return (e as unknown as { value: boolean }).value ? 1n : 0n;
  return null;
}

/** `L == K` (either order) with K a literal: [L, K]. */
function eqLiteral(e: ASTNode | null): [Expression, bigint] | null {
  if (!e) return null;
  const x = strip(e as Expression);
  if (x.kind !== NodeKind.BinaryExpr || (x as unknown as { operator: string }).operator !== '==') return null;
  const b = x as unknown as { left: Expression; right: Expression };
  const r = literal(b.right), l = literal(b.left);
  if (r !== null && l === null) return [b.left, r];
  if (l !== null && r === null) return [b.right, l];
  return null;
}

/** The store `L = K` a work node performs, K a literal in 0..127 and L pure. */
function storeOf(n: BNode): [string, bigint] | null {
  let e = n.origin as ASTNode | null;
  if (!e) return null;
  if (e.kind === NodeKind.ExprStmt) e = (e as unknown as { expression: ASTNode }).expression;
  const x = strip(e as Expression);
  if (x.kind !== NodeKind.AssignExpr || (x as unknown as { operator: string }).operator !== '=') return null;
  const a = x as unknown as { left: Expression; right: Expression };
  const k = literal(a.right);
  if (k === null || k < 0n || k > 127n || !isPureExpr(a.left)) return null;
  return [nodeText(a.left), k];
}

function sameBindings(n: BNode, f: Fact): boolean {
  if (!n.origin) return false;
  for (const name of usedNames(n.origin)) if (lookup(n.scope, name) !== lookup(f.scope, name)) return false;
  return true;
}

/** The outcome of test `n` the facts decide, or null. */
function decided(n: BNode, facts: Fact[]): boolean | null {
  if (n.kind !== 'test' || !n.pure || !n.origin) return null;
  for (const f of facts) if (f.truth !== undefined && f.key === n.key && sameBindings(n, f)) return f.truth;
  const eq = eqLiteral(n.origin);
  const lv = eq ? nodeText(eq[0]) : nodeText(n.origin);
  for (const f of facts) {
    if (f.lit === undefined || f.key !== lv || !sameBindings(n, f)) continue;
    return eq ? f.lit === eq[1] : f.lit !== 0n;
  }
  return null;
}

function factsKey(facts: Fact[]): string {
  return facts.map(f => `${f.key}=${f.truth ?? f.lit}`).sort().join('|');
}

/** The facts after taking edge `taken` of the related test `n`. */
function afterTest(n: BNode, taken: boolean, facts: Fact[]): Fact[] {
  if (!n.pure || !n.origin) return [];
  const out = facts.filter(f => !(f.truth !== undefined && f.key === n.key));
  out.push({ key: n.key, truth: taken, scope: n.scope, origin: n.origin });
  return out;
}

/** `ok` with the number of related node pairs, or a refusal with its reason. */
export interface ValidationResult { ok: boolean; reason: string; pairs: number }

function describe(n: BNode): string {
  switch (n.kind) {
    case 'work': case 'test': case 'dispatch': return `${n.kind} ${n.key.length > 120 ? n.key.slice(0, 117) + '...' : n.key}`;
    case 'external': return `external ${n.key}`;
    default: return n.kind;
  }
}

/** Compare two already-built graphs. */
export function compareBcfg(before: Bcfg, after: Bcfg): ValidationResult {
  const rb = resolver(before), ra = resolver(after);
  const seen = new Set<string>();
  const related = new Map<number, Set<number>>(); // after node -> before nodes
  const stack: [number, number, Fact[]][] = [[after.entry, before.entry, []]];

  for (const [name, id] of before.namedEntries) {
    const a = after.namedEntries.get(name);
    if (a === undefined) return { ok: false, reason: `entry ${name} lost`, pairs: 0 };
    stack.push([a, id, []]);
  }
  for (const name of after.namedEntries.keys()) {
    if (!before.namedEntries.has(name)) return { ok: false, reason: `entry ${name} added`, pairs: 0 };
  }

  let threaded = 0;
  while (stack.length) {
    const [a0, b0, facts] = stack.pop()!;
    const a = ra(a0), b = rb(b0);
    const k = a + ',' + b + (facts.length ? ';' + factsKey(facts) : '');
    if (seen.has(k)) continue;
    seen.add(k);
    const na = after.nodes[a], nb = before.nodes[b];
    if (na.kind !== nb.kind || na.key !== nb.key) {
      // A4: a test the candidate repeats where the original threaded past it.
      // The chain of decided tests is followed here, not through the stack: a cycle of
      // them is a loop that does nothing forever, which the original does not do.
      let cur = a, chain = new Set<number>();
      for (let v = decided(after.nodes[cur], facts); v !== null; v = decided(after.nodes[cur], facts)) {
        if (chain.has(cur)) return { ok: false, reason: `threaded tests spin at ${describe(after.nodes[cur])}`, pairs: 0 };
        chain.add(cur);
        cur = ra(v ? after.nodes[cur].t : after.nodes[cur].f);
      }
      if (cur !== a) {
        threaded++;
        stack.push([cur, b0, facts]);
        continue;
      }
      return { ok: false, reason: `${describe(nb)}  became  ${describe(na)}`, pairs: 0 };
    }
    let set = related.get(a);
    if (!set) { set = new Set(); related.set(a, set); }
    set.add(b);
    switch (na.kind) {
      case 'work': {
        const st = storeOf(na);
        stack.push([na.next, nb.next, st ? [{ key: st[0], lit: st[1], scope: na.scope, origin: na.origin! }] : []]);
        break;
      }
      case 'test':
        stack.push([na.t, nb.t, afterTest(na, true, facts)], [na.f, nb.f, afterTest(na, false, facts)]);
        break;
      case 'dispatch': {
        const ca = na.cases!, cb = nb.cases!;
        if (ca.size !== cb.size) return { ok: false, reason: `dispatch ${nb.key}: ${cb.size} cases became ${ca.size}`, pairs: 0 };
        for (const [v, tb] of cb) {
          const ta = ca.get(v);
          if (ta === undefined) return { ok: false, reason: `dispatch ${nb.key}: case ${v} lost`, pairs: 0 };
          stack.push([ta, tb, []]);
        }
        stack.push([na.dflt, nb.dflt, []]);
        break;
      }
      default:
        break;
    }
  }
  void threaded;

  // A1: a copy must see the same declarations the original saw.
  const declOf = (g: Bcfg, decl: object): number | undefined => g.declNodes.get(decl as never);
  for (const [a, bs] of related) {
    const na = after.nodes[a];
    if (!na.origin || (na.kind !== 'work' && na.kind !== 'test' && na.kind !== 'dispatch')) continue;
    const names = usedNames(na.origin);
    if (names.size === 0) continue;
    for (const b of bs) {
      const nb = before.nodes[b];
      if (na.scope === null && nb.scope === null) continue;
      for (const name of names) {
        const da = lookup(na.scope, name), db = lookup(nb.scope, name);
        if (da === db) continue;
        if (!da || !db) return { ok: false, reason: `scope: '${name}' in ${describe(na)} binds differently`, pairs: 0 };
        const ia = declOf(after, da), ib = declOf(before, db);
        if (ia === undefined || ib === undefined || !related.get(ra(ia))?.has(rb(ib))) {
          return { ok: false, reason: `scope: '${name}' in ${describe(na)} binds to another declaration`, pairs: 0 };
        }
      }
    }
  }
  return { ok: true, reason: '', pairs: seen.size };
}

/**
 * Is `after` an unfolding of `before`? Both are the statement list of the same region, and
 * `options` must be the same for both - in particular the whole-function goto counts, which
 * decide which labels are entry points.
 */
export function isUnfolding(before: Statement[], after: Statement[], options: BcfgOptions = {}): ValidationResult {
  let gb: Bcfg, ga: Bcfg;
  try {
    gb = buildBcfg(before, options);
  } catch (e) {
    if (e instanceof Unsupported) return { ok: false, reason: `before: ${e.message}`, pairs: 0 };
    throw e;
  }
  // Which labels are targeted from OUTSIDE the region is a fact about the original: the
  // gotos the whole function holds minus those the original region holds. A candidate that
  // removes one of the region's own gotos to a label must not make that label look
  // outside-targeted, so the after side sees outside + its own inside count.
  let afterOptions = options;
  if (options.externalGotoCounts) {
    const insideBefore = countGotoTargets(before), insideAfter = countGotoTargets(after);
    const adjusted = new Map<string, number>();
    for (const name of new Set([...options.externalGotoCounts.keys(), ...insideAfter.keys()])) {
      const outside = Math.max(0, (options.externalGotoCounts.get(name) ?? 0) - (insideBefore.get(name) ?? 0));
      adjusted.set(name, outside + (insideAfter.get(name) ?? 0));
    }
    afterOptions = { ...options, externalGotoCounts: adjusted };
  }
  try {
    ga = buildBcfg(after, afterOptions);
  } catch (e) {
    if (e instanceof Unsupported) return { ok: false, reason: `after: ${e.message}`, pairs: 0 };
    throw e;
  }
  return compareBcfg(gb, ga);
}
