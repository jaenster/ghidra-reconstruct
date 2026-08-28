/**
 * On-disk cache for an ADDITIONAL source binary's extraction.
 *
 * The Diablo II reconstruction pulls a second Ghidra program — the Mac Mach-O —
 * purely as a cross-check oracle: it contributes `mac:` address anchors next to
 * the Windows ones, plus the handful of functions that exist only on Mac. That
 * extraction costs ~300s of a ~1080s run, and it re-does the identical work on
 * every regen: the Windows program moves several times a day (domain-file
 * version 643 and climbing) while the Mac program sits at version 5.
 *
 * So: persist the secondary extraction, keyed on the SECONDARY program's Ghidra
 * version, and replay it when that version has not moved.
 *
 * This mirrors ./snapshot.ts deliberately — same NDJSON-parts layout (a single
 * JSON.stringify of 11k function records would build a several-hundred-megabyte
 * string and flirt with V8's ~512MB cap), same stage-then-rename so an interrupt
 * cannot leave a half-cache behind, same "manifest written last" rule, and the
 * same hard-error stance on a format mismatch or a truncated part. Its NDJSON
 * and age helpers are imported rather than re-implemented.
 *
 * INVALIDATION IS EXACT, NOT BEST-EFFORT. A cache whose recorded program
 * version is not precisely the live one is a miss, full stop. A stale secondary
 * extraction would not crash anything — it would quietly emit a tree with last
 * month's Mac anchors, which is the one failure mode that makes this feature
 * worse than the 300s it saves.
 */

import { mkdir, readFile, writeFile, rm, rename } from 'fs/promises';
import { join } from 'path';

import { readNdjson, writeNdjson, formatAge } from './snapshot.js';
import type {
  AnalyzedDataSymbol,
  ExtractedDataType,
  ExtractedFunction,
  ExtractedNamespace,
  ProgramInfo,
} from './types.js';

/**
 * Bumped whenever the on-disk layout changes in a way that makes older caches
 * unreadable. A mismatch is a hard miss, never a silent best-effort load.
 */
export const SOURCE_CACHE_FORMAT_VERSION = 1;

/** Default location, relative to the caller's projectDir. */
export const DEFAULT_SOURCE_CACHE_DIRNAME = join('.ghidra-mcp', 'source-cache');

/** Where this cache came from, and when. */
export interface SourceCacheProvenance {
  /** ISO 8601, when the cache finished writing. */
  writtenAt: string;
  /** Ghidra project URL of the secondary source. */
  ghidra: string;
  /** Program within it, e.g. "/mac/intel/1.14d/DiabloII_macho". */
  programPath?: string;
  /**
   * The Ghidra Server domain-file version of that program. THE cache key: a
   * cache is used only when this is exactly the live value. Never null on a
   * written cache — a version lookup that failed means no cache is written at
   * all, because a cache that cannot be invalidated is a liability.
   */
  programVersion: number;
  /** Binary identity as Ghidra reports it. */
  programInfo: ProgramInfo;
}

/** Counts, so a truncated part is caught without trusting the directory. */
export interface SourceCacheCounts {
  functions: number;
  /** How many of those carry a decompiled body. */
  functionsWithBody: number;
  dataTypes: number;
  globals: number;
  namespaces: number;
}

export interface SourceCacheManifest {
  formatVersion: number;
  /** e.g. "mac" — the additionalSources entry this cache belongs to. */
  platform: string;
  provenance: SourceCacheProvenance;
  counts: SourceCacheCounts;
}

/**
 * Exactly the slice of an ExtractionResult that `mergeAdditionalSources`
 * consumes. `strings` are deliberately absent: nothing downstream of the merge
 * reads a secondary binary's strings, and they would bloat the cache for free.
 */
export interface CachedSourceExtraction {
  manifest: SourceCacheManifest;
  functions: ExtractedFunction[];
  dataTypes: ExtractedDataType[];
  globals: AnalyzedDataSymbol[];
  namespaces: ExtractedNamespace[];
}

const MANIFEST = 'manifest.json';
const PARTS = {
  functions: 'functions.ndjson',
  dataTypes: 'dataTypes.ndjson',
  globals: 'globals.ndjson',
  namespaces: 'namespaces.ndjson',
} as const;

/** One directory per platform, under the shared source-cache root. */
export function sourceCacheDir(baseDir: string, platform: string): string {
  return join(baseDir, platform.replace(/[^A-Za-z0-9_.-]/g, '_'));
}

export async function writeSourceCache(
  dir: string,
  cache: CachedSourceExtraction
): Promise<void> {
  const staging = `${dir}.tmp`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  await writeNdjson(join(staging, PARTS.functions), cache.functions);
  await writeNdjson(join(staging, PARTS.dataTypes), cache.dataTypes);
  await writeNdjson(join(staging, PARTS.globals), cache.globals);
  await writeNdjson(join(staging, PARTS.namespaces), cache.namespaces);

  // Manifest last: its presence is what makes the directory a valid cache.
  await writeFile(join(staging, MANIFEST), JSON.stringify(cache.manifest, null, 2), 'utf8');

  await rm(dir, { recursive: true, force: true });
  await rename(staging, dir);
}

/**
 * Read just the manifest. Returns null when there is simply no cache there;
 * THROWS when a cache exists but this build cannot trust it (unreadable JSON,
 * wrong format version) — those deserve a loud line in the log, not silence.
 */
export async function readSourceCacheManifest(dir: string): Promise<SourceCacheManifest | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, MANIFEST), 'utf8');
  } catch {
    return null;
  }
  const manifest = JSON.parse(raw) as SourceCacheManifest;
  if (manifest.formatVersion !== SOURCE_CACHE_FORMAT_VERSION) {
    throw new Error(
      `Source cache at ${dir} is format v${manifest.formatVersion}, this build reads ` +
      `v${SOURCE_CACHE_FORMAT_VERSION}. It will be re-extracted and rewritten.`
    );
  }
  return manifest;
}

export async function readSourceCache(dir: string): Promise<CachedSourceExtraction> {
  const manifest = await readSourceCacheManifest(dir);
  if (!manifest) throw new Error(`No source cache at ${dir}.`);

  const [functions, dataTypes, globals, namespaces] = await Promise.all([
    readNdjson<ExtractedFunction>(join(dir, PARTS.functions)),
    readNdjson<ExtractedDataType>(join(dir, PARTS.dataTypes)),
    readNdjson<AnalyzedDataSymbol>(join(dir, PARTS.globals)),
    readNdjson<ExtractedNamespace>(join(dir, PARTS.namespaces)),
  ]);

  // A truncated part is the failure that would quietly drop anchors, so verify
  // every count rather than trusting the directory listing.
  const actual: SourceCacheCounts = {
    functions: functions.length,
    functionsWithBody: functions.reduce((n, f) => (f.decompiled ? n + 1 : n), 0),
    dataTypes: dataTypes.length,
    globals: globals.length,
    namespaces: namespaces.length,
  };
  for (const key of Object.keys(manifest.counts) as (keyof SourceCacheCounts)[]) {
    if (actual[key] !== manifest.counts[key]) {
      throw new Error(
        `Source cache at ${dir} is incomplete: manifest says ${manifest.counts[key]} ` +
        `${key} but ${actual[key]} were read.`
      );
    }
  }

  return { manifest, functions, dataTypes, globals, namespaces };
}

export function countBodies(functions: readonly ExtractedFunction[]): number {
  return functions.reduce((n, f) => (f.decompiled ? n + 1 : n), 0);
}

/**
 * Is this cache usable for the program we are actually looking at?
 *
 * `liveVersion` is null when the version lookup failed. That is NOT a licence to
 * use the cache anyway — an unverifiable cache is treated exactly like a stale
 * one, because "probably still current" is how a wrong tree gets shipped.
 */
export function verifySourceCache(
  manifest: SourceCacheManifest,
  expect: { platform: string; programPath?: string; liveVersion: number | null }
): { ok: boolean; reason?: string } {
  if (expect.liveVersion === null) {
    return {
      ok: false,
      reason: 'could not read the live Ghidra version of the program — refusing to trust the cache',
    };
  }
  if (manifest.platform !== expect.platform) {
    return { ok: false, reason: `cache is for platform "${manifest.platform}", this source is "${expect.platform}"` };
  }
  if ((manifest.provenance.programPath ?? '') !== (expect.programPath ?? '')) {
    return {
      ok: false,
      reason:
        `cache is for program "${manifest.provenance.programPath ?? '(none)'}", ` +
        `this source is "${expect.programPath ?? '(none)'}"`,
    };
  }
  if (manifest.provenance.programVersion !== expect.liveVersion) {
    return {
      ok: false,
      reason:
        `Ghidra version moved ${manifest.provenance.programVersion} -> ${expect.liveVersion} ` +
        `since the cache was written`,
    };
  }
  return { ok: true };
}

/** Loud provenance banner. Printed BEFORE the cache is consumed, every time. */
export function describeSourceCacheHit(
  dir: string,
  manifest: SourceCacheManifest,
  now = Date.now()
): string {
  const p = manifest.provenance;
  const ageHours = (now - Date.parse(p.writtenAt)) / 3_600_000;
  const c = manifest.counts;
  return [
    '='.repeat(60),
    `${manifest.platform.toUpperCase()} SOURCE CACHE HIT — its extraction is replayed from disk`,
    '='.repeat(60),
    `  cache:     ${dir}`,
    `  program:   ${p.ghidra}${p.programPath ?? ''}`,
    `  Ghidra version: ${p.programVersion}   (matches the live program)`,
    `  written:   ${p.writtenAt}  (${formatAge(ageHours)} ago)`,
    `  contents:  ${c.functions} functions (${c.functionsWithBody} with bodies), ` +
      `${c.dataTypes} types, ${c.globals} globals, ${c.namespaces} namespaces`,
    '='.repeat(60),
  ].join('\n');
}

/** Loud miss line, always saying WHY, so a surprise 300s is never a mystery. */
export function describeSourceCacheMiss(dir: string, platform: string, reason: string): string {
  return `${platform} source cache MISS (${reason}) — extracting from Ghidra; cache dir ${dir}`;
}
