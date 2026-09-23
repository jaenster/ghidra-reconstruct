/**
 * The extraction snapshot the generator writes - Ghidra's own model, read without a server.
 *
 * Checks consult it for what the emitted text cannot say: a symbol's address, its modelled
 * size and the gap to the next symbol, and a struct's size. Records carrying
 * `platform: "mac"` are the Mac cross-check build merged in; they are never the Windows
 * program and are skipped - reading one as Windows data cost a wasted analysis once
 * (gpGfxColorRemapTables, a Mac-only symbol that looked like a 1-byte Windows global).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SnapshotGlobal {
  name: string;
  address: number;
  addressText: string;
  size: number;
  xrefCount: number;
  dataType: string;
}

export interface SnapshotStruct {
  name: string;
  size: number;
  alignment?: number;
  category?: string;
  fields: Array<{ name?: string; offset?: number; size?: number; dataType?: string }>;
}

export interface Snapshot {
  dir: string;
  /** Windows data symbols, sorted by address. */
  globals: SnapshotGlobal[];
  globalByName: Map<string, SnapshotGlobal>;
  /** Distance to the next symbol, by address. */
  gapAfter: Map<number, number | null>;
  structs: SnapshotStruct[];
  /** Struct/union/typedef size by name; null when the name is ambiguous. */
  typeSize: Map<string, number | null>;
}

export const DEFAULT_SNAPSHOT_DIR = join(
  process.env.HOME ?? '', 'code/ts/ghidra-reconstruct/project/.ghidra-mcp/codegen-snapshot',
);

function ndjson(path: string): any[] {
  if (!existsSync(path)) return [];
  const out: any[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line is not data */ }
  }
  return out;
}

export function loadSnapshot(dir: string = DEFAULT_SNAPSHOT_DIR): Snapshot | null {
  if (!existsSync(join(dir, 'globals.ndjson'))) return null;
  const globals: SnapshotGlobal[] = [];
  const all: number[] = [];
  for (const d of ndjson(join(dir, 'globals.ndjson'))) {
    if (!d.address) continue;
    const v = parseInt(String(d.address), 16);
    if (!Number.isFinite(v)) continue;
    all.push(v);
    if (d.platform === 'mac') continue;
    globals.push({
      name: String(d.name), address: v, addressText: String(d.address),
      size: Number(d.size) || 0, xrefCount: Number(d.xrefCount) || 0, dataType: String(d.dataType ?? ''),
    });
  }
  return buildSnapshot(dir, globals, ndjson(join(dir, 'dataTypes.ndjson')), all);
}

/**
 * Assemble a Snapshot from records. The gap table is built over EVERY address record, Mac
 * or not, exactly as the original triage did: the gap bounds how far a symbol can extend.
 */
export function buildSnapshot(dir: string, globals: SnapshotGlobal[], dataTypes: any[], allAddresses?: number[]): Snapshot {
  const sorted = [...globals].sort((a, b) => a.address - b.address);
  const globalByName = new Map<string, SnapshotGlobal>();
  for (const g of sorted) if (!globalByName.has(g.name)) globalByName.set(g.name, g);
  const addrs = [...new Set(allAddresses ?? sorted.map(g => g.address))].sort((a, b) => a - b);
  const gapAfter = new Map<number, number | null>();
  addrs.forEach((a, i) => gapAfter.set(a, i + 1 < addrs.length ? addrs[i + 1] - a : null));

  const structs: SnapshotStruct[] = [];
  const typeSize = new Map<string, number | null>();
  for (const d of dataTypes) {
    if (d.platform === 'mac') continue;
    const name = d.name;
    if (!name || typeof d.size !== 'number') continue;
    if (d.kind === 'STRUCTURE' || d.kind === 'UNION' || d.kind === 'TYPEDEF' || d.kind === 'ENUM') {
      const prev = typeSize.get(name);
      if (prev === undefined) typeSize.set(name, d.size > 0 ? d.size : null);
      else if (prev !== d.size) typeSize.set(name, null);
    }
    if (d.kind === 'STRUCTURE') {
      structs.push({ name, size: d.size, alignment: d.alignment, category: d.category, fields: d.fields ?? [] });
    }
  }
  return { dir, globals: sorted, globalByName, gapAfter, structs, typeSize };
}
