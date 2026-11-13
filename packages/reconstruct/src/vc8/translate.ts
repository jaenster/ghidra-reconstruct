/**
 * The source tree in a form Visual C++ 2005 compiles: the rewrites, one file at a time.
 *
 * Every rewrite is LINE-PRESERVING - no line is added or removed - so __LINE__ (which assert
 * sites embed) and every compiler diagnostic map 1:1 back to the real file. Each rewrite finds
 * its construct in the token stream and edits the text at token offsets; the text between
 * tokens, comments and directives included, is copied as it is.
 *
 *   namespace A::B {          ->  namespace A { namespace B {      and its `}` -> `}}`
 *   struct __attribute__((packed)) S { ... };
 *                             ->  __pragma(pack(push, 1)) struct S { ... }; __pragma(pack(pop))
 *   __attribute__((noinline)) ->  __declspec(noinline)
 *   T() = default;            ->  (blanked), or T() {} if T has other constructors
 *   T x{args};                ->  T x(args);
 *   x = {};                   ->  memset(&(x), 0, sizeof(x));
 *   template<> T C<A>::m;     ->  (blanked, in headers): VC8 takes it for a definition
 *   0b1010                    ->  0xa
 *   [[attribute]]             ->  (removed)
 *   T __thiscall f(A a, B b)  ->  T __fastcall f(A a, int, B b)
 *   T (__thiscall *p)(A, B)   ->  T (__fastcall *p)(A, int, B)
 *   f(a, b)  /  x->p(a, b)    ->  vc8_thiscall(f)(a, b)  /  vc8_thiscall(x->p)(a, b)
 *       VC8 accepts __thiscall only on member functions (C3865); __fastcall with an unused int
 *       second parameter is the same callee. A call casts the callee back to the __thiscall
 *       pointer type (vc8_compat.h), so the caller loads no EDX; a callee declared static or
 *       inline, or one whose expression cannot be delimited, gets the unused int instead.
 *       A function is known by its qualified name and parameter count; one also declared
 *       without __thiscall under that name and count is left stripped (compiled __cdecl).
 *   extern "C" __stdcall T f( ->  extern "C" T __stdcall f(
 *   constructors of a struct that is a union member  ->  (blanked; C2620)
 *   T x[] = {{a, b}, {}}      ->  T x[] = {T(a, b), T()}     (for a T with constructors)
 *   T x = {};                 ->  T x = {0};
 *
 * A function the compiler cannot build at all is QUARANTINED: its body is blanked to
 * `{ __assume(0); }` with its lines kept, for the lines quarantine.tsv names.
 */

import { Doc, K, applyEdits, countNewlines, isSpace, isWordChar, type Edit } from './doc.js';
import {
  argList, qualifierBefore, scopes, secondItemAt, statementStart, thiscallDeclAt,
} from './syntax.js';
import { heads, listInitAt, packedAttr, resolveCall, thiscallPtrAt, type TreeState } from './facts.js';
import { expressionStruct, functionVariables } from './types.js';
import { argNestPass, type ArgNestMode, type ArgNestSite } from './argnest.js';

/** VC8_ARGNEST (`values`, `calls`, `off`) overrides which temporaries argnest.ts nests, for an A/B measurement. */
function argNestMode(): ArgNestMode {
  const m = process.env.VC8_ARGNEST;
  return m === 'off' || m === 'calls' || m === 'values' ? m : 'values';
}

/** With VC8_ARGNEST_SITES set, the nested calls per file, for the CLI to report. */
export const argNestSites: Record<string, ArgNestSite[]> | null = process.env.VC8_ARGNEST_SITES ? {} : null;

export const PLATFORM_H = 'Source/D2Headers/d2_platform.h';

// ---------------------------------------------------------------------------------------------
// Syntax VC8 lacks

const BRACE_INIT_BAD = new Set(['struct', 'class', 'union', 'enum', 'namespace', 'typedef', 'return', 'else', 'do']);

function syntaxPass(text: string, header: boolean): string {
  const doc = new Doc(text);
  const edits: Edit[] = [];
  const { toks } = doc;
  const n = doc.length;

  // namespace A::B {  ->  namespace A { namespace B {
  for (let i = 0; i < n; i++) {
    if (doc.k(i) !== K.Namespace || !doc.lineLead(i)) continue;
    const parts: string[] = [];
    let j = i + 1;
    if (!(j < n && !doc.tight(j) && doc.wsBefore(j) && doc.k(j) === K.Identifier)) continue;
    parts.push(doc.t(j)!);
    while (doc.k(j + 1) === K.ColonColon && doc.tight(j + 1) && doc.k(j + 2) === K.Identifier && doc.tight(j + 2)) {
      parts.push(doc.t(j + 2)!);
      j += 2;
    }
    if (parts.length < 2 || doc.k(j + 1) !== K.LeftBrace || !doc.wsBefore(j + 1)) continue;
    edits.push({ s: toks[i].s, e: toks[j + 1].e, text: parts.map(p => `namespace ${p} {`).join(' ') });
    const close = doc.pair[j + 1];
    if (close >= 0) edits.push({ s: toks[close].s, e: toks[close].e, text: '}'.repeat(parts.length) });
  }

  // struct __attribute__((packed)) S { ... };
  let packedEnd = -1;
  for (let i = 0; i < n; i++) {
    const k = doc.k(i);
    if (k !== K.Struct && k !== K.Union && k !== K.Class) continue;
    if (!(i + 1 < n && !doc.tight(i + 1) && doc.wsBefore(i + 1) && packedAttr(doc, i + 1))) continue;
    if (toks[i].s < packedEnd) continue;
    let end = toks[i + 6].e;
    while (end < text.length && isSpace(text[end])) end++;
    let b = i + 7;
    while (b < n && doc.k(b) !== K.LeftBrace && doc.k(b) !== K.Semicolon) b++;
    const kw = doc.t(i)!;
    if (b >= n || doc.k(b) === K.Semicolon) {
      edits.push({ s: toks[i].s, e: end, text: kw + ' ' });
      continue;
    }
    const close = doc.pair[b];
    let semi = close + 1;
    while (semi < n && doc.k(semi) !== K.Semicolon) semi++;
    if (close < 0 || semi >= n) throw new Error(`unbalanced packed struct at offset ${toks[i].s}`);
    edits.push({ s: toks[i].s, e: end, text: '__pragma(pack(push, 1)) ' + kw + ' ' });
    edits.push({ s: toks[semi].e, e: toks[semi].e, text: ' __pragma(pack(pop))' });
    packedEnd = toks[semi].e;
  }

  // __attribute__((noinline))  ->  __declspec(noinline)
  for (let i = 0; i < n; i++) {
    if (doc.t(i) === '__attribute__' && doc.k(i + 1) === K.LeftParen && doc.wsBefore(i + 1) &&
        doc.k(i + 2) === K.LeftParen && doc.tight(i + 2) && doc.t(i + 3) === 'noinline' && doc.wsBefore(i + 3) &&
        doc.k(i + 4) === K.RightParen && doc.wsBefore(i + 4) && doc.k(i + 5) === K.RightParen && doc.tight(i + 5)) {
      edits.push({ s: toks[i].s, e: toks[i + 5].e, text: '__declspec(noinline)' });
    }
  }

  // T() = default;
  let defaultedEnd = -1;
  for (const h of heads(doc)) {
    if (toks[h.open].e < defaultedEnd) continue;
    const from = toks[h.open].e;
    const ctorAt = (j: number) => doc.k(j) === K.Identifier && doc.t(j) === h.name && doc.lineLead(j, from) &&
      doc.k(j + 1) === K.LeftParen && doc.wsBefore(j + 1);
    const dflt: number[] = [];
    let others = false;
    for (let j = h.open + 1; j < h.close; j++) {
      if (!ctorAt(j)) continue;
      if (doc.k(j + 2) === K.RightParen && doc.wsBefore(j + 2) && doc.k(j + 3) === K.Equal && doc.wsBefore(j + 3) &&
          doc.k(j + 4) === K.Default && doc.wsBefore(j + 4) && doc.k(j + 5) === K.Semicolon && doc.wsBefore(j + 5)) {
        dflt.push(j);
      } else others = true;
    }
    if (!dflt.length) continue;
    for (const j of dflt) {
      edits.push({ s: toks[j].s, e: toks[j + 5].e, text: others ? text.slice(toks[j].s, toks[j + 2].e) + ' {}' : '' });
    }
    defaultedEnd = toks[h.close].s;
  }

  for (let i = 0; i < n; i++) {
    // T x{args};  ->  T x(args);
    if (doc.lineLead(i) && doc.word(i) && !BRACE_INIT_BAD.has(doc.t(i)!)) {
      const b = braceInitAt(doc, i);
      if (b) {
        edits.push({ s: toks[b].s, e: toks[b].e, text: '(' });
        edits.push({ s: toks[doc.pair[b]].s, e: toks[doc.pair[b]].e, text: ')' });
      }
    }
    // x = {};  ->  memset(&(x), 0, sizeof(x));
    if (doc.lineLead(i) && doc.k(i) === K.Identifier) {
      const z = zeroAssignAt(doc, i);
      if (z) {
        const lv = text.slice(toks[i].s, toks[z.eq - 1].e);
        edits.push({ s: toks[i].s, e: toks[z.semi].e, text: `memset(&(${lv}), 0, sizeof(${lv}));` });
      }
    }
    // template<> T C<A>::m;  (headers)
    if (header && doc.k(i) === K.Template && doc.lineStart(toks[i].s) === toks[i].s) {
      const e = templateStaticDeclEnd(doc, i);
      if (e >= 0) edits.push({ s: toks[i].s, e, text: '' });
    }
    // 0b1010  ->  0xa
    if (doc.k(i) === K.IntegerLiteral) {
      const hex = binaryAsHex(doc.t(i)!);
      if (hex) edits.push({ s: toks[i].s, e: toks[i].e, text: hex });
    }
    // [[attribute]]
    if (doc.k(i) === K.LeftBracket && doc.k(i + 1) === K.LeftBracket && doc.tight(i + 1)) {
      const e = cxxAttributeEnd(doc, i);
      if (e >= 0) edits.push({ s: toks[i].s, e, text: '' });
    }
  }
  return applyEdits(text, edits);
}

/** The `{` of `T x{args};` (the `T` at token i), or null. */
function braceInitAt(doc: Doc, i: number): number | null {
  const n = doc.length;
  let j = i + 1;
  while (j < n && doc.tight(j) && (doc.word(j) || doc.k(j) === K.ColonColon || doc.k(j) === K.IntegerLiteral)) j++;
  if (doc.k(j) === K.Less && doc.tight(j)) {
    let m = j + 1;
    let lastGt = -1;
    for (; m < n; m++) {
      const t = doc.t(m)!;
      if (t.includes(';') || t.includes('{') || t.includes('}') || t.includes('(') || t.includes(')')) break;
      if (doc.k(m) === K.Greater) lastGt = m;
    }
    if (lastGt < 0) return null;
    j = lastGt + 1;
  }
  // [\s*&]+ - at least one character of whitespace, `*` or `&`.
  let sep = 0;
  for (;;) {
    if (!doc.wsBefore(j)) return null;
    sep += doc.gap(j).length;
    const k = doc.k(j);
    if (k === K.Star || k === K.Ampersand || k === K.AmpAmp) {
      sep++;
      j++;
      continue;
    }
    break;
  }
  if (!sep || doc.k(j) !== K.Identifier) return null;
  const b = j + 1;
  if (doc.k(b) !== K.LeftBrace || !doc.tight(b)) return null;
  const close = doc.pair[b];
  if (close < 0 || doc.k(close + 1) !== K.Semicolon || !doc.tight(close + 1)) return null;
  const inner = doc.text.slice(doc.toks[b].e, doc.toks[close].s);
  if (inner.includes('{') || inner.includes('}') || inner.includes(';')) return null;
  return b;
}

/** `lvalue = {};` with the lvalue at token i: the `=` and `;` tokens. */
function zeroAssignAt(doc: Doc, i: number): { eq: number; semi: number } | null {
  const n = doc.length;
  let j = i + 1;
  let afterArrow = false;
  while (j < n && doc.tight(j)) {
    const k = doc.k(j)!;
    if (doc.word(j) || k === K.IntegerLiteral || k === K.Dot || k === K.LeftBracket || k === K.RightBracket) {
      afterArrow = false;
      j++;
    } else if (k === K.Arrow) {
      afterArrow = true;
      j++;
    } else break;
  }
  if (afterArrow) return null;
  if (doc.k(j) !== K.Equal || !doc.wsBefore(j) || doc.k(j + 1) !== K.LeftBrace || !doc.wsBefore(j + 1) ||
      doc.k(j + 2) !== K.RightBrace || !doc.wsBefore(j + 2) || doc.k(j + 3) !== K.Semicolon || !doc.tight(j + 3)) return null;
  return { eq: j, semi: j + 3 };
}

/** End offset (trailing blanks included) of `template<> T C<A>::m[N];` at token i, or -1. */
function templateStaticDeclEnd(doc: Doc, i: number): number {
  const n = doc.length;
  if (doc.k(i + 1) !== K.Less || !doc.wsBefore(i + 1) || doc.k(i + 2) !== K.Greater || !doc.tight(i + 2)) return -1;
  let semi = i + 3;
  for (; semi < n && doc.k(semi) !== K.Semicolon; semi++) {
    const t = doc.t(semi)!;
    if (t.includes('=') || t.includes('(') || t.includes(')') || t.includes('{') || t.includes('}')) return -1;
  }
  if (semi >= n || !doc.wsBefore(semi)) return -1;
  let e = semi - 1;
  if (doc.k(e) === K.RightBracket && doc.pair[e] >= 0) {
    const o = doc.pair[e];
    if (doc.text.slice(doc.toks[o].e, doc.toks[e].s).includes(']') || !doc.wsBefore(o)) return -1;
    e = o - 1;
  }
  if (!(doc.k(e) === K.Identifier || doc.word(e)) || doc.k(e - 1) !== K.ColonColon || !doc.tight(e) || e - 1 <= i + 2) return -1;
  let end = doc.toks[semi].e;
  while (end < doc.text.length && (doc.text[end] === ' ' || doc.text[end] === '\t')) end++;
  if (end < doc.text.length && doc.text[end] !== '\n') return -1;
  return end;
}

/** `0b1010u` -> `0xau`; null for any other literal. */
export function binaryAsHex(t: string): string | null {
  if (!(t[0] === '0' && (t[1] === 'b' || t[1] === 'B'))) return null;
  let p = 2;
  while (p < t.length && (t[p] === '0' || t[p] === '1')) p++;
  if (p === 2) return null;
  for (let q = p; q < t.length; q++) if (!'uUlL'.includes(t[q])) return null;
  return '0x' + BigInt('0b' + t.slice(2, p)).toString(16) + t.slice(p);
}

/** End offset, trailing whitespace included, of `[[name(args)]]` opening at token i; -1 if none. */
function cxxAttributeEnd(doc: Doc, i: number): number {
  let j = i + 2;
  if (!doc.wsBefore(j) || doc.k(j) !== K.Identifier) return -1;
  while (doc.tight(j + 1) && (doc.word(j + 1) || doc.k(j + 1) === K.ColonColon)) j++;
  if (doc.k(j + 1) === K.LeftParen && doc.tight(j + 1)) {
    const c = doc.pair[j + 1];
    if (c < 0 || doc.text.slice(doc.toks[j + 1].e, doc.toks[c].s).includes(')')) return -1;
    j = c;
  }
  if (doc.k(j + 1) !== K.RightBracket || !doc.wsBefore(j + 1) || doc.k(j + 2) !== K.RightBracket || !doc.tight(j + 2)) return -1;
  let end = doc.toks[j + 2].e;
  while (end < doc.text.length && isSpace(doc.text[end])) end++;
  return end;
}

// ---------------------------------------------------------------------------------------------
// __thiscall

/** Calls through pointer fields since the process started: resolved through the object's struct, or by field name. */
export const ptrCallStats = { byStruct: 0, byName: 0 };

/** Collects the call-site insertions, composing the ones that land on one offset. */
class Inserts {
  private wraps = new Map<number, { lead: string; n: number }>();
  private closes = new Set<number>();
  private seconds: Edit[] = [];

  constructor(private readonly text: string) {}

  wrap(start: number, args: number): void {
    const w = this.wraps.get(start);
    if (w) w.n++;
    else {
      const before = this.closes.has(start) ? ')' : this.text[start - 1];
      this.wraps.set(start, { lead: start > 0 && isWordChar(before) ? ' ' : '', n: 1 });
    }
    this.closes.add(args);
  }

  second(at: number, text: string): void {
    this.seconds.push({ s: at, e: at, text: ', ' + text });
  }

  edits(): Edit[] {
    const out: Edit[] = [...this.seconds];
    for (const [s, w] of this.wraps) out.push({ s, e: s, text: w.lead + 'vc8_thiscall('.repeat(w.n) });
    for (const s of this.closes) out.push({ s, e: s, text: ')' });
    return out;
  }
}

function thiscallPass(text: string, state: TreeState): string {
  const doc = new Doc(text);
  const sc = scopes(doc);
  const { toks } = doc;
  const n = doc.length;
  const decl: Edit[] = [];
  // Parenthesis depth within the statement, counting the token's own `(`.
  const parens = new Int32Array(n);
  for (let i = 0, d = 0; i < n; i++) {
    const k = doc.k(i);
    if (k === K.LeftParen) d++;
    else if (k === K.RightParen) d = Math.max(0, d - 1);
    else if (k === K.LeftBrace || k === K.RightBrace || k === K.Semicolon) d = 0;
    parens[i] = d;
  }

  for (let i = 0; i < n; i++) {
    if (doc.k(i) !== K.CallingConvThiscall) continue;
    const d = thiscallDeclAt(doc, i);
    if (d) {
      const q = [...sc.table[sc.at[i]].names, ...d.qual, d.name].join('::');
      const list = argList(doc, d.nameAt + 1, true);
      if (list.close >= 0 && state.funcs.get(q)?.has(list.count)) {
        decl.push({ s: toks[i].s, e: toks[i].e, text: '__fastcall' });
        decl.push({ s: secondItemAt(list), e: secondItemAt(list), text: ', int' });
      } else {
        decl.push({ s: toks[i].s, e: toks[i + 1].s, text: '' });
      }
      continue;
    }
    const p = thiscallPtrAt(doc, i - 1);
    if (!p) continue;
    const list = argList(doc, p.params, true);
    // A struct's own field is known as Struct::field; any other named pointer by its name.
    const s = sc.table[sc.at[i]];
    const member = s.cls && !s.body && parens[i - 1] === 1 ? `${s.cls}::${p.name}` : null;
    const counts = member ? state.qptrs.get(member) : state.ptrs.get(p.name);
    const ok = list.close >= 0 && (p.name ? !!counts?.has(list.count) : list.count >= 1 && list.count < 64);
    if (ok) {
      decl.push({ s: toks[i].s, e: toks[i].e, text: '__fastcall' });
      decl.push({ s: secondItemAt(list), e: secondItemAt(list), text: ', int' });
    } else {
      decl.push({ s: toks[i - 1].e, e: toks[i].e, text: '' });
    }
  }

  const ins = new Inserts(text);
  // Calls of functions: f(...), ns::f(...).
  for (let i = 0; i < n; i++) {
    if (doc.k(i) !== K.Identifier || !state.names.has(doc.t(i)!)) continue;
    if (doc.k(i + 1) !== K.LeftParen || !doc.wsBefore(i + 1)) continue;
    const before = text[toks[i].s - 1];
    if (isWordChar(before) || before === '.' || before === '>') continue;
    const q = qualifierBefore(doc, i)!;
    const start = toks[q.first].s;
    if (headIsDeclaration(doc, start)) continue;
    const target = resolveCall(state, sc.table[sc.at[i]].names, q.qual, q.global, doc.t(i)!);
    const counts = target ? state.funcs.get(target) : undefined;
    const list = argList(doc, i + 1, false);
    if (!counts?.has(list.count)) continue;
    if (state.direct.has(target!)) ins.second(secondItemAt(list), '0');
    else ins.wrap(start, toks[i + 1].s);
  }
  // Calls through pointer fields: x->p(...), x.p(...). The field is the one of the struct the
  // object expression has, when its type can be told; else it is known by its name alone.
  const locals = new Map<number, Map<string, string>>();
  for (let i = 0; i < n; i++) {
    if (doc.k(i) !== K.Identifier || doc.k(i + 1) !== K.LeftParen || !doc.wsBefore(i + 1)) continue;
    const field = doc.t(i)!;
    if (!(state.ptrs.has(field) || state.qptrNames.has(field))) continue;
    if (!(doc.k(i - 1) === K.Arrow || doc.k(i - 1) === K.Dot) || !doc.wsBefore(i)) continue;
    const start = postfixStart(doc, i);
    let owner: string | null = null;
    if (start !== null && start < i - 1) {
      const fn = sc.table[sc.at[i]].fn;
      let vars = fn >= 0 ? locals.get(fn) : null;
      if (fn >= 0 && !vars) locals.set(fn, vars = functionVariables(doc, fn));
      owner = expressionStruct(doc, start, i - 1, state.types, vars ?? null);
      if (owner && !state.types.fields.has(owner)) owner = null;
    }
    const counts = owner ? state.qptrs.get(`${owner}::${field}`) : state.ptrs.get(field);
    if (owner) ptrCallStats.byStruct++;
    else ptrCallStats.byName++;
    if (!counts) continue;
    const list = argList(doc, i + 1, false);
    if (!counts.has(list.count)) continue;
    if (start === null) ins.second(secondItemAt(list), '0');
    else ins.wrap(toks[start].s, toks[i + 1].s);
  }
  // (*pfn)(...), pfn a local or a parameter.
  for (let i = 0; i < n; i++) {
    if (doc.k(i) !== K.LeftParen || doc.k(i + 1) !== K.Star || !doc.wsBefore(i + 1)) continue;
    const name = i + 2;
    const counts = doc.k(name) === K.Identifier && doc.wsBefore(name) ? state.ptrs.get(doc.t(name)!) : undefined;
    if (!counts || doc.k(name + 1) !== K.RightParen || !doc.wsBefore(name + 1) ||
        doc.k(name + 2) !== K.LeftParen || !doc.wsBefore(name + 2)) continue;
    if (!counts.has(argList(doc, name + 2, false).count)) continue;
    ins.wrap(toks[i].s, toks[name + 2].s);
  }
  return applyEdits(text, [...decl, ...ins.edits()]);
}

/**
 * Whether the qualified name starting at `start` is declared there rather than called: the
 * text before it ends in a type - a word or a template's `>`, possibly followed by `*`/`&` -
 * or in a lone `*`/`&`, and not in `return`, `else`, `case` or `throw`. Read as characters
 * back from `start` over at most 200 of them, line comments dropped.
 */
export function headIsDeclaration(doc: Doc, start: number): boolean {
  const text = doc.text;
  const lo = Math.max(0, start - 200);
  let p = start;
  const back = (): string | null => {
    while (p > lo) {
      const lc = doc.lineCommentAt(p - 1);
      if (lc && lc.s >= lo) {
        p = lc.s;
        continue;
      }
      return text[--p];
    }
    return null;
  };
  const peek = (): string | null => {
    const save = p;
    const c = back();
    p = save;
    return c;
  };
  let c = back();
  while (c !== null && isSpace(c)) c = back();
  if (c === null) return false;
  const endWord = p;
  let decl = false;
  if (c === '*' || c === '&') {
    const prev = peek();
    if (prev !== '&') decl = true;
    else {
      let d: string | null = c;
      while (d === '*' || d === '&') d = back();
      while (d !== null && isSpace(d)) d = back();
      decl = d !== null && (isWordChar(d) || d === '>');
    }
    return decl;
  }
  if (!(isWordChar(c) || c === '>')) return false;
  // A word: the declaration test passes unless the word is return/else/case/throw.
  p = endWord + 1;
  let w = '';
  let d = back();
  while (d !== null && isWordChar(d)) {
    w = d + w;
    d = back();
  }
  return !['return', 'else', 'case', 'throw'].includes(w);
}

/**
 * Token where the postfix expression begins whose member name - reached through `->` or `.`
 * - is token i: back over member accesses, subscripts, calls and names to a parenthesised
 * primary or the first name. null for a shape it does not know.
 */
export function postfixStart(doc: Doc, i: number): number | null {
  for (;;) {
    if (!doc.wsBefore(i)) return i;
    const op = doc.k(i - 1);
    if (!(op === K.Arrow || op === K.ColonColon || op === K.Dot)) return i;
    let j = i - 1;
    let primary = -1;
    while (doc.wsBefore(j) && (doc.k(j - 1) === K.RightParen || doc.k(j - 1) === K.RightBracket)) {
      const close = j - 1;
      const open = backMatch(doc, close);
      if (open < 0) return null;
      const prev = open > 0 && doc.wsBefore(open) ? doc.toks[open - 1].t : '';
      const last = prev[prev.length - 1];
      if (doc.k(close) === K.RightParen && !(isWordChar(last) || last === ')' || last === ']')) {
        primary = open;
        break;
      }
      j = open;
    }
    if (primary >= 0) {
      i = primary;
      continue;
    }
    if (!doc.wsBefore(j) || j === 0) return null;
    const w = j - 1;
    if (!doc.word(w) || doc.k(w) === K.IntegerLiteral) return null;
    i = w;
  }
}

/** The bracket opening the `)` or `]` at token `close`, or -1 when a `;`, `{` or `}` lies between. */
function backMatch(doc: Doc, close: number): number {
  const open = doc.pair[close];
  if (open < 0) return -1;
  for (let j = open + 1; j < close; j++) {
    const k = doc.k(j);
    if (k === K.Semicolon || k === K.LeftBrace || k === K.RightBrace) return -1;
  }
  return open;
}

// ---------------------------------------------------------------------------------------------
// Calling conventions

/** Any `__thiscall` left (one VC8 does not take where it is written) goes, with its blanks. */
function stripThiscallPass(text: string): string {
  const doc = new Doc(text);
  const edits: Edit[] = [];
  for (const tk of doc.toks) {
    if (tk.k !== K.CallingConvThiscall) continue;
    let e = tk.e;
    while (text[e] === ' ' || text[e] === '\t') e++;
    edits.push({ s: tk.s, e, text: '' });
  }
  return applyEdits(text, edits);
}

const CONV_FIRST = new Set<K>([K.CallingConvStdcall, K.CallingConvCdecl, K.CallingConvFastcall]);
const CONV_PREFIX = new Set(['const', 'struct', 'unsigned', 'signed']);

/** `__stdcall T f(`  ->  `T __stdcall f(`: GCC takes a convention before the type, MSVC only after. */
function conventionPass(text: string): string {
  const doc = new Doc(text);
  const edits: Edit[] = [];
  const spaced = (j: number) => j < doc.length && !doc.tight(j) && doc.wsBefore(j);
  for (let c = 0; c < doc.length; c++) {
    if (!CONV_FIRST.has(doc.k(c)!) || !spaced(c + 1)) continue;
    let max = 0;
    while (CONV_PREFIX.has(doc.t(c + 1 + max)!) && spaced(c + 2 + max)) max++;
    for (let np = max; np >= 0; np--) {
      const t0 = c + 1 + np;
      if (!doc.word(t0)) continue;
      let e = t0;
      while (doc.tight(e + 1) && (doc.word(e + 1) || doc.k(e + 1) === K.ColonColon || doc.k(e + 1) === K.IntegerLiteral)) e++;
      const tryEnd = (typeEnd: number): number => {
        const name = typeEnd + 1;
        if (!spaced(name) || doc.k(name) !== K.Identifier) return -1;
        if (doc.k(name + 1) !== K.LeftParen || !doc.wsBefore(name + 1)) return -1;
        return name;
      };
      let name = -1;
      let typeEnd = e;
      if (doc.k(e + 1) === K.Star && doc.wsBefore(e + 1)) {
        let s = e + 1;
        while (doc.k(s + 1) === K.Star && doc.tight(s + 1)) s++;
        name = tryEnd(s);
        if (name >= 0) typeEnd = s;
      }
      if (name < 0) name = tryEnd(e);
      if (name < 0) continue;
      const type = text.slice(doc.toks[c + 1].s, doc.toks[typeEnd].e);
      edits.push({ s: doc.toks[c].s, e: doc.toks[name + 1].e, text: `${type} ${doc.t(c)} ${doc.t(name)}(` });
      break;
    }
  }
  return applyEdits(text, edits);
}

// ---------------------------------------------------------------------------------------------
// Constructors and aggregates

/** Blank every constructor of the named structs, keeping the line count. */
function stripCtorsPass(text: string, names: Set<string>): string {
  const doc = new Doc(text);
  const edits: Edit[] = [];
  let pos = -1;
  for (const h of heads(doc)) {
    if (!names.has(h.name) || doc.toks[h.open].e < pos) continue;
    const from = doc.toks[h.open].e;
    let p = -1;
    for (let j = h.open + 1; j < h.close; j++) {
      if (doc.k(j) !== K.Identifier || doc.t(j) !== h.name || !doc.lineLead(j, from) ||
          doc.k(j + 1) !== K.LeftParen || !doc.wsBefore(j + 1)) continue;
      const s = Math.max(from, doc.lineStart(doc.toks[j].s));
      if (s < p) continue;
      let k = j + 2;
      while (k < h.close && doc.k(k) !== K.Semicolon && doc.k(k) !== K.LeftBrace) k++;
      let end: number;
      if (k >= h.close) break;
      if (doc.k(k) === K.Semicolon) end = doc.toks[k].e;
      else {
        if (doc.pair[k] < 0 || doc.pair[k] >= h.close) break;
        end = doc.toks[doc.pair[k]].e;
      }
      edits.push({ s, e: end, text: '\n'.repeat(countNewlines(text, s, end)) });
      p = end;
      j = doc.tokenAt(end) - 1;
    }
    pos = doc.toks[h.close].s;
  }
  return applyEdits(text, edits);
}

/**
 * `T x = {a, b};` -> `T x = T(a, b);`, `T x[] = {{a, b}, {}}` -> `{T(a, b), T()}` for the
 * named structs, then `= {};` -> `= {0};` for what is left.
 */
function aggregatePass(text: string, construct: Set<string>): string {
  const doc = new Doc(text);
  const edits: Edit[] = [];
  const edited = new Set<number>();
  let pos = -1;
  if (construct.size) {
    for (let i = 0; i < doc.length; i++) {
      if (doc.toks[i].s < pos) continue;
      const li = listInitAt(doc, i);
      if (!li || !construct.has(li.type)) continue;
      const close = doc.pair[li.open];
      if (close < 0) continue;
      let depth = 0;
      for (let j = li.open; j <= close; j++) {
        const k = doc.k(j);
        if (k === K.LeftBrace) {
          depth++;
          if (depth === li.rank + 1) {
            const end = doc.pair[j];
            if (end >= 0 && !text.slice(doc.toks[j].e, doc.toks[end].s).includes('{')) {
              edits.push({ s: doc.toks[j].s, e: doc.toks[j].e, text: li.type + '(' });
              edits.push({ s: doc.toks[end].s, e: doc.toks[end].e, text: ')' });
              edited.add(j);
              depth--;
              j = end;
            }
          }
        } else if (k === K.RightBrace) depth--;
      }
      pos = doc.toks[close].e;
    }
  }
  for (let i = 0; i + 3 < doc.length; i++) {
    if (doc.k(i) === K.Equal && doc.k(i + 1) === K.LeftBrace && doc.wsBefore(i + 1) && !edited.has(i + 1) &&
        doc.k(i + 2) === K.RightBrace && doc.wsBefore(i + 2) && doc.k(i + 3) === K.Semicolon && doc.wsBefore(i + 3)) {
      edits.push({ s: doc.toks[i + 1].s, e: doc.toks[i + 2].e, text: '{0}' });
    }
  }
  return applyEdits(text, edits);
}

// ---------------------------------------------------------------------------------------------
// The platform header's toolchain glue

const RAD_IJL_IMPORTS = ['SmackOpen', 'SmackClose', 'SmackDoFrame', 'SmackNextFrame', 'SmackWait',
  'SmackToBuffer', 'BinkOpen', 'BinkClose', 'BinkDoFrame', 'BinkNextFrame', 'BinkWait', 'BinkCopyToBuffer',
  'BinkSetSoundSystem', 'BinkOpenDirectSound', 'BinkDDSurfaceType', 'ijlInit', 'ijlFree', 'ijlWrite'];

/** A whole-line replacement, or an insertion after a line's `extern "C" `. */
interface Patch {
  what: string;
  /** Offsets the patch applies at; it must find exactly one. */
  find(text: string): number[];
  apply(text: string, at: number): string;
}

function linePatch(line: string, repl: string): Patch {
  return {
    what: line,
    find(text) {
      const out: number[] = [];
      for (let p = text.indexOf(line); p >= 0; p = text.indexOf(line, p + 1)) {
        const atStart = p === 0 || text[p - 1] === '\n';
        const end = p + line.length;
        if (atStart && (end === text.length || text[end] === '\n')) out.push(p);
      }
      return out;
    },
    apply: (text, at) => text.slice(0, at) + repl + text.slice(at + line.length),
  };
}

function dllimportPatch(name: string): Patch {
  const lead = 'extern "C" ';
  return {
    what: `extern "C" ... __stdcall ${name}(`,
    find(text) {
      const out: number[] = [];
      for (let p = text.indexOf(lead); p >= 0; p = text.indexOf(lead, p + 1)) {
        if (!(p === 0 || text[p - 1] === '\n')) continue;
        let j = p + lead.length;
        while (j < text.length && text[j] !== ';' && text[j] !== '(') j++;
        if (text[j] === '(' && text.slice(p + lead.length, j).endsWith(` __stdcall ${name}`)) out.push(p);
      }
      return out;
    },
    apply: (text, at) => text.slice(0, at + lead.length) + '__declspec(dllimport) ' + text.slice(at + lead.length),
  };
}

export const FILE_PATCHES: Record<string, Patch[]> = {
  [PLATFORM_H]: [
    // The hook that runs right after the Windows headers: see vc8_after_windows.h.
    linePatch('#  include <wintrust.h>', '#  include <wintrust.h>\n#  include <vc8_after_windows.h>'),
    // mingw lacks the MSVC names and maps them to C99's; VC8 has them, and the reverse
    // mapping in vc8_after_windows.h would make these loop.
    linePatch('#define __snprintf snprintf', '#define __snprintf _snprintf'),
    linePatch('#define _snprintf snprintf', '/* VC8 has _snprintf */'),
    linePatch('#define _vsnprintf vsnprintf', '/* VC8 has _vsnprintf */'),
    // VC8 SP1's back end crashes (C1001, P2 main.c line 182) inlining memcpy(p, &v, 3) when v
    // is the by-value parameter and the call passes a computed value; a local copy avoids it
    // and compiles to the same word + byte stores.
    linePatch('static inline void d2_store24(void* p, uint32_t v) { std::memcpy(p, &v, 3); }',
      'static inline void d2_store24(void* p, uint32_t v) { uint32_t t = v; std::memcpy(p, &t, 3); }'),
    linePatch('#define __stricmp strcasecmp', '#define __stricmp _stricmp'),
    linePatch('#define _stricmp strcasecmp', '/* VC8 has _stricmp */'),
    linePatch('#define _strnicmp strncasecmp', '/* VC8 has _strnicmp */'),
    // Game.exe calls binkw32, smackw32 and ijl11 through the IAT (`call [__imp__SmackClose@4]`):
    // their own headers declare them dllimport, and d2_platform.h (written for mingw) does not.
    ...RAD_IJL_IMPORTS.map(dllimportPatch),
  ],
};

function hasPatches(rel: string): boolean {
  return Object.prototype.hasOwnProperty.call(FILE_PATCHES, rel);
}

export function applyPatches(rel: string, text: string): string {
  for (const patch of (hasPatches(rel) ? FILE_PATCHES[rel] : [])) {
    const at = patch.find(text);
    if (at.length !== 1) throw new Error(`patch anchor ${JSON.stringify(patch.what)} matches ${at.length} times, expected once`);
    text = patch.apply(text, at[0]);
  }
  return text;
}

// ---------------------------------------------------------------------------------------------
// Quarantine

const FUNC_HEAD_BAD = new Set(['namespace', 'struct', 'class', 'union', 'enum', 'if', 'for', 'while', 'switch',
  'do', 'else', 'try', 'catch', '__try', '__except', '__finally']);

/**
 * Token indices of the `{` and `}` of the outermost function body enclosing 1-based `line`,
 * or null. A block is a function body when the statement before its brace ends in a
 * parameter list (and `const`), and is not a control statement, a type or an initialiser.
 */
export function functionBodyAt(doc: Doc, line: number): { open: number; close: number } | null {
  let target = 0;
  for (let l = 1; l < line && target >= 0; l++) target = doc.text.indexOf('\n', target) + 1;
  if (line > 1 && target === 0) target = doc.text.length;
  const stack: number[] = [];
  for (let i = 0; i < doc.length && doc.toks[i].s <= target; i++) {
    if (doc.k(i) === K.LeftBrace) stack.push(i);
    else if (doc.k(i) === K.RightBrace) stack.pop();
  }
  for (const o of stack) {
    const h = statementStart(doc, o - 1);
    let e = o - 1;
    if (doc.k(e) === K.Const) e--;
    if (e < h || doc.k(e) !== K.RightParen) continue;
    if (FUNC_HEAD_BAD.has(doc.t(h)!)) continue;
    let assign = false;
    for (let j = h; j < o && doc.k(j) !== K.LeftParen; j++) if (doc.t(j)!.includes('=')) assign = true;
    if (assign) continue;
    if (doc.pair[o] >= 0) return { open: o, close: doc.pair[o] };
  }
  return null;
}

/**
 * The function enclosing 1-based `line`, as quarantine.tsv records it: the line of its body's
 * `{` and its name as written before the parameter list (`?` when the list nests parentheses
 * deeper than one level, or no name stands there).
 */
export function functionAt(text: string, line: number): { line: number; name: string } | null {
  const doc = new Doc(text);
  const b = functionBodyAt(doc, line);
  if (!b) return null;
  return { line: countNewlines(text, 0, doc.toks[b.open].s) + 1, name: functionName(doc, b.open) };
}

function functionName(doc: Doc, open: number): string {
  let e = open - 1;
  if (doc.k(e) === K.Const) e--;
  const o = doc.pair[e];
  if (doc.k(e) !== K.RightParen || o < 0) return '?';
  for (let j = o + 1; j < e; j++) {
    if (doc.k(j) === K.LeftParen) {
      for (let m = j + 1; m < doc.pair[j]; m++) if (doc.k(m) === K.LeftParen) return '?';
      j = doc.pair[j];
    }
  }
  if (!doc.wsBefore(o)) return '?';
  let s = o - 1;
  const part = (j: number) => doc.word(j) || doc.k(j) === K.ColonColon || doc.k(j) === K.Tilde;
  if (s < 0 || !part(s)) return '?';
  while (s > 0 && doc.tight(s) && part(s - 1)) s--;
  while (s < o && !(doc.word(s) || doc.k(s) === K.Tilde)) s++;
  return s < o ? doc.text.slice(doc.toks[s].s, doc.toks[o - 1].e) : '?';
}

/** Blank the bodies of the functions enclosing each 1-based line, keeping every newline. */
export function quarantineBodies(text: string, lines: Iterable<number>): string {
  const doc = new Doc(text);
  const spans = new Map<number, { open: number; close: number }>();
  for (const ln of lines) {
    const b = functionBodyAt(doc, ln);
    if (b) spans.set(b.open, b);
  }
  const edits: Edit[] = [];
  for (const { open, close } of spans.values()) {
    const s = doc.toks[open].e;
    const e = doc.toks[close].s;
    edits.push({ s, e, text: ' __assume(0);' + '\n'.repeat(countNewlines(text, s, e)) });
  }
  return applyEdits(text, edits);
}

// ---------------------------------------------------------------------------------------------

/** One file's translation. `rel` is its path in the tree, forward slashes. */
export function translate(text: string, rel: string, state: TreeState, quarantine?: Iterable<number>): string {
  let s = syntaxPass(text, rel.endsWith('.h'));
  if (!rel.endsWith('.h')) s = argNestPass(s, state, argNestMode(), argNestSites ? (argNestSites[rel] = []) : undefined);
  s = thiscallPass(s, state);
  s = stripThiscallPass(s);
  s = conventionPass(s);
  if (state.strip.size) s = stripCtorsPass(s, state.strip);
  s = aggregatePass(s, state.construct);
  if (countNewlines(s) !== countNewlines(text)) throw new Error('rewrite changed the line count');
  if (hasPatches(rel)) {
    s = applyPatches(rel, s);
    if (countNewlines(s) !== countNewlines(text) && text.includes('__LINE__')) {
      throw new Error('a line-adding patch on a file that uses __LINE__');
    }
  }
  if (quarantine) {
    const lines = [...quarantine];
    if (lines.length) s = quarantineBodies(s, lines);
  }
  return s;
}
