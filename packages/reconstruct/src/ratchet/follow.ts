/**
 * Carry hand-written files (Redivivus/, support/) through a regen's renames.
 *
 * A hand file names engine symbols the way the tree spelled them when it was written. When
 * a regen renames or moves one, every such reference resolves to nothing. `follow` binds the
 * file's references under the index of the tree before the regen and spells them again under
 * the index after it: a function moved to another namespace gets its new qualification, a
 * renamed global or field its new name, a callee whose parameter list changed has its
 * arguments re-ordered by parameter name (a dropped side-effect-free argument goes), and the
 * header that now declares a moved function is included where the old one was.
 *
 * Hand files use macros the C++ parser does not know (WINAPI, CALLBACK, ...), so this works
 * on the lexer's tokens: a reference is a qualified name not preceded by `.`, `->` or `::`.
 * Unqualified names are followed only when they are called and denote a function, because a
 * hand file's locals are not known here.
 */
import { TokenKind, TriviaKind } from '@ghidra-mcp/cpp-parser';

import type { Binding, Site, SiteScan } from './refs.js';
import { rewriteBody } from './rewrite.js';
import { lexTokens, matchParen, type Tok } from './scan.js';
import type { SymbolIndex } from './symbol-index.js';

export interface FollowResult {
  text: string;
  changed: boolean;
  renames: string[];
  includes: string[];
  errors: string[];
}

function argRanges(toks: Tok[], open: number): { close: number; args: Array<[number, number]>; pure: boolean[] } | undefined {
  const close = matchParen(toks, open);
  if (close < 0) return undefined;
  const args: Array<[number, number]> = [];
  const pure: boolean[] = [];
  let depth = 0;
  let segStart = open + 1;
  let effect = false;
  const flush = (end: number) => {
    if (end <= segStart) return;
    args.push([toks[segStart].start, toks[end - 1].end]);
    pure.push(!effect);
    effect = false;
  };
  for (let k = open + 1; k < close; k++) {
    const t = toks[k];
    if (t.kind === TokenKind.LeftParen) {
      if (toks[k - 1]?.kind === TokenKind.Identifier && toks[k - 1].text !== 'sizeof') effect = true;
      depth++;
    } else if (t.kind === TokenKind.RightParen || t.kind === TokenKind.RightBracket || t.kind === TokenKind.RightBrace) depth--;
    else if (t.kind === TokenKind.LeftBracket || t.kind === TokenKind.LeftBrace) depth++;
    else if (t.kind === TokenKind.PlusPlus || t.kind === TokenKind.MinusMinus || t.kind === TokenKind.Equal
      || (t.text.length >= 2 && t.text.endsWith('=') && !['==', '!=', '<=', '>='].includes(t.text))) effect = true;
    else if (t.kind === TokenKind.Comma && depth === 0) { flush(k); segStart = k + 1; }
  }
  flush(close);
  return { close, args, pure };
}

/** The reference sites of a whole hand file, with their bindings under `index`. */
export function handSites(text: string, toks: Tok[], index: SymbolIndex): { sites: Site[]; bindings: Array<Binding | undefined>; scopes: string[][] } {
  const sites: Site[] = [];
  const bindings: Array<Binding | undefined> = [];
  const scopes: string[][] = [];
  const nsStack: Array<string[] | undefined> = [];
  const scope = () => nsStack.flatMap(s => s ?? []);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === TokenKind.EOF) break;
    if (t.kind === TokenKind.Namespace && toks[i + 1]?.kind === TokenKind.Identifier) {
      const parts: string[] = [];
      let k = i + 1;
      while (toks[k]?.kind === TokenKind.Identifier) {
        parts.push(toks[k].text);
        if (toks[k + 1]?.kind === TokenKind.ColonColon) k += 2; else { k++; break; }
      }
      if (toks[k]?.kind === TokenKind.LeftBrace) { nsStack.push(parts); i = k; continue; }
    }
    if (t.kind === TokenKind.LeftBrace) { nsStack.push(undefined); continue; }
    if (t.kind === TokenKind.RightBrace) { nsStack.pop(); continue; }
    const startsName = t.kind === TokenKind.Identifier || (t.kind === TokenKind.ColonColon && toks[i + 1]?.kind === TokenKind.Identifier);
    if (!startsName) continue;
    const prev = toks[i - 1];
    if (prev && (prev.kind === TokenKind.Dot || prev.kind === TokenKind.Arrow || prev.kind === TokenKind.ColonColon)) {
      if (t.kind === TokenKind.Identifier && prev.kind !== TokenKind.ColonColon) {
        // A member name: followed by its candidate owners.
        const owners = index.fieldOwners.get(t.text);
        if (owners && owners.length > 0) {
          sites.push({ kind: 'member', start: t.start, end: t.end, parts: [t.text], isGlobal: false });
          bindings.push({ k: 'fdc', c: owners.map(o => [o.s, o.o] as [string, number]) });
          scopes.push(scope());
        }
      }
      continue;
    }
    const isGlobal = t.kind === TokenKind.ColonColon;
    let k = isGlobal ? i + 1 : i;
    const parts: string[] = [];
    while (toks[k]?.kind === TokenKind.Identifier) {
      parts.push(toks[k].text);
      if (toks[k + 1]?.kind === TokenKind.ColonColon && toks[k + 2]?.kind === TokenKind.Identifier) k += 2; else break;
    }
    const last = k;
    const next = toks[last + 1];
    const called = next?.kind === TokenKind.LeftParen;
    const r = index.resolve(parts, isGlobal, scope());
    i = last;
    if (!r) continue;
    if (parts.length === 1 && !isGlobal && !(called && r.k === 'fn')) continue;
    const site: Site = { kind: r.k === 'ty' ? 'type' : 'name', start: t.start, end: toks[last].end, parts, isGlobal };
    let b: Binding = r;
    if (r.k === 'fn') {
      const p = r.a.length === 1 ? index.fnByAddr.get(r.a[0])?.params : undefined;
      b = p ? { k: 'fn', a: r.a, p: [...p] } : { k: 'fn', a: r.a };
      if (called) {
        const ar = argRanges(toks, last + 1);
        if (ar) site.call = { open: next.start, close: toks[ar.close].end, args: ar.args, pure: ar.pure };
      }
    }
    sites.push(site);
    bindings.push(b);
    scopes.push(scope());
  }
  return { sites, bindings, scopes };
}

/** Follow one hand file from the tree `before` describes to the tree `after` describes. */
export function followHandFile(text: string, before: SymbolIndex, after: SymbolIndex): FollowResult {
  const toks = lexTokens(text);
  if (!toks) return { text, changed: false, renames: [], includes: [], errors: ['does not lex'] };
  const { sites, bindings, scopes } = handSites(text, toks, before);
  // Keep only the sites whose meaning the regen changed: everything else stays as written.
  const keep: number[] = [];
  sites.forEach((s, i) => {
    const b = bindings[i]!;
    if (b.k === 'fdc') {
      const now = after.fieldOwners.get(s.parts[0]) ?? [];
      const all = b.c.every(([st, o]) => now.some(n => n.s === st && n.o === o));
      if (!all) keep.push(i);
      return;
    }
    const r = after.resolve(s.parts, s.isGlobal, scopes[i]);
    const same = r && r.k === b.k && JSON.stringify(r.k === 'fn' ? [...r.a].sort() : r) === JSON.stringify(b.k === 'fn' ? [...b.a].sort() : b);
    const paramsMoved = b.k === 'fn' && b.p && b.a.length === 1 && s.call && JSON.stringify(after.fnByAddr.get(b.a[0])?.params) !== JSON.stringify(b.p);
    if (!same || paramsMoved) keep.push(i);
  });
  if (keep.length === 0) return { text, changed: false, renames: [], includes: [], errors: [] };
  const kept: Array<Binding | undefined> = new Array(sites.length);
  for (const i of keep) kept[i] = bindings[i];
  const whole: SiteScan = {
    sites, bodyStart: 0, bodyEnd: text.length, params: [], siteHash: '', locals: new Map(), paramTypes: new Map(),
    root: undefined as never, toks,
  };
  const r = rewriteBody(text, whole, kept, { index: after, scope: [], params: [], scopeOf: i => scopes[i], partial: true });
  let out = r.text ?? text;
  const renames = r.renames;
  const errors: string[] = [...r.errors];

  // Include the header that now declares a moved function, where the old one was included.
  const includes: string[] = [];
  const includeLines = new Map<string, number>();
  for (const t of toks) for (const tr of t.lead) {
    if (tr.kind !== TriviaKind.Directive) continue;
    const m = tr.text.trim();
    if (!m.startsWith('#include')) continue;
    const q1 = m.indexOf('"');
    const q2 = m.indexOf('"', q1 + 1);
    if (q1 > 0 && q2 > q1) includeLines.set(m.slice(q1 + 1, q2), tr.start);
  }
  const want = new Map<string, string>();
  for (const i of keep) {
    const b = bindings[i]!;
    if (b.k !== 'fn' || b.a.length !== 1) continue;
    const oldH = before.fnByAddr.get(b.a[0])?.header;
    const newH = after.fnByAddr.get(b.a[0])?.header;
    if (oldH && newH && oldH !== newH && includeLines.has(oldH) && !includeLines.has(newH)) want.set(newH, oldH);
  }
  for (const [newH, oldH] of want) {
    // After the old header's line, in the text as edited so far.
    const marker = `#include "${oldH}"`;
    const at = out.indexOf(marker);
    if (at < 0) continue;
    const eol = out.indexOf('\n', at);
    out = `${out.slice(0, eol + 1)}#include "${newH}"\n${out.slice(eol + 1)}`;
    includes.push(newH);
  }
  return { text: out, changed: out !== text, renames, includes, errors };
}
