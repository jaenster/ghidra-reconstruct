/**
 * The live model, backed by the extraction snapshot on disk.
 *
 * The snapshot is NOT the raw extraction: it is written at the seam right after
 * analysis, so what it holds is post-merge, post-normalize, post-analysis — the
 * exact arrays `generateProject` was handed. That is what makes the live loop
 * possible at all. Patch a record in this model, write the snapshot back, replay
 * it through the codegen-only path, and the tree that comes out is byte-identical
 * to the one the batch run produced, because it went through the same code with
 * the same input. No second implementation of the pipeline exists to drift.
 *
 * The corollary is that a re-extracted record must be MERGED onto the one it
 * replaces, never substituted for it. A single-symbol re-extract asks Ghidra for
 * the Ghidra-side facts and gets exactly those back; everything the snapshot
 * carries that Ghidra was never asked for — the mac merge's cross-platform
 * anchor above all — exists only in the record already in hand.
 */

import { join, dirname } from 'node:path';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';

import {
  readSnapshot,
  writeSnapshot,
  type CodegenSnapshot,
  type SnapshotManifest,
  type AnalyzedDataSymbol,
  type DetectedClass,
  type ExtractedDataType,
  type ExtractedFunction,
  type ExtractedNamespace,
  type ExtractedString,
  type ReconstructionOptions,
} from '@ghidra-mcp/reconstruct';

import { buildIndices, type LiveModel, type ModelIndices } from './model.js';

/**
 * Everything `readSnapshot` returns, arranged so the incremental machinery in
 * `model.ts` can operate on it unchanged.
 *
 * `primary` is not a copy: its `functions`, `dataTypes`, `globals`, `strings`
 * and `namespaces` are THE SAME array objects the snapshot was read into, and
 * `saveSnapshotModel` writes those same arrays back out. An in-place patch is
 * therefore visible to both views at once, and there is no reconciliation step
 * that could forget one of them.
 */
export interface LiveSnapshotModel extends LiveModel {
  /** Detected classes. Not part of `ExtractionResult`, so it hangs off here. */
  classes: DetectedClass[];
  /** `analysis.staticPromotions`, flattened, exactly as the snapshot stores it. */
  staticPromotions: [string, string][];
  /** Warnings accumulated before codegen. Replayed so the run reproduces them. */
  warnings: string[];
  manifest: SnapshotManifest;
  /** Where this came from and where `saveSnapshotModel` writes it back. */
  snapshotDir: string;
}

/** Persisted next to the snapshot so a restart resumes at the right event. */
export interface LiveState {
  /**
   * Symbol hashes as of `seq`, so a restart resumes incrementally rather than
   * re-emitting everything. Written in the same atomic file as `seq`: the two
   * describe one moment or neither is used.
   */
  hashCache?: unknown | null;
  /**
   * Fingerprint of the generator build that produced the cached output. Reusing a
   * unit emitted by a different build yields a tree that is half one generator
   * version and half another.
   */
  buildId?: string | null;
  /** Highest change-event sequence folded into the snapshot on disk. */
  seq: number;
  /** Which program the seq counts against — a seq is meaningless without it. */
  programPath: string;
  updatedAt: string;
}

const STATE_FILE = 'live-state.json';

/**
 * Read the seq the snapshot was last written at.
 *
 * Missing means "never ran": seq 0, which asks the daemon for the whole journal
 * and is the correct conservative answer. A seq recorded against a DIFFERENT
 * program is worse than none — sequence numbers are per-program, so replaying
 * one program's number against another silently skips real changes — so it is
 * discarded rather than trusted.
 */
export async function loadLiveState(
  snapshotDir: string,
  programPath: string,
): Promise<LiveState> {
  const path = stateFilePath(snapshotDir);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<LiveState>;
    if (typeof parsed.seq !== 'number' || !Number.isFinite(parsed.seq)) {
      return freshState(programPath);
    }
    if (parsed.programPath && parsed.programPath !== programPath) {
      return freshState(programPath);
    }
    return {
      seq: parsed.seq,
      programPath,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      // Carried so a restart resumes incrementally instead of cold-starting into
      // a full re-emit. It is written in the SAME atomic file as the seq, so the
      // two can never disagree about which moment they describe.
      hashCache: parsed.hashCache ?? null,
      buildId: parsed.buildId ?? null,
    };
  } catch {
    return freshState(programPath);
  }
}

/**
 * Record the seq, atomically.
 *
 * Written through a temp file and renamed: a torn state file read back as a
 * lower seq would replay events already applied, and read back as a higher one
 * would skip events never applied. Both produce a tree that does not correspond
 * to any Ghidra state, and neither announces itself.
 */
export async function saveLiveState(snapshotDir: string, state: LiveState): Promise<void> {
  const path = stateFilePath(snapshotDir);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  await rm(path, { force: true });
  await rename(tmp, path);
}

function stateFilePath(snapshotDir: string): string {
  // Beside the snapshot directory rather than inside it: `writeSnapshot` swaps
  // the whole directory out by rename, so anything within it is destroyed on
  // every save.
  return join(dirname(snapshotDir), STATE_FILE);
}

function freshState(programPath: string): LiveState {
  return { seq: 0, programPath, updatedAt: new Date().toISOString() };
}

/**
 * Load the snapshot into a live model.
 *
 * `options` are the extraction options the live re-extracts must run under.
 * They are supplied by the caller rather than read from the snapshot, because
 * the snapshot records what was extracted, not how to extract it again.
 */
export async function loadSnapshotModel(
  snapshotDir: string,
  options: ReconstructionOptions,
  seq: number,
): Promise<LiveSnapshotModel> {
  const snapshot = await readSnapshot(snapshotDir);

  return {
    primary: {
      functions: snapshot.functions,
      dataTypes: snapshot.dataTypes,
      globals: snapshot.globals,
      strings: snapshot.strings,
      namespaces: snapshot.namespaces,
      programInfo: snapshot.manifest.provenance.programInfo,
    },
    // The mac build is already merged INTO `primary` in a snapshot — the merge
    // ran before the snapshot was taken. There is no separate secondary to hold
    // here, and re-running the merge would double every mac-only function.
    secondary: null,
    options,
    seq,
    classes: snapshot.classes,
    staticPromotions: snapshot.staticPromotions,
    warnings: snapshot.warnings,
    manifest: snapshot.manifest,
    snapshotDir,
  };
}

/**
 * Write the model back over the snapshot it came from.
 *
 * The manifest counts are recomputed here: `readSnapshot` verifies every count
 * against the parts it read and refuses a mismatch, so writing the ORIGINAL
 * counts after a patch that added or removed a record would make the very next
 * load fail — and fail with "re-run the full pipeline", which costs 20 minutes
 * to discover was a bookkeeping bug.
 */
export async function saveSnapshotModel(model: LiveSnapshotModel): Promise<void> {
  const snapshot: CodegenSnapshot = {
    manifest: {
      ...model.manifest,
      counts: {
        functions: model.primary.functions.length,
        dataTypes: model.primary.dataTypes.length,
        globals: model.primary.globals.length,
        namespaces: model.primary.namespaces.length,
        classes: model.classes.length,
        strings: model.primary.strings.length,
      },
    },
    functions: model.primary.functions,
    dataTypes: model.primary.dataTypes,
    globals: model.primary.globals,
    namespaces: model.primary.namespaces,
    classes: model.classes,
    strings: model.primary.strings,
    staticPromotions: model.staticPromotions,
    warnings: model.warnings,
  };
  await writeSnapshot(model.snapshotDir, snapshot);
}

/** Indices over the live model. The shapes line up, so `model.ts` builds them. */
export function indexSnapshotModel(model: LiveSnapshotModel): ModelIndices {
  return buildIndices(model);
}

/**
 * Fields on `ExtractedFunction` that a single-symbol re-extract CANNOT produce.
 *
 * `get_function_info` answers with what Ghidra knows about one function. It does
 * not know about the mac merge, the platform guard the merge attached, the call
 * graph the analysis built, or the exclusion closure. Every one of those is
 * computed by a whole-program pass in the batch pipeline and lives only in the
 * record already in the snapshot.
 *
 * `crossPlatformAddress` is the sharp one. It is the mac<->windows anchor, set
 * by `mergeSecondaryPure`, and it is what puts the `mac:` cross-reference into
 * the emitted comment. Dropping it produces a tree that compiles identically,
 * differs from the oracle in exactly one line of one file, and gives no hint
 * that a whole class of anchors is at risk. It is silent, and it is why this
 * list is a list rather than a spread.
 */
const FUNCTION_CARRY_FORWARD = [
  'crossPlatformAddress',
  'platform',
  'ifdef',
  'calledFunctions',
  'callers',
  'sourceFile',
  'sourceLine',
  'isLibrary',
  'libraryMapping',
  'thunkTarget',
  'excludedNamespaceReachable',
] as const satisfies readonly (keyof ExtractedFunction)[];

/**
 * Fields on a global that only the whole-binary scope analysis produces.
 *
 * `analyzeDataSymbols` derives scope, ownership and promotion for every symbol
 * at once — its per-symbol helpers are not reachable from here — so a re-listed
 * global arrives with the Ghidra facts and none of the analysis.
 */
const GLOBAL_CARRY_FORWARD = [
  'scope',
  'suggestedName',
  'suggestedType',
  'ownerFunction',
  'ownerFile',
  'ownerStructType',
  'ownerStructHeader',
  'platform',
  'ifdef',
] as const satisfies readonly (keyof AnalyzedDataSymbol)[];

/**
 * Merge `fresh` onto `existing`, keeping every carried-forward field the fresh
 * record does not itself supply.
 *
 * Two rules, both learned the expensive way:
 *  - an explicitly-`undefined` key must not overwrite a real value. Ghidra
 *    answers `namespace: undefined` for a global-namespace function, and a plain
 *    spread would move that function to the root of the emitted tree.
 *  - a carried field is only taken from `fresh` when `fresh` actually has one.
 */
function mergeCarryingForward<T extends object>(
  existing: T,
  fresh: Partial<T>,
  carry: readonly (keyof T)[],
): T {
  const merged = { ...existing } as Record<string, unknown>;
  for (const [key, value] of Object.entries(fresh)) {
    if (value !== undefined) merged[key] = value;
  }
  for (const key of carry) {
    if ((fresh as Record<string, unknown>)[key as string] === undefined) {
      merged[key as string] = (existing as Record<string, unknown>)[key as string];
    }
  }
  return merged as T;
}

/**
 * Replace one function in place.
 *
 * IN PLACE is not a micro-optimisation: the array order reaches the emitted
 * tree. Functions are grouped into files and ordered within them by their
 * position here, so an append-and-remove that changed the order would rewrite
 * hundreds of files for a one-symbol edit and drown the real diff.
 *
 * Returns the merged record, or null when the address is not in the model.
 */
export function patchFunction(
  model: LiveSnapshotModel,
  indices: ModelIndices,
  address: string,
  fresh: Partial<ExtractedFunction>,
): ExtractedFunction | null {
  const key = addressKey(address);
  const existing = indices.fnByAddr.get(key);
  if (!existing) return null;

  const merged = mergeCarryingForward(existing, fresh, FUNCTION_CARRY_FORWARD);
  const slot = model.primary.functions.indexOf(existing);
  if (slot < 0) return null;
  model.primary.functions[slot] = merged;
  indices.fnByAddr.set(addressKey(merged.address), merged);
  indices.bodyTokens.set(addressKey(merged.address), tokenize(merged.decompiled));
  return merged;
}

/** Replace one global in place, keeping the scope analysis that Ghidra cannot resupply. */
export function patchGlobal(
  model: LiveSnapshotModel,
  indices: ModelIndices,
  address: string,
  fresh: Partial<AnalyzedDataSymbol>,
): AnalyzedDataSymbol | null {
  const key = addressKey(address);
  const existing = indices.globalByAddr.get(key);
  if (!existing) return null;

  const merged = mergeCarryingForward(existing, fresh, GLOBAL_CARRY_FORWARD);
  const slot = model.primary.globals.indexOf(existing);
  if (slot < 0) return null;
  model.primary.globals[slot] = merged;
  indices.globalByAddr.set(addressKey(merged.address), merged);
  return merged;
}

/**
 * Replace one data type in place.
 *
 * A type carries no whole-program analysis, so this is a straight replacement —
 * but it still goes through the slot rather than a push, because codegen groups
 * types by category and ownership and reads this array in order when two
 * categories both claim a name.
 */
export function patchDataType(
  model: LiveSnapshotModel,
  indices: ModelIndices,
  name: string,
  category: string | undefined,
  fresh: ExtractedDataType,
): ExtractedDataType | null {
  const existing = model.primary.dataTypes.find(
    dt => dt.name === name && (category === undefined || dt.category === category),
  );
  if (!existing) return null;
  const slot = model.primary.dataTypes.indexOf(existing);
  model.primary.dataTypes[slot] = fresh;
  indices.dtByKey.delete(dataTypeKey(existing.name, existing.category));
  indices.dtByKey.set(dataTypeKey(fresh.name, fresh.category), fresh);
  return fresh;
}

/** Model sizes, for `status` and for a sanity check after a batch. */
export interface ModelCounts {
  functions: number;
  dataTypes: number;
  globals: number;
  namespaces: number;
  classes: number;
  strings: number;
}

export function countModel(model: LiveSnapshotModel): ModelCounts {
  return {
    functions: model.primary.functions.length,
    dataTypes: model.primary.dataTypes.length,
    globals: model.primary.globals.length,
    namespaces: model.primary.namespaces.length,
    classes: model.classes.length,
    strings: model.primary.strings.length,
  };
}

/**
 * The hex tail of a Ghidra address, matching `model.ts`'s keying exactly.
 *
 * Duplicated rather than exported from there because the two modules must agree
 * on it forever: an index built with one spelling and looked up with the other
 * silently misses every symbol, and reports "not in the model" for symbols that
 * plainly are.
 */
function addressKey(address: string): string {
  const bare = address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
  return bare.replace(/^0x/i, '').toLowerCase();
}

const DT_SEP = '\u0000';

function dataTypeKey(name: string, category: string | undefined): string {
  return `${name}${DT_SEP}${category ?? ''}`;
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

function tokenize(body: string | undefined): Set<string> {
  const tokens = new Set<string>();
  if (!body) return tokens;
  for (const match of body.matchAll(IDENTIFIER)) tokens.add(match[0]);
  return tokens;
}

export type {
  ExtractedFunction,
  ExtractedDataType,
  ExtractedNamespace,
  ExtractedString,
  AnalyzedDataSymbol,
  DetectedClass,
  SnapshotManifest,
};
