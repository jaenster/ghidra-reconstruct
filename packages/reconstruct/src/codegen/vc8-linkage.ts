/**
 * The linkage a VC8 compile proved for a function, recorded as a Ghidra tag.
 *
 * File-static selection (file-static-functions.ts) reads the original's convention from
 * Ghidra's parameter storage: a parameter in a register the declared convention does not
 * pass arguments in can only come from a function VC8 compiled static. What the storage
 * cannot say is which register VC8 chooses for the rebuild's static: that depends on the
 * body and its callers, and only a compile shows it. The VC8 oracle measures both
 * linkages of a function and records the one whose compile is the original's as
 *
 *     vc8linkage:<static|extern>;ev=<evidence>;bh=<size>-<bytes>;dh=<body>
 *
 *   static  define it static although its storage shows no convention of its own; every
 *           other condition of the selection (all references in its unit, a caller, no
 *           data or foreign source naming it) still has to hold
 *   extern  keep it extern although its storage selects it: made static, VC8 gives it a
 *           register convention the original does not have
 *   ev, bh, dh  as in a vc8form tag (vc8form-spec.ts): the evidence row, the original's
 *           size and byte hash, and the decompile the verdict was measured against
 *
 * A tag is stale, and changes nothing, when the function's size is not the one `bh`
 * records or its decompile no longer hashes to `dh`: a changed body can make VC8 choose
 * another register. Two well-formed tags that disagree are both stale. Stale tags are
 * reported, so the oracle can measure the function again.
 */

import type { ExtractedFunction } from '../types.js';
import { vc8formBodyHash } from './vc8form-spec.js';

export const VC8_LINKAGE_TAG = 'vc8linkage';

export type Vc8Linkage = 'static' | 'extern';

export interface Vc8LinkageVerdict {
  /** The linkage the measured tags agree on; absent when there is none to apply. */
  linkage?: Vc8Linkage;
  /** Tags left out, with why. */
  stale: Array<{ tag: string; why: string }>;
}

interface ParsedTag {
  linkage: Vc8Linkage;
  size: number;
  body: string;
}

/** Parse one tag's data; undefined when it is not a well-formed vc8linkage record. */
export function parseVc8LinkageTag(data: string): ParsedTag | undefined {
  const parts = data.split(';').map(p => p.trim());
  const linkage = parts[0];
  if (linkage !== 'static' && linkage !== 'extern') return undefined;
  const fields = new Map<string, string>();
  for (const kv of parts.slice(1)) {
    const eq = kv.indexOf('=');
    if (eq <= 0) return undefined;
    fields.set(kv.slice(0, eq), kv.slice(eq + 1));
  }
  const ev = fields.get('ev'), bh = fields.get('bh'), dh = fields.get('dh');
  const m = bh ? /^(\d+)-([0-9a-f]{8})$/.exec(bh) : null;
  if (!ev || !/^[0-9a-f]{10}$/.test(ev) || !m || !dh || !/^[0-9a-f]{8}$/.test(dh)) return undefined;
  return { linkage, size: Number(m[1]), body: dh };
}

/** The measured linkage of func, from its `vc8linkage` tags. */
export function vc8LinkageVerdict(func: Pick<ExtractedFunction, 'tags' | 'size' | 'decompiled'>): Vc8LinkageVerdict {
  const out: Vc8LinkageVerdict = { stale: [] };
  const tags = (func.tags ?? []).filter(t => t.type === VC8_LINKAGE_TAG);
  if (tags.length === 0) return out;
  const fresh: Array<{ tag: string; linkage: Vc8Linkage }> = [];
  let body: string | undefined;
  for (const t of tags) {
    const raw = t.data ?? '';
    const tag = parseVc8LinkageTag(raw);
    if (!tag) { out.stale.push({ tag: raw, why: 'not a vc8linkage record' }); continue; }
    if (Number(func.size) !== tag.size) { out.stale.push({ tag: raw, why: `size ${func.size}, the tag measured ${tag.size}` }); continue; }
    body ??= vc8formBodyHash(func.decompiled ?? '');
    if (body !== tag.body) { out.stale.push({ tag: raw, why: `decompile ${body}, the tag measured ${tag.body}` }); continue; }
    fresh.push({ tag: raw, linkage: tag.linkage });
  }
  const linkages = new Set(fresh.map(f => f.linkage));
  if (linkages.size > 1) {
    for (const f of fresh) out.stale.push({ tag: f.tag, why: 'another vc8linkage tag measures the other linkage' });
  } else if (linkages.size === 1) {
    out.linkage = fresh[0].linkage;
  }
  return out;
}
