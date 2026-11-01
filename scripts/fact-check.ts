#!/usr/bin/env npx tsx
/**
 * Check the instruction facts a real extraction wrote against what the public Ghidra
 * database shows for three known functions per fact (get_disassembly, get_switch_table on
 * the redivivus MCP, program version 1783). Read-only: it reads a codegen snapshot and
 * nothing else.
 *
 *   npx tsx scripts/fact-check.ts [snapshot-dir]
 *
 * Default snapshot: $GHIDRA_SNAPSHOT_DIR, else project/.ghidra-mcp/codegen-snapshot. Exits 1
 * when a fact is missing or differs; a function the program no longer has is reported, not
 * failed.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

interface Expect {
  address: string;
  name: string;
  check: (f: Record<string, any>) => string | null;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const EXPECT: Expect[] = [
  // haltLines: the line each way into the shared halt pushes.
  {
    address: '00524930', name: 'STRTABLE_GetStringByIndex',
    check: f => {
      const p = f.haltLines?.halts?.[0]?.paths;
      return p && sameJson(p.map((x: any) => [x.line, x.guard]), [[0x102, 0x28], [0x106, 0x59], [0x107, 0x67], [0x109, 0x74]])
        ? null : `haltLines ${JSON.stringify(p)}`;
    },
  },
  {
    address: '00540320', name: 'PARTY_AddUnitToParty',
    check: f => {
      const lines = new Set((f.haltLines?.halts ?? []).flatMap((h: any) => h.paths.map((x: any) => x.line)));
      return [0xd2, 0xfe, 0xff, 0x109].every(l => lines.has(l)) ? null : `haltLines lines ${[...lines]}`;
    },
  },
  {
    address: '0040a080', name: 'Alloc',
    check: f => {
      const lines = new Set((f.haltLines?.halts ?? []).flatMap((h: any) => h.paths.map((x: any) => x.line)));
      return lines.has(0x4f3) ? null : `haltLines lines ${[...lines]}`;
    },
  },
  // jumpTables: cmp ecx, 5; ja 00620574; jmp [ecx*4 + 0062057c], six entries, the last at the fallback.
  {
    address: '00620510', name: 'GetUnitSizeX',
    check: f => {
      const t = f.jumpTables?.find((x: any) => x.at === 0x11);
      if (!t) return `no table at 0x11: ${JSON.stringify(f.jumpTables)}`;
      if (t.fallback !== 0x64 || t.bound !== 5) return `fallback/bound ${t.fallback}/${t.bound}`;
      const targets = t.entries.map((e: any) => e.target);
      if (!sameJson(targets, [0x18, 0x21, 0x35, 0x4d, 0x44, 0x64])) return `targets ${targets}`;
      if (t.labelled && !sameJson(t.entries.map((e: any) => e.value), [0, 1, 2, 3, 4, 5])) return `values ${t.entries.map((e: any) => e.value)}`;
      return t.labelled ? null : 'not labelled: jump-table-case leaves every switch';
    },
  },
  // lea eax, [ecx-1]; cmp eax, 0x6c; ja; movzx eax, byte [eax + index]; jmp [eax*4 + table]: levels 1..109.
  {
    address: '006426a0', name: 'LEVEL_CheckIfLevelIsTown',
    check: f => {
      const t = f.jumpTables?.find((x: any) => x.at === 0xf);
      if (!t) return `no table at 0xf: ${JSON.stringify(f.jumpTables)?.slice(0, 200)}`;
      if (t.fallback !== 0x1c || t.bound !== 0x6c || t.entries.length !== 109) return `fallback/bound/entries ${t.fallback}/${t.bound}/${t.entries.length}`;
      if (!t.labelled) return 'not labelled';
      const towns = t.entries.filter((e: any) => e.target === 0x16).map((e: any) => e.value);
      return sameJson(towns, [1, 40, 75, 103, 109]) ? null : `town cases ${towns}`;
    },
  },
  {
    address: '0065ce40', name: 'ITEMMOD_ScaleValueForStatType',
    check: f => {
      const t = f.jumpTables?.find((x: any) => x.at === 0x11);
      if (!t) return `no table at 0x11: ${JSON.stringify(f.jumpTables)?.slice(0, 200)}`;
      return t.fallback === 0x1b && t.bound === 0xd3 && t.entries.length === 0xd4 ? null : `fallback/bound/entries ${t.fallback}/${t.bound}/${t.entries.length}`;
    },
  },
  // zeroStores: what the opening stores write, relative to the local.
  {
    address: '006b7f70', name: 'ClearScreen',
    check: f => {
      const z = f.zeroStores?.find((x: any) => x.name === 'nViewportLeft');
      return z && z.offset === -0x14 && z.size === 16 && sameJson(z.zero, [[0, 8]]) && sameJson(z.other, [[8, 16]])
        ? null : `zeroStores ${JSON.stringify(f.zeroStores)}`;
    },
  },
  {
    // VC8 itself dropped the zero store to pControl (offset 0), which `mov [ebp-0x20], ecx` overwrites.
    address: '00500b50', name: 'D2WINBUTTON_HandleMouseWheel',
    check: f => {
      const z = f.zeroStores?.find((x: any) => x.name === 'sMsg');
      return z && z.offset === -0x24 && z.size === 32 && sameJson(z.zero, [[4, 32]]) && sameJson(z.other, [[0, 4]])
        ? null : `zeroStores ${JSON.stringify(f.zeroStores)}`;
    },
  },
  {
    address: '00404210', name: 'FILETOOLS_StartApplicationWithCommandLine_UTF8',
    check: f => {
      const z = f.zeroStores?.find((x: any) => x.name === 'processInfo');
      return z && z.offset === -0x10818 && z.size === 16 && sameJson(z.zero, [[0, 16]]) && sameJson(z.other, [])
        ? null : `zeroStores ${JSON.stringify(f.zeroStores)}`;
    },
  },
  // maskSites: movzx ecx, cx at 0067bbd9 and movzx edx, dx at 0067bbdc print as `& 0xffff`.
  {
    address: '0067bbc0', name: 'DRLGPATH_GetDirectionLookupFromPacked',
    check: f => sameJson(f.maskSites, { count: 2, sites: [
      { ord: 0, k: 0xffff, mnemonic: 'MOVZX', width: 2 }, { ord: 1, k: 0xffff, mnemonic: 'MOVZX', width: 2 },
    ] }) ? null : `maskSites ${JSON.stringify(f.maskSites)}`,
  },
];

async function main(): Promise<void> {
  const dir = process.argv[2] ?? process.env.GHIDRA_SNAPSHOT_DIR ?? join(process.cwd(), 'project', '.ghidra-mcp', 'codegen-snapshot');
  const want = new Map(EXPECT.map(e => [e.address, e]));
  const found = new Map<string, Record<string, any>>();
  const rl = createInterface({ input: createReadStream(join(dir, 'functions.ndjson')), crlfDelay: Infinity });
  for await (const line of rl) {
    const m = /"address":"(?:0x)?([0-9a-fA-F]{8})"/.exec(line);
    if (!m || !want.has(m[1].toLowerCase())) continue;
    found.set(m[1].toLowerCase(), JSON.parse(line));
  }
  let failed = 0;
  for (const e of EXPECT) {
    const f = found.get(e.address);
    if (!f) { console.log(`SKIP  ${e.address} ${e.name}: not in the snapshot`); continue; }
    const why = e.check(f);
    if (why) failed++;
    console.log(`${why ? 'FAIL' : 'ok  '}  ${e.address} ${e.name}${why ? `: ${why}` : ''}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

void main();
