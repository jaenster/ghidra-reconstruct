/**
 * Call results stored to temporaries just to be passed on, nested back into the call (VC8 only).
 *
 *   t1 = f1();
 *   T2 t2 = f2();
 *   g(a, t2, t1);                      ->  g(a, (T2)(f2()), (T1)(f1()));
 *
 * The decompiler gives every call result a variable, so a call whose arguments were calls
 * comes out as a run of stores right before it, one per argument, in the order the original
 * evaluated them. VC8 evaluates arguments right to left and pushes each value as it comes, so
 * the nested original holds none of them; ours holds every one across the next call and spills
 * what does not fit in a callee-saved register (MISSILESMODE_SrvDoFn21_Distraction 005af590:
 * frame and 14 instructions more, MATCH once nested). GCC's argument order is unspecified, so
 * the generated tree keeps the temporaries and only the VC8 translation nests them.
 *
 * A run is nested when all of these hold, else it is left as written:
 * - its stores (`t = E;` or a one-declarator `T t = E;`) stand one after another right before
 *   the statement holding the call, nothing but comments between them;
 * - each temporary is a local the function names only in those stores, as those arguments
 *   (each the whole argument) and in one lone declaration: every value it holds is read once,
 *   by the call right after its store, and its address is never taken;
 * - the stores run in the order VC8 evaluates those arguments, right to left, and every
 *   argument between two nested calls nests too;
 * - it is two stores or more, at least one of them a call: a single temporary costs VC8 no
 *   frame slot, and nesting single ones lost 51 functions their MATCH;
 * - each stored value is a call or, in `values` mode (the default), free of side effects -
 *   with the order kept, a load moves nowhere relative to the calls;
 * - the call's other arguments have no side effect (no call, `++`/`--`, assignment, `new`,
 *   `delete`), and those VC8 now evaluates before one of the nested calls read only locals
 *   whose address is never taken, constants and enumerators - nothing a call could change;
 * - the function names nothing `volatile`.
 * Of a longer run the nested part is the stores nearest the call that pass. Each nested value
 * is cast to its temporary's type, so it converts exactly as the store did. Edits keep every
 * line: a nested store's text and its declaration are blanked, and a store written over
 * several lines is left alone.
 */

import { Doc, K, applyEdits, type Edit } from './doc.js';
import { statementStart, scopes } from './syntax.js';
import { lastPart, type TreeState } from './facts.js';
import { functionVariables } from './types.js';

/** Which stores join a run: only call results, or side-effect-free values too. */
export type ArgNestMode = 'off' | 'calls' | 'values';

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
const EFFECT_WORDS = new Set(['new', 'delete', 'throw', 'volatile', '__asm', 'asm', 'goto']);
const TYPE_WORDS = new Set(['const', 'struct', 'class', 'union', 'enum', 'unsigned', 'signed']);

const functionNames = new WeakMap<TreeState, Set<string>>();

/** Unqualified names of every function the tree declares: what a call may name (no macro). */
function declaredNames(state: TreeState): Set<string> {
  let s = functionNames.get(state);
  if (!s) {
    s = new Set([...state.declared].map(lastPart));
    functionNames.set(state, s);
  }
  return s;
}

export interface ArgNestSite {
  line: number;
  callee: string;
  nested: number;
}

interface Store {
  /** First token and the `;`. */
  a: number;
  semi: number;
  name: string;
  /** Tokens of the stored value: [vs, semi). */
  vs: number;
  /** The declared type's text, for a `T t = E;` store. */
  type: string | null;
}

/** The text of tokens [a, b), as written. */
function span(doc: Doc, a: number, b: number): string {
  return doc.text.slice(doc.toks[a].s, doc.toks[b - 1].e);
}

/** The top-level items of the list opened by the `(` at token `open`, as token ranges. */
function items(doc: Doc, open: number): Array<[number, number]> {
  const close = doc.pair[open];
  const out: Array<[number, number]> = [];
  if (close === open + 1) return out;
  let from = open + 1;
  for (let j = open + 1; j < close; j++) {
    const k = doc.k(j);
    if ((k === K.LeftParen || k === K.LeftBracket || k === K.LeftBrace) && doc.pair[j] > j) j = doc.pair[j];
    else if (k === K.Comma) {
      out.push([from, j]);
      from = j + 1;
    }
  }
  out.push([from, close]);
  return out;
}

/** Tokens [a, b) are a name chain: `f`, `A::f`, `p->pfn`, `s.pfn`. */
function nameChain(doc: Doc, a: number, b: number): boolean {
  if (a >= b) return false;
  for (let j = a; j < b; j++) {
    const k = doc.k(j);
    const name = (j - a) % 2 === 0;
    if (name ? k !== K.Identifier : !(k === K.ColonColon || k === K.Arrow || k === K.Dot)) return false;
  }
  return (b - a) % 2 === 1;
}

/** A top-level token of kind `kind` in [a, b), or -1. */
function topLevel(doc: Doc, a: number, b: number, kind: K): number {
  for (let j = a; j < b; j++) {
    const k = doc.k(j);
    if (k === kind) return j;
    if ((k === K.LeftParen || k === K.LeftBracket || k === K.LeftBrace) && doc.pair[j] > j) j = doc.pair[j];
  }
  return -1;
}

/** Tokens [a, b) call a function as their whole value, behind optional casts: `(T)A::f(x)`. */
function isCall(doc: Doc, a: number, b: number, names: Set<string>): boolean {
  while (a < b && doc.k(a) === K.LeftParen && isCast(doc, a)) a = doc.pair[a] + 1;
  if (b - a < 3 || doc.k(b - 1) !== K.RightParen) return false;
  const open = doc.pair[b - 1];
  if (open <= a || !nameChain(doc, a, open)) return false;
  return open - a > 1 && doc.k(open - 2) !== K.ColonColon ? true : names.has(doc.t(open - 1)!);
}

/** The `(` at token j opens a cast: type words, `::` and `*` only, followed by an operand. */
function isCast(doc: Doc, j: number): boolean {
  const c = doc.pair[j];
  if (c <= j + 1) return false;
  for (let p = j + 1; p < c; p++) {
    const k = doc.k(p);
    if (!(doc.word(p) || k === K.ColonColon || k === K.Star)) return false;
  }
  const next = doc.k(c + 1);
  return next === K.Identifier || next === K.LeftParen || next === K.IntegerLiteral || next === K.Star;
}

/** Tokens [a, b) evaluate with no side effect: no call, increment, assignment, `new`, `delete`. */
function pure(doc: Doc, a: number, b: number): boolean {
  for (let j = a; j < b; j++) {
    const k = doc.k(j);
    const t = doc.t(j)!;
    if (k === K.PlusPlus || k === K.MinusMinus || ASSIGN_OPS.has(t) || EFFECT_WORDS.has(t)) return false;
    if (k === K.LeftParen) {
      const pk = doc.k(j - 1);
      if (j > a && (pk === K.Identifier || pk === K.RightParen || pk === K.RightBracket || pk === K.Greater)) return false;
    }
  }
  return true;
}

/**
 * Tokens [a, b) read nothing a call could change: locals whose address the function never
 * takes, constants, enumerators, casts and operators - no member, subscript, dereference or
 * global.
 */
function stable(doc: Doc, a: number, b: number, locals: Set<string>, addressed: Set<string>, globals: Map<string, string>): boolean {
  for (let j = a; j < b; j++) {
    const k = doc.k(j);
    if (k === K.Arrow || k === K.Dot || k === K.LeftBracket) return false;
    if (k === K.Star || k === K.Ampersand) {
      const pk = doc.k(j - 1);
      const binary = j > a && (pk === K.Identifier || pk === K.RightParen || pk === K.RightBracket ||
        pk === K.IntegerLiteral || pk === K.FloatingLiteral || pk === K.CharLiteral);
      if (!binary && !(k === K.Star && doc.k(j + 1) === K.RightParen)) return false;
    }
    if (k === K.Identifier) {
      if (doc.k(j + 1) === K.ColonColon) continue;
      const name = doc.t(j)!;
      if (locals.has(name)) {
        if (addressed.has(name)) return false;
      } else if (globals.has(name)) return false;
    }
  }
  return true;
}

/** The store statement over tokens [a, semi): `t = E` or a one-declarator `T t = E`. */
function storeAt(doc: Doc, a: number, semi: number): Store | null {
  if (doc.k(a) === K.Identifier && doc.k(a + 1) === K.Equal && a + 2 < semi) {
    return { a, semi, name: doc.t(a)!, vs: a + 2, type: null };
  }
  const eq = topLevel(doc, a, semi, K.Equal);
  if (eq < a + 2 || eq + 1 >= semi || topLevel(doc, a, semi, K.Comma) >= 0) return null;
  const n = eq - 1;
  if (doc.k(n) !== K.Identifier || !typeTokens(doc, a, n)) return null;
  return { a, semi, name: doc.t(n)!, vs: eq + 1, type: span(doc, a, n) };
}

/** Tokens [a, b) spell a type: names, `::`, `*` and the builtin and qualifier words, a word first. */
function typeTokens(doc: Doc, a: number, b: number): boolean {
  if (a >= b || doc.k(a) === K.Star) return false;
  for (let p = a; p < b; p++) {
    const k = doc.k(p);
    if (!(k === K.Identifier || k === K.ColonColon || k === K.Star || TYPE_WORDS.has(doc.t(p)!) || builtinType(doc.t(p)!))) return false;
  }
  return !doc.text.slice(doc.toks[a].s, doc.toks[b - 1].e).includes('\n');
}

function builtinType(t: string): boolean {
  return ['int', 'char', 'short', 'long', 'bool', 'float', 'double', 'void', 'unsigned', 'signed', '__int64',
    '__int8', '__int16', '__int32', 'wchar_t'].includes(t);
}

/** Whether the type text names a struct by value (nested as is, a cast would copy it). */
function structByValue(type: string, state: TreeState): boolean {
  if (type.includes('*')) return false;
  const words = type.split(/[^A-Za-z0-9_]+/).filter(w => w && !TYPE_WORDS.has(w));
  const bare = words[words.length - 1];
  return !!bare && state.types.fields.has(bare);
}

interface RunStore extends Store {
  /** The argument it is passed as. */
  pos: number;
  /** The type it is cast to: its own declaration's, or the variable's one declaration's. */
  type: string;
  /** Its value is a call. */
  call: boolean;
}

/**
 * Index (nearest first) of the first nested call that leaves an argument un-nested between it
 * and the nested calls nearer the call statement, or -1.
 */
function callGap(run: RunStore[]): number {
  const nested = new Set<number>();
  let lowestCall = -1;
  for (let i = 0; i < run.length; i++) {
    const r = run[i];
    if (r.call) {
      if (lowestCall >= 0) for (let p = lowestCall + 1; p < r.pos; p++) if (!nested.has(p)) return i;
      if (lowestCall < 0) lowestCall = r.pos;
    }
    nested.add(r.pos);
  }
  return -1;
}

interface CallSite {
  /** The statement's first token and `;`; the call's callee start, `(` and `)`. */
  a: number;
  semi: number;
  callee: number;
  lp: number;
  rp: number;
  args: Array<[number, number]>;
  /** Its candidate stores, nearest first; cut to what passes. */
  run: RunStore[];
}

/** Each declaration of a local in the body: the name token, and whether it is a lone `T t;`. */
function declarations(doc: Doc, open: number, close: number): Map<string, Array<{ at: number; type: string; lone: boolean }>> {
  const out = new Map<string, Array<{ at: number; type: string; lone: boolean }>>();
  for (let j = open + 1; j < close; j++) {
    if (doc.k(j) !== K.Identifier) continue;
    const nk = doc.k(j + 1);
    if (!(nk === K.Semicolon || nk === K.Equal || nk === K.Comma || nk === K.LeftBracket)) continue;
    const a = statementStart(doc, j);
    if (a >= j || a <= open || !typeTokens(doc, a, j)) continue;
    const name = doc.t(j)!;
    let list = out.get(name);
    if (!list) out.set(name, list = []);
    list.push({ at: j, type: span(doc, a, j), lone: nk === K.Semicolon });
  }
  return out;
}

/** Nest each call's run of argument temporaries; `sites` collects what was nested. */
export function argNestPass(text: string, state: TreeState, mode: ArgNestMode, sites?: ArgNestSite[]): string {
  if (mode === 'off') return text;
  const doc = new Doc(text);
  const sc = scopes(doc);
  const names = declaredNames(state);
  const edits: Edit[] = [];
  const n = doc.length;

  for (let open = 0; open < n; open++) {
    if (doc.k(open) !== K.LeftBrace || open + 1 >= n || sc.table[sc.at[open + 1]].fn !== open) continue;
    const close = doc.pair[open];
    if (close < 0) continue;
    let head = open - 1;
    if (doc.k(head) === K.Const) head--;
    const params = doc.k(head) === K.RightParen ? doc.pair[head] : -1;
    if (params >= 0) edits.push(...nestFunction(doc, open, close, params, state, names, mode, sites));
    open = close;
  }
  return applyEdits(text, edits);
}

function nestFunction(doc: Doc, open: number, close: number, params: number, state: TreeState, names: Set<string>,
    mode: ArgNestMode, sites?: ArgNestSite[]): Edit[] {
  const text = doc.text;
  const count = new Map<string, number>();
  const addressed = new Set<string>();
  for (let j = params; j < close; j++) {
    if (doc.t(j) === 'volatile') return [];
    if (doc.k(j) !== K.Identifier || doc.k(j - 1) === K.Dot || doc.k(j - 1) === K.Arrow) continue;
    const t = doc.t(j)!;
    count.set(t, (count.get(t) ?? 0) + 1);
    if (doc.k(j - 1) === K.Ampersand && !(doc.k(j - 2) === K.Identifier || doc.k(j - 2) === K.RightParen ||
        doc.k(j - 2) === K.RightBracket || doc.k(j - 2) === K.IntegerLiteral)) addressed.add(t);
  }
  const locals = new Set(functionVariables(doc, open).keys());
  const decls = declarations(doc, open, close);

  // Every call statement with the stores that could nest into it.
  const calls: CallSite[] = [];
  for (let semi = open + 1; semi < close; semi++) {
    if (doc.k(semi) !== K.Semicolon) continue;
    const a = statementStart(doc, semi - 1);
    if (a >= semi || a <= open) continue;
    // The call is the statement's value, after nothing, `return`, `x =` or `T x =`.
    const rp = semi - 1;
    if (doc.k(rp) !== K.RightParen) continue;
    const lp = doc.pair[rp];
    if (lp <= a) continue;
    let callee = lp - 1;
    while (callee > a && (doc.k(callee - 1) === K.ColonColon || doc.k(callee - 1) === K.Arrow ||
        doc.k(callee - 1) === K.Dot) && doc.k(callee - 2) === K.Identifier) callee -= 2;
    if (!nameChain(doc, callee, lp)) continue;
    if ((lp - 1 === callee || doc.k(lp - 2) === K.ColonColon) && !names.has(doc.t(lp - 1)!)) continue;
    let lhsName: string | null = null;
    if (callee > a) {
      if (doc.k(a) === K.Return && callee === a + 1) {
        // return g(...);
      } else if (doc.k(callee - 1) === K.Equal) {
        const lhs = storeAt(doc, a, semi);
        if (!lhs || lhs.vs !== callee) continue;
        if (lhs.type === null && !nameChain(doc, a, callee - 1)) continue;
        lhsName = lhs.name;
      } else continue;
    }
    if (!pure(doc, callee, lp)) continue;
    const args = items(doc, lp);
    const argOf = new Map<string, number>();
    args.forEach(([s, e], i) => {
      if (e === s + 1 && doc.k(s) === K.Identifier) argOf.set(doc.t(s)!, argOf.has(doc.t(s)!) ? -1 : i);
    });
    const run: RunStore[] = [];
    let at = a;
    while (argOf.size && doc.k(at - 1) === K.Semicolon && at - 1 > open) {
      const ps = at - 1;
      if (doc.directives.some(r => r.s >= doc.toks[ps].e && r.e <= doc.toks[at].s)) break;
      const pa = statementStart(doc, ps - 1);
      if (pa <= open || pa >= ps) break;
      const st = storeAt(doc, pa, ps);
      if (!st) break;
      const pos = argOf.get(st.name);
      if (pos === undefined || pos < 0 || st.name === lhsName || run.some(r => r.name === st.name)) break;
      if (run.length && run[run.length - 1].pos >= pos) break;
      const valueOk = isCall(doc, st.vs, ps, names) || (mode === 'values' && pure(doc, st.vs, ps));
      if (!valueOk || topLevel(doc, st.vs, ps, K.Comma) >= 0) break;
      if (text.slice(doc.toks[pa].s, doc.toks[ps].e).includes('\n') || !locals.has(st.name) || addressed.has(st.name)) break;
      const d = decls.get(st.name) ?? [];
      const type = st.type ?? (d.length === 1 && d[0].lone ? d[0].type : null);
      if (type === null || type.includes('&') || structByValue(type, state)) break;
      run.push({ ...st, pos, type, call: isCall(doc, st.vs, ps, names) });
      at = pa;
    }
    if (run.length) calls.push({ a, semi, callee, lp, rp, args, run });
  }

  // Cut runs until every nested variable disappears whole: each of its names is a nested
  // store, that store's argument, or its lone declaration - so every value it held is read
  // exactly once, by the call it is nested into - and the call's other arguments still hold.
  for (let changed = true; changed;) {
    changed = false;
    const pairs = new Map<string, number>();
    const owner = new Map<number, number>();
    const bad = new Set<string>();
    calls.forEach((c, ci) => {
      for (const r of c.run) {
        pairs.set(r.name, (pairs.get(r.name) ?? 0) + 1);
        if (owner.has(r.semi) && owner.get(r.semi) !== ci) bad.add(r.name);
        owner.set(r.semi, ci);
      }
    });
    for (const [v, k] of pairs) {
      const lone = (decls.get(v) ?? []).filter(d => d.lone).length;
      if (count.get(v) !== 2 * k + lone) bad.add(v);
    }
    for (const c of calls) {
      const cut = c.run.findIndex(r => bad.has(r.name));
      if (cut >= 0) {
        c.run = c.run.slice(0, cut);
        changed = true;
      }
      // Between two nested calls every argument nests too: one left in a gap would be pushed
      // before the call to its left, where the temporaries had every call made first
      // (TestCollisionWithUnit 00622aa0 grew a frame, Skills_SrvDoFunc_029_ThunderStorm
      // 005ca4d0 lost bytes). The run is cut at the first call past a gap.
      const gap = callGap(c.run);
      if (gap >= 0) {
        c.run = c.run.slice(0, gap);
        changed = true;
      }
      // One temporary costs VC8 no frame slot, and the original kept as many as it nested
      // (MAINMENU_CheckCharacterSaveFileExists 00431f70 and 50 more lose their MATCH when
      // single ones nest): only a run of two or more, holding a call, nests.
      if (c.run.length && (c.run.length < 2 || !c.run.some(r => r.call))) {
        c.run = [];
        changed = true;
      }
      if (!c.run.length) continue;
      // Right to left, the arguments right of the leftmost nested one now come before a
      // nested value is computed: they may read nothing that value's call could change.
      const nested = new Set(c.run.map(r => r.pos));
      const lowest = Math.min(...nested);
      const ok = c.args.every(([s, e], i) => nested.has(i) ||
        (pure(doc, s, e) && (i < lowest || stable(doc, s, e, locals, addressed, state.types.globals))));
      if (!ok) {
        c.run = [];
        changed = true;
      }
    }
  }

  // The argument lists with each nested value in place of its temporary, in source order: a
  // store nested here may itself be a call whose own temporaries were nested, and its value
  // is taken as rewritten, so `a = f(); b = g(a); h(b);` becomes `h(g(f()))`.
  const edits: Edit[] = [];
  const listText = new Map<number, { lp: number; rp: number; text: string }>();
  const blanked = new Map<number, number>();
  const blankedDecl = new Set<number>();
  for (const c of calls) {
    if (!c.run.length) continue;
    let pos = doc.toks[c.lp].e;
    let list = '';
    for (const r of [...c.run].sort((x, y) => x.pos - y.pos)) {
      const [s] = c.args[r.pos];
      const rw = listText.get(r.semi);
      const value = rw && rw.lp >= r.vs
        ? text.slice(doc.toks[r.vs].s, doc.toks[rw.lp].e) + rw.text + text.slice(doc.toks[rw.rp].s, doc.toks[r.semi - 1].e)
        : span(doc, r.vs, r.semi);
      list += text.slice(pos, doc.toks[s].s) + `(${r.type})(${value})`;
      pos = doc.toks[s].e;
      blanked.set(r.semi, r.a);
      for (const d of decls.get(r.name) ?? []) {
        if (!d.lone || blankedDecl.has(d.at)) continue;
        blankedDecl.add(d.at);
        edits.push({ s: doc.toks[statementStart(doc, d.at)].s, e: doc.toks[d.at + 1].e, text: '' });
      }
    }
    listText.set(c.semi, { lp: c.lp, rp: c.rp, text: list + text.slice(pos, doc.toks[c.rp].s) });
    sites?.push({ line: text.slice(0, doc.toks[c.a].s).split('\n').length, callee: span(doc, c.callee, c.lp), nested: c.run.length });
  }
  for (const [semi, rw] of listText) if (!blanked.has(semi)) edits.push({ s: doc.toks[rw.lp].e, e: doc.toks[rw.rp].s, text: rw.text });
  for (const [semi, a] of blanked) edits.push({ s: doc.toks[a].s, e: doc.toks[semi].e, text: '' });
  return edits;
}
