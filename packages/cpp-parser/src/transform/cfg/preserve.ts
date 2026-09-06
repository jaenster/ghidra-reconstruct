/**
 * The preservation check every span-deleting rewrite is measured against.
 *
 * A transform here is allowed to move code, duplicate it, drop a `goto`, drop a label,
 * fabricate a `return`, and delete anything the graph says is unreachable. It is not
 * allowed to make reachable work stop being reachable. That single invariant is what
 * "graph before, graph after, assert isomorphism modulo the intended edit" reduces to
 * when the intended edit is always control-flow scaffolding.
 *
 * Two things are compared, both over the CONTRACTED graph - the graph with scaffolding
 * squeezed out, so only work nodes and the synthetic entry/exit/external remain:
 *
 *   - every reachable work key must still be reachable, at least as many times.
 *     Catches an arm deleted outright.
 *   - every reachable work-to-work EDGE must still exist.
 *     Catches the subtler shape: a label reached BOTH by fallthrough and by `goto`,
 *     inlined at the goto site and then deleted, which leaves the counts intact and the
 *     fallthrough path silently gone.
 *
 * A rejection is not an error. It means "this rewrite is not provably safe here", and the
 * caller's answer is to leave the `goto` alone - which is the correct default when the
 * deliverable is a program that runs rather than a program that reads well.
 */

import type { Statement } from '../../ast/nodes.js';
import { buildCfg } from './build.js';
import type { BuildCfgOptions, Cfg } from './types.js';

const ENTRY_KEY = '^';
const EXIT_KEY = '$';
const EXTERNAL_KEY = '~';
const EDGE_SEP = ' => ';

export interface PreservationResult {
  ok: boolean;
  /** Work keys reachable before and not after, with how many copies went missing. */
  lostKeys: string[];
  /** `from => to` work edges reachable before and absent after. */
  lostEdges: string[];
}

interface Contracted {
  counts: Map<string, number>;
  edges: Set<string>;
}

/**
 * The key a node contributes to the contracted graph, or null when it is transparent.
 *
 * `visible` is the set of keys the BEFORE graph had. Anything the rewrite introduced -
 * the `bool found` a loop-to-break conversion needs, the flag assignment, a fabricated
 * `return;` - is not in it and is treated as scaffolding, because inserting a statement
 * on a path splits an edge that was there and must not read as a loss. Deletions are
 * measured against the before keys only, so making insertions transparent cannot hide
 * one.
 */
function synthKey(cfg: Cfg, id: number, visible: Set<string> | null): string | null {
  if (id === cfg.entry) return ENTRY_KEY;
  if (id === cfg.exit) return EXIT_KEY;
  if (id === cfg.external) return EXTERNAL_KEY;
  const key = cfg.nodes[id].key;
  if (key === null) return null;
  return visible === null || visible.has(key) ? key : null;
}

/**
 * Squeeze the scaffolding out: for each node, the set of key-bearing nodes reachable
 * from it without passing through another key-bearing node.
 *
 * Memoised, with nodes currently on the stack contributing nothing. A cycle made
 * entirely of scaffolding (`while (true) { goto L; L: ; }`) then under-reports, which
 * loses a would-be edge on BOTH sides of the comparison - never invents one on the
 * "after" side, so it can miss a defect but cannot manufacture a false rejection.
 */
function keyedSuccessors(cfg: Cfg, visible: Set<string> | null): (id: number) => number[] {
  const memo = new Map<number, number[]>();
  const onStack = new Set<number>();

  const walk = (id: number): number[] => {
    const hit = memo.get(id);
    if (hit) return hit;
    if (onStack.has(id)) return [];
    onStack.add(id);
    const out = new Set<number>();
    for (const s of cfg.nodes[id].succ) {
      if (synthKey(cfg, s, visible) !== null) out.add(s);
      else for (const t of walk(s)) out.add(t);
    }
    onStack.delete(id);
    const arr = [...out];
    memo.set(id, arr);
    return arr;
  };
  return walk;
}

function contract(cfg: Cfg, visible: Set<string> | null): Contracted {
  const reachable = new Set<number>();
  const stack = [cfg.entry, ...cfg.extraEntries];
  for (const s of stack) reachable.add(s);
  while (stack.length) {
    const id = stack.pop()!;
    for (const s of cfg.nodes[id].succ) {
      if (!reachable.has(s)) { reachable.add(s); stack.push(s); }
    }
  }

  const succOf = keyedSuccessors(cfg, visible);
  const counts = new Map<string, number>();
  const edges = new Set<string>();

  for (const id of reachable) {
    const from = synthKey(cfg, id, visible);
    if (from === null) continue;
    if (id !== cfg.entry && id !== cfg.exit && id !== cfg.external) {
      counts.set(from, (counts.get(from) ?? 0) + 1);
    }
    for (const s of succOf(id)) {
      const to = synthKey(cfg, s, visible);
      if (to !== null) edges.add(from + EDGE_SEP + to);
    }
  }
  return { counts, edges };
}

/**
 * Does `after` still reach everything `before` reached?
 *
 * `options` must be the same for both - in particular the whole-function goto counts,
 * which decide which labels are entry points.
 */
export function preservesReachableWork(
  before: Statement[],
  after: Statement[],
  options: BuildCfgOptions = {},
): PreservationResult {
  const a = contract(buildCfg(before, options), null);
  const b = contract(buildCfg(after, options), new Set(a.counts.keys()));

  const lostKeys: string[] = [];
  for (const [key, n] of a.counts) {
    const m = b.counts.get(key) ?? 0;
    if (m < n) lostKeys.push(`${key} (${n} -> ${m})`);
  }

  const lostEdges: string[] = [];
  for (const e of a.edges) {
    if (!b.edges.has(e)) lostEdges.push(e);
  }

  return { ok: lostKeys.length === 0 && lostEdges.length === 0, lostKeys, lostEdges };
}
