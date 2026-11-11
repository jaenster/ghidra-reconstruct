/**
 * Just enough of the tree's types to tell which struct a member access reaches: the fields
 * of every struct with the struct each one points to, typedef aliases, and the declared
 * types of globals, parameters and locals. Types are known by their bare name (`::X *`,
 * `struct X*` and `X` are all X); a name declared with two different types is unknown.
 */

import { Doc, K } from './doc.js';
import { heads } from './facts.js';
import { statementStart, type Scope } from './syntax.js';

export const UNKNOWN = '?';

const TYPE_NOISE = new Set(['const', 'volatile', 'struct', 'class', 'union', 'enum', 'unsigned', 'signed',
  'static', 'extern', 'mutable', 'typename', 'register', 'inline', '__inline', '__forceinline']);
const NOT_A_TYPE = new Set(['return', 'delete', 'goto', 'case', 'else', 'throw', 'new', 'sizeof', 'do',
  'public', 'private', 'protected', 'typedef', 'using', 'namespace', 'template', 'operator', 'friend']);

/** Add `name -> type` to `m`; a second, different type makes the name unknown. */
export function note(m: Map<string, string>, name: string, type: string): void {
  const had = m.get(name);
  m.set(name, had === undefined || had === type ? type : UNKNOWN);
}

/**
 * The variables a declaration statement `[spec...] T [*] a [= ...], [*] b[N];` over tokens
 * [a, b) declares, with T's bare name. Function declarations, function pointers and
 * templates are not read (null).
 */
export function declaredVariables(doc: Doc, a: number, b: number): Array<[string, string]> | null {
  while (a < b && (doc.t(a) === 'public' || doc.t(a) === 'private' || doc.t(a) === 'protected') && doc.k(a + 1) === K.Colon) a += 2;
  if (a >= b || NOT_A_TYPE.has(doc.t(a)!)) return null;
  // Declarators are split at top-level commas; each one's name stands before its first
  // top-level `[`, `:` (bit-field), `=` or `(` - and a `(` there makes it a function.
  const ends: number[] = [];
  let depth = 0;
  for (let j = a; j < b; j++) {
    const k = doc.k(j);
    if (k === K.LeftParen || k === K.LeftBracket || k === K.LeftBrace) depth++;
    else if (k === K.RightParen || k === K.RightBracket || k === K.RightBrace) depth--;
    else if (depth === 0 && k === K.Comma) ends.push(j);
  }
  const out: Array<[string, string]> = [];
  let type: string | null = null;
  let from = a;
  for (const end of [...ends, b]) {
    let p = from;
    for (; p < end; p++) {
      const k = doc.k(p);
      if (k === K.Less) return null;
      if (k === K.LeftParen) return null;
      if (k === K.LeftBracket || k === K.Colon || k === K.Equal) break;
    }
    const n = p - 1;
    if (n < from || doc.k(n) !== K.Identifier) return null;
    if (type === null) {
      let t = n - 1;
      while (t >= from && (doc.k(t) === K.Star || doc.k(t) === K.Ampersand || TYPE_NOISE.has(doc.t(t)!))) t--;
      if (t < from || !doc.word(t) || NOT_A_TYPE.has(doc.t(t)!)) return null;
      type = doc.t(t)!;
    } else {
      for (let t = from; t < n; t++) if (doc.k(t) !== K.Star && doc.k(t) !== K.Ampersand) return null;
    }
    out.push([doc.t(n)!, type]);
    from = end + 1;
  }
  return out;
}

/** Every named struct's fields -> the bare type each is declared with, members of anonymous nested bodies included. */
export function structFields(doc: Doc): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  const named = new Map<number, number>();
  for (const h of heads(doc)) named.set(h.open, h.close);
  for (const h of heads(doc, true)) named.set(h.open, h.close);
  for (const h of [...heads(doc), ...heads(doc, true)]) {
    let start = h.open + 1;
    for (let j = h.open + 1; j < h.close; j++) {
      const k = doc.k(j);
      if (k === K.LeftBrace) {
        if (named.has(j)) {
          j = named.get(j)!;
          start = j + 1;
        } else start = j + 1;           // an anonymous struct or union: its members are this one's
      } else if (k === K.RightBrace) {
        start = j + 1;
      } else if (k === K.Semicolon) {
        if (doc.k(start - 1) === K.RightBrace) {
          start = j + 1;                // `} name;` after a nested body
          continue;
        }
        const fnptr = functionPointerName(doc, start, j);
        if (fnptr) out.push([h.name, fnptr, UNKNOWN]);
        else for (const [n, t] of declaredVariables(doc, start, j) ?? []) out.push([h.name, n, t]);
        start = j + 1;
      }
    }
  }
  return out;
}

/** `T (conv *name)(...)` over tokens [a, b): the name. */
function functionPointerName(doc: Doc, a: number, b: number): string | null {
  for (let j = a; j < b; j++) {
    if (doc.k(j) !== K.LeftParen) continue;
    let p = j + 1;
    if (doc.k(p) !== undefined && doc.t(p)!.startsWith('__') && doc.k(p) !== K.Identifier) p++;
    if (doc.k(p) === K.Star && doc.k(p + 1) === K.Identifier && doc.k(p + 2) === K.RightParen && doc.k(p + 3) === K.LeftParen) {
      return doc.t(p + 1)!;
    }
    return null;
  }
  return null;
}

/** `typedef [struct] T [*] Alias;` -> [Alias, T]. */
export function typedefAliases(doc: Doc): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < doc.length; i++) {
    if (doc.k(i) !== K.Typedef) continue;
    let e = i + 1;
    while (e < doc.length && doc.k(e) !== K.Semicolon && doc.k(e) !== K.LeftBrace) e++;
    if (doc.k(e) === K.LeftBrace) {
      // typedef struct X { ... } Alias;
      const close = doc.pair[e];
      const tag = doc.k(e - 1) === K.Identifier ? doc.t(e - 1)! : null;
      if (close > e && tag && doc.k(close + 1) === K.Identifier && doc.k(close + 2) === K.Semicolon) out.push([doc.t(close + 1)!, tag]);
      continue;
    }
    for (const [alias, type] of declaredVariables(doc, i + 1, e) ?? []) if (alias !== type) out.push([alias, type]);
  }
  return out;
}

/** Variables declared at namespace scope (globals, `extern` ones included). */
export function globalVariables(doc: Doc, sc: { at: Int32Array; table: Scope[] }): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < doc.length; i++) {
    if (doc.k(i) !== K.Semicolon) continue;
    const s = sc.table[sc.at[i]];
    if (s.body || s.cls !== null) continue;
    const a = statementStart(doc, i - 1);
    if (doc.k(a) === K.Typedef || doc.k(a) === K.Using) continue;
    for (const v of declaredVariables(doc, a, i) ?? []) out.push(v);
  }
  return out;
}

/** The parameters and locals of the function body opening at token `open`, by name. */
export function functionVariables(doc: Doc, open: number): Map<string, string> {
  const vars = new Map<string, string>();
  let e = open - 1;
  if (doc.k(e) === K.Const) e--;
  const po = doc.pair[e];
  if (doc.k(e) === K.RightParen && po >= 0) {
    let from = po + 1;
    let depth = 0;
    for (let j = po + 1; j <= e; j++) {
      const k = doc.k(j);
      if (k === K.LeftParen || k === K.LeftBracket) depth++;
      else if ((k === K.RightParen || k === K.RightBracket) && j !== e) depth--;
      if ((depth === 0 && k === K.Comma) || j === e) {
        for (const [n, t] of declaredVariables(doc, from, j) ?? []) note(vars, n, t);
        from = j + 1;
      }
    }
  }
  const close = doc.pair[open];
  let start = open + 1;
  for (let j = open + 1; j < close; j++) {
    const k = doc.k(j);
    if (k === K.LeftBrace || k === K.RightBrace) start = j + 1;
    else if (k === K.LeftParen && (doc.k(j - 1) === K.For)) start = j + 1;
    else if (k === K.Semicolon) {
      for (const [n, t] of declaredVariables(doc, start, j) ?? []) note(vars, n, t);
      start = j + 1;
    }
  }
  return vars;
}

export interface TypeInfo {
  /** struct -> field -> the bare type it points to (UNKNOWN when declared differently). */
  fields: Map<string, Map<string, string>>;
  aliases: Map<string, string>;
  globals: Map<string, string>;
}

/** A type's name through its typedef aliases. */
export function resolveAlias(info: TypeInfo, t: string): string {
  for (let n = 0; n < 16; n++) {
    const a = info.aliases.get(t);
    if (!a || a === UNKNOWN || a === t) return t;
    t = a;
  }
  return t;
}

/**
 * The struct the expression over tokens [a, b) has (through pointers), or null when it cannot
 * be told: a name, a cast `((T*)x)`, `(*p)`, and member accesses and subscripts after them.
 */
export function expressionStruct(doc: Doc, a: number, b: number, info: TypeInfo, locals: Map<string, string> | null): string | null {
  let j = a;
  let cur: string | null = null;
  if (doc.k(j) === K.LeftParen) {
    const close = doc.pair[j];
    if (close < 0 || close >= b) return null;
    if (doc.k(j + 1) === K.LeftParen && doc.pair[j + 1] > j + 1) {
      // ((T*)x): the cast's type.
      const tc = doc.pair[j + 1];
      let t = tc - 1;
      while (t > j + 1 && (doc.k(t) === K.Star || TYPE_NOISE.has(doc.t(t)!))) t--;
      if (!doc.word(t) || doc.k(t - 1) === K.Dot || doc.k(t - 1) === K.Arrow) return null;
      for (let p = j + 2; p < tc; p++) {
        const k = doc.k(p);
        if (!(doc.word(p) || k === K.Star || k === K.ColonColon)) return null;
      }
      cur = doc.t(t)!;
    } else {
      let p = j + 1;
      while (doc.k(p) === K.Star) p++;
      cur = expressionStruct(doc, p, close, info, locals);
    }
    j = close + 1;
  } else if (doc.k(j) === K.Identifier) {
    while (doc.k(j + 1) === K.ColonColon && doc.k(j + 2) === K.Identifier) j += 2;
    const name = doc.t(j)!;
    const t = locals?.get(name) ?? info.globals.get(name);
    cur = t && t !== UNKNOWN ? t : null;
    j++;
  } else return null;
  while (cur !== null && j < b) {
    const k = doc.k(j);
    if (k === K.LeftBracket && doc.pair[j] > j) j = doc.pair[j] + 1;
    else if ((k === K.Arrow || k === K.Dot) && doc.k(j + 1) === K.Identifier) {
      const t = info.fields.get(resolveAlias(info, cur))?.get(doc.t(j + 1)!);
      cur = t && t !== UNKNOWN ? t : null;
      j += 2;
    } else return null;
  }
  return cur === null ? null : resolveAlias(info, cur);
}
