/**
 * struct-packing-mismatch: does the emitted C++ reproduce Ghidra's struct layout?
 *
 * This one is deliberately NOT answered from the AST. Computing a layout from parsed
 * declarations means re-implementing the compiler's rules - alignment, `#pragma pack`,
 * bit-field units, empty bases - and a re-implementation is a simulation, which is exactly
 * what failed before: the Python simulation could not judge 376 of 1023 structs and never
 * saw the emitter spell a one-byte bit-field unit as `int`. The COMPILER decides layout, so
 * the compiler is asked: one translation unit of `static_assert(sizeof)` / `offsetof` per
 * Ghidra struct, compiled `-fsyntax-only` against every header in the tree. What is read
 * back is the compiler's diagnostics, not C++.
 *
 * Without the cross compiler it falls back to the natural-alignment simulation over the
 * snapshot's own field list, and says so.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Check, Finding, LintContext } from '../context.js';
import type { SnapshotStruct } from '../snapshot.js';
import { SKIP_DIRS } from '../tree.js';

export const CXX = process.env.D2_LINT_CXX ?? 'i686-w64-mingw32-g++';

const BAD_IDENT = /^\s*$|[^A-Za-z_0-9]/;

/** The structs worth asserting, with Ghidra's size (null when Ghidra's size is its own artifact). */
export function assertableStructs(structs: SnapshotStruct[]): Array<{ name: string; size: number | null; fields: SnapshotStruct['fields'] }> {
  const out: Array<{ name: string; size: number | null; fields: SnapshotStruct['fields'] }> = [];
  for (const d of structs) {
    const { name, fields } = d;
    let size: number | null = d.size;
    if (!name || !(size > 0) || !fields?.length) continue;
    if (BAD_IDENT.test(name) || name.startsWith('_')) continue;
    // Compiler and CRT internals are not the program's structs and are not in the tree.
    if (/\/(compiler|visualstudio|crt|std|demangler)/i.test(d.category ?? '')) continue;
    // Ghidra records alignment 8 and pads past the last field; the compiler is right there.
    const named = fields.filter(f => typeof f.offset === 'number');
    if (d.alignment === 8 && named.length) {
      const last = named.reduce((a, b) => (b.offset! > a.offset! ? b : a));
      if (size > last.offset! + (last.size ?? 0)) size = null;
    }
    out.push({ name, size, fields });
  }
  return out;
}

function headersOf(root: string): string[] {
  const out: string[] = [];
  const rec = (dir: string) => {
    for (const e of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(e)) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) rec(p);
      else if (e.endsWith('.h')) out.push(relative(root, p).split('\\').join('/'));
    }
  };
  rec(root);
  return out;
}

function dirsOf(root: string): string[] {
  const out: string[] = [root];
  const rec = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (SKIP_DIRS.has(e)) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) { out.push(p); rec(p); }
    }
  };
  rec(root);
  return out;
}

export function compilerAvailable(): boolean {
  const r = spawnSync(CXX, ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

/** Compile the assert TU; SIZE/OFF failures by struct, or null without a compiler. */
export function compilerLayout(root: string, structs: SnapshotStruct[]):
    { sizeBad: string[]; offBad: string[]; uncheckable: string[] } | null {
  if (!compilerAvailable()) return null;
  const items = assertableStructs(structs);
  if (!items.length) return null;
  const dir = mkdtempSync(join(tmpdir(), 'defect-lint-layout-'));
  try {
    const lines: string[] = ['#include "d2_platform.h"'];
    for (const h of headersOf(root)) lines.push(`#include "${h}"`);
    lines.push('#include <cstddef>', '');
    for (const { name, size, fields } of items) {
      if (size !== null) lines.push(`static_assert(sizeof(${name}) == ${size}, "SIZE ${name}");`);
      for (const f of fields) {
        if (!f.name || typeof f.offset !== 'number' || BAD_IDENT.test(f.name)) continue;
        lines.push(`static_assert(offsetof(${name}, ${f.name}) == ${f.offset}, "OFF ${name}.${f.name}");`);
      }
    }
    const tu = join(dir, 'layout_check.cpp');
    writeFileSync(tu, lines.join('\n') + '\n');
    const rsp = join(dir, 'incdirs.rsp');
    writeFileSync(rsp, dirsOf(root).map(d => `-I${d}`).join('\n') + '\n');
    const r = spawnSync(CXX, ['-std=c++17', '-fsyntax-only', '-w', '-fms-extensions',
      '-include', 'd2_platform.h', `@${rsp}`, '-fmax-errors=0', tu],
      { encoding: 'utf8', cwd: root, maxBuffer: 256 * 1024 * 1024 });
    const text = (r.stdout ?? '') + (r.stderr ?? '');
    const sizeBad = [...text.matchAll(/static assertion failed: SIZE (\S+)/g)].map(m => m[1]);
    const offBad = [...text.matchAll(/static assertion failed: OFF (\S+)/g)].map(m => m[1]);
    const uncheckable = text.split('\n').filter(l => l.includes(' error:') &&
      !l.includes('static assertion failed') && !l.includes('address of bit-field'));
    return { sizeBad, offBad, uncheckable };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SIM_WIDTH: Record<string, number> = {
  char: 1, uint8_t: 1, byte: 1, int8_t: 1, undefined: 1, undefined1: 1, bool: 1,
  short: 2, ushort: 2, uint16_t: 2, int16_t: 2, wchar_t: 2, undefined2: 2,
  int: 4, uint: 4, uint32_t: 4, int32_t: 4, long: 4, ulong: 4, float: 4, DWORD: 4, BOOL: 4, undefined4: 4,
  uint64_t: 8, int64_t: 8, double: 8, undefined8: 8,
};

/** Natural-alignment simulation over Ghidra's field list - the fallback, and a weaker one. */
export function simulatedLayout(structs: SnapshotStruct[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of structs) {
    let off = 0;
    for (const f of d.fields ?? []) {
      const m = /^(.*?)\s*\[(\d+)\]$/.exec((f.dataType ?? '').trim());
      let t = (f.dataType ?? '').trim();
      let n = 1;
      if (m) { t = m[1].trim(); n = parseInt(m[2], 10); }
      let size: number, align: number;
      if (t.includes('*')) { size = 4 * n; align = 4; }
      else if (SIM_WIDTH[t] !== undefined) { size = SIM_WIDTH[t] * n; align = SIM_WIDTH[t]; }
      else break;
      off = Math.ceil(off / align) * align;
      if (typeof f.offset === 'number' && off !== f.offset) {
        out.set(d.name, `field '${f.name}': C puts it at 0x${off.toString(16)}, Ghidra says 0x${f.offset.toString(16)}`);
        break;
      }
      off += size;
    }
  }
  return out;
}

export const structPackingMismatch: Check = {
  id: 'struct-packing-mismatch',
  blurb: "Ghidra's field offsets are not what a C compiler will produce",
  run(ctx: LintContext) {
    const structs = ctx.snapshot?.structs ?? [];
    if (!structs.length) return [];
    const r = compilerLayout(ctx.tree.root, structs);
    const out: Finding[] = [];
    if (!r) {
      for (const [name, why] of simulatedLayout(structs)) {
        out.push({ check: this.id, subject: name, detail: `${why} (simulated - no cross compiler)` });
      }
      return out;
    }
    const seen = new Set<string>();
    for (const n of r.sizeBad) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push({ check: this.id, subject: n, detail: 'sizeof does not match Ghidra - array stride and every allocation are wrong' });
    }
    for (const n of r.offBad) {
      const s = n.split('.')[0];
      if (seen.has(s)) continue;
      seen.add(s);
      out.push({ check: this.id, subject: s, detail: `field '${n.split('.').slice(1).join('.')}' is not where Ghidra puts it` });
    }
    return out;
  },
};
