/**
 * Globals a VC8 compile proved are not defined in the translation unit that uses them,
 * recorded as a Ghidra tag on the function whose compile proved it.
 *
 * Where a global is defined is decided from its data run (file-local-globals.ts): a
 * global all of whose users are in one TU becomes that TU's `static`, and a global in a
 * TU's run is defined there with external linkage. VC8 compiles a use differently by
 * whether the TU holds the definition: a 16-bit global passed in a register is loaded
 * with 32 bits when the TU defines it and with 16 bits when the TU only declares it
 * (NPCMENU_ScrollCompleteShowNextMessage 004b18c0, `mov cx, word ptr [007c0c7b]` for
 * gnNpcMenuScrollCompleteMode, which every user in npcmenu.cpp reads). Nothing in the
 * data says which; a compile of the function does. The oracle records the verdict as
 *
 *     vc8datalinkage:extern(<address>[,<address>...]);ev=<evidence>;bh=<size>-<bytes>;dh=<body>
 *
 *   extern  the globals at these addresses (8 hex digits, the program's addresses) are
 *           declared in the function's TU and defined elsewhere: never the TU's
 *           `static`, never homed in a TU's data run, defined by the globals units
 *   ev, bh, dh  as in a vc8form tag (vc8form-spec.ts): the evidence row, the original's
 *           size and byte hash, and the decompile the verdict was measured against
 *
 * A tag is stale, and changes nothing, when the function's size is not the one `bh`
 * records or its decompile no longer hashes to `dh`, as a vc8linkage tag is: the compile
 * that proved it was of that body. Stale tags and addresses that name no global are
 * reported.
 */

import type { AnalyzedDataSymbol, ExtractedFunction } from '../types.js';
import { vc8formBodyHash } from './vc8form-spec.js';
import { noteGlobalScopeReason } from './global-scope-trace.js';

export const VC8_DATA_LINKAGE_TAG = 'vc8datalinkage';

interface ParsedTag {
  addresses: string[];
  size: number;
  body: string;
}

const ADDRESS = /^(?:0x)?([0-9a-fA-F]{8})$/;

/** Parse one tag's data; undefined when it is not a well-formed vc8datalinkage record. */
export function parseVc8DataLinkageTag(data: string): ParsedTag | undefined {
  const parts = data.split(';').map(p => p.trim());
  const m = /^extern\(([^()]*)\)$/.exec(parts[0] ?? '');
  if (!m) return undefined;
  const addresses: string[] = [];
  for (const a of m[1].split(',').map(x => x.trim())) {
    const am = ADDRESS.exec(a);
    if (!am) return undefined;
    addresses.push(am[1].toLowerCase());
  }
  if (addresses.length === 0) return undefined;
  const fields = new Map<string, string>();
  for (const kv of parts.slice(1)) {
    const eq = kv.indexOf('=');
    if (eq <= 0) return undefined;
    fields.set(kv.slice(0, eq), kv.slice(eq + 1));
  }
  const ev = fields.get('ev'), bh = fields.get('bh'), dh = fields.get('dh');
  const bm = bh ? /^(\d+)-([0-9a-f]{8})$/.exec(bh) : null;
  if (!ev || !/^[0-9a-f]{10}$/.test(ev) || !bm || !dh || !/^[0-9a-f]{8}$/.test(dh)) return undefined;
  return { addresses, size: Number(bm[1]), body: dh };
}

export interface Vc8DataLinkage {
  /** Address (8 lowercase hex digits) -> the functions whose fresh tags name it. */
  external: Map<string, string[]>;
  /** Tags left out, with why. */
  stale: Array<{ func: string; tag: string; why: string }>;
}

/** The measured data linkage every function's fresh `vc8datalinkage` tags record. */
export function vc8DataLinkage(functions: ReadonlyArray<Pick<ExtractedFunction, 'name' | 'tags' | 'size' | 'decompiled'>>): Vc8DataLinkage {
  const out: Vc8DataLinkage = { external: new Map(), stale: [] };
  for (const func of functions) {
    const tags = (func.tags ?? []).filter(t => t.type === VC8_DATA_LINKAGE_TAG);
    if (tags.length === 0) continue;
    let body: string | undefined;
    for (const t of tags) {
      const raw = t.data ?? '';
      const tag = parseVc8DataLinkageTag(raw);
      if (!tag) { out.stale.push({ func: func.name, tag: raw, why: 'not a vc8datalinkage record' }); continue; }
      if (Number(func.size) !== tag.size) { out.stale.push({ func: func.name, tag: raw, why: `size ${func.size}, the tag measured ${tag.size}` }); continue; }
      body ??= vc8formBodyHash(func.decompiled ?? '');
      if (body !== tag.body) { out.stale.push({ func: func.name, tag: raw, why: `decompile ${body}, the tag measured ${tag.body}` }); continue; }
      for (const a of tag.addresses) {
        const list = out.external.get(a) ?? [];
        if (!list.includes(func.name)) list.push(func.name);
        out.external.set(a, list);
      }
    }
  }
  return out;
}

function addressKey(g: { address: string }): string {
  return String(g.address).replace(/^.*:/, '').replace(/^0x/i, '').toLowerCase().padStart(8, '0');
}

/**
 * Mark the globals the fresh tags name `definedElsewhere`, before any scope is computed.
 * Returns the addresses no global of the program starts at.
 */
export function markMeasuredExternData(globals: AnalyzedDataSymbol[], linkage: Vc8DataLinkage): string[] {
  if (linkage.external.size === 0) return [];
  const seen = new Set<string>();
  for (const g of globals) {
    const key = addressKey(g);
    if (!linkage.external.has(key)) continue;
    seen.add(key);
    g.definedElsewhere = true;
    noteGlobalScopeReason(g, 'vc8datalinkage-extern');
  }
  return [...linkage.external.keys()].filter(a => !seen.has(a));
}
