/**
 * The one definition of `dh`, the decompile hash a VC8 tag (vc8form, vc8linkage,
 * vc8datalinkage) records and a source map carries.
 *
 * The text hashed is Ghidra's decompile of the function exactly as Ghidra prints it: the
 * `pseudocode` of a decompile call, the `decompiled` of a snapshot record. Never the text
 * after the generator has rewritten it (template names respelled, a funclet inlined):
 * the people and tools that write a tag only ever see Ghidra's text, so that is the only
 * text both sides can hash alike.
 *
 *   dh = the first 8 hex digits of SHA-256(UTF-8 of vc8formBodyForm(decompile))
 *
 * This file has no imports and is copied verbatim into redivivus-app
 * (scripts/vc8form-sync.mjs), whose proposal checker runs on Workers: the digest is passed
 * in, so the same code serves node:crypto here and WebCrypto there.
 */

/** Hex digits of the SHA-256 a `dh` keeps. */
export const VC8FORM_DH_DIGITS = 8;

/** `dh` of a Ghidra decompile, given a SHA-256 hex digest of a UTF-8 string. */
export function vc8formDh(decompiled: string, sha256Hex: (text: string) => string): string;
export function vc8formDh(decompiled: string, sha256Hex: (text: string) => Promise<string>): Promise<string>;
export function vc8formDh(decompiled: string, sha256Hex: (text: string) => string | Promise<string>): string | Promise<string> {
  const hex = sha256Hex(vc8formBodyForm(decompiled));
  return typeof hex === 'string' ? hex.slice(0, VC8FORM_DH_DIGITS) : hex.then(h => h.slice(0, VC8FORM_DH_DIGITS));
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
