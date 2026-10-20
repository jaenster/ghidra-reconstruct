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
 * What is NOT proven, by design: anything that needs a value fact - a flag variable, a
 * re-evaluated condition, a deleted assignment the loop exit makes redundant. Those are
 * refused here; a pass that wants them needs a named lemma (section 3.1 of the design).
 */

import type { Statement } from '../../ast/nodes.js';
import { countGotoTargets } from './labels.js';
import {
  buildBcfg, lookup, resolver, usedNames, Unsupported,
  type Bcfg, type BcfgOptions, type BNode,
} from './bcfg.js';

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
  const stack: [number, number][] = [[after.entry, before.entry]];

  for (const [name, id] of before.namedEntries) {
    const a = after.namedEntries.get(name);
    if (a === undefined) return { ok: false, reason: `entry ${name} lost`, pairs: 0 };
    stack.push([a, id]);
  }
  for (const name of after.namedEntries.keys()) {
    if (!before.namedEntries.has(name)) return { ok: false, reason: `entry ${name} added`, pairs: 0 };
  }

  while (stack.length) {
    const [a0, b0] = stack.pop()!;
    const a = ra(a0), b = rb(b0);
    const k = a + ',' + b;
    if (seen.has(k)) continue;
    seen.add(k);
    let set = related.get(a);
    if (!set) { set = new Set(); related.set(a, set); }
    set.add(b);
    const na = after.nodes[a], nb = before.nodes[b];
    if (na.kind !== nb.kind || na.key !== nb.key) {
      return { ok: false, reason: `${describe(nb)}  became  ${describe(na)}`, pairs: 0 };
    }
    switch (na.kind) {
      case 'work':
        stack.push([na.next, nb.next]);
        break;
      case 'test':
        stack.push([na.t, nb.t], [na.f, nb.f]);
        break;
      case 'dispatch': {
        const ca = na.cases!, cb = nb.cases!;
        if (ca.size !== cb.size) return { ok: false, reason: `dispatch ${nb.key}: ${cb.size} cases became ${ca.size}`, pairs: 0 };
        for (const [v, tb] of cb) {
          const ta = ca.get(v);
          if (ta === undefined) return { ok: false, reason: `dispatch ${nb.key}: case ${v} lost`, pairs: 0 };
          stack.push([ta, tb]);
        }
        stack.push([na.dflt, nb.dflt]);
        break;
      }
      default:
        break;
    }
  }

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
