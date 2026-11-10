/**
 * The structural questions the VC8 rewrites ask of a token stream: how many items a
 * parenthesised list holds, which namespaces and classes enclose a token, and whether an
 * identifier followed by `(` declares a function - with the qualified name it declares.
 */

import { Doc, K, isSpace, isWordChar } from './doc.js';

export interface ArgList {
  /** Offsets of the top-level commas. */
  commas: number[];
  /** Offset of the character that closes the list; -1 when it is never closed. */
  close: number;
  /** Item count: 0 for `()` and `(void)`, -1 for an unclosed list. */
  count: number;
}

const PUNCT_SKIP = new Set<K>([K.Identifier, K.IntegerLiteral, K.FloatingLiteral, K.CharLiteral,
  K.StringLiteral, K.UserDefinedLiteral]);

/**
 * The list opened by the `(` at token `open`. With `angle`, `<` and `>` nest too, as they do
 * in a parameter list's template arguments; any `>` closes one level there except the one of
 * `->`, exactly as a character count would, so `(a > b)` reads as closed at the `>`.
 */
export function argList(doc: Doc, open: number, angle: boolean): ArgList {
  const text = doc.text;
  const commas: number[] = [];
  let depth = 0;
  for (let i = open; i < doc.length; i++) {
    const tk = doc.toks[i];
    if (PUNCT_SKIP.has(tk.k) || doc.word(i)) continue;
    for (let o = tk.s; o < tk.e; o++) {
      const c = text[o];
      if (c === '(' || c === '[' || c === '{' || (angle && c === '<')) depth++;
      else if (c === ')' || c === ']' || c === '}' || (angle && c === '>' && text[o - 1] !== '-')) {
        depth--;
        if (depth === 0) {
          const inner = text.slice(doc.toks[open].e, o).trim();
          return { commas, close: o, count: inner === '' || inner === 'void' ? 0 : commas.length + 1 };
        }
      } else if (c === ',' && depth === 1) commas.push(o);
    }
  }
  return { commas, close: -1, count: -1 };
}

/** Where `, <text>` goes to become the list's second item: before its first comma, or its close. */
export function secondItemAt(list: ArgList): number {
  return list.commas.length ? list.commas[0] : list.close;
}

export interface Scope {
  /** The enclosing namespaces and classes, outermost first. */
  names: string[];
  /** Inside a function body or an initializer: no declaration here is a namespace member. */
  body: boolean;
  /** The struct, class or union whose members are declared here (an anonymous one's members are its parent's). */
  cls: string | null;
  /** For a function body: the token of the `{` of the outermost one enclosing. */
  fn: number;
}

const CLASS_KEYS = new Set<K>([K.Struct, K.Class, K.Union]);
const ATTR_WORDS = new Set(['__attribute__', '__declspec', 'alignas', '__pragma']);

/**
 * The scope of every token, as an index into `table`: what namespaces and classes enclose it,
 * and whether it sits in a function body. A function defined out of line as `Q::f(...) {`
 * has Q in its body's scope, as C++ name lookup has.
 */
export function scopes(doc: Doc): { at: Int32Array; table: Scope[] } {
  const table: Scope[] = [{ names: [], body: false, cls: null, fn: -1 }];
  const at = new Int32Array(doc.length);
  const stack: Array<{ close: number; id: number }> = [{ close: -2, id: 0 }];
  for (let i = 0; i < doc.length; i++) {
    const top = stack[stack.length - 1];
    at[i] = top.id;
    const k = doc.k(i);
    if (k === K.LeftBrace) {
      const outer = table[top.id];
      const opened = classifyBrace(doc, i, outer.body);
      const cls = opened.cls === undefined ? null : opened.cls === '' ? outer.cls : opened.cls;
      const fn = outer.body ? outer.fn : opened.body && opened.fn ? i : -1;
      table.push({ names: [...outer.names, ...opened.names], body: outer.body || opened.body, cls, fn });
      stack.push({ close: doc.pair[i], id: table.length - 1 });
    } else if (k === K.RightBrace) {
      while (stack.length > 1 && stack[stack.length - 1].close === i) stack.pop();
    }
  }
  return { at, table };
}

/** First token of the statement whose last token is `end`: just after a `;`, `{` or `}`. */
export function statementStart(doc: Doc, end: number): number {
  let j = end;
  while (j >= 0) {
    const k = doc.k(j);
    if (k === K.Semicolon || k === K.LeftBrace || k === K.RightBrace) break;
    if ((k === K.RightParen || k === K.RightBracket) && doc.pair[j] >= 0) j = doc.pair[j];
    j--;
  }
  return j + 1;
}

function classifyBrace(doc: Doc, brace: number, inBody: boolean): { names: string[]; body: boolean; cls?: string; fn?: boolean } {
  const h = statementStart(doc, brace - 1);
  if (inBody) return { names: [], body: true };
  let j = h;
  // `__pragma(pack(pop))` from a packed struct before it, `inline` of an inline namespace.
  for (;;) {
    if (doc.k(j) === K.Inline) j++;
    else if (ATTR_WORDS.has(doc.t(j)!) && doc.k(j + 1) === K.LeftParen && doc.pair[j + 1] > j) j = doc.pair[j + 1] + 1;
    else break;
  }
  if (doc.k(j) === K.Namespace) {
    const names: string[] = [];
    for (let p = j + 1; p < brace; p++) if (doc.k(p) === K.Identifier) names.push(doc.t(p)!);
    return { names, body: false };
  }
  if (doc.k(h) === K.Extern && doc.k(h + 1) === K.StringLiteral) return { names: [], body: false };
  // Top-level parentheses and `=` in the head, attribute groups aside.
  let firstParen = -1;
  let assign = false;
  let classKey = -1;
  let enumKey = false;
  for (let p = h; p < brace; p++) {
    const k = doc.k(p);
    if (k === K.LeftParen) {
      const prev = doc.t(p - 1);
      if (!(prev && ATTR_WORDS.has(prev)) && firstParen < 0) firstParen = p;
      if (doc.pair[p] > p) p = doc.pair[p];
    } else if (k === K.Equal) assign = true;
    else if (CLASS_KEYS.has(k!) && classKey < 0) classKey = p;
    else if (k === K.Enum) enumKey = true;
  }
  if (assign) return { names: [], body: true };
  if (firstParen < 0 && enumKey) return { names: [], body: true };
  if (firstParen < 0 && classKey >= 0) {
    let p = classKey + 1;
    while (p < brace) {
      const t = doc.t(p)!;
      if (ATTR_WORDS.has(t) && doc.k(p + 1) === K.LeftParen && doc.pair[p + 1] > p) p = doc.pair[p + 1] + 1;
      else break;
    }
    if (doc.k(p) === K.Identifier && doc.t(p) !== 'final') return { names: [doc.t(p)!], body: false, cls: doc.t(p)! };
    return { names: [], body: false, cls: '' };
  }
  if (firstParen >= 0) {
    // A function body. `Q::f(...) {` - lookup inside it starts in Q.
    const d = qualifierBefore(doc, firstParen - 1);
    return { names: d && !d.global ? d.qual : [], body: true, fn: true };
  }
  return { names: [], body: true };
}

export interface Qualified {
  /** Components of the qualifier written before the name: `A::B<T>::f` -> ['A', 'B<T>']. */
  qual: string[];
  /** Written with a leading `::`. */
  global: boolean;
  /** Index of the first token of the qualified name (the leading `::`, or the first component). */
  first: number;
}

/**
 * The qualifier written in front of the identifier at token `name`, read back through
 * `A::`, `B<args>::` (template arguments holding none of `; { } ( ) < >`) and a leading `::`.
 * Its parts are written tight, with nothing between them.
 */
export function qualifierBefore(doc: Doc, name: number): Qualified | null {
  if (doc.k(name) !== K.Identifier) return null;
  const qual: string[] = [];
  let j = name;
  while (j >= 2 && doc.k(j - 1) === K.ColonColon && doc.tight(j)) {
    let k = j - 2;
    if (!doc.tight(j - 1)) break;
    let comp: string;
    if (doc.k(k) === K.Greater) {
      let m = k - 1;
      while (m >= 0 && !TEMPLATE_STOP.has(doc.k(m)!)) m--;
      if (m < 1 || doc.k(m) !== K.Less || doc.k(m - 1) !== K.Identifier || !doc.tight(m)) break;
      comp = doc.t(m - 1)! + squeeze(doc.text.slice(doc.toks[m].s, doc.toks[k].e));
      k = m - 1;
    } else if (doc.k(k) === K.Identifier) {
      comp = doc.t(k)!;
    } else break;
    qual.unshift(comp);
    j = k;
  }
  let global = false;
  if (doc.k(j - 1) === K.ColonColon && doc.tight(j) && !(isWordChar(doc.text[doc.toks[j - 1].s - 1]))) {
    global = true;
    j--;
  }
  return { qual, global, first: j };
}

const TEMPLATE_STOP = new Set<K>([K.Semicolon, K.LeftBrace, K.RightBrace, K.LeftParen, K.RightParen,
  K.Less, K.Greater, K.LessLess, K.GreaterGreater, K.LessEqual, K.GreaterEqual, K.LessLessEqual,
  K.GreaterGreaterEqual, K.Spaceship]);

export const CONVENTIONS = new Set<K>([K.CallingConvCdecl, K.CallingConvStdcall, K.CallingConvFastcall,
  K.CallingConvThiscall, K.CallingConvVectorcall, K.CallingConvClrcall]);

const NOT_A_TYPE = new Set<K>([K.Return, K.Else, K.New, K.Delete, K.Case, K.Throw, K.Goto, K.Sizeof,
  K.Operator, K.Do, K.If, K.While, K.For, K.Switch]);

export interface Declarator extends Qualified {
  name: string;
  /** `__thiscall` written right before the qualified name. */
  thiscall: boolean;
}

/**
 * The function declarator whose name is the identifier at token `i` (followed by `(`): a
 * name with its qualifier, after a type - a word, `*`, `&` or a template's `>` - and an
 * optional calling convention. A name after `return`, `new`, an operator or a punctuator is
 * a call or an expression, not a declarator.
 */
export function declaratorAt(doc: Doc, i: number): Declarator | null {
  if (doc.k(i) !== K.Identifier || doc.k(i + 1) !== K.LeftParen || !doc.wsBefore(i + 1)) return null;
  const q = qualifierBefore(doc, i)!;
  let p = q.first - 1;
  let thiscall = false;
  if (CONVENTIONS.has(doc.k(p)!)) {
    thiscall = doc.k(p) === K.CallingConvThiscall && !q.global && doc.wsBefore(q.first) && !doc.tight(q.first);
    p--;
  }
  const pk = doc.k(p);
  if (pk === undefined || NOT_A_TYPE.has(pk)) return null;
  const typeEnd = doc.word(p) || pk === K.Star || pk === K.Ampersand || pk === K.AmpAmp ||
    pk === K.Greater || pk === K.GreaterGreater;
  if (!typeEnd) return null;
  return { ...q, name: doc.t(i)!, thiscall };
}

/** `s` without its whitespace: the spelling of a template argument list as a name part. */
export function squeeze(s: string): string {
  let out = '';
  for (const c of s) if (!isSpace(c)) out += c;
  return out;
}

/**
 * The function `__thiscall QUAL name(` declares, read forward from the `__thiscall` at token
 * `conv`: whitespace, then a qualifier written tight (`A::`, `B<args>::`), the name, `(`.
 */
export function thiscallDeclAt(doc: Doc, conv: number): (Declarator & { nameAt: number }) | null {
  if (doc.k(conv) !== K.CallingConvThiscall) return null;
  let j = conv + 1;
  if (j >= doc.length || doc.tight(j) || !doc.wsBefore(j)) return null;
  const qual: string[] = [];
  for (;;) {
    if (doc.k(j) !== K.Identifier) return null;
    if (doc.k(j + 1) === K.LeftParen && doc.wsBefore(j + 1)) {
      return { qual, global: false, first: conv + 1, name: doc.t(j)!, thiscall: true, nameAt: j };
    }
    let k = j + 1;
    let comp = doc.t(j)!;
    if (doc.k(k) === K.Less && doc.tight(k)) {
      let m = k + 1;
      while (m < doc.length && !TEMPLATE_STOP.has(doc.k(m)!)) m++;
      if (doc.k(m) !== K.Greater) return null;
      comp += squeeze(doc.text.slice(doc.toks[k].s, doc.toks[m].e));
      k = m + 1;
    }
    if (doc.k(k) !== K.ColonColon || !doc.tight(k) || !doc.tight(k + 1)) return null;
    qual.push(comp);
    j = k + 1;
  }
}

export function qualifiedName(scope: string[], d: Qualified & { name: string }): string {
  return [...(d.global ? [] : scope), ...d.qual, d.name].join('::');
}
