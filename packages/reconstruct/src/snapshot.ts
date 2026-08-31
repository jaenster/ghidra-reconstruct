/**
 * Extraction snapshot — the offline half of the reconstruction pipeline.
 *
 * A full run is daemon -> extract -> analyze -> generateProject, and the first
 * three stages take ~20 minutes against the remote Ghidra. Codegen changes only
 * need the fourth. This module persists everything `generateProject` consumes at
 * the seam right after analysis, so a codegen-only run can start there and never
 * open a connection at all.
 *
 * WRITTEN AS A DIRECTORY OF NDJSON PARTS, not one JSON blob. The 1.14d Game.exe
 * extraction carries 14k decompiled function bodies; a single `JSON.stringify`
 * of that would build a several-hundred-megabyte string and flirt with V8's
 * ~512MB string cap. One object per line streams in both directions, costs a
 * constant amount of memory, and stays greppable.
 *
 * The snapshot records WHICH Ghidra it came from — the server's domain-file
 * version for the program (Game.exe was at version 641) and the worker's
 * modification number — because a snapshot that silently goes stale and keeps
 * emitting a tree from last week's Ghidra is worse than no snapshot at all.
 */

import { createReadStream, createWriteStream } from 'fs';
import { mkdir, readFile, writeFile, rm, stat } from 'fs/promises';
import { createInterface } from 'readline';
import { join } from 'path';
import { once } from 'events';

import type {
  AnalyzedDataSymbol,
  DetectedClass,
  ExtractedDataType,
  ExtractedFunction,
  ExtractedNamespace,
  ExtractedString,
  ProgramInfo,
} from './types.js';

/**
 * Bumped whenever the on-disk layout changes in a way that makes older
 * snapshots unreadable. A mismatch is a hard error, never a silent best-effort
 * load — a half-understood snapshot produces a subtly wrong tree.
 */
export const SNAPSHOT_FORMAT_VERSION = 1;

/** Default location, relative to the caller's projectDir. */
export const DEFAULT_SNAPSHOT_DIRNAME = join('.ghidra-mcp', 'codegen-snapshot');

/** Where the snapshot came from, and when. */
export interface SnapshotProvenance {
  /** ISO 8601, when the snapshot finished writing. */
  writtenAt: string;
  /** Ghidra project URL, e.g. "ghidra://ghidra.typeguru.nl:13100/Diablo2Lod". */
  projectPath: string;
  /** Program within it, e.g. "/windows/lod/1.14d/Game.exe". */
  programPath?: string;
  /**
   * The Ghidra Server domain-file version of that program — the number that
   * goes up every time someone checks in a change. 1.14d Game.exe was at 641.
   * Null when the lookup failed; `programVersionError` then says why.
   */
  programVersion: number | null;
  programVersionError?: string;
  /**
   * The worker's program modification number. Moves on ANY edit in the open
   * session, including ones not yet checked in, so it catches staleness that
   * `programVersion` alone would miss.
   */
  cacheVersion: number | null;
  cacheVersionError?: string;
  /** Binary identity as Ghidra reports it (name, format, image base, hashes). */
  programInfo: ProgramInfo;
}

/** Counts, so a load can be sanity-checked without reading every line. */
export interface SnapshotCounts {
  functions: number;
  dataTypes: number;
  globals: number;
  namespaces: number;
  classes: number;
  strings: number;
}

export interface SnapshotManifest {
  formatVersion: number;
  provenance: SnapshotProvenance;
  projectName: string;
  counts: SnapshotCounts;
}

/**
 * Everything `generateProject` and the result stats need. Deliberately NOT the
 * whole ExtractionResult — but `strings` ARE part of it: they carry the byte
 * content behind Ghidra's string labels, and the declaration closure defines
 * those labels from it. Keeping only the count is what left them declared and
 * undefined.
 */
export interface CodegenSnapshot {
  manifest: SnapshotManifest;
  functions: ExtractedFunction[];
  /** Post-exclusion, post-dedup — the exact array generateProject was handed. */
  dataTypes: ExtractedDataType[];
  globals: AnalyzedDataSymbol[];
  namespaces: ExtractedNamespace[];
  classes: DetectedClass[];
  /**
   * String literals with their addresses and content. The closure joins these
   * onto its declarations BY ADDRESS — never by label text, which Ghidra
   * truncates and mangles.
   */
  strings: ExtractedString[];
  /** analysis.staticPromotions, flattened from its Map. */
  staticPromotions: [string, string][];
  /** Warnings accumulated before codegen, so a reload reproduces them. */
  warnings: string[];
}

const MANIFEST = 'manifest.json';
const PARTS = {
  functions: 'functions.ndjson',
  dataTypes: 'dataTypes.ndjson',
  globals: 'globals.ndjson',
  namespaces: 'namespaces.ndjson',
  classes: 'classes.ndjson',
  strings: 'strings.ndjson',
} as const;
const SIDECAR = 'sidecar.json';

/** Stream an array out, one JSON object per line. */
export async function writeNdjson(path: string, rows: readonly unknown[]): Promise<void> {
  const out = createWriteStream(path, { encoding: 'utf8' });
  for (const row of rows) {
    if (!out.write(JSON.stringify(row) + '\n')) {
      await once(out, 'drain');
    }
  }
  out.end();
  await once(out, 'finish');
}

/** Stream an array back in. Blank lines are tolerated; anything else is fatal. */
export async function readNdjson<T>(path: string): Promise<T[]> {
  const rows: T[] = [];
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (line.length === 0) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch (e) {
      throw new Error(`${path}:${lineNo} is not valid JSON: ${(e as Error).message}`);
    }
  }
  return rows;
}

/**
 * Write the snapshot. Writes into a sibling `.tmp` directory and swaps it in at
 * the end, so an interrupted write never leaves a half-snapshot that a later
 * codegen-only run would happily consume.
 */
export async function writeSnapshot(dir: string, snapshot: CodegenSnapshot): Promise<void> {
  const staging = `${dir}.tmp`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  await writeNdjson(join(staging, PARTS.functions), snapshot.functions);
  await writeNdjson(join(staging, PARTS.dataTypes), snapshot.dataTypes);
  await writeNdjson(join(staging, PARTS.globals), snapshot.globals);
  await writeNdjson(join(staging, PARTS.namespaces), snapshot.namespaces);
  await writeNdjson(join(staging, PARTS.classes), snapshot.classes);
  await writeNdjson(join(staging, PARTS.strings), snapshot.strings);

  await writeFile(
    join(staging, SIDECAR),
    JSON.stringify({
      staticPromotions: snapshot.staticPromotions,
      warnings: snapshot.warnings,
    }),
    'utf8'
  );

  // Manifest last: its presence is what makes the directory a valid snapshot.
  await writeFile(join(staging, MANIFEST), JSON.stringify(snapshot.manifest, null, 2), 'utf8');

  await rm(dir, { recursive: true, force: true });
  const { rename } = await import('fs/promises');
  await rename(staging, dir);
}

export async function snapshotExists(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, MANIFEST));
    return true;
  } catch {
    return false;
  }
}

/** Read just the manifest — enough to report provenance or reject a stale one. */
export async function readSnapshotManifest(dir: string): Promise<SnapshotManifest> {
  let raw: string;
  try {
    raw = await readFile(join(dir, MANIFEST), 'utf8');
  } catch {
    throw new Error(
      `No extraction snapshot at ${dir}. Run once without codegen-only to create it.`
    );
  }
  const manifest = JSON.parse(raw) as SnapshotManifest;
  if (manifest.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      `Snapshot at ${dir} is format v${manifest.formatVersion}, this build reads ` +
      `v${SNAPSHOT_FORMAT_VERSION}. Re-run the full pipeline to rewrite it.`
    );
  }
  return manifest;
}

export async function readSnapshot(dir: string): Promise<CodegenSnapshot> {
  const manifest = await readSnapshotManifest(dir);

  const [functions, dataTypes, globals, namespaces, classes] = await Promise.all([
    readNdjson<ExtractedFunction>(join(dir, PARTS.functions)),
    readNdjson<ExtractedDataType>(join(dir, PARTS.dataTypes)),
    readNdjson<AnalyzedDataSymbol>(join(dir, PARTS.globals)),
    readNdjson<ExtractedNamespace>(join(dir, PARTS.namespaces)),
    readNdjson<DetectedClass>(join(dir, PARTS.classes)),
  ]);

  // The strings part arrived after the format did, so a snapshot written before
  // it simply has no such file. That is a snapshot with fewer definitions in the
  // tree it produces, not a corrupt one, and the closure report names every
  // symbol it costs — so it is read leniently rather than rejected, which would
  // force a 20-minute re-extraction for a file that is one page long.
  const strings = await readNdjson<ExtractedString>(join(dir, PARTS.strings)).catch(() => []);

  const sidecar = JSON.parse(await readFile(join(dir, SIDECAR), 'utf8')) as {
    staticPromotions: [string, string][];
    warnings: string[];
  };

  // A truncated part file is the failure mode that would quietly emit a smaller
  // tree, so check every count rather than trusting the directory.
  const actual: SnapshotCounts = {
    functions: functions.length,
    dataTypes: dataTypes.length,
    globals: globals.length,
    namespaces: namespaces.length,
    classes: classes.length,
    // Not `strings.length`: an older snapshot legitimately has none, and the
    // manifest count is what the extraction saw either way.
    strings: manifest.counts.strings,
  };
  for (const key of Object.keys(manifest.counts) as (keyof SnapshotCounts)[]) {
    if (actual[key] !== manifest.counts[key]) {
      throw new Error(
        `Snapshot at ${dir} is incomplete: manifest says ${manifest.counts[key]} ` +
        `${key} but ${actual[key]} were read. Re-run the full pipeline.`
      );
    }
  }

  return {
    manifest,
    functions,
    dataTypes,
    globals,
    namespaces,
    classes,
    strings,
    staticPromotions: sidecar.staticPromotions,
    warnings: sidecar.warnings,
  };
}

/**
 * Human-readable provenance banner. Codegen-only runs print this before doing
 * anything, so the tree can never be attributed to a Ghidra state it did not
 * come from.
 */
export function describeSnapshot(dir: string, manifest: SnapshotManifest, now = Date.now()): string {
  const p = manifest.provenance;
  const ageHours = (now - Date.parse(p.writtenAt)) / 3_600_000;
  const c = manifest.counts;
  const version = p.programVersion !== null
    ? `${p.programVersion}`
    : `unknown (${p.programVersionError ?? 'not recorded'})`;
  const cache = p.cacheVersion !== null ? `${p.cacheVersion}` : 'unknown';

  return [
    '='.repeat(60),
    'CODEGEN-ONLY — reusing an extraction snapshot; the daemon is NOT contacted',
    '='.repeat(60),
    `  snapshot:  ${dir}`,
    `  program:   ${p.projectPath}${p.programPath ?? ''}`,
    `  Ghidra version: ${version}   (worker modification number ${cache})`,
    `  written:   ${p.writtenAt}  (${formatAge(ageHours)} ago)`,
    `  contents:  ${c.functions} functions, ${c.dataTypes} types, ` +
      `${c.globals} globals, ${c.namespaces} namespaces, ${c.classes} classes`,
    '',
    '  The generated tree reflects Ghidra AS OF THAT MOMENT, not as of now.',
    '  Any renaming, retyping or re-analysis since then is absent from it.',
    '='.repeat(60),
  ].join('\n');
}

export function formatAge(hours: number): string {
  if (!Number.isFinite(hours)) return 'unknown time';
  if (hours < 1) return `${Math.max(0, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

export interface StalenessVerdict {
  ageHours: number;
  /** Worth shouting about, but the run continues. */
  warn: boolean;
  /** Too old to use without an explicit override. */
  refuse: boolean;
  message?: string;
}

/**
 * Age policy. Warn early, refuse eventually — a snapshot from last week rebuilt
 * into a "current" tree is exactly the silent-staleness failure this feature
 * must not introduce.
 */
export function assessStaleness(
  manifest: SnapshotManifest,
  opts: { warnAfterHours?: number; refuseAfterHours?: number; now?: number } = {}
): StalenessVerdict {
  const warnAfterHours = opts.warnAfterHours ?? 12;
  const refuseAfterHours = opts.refuseAfterHours ?? 24 * 7;
  const now = opts.now ?? Date.now();
  const written = Date.parse(manifest.provenance.writtenAt);

  if (!Number.isFinite(written)) {
    return {
      ageHours: NaN,
      warn: true,
      refuse: false,
      message: `Snapshot has an unreadable timestamp (${manifest.provenance.writtenAt}); age unknown.`,
    };
  }

  const ageHours = (now - written) / 3_600_000;
  if (ageHours >= refuseAfterHours) {
    return {
      ageHours,
      warn: true,
      refuse: true,
      message:
        `Snapshot is ${formatAge(ageHours)} old (limit ${formatAge(refuseAfterHours)}). ` +
        `Re-run the full pipeline, or set GHIDRA_SNAPSHOT_MAX_AGE_HOURS to override.`,
    };
  }
  if (ageHours >= warnAfterHours) {
    return {
      ageHours,
      warn: true,
      refuse: false,
      message: `Snapshot is ${formatAge(ageHours)} old — confirm Ghidra has not moved since.`,
    };
  }
  return { ageHours, warn: false, refuse: false };
}
