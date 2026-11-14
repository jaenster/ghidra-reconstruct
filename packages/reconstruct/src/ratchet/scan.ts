/**
 * Token-level views of emitted C++ that the ratchet needs before it parses anything: where
 * each function definition starts and ends, which namespace encloses it, and what the
 * headers declare (function declarations by address, struct fields by offset, enum
 * constants by value, typedef names).
 *
 * Everything here reads the C++ lexer's tokens and trivia, never the raw text: a marker in
 * a string literal or a brace in a comment cannot move an extent.
 */
import { Lexer, TokenKind, TriviaKind } from '@ghidra-mcp/cpp-parser';

export interface Trivium { kind: TriviaKind; text: string; start: number; line: number }
export interface Tok {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  line: number;
  lead: Trivium[];
  trail: Trivium[];
}

/** The tokens of a C++ text with their trivia, or undefined when it does not lex. */
export function lexTokens(text: string): Tok[] | undefined {
  let raw;
  try {
    raw = new Lexer(text, { preserveTrivia: true }).tokenizeWithTrivia();
  } catch {
    return undefined;
  }
  const conv = (t: { kind: TriviaKind; text: string; location: { start: { offset: number; line: number } } }): Trivium =>
    ({ kind: t.kind, text: t.text, start: t.location.start.offset, line: t.location.start.line });
  return raw.map(r => ({
    kind: r.token.kind,
    text: r.token.text,
    start: r.token.location.start.offset,
    end: r.token.location.end.offset,
    line: r.token.location.start.line,
    lead: r.leadingTrivia.map(conv),
    trail: r.trailingTrivia.map(conv),
  }));
}

/** `// 1.14d: 0057eab0` -> `0057eab0`; anything else (a thunk's longer marker too) -> undefined. */
export function markerAddress(comment: string): string | undefined {
  const prefix = '// 1.14d: ';
  if (!comment.startsWith(prefix)) return undefined;
  let rest = comment.slice(prefix.length).trim();
  if (rest.startsWith('0x')) rest = rest.slice(2);
  if (rest.length < 6 || rest.length > 8) return undefined;
  for (const c of rest.toLowerCase()) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return undefined;
  return rest.toLowerCase().padStart(8, '0');
}

/** The marker on its own line before `t` (one trailing the previous token is a header declaration's). */
function leadMarker(t: Tok, prevLine: number): { address: string; start: number } | undefined {
  let found: { address: string; start: number } | undefined;
  for (const tr of t.lead) {
    if (tr.kind === TriviaKind.LineComment && tr.line > prevLine) {
      const a = markerAddress(tr.text);
      if (a) found = { address: a, start: tr.start };
    }
  }
  return found;
}

const IDENT = TokenKind.Identifier;
const ATTRIBUTE_WORDS = new Set(['__attribute__', '__declspec', 'alignas', '_Alignas']);

/** A function definition in a .cpp, located by the `// 1.14d:` line before it. */
export interface FunctionExtent {
  address: string;
  /** Offset of the `// 1.14d:` comment line. */
  markerStart: number;
  /** Offset of the first token of the definition (after the marker line). */
  start: number;
  /** Offset of the body's `{`. */
  bodyStart: number;
  /** Offset one past the body's `}`. */
  end: number;
  /** The namespaces enclosing the definition, outermost first. */
  scope: string[];
  /** The declarator as spelled, `Class::method` or `name`. */
  declarator: string[];
  isStatic: boolean;
  isInline: boolean;
  /** Token index range of the signature, [first, bodyStart). */
  sigTokens: [number, number];
}

export interface CppScan {
  tokens: Tok[];
  functions: FunctionExtent[];
}

/** Read a qualified name `a::b::c` starting at token i; returns the parts and the next index. */
function readQualified(toks: Tok[], i: number): { parts: string[]; next: number } {
  const parts: string[] = [];
  while (i < toks.length && toks[i].kind === IDENT) {
    parts.push(toks[i].text);
    if (toks[i + 1]?.kind === TokenKind.ColonColon && toks[i + 2]?.kind === IDENT) i += 2;
    else { i += 1; break; }
  }
  return { parts, next: i };
}

/** Index of the brace closing the one at `open`, or -1. */
export function matchBrace(toks: Tok[], open: number): number {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    const k = toks[i].kind;
    if (k === TokenKind.LeftBrace) depth++;
    else if (k === TokenKind.RightBrace) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Index of the paren closing the one at `open`, or -1. */
export function matchParen(toks: Tok[], open: number): number {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    const k = toks[i].kind;
    if (k === TokenKind.LeftParen) depth++;
    else if (k === TokenKind.RightParen) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Index one past an attribute group starting at token `i` - `__attribute__((..))`,
 * `__declspec(..)`, `alignas(..)` or `[[..]]` - or `i` when none starts there.
 */
export function skipAttribute(toks: Tok[], i: number): number {
  const t = toks[i];
  if (t?.kind === IDENT && ATTRIBUTE_WORDS.has(t.text) && toks[i + 1]?.kind === TokenKind.LeftParen) {
    const close = matchParen(toks, i + 1);
    return close < 0 ? i : close + 1;
  }
  if (t?.kind === TokenKind.LeftAttrBracket) {
    for (let k = i + 1; k < toks.length; k++) if (toks[k].kind === TokenKind.RightAttrBracket) return k + 1;
  }
  return i;
}

/** The tokens of `[from, to)` without their attribute groups. */
function withoutAttributes(toks: Tok[], from: number, to: number): Tok[] {
  const out: Tok[] = [];
  for (let i = from; i < to;) {
    const n = skipAttribute(toks, i);
    if (n > i) { i = n; continue; }
    out.push(toks[i++]);
  }
  return out;
}

/**
 * The declarator (name before the parameter list) of a signature token range. Attribute
 * groups (`__attribute__((noinline)) inline void f(..)`) are not the declarator: their
 * parentheses are skipped.
 */
export function signatureDeclarator(toks: Tok[], from: number, to: number): { name: string[]; paren: number } | undefined {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const skip = skipAttribute(toks, i);
    if (skip > i) { i = skip - 1; continue; }
    const k = toks[i].kind;
    if (k === TokenKind.Less) depth++;
    else if (k === TokenKind.Greater) depth--;
    if (k === TokenKind.LeftParen && depth <= 0) {
      // Walk back over `a::b::~c` / `operator==`.
      const name: string[] = [];
      let j = i - 1;
      if (toks[j]?.kind === IDENT) {
        name.unshift(toks[j].text);
        if (toks[j - 1]?.kind === TokenKind.Tilde) { name[0] = '~' + name[0]; j--; }
        j--;
        while (toks[j]?.kind === TokenKind.ColonColon && toks[j - 1]?.kind === IDENT) {
          name.unshift(toks[j - 1].text);
          j -= 2;
        }
        return { name, paren: i };
      }
      return undefined;
    }
  }
  return undefined;
}

/** Find every marked function definition in a .cpp text. */
export function scanCpp(text: string): CppScan | undefined {
  const toks = lexTokens(text);
  if (!toks) return undefined;
  const functions: FunctionExtent[] = [];
  const scope: Array<{ name?: string[] }> = [];
  const nsScope = () => scope.flatMap(s => s.name ?? []);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === TokenKind.EOF) break;
    if (t.kind === TokenKind.Namespace) {
      const q = readQualified(toks, i + 1);
      if (toks[q.next]?.kind === TokenKind.LeftBrace) {
        scope.push({ name: q.parts });
        i = q.next;
        continue;
      }
    }
    if (t.kind === TokenKind.LeftBrace) { scope.push({}); continue; }
    if (t.kind === TokenKind.RightBrace) { scope.pop(); continue; }
    const marker = leadMarker(t, toks[i - 1]?.line ?? 0);
    if (!marker) continue;
    // The definition: tokens to the first top-level `{` (a definition) or `;` (not one).
    let j = i;
    let paren = 0;
    for (; j < toks.length; j++) {
      const k = toks[j].kind;
      if (k === TokenKind.LeftParen) paren++;
      else if (k === TokenKind.RightParen) paren--;
      else if (paren === 0 && (k === TokenKind.LeftBrace || k === TokenKind.Semicolon || k === TokenKind.EOF)) break;
    }
    if (toks[j]?.kind !== TokenKind.LeftBrace) continue;
    const close = matchBrace(toks, j);
    if (close < 0) break;
    const decl = signatureDeclarator(toks, i, j);
    let isStatic = false;
    let isInline = false;
    for (let k = i; k < j; k++) {
      if (toks[k].kind === TokenKind.Static) isStatic = true;
      if (toks[k].text === 'inline' || toks[k].text === '__inline' || toks[k].text === '__forceinline') isInline = true;
    }
    functions.push({
      address: marker.address,
      markerStart: marker.start,
      start: t.start,
      bodyStart: toks[j].start,
      end: toks[close].end,
      scope: nsScope(),
      declarator: decl?.name ?? [],
      isStatic,
      isInline,
      sigTokens: [i, j],
    });
    i = close;
  }
  return { tokens: toks, functions };
}

/** A type as the ratchet needs it: the named base and how many pointer levels sit on it. */
export interface TypeRef { base: string; ptr: number }

const BUILTIN_WORDS = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'bool', 'signed', 'unsigned', '__int64', '__int32',
  '__int16', '__int8', 'wchar_t',
]);
const SKIP_WORDS = new Set([
  'const', 'volatile', 'struct', 'union', 'class', 'enum', 'static', 'inline', 'extern', '__inline', '__forceinline',
  '__cdecl', '__stdcall', '__fastcall', '__thiscall', '__declspec', 'typename', 'register', 'mutable',
]);

/** A TypeRef from the tokens of a type spelling (`struct D2UnitStrc * const`). */
export function typeRefFromTokens(toks: Tok[], from = 0, to = toks.length): TypeRef | undefined {
  let base: string | undefined;
  let ptr = 0;
  let depth = 0;
  for (let i = from; i < to; i++) {
    const t = toks[i];
    if (t.kind === TokenKind.Less) { depth++; continue; }
    if (t.kind === TokenKind.Greater) { depth--; continue; }
    if (depth > 0) continue;
    if (t.kind === TokenKind.Star || t.kind === TokenKind.Ampersand || t.kind === TokenKind.AmpAmp) { if (t.kind === TokenKind.Star) ptr++; continue; }
    if (SKIP_WORDS.has(t.text)) continue;
    if (t.kind === TokenKind.ColonColon) continue;
    if (t.kind === IDENT || BUILTIN_WORDS.has(t.text)) {
      // `a::b` keeps the last part; a builtin word run keeps its last word.
      base = t.text;
    }
  }
  return base ? { base, ptr } : undefined;
}

export function typeRefFromText(text: string): TypeRef | undefined {
  const toks = lexTokens(text);
  return toks ? typeRefFromTokens(toks.filter(t => t.kind !== TokenKind.EOF)) : undefined;
}

/** Parameter names and the return type of a signature token range `[from, to)`. */
/** A type spelling compared across trees: its tokens, without elaborating keywords or a leading `::`. */
export function typeSpelling(toks: Tok[], skip?: number): string {
  const out: string[] = [];
  let prev: TokenKind | undefined;
  toks.forEach((t, k) => {
    if (k === skip) return;
    if (t.kind === TokenKind.Struct || t.kind === TokenKind.Class || t.kind === TokenKind.Union || t.kind === TokenKind.Enum) return;
    // A `::` that does not follow a name or a template's `>` is a leading one.
    if (t.kind === TokenKind.ColonColon && prev !== IDENT && prev !== TokenKind.Greater) return;
    out.push(t.text);
    prev = t.kind;
  });
  return out.join(' ');
}

const SIGNATURE_WORDS = new Set(['static', 'inline', '__inline', '__forceinline', 'extern', '__cdecl', '__stdcall', '__fastcall', '__thiscall', 'virtual', 'constexpr']);

export function signatureParts(toks: Tok[], from: number, to: number): { params: string[]; types: string[]; ret?: TypeRef; retText: string } | undefined {
  const d = signatureDeclarator(toks, from, to);
  if (!d) return undefined;
  const close = matchParen(toks, d.paren);
  if (close < 0) return undefined;
  const params: string[] = [];
  const types: string[] = [];
  let segStart = d.paren + 1;
  let depth = 0;
  const flush = (end: number) => {
    if (end <= segStart) return;
    const seg = toks.slice(segStart, end);
    if (seg.length === 1 && seg[0].text === 'void') return;
    if (seg.length === 1 && seg[0].kind === TokenKind.Ellipsis) { params.push('...'); types.push('...'); return; }
    let nameAt = -1;
    // `T (*name)(args)` names the inner identifier; otherwise the last identifier before
    // an array suffix or a default value.
    let name: string | undefined;
    for (let k = 0; k < seg.length - 2; k++) {
      if (seg[k].kind === TokenKind.LeftParen && seg[k + 1].kind === TokenKind.Star && seg[k + 2].kind === IDENT) { name = seg[k + 2].text; nameAt = k + 2; break; }
    }
    let stop = seg.length;
    if (!name) {
      for (let k = 0; k < seg.length; k++) if (seg[k].kind === TokenKind.LeftBracket || seg[k].kind === TokenKind.Equal) { stop = k; break; }
      const last = seg[stop - 1];
      if (last && last.kind === IDENT && stop > 1) { name = last.text; nameAt = stop - 1; }
    }
    params.push(name ?? '');
    // The default value is not part of the type.
    let eq = seg.length;
    for (let k = 0; k < seg.length; k++) if (seg[k].kind === TokenKind.Equal) { eq = k; break; }
    types.push(typeSpelling(seg.slice(0, eq), nameAt >= 0 && nameAt < eq ? nameAt : undefined));
  };
  for (let i = d.paren + 1; i < close; i++) {
    const k = toks[i].kind;
    if (k === TokenKind.LeftParen || k === TokenKind.LeftBracket || k === TokenKind.Less) depth++;
    else if (k === TokenKind.RightParen || k === TokenKind.RightBracket || k === TokenKind.Greater) depth--;
    else if (k === TokenKind.Comma && depth === 0) { flush(i); segStart = i + 1; }
  }
  flush(close);
  // The return type: the tokens before the declarator's qualified name.
  let nameStart = d.paren - 1;
  while (toks[nameStart - 1]?.kind === TokenKind.ColonColon || toks[nameStart - 1]?.kind === TokenKind.Tilde) nameStart -= toks[nameStart - 1].kind === TokenKind.Tilde ? 1 : 2;
  const retToks = withoutAttributes(toks, from, nameStart);
  const ret = typeRefFromTokens(retToks);
  const retText = typeSpelling(retToks.filter(t => !SIGNATURE_WORDS.has(t.text)));
  return { params, types, ret, retText };
}

/**
 * Parameter type spellings an older scanner read off an attribute group's parentheses
 * (`__attribute__((noinline)) inline void f(int)` stored as `( noinline )`): no parameter
 * type spelling starts with a parenthesis.
 */
export function misparsedTypes(types: readonly string[] | undefined): boolean {
  return !!types && types.some(t => t.startsWith('('));
}

/** The signature of a definition's text (`R f(..) {..}`): what signatureParts reads. */
export function definitionSignature(text: string): ReturnType<typeof signatureParts> {
  const toks = lexTokens(text);
  if (!toks) return undefined;
  let paren = 0;
  for (let j = 0; j < toks.length; j++) {
    const k = toks[j].kind;
    if (k === TokenKind.LeftParen) paren++;
    else if (k === TokenKind.RightParen) paren--;
    else if (paren === 0 && k === TokenKind.LeftBrace) return signatureParts(toks, 0, j);
    else if (paren === 0 && (k === TokenKind.Semicolon || k === TokenKind.EOF)) return undefined;
  }
  return undefined;
}

export interface HeaderDecl { address: string; scope: string[]; name: string[]; params: string[]; types: string[]; ret?: TypeRef; retText: string }
export interface HeaderField { name: string; offset: number; type?: TypeRef }
export interface HeaderStruct { qname: string; fields: HeaderField[] }
/**
 * An enum's constants. A C++ `enum` declares them in its own scope (`scope`); the generator's
 * form (codegen/header.ts, index.ts) is `typedef T E; namespace E_ns { constexpr E C = v; }`
 * plus `using E_ns::C;` or `using namespace E_ns;` for the names it exports: then `ns` is the
 * namespace the constants are declared in, and only the names in `exported` (all of them
 * with `exportAll`) are visible in `scope`.
 */
export interface HeaderEnum {
  qname: string;
  scope: string[];
  consts: Array<{ name: string; value: string }>;
  ns?: string[];
  exported?: Set<string>;
  exportAll?: boolean;
}
/** `using N::C;` (`name` set) or `using namespace N;`, declared in `scope`. */
export interface HeaderUsing { scope: string[]; target: string[]; name?: string }
export interface HeaderScan {
  decls: HeaderDecl[];
  structs: HeaderStruct[];
  enums: HeaderEnum[];
  typedefs: string[];
  usings: HeaderUsing[];
}

/** The suffix of the namespace the generator declares an enum's constants in. */
export const ENUM_NAMESPACE_SUFFIX = '_ns';

function parseOffsetComment(text: string): number | undefined {
  if (!text.startsWith('/*') || !text.endsWith('*/')) return undefined;
  const inner = text.slice(2, -2).trim();
  if (!inner.startsWith('0x')) return undefined;
  const n = Number.parseInt(inner.slice(2), 16);
  return Number.isFinite(n) && inner.slice(2).length > 0 ? n : undefined;
}

function evalEnumValue(toks: Tok[], prev: string | undefined): string {
  if (toks.length === 0) {
    if (prev === undefined) return '0';
    const n = Number(prev);
    return Number.isFinite(n) ? String(n + 1) : `${prev}+1`;
  }
  const text = toks.map(t => t.text).join('');
  const neg = text.startsWith('-');
  const body = neg ? text.slice(1) : text;
  const clean = body.replace(/[uUlL]+$/u, '');
  const n = clean.startsWith('0x') || clean.startsWith('0X') ? Number.parseInt(clean.slice(2), 16) : Number(clean);
  return Number.isFinite(n) ? String(neg ? -n : n) : text;
}

/**
 * What a header declares: function declarations carrying a `// 1.14d:` comment, struct and
 * union fields with their `/* 0xNN *\/` offsets, enum constants with their values, typedef names.
 */
export function scanHeader(text: string): HeaderScan | undefined {
  const toks = lexTokens(text);
  if (!toks) return undefined;
  const out: HeaderScan = { decls: [], structs: [], enums: [], typedefs: [], usings: [] };
  // Markers by the line they sit on: a declaration's comment trails its `;`.
  const markerByLine = new Map<number, string>();
  for (const t of toks) {
    for (const tr of [...t.lead, ...t.trail]) {
      if (tr.kind !== TriviaKind.LineComment) continue;
      const a = markerAddress(tr.text);
      if (a) markerByLine.set(tr.line, a);
    }
  }
  type Scope = { kind: 'ns' | 'struct' | 'enum' | 'block'; name?: string[]; struct?: HeaderStruct; en?: HeaderEnum };
  const scope: Scope[] = [];
  const nsParts = () => scope.flatMap(s => (s.kind === 'ns' || s.kind === 'struct') && s.name ? s.name : []);
  let stmtStart = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === TokenKind.EOF) break;
    const top = scope[scope.length - 1];
    if (t.kind === TokenKind.Namespace) {
      const q = readQualified(toks, i + 1);
      if (toks[q.next]?.kind === TokenKind.LeftBrace) {
        scope.push({ kind: 'ns', name: q.parts });
        i = q.next;
        stmtStart = i + 1;
        continue;
      }
    }
    if ((t.kind === TokenKind.Struct || t.kind === TokenKind.Union || t.kind === TokenKind.Class) && i === stmtStart
      || ((t.kind === TokenKind.Struct || t.kind === TokenKind.Union) && toks[i - 1]?.kind === TokenKind.Typedef && i - 1 === stmtStart)) {
      // `struct Name [: bases] {` or `typedef struct Name {` or an anonymous `union {`,
      // with `__attribute__((packed))` / `__declspec(..)` / `alignas(..)` before the name.
      let n0 = i + 1;
      while (toks[n0]?.kind === IDENT && ATTRIBUTE_WORDS.has(toks[n0].text) && toks[n0 + 1]?.kind === TokenKind.LeftParen) {
        const close = matchParen(toks, n0 + 1);
        if (close < 0) break;
        n0 = close + 1;
      }
      const q = readQualified(toks, n0);
      let k = q.next;
      if (toks[k]?.kind === TokenKind.Colon) {
        while (k < toks.length && toks[k].kind !== TokenKind.LeftBrace && toks[k].kind !== TokenKind.Semicolon) k++;
      }
      if (toks[k]?.kind === TokenKind.LeftBrace) {
        const outer = top?.kind === 'struct' ? top.struct : undefined;
        if (q.parts.length > 0) {
          const qname = [...nsParts(), ...q.parts].join('::');
          const st: HeaderStruct = { qname, fields: [] };
          out.structs.push(st);
          scope.push({ kind: 'struct', name: q.parts, struct: st });
        } else if (outer) {
          // An anonymous aggregate inside a struct: its members are the outer struct's.
          scope.push({ kind: 'struct', struct: outer });
        } else {
          scope.push({ kind: 'block' });
        }
        i = k;
        stmtStart = i + 1;
        continue;
      }
    }
    if (t.kind === TokenKind.Enum && i === stmtStart || (t.kind === TokenKind.Enum && toks[i - 1]?.kind === TokenKind.Typedef && i - 1 === stmtStart)) {
      let k = i + 1;
      if (toks[k]?.kind === TokenKind.Class || toks[k]?.kind === TokenKind.Struct) k++;
      const q = readQualified(toks, k);
      k = q.next;
      if (toks[k]?.kind === TokenKind.Colon) {
        while (k < toks.length && toks[k].kind !== TokenKind.LeftBrace && toks[k].kind !== TokenKind.Semicolon) k++;
      }
      if (toks[k]?.kind === TokenKind.LeftBrace) {
        const close = matchBrace(toks, k);
        if (close < 0) break;
        const en: HeaderEnum = { qname: [...nsParts(), ...q.parts].join('::'), scope: nsParts(), consts: [] };
        let prev: string | undefined;
        let segStart = k + 1;
        const flush = (end: number) => {
          if (end <= segStart || toks[segStart].kind !== IDENT) return;
          const name = toks[segStart].text;
          const valueToks = toks[segStart + 1]?.kind === TokenKind.Equal ? toks.slice(segStart + 2, end) : [];
          const value = evalEnumValue(valueToks, prev);
          prev = value;
          en.consts.push({ name, value });
        };
        let depth = 0;
        for (let m = k + 1; m < close; m++) {
          const mk = toks[m].kind;
          if (mk === TokenKind.LeftParen) depth++;
          else if (mk === TokenKind.RightParen) depth--;
          else if (mk === TokenKind.Comma && depth === 0) { flush(m); segStart = m + 1; }
        }
        flush(close);
        out.enums.push(en);
        i = close;
        // `typedef enum X {..} Y;` - the trailing name is a typedef.
        continue;
      }
    }
    if (t.kind === TokenKind.LeftBrace) {
      // A function body or an initializer inside a header: skip it whole.
      const close = matchBrace(toks, i);
      if (close < 0) break;
      i = close;
      if (toks[i + 1]?.kind !== TokenKind.Semicolon) stmtStart = i + 1;
      continue;
    }
    if (t.kind === TokenKind.RightBrace) {
      scope.pop();
      // `} Name;` after a typedef'd aggregate names a typedef.
      if (toks[i + 1]?.kind === IDENT && toks[i + 2]?.kind === TokenKind.Semicolon) out.typedefs.push([...nsParts(), toks[i + 1].text].join('::'));
      stmtStart = i + 1;
      continue;
    }
    if (t.kind === TokenKind.Colon && (toks[i - 1]?.text === 'public' || toks[i - 1]?.text === 'private' || toks[i - 1]?.text === 'protected') && i - 1 === stmtStart) {
      stmtStart = i + 1;
      continue;
    }
    if (t.kind !== TokenKind.Semicolon) continue;
    // One statement [stmtStart, i).
    const from = stmtStart;
    stmtStart = i + 1;
    if (from >= i) continue;
    const first = toks[from];
    if (first.kind === TokenKind.Typedef || first.text === 'using') {
      if (first.text === 'using' && toks[from + 1]?.kind === IDENT && toks[from + 2]?.kind === TokenKind.Equal) {
        out.typedefs.push([...nsParts(), toks[from + 1].text].join('::'));
      } else if (first.text === 'using' && toks[from + 1]?.text === 'namespace') {
        const q = readQualified(toks, from + 2);
        if (q.parts.length > 0 && q.next === i) out.usings.push({ scope: nsParts(), target: q.parts });
      } else if (first.text === 'using') {
        const q = readQualified(toks, from + 1);
        if (q.parts.length > 1 && q.next === i) out.usings.push({ scope: nsParts(), target: q.parts.slice(0, -1), name: q.parts[q.parts.length - 1] });
      } else if (first.kind === TokenKind.Typedef) {
        // `typedef R (__stdcall *Name)(..)` or `typedef T Name[..]` or `typedef T Name`.
        let name: string | undefined;
        for (let k = from; k < i - 2; k++) {
          if (toks[k].kind === TokenKind.Star && toks[k + 1].kind === IDENT && toks[k + 2].kind === TokenKind.RightParen) { name = toks[k + 1].text; break; }
        }
        if (!name) {
          let stop = i;
          for (let k = from; k < i; k++) if (toks[k].kind === TokenKind.LeftBracket) { stop = k; break; }
          if (toks[stop - 1]?.kind === IDENT) name = toks[stop - 1].text;
        }
        if (name) out.typedefs.push([...nsParts(), name].join('::'));
      }
      continue;
    }
    const enumNs = top?.kind === 'ns' && top.name ? top.name[top.name.length - 1] : undefined;
    if (enumNs && enumNs.endsWith(ENUM_NAMESPACE_SUFFIX) && enumNs.length > ENUM_NAMESPACE_SUFFIX.length && first.text === 'constexpr') {
      // `constexpr E C = v;` inside `namespace E_ns`: a constant of the enum E.
      const e = enumNs.slice(0, -ENUM_NAMESPACE_SUFFIX.length);
      if (toks[from + 1]?.kind === IDENT && toks[from + 1].text === e && toks[from + 2]?.kind === IDENT && toks[from + 3]?.kind === TokenKind.Equal && from + 4 < i) {
        const ns = nsParts();
        const outer = ns.slice(0, -1);
        const nsKey = ns.join('::');
        let en = out.enums.find(x => x.ns?.join('::') === nsKey);
        if (!en) {
          en = { qname: [...outer, e].join('::'), scope: outer, consts: [], ns, exported: new Set() };
          out.enums.push(en);
        }
        en.consts.push({ name: toks[from + 2].text, value: evalEnumValue(toks.slice(from + 4, i), undefined) });
      }
      continue;
    }
    if (top?.kind === 'struct' && top.struct) {
      // A field: its offset is the block comment leading its first token.
      let offset: number | undefined;
      for (const tr of first.lead) {
        if (tr.kind === TriviaKind.BlockComment) {
          const o = parseOffsetComment(tr.text);
          if (o !== undefined) offset = o;
        }
      }
      if (offset === undefined) continue;
      let name: string | undefined;
      let nameAt = -1;
      for (let k = from; k < i - 2; k++) {
        if (toks[k].kind === TokenKind.LeftParen && toks[k + 1].kind === TokenKind.Star && toks[k + 2].kind === IDENT) { name = toks[k + 2].text; nameAt = k; break; }
        if (toks[k].kind === TokenKind.LeftParen && (toks[k + 1].text.startsWith('__') && toks[k + 2]?.kind === TokenKind.Star && toks[k + 3]?.kind === IDENT)) { name = toks[k + 3].text; nameAt = k; break; }
      }
      let type: TypeRef | undefined;
      if (name) {
        type = { base: '(fn)', ptr: 1 };
      } else {
        let stop = i;
        for (let k = from; k < i; k++) {
          const kk = toks[k].kind;
          if (kk === TokenKind.LeftBracket || kk === TokenKind.Colon || kk === TokenKind.Equal) { stop = k; break; }
        }
        if (toks[stop - 1]?.kind === IDENT && stop - 1 > from) {
          name = toks[stop - 1].text;
          nameAt = stop - 1;
          type = typeRefFromTokens(toks, from, nameAt);
          // An array field decays to a pointer when indexed or used.
          if (type && toks[stop]?.kind === TokenKind.LeftBracket) type = { base: type.base, ptr: type.ptr + 1 };
        }
      }
      if (name) top.struct.fields.push({ name, offset, type });
      continue;
    }
    // A function declaration with its address.
    const addr = markerByLine.get(toks[i].line);
    if (!addr) continue;
    const parts = signatureParts(toks, from, i);
    const decl = signatureDeclarator(toks, from, i);
    if (!parts || !decl) continue;
    out.decls.push({ address: addr, scope: nsParts(), name: decl.name, params: parts.params, types: parts.types, ret: parts.ret, retText: parts.retText });
  }
  // What each `using` exports of an enum namespace declared in this header.
  for (const u of out.usings) {
    for (const en of out.enums) {
      if (!en.ns || !usingNames(u, en.ns)) continue;
      if (u.name === undefined) en.exportAll = true;
      else en.exported!.add(u.name);
    }
  }
  return out;
}

/** Does `using` `u` name namespace `ns` (by C++ lookup from the scope it is declared in)? */
export function usingNames(u: HeaderUsing, ns: string[]): boolean {
  const target = u.target.join('::');
  for (let k = u.scope.length; k >= 0; k--) {
    if ([...u.scope.slice(0, k), target].join('::') === ns.join('::')) return true;
  }
  return false;
}
