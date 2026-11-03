/**
 * The per-function fact cache: one NDJSON file per program, a header line and then one line
 * per function entry.
 *
 * An entry holds the facts (function-facts.ts) and what they were read from:
 *
 *   program     the program stamp at extraction
 *   self        the function's own stamp, taken before it was decompiled
 *   deps        id -> {full, shape} of every type its markup named, taken after
 *   textHash    Java String.hashCode and length of the decompile the facts belong to
 *
 * It is current when, in this order: the header's script version matches, the program
 * stamp matches, the function's stamp matches, every dependency's full stamp matches, and
 * the decompile the snapshot holds now hashes the same. The first failing check is the
 * reason it missed; `type-name` means only names moved (a rename) and `type-shape` that a
 * layout did. Anything the stamps cannot see is what `verify` is for.
 *
 * Location: GHIDRA_FACT_CACHE_DIR, else `project/.ghidra-mcp/fact-cache` under the working
 * directory. Writes go to a temporary file and are renamed into place.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BranchLayoutFacts } from './branch-layout.js';
import type { CallOrderFacts } from './call-order.js';
import type { AccessOrderFacts } from './access-order.js';
import type { HaltLineFacts } from './halt-lines.js';
import type { StringOpFacts } from './string-ops.js';
import type { JumpTableFacts } from './jump-tables.js';
import type { ZeroStoreFacts } from './zero-stores.js';
import type { MaskSiteFacts } from './mask-sites.js';
import type { ZextSiteFacts } from './zext-sites.js';
import type { LabelFlow } from '../types.js';
import type { TypeStamp, FunctionStamps } from './function-stamps.js';
import { javaStringHash } from './compare-sites.js';

export interface CachedFacts {
  compareSites?: string;
  branchLayout?: BranchLayoutFacts;
  callOrder?: CallOrderFacts;
  accessOrder?: AccessOrderFacts;
  haltLines?: HaltLineFacts;
  stringOps?: StringOpFacts;
  jumpTables?: JumpTableFacts;
  zeroStores?: ZeroStoreFacts;
  maskSites?: MaskSiteFacts;
  zextSites?: ZextSiteFacts;
  labelFlow?: Record<string, LabelFlow>;
}

export interface FactEntry {
  program: string;
  self: string;
  deps: Record<string, TypeStamp>;
  textHash: number;
  textLength: number;
  facts: CachedFacts;
}

export type MissReason = 'new' | 'program' | 'self' | 'type-shape' | 'type-name' | 'text';

interface Header { kind: 'fact-cache'; scriptVersion: string; program: string | null }

export function defaultFactCacheDir(): string {
  return process.env.GHIDRA_FACT_CACHE_DIR || path.join(process.cwd(), 'project', '.ghidra-mcp', 'fact-cache');
}

export class FactCache {
  readonly file: string;
  private entries = new Map<string, FactEntry>();
  private program: string | null = null;
  private dirty = false;

  /**
   * @param key       names the program, e.g. its repository path; one file per key
   * @param scriptVersion  FACT_SCRIPT_VERSION; a file written by other scripts loads empty
   */
  constructor(key: string, readonly scriptVersion: string, dir = defaultFactCacheDir()) {
    this.file = path.join(dir, `${key.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')}.ndjson`);
    this.load();
  }

  get size(): number { return this.entries.size; }

  get(entry: string): FactEntry | undefined { return this.entries.get(entry); }

  put(entry: string, value: FactEntry): void {
    this.entries.set(entry, value);
    this.dirty = true;
  }

  delete(entry: string): void {
    if (this.entries.delete(entry)) this.dirty = true;
  }

  clear(): void {
    if (this.entries.size > 0) this.dirty = true;
    this.entries.clear();
  }

  setProgram(program: string): void {
    if (this.program !== program) { this.program = program; this.dirty = true; }
  }

  /** Null when the entry is current against these stamps and this decompile text, else why not. */
  check(entry: string, text: string, stamps: FunctionStamps): MissReason | null {
    const e = this.entries.get(entry);
    if (!e) return 'new';
    if (!stamps.program || e.program !== stamps.program) return 'program';
    const self = stamps.self.get(entry);
    if (!self || self !== e.self) return 'self';
    let renamed = false;
    for (const [id, was] of Object.entries(e.deps)) {
      const now = stamps.types.get(id);
      if (!now || now.shape !== was.shape) return 'type-shape';
      if (now.full !== was.full) renamed = true;
    }
    if (renamed) return 'type-name';
    if (text.length !== e.textLength || javaStringHash(text) !== e.textHash) return 'text';
    return null;
  }

  /**
   * Entries whose dependencies include any of these type ids: what a journal event on a
   * type reaches, without asking Ghidra.
   */
  dependents(typeIds: Iterable<string>): string[] {
    const want = new Set(typeIds);
    const out: string[] = [];
    for (const [entry, e] of this.entries) if (Object.keys(e.deps).some(id => want.has(id))) out.push(entry);
    return out;
  }

  save(): void {
    if (!this.dirty) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const header: Header = { kind: 'fact-cache', scriptVersion: this.scriptVersion, program: this.program };
    const lines = [JSON.stringify(header)];
    for (const [entry, e] of this.entries) lines.push(JSON.stringify({ entry, ...e }));
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, lines.join('\n') + '\n');
    renameSync(tmp, this.file);
    this.dirty = false;
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const lines = readFileSync(this.file, 'utf8').split('\n');
    let header: Header | null = null;
    try { header = JSON.parse(lines[0]) as Header; } catch { return; }
    if (header?.kind !== 'fact-cache' || header.scriptVersion !== this.scriptVersion) return;
    this.program = header.program;
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      try {
        const { entry, ...e } = JSON.parse(lines[i]) as FactEntry & { entry: string };
        this.entries.set(entry, e);
      } catch {
        // A torn line is a miss, not a reason to drop the rest.
      }
    }
  }
}
