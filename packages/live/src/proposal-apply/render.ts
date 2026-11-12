/**
 * Render the Ghidra script that applies one group of approved redivivus.app proposals.
 *
 *   proposal-render <proposals.json> <win|mac> <author|*> <true|false> <out.java> [tag] [chunk/size]
 *
 * proposals.json is a list of {id, author, ops} (list_approved rows, or the `proposals` of a
 * list_approved / admin_queue answer). Only the ops of the chosen program go in; a proposal whose
 * ops span both programs is applied per program, its ops for the other one are left for that
 * program's run. dry=true checks every expect and writes nothing. tag (default
 * community-proposal) is put on every function an op touches. chunk/size renders the chunk-th
 * (0-based) run of size proposals: the transport ends a script after 120 s, and every touched
 * function is decompiled twice.
 *
 * The port of the D2 workspace's docs/tools/ghidra-apply/proposal_render.py: for the ops that
 * script knew the output is its output byte for byte (the JSON as Python's json.dumps writes it,
 * the placeholders replaced in its order). The ops it did not know (vc8form, linkage) add their
 * code to the template only when the group holds one (ext-ops.ts).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { PROPOSAL_APPLY_TEMPLATE } from './template.js';
import { extensionParts } from './ext-ops.js';

export interface ProposalRow {
  id: number;
  author: string | { login?: string } | null;
  ops: Array<Record<string, unknown>>;
}

export interface RenderOptions {
  program: string;
  /** A GitHub login, or "*" for every author. */
  author: string;
  dry: boolean;
  tag?: string;
  /** [chunk, size]: the chunk-th run of size proposals; size 0 for all. */
  chunk?: [number, number];
}

export interface Rendered {
  text: string;
  proposals: number;
  ops: number;
}

/** Python's json.dumps(v, separators=(',', ':')): ensure_ascii, no spaces, keys in their order. */
export function pyJsonDumps(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
    return String(v);
  }
  if (typeof v === 'string') return pyJsonString(v);
  if (Array.isArray(v)) return `[${v.map(pyJsonDumps).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pyJsonString(k)}:${pyJsonDumps(x)}`).join(',')}}`;
  }
  throw new Error(`cannot serialise a ${typeof v}`);
}

const SHORT: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

/** A string as json.dumps writes it with ensure_ascii: everything outside ' '..'~' escaped, UTF-16 units as \uXXXX. */
function pyJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const code = s.charCodeAt(i);
    if (SHORT[c] !== undefined) out += SHORT[c];
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += c;
  }
  return `${out}"`;
}

/** str.replace(old, new): every occurrence. */
function replaceAll(s: string, from: string, to: string): string {
  return s.split(from).join(to);
}

function loginOf(author: ProposalRow['author']): string | undefined {
  if (typeof author === 'string') return author;
  return author?.login;
}

/** The proposals of one group, as proposal_render.py selects them. */
export function selectGroup(all: ProposalRow[], opts: RenderOptions): Array<{ id: number; ops: Array<Record<string, unknown>> }> {
  let rows: Array<{ id: number; ops: Array<Record<string, unknown>> }> = [];
  for (const p of all) {
    if (opts.author !== '*' && loginOf(p.author) !== opts.author) continue;
    const ops = p.ops.filter((o) => o.program === opts.program);
    if (ops.length) rows.push({ id: p.id, ops });
  }
  const [chunk, size] = opts.chunk ?? [0, 0];
  if (size) rows = rows.slice(chunk * size, (chunk + 1) * size);
  return rows;
}

export function renderProposalScript(all: ProposalRow[], opts: RenderOptions): Rendered {
  const rows = selectGroup(all, opts);
  const json = pyJsonDumps(rows);
  if (json.includes('"""')) throw new Error('the proposals hold """, which would end the Java text block');
  const [chunk, size] = opts.chunk ?? [0, 0];
  let t = PROPOSAL_APPLY_TEMPLATE;
  for (const [marker, text] of Object.entries(extensionParts(rows.flatMap((r) => r.ops)))) t = replaceAll(t, marker, text);
  t = replaceAll(t, '__DRY__', String(opts.dry));
  t = replaceAll(t, '__GROUP__', `${opts.program} ${opts.author}${size ? ` part ${chunk + 1}` : ''}`);
  t = replaceAll(t, '__TAG__', opts.tag ?? 'community-proposal');
  t = replaceAll(t, '__JSON__', replaceAll(json, '\\', '\\\\'));
  return { text: t, proposals: rows.length, ops: rows.reduce((n, r) => n + r.ops.length, 0) };
}

/** The rows of a proposals file: a list, or an MCP answer with a `proposals` list. */
export function readProposals(path: string): ProposalRow[] {
  const v = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(v) ? v : v?.proposals;
  if (!Array.isArray(list)) throw new Error(`${path}: neither a list of proposals nor an answer with "proposals"`);
  return list;
}

const USAGE = 'usage: proposal-render <proposals.json> <win|mac> <author|*> <true|false> <out.java> [tag] [chunk/size]';

export function main(argv: string[]): number {
  if (argv.length < 5) { process.stderr.write(`${USAGE}\n`); return 2; }
  const [src, program, author, dry, out, tag, part] = argv;
  if (dry !== 'true' && dry !== 'false') { process.stderr.write(`dry is true or false\n${USAGE}\n`); return 2; }
  let chunk: [number, number] | undefined;
  if (part !== undefined) {
    const m = /^(\d+)\/(\d+)$/.exec(part);
    if (!m) { process.stderr.write(`chunk/size is two numbers, like 0/40\n${USAGE}\n`); return 2; }
    chunk = [Number(m[1]), Number(m[2])];
  }
  const r = renderProposalScript(readProposals(src), { program, author, dry: dry === 'true', tag, chunk });
  writeFileSync(out, r.text);
  process.stdout.write(`${out} ${[...r.text].length} proposals ${r.proposals} ops ${r.ops}\n`);
  return 0;
}
