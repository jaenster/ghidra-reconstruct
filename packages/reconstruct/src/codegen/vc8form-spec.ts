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
 *   dh     the first 8 hex digits of the SHA-256 of Ghidra's decompile the tag was
 *          measured against, in its namespace-free token form: the tokens one space
 *          apart, and every qualifier `N::` a name is spelled with dropped. The one
 *          definition is vc8form-dh.ts, which redivivus-app copies: Ghidra's text, never
 *          the generator's rewrite of it
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
import { vc8formBodyForm, vc8formDh } from './vc8form-dh.js';

export { vc8formBodyForm };

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

/** The decompile hash a tag's `dh` records, of Ghidra's decompile (vc8form-dh.ts). */
export function vc8formBodyHash(decompiled: string): string {
  return vc8formDh(decompiled, text => createHash('sha256').update(text).digest('hex'));
}

/**
 * The hash tags recorded before `dh` was taken over the token form: whitespace runs
 * collapsed only. Kept for the rehash tool, which proves an old tag against it.
 */
export function vc8formLegacyBodyHash(decompiled: string): string {
  return createHash('sha256').update(decompiled.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 8);
}

type DecompiledFunction = Pick<ExtractedFunction, 'decompiled' | 'ghidraDecompiled'>;

/** Ghidra's decompile of func: the text `dh` is defined over, before generation rewrote it. */
export function ghidraDecompile(func: DecompiledFunction): string {
  return func.ghidraDecompiled ?? func.decompiled ?? '';
}

/** Keep each function's decompile as Ghidra printed it, before anything rewrites `decompiled`. */
export function keepGhidraDecompiles(functions: ExtractedFunction[]): void {
  for (const f of functions) if (f.ghidraDecompiled === undefined && f.decompiled !== undefined) f.ghidraDecompiled = f.decompiled;
}

/**
 * Whether a tag's recorded `dh` is current for func. `dh` is the hash of Ghidra's decompile.
 * Until the one-shot rehash has run, a tag may still carry the hash of the decompile as the
 * generator had rewritten it (template names respelled) when it checked tags that way; that
 * hash is accepted too, and named, so the rehash tool can list it.
 */
export class DecompileHash {
  private ghidra?: string;
  private stagedHash?: string | null;
  constructor(private readonly func: DecompiledFunction) {}

  /** `dh` of Ghidra's decompile. */
  get dh(): string {
    return (this.ghidra ??= vc8formBodyHash(ghidraDecompile(this.func)));
  }

  /** The generator-stage hash, when the generator's text hashes differently; else null. */
  get staged(): string | null {
    if (this.stagedHash === undefined) {
      const d = this.func.decompiled ?? '';
      this.stagedHash = d === ghidraDecompile(this.func) ? null : vc8formBodyHash(d);
      if (this.stagedHash === this.dh) this.stagedHash = null;
    }
    return this.stagedHash;
  }

  /** 'ghidra' when dh is current, 'staged' when it is the transitional hash, else undefined. */
  matches(dh: string): 'ghidra' | 'staged' | undefined {
    if (dh === this.dh) return 'ghidra';
    if (dh === this.staged) return 'staged';
    return undefined;
  }
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
export function vc8FormSpec(func: Pick<ExtractedFunction, 'tags' | 'size' | 'decompiled' | 'ghidraDecompiled'>): Vc8FormSpec | undefined {
  const tags = (func.tags ?? []).filter(t => t.type === VC8FORM_TAG);
  if (tags.length === 0) return undefined;
  const out: Vc8FormSpec = { forms: [], stale: [] };
  const forms: Array<{ form: Vc8Form; tag: string; order: number }> = [];
  const body = new DecompileHash(func);
  for (const t of tags) {
    const raw = t.data ?? '';
    const tag = parseVc8FormTag(raw);
    if (!tag) { out.stale.push({ tag: raw, why: 'not a vc8form record' }); continue; }
    if (Number(func.size) !== tag.size) { out.stale.push({ tag: raw, why: `size ${func.size}, the tag measured ${tag.size}` }); continue; }
    if (!body.matches(tag.body)) {
      const legacy = vc8formLegacyBodyHash(ghidraDecompile(func)) === tag.body ? '; its dh is the whitespace-only hash, rehash it (scripts/vc8form-rehash.ts)' : '';
      out.stale.push({ tag: raw, why: `decompile ${body.dh}, the tag measured ${tag.body}${legacy}` });
      continue;
    }
    forms.push({ form: tag.form, tag: raw, order: tag.order ?? 0 });
  }
  // Ghidra keeps a function's tags as a set, so their order says nothing: the forms that
  // change a declaration go first, the moves last, and equal ops by their `ord`, then by
  // their text. dup goes before fold: the copy it writes into each arm is what fold then
  // folds the arm's temporary into (LOADER_CheckForInsertedDiscs 0045fc60).
  forms.sort((a, b) => FORM_RANK.get(a.form.op)! - FORM_RANK.get(b.form.op)! || a.order - b.order || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  out.forms = forms.map(({ form, tag }) => ({ form, tag }));
  return out;
}

/** A tagged function's size and its decompile hashes, with its vc8form tags as Ghidra holds them. */
export interface Vc8FormHashRecord {
  address: string;
  name: string;
  size: number;
  /** `vc8formBodyHash` of Ghidra's decompile: the `dh` a current tag records. */
  form: string;
  /** `vc8formLegacyBodyHash` of Ghidra's decompile. */
  legacy: string;
  /** `vc8formBodyHash` of the decompile as the generator rewrote it, when that differs. */
  staged?: string;
  tags: string[];
}

export function vc8formHashRecord(func: Pick<ExtractedFunction, 'address' | 'name' | 'tags' | 'size' | 'decompiled' | 'ghidraDecompiled'>): Vc8FormHashRecord | undefined {
  const tags = (func.tags ?? []).filter(t => t.type === VC8FORM_TAG).map(t => t.data ?? '');
  if (tags.length === 0) return undefined;
  const h = new DecompileHash(func);
  return {
    address: String(func.address), name: String(func.name ?? ''), size: Number(func.size), form: h.dh,
    legacy: vc8formLegacyBodyHash(ghidraDecompile(func)), ...(h.staged ? { staged: h.staged } : {}), tags: tags.sort(),
  };
}

export const FORM_ORDER = ['nullfault32', 'width', 'boolflag', 'retwiden', 'own', 'split', 'zerolife', 'join', 'coalesce', 'dup', 'guardchoice', 'fold', 'nestcall', 'fill', 'elems', 'copy', 'rowptr', 'ptrwalk', 'recordwalk', 'fieldalias', 'postdec', 'cache', 'pairvia', 'ifsel', 'clamp', 'guards', 'merge-guards', 'retval', 'branchret', 'retbase', 'select', 'tsel', 'merge-tail', 'tailguard', 'tailcopy', 'swtail', 'andguard', 'sel', 'retvar', 'onecall', 'roundup', 'switch', 'swclamp', 'swmerge', 'nest', 'continue', 'arms', 'tarms', 'unselect', 'zero', 'nonzero', 'bool', 'shift', 'range', 'castout', 'signbit', 'cmp', 'swap', 'hoist', 'opas', 'dec', 'uncoalesce', 'sinkvia', 'lift', 'decl', 'initbefore', 'zinit', 'znew', 'seq', 'nullinit', 'movestore', 'sinkstore', 'nullfield', 'acc', 'swdefault'] as const satisfies ReadonlyArray<Vc8Form['op']>;
// Every op needs a slot: the build fails on an op without one.
const _everyFormHasASlot: Exclude<Vc8Form['op'], typeof FORM_ORDER[number]> extends never ? true : never = true;
void _everyFormHasASlot;
const FORM_RANK = new Map<Vc8Form['op'], number>(FORM_ORDER.map((op, i) => [op, i]));
