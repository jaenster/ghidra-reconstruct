/**
 * The whole-tree pre-pass of the VC8 translation: what every file declares that a rewrite in
 * another file depends on.
 *
 *   __thiscall functions   by qualified name (namespaces, classes, the written qualifier) and
 *                          parameter count, less any count the same qualified name is also
 *                          declared with otherwise - a call to that one cannot be told apart.
 *                          Keying on the qualified name is what keeps `HASHKEY_STRI::Constructor
 *                          (char*)` from costing every `Ui::Widget::Constructor(pThis)` its
 *                          convention.
 *   __thiscall pointers    by field name (a member access names no type here), with the
 *                          fields typed by a __thiscall pointer typedef.
 *   constructors           structs that declare one and are a union member (they lose them)
 *                          or list-initialised (their braces become constructor calls).
 *
 * Definitions VC8 never compiles - `#ifndef _WIN32` blocks - do not count.
 */

import { Doc, K, isSpace, isWordChar } from './doc.js';
import {
  argList, declaratorAt, qualifiedName, scopes, thiscallDeclAt,
} from './syntax.js';
import { globalVariables, note, structFields, typedefAliases, type TypeInfo } from './types.js';

export interface Fn {
  q: string;
  name: string;
  count: number;
}

export interface FileFacts {
  fn: Array<Fn & { direct: boolean }>;
  other: Fn[];
  ptr: Array<{ name: string; count: number }>;
  otherPtr: Array<{ name: string; count: number }>;
  typedef: Array<{ name: string; count: number }>;
  /** `T name;` pairs: the fields a __thiscall pointer typedef types are among them. */
  pairs: Array<[string, string]>;
  /** The pointer fields among `ptr`/`otherPtr`/`pairs`, by `Struct::field`. */
  qptr: Array<{ name: string; count: number }>;
  otherQPtr: Array<{ name: string; count: number }>;
  classPairs: Array<[string, string]>;
  fields: Array<[string, string, string]>;
  aliases: Array<[string, string]>;
  globals: Array<[string, string]>;
  ctor: string[];
  union: string[];
  listInit: string[];
}

export interface TreeState {
  /** Qualified __thiscall function -> the parameter counts it is rewritten for. */
  funcs: Map<string, Set<number>>;
  /** Qualified __thiscall functions declared static or inline: called directly. */
  direct: Set<string>;
  /** Every qualified function name the tree declares, any convention. */
  declared: Set<string>;
  /** Unqualified names of `funcs`: the identifiers a call to one of them can be spelled with. */
  names: Set<string>;
  /**
   * __thiscall pointer field -> parameter counts, by field name: for a call whose object's
   * struct is not known, and for pointers that are no struct's field.
   */
  ptrs: Map<string, Set<number>>;
  /** The same by `Struct::field`, less only what that struct's own field is declared otherwise. */
  qptrs: Map<string, Set<number>>;
  /** Field names of `qptrs`. */
  qptrNames: Set<string>;
  types: TypeInfo;
  strip: Set<string>;
  construct: Set<string>;
}

/**
 * `text` with every `#ifndef _WIN32` (or `#if !defined(_WIN32)`) block blanked, lines kept:
 * the generator's stand-ins for SDK types, which VC8 never compiles.
 */
export function withoutNonWin32(text: string): string {
  const lines = text.split('\n');
  let depth = 0;
  for (let n = 0; n < lines.length; n++) {
    const d = directive(lines[n].trim());
    if (depth) {
      if (d && (d.word === 'if' || d.word === 'ifdef' || d.word === 'ifndef')) depth++;
      else if (d && d.word === 'endif') depth--;
      else if (depth === 1 && d && (d.word === 'else' || d.word === 'elif')) depth = 0;
      lines[n] = '';
      continue;
    }
    if (d && opensNonWin32(d)) {
      depth = 1;
      lines[n] = '';
    }
  }
  return lines.join('\n');
}

function directive(t: string): { word: string; rest: string } | null {
  if (t[0] !== '#') return null;
  let p = 1;
  while (p < t.length && isSpace(t[p])) p++;
  let q = p;
  while (q < t.length && isWordChar(t[q])) q++;
  return { word: t.slice(p, q), rest: t.slice(q) };
}

function opensNonWin32(d: { word: string; rest: string }): boolean {
  const r = d.rest;
  let p = 0;
  const ws = () => { while (p < r.length && (r[p] === ' ' || r[p] === '\t' || r[p] === '\r' || r[p] === '\f' || r[p] === '\v')) p++; };
  const win32 = () => r.startsWith('_WIN32', p) && !isWordChar(r[p + 6]);
  if (d.word === 'ifndef') {
    if (!(r[0] === ' ' || r[0] === '\t')) return false;
    ws();
    return win32();
  }
  if (d.word === 'if') {
    ws();
    if (r[p] !== '!') return false;
    p++;
    ws();
    if (!r.startsWith('defined', p)) return false;
    p += 7;
    ws();
    if (r[p] === '(') p++;
    ws();
    return win32();
  }
  return false;
}

/** A struct or class head `struct [__attribute__((packed))] Name [: bases] {`. */
export interface Head {
  kw: number;
  name: string;
  open: number;
  close: number;
}

/** Every struct/class (or, with `union`, named union) definition head, in order. */
export function heads(doc: Doc, union = false): Head[] {
  const out: Head[] = [];
  for (let i = 0; i < doc.length; i++) {
    const k = doc.k(i);
    if (union ? k !== K.Union : k !== K.Struct && k !== K.Class) continue;
    let j = i + 1;
    if (j >= doc.length || doc.tight(j) || !doc.wsBefore(j)) continue;
    if (!union && doc.t(j) === '__attribute__' && packedAttr(doc, j) && !doc.tight(j + 6) && doc.wsBefore(j + 6)) j += 6;
    if (!doc.word(j)) continue;
    const name = doc.t(j)!;
    let b = j + 1;
    if (!doc.wsBefore(b)) continue;
    if (!union && (doc.k(b) === K.Colon || doc.k(b) === K.ColonColon)) {
      while (b < doc.length && doc.k(b) !== K.LeftBrace && doc.k(b) !== K.Semicolon) b++;
    }
    if (doc.k(b) !== K.LeftBrace || doc.pair[b] < 0) continue;
    out.push({ kw: i, name, open: b, close: doc.pair[b] });
  }
  return out;
}

/** `__attribute__((packed))` at token j, the two parens of each side written tight. */
export function packedAttr(doc: Doc, j: number): boolean {
  return doc.t(j) === '__attribute__' && doc.k(j + 1) === K.LeftParen && doc.wsBefore(j + 1) &&
    doc.k(j + 2) === K.LeftParen && doc.tight(j + 2) && doc.t(j + 3) === 'packed' && doc.wsBefore(j + 3) &&
    doc.k(j + 4) === K.RightParen && doc.wsBefore(j + 4) && doc.k(j + 5) === K.RightParen && doc.tight(j + 5);
}

/** `( __thiscall * [name] ) (` at token i: the name (or '') and the parameter list's `(`. */
export function thiscallPtrAt(doc: Doc, i: number): { name: string; at: number; params: number } | null {
  if (doc.k(i) !== K.LeftParen || doc.k(i + 1) !== K.CallingConvThiscall || !doc.wsBefore(i + 1)) return null;
  if (doc.k(i + 2) !== K.Star || !doc.wsBefore(i + 2)) return null;
  let j = i + 3;
  let name = '';
  if (doc.k(j) === K.Identifier && doc.wsBefore(j)) {
    name = doc.t(j)!;
    j++;
  }
  if (doc.k(j) !== K.RightParen || !doc.wsBefore(j) || doc.k(j + 1) !== K.LeftParen || !doc.wsBefore(j + 1)) return null;
  return { name, at: j - (name ? 1 : 0), params: j + 1 };
}

const OTHER_PTR_CONV = new Set<K>([K.CallingConvCdecl, K.CallingConvStdcall, K.CallingConvFastcall]);

/** `T (conv *name)(` at the `(` of token i, the `(` written after a word, `*`, `&` or `>`. */
function otherPtrAt(doc: Doc, i: number): { name: string; params: number } | null {
  if (doc.k(i) !== K.LeftParen || i === 0) return null;
  const gap = doc.gap(i);
  for (const c of gap) if (c !== ' ' && c !== '\t') return null;
  const before = doc.toks[i - 1].t;
  const last = before[before.length - 1];
  if (!(isWordChar(last) || last === '*' || last === '&' || last === '>')) return null;
  let j = i + 1;
  if (OTHER_PTR_CONV.has(doc.k(j)!) && doc.wsBefore(j)) j++;
  if (doc.k(j) !== K.Star || !doc.wsBefore(j)) return null;
  if (doc.k(j + 1) !== K.Identifier || !doc.wsBefore(j + 1)) return null;
  if (doc.k(j + 2) !== K.RightParen || !doc.wsBefore(j + 2) || doc.k(j + 3) !== K.LeftParen || !doc.wsBefore(j + 3)) return null;
  return { name: doc.t(j + 1)!, params: j + 3 };
}

const DIRECT_WORDS = new Set(['static', 'inline', '__inline', '__forceinline']);

/** A `static`/`inline` written on the `__thiscall`'s line, after the last `;` or `}`. */
function directBefore(doc: Doc, conv: number): boolean {
  const ls = doc.lineStart(doc.toks[conv].s);
  for (let j = conv - 1; j >= 0 && doc.toks[j].s >= ls; j--) {
    const k = doc.k(j);
    if (k === K.Semicolon || k === K.RightBrace) break;
    if (DIRECT_WORDS.has(doc.t(j)!)) return true;
  }
  return false;
}

/** A `__thiscall` on the line of token i, before it. */
function thiscallOnLineBefore(doc: Doc, i: number): boolean {
  const ls = doc.lineStart(doc.toks[i].s);
  for (let j = i - 1; j >= 0 && doc.toks[j].s >= ls; j--) if (doc.k(j) === K.CallingConvThiscall) return true;
  return false;
}

/**
 * `[static|const|extern ...] [struct] T name[...]... = {` written at the start of a line:
 * the type and the `{`, and how many `[]` the declarator has.
 */
export function listInitAt(doc: Doc, i: number): { type: string; rank: number; open: number } | null {
  if (!doc.lineLead(i)) return null;
  const prefixes: number[] = [];
  let j = i;
  while (['static', 'const', 'extern'].includes(doc.t(j)!) && spaced(doc, j + 1)) {
    j++;
    prefixes.push(j);
  }
  for (let n = prefixes.length; n >= 0; n--) {
    const start = n ? prefixes[n - 1] : i;
    for (const withStruct of [true, false]) {
      let p = start;
      if (withStruct) {
        if (doc.k(p) !== K.Struct || !spaced(doc, p + 1)) continue;
        p++;
      }
      const r = listInitRest(doc, p);
      if (r) return r;
    }
  }
  return null;
}

/** Token j is preceded by whitespace only, at least one character of it. */
function spaced(doc: Doc, j: number): boolean {
  return j < doc.length && !doc.tight(j) && doc.wsBefore(j);
}

function listInitRest(doc: Doc, p: number): { type: string; rank: number; open: number } | null {
  if (!doc.word(p)) return null;
  const type = doc.t(p)!;
  let j = p + 1;
  if (!spaced(doc, j) || !doc.word(j)) return null;
  j++;
  while (j < doc.length && doc.tight(j) && (doc.word(j) || doc.k(j) === K.ColonColon || doc.k(j) === K.IntegerLiteral)) j++;
  let rank = 0;
  while (doc.k(j) === K.LeftBracket && doc.wsBefore(j)) {
    const close = doc.pair[j];
    if (close < 0) return null;
    if (doc.text.slice(doc.toks[j].e, doc.toks[close].s).includes(']')) return null;
    rank++;
    j = close + 1;
  }
  if (doc.k(j) !== K.Equal || !doc.wsBefore(j) || doc.k(j + 1) !== K.LeftBrace || !doc.wsBefore(j + 1)) return null;
  return { type, rank, open: j + 1 };
}

/** What one file contributes to the pre-pass. `text` is the file as written. */
export function fileFacts(text: string, header: boolean, filename = '<input>'): FileFacts {
  const stripped = withoutNonWin32(text);
  const doc = new Doc(stripped, filename);
  const sc = scopes(doc);
  const f: FileFacts = { fn: [], other: [], ptr: [], otherPtr: [], typedef: [], pairs: [], ctor: [], union: [], listInit: [],
    qptr: [], otherQPtr: [], classPairs: [], fields: structFields(doc), aliases: typedefAliases(doc), globals: globalVariables(doc, sc) };
  const scopeOf = (i: number) => sc.table[sc.at[i]];
  let depth = 0;
  // The struct a `(` at token i declares a member of: written at the struct's own level.
  const memberOf = (i: number): string | null => {
    const s = scopeOf(i);
    return s.cls && !s.body && depth === 1 ? s.cls : null;
  };
  for (let i = 0; i < doc.length; i++) {
    const k = doc.k(i)!;
    if (k === K.LeftParen) depth++;
    else if (k === K.RightParen) depth = Math.max(0, depth - 1);
    else if (k === K.LeftBrace || k === K.RightBrace || k === K.Semicolon) depth = 0;

    if (k === K.CallingConvThiscall) {
      const d = thiscallDeclAt(doc, i);
      if (d) {
        f.fn.push({ q: qualifiedName(scopeOf(i).names, d), name: d.name, count: argList(doc, d.nameAt + 1, true).count,
          direct: directBefore(doc, i) });
      }
    } else if (k === K.LeftParen) {
      const member = memberOf(i);
      const p = thiscallPtrAt(doc, i);
      if (p && p.name) {
        const count = argList(doc, p.params, true).count;
        f.ptr.push({ name: p.name, count });
        if (member) f.qptr.push({ name: `${member}::${p.name}`, count });
      }
      const o = otherPtrAt(doc, i);
      if (o) {
        const count = argList(doc, o.params, true).count;
        f.otherPtr.push({ name: o.name, count });
        if (member) f.otherQPtr.push({ name: `${member}::${o.name}`, count });
      }
    } else if (k === K.Typedef) {
      for (let j = i + 1; j < doc.length && doc.k(j) !== K.Semicolon; j++) {
        const p = thiscallPtrAt(doc, j);
        if (p && p.name) {
          f.typedef.push({ name: p.name, count: argList(doc, p.params, true).count });
          break;
        }
      }
    } else if (k === K.Identifier) {
      if (doc.k(i + 1) === K.LeftParen && depth === 0 && !scopeOf(i).body) {
        const d = declaratorAt(doc, i);
        if (d && !d.thiscall && !thiscallOnLineBefore(doc, i)) {
          f.other.push({ q: qualifiedName(scopeOf(i).names, d), name: d.name, count: argList(doc, i + 1, true).count });
        }
      }
      if (doc.k(i + 1) === K.Identifier && spaced(doc, i + 1) && doc.k(i + 2) === K.Semicolon && doc.wsBefore(i + 2)) {
        f.pairs.push([doc.t(i)!, doc.t(i + 1)!]);
        const c = scopeOf(i).cls;
        if (c && !scopeOf(i).body && depth === 0) f.classPairs.push([doc.t(i)!, `${c}::${doc.t(i + 1)!}`]);
      }
    }
  }
  if (header) {
    for (const h of heads(doc)) {
      for (let j = h.open + 1; j < h.close; j++) {
        if (doc.t(j) === h.name && doc.k(j) === K.Identifier && doc.lineLead(j, doc.toks[h.open].e) &&
            doc.k(j + 1) === K.LeftParen && doc.wsBefore(j + 1)) {
          f.ctor.push(h.name);
          break;
        }
      }
    }
    for (const h of heads(doc, true)) f.union.push(...unionMembers(doc, h));
  }
  const listDoc = header || stripped === text ? doc : new Doc(text, filename);
  for (let i = 0; i < listDoc.length; i++) {
    const li = listInitAt(listDoc, i);
    if (li) f.listInit.push(li.type);
  }
  return f;
}

/** The type of each `[struct] T name[N];` member line of a union body, nested bodies included. */
function unionMembers(doc: Doc, h: Head): string[] {
  const out: string[] = [];
  const from = doc.toks[h.open].e;
  for (let j = h.open + 1; j < h.close; j++) {
    if (!leadsLine(doc, j, from)) continue;
    for (const withStruct of [true, false]) {
      let p = j;
      if (withStruct) {
        if (doc.k(p) !== K.Struct || !spaced(doc, p + 1)) continue;
        p++;
      }
      if (!doc.word(p) || !spaced(doc, p + 1) || !doc.word(p + 1)) continue;
      let e = p + 2;
      if (doc.k(e) === K.LeftBracket && doc.wsBefore(e) && doc.pair[e] > e &&
          !doc.text.slice(doc.toks[e].e, doc.toks[doc.pair[e]].s).includes(']')) e = doc.pair[e] + 1;
      if (doc.k(e) === K.Semicolon && doc.wsBefore(e)) {
        out.push(doc.t(p)!);
        break;
      }
    }
  }
  return out;
}

/** Token j opens its line (or follows `from`), after whitespace and at most one `/* ... *\/`. */
function leadsLine(doc: Doc, j: number, from: number): boolean {
  const text = doc.text;
  let p = doc.toks[j].s;
  let sawComment = false;
  for (;;) {
    while (p > from && p > 0 && text[p - 1] !== '\n' && isSpace(text[p - 1])) p--;
    if (p <= from || p === 0 || text[p - 1] === '\n') return true;
    if (!sawComment && text[p - 1] === '/' && text[p - 2] === '*') {
      const c = doc.blockCommentAt(p - 1);
      if (!c || c.s < from || text.slice(c.s + 2, c.e - 2).includes('*')) return false;
      sawComment = true;
      p = c.s;
      continue;
    }
    return false;
  }
}

/** The tree's state from every file's facts, in file order. */
export function mergeFacts(facts: FileFacts[]): TreeState {
  const add = (m: Map<string, Set<number>>, k: string, c: number) => {
    let s = m.get(k);
    if (!s) m.set(k, s = new Set());
    s.add(c);
  };
  const fnQ = new Map<string, Set<number>>();
  const otherQ = new Map<string, Set<number>>();
  const otherB = new Map<string, Set<number>>();
  const ptrs = new Map<string, Set<number>>();
  const otherP = new Map<string, Set<number>>();
  const typedefs = new Map<string, number>();
  const direct = new Set<string>();
  const declared = new Set<string>();
  const withCtor = new Set<string>();
  const inUnion = new Set<string>();
  const listInit = new Set<string>();
  const qptrs = new Map<string, Set<number>>();
  const otherQP = new Map<string, Set<number>>();
  const types: TypeInfo = { fields: new Map(), aliases: new Map(), globals: new Map() };
  for (const f of facts) {
    for (const x of f.qptr) add(qptrs, x.name, x.count);
    for (const x of f.otherQPtr) add(otherQP, x.name, x.count);
    for (const [st, field, type] of f.fields) {
      let m = types.fields.get(st);
      if (!m) types.fields.set(st, m = new Map());
      note(m, field, type);
    }
    for (const [a, t] of f.aliases) note(types.aliases, a, t);
    for (const [n, t] of f.globals) note(types.globals, n, t);
    for (const x of f.fn) {
      add(fnQ, x.q, x.count);
      declared.add(x.q);
      if (x.direct) direct.add(x.q);
    }
    for (const x of f.other) {
      add(otherQ, x.q, x.count);
      add(otherB, x.name, x.count);
      declared.add(x.q);
    }
    for (const x of f.ptr) add(ptrs, x.name, x.count);
    for (const x of f.otherPtr) add(otherP, x.name, x.count);
    for (const x of f.typedef) typedefs.set(x.name, x.count);
    f.ctor.forEach(n => withCtor.add(n));
    f.union.forEach(n => inUnion.add(n));
    f.listInit.forEach(n => listInit.add(n));
  }
  if (typedefs.size) {
    for (const f of facts) for (const [t, n] of f.pairs) if (typedefs.has(t)) add(ptrs, n, typedefs.get(t)!);
    for (const f of facts) for (const [t, n] of f.classPairs) if (typedefs.has(t)) add(qptrs, n, typedefs.get(t)!);
  }
  const funcs = new Map<string, Set<number>>();
  const names = new Set<string>();
  for (const [q, counts] of fnQ) {
    const keep = new Set([...counts].filter(c => c > 0 && !otherQ.get(q)?.has(c)));
    if (keep.size) {
      funcs.set(q, keep);
      names.add(lastPart(q));
    }
  }
  const ptrsOut = new Map<string, Set<number>>();
  for (const [n, counts] of ptrs) {
    const keep = new Set([...counts].filter(c => c > 0 && !otherP.get(n)?.has(c) && !otherB.get(n)?.has(c)));
    if (keep.size) ptrsOut.set(n, keep);
  }
  const qptrsOut = new Map<string, Set<number>>();
  const qptrNames = new Set<string>();
  for (const [n, counts] of qptrs) {
    const keep = new Set([...counts].filter(c => c > 0 && !otherQP.get(n)?.has(c)));
    if (keep.size) {
      qptrsOut.set(n, keep);
      qptrNames.add(lastPart(n));
    }
  }
  const strip = new Set([...withCtor].filter(n => inUnion.has(n)));
  const construct = new Set([...withCtor].filter(n => listInit.has(n) && !strip.has(n)));
  return { funcs, direct, declared, names, ptrs: ptrsOut, qptrs: qptrsOut, qptrNames, types, strip, construct };
}

/** `A::B::f` -> `f`. */
export function lastPart(q: string): string {
  const i = q.lastIndexOf('::');
  return i < 0 ? q : q.slice(i + 2);
}

/** The qualified function a call `qual::name(` written in scope `scope` reaches, if declared. */
export function resolveCall(state: TreeState, scope: string[], qual: string[], global: boolean, name: string): string | null {
  const tail = [...qual, name];
  if (global) {
    const q = tail.join('::');
    return state.declared.has(q) ? q : null;
  }
  for (let n = scope.length; n >= 0; n--) {
    const q = [...scope.slice(0, n), ...tail].join('::');
    if (state.declared.has(q)) return q;
  }
  return null;
}
