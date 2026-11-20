/**
 * A proposed change to one hand-owned body, given as a unified diff: apply it to the tree's
 * files, find the target function before and after by its `// 1.14d:` anchor, and say what
 * the diff touches besides that body.
 *
 * A diff is read as text lines (it is not C++); the C++ on either side is read with the
 * lexer and parser like any other body.
 */

import { lexTokens, markerAddress, scanCpp, type FunctionExtent } from '../../ratchet/scan.js';
import { normalizeAddress } from '../../ratchet/store.js';
import { lexBody } from './body.js';

export interface DiffLine {
  op: ' ' | '-' | '+';
  text: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number | null;
  newStart: number;
  newLines: number | null;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  hunks: Hunk[];
}

/** The diff inside a document: the ```diff fences of an issue body, or the whole text. */
export function extractDiff(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inside = false;
  let found = false;
  for (const l of lines) {
    if (!inside && l.trimStart().startsWith('```diff')) { inside = true; found = true; continue; }
    if (inside && l.trimStart().startsWith('```')) { inside = false; continue; }
    if (inside) out.push(l);
  }
  return found ? out.join('\n') : text;
}

function stripPrefix(p: string): string {
  const t = p.trim().split('\t')[0];
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

function hunkHeader(l: string): Hunk | null {
  if (!l.startsWith('@@')) return null;
  const end = l.indexOf('@@', 2);
  if (end < 0) return null;
  const [o, n] = l.slice(2, end).trim().split(/\s+/);
  const range = (s: string | undefined): [number, number | null] => {
    if (!s) return [0, null];
    const [a, b] = s.slice(1).split(',');
    return [Number(a) || 0, b === undefined ? 1 : Number(b)];
  };
  const [oldStart, oldLines] = range(o);
  const [newStart, newLines] = range(n);
  return { oldStart, oldLines, newStart, newLines, lines: [] };
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  const counted = () => hunk && hunk.oldLines !== null && hunk.newLines !== null;
  for (const l of text.split(/\r?\n/)) {
    if (hunk && (oldLeft > 0 || newLeft > 0 || !counted())) {
      const c = l[0];
      // A blank line inside a counted hunk is a context line whose single space was lost.
      if (l === '' && counted()) { hunk.lines.push({ op: ' ', text: '' }); oldLeft--; newLeft--; continue; }
      if (c === ' ' || c === '-' || c === '+') {
        if (!(c === '-' && l.startsWith('--- ') && !counted()) && !(c === '+' && l.startsWith('+++ ') && !counted())) {
          hunk.lines.push({ op: c, text: l.slice(1) });
          if (c !== '+') oldLeft--;
          if (c !== '-') newLeft--;
          continue;
        }
      }
      if (c === '\\') continue;
      hunk = null;
    }
    if (l.startsWith('+++ ')) {
      file = { path: stripPrefix(l.slice(4)), hunks: [] };
      files.push(file);
      continue;
    }
    if (l.startsWith('--- ') || l.startsWith('diff ') || l.startsWith('index ')) continue;
    const h = hunkHeader(l);
    if (h && file) {
      hunk = h;
      file.hunks.push(h);
      oldLeft = h.oldLines ?? 0;
      newLeft = h.newLines ?? 0;
    }
  }
  return files;
}

export interface Applied {
  text: string;
  /**
   * Per hunk: the 1-based line range in the new text the hunk's lines occupy, the new line of
   * every added line, and the new line each removed line stood before.
   */
  ranges: Array<{ hunk: Hunk; start: number; end: number; added: Array<[number, string]>; removed: Array<[number, string]> }>;
}

const norm = (s: string) => s.replace(/\s+$/, '');

/** A line that holds only an address anchor: tree metadata a public checkout does not carry. */
function isAnchorLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') && anchorsOn(t).length > 0;
}

/** File line indices matching a hunk's old side from `i`, stepping over anchor lines; null when it does not match. */
function matchAt(lines: string[], i: number, oldBlock: string[]): number[] | null {
  const at: number[] = [];
  let j = i;
  for (let k = 0; k < oldBlock.length; k++) {
    while (j < lines.length && norm(lines[j]) !== oldBlock[k] && isAnchorLine(lines[j]) && k > 0) j++;
    if (j >= lines.length || norm(lines[j]) !== oldBlock[k]) return null;
    at.push(j++);
  }
  return at;
}

/**
 * Apply hunks by content: each hunk's old side is looked for as a block, nearest its stated
 * line first, so a diff written against an older revision of the file still lands where its
 * context matches. Anchor lines inside the block are stepped over and kept: a diff made on a
 * checkout without them still lands. A hunk whose context is nowhere in the file fails the
 * whole apply.
 */
export function applyHunks(original: string, hunks: Hunk[]): Applied | { error: string } {
  let lines = original.split('\n');
  const ranges: Applied['ranges'] = [];
  let shift = 0;
  for (const h of hunks) {
    const oldBlock = h.lines.filter(x => x.op !== '+').map(x => norm(x.text));
    const want = Math.max(0, h.oldStart - 1 + shift);
    let best: number[] | null = null;
    for (let i = 0; i + oldBlock.length <= lines.length; i++) {
      const at = matchAt(lines, i, oldBlock);
      if (at && (!best || Math.abs(i - want) < Math.abs(best[0] - want))) best = at;
    }
    if (!best && oldBlock.length) return { error: `hunk @@ -${h.oldStart} does not apply: its context is not in the file` };
    const first = best ? best[0] : want;
    const last = best ? best[best.length - 1] + 1 : want;
    const out: string[] = [];
    const added: Array<[number, string]> = [];
    const removed: Array<[number, string]> = [];
    let cursor = first;
    let k = 0;
    for (const x of h.lines) {
      if (x.op === '+') { out.push(x.text); added.push([first + out.length, x.text]); continue; }
      const j = best![k++];
      while (cursor < j) out.push(lines[cursor++]); // anchor lines stepped over
      if (x.op === ' ') out.push(lines[j]);
      else removed.push([first + out.length + 1, lines[j]]);
      cursor = j + 1;
    }
    lines = [...lines.slice(0, first), ...out, ...lines.slice(last)];
    shift += out.length - (last - first);
    ranges.push({ hunk: h, start: first + 1, end: first + out.length, added, removed });
  }
  return { text: lines.join('\n'), ranges };
}

export function lineAt(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** The definition carrying `// 1.14d: <addr>` in a file's text. */
export function findByAddress(text: string, address: string): FunctionExtent | undefined {
  const a = normalizeAddress(address);
  return scanCpp(text)?.functions.find(f => f.address === a);
}

/** The definition's signature as tokens, `{` excluded: what Ghidra owns. */
export function signatureTokens(text: string, ext: FunctionExtent): string[] {
  return (lexTokens(text.slice(ext.start, ext.bodyStart)) ?? []).map(t => t.text);
}

/** Addresses named by an anchor comment on a diff line. */
export function anchorsOn(line: string): string[] {
  return lexBody(line).comments.map(c => markerAddress(c.text)).filter((a): a is string => !!a);
}

export const isHeaderPath = (p: string) => p.endsWith('.h') || p.endsWith('.hpp') || p.endsWith('.inl');
