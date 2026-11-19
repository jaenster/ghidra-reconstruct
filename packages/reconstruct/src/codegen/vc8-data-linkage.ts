/**
 * Where and with which linkage a VC8 compile proved a global is defined, recorded as a
 * Ghidra tag on the function whose compile proved it.
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
 *     vc8datalinkage:<extern|defined>(<address>[,<address>...]);ev=<evidence>;bh=<size>-<bytes>;dh=<body>
 *
 *   extern  the globals at these addresses (8 hex digits, the program's addresses) are
 *           declared in the function's TU and defined elsewhere: never the TU's
 *           `static`, never homed in a TU's data run, defined by the globals units
 *   defined the globals at these addresses have external linkage although every user is
 *           in one TU: never that TU's `static`, defined in its data run (a global a
 *           function owns leaves the function). VC8 assumes no pointer reaches a `static`
 *           whose address the TU never takes, so it moves the static's loads above stores
 *           through pointers and sinks its stores below them; the original kept such
 *           accesses in statement order (SELECT_SetExclusionRect 00467430 stores the four
 *           gnSelectExclusionRect* globals each straight after its load), which VC8 gives
 *           a global with external linkage
 *   ev, bh, dh  as in a vc8form tag (vc8form-spec.ts): the evidence row, the original's
 *           size and byte hash, and the decompile the verdict was measured against
 *
 * A tag is stale, and changes nothing, when the function's size is not the one `bh`
 * records or its decompile no longer hashes to `dh`, as a vc8linkage tag is: the compile
 * that proved it was of that body. Stale tags and addresses that name no global are
 * reported.
 */

import type { AnalyzedDataSymbol, ExtractedFunction } from '../types.js';
import { DecompileHash } from './vc8form-spec.js';
import { noteGlobalScopeReason } from './global-scope-trace.js';

export const VC8_DATA_LINKAGE_TAG = 'vc8datalinkage';

export type Vc8DataLinkageKind = 'extern' | 'defined';

interface ParsedTag {
  kind: Vc8DataLinkageKind;
  addresses: string[];
  size: number;
  body: string;
}

const ADDRESS = /^(?:0x)?([0-9a-fA-F]{8})$/;

/** Parse one tag's data; undefined when it is not a well-formed vc8datalinkage record. */
export function parseVc8DataLinkageTag(data: string): ParsedTag | undefined {
  const parts = data.split(';').map(p => p.trim());
  const m = /^(extern|defined)\(([^()]*)\)$/.exec(parts[0] ?? '');
  if (!m) return undefined;
  const kind = m[1] as Vc8DataLinkageKind;
  const addresses: string[] = [];
  for (const a of m[2].split(',').map(x => x.trim())) {
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
  return { kind, addresses, size: Number(bm[1]), body: dh };
}

export interface Vc8DataLinkage {
  /** Address (8 lowercase hex digits) -> the functions whose fresh `extern` tags name it. */
  external: Map<string, string[]>;
  /** Address -> the functions whose fresh `defined` tags name it. */
  defined: Map<string, string[]>;
  /** Tags left out, with why. */
  stale: Array<{ func: string; tag: string; why: string }>;
}

/** The measured data linkage every function's fresh `vc8datalinkage` tags record. */
export function vc8DataLinkage(functions: ReadonlyArray<Pick<ExtractedFunction, 'name' | 'tags' | 'size' | 'decompiled' | 'ghidraDecompiled'>>): Vc8DataLinkage {
  const out: Vc8DataLinkage = { external: new Map(), defined: new Map(), stale: [] };
  for (const func of functions) {
    const tags = (func.tags ?? []).filter(t => t.type === VC8_DATA_LINKAGE_TAG);
    if (tags.length === 0) continue;
    const body = new DecompileHash(func);
    for (const t of tags) {
      const raw = t.data ?? '';
      const tag = parseVc8DataLinkageTag(raw);
      if (!tag) { out.stale.push({ func: func.name, tag: raw, why: 'not a vc8datalinkage record' }); continue; }
      if (Number(func.size) !== tag.size) { out.stale.push({ func: func.name, tag: raw, why: `size ${func.size}, the tag measured ${tag.size}` }); continue; }
      if (!body.matches(tag.body)) { out.stale.push({ func: func.name, tag: raw, why: `decompile ${body.dh}, the tag measured ${tag.body}` }); continue; }
      const into = tag.kind === 'extern' ? out.external : out.defined;
      for (const a of tag.addresses) {
        const list = into.get(a) ?? [];
        if (!list.includes(func.name)) list.push(func.name);
        into.set(a, list);
      }
    }
  }
  // Two compiles that disagree prove neither: the global keeps the scope its users give it.
  for (const [a, byDefined] of out.defined) {
    const byExtern = out.external.get(a);
    if (!byExtern) continue;
    out.stale.push({ func: [...byExtern, ...byDefined].join(','), tag: a, why: 'measured both extern and defined' });
    out.external.delete(a);
    out.defined.delete(a);
  }
  return out;
}

function addressKey(g: { address: string }): string {
  return String(g.address).replace(/^.*:/, '').replace(/^0x/i, '').toLowerCase().padStart(8, '0');
}

/**
 * Mark the globals the fresh tags name, before any scope is computed: `definedElsewhere`
 * for an `extern` tag, `externalLinkage` for a `defined` one. Returns the addresses no
 * global of the program starts at.
 */
export function markMeasuredExternData(globals: AnalyzedDataSymbol[], linkage: Vc8DataLinkage): string[] {
  if (linkage.external.size === 0 && linkage.defined.size === 0) return [];
  const seen = new Set<string>();
  for (const g of globals) {
    const key = addressKey(g);
    if (linkage.external.has(key)) {
      seen.add(key);
      g.definedElsewhere = true;
      noteGlobalScopeReason(g, 'vc8datalinkage-extern');
    } else if (linkage.defined.has(key)) {
      seen.add(key);
      g.externalLinkage = true;
    }
  }
  return [...linkage.external.keys(), ...linkage.defined.keys()].filter(a => !seen.has(a));
}
