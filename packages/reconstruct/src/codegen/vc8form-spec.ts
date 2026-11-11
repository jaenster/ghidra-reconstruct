/**
 * The VC8 source forms a function's `vc8form` tags record (cpp-parser vc8-form.ts).
 *
 * A tag is written once a VC8 compile of the form matched the original's bytes, and it
 * names the body as the generator printed it then. Its data carries the evidence:
 *
 *     vc8form:<form>;ev=<evidence>;bh=<size>-<bytes>;dh=<body>[;ord=<n>]
 *
 *   form   the form and its arguments, `seq(a.x,a.y)` (vc8-form.ts lists them)
 *   ev     the evidence record of the match: the first 10 hex digits of the SHA-256 of
 *          its row in the evidence table, so the tag can be traced to the compile that
 *          proved it
 *   bh     the original function's size and the first 8 hex digits of the SHA-256 of
 *          its bytes, relocations masked
 *   dh     the first 8 hex digits of the SHA-256 of the decompile the tag was measured
 *          against, in its namespace-free token form (`vc8formBodyForm`): the tokens
 *          one space apart, and every qualifier `N::` a name is spelled with dropped
 *   ord    optional, a positive integer: the place of this tag among the function's
 *          tags of the same form. Ghidra keeps a function's tags as a set, so where a
 *          second form rewrites what a first one printed (two seq, select, nest or
 *          merge-tail tags, DrawRect 0050c3a0), the tags say which goes first. Forms of
 *          the same op apply without `ord` first, by their text, then by `ord`.
 *
 * A tag is stale, and changes nothing, when the function's size is not the size `bh`
 * records (Ghidra's body for the function moved) or its decompile no longer hashes to
 * `dh` (a type, a name or a callee changed what the form was measured against). Stale
 * tags are reported, so the lane that measures forms can measure them again.
 *
 * A symbol moved to another namespace changes only how Ghidra qualifies it, and with the
 * longer or shorter name where Ghidra wraps the line; neither changes what the form was
 * measured against, so neither may stale a tag. Everything else still does: a rename,
 * a type, a cast, a constant, a reordered statement.
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
  /** The `ord` field: the tag's place among the function's tags of its op. */
  order?: number;
}

export interface Vc8FormSpec {
  forms: Array<{ form: Vc8Form; tag: string }>;
  /** Tags that were not applied, with why. */
  stale: Array<{ tag: string; why: string }>;
}

/** The decompile hash a tag's `dh` records: of the body's namespace-free token form. */
export function vc8formBodyHash(decompiled: string): string {
  return createHash('sha256').update(vc8formBodyForm(decompiled)).digest('hex').slice(0, 8);
}

/**
 * The hash tags recorded before `dh` was taken over the token form: whitespace runs
 * collapsed only. Kept for the rehash tool, which proves an old tag against it.
 */
export function vc8formLegacyBodyHash(decompiled: string): string {
  return createHash('sha256').update(decompiled.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 8);
}

const isWordStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isWord = (c: number) => isWordStart(c) || isDigit(c);
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;

/**
 * The decompile as tokens one space apart, with every qualifier dropped: an identifier
 * followed by `::` goes with the `::`, so `D2Game::SKILLS::Foo(x)` and `Foo (x)` are one
 * form. String and character literals are kept whole; a comment is one token whose own
 * text gets the same treatment. Other punctuation is one token per character, which only
 * matters where it joins two forms Ghidra never prints apart.
 */
export function vc8formBodyForm(decompiled: string): string {
  return tokenForm(decompiled, true);
}

function tokenForm(text: string, literals: boolean): string {
  const toks: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (isSpace(c)) { i++; continue; }
    const two = text.slice(i, i + 2);
    if (literals && (two === '/*' || two === '//')) {
      const end = two === '/*' ? text.indexOf('*/', i + 2) : text.indexOf('\n', i + 2);
      const stop = end < 0 ? n : end;
      toks.push(two + ' ' + tokenForm(text.slice(i + 2, stop), false) + (two === '/*' ? ' */' : ''));
      i = two === '/*' ? (end < 0 ? n : end + 2) : stop;
      continue;
    }
    if (literals && (c === 34 || c === 39)) {
      // A literal ends at its unescaped quote; one never runs past its line.
      let j = i + 1;
      while (j < n && text.charCodeAt(j) !== c && text.charCodeAt(j) !== 10) j += text.charCodeAt(j) === 92 ? 2 : 1;
      j = Math.min(j + 1, n);
      toks.push(text.slice(i, j));
      i = j;
      continue;
    }
    if (isWordStart(c) || isDigit(c)) {
      let j = i + 1;
      while (j < n && (isWord(text.charCodeAt(j)) || (isDigit(c) && text.charCodeAt(j) === 46))) j++;
      toks.push(text.slice(i, j));
      i = j;
      continue;
    }
    if (two === '::') { toks.push('::'); i += 2; continue; }
    toks.push(text[i]!);
    i++;
  }
  const out: string[] = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k + 1] === '::' && isWordStart(toks[k]!.charCodeAt(0))) { k++; continue; }
    out.push(toks[k]!);
  }
  return out.join(' ');
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
  const ord = fields.get('ord');
  if (ord !== undefined && !/^[1-9]\d{0,5}$/.test(ord)) return undefined;
  const form = parseVc8Form(data.slice(0, at));
  if (!form) return undefined;
  return { form, raw: data, ev, size: Number(m[1]), bytes: m[2], body: dh, ...(ord !== undefined ? { order: Number(ord) } : {}) };
}

/** The forms to apply to func, in tag order, and the tags left out. */
export function vc8FormSpec(func: Pick<ExtractedFunction, 'tags' | 'size' | 'decompiled'>): Vc8FormSpec | undefined {
  const tags = (func.tags ?? []).filter(t => t.type === VC8FORM_TAG);
  if (tags.length === 0) return undefined;
  const out: Vc8FormSpec = { forms: [], stale: [] };
  const forms: Array<{ form: Vc8Form; tag: string; order: number }> = [];
  let body: string | undefined;
  for (const t of tags) {
    const raw = t.data ?? '';
    const tag = parseVc8FormTag(raw);
    if (!tag) { out.stale.push({ tag: raw, why: 'not a vc8form record' }); continue; }
    if (Number(func.size) !== tag.size) { out.stale.push({ tag: raw, why: `size ${func.size}, the tag measured ${tag.size}` }); continue; }
    body ??= vc8formBodyHash(func.decompiled ?? '');
    if (body !== tag.body) {
      const legacy = vc8formLegacyBodyHash(func.decompiled ?? '') === tag.body ? '; its dh is the whitespace-only hash, rehash it (scripts/vc8form-rehash.ts)' : '';
      out.stale.push({ tag: raw, why: `decompile ${body}, the tag measured ${tag.body}${legacy}` });
      continue;
    }
    forms.push({ form: tag.form, tag: raw, order: tag.order ?? 0 });
  }
  // Ghidra keeps a function's tags as a set, so their order says nothing: the forms that
  // change a declaration go first, the moves last, and equal ops by their `ord`, then by
  // their text. dup goes before fold: the copy it writes into each arm is what fold then
  // folds the arm's temporary into (LOADER_CheckForInsertedDiscs 0045fc60).
  forms.sort((a, b) => FORM_ORDER.indexOf(a.form.op) - FORM_ORDER.indexOf(b.form.op) || a.order - b.order || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  out.forms = forms.map(({ form, tag }) => ({ form, tag }));
  return out;
}

/** A tagged function's size and both decompile hashes, with its vc8form tags as Ghidra holds them. */
export interface Vc8FormHashRecord {
  address: string;
  name: string;
  size: number;
  /** `vc8formBodyHash` of the decompile. */
  form: string;
  /** `vc8formLegacyBodyHash` of the decompile. */
  legacy: string;
  tags: string[];
}

export function vc8formHashRecord(func: Pick<ExtractedFunction, 'address' | 'name' | 'tags' | 'size' | 'decompiled'>): Vc8FormHashRecord | undefined {
  const tags = (func.tags ?? []).filter(t => t.type === VC8FORM_TAG).map(t => t.data ?? '');
  if (tags.length === 0) return undefined;
  const d = func.decompiled ?? '';
  return { address: String(func.address), name: String(func.name ?? ''), size: Number(func.size), form: vc8formBodyHash(d), legacy: vc8formLegacyBodyHash(d), tags: tags.sort() };
}

const FORM_ORDER: Array<Vc8Form['op']> = ['width', 'own', 'split', 'dup', 'fold', 'cache', 'ifsel', 'guards', 'merge-guards', 'retval', 'select', 'tsel', 'merge-tail', 'nest', 'continue', 'arms', 'tarms', 'unselect', 'zero', 'nonzero', 'bool', 'cmp', 'swap', 'hoist', 'decl', 'seq'];
