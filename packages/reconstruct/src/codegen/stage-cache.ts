/**
 * Values generation derives from its inputs, kept on disk between runs.
 *
 * A cached value is used only under the hash of exactly what it was computed from
 * plus the generator build that computed it: the same inputs through the same code
 * give the same value, and anything else is a miss that recomputes. Nothing is ever
 * invalidated by hand, because nothing is ever looked up by a key that could be
 * stale.
 *
 * The directory sits beside the extraction snapshot (or wherever
 * RECON_CODEGEN_CACHE_DIR points). No directory configured means no cache: every
 * value is computed, as it always was.
 */

import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';

let cacheDir: string | null = process.env.RECON_CODEGEN_CACHE_DIR || null;

/** Where cached values live for this process; null turns the cache off. */
export function configureStageCache(dir: string | null): void {
  cacheDir = dir;
}

export function stageCacheDir(): string | null {
  return cacheDir;
}

export function sha256(...parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(String(p.length));
    h.update(':');
    h.update(p);
  }
  return h.digest('hex');
}

let buildId: string | undefined;

/**
 * The generator build: a hash over every source or compiled file of the packages
 * generation runs (reconstruct, cpp-parser, shared), read from where this module
 * itself was loaded. A change to any of them is a different generator.
 */
export function generatorBuildId(): string {
  if (buildId) return buildId;
  const here = fileURLToPath(import.meta.url);
  const codeDir = nodePath.dirname(nodePath.dirname(here));       // <pkg>/src or <pkg>/dist
  const packagesDir = nodePath.dirname(nodePath.dirname(codeDir));  // packages/
  // The sources, whichever of the two this process runs: a coordinator under tsx and
  // its shards on the compiled build are one generator (the shards refuse a dist/
  // older than src/), and must read each other's entries.
  const flavour = nodeFs.existsSync(nodePath.join(packagesDir, 'reconstruct', 'src')) ? 'src' : 'dist';
  const h = createHash('sha256');
  for (const pkg of ['reconstruct', 'cpp-parser', 'shared']) {
    const root = nodePath.join(packagesDir, pkg, flavour);
    const files: string[] = [];
    const walk = (d: string): void => {
      let entries: nodeFs.Dirent[];
      try { entries = nodeFs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = nodePath.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p);
        } else if (/\.(ts|js|json)$/.test(e.name) && !/\.(test|d)\.(ts|js)$/.test(e.name)) {
          files.push(p);
        }
      }
    };
    walk(root);
    files.sort();
    for (const f of files) {
      h.update(nodePath.relative(packagesDir, f));
      h.update('\0');
      h.update(nodeFs.readFileSync(f));
      h.update('\0');
    }
  }
  buildId = h.digest('hex');
  return buildId;
}

function entryPath(name: string, inputHash: string): string | null {
  if (!cacheDir) return null;
  return nodePath.join(cacheDir, `${name}-${sha256(inputHash, generatorBuildId()).slice(0, 32)}.json`);
}

/** Atomic: a reader never sees half a file, and concurrent writers of one key write the same bytes. */
function writeAtomic(file: string, text: string): void {
  try {
    nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    nodeFs.writeFileSync(tmp, text, 'utf-8');
    nodeFs.renameSync(tmp, file);
  } catch {
    // A cache that cannot be written costs the next run its speed, nothing else.
  }
}

/**
 * The value `compute` returns for these inputs, read from disk when a run with the
 * same input hash and the same generator build already computed it. The value must
 * survive a JSON round trip unchanged: `encode`/`decode` convert one that does not
 * (Maps, Sets) to and from plain data.
 */
export function cachedValue<T, E = T>(
  name: string,
  inputHash: () => string,
  compute: () => T,
  codec: { encode: (v: T) => E; decode: (e: E) => T } = { encode: v => v as unknown as E, decode: e => e as unknown as T },
): T {
  const file = entryPath(name, cacheDir ? inputHash() : '');
  if (file) {
    try {
      return codec.decode(JSON.parse(nodeFs.readFileSync(file, 'utf-8')) as E);
    } catch {
      // Absent or unreadable: compute it.
    }
  }
  const value = compute();
  if (file) writeAtomic(file, JSON.stringify(codec.encode(value)));
  return value;
}

/**
 * A per-item store: one value per item hash (a function body, say), loaded once and
 * written back once. The item hash covers everything the value is computed from; the
 * generator build is part of the file name, so another build never reads these.
 */
export class ItemCache<V> {
  private entries: Map<string, V> | null = null;
  private dirty = false;
  constructor(private readonly name: string) {}

  private file(): string | null {
    if (!cacheDir) return null;
    return nodePath.join(cacheDir, `${this.name}-${generatorBuildId().slice(0, 32)}.json`);
  }

  private load(): Map<string, V> {
    if (this.entries) return this.entries;
    this.entries = new Map();
    const file = this.file();
    if (file) {
      try {
        const raw = JSON.parse(nodeFs.readFileSync(file, 'utf-8')) as Record<string, V>;
        for (const [k, v] of Object.entries(raw)) this.entries.set(k, v);
      } catch {
        // Nothing cached yet.
      }
    }
    return this.entries;
  }

  get(itemHash: string, compute: () => V): V {
    const entries = this.load();
    const hit = entries.get(itemHash);
    if (hit !== undefined) return hit;
    const value = compute();
    entries.set(itemHash, value);
    this.dirty = true;
    return value;
  }

  /**
   * Write the entries this run used back, and only those: an entry no input hashes to
   * any more is dropped, so the file tracks the snapshot instead of growing forever.
   * Only the main thread writes; generation shards are threads of the same process.
   */
  save(used: Iterable<string>): void {
    const file = this.file();
    const entries = this.entries;
    // Read back from disk next time: one run's entries are not kept in memory for the next.
    this.entries = null;
    const dirty = this.dirty;
    this.dirty = false;
    if (!file || !entries || !isMainThread) return;
    const keep: Record<string, V> = {};
    let n = 0;
    for (const k of new Set(used)) {
      const v = entries.get(k);
      if (v !== undefined) { keep[k] = v; n++; }
    }
    if (!dirty && n === entries.size) return;
    writeAtomic(file, JSON.stringify(keep));
  }
}
