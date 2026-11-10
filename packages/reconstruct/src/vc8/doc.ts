/**
 * One source text as the VC8 translator sees it: the project lexer's tokens with their byte
 * ranges, the comment and directive ranges between them, and the bracket pairs.
 *
 * Every rewrite locates its construct here and edits the text at token offsets, so the text
 * between tokens - whitespace, comments, directives - is carried over untouched and the line
 * count never moves unless a rewrite means it to.
 */

import { Lexer, TokenKind as K, TriviaKind } from '@ghidra-mcp/cpp-parser';

export { K };

export interface Tok {
  k: K;
  t: string;
  /** Byte range in the text. */
  s: number;
  e: number;
}

export interface Range {
  s: number;
  e: number;
}

/**
 * Tokens the lexer glues that this code never means glued: `[[`/`]]` are two brackets in
 * `a[b[0]]`, and the digraphs never occur as such. Splitting them keeps bracket matching and
 * the character-level tests exact.
 */
const SPLIT = new Map<string, K[]>(Object.entries({
  '[[': [K.LeftBracket, K.LeftBracket],
  ']]': [K.RightBracket, K.RightBracket],
  '<:': [K.Less, K.Colon],
  ':>': [K.Colon, K.Greater],
  '<%': [K.Less, K.Percent],
  '%>': [K.Percent, K.Greater],
  '%:': [K.Percent, K.Colon],
  '%:%:': [K.Percent, K.Colon, K.Percent, K.Colon],
}));

const OPEN: Partial<Record<K, K>> = { [K.LeftParen]: K.RightParen, [K.LeftBracket]: K.RightBracket, [K.LeftBrace]: K.RightBrace };
const CLOSE: Partial<Record<K, K>> = { [K.RightParen]: K.LeftParen, [K.RightBracket]: K.LeftBracket, [K.RightBrace]: K.LeftBrace };

export function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
}

export function isWordChar(c: string | undefined): boolean {
  if (!c) return false;
  const x = c.charCodeAt(0);
  return (x >= 48 && x <= 57) || (x >= 65 && x <= 90) || (x >= 97 && x <= 122) || x === 95;
}

export function isWordStart(c: string | undefined): boolean {
  return isWordChar(c) && !(c! >= '0' && c! <= '9');
}

export class Doc {
  readonly toks: Tok[] = [];
  /** For a bracket token, the index of its partner; -1 when it has none. */
  readonly pair: Int32Array;
  readonly lineComments: Range[] = [];
  readonly blockComments: Range[] = [];
  readonly directives: Range[] = [];

  constructor(readonly text: string, filename = '<input>') {
    const lexed = new Lexer(text, { filename }).tokenizeWithTrivia();
    for (const { leadingTrivia, token, trailingTrivia } of lexed) {
      for (const tr of [...leadingTrivia, ...trailingTrivia]) {
        const r = { s: tr.location.start.offset, e: tr.location.end.offset };
        if (tr.kind === TriviaKind.LineComment) this.lineComments.push(r);
        else if (tr.kind === TriviaKind.BlockComment) this.blockComments.push(r);
        else if (tr.kind === TriviaKind.Directive) this.directives.push(r);
      }
      if (token.kind === K.EOF) continue;
      const s = token.location.start.offset;
      const parts = SPLIT.get(token.text);
      if (parts) {
        let o = s;
        for (const k of parts) {
          this.toks.push({ k, t: text[o], s: o, e: o + 1 });
          o += 1;
        }
      } else {
        this.toks.push({ k: token.kind, t: token.text, s, e: s + token.text.length });
      }
    }
    for (const list of [this.lineComments, this.blockComments, this.directives]) list.sort((a, b) => a.s - b.s);
    this.pair = new Int32Array(this.toks.length).fill(-1);
    const stacks: Partial<Record<K, number[]>> = { [K.LeftParen]: [], [K.LeftBracket]: [], [K.LeftBrace]: [] };
    this.toks.forEach((tk, i) => {
      if (OPEN[tk.k] !== undefined) stacks[tk.k]!.push(i);
      else {
        const o = CLOSE[tk.k];
        if (o !== undefined) {
          const j = stacks[o]!.pop();
          if (j !== undefined) {
            this.pair[i] = j;
            this.pair[j] = i;
          }
        }
      }
    });
  }

  get length(): number {
    return this.toks.length;
  }

  k(i: number): K | undefined {
    return this.toks[i]?.k;
  }

  t(i: number): string | undefined {
    return this.toks[i]?.t;
  }

  /** Text between token i-1 and token i (from the start of the text for i = 0). */
  gap(i: number): string {
    return this.text.slice(i > 0 ? this.toks[i - 1].e : 0, this.toks[i].s);
  }

  /** The gap before token i holds whitespace only (possibly none). */
  wsBefore(i: number): boolean {
    return allSpace(this.text, i > 0 ? this.toks[i - 1].e : 0, this.toks[i].s);
  }

  /** The gap before token i is empty. */
  tight(i: number): boolean {
    return i > 0 && this.toks[i - 1].e === this.toks[i].s;
  }

  /**
   * Only spaces and tabs stand between the start of token i's line - or `from`, when that is
   * later - and the token.
   */
  lineLead(i: number, from = 0): boolean {
    const s = this.toks[i].s;
    const ls = Math.max(from, this.text.lastIndexOf('\n', s - 1) + 1);
    for (let p = ls; p < s; p++) {
      const c = this.text[p];
      if (c !== ' ' && c !== '\t') return false;
    }
    return true;
  }

  /** Offset of the start of the line holding `offset`. */
  lineStart(offset: number): number {
    return this.text.lastIndexOf('\n', offset - 1) + 1;
  }

  /** Token i starts a word: an identifier or a keyword. */
  word(i: number): boolean {
    return isWordStart(this.toks[i]?.t[0]);
  }

  /** The line comment holding offset p, if any. */
  lineCommentAt(p: number): Range | undefined {
    return containing(this.lineComments, p);
  }

  blockCommentAt(p: number): Range | undefined {
    return containing(this.blockComments, p);
  }

  /** Index of the first token starting at or after offset p. */
  tokenAt(p: number): number {
    let lo = 0;
    let hi = this.toks.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.toks[m].s < p) lo = m + 1;
      else hi = m;
    }
    return lo;
  }
}

export function allSpace(text: string, a: number, b: number): boolean {
  for (let p = a; p < b; p++) if (!isSpace(text[p])) return false;
  return true;
}

function containing(list: Range[], p: number): Range | undefined {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (list[m].s <= p) lo = m + 1;
    else hi = m;
  }
  const r = list[lo - 1];
  return r && r.s <= p && p < r.e ? r : undefined;
}

/** Text edits at byte offsets of one text, applied together. */
export interface Edit {
  s: number;
  e: number;
  text: string;
}

export function applyEdits(text: string, edits: Edit[]): string {
  if (!edits.length) return text;
  const order = edits.map((ed, i) => ({ ed, i })).sort((a, b) => a.ed.s - b.ed.s || a.i - b.i);
  let out = '';
  let pos = 0;
  for (const { ed } of order) {
    if (ed.s < pos) throw new Error(`overlapping edits at offset ${ed.s}`);
    out += text.slice(pos, ed.s) + ed.text;
    pos = ed.e;
  }
  return out + text.slice(pos);
}

export function countNewlines(text: string, a = 0, b = text.length): number {
  let n = 0;
  for (let p = text.indexOf('\n', a); p >= 0 && p < b; p = text.indexOf('\n', p + 1)) n++;
  return n;
}
