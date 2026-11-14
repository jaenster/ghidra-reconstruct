/**
 * The edits the parameter-order permuter (permute.ts) tries: which declaration orders keep
 * every parameter's storage, and the text of a TU with one function's parameters re-ordered
 * at its definition, every declaration and every call.
 *
 * A trial order is a permutation `perm` of the parameter indices: position k of the new list
 * holds the old parameter perm[k] (the regcallee/final-spec convention, which the Ghidra
 * apply step reads too).
 */
import { TokenKind } from '../../packages/cpp-parser/src/index.js';
import { lexTokens, matchParen, type Tok } from '../../packages/reconstruct/src/ratchet/scan.js';

/**
 * One letter per parameter, in Ghidra's order:
 *   R  a register Ghidra gives the parameter that the convention does not (VC8 assigns these
 *      itself for a file-static function, in declaration order),
 *   S  a stack slot,
 *   F  the convention's own positional register (__fastcall ECX/EDX, __thiscall ECX).
 */
export type Kind = 'R' | 'S' | 'F';

const STD: Record<string, string[]> = { __fastcall: ['ECX', 'EDX'], __thiscall: ['ECX'] };
const NARROW: Record<string, string> = {
  AL: 'EAX', AX: 'EAX', BL: 'EBX', BX: 'EBX', CL: 'ECX', CX: 'ECX', DL: 'EDX', DX: 'EDX', SI: 'ESI', DI: 'EDI',
};

/** The kind of each parameter from its Ghidra storage (`ECX:4`, `Stack[0x8]:4`), or undefined
 * when one has no storage or a composite one. */
export function paramKinds(convention: string, storage: string[]): Kind[] | undefined {
  const std = STD[convention.split(/\s/)[0]] ?? [];
  const out: Kind[] = [];
  for (let i = 0; i < storage.length; i++) {
    const s = storage[i].replace(' (auto)', '').trim();
    if (!s || s.includes(',')) return undefined;
    const reg = s.split(':')[0];
    if (reg.startsWith('Stack')) { out.push('S'); continue; }
    const full = NARROW[reg] ?? reg;
    out.push(i < std.length && std[i] === full ? 'F' : 'R');
  }
  return out;
}

/** VC8's tie order for callee-saved register parameters. */
const RANK: Record<string, number> = { EBX: 0, EDI: 1, ESI: 2 };

/**
 * The orders that keep every parameter's storage: an F parameter keeps its position (the
 * convention puts it there), stack parameters keep their relative order (VC8 lays the stack
 * out in declaration order), register parameters go anywhere else. The identity comes first.
 *
 * Bounded by `cap`: when there are more, only the register parameters are permuted among
 * their own positions; when that is still more, a heuristic few (the EBX/EDI/ESI order, the
 * reverse, each adjacent swap of register parameters).
 */
export function storageOrders(kinds: Kind[], cap = 24, registers: string[] = []): number[][] {
  const n = kinds.length;
  const free = kinds.map((k, i) => (k === 'F' ? -1 : i)).filter(i => i >= 0);
  const regs = free.filter(i => kinds[i] === 'R');
  const stack = free.filter(i => kinds[i] === 'S');
  const identity = kinds.map((_, i) => i);
  const key = (p: number[]) => p.join(',');
  const out = new Map<string, number[]>([[key(identity), identity]]);
  const count = (m: number, r: number) => { let c = 1; for (let k = 0; k < r; k++) c *= m - k; return c; };

  if (count(free.length, regs.length) <= cap) {
    // Every placement of the register parameters (in every order) over the free positions.
    const place = (pos: number[], used: Set<number>) => {
      if (pos.length === regs.length) {
        const perm = identity.slice();
        const taken = new Set(pos);
        pos.forEach((p, k) => { perm[p] = regs[k]; });
        let s = 0;
        for (const p of free) if (!taken.has(p)) perm[p] = stack[s++];
        out.set(key(perm), perm);
        return;
      }
      for (const p of free) if (!used.has(p)) { used.add(p); pos.push(p); place(pos, used); pos.pop(); used.delete(p); }
    };
    place([], new Set());
  } else if (count(regs.length, regs.length) <= cap) {
    const orders = (rest: number[]): number[][] => rest.length <= 1 ? [rest] : rest.flatMap((x, i) => orders([...rest.slice(0, i), ...rest.slice(i + 1)]).map(o => [x, ...o]));
    for (const o of orders(regs)) {
      const perm = identity.slice();
      regs.forEach((p, k) => { perm[p] = o[k]; });
      out.set(key(perm), perm);
    }
  } else {
    const withRegs = (o: number[]) => { const perm = identity.slice(); regs.forEach((p, k) => { perm[p] = o[k]; }); out.set(key(perm), perm); };
    const rank = (i: number) => RANK[registers[i]?.split(':')[0]] ?? 3;
    withRegs([...regs].sort((a, b) => rank(a) - rank(b) || a - b));
    withRegs([...regs].reverse());
    for (let k = 0; k + 1 < regs.length; k++) { const o = regs.slice(); [o[k], o[k + 1]] = [o[k + 1], o[k]]; withRegs(o); }
  }
  return n < 2 ? [identity] : [...out.values()];
}

export interface Reordered {
  text: string;
  /** Argument or parameter lists re-ordered. */
  sites: number;
  /** Why the function cannot be re-ordered in this text (nothing was changed then). */
  errors: string[];
}

const IDENT = TokenKind.Identifier;
const OPEN = new Set([TokenKind.LeftParen, TokenKind.LeftBracket, TokenKind.LeftBrace]);
const CLOSE = new Set([TokenKind.RightParen, TokenKind.RightBracket, TokenKind.RightBrace]);

/**
 * `text` with the parameter list of every declaration and definition of `name`, and the
 * argument list of every call to it, re-ordered by `perm`. Read as tokens: `name` followed by
 * `(`, qualified or not, never a member access (`.name(`, `->name(`). Each list is split at its
 * top-level commas; the separators and the space around each item stay where they were.
 *
 * Refuses (errors, text unchanged) where a re-order cannot be made safely: a use of `name`
 * that is not a call or a declarator (its address is taken), a list of another length, a
 * top-level `<` (a template argument may hold the comma), or a text that does not lex.
 */
export function reorderFunction(text: string, name: string, perm: number[]): Reordered {
  const toks = lexTokens(text);
  if (!toks) return { text, sites: 0, errors: ['the text does not lex'] };
  const errors: string[] = [];
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let sites = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== IDENT || t.text !== name) continue;
    const prev = toks[i - 1];
    if (prev && (prev.kind === TokenKind.Dot || prev.kind === TokenKind.Arrow)) continue;
    if (toks[i + 1]?.kind !== TokenKind.LeftParen) { errors.push(`line ${t.line}: ${name} used other than called`); continue; }
    const close = matchParen(toks, i + 1);
    if (close < 0) { errors.push(`line ${t.line}: unbalanced call`); continue; }
    const items = splitItems(toks, i + 2, close);
    if (typeof items === 'string') { errors.push(`line ${t.line}: ${items}`); continue; }
    if (items.length !== perm.length) { errors.push(`line ${t.line}: ${items.length} items for ${perm.length} parameters`); continue; }
    sites++;
    for (let k = 0; k < perm.length; k++) {
      if (perm[k] === k) continue;
      const [a, b] = items[k];
      const [c, d] = items[perm[k]];
      edits.push({ start: toks[a].start, end: toks[b].end, text: text.slice(toks[c].start, toks[d].end) });
    }
  }
  if (errors.length) return { text, sites: 0, errors };
  edits.sort((x, y) => x.start - y.start);
  let out = '', at = 0;
  for (const e of edits) { out += text.slice(at, e.start) + e.text; at = e.end; }
  return { text: out + text.slice(at), sites, errors };
}

/** The top-level items of a list between tokens [from, to): each as [first, last] token. */
function splitItems(toks: Tok[], from: number, to: number): Array<[number, number]> | string {
  const items: Array<[number, number]> = [];
  let depth = 0, first = from;
  for (let j = from; j < to; j++) {
    const k = toks[j].kind;
    if (OPEN.has(k)) depth++;
    else if (CLOSE.has(k)) depth--;
    else if (depth === 0 && k === TokenKind.Less) return 'a top-level < in the list';
    else if (depth === 0 && k === TokenKind.Comma) {
      if (j === first) return 'an empty item';
      items.push([first, j - 1]);
      first = j + 1;
    }
  }
  if (to > first) items.push([first, to - 1]);
  else if (items.length) return 'an empty item';
  return items;
}

/** Whether `name`'s definition in `text` (the one after `defStart`) is file-static. */
export function isStaticAt(text: string, defStart: number, name: string): boolean {
  const toks = lexTokens(text.slice(defStart));
  if (!toks) return false;
  for (const t of toks) {
    if (t.kind === IDENT && t.text === name) return false;
    if (t.text === 'static') return true;
    if (t.kind === TokenKind.LeftBrace || t.kind === TokenKind.Semicolon) return false;
  }
  return false;
}
