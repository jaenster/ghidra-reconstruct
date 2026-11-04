/**
 * The VC8 source forms a function's `vc8form` tags record (cpp-parser vc8-form.ts).
 *
 * A tag is written once a VC8 compile of the form matched the original's bytes, and it
 * names the body as the generator printed it then. Its data carries the evidence:
 *
 *     vc8form:<form>;ev=<evidence>;bh=<size>-<bytes>;dh=<body>
 *
 *   form   the form and its arguments, `seq(a.x,a.y)` (vc8-form.ts lists them)
 *   ev     the evidence record of the match: the first 10 hex digits of the SHA-256 of
 *          its row in the evidence table, so the tag can be traced to the compile that
 *          proved it
 *   bh     the original function's size and the first 8 hex digits of the SHA-256 of
 *          its bytes, relocations masked
 *   dh     the first 8 hex digits of the SHA-256 of the decompile the tag was measured
 *          against, whitespace runs collapsed to one space (`vc8formBodyHash`)
 *
 * A tag is stale, and changes nothing, when the function's size is not the size `bh`
 * records (Ghidra's body for the function moved) or its decompile no longer hashes to
 * `dh` (a type, a name or a callee changed what the form was measured against). Stale
 * tags are reported, so the lane that measures forms can measure them again.
 */

import { createHash } from 'node:crypto';
import { parseVc8Form, type Vc8Form } from '@ghidra-mcp/cpp-parser';
import type { ExtractedFunction } from '../types.js';

export const VC8FORM_TAG = 'vc8form';

export interface Vc8FormTag {
  form: Vc8Form;
  /** The tag's data as Ghidra holds it, for the report. */
  raw: string;
  ev: string;
  size: number;
  bytes: string;
  body: string;
}

export interface Vc8FormSpec {
  forms: Array<{ form: Vc8Form; tag: string }>;
  /** Tags that were not applied, with why. */
  stale: Array<{ tag: string; why: string }>;
}

/** The decompile hash a tag's `dh` records. */
export function vc8formBodyHash(decompiled: string): string {
  return createHash('sha256').update(decompiled.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 8);
}

/** Parse one tag's data; undefined when it is not a well-formed vc8form record. */
export function parseVc8FormTag(data: string): Vc8FormTag | undefined {
  const at = data.lastIndexOf(';ev=');
  if (at < 0) return undefined;
  const fields = new Map<string, string>();
  for (const kv of data.slice(at + 1).split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) fields.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
  }
  const ev = fields.get('ev'), bh = fields.get('bh'), dh = fields.get('dh');
  const m = bh ? /^(\d+)-([0-9a-f]{8})$/.exec(bh) : null;
  if (!ev || !/^[0-9a-f]{10}$/.test(ev) || !m || !dh || !/^[0-9a-f]{8}$/.test(dh)) return undefined;
  const form = parseVc8Form(data.slice(0, at));
  if (!form) return undefined;
  return { form, raw: data, ev, size: Number(m[1]), bytes: m[2], body: dh };
}

/** The forms to apply to func, in tag order, and the tags left out. */
export function vc8FormSpec(func: Pick<ExtractedFunction, 'tags' | 'size' | 'decompiled'>): Vc8FormSpec | undefined {
  const tags = (func.tags ?? []).filter(t => t.type === VC8FORM_TAG);
  if (tags.length === 0) return undefined;
  const out: Vc8FormSpec = { forms: [], stale: [] };
  let body: string | undefined;
  for (const t of tags) {
    const raw = t.data ?? '';
    const tag = parseVc8FormTag(raw);
    if (!tag) { out.stale.push({ tag: raw, why: 'not a vc8form record' }); continue; }
    if (Number(func.size) !== tag.size) { out.stale.push({ tag: raw, why: `size ${func.size}, the tag measured ${tag.size}` }); continue; }
    body ??= vc8formBodyHash(func.decompiled ?? '');
    if (body !== tag.body) { out.stale.push({ tag: raw, why: `decompile ${body}, the tag measured ${tag.body}` }); continue; }
    out.forms.push({ form: tag.form, tag: raw });
  }
  // Ghidra keeps a function's tags as a set, so their order says nothing: the forms that
  // change a declaration go first, the moves last, and equal ops by their text.
  out.forms.sort((a, b) => FORM_ORDER.indexOf(a.form.op) - FORM_ORDER.indexOf(b.form.op) || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  return out;
}

const FORM_ORDER: Array<Vc8Form['op']> = ['width', 'own', 'fold', 'cache', 'guards', 'merge-guards', 'retval', 'arms', 'seq'];
