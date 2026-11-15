/**
 * The ratchet store: one JSON record per function address, committed on `source/modified`
 * beside the VC8 evidence that justifies it.
 *
 *   <store>/fn/<address>.json   a record, kind `match` (advanced only by a measurement) or
 *                               `pin` (a hand-edited body, written deliberately)
 *   <store>/release.tsv         addresses whose generated body goes through anyway
 *
 * A record holds the body text exactly as it was emitted (or hand-edited), the scope it was
 * printed in, its parameters, and the binding of every reference site, so it can be printed
 * again under names that have changed since.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Binding } from './refs.js';

export type RecordKind = 'match' | 'pin';

export interface StoredBody {
  address: string;
  /** Qualified name when captured. */
  name: string;
  /** Tree-relative file when captured. */
  file: string;
  /** The scope the body was printed in (namespaces plus the declarator's qualifier). */
  scope: string[];
  /** The whole definition, signature and body, as emitted. */
  text: string;
  params: string[];
  /** Ghidra's storage of each parameter when captured, if the tree's maps carried it (params.ts). */
  paramStorage?: string[];
  /** Parameter and return type spellings of the definition when captured. */
  paramTypes?: string[];
  ret?: string;
  siteHash: string;
  /** [site index, binding] for every bound site. */
  bindings: Array<[number, Binding]>;
}

export interface RatchetRecord {
  address: string;
  kind: RecordKind;
  /** match: the evidence commit that measured MATCH; pin: the commit the body was taken from. */
  evidence: string;
  captured: string;
  /** The decompile hash (vc8form `dh`) of the root when captured, if the tree's map had one. */
  dh?: string;
  /** Free text: why a pin exists, what retires it. */
  note?: string;
  /** The root first, then the file-static callees whose code shape its match depends on. */
  members: StoredBody[];
}

export interface Release {
  address: string;
  reason: string;
  /**
   * The body the release is for (`bodyHash` of its definition): the generated body goes through
   * only while it is that one. A release without it lets any generated body through.
   */
  body?: string;
}

/** The identity of a definition's exact text, as a release names it. */
export function bodyHash(definition: string): string {
  return createHash('sha256').update(definition).digest('hex').slice(0, 16);
}

const BODY_COLUMN = /^body=([0-9a-f]{16})$/u;

export class RatchetStore {
  constructor(readonly dir: string) {}

  static open(dir: string | undefined): RatchetStore | undefined {
    if (!dir) return undefined;
    return fs.existsSync(dir) ? new RatchetStore(dir) : undefined;
  }

  private fnDir(): string { return path.join(this.dir, 'fn'); }

  recordPath(address: string): string { return path.join(this.fnDir(), `${address}.json`); }

  list(): RatchetRecord[] {
    let names: string[];
    try { names = fs.readdirSync(this.fnDir()); } catch { return []; }
    return names.filter(n => n.endsWith('.json')).sort().map(n => JSON.parse(fs.readFileSync(path.join(this.fnDir(), n), 'utf-8')) as RatchetRecord);
  }

  get(address: string): RatchetRecord | undefined {
    try { return JSON.parse(fs.readFileSync(this.recordPath(address), 'utf-8')) as RatchetRecord; } catch { return undefined; }
  }

  put(r: RatchetRecord): void {
    fs.mkdirSync(this.fnDir(), { recursive: true });
    fs.writeFileSync(this.recordPath(r.address), `${JSON.stringify(r, null, 1)}\n`, 'utf-8');
  }

  remove(address: string): boolean {
    try { fs.unlinkSync(this.recordPath(address)); return true; } catch { return false; }
  }

  releases(): Release[] {
    let text: string;
    try { text = fs.readFileSync(path.join(this.dir, 'release.tsv'), 'utf-8'); } catch { return []; }
    const out: Release[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const [address, ...rest] = line.split('\t');
      const body = rest.length > 1 ? BODY_COLUMN.exec(rest[rest.length - 1])?.[1] : undefined;
      if (body) rest.pop();
      out.push({ address: normalizeAddress(address), reason: rest.join('\t'), ...(body ? { body } : {}) });
    }
    return out;
  }

  writeReleases(rows: Release[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const body = rows.map(r => `${r.address}\t${r.reason}${r.body ? `\tbody=${r.body}` : ''}`).join('\n');
    fs.writeFileSync(path.join(this.dir, 'release.tsv'),
      `# address\treason[\tbody=<hash>] - the generated body (that one, when a hash is given) goes through; the next measurement decides (docs/ratchet.md)\n${body}${body ? '\n' : ''}`, 'utf-8');
  }
}

export function normalizeAddress(a: string): string {
  return a.trim().toLowerCase().replace(/^0x/u, '').padStart(8, '0');
}
