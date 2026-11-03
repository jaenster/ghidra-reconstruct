/**
 * Keep the model's per-function facts at the generator's fact-script version.
 *
 * The daemon re-reads facts only for functions it re-decompiles. When the generator's
 * fact script changes (a new row, a fixed parser), every other function keeps the facts
 * of the old script for as long as nobody touches it: a function edited later gets the
 * new facts, an untouched one never does, and the tree drifts from a batch regen that
 * reads them all. A missing fact field cannot tell "the old script had no such row" from
 * "the new script found none", so the version is recorded beside the facts, in the
 * snapshot manifest the model is saved with, and a model whose facts were read with
 * another script (or an unknown one) reads every function's facts again before it emits.
 */
import type { GhidraConnection } from '@ghidra-mcp/reconstruct';
import {
  extractFunctionFacts,
  FACT_KEYS,
  FACT_SCRIPT_VERSION,
  FactsReadError,
  type FunctionFactStats,
} from '@ghidra-mcp/reconstruct/extract/function-facts';
import { normalizeEntry } from '@ghidra-mcp/reconstruct/extract/function-stamps';
import type { LiveSnapshotModel } from './snapshot-model.js';

export type FactExtractor = (
  client: GhidraConnection,
  functions: Parameters<typeof extractFunctionFacts>[1],
  options: Parameters<typeof extractFunctionFacts>[2],
) => Promise<FunctionFactStats>;

export interface FactRefresh {
  /** The script the model's facts were read with; null when unknown. */
  had: string | null;
  wanted: string;
  /** False when the model was already current and nothing was read. */
  refreshed: boolean;
  stats?: FunctionFactStats;
}

/**
 * Read every function's facts again when the model's fact-script version is not
 * `wanted`. Clears the old facts first, as a full extraction with an empty cache would
 * start, and stamps the manifest only after the read succeeded: a failure throws and
 * leaves the version unstamped, so the next start tries again rather than emitting a
 * model of mixed vintage. The caller saves the model and re-emits every unit.
 */
export async function ensureFactScriptVersion(
  model: LiveSnapshotModel,
  client: GhidraConnection,
  log: (m: string) => void,
  wanted: string = FACT_SCRIPT_VERSION,
  extract: FactExtractor = extractFunctionFacts,
): Promise<FactRefresh> {
  const had = model.manifest.provenance.factScriptVersion ?? null;
  if (had === wanted) return { had, wanted, refreshed: false };

  log(`facts: the model's were read with fact script ${had ?? 'unknown'}, the generator's is ${wanted}; ` +
    'reading every function\'s facts again before the first emission');
  const functions = model.primary.functions;
  for (const fn of functions) for (const key of FACT_KEYS) delete fn[key];
  const format = model.primary.programInfo?.format ?? '';
  const compareSites = process.env.GHIDRA_COMPARE_SITES !== '0' && /Portable Executable|\bPE\b/i.test(format);
  let stats: FunctionFactStats;
  try {
    stats = await extract(client, functions, { compareSites });
  } catch (e) {
    // The worker can be versions ahead of the model at start: a function removed in a
    // version not yet applied is no longer a function there. Its removal arrives with
    // that version, so it alone does not stop the start; any other failure does.
    if (!(e instanceof FactsReadError) || [...e.failed.values()].some(why => why !== 'not a function')) throw e;
    log(`facts: ${e.failed.size} function(s) of the model are not functions in the program any more ` +
      `(${[...e.failed.keys()].slice(0, 10).join(' ')}); their removal is in a version still to apply`);
    // The rest were read; the failure was raised after them. Read them again without the gone ones.
    const gone = new Set(e.failed.keys());
    const rest = functions.filter(f => !gone.has(normalizeEntry(f.address)));
    for (const fn of rest) for (const key of FACT_KEYS) delete fn[key];
    stats = await extract(client, rest, { compareSites });
  }
  model.manifest.provenance.factScriptVersion = wanted;
  model.primary.factScriptVersion = wanted;
  log(`facts: ${stats.extracted} of ${stats.candidates} candidate(s) read with fact script ${wanted}`);
  return { had, wanted, refreshed: true, stats };
}
