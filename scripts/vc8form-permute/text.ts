/**
 * Text helpers the form permuter (permute.ts) and verify-gen.ts share: finding a function's
 * definition in a TU, the file and JSON conventions the permuter's outputs keep, and Python's
 * seeded sampler (a `--sample N --seed S` run draws the same targets it always drew).
 */

// ---------------------------------------------------------------------------------------
// Files: UTF-8 with undecodable bytes kept as U+DC80..U+DCFF, so every byte round-trips and
// a definition's text (and every offset into it) is the same whatever the file holds.

export function decodeFile(buf: Buffer): string {
  let out = '';
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) { out += String.fromCharCode(b); i++; continue; }
    let len = 0, cp = 0, min = 0;
    if (b >= 0xc2 && b <= 0xdf) { len = 2; cp = b & 0x1f; min = 0x80; }
    else if (b >= 0xe0 && b <= 0xef) { len = 3; cp = b & 0x0f; min = 0x800; }
    else if (b >= 0xf0 && b <= 0xf4) { len = 4; cp = b & 0x07; min = 0x10000; }
    let ok = len > 0 && i + len <= n;
    for (let k = 1; ok && k < len; k++) {
      const c = buf[i + k];
      if ((c & 0xc0) !== 0x80) ok = false; else cp = (cp << 6) | (c & 0x3f);
    }
    if (ok && (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))) ok = false;
    if (!ok) { out += String.fromCharCode(0xdc00 + b); i++; continue; }
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

export function encodeFile(s: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xdc80 && cp <= 0xdcff) { bytes.push(cp - 0xdc00); continue; }
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00); i++; }
    }
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------------------
// JSON as the permuter's files have always been written: ASCII only, `, ` and `: ` between
// items, or one item per line (`indent=0`) for bodies.json.

type Json = string | number | boolean | null | Json[] | Map<string, Json> | { [k: string]: Json };

export function jsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c < 0x20 || c > 0x7e) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += s[i];
  }
  return out + '"';
}

export function jsonDumps(v: Json, indent?: number): string {
  const nl = indent === undefined ? '' : '\n' + ' '.repeat(indent);
  const sep = indent === undefined ? ', ' : ',' + nl;
  const one = (x: Json): string => {
    if (x === null) return 'null';
    if (typeof x === 'string') return jsonString(x);
    if (typeof x === 'boolean') return x ? 'true' : 'false';
    if (typeof x === 'number') return String(x);
    if (Array.isArray(x)) return x.length ? '[' + nl + x.map(one).join(sep) + (indent === undefined ? '' : '\n') + ']' : '[]';
    const entries = x instanceof Map ? [...x.entries()] : Object.entries(x);
    if (!entries.length) return '{}';
    return '{' + nl + entries.map(([k, val]) => jsonString(k) + ': ' + one(val)).join(sep) + (indent === undefined ? '' : '\n') + '}';
  };
  return one(v);
}

// ---------------------------------------------------------------------------------------
// A definition in a TU

const WS = '[ \\t\\n\\r\\f\\v]';

/** (def start, end) offsets of the definition after `// 1.14d: <start>` in a TU, or null. */
export function functionSpan(text: string, start: number): [number, number] | null {
  const re = new RegExp(`(?:(?<=\\n)|(?<![\\s\\S]))// 1\\.14d: ${start.toString(16).padStart(8, '0')}${WS}*(?=\\n|(?![\\s\\S]))`);
  const m = re.exec(text);
  if (!m) return null;
  const end = m.index + m[0].length;
  const i = text[end - 1] !== '\n' ? text.indexOf('\n', end - 1) + 1 : end;
  const n = text.length;
  let j = i, depth = 0;
  while (j < n) {                                   // the body's opening brace, outside parentheses
    const c = text[j];
    if (text.startsWith('//', j)) { j = text.indexOf('\n', j); j = j < 0 ? n : j; continue; }
    if (text.startsWith('/*', j)) { j = text.indexOf('*/', j) + 2; continue; }
    if (c === '"' || c === "'") { j = skipLiteral(text, j); continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && depth === 0) return null;
    else if (c === '{' && depth === 0) break;
    j++;
  }
  let k = j, level = 0;
  while (k < n) {
    const c = text[k];
    if (text.startsWith('//', k)) { k = text.indexOf('\n', k); k = k < 0 ? n : k; continue; }
    if (text.startsWith('/*', k)) { k = text.indexOf('*/', k) + 2; continue; }
    if (c === '"' || c === "'") { k = skipLiteral(text, k); continue; }
    if (c === '{') level++;
    else if (c === '}') {
      level--;
      if (level === 0) return [i, k + 1];
    }
    k++;
  }
  return null;
}

export function skipLiteral(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
  return j + 1;
}

// ---------------------------------------------------------------------------------------
// Equal bodies

/** Tokens one space apart, qualifiers dropped, comments gone: what decides equal bodies. */
export function tokenForm(text: string): string {
  text = text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  const toks = text.match(/"(?:\\[^\n]|[^"\\\n])*"|'(?:\\[^\n]|[^'\\\n])*'|[A-Za-z_$][\p{L}\p{N}_$]*|\p{Nd}[\p{L}\p{N}_.]*|::|\S/gu) ?? [];
  const out: string[] = [];
  let k = 0;
  while (k < toks.length) {
    if (k + 1 < toks.length && toks[k + 1] === '::' && /^[A-Za-z_]/.test(toks[k])) { k += 2; continue; }
    if (toks[k] === '::') { k++; continue; }
    out.push(toks[k]);
    k++;
  }
  return out.join(' ');
}

// ---------------------------------------------------------------------------------------
// Formatting as the outputs always printed it

/** '%.Nf' with ties to even on the exact binary value, as printf rounds. */
export function fixed(x: number, digits: number): string {
  const s = x.toFixed(digits);
  // toFixed breaks an exact tie upwards; printf to even. Only exact ties can differ.
  const scaled = x * 10 ** digits;
  if (Number.isFinite(scaled) && Math.abs(scaled) < 2 ** 52 && scaled - Math.trunc(scaled) === 0.5 * Math.sign(scaled)) {
    const down = Math.trunc(scaled);
    const pick = down % 2 === 0 ? down : down + Math.sign(scaled);
    return (pick / 10 ** digits).toFixed(digits);
  }
  return s;
}

export const hex8 = (n: number) => n.toString(16).padStart(8, '0');

// ---------------------------------------------------------------------------------------
// Python's random.Random(seed).sample: MT19937 seeded by init_by_array, _randbelow by
// getrandbits, the list or set selection by the sample's size.

export class PyRandom {
  private mt = new Uint32Array(624);
  private mti = 625;

  constructor(seed: number) {
    let n = Math.abs(Math.trunc(seed));
    const key: number[] = [];
    while (n > 0) { key.push(n % 0x100000000); n = Math.floor(n / 0x100000000); }
    if (!key.length) key.push(0);
    this.initByArray(key);
  }

  private initGenrand(s: number) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) {
      const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, p) + i) >>> 0;
    }
    this.mti = 624;
  }

  private initByArray(key: number[]) {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1, j = 0;
    for (let k = Math.max(624, key.length); k; k--) {
      const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(p, 1664525)) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= 624) { mt[0] = mt[623]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k; k--) {
      const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(p, 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) { mt[0] = mt[623]; i = 1; }
    }
    mt[0] = 0x80000000;
  }

  private genrand(): number {
    const mt = this.mt;
    if (this.mti >= 624) {
      for (let kk = 0; kk < 624; kk++) {
        const y = (mt[kk] & 0x80000000) | (mt[(kk + 1) % 624] & 0x7fffffff);
        mt[kk] = mt[(kk + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.mti = 0;
    }
    let y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  private getrandbits(k: number): number {
    if (k === 0) return 0;
    if (k > 32) throw new Error('getrandbits over 32 bits');
    return this.genrand() >>> (32 - k);
  }

  private randbelow(n: number): number {
    const k = n.toString(2).length;
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  sample<T>(population: T[], k: number): T[] {
    const n = population.length;
    if (k < 0 || k > n) throw new Error('Sample larger than population or is negative');
    const result: T[] = new Array(k);
    let setsize = 21;
    if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= setsize) {
      const pool = [...population];
      for (let i = 0; i < k; i++) {
        const j = this.randbelow(n - i);
        result[i] = pool[j];
        pool[j] = pool[n - i - 1];
      }
    } else {
      const selected = new Set<number>();
      for (let i = 0; i < k; i++) {
        let j = this.randbelow(n);
        while (selected.has(j)) j = this.randbelow(n);
        selected.add(j);
        result[i] = population[j];
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------------------
// Inline twins written once

/** The head of an inline twin `acc` writes (accessor-twins.ts): its comment and signature. */
const TWIN_HEAD = /(?<=^|\n)\/\/ [^\n]* as its callers inlined it: [^\n]*\nstatic inline [^\n(]*?\b([A-Za-z_]\w*)\(/g;

/**
 * Every candidate that calls an inline twin carries its definition ahead of its body, so a
 * TU with two such bodies swapped in, or one where the generator already wrote the twin,
 * defines it twice. The generator writes each twin once per namespace scope of the file,
 * ahead of the first function calling it: keep the first definition of each twin in each
 * scope, and blank the later ones to as many newlines (a quarantine names lines).
 */
export function dedupeTwins(text: string): string {
  const heads: Array<{ at: number; name: string }> = [];
  for (const m of text.matchAll(TWIN_HEAD)) heads.push({ at: m.index!, name: m[1] });
  if (heads.length < 2) return text;
  // The namespace path at each head: braces outside comments and literals, a `namespace N {` named.
  const scopeAt = new Map<number, string>();
  const stack: string[] = [];
  let h = 0, i = 0;
  const n = text.length;
  while (i < n && h < heads.length) {
    while (h < heads.length && heads[h].at <= i) { if (heads[h].at === i) scopeAt.set(i, stack.join('/')); h++; }
    const c = text[i];
    if (text.startsWith('//', i)) { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (text.startsWith('/*', i)) { const e = text.indexOf('*/', i); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") { i = skipLiteral(text, i); continue; }
    if (c === '{') {
      const ns = /\bnamespace\s+([A-Za-z_][\w:]*)?\s*$/.exec(text.slice(Math.max(0, i - 200), i));
      stack.push(ns ? `ns:${ns[1] ?? ''}` : 'block');
    } else if (c === '}') stack.pop();
    i++;
  }
  const seen = new Set<string>();
  const cut: Array<[number, number]> = [];
  for (const { at, name } of heads) {
    const scope = scopeAt.get(at);
    if (scope === undefined || scope.split('/').some(s => s === 'block')) continue;
    const key = `${scope}\0${name}`;
    if (!seen.has(key)) { seen.add(key); continue; }
    // The definition runs to the brace that closes its body.
    const open = text.indexOf('{', at);
    let k = open, level = 0;
    while (k < n) {
      if (text.startsWith('//', k)) { const e = text.indexOf('\n', k); k = e < 0 ? n : e; continue; }
      if (text.startsWith('/*', k)) { const e = text.indexOf('*/', k); k = e < 0 ? n : e + 2; continue; }
      if (text[k] === '"' || text[k] === "'") { k = skipLiteral(text, k); continue; }
      if (text[k] === '{') level++;
      else if (text[k] === '}' && --level === 0) break;
      k++;
    }
    if (k < n) cut.push([at, k + 1]);
  }
  let out = '', from = 0;
  for (const [a, b] of cut) { out += text.slice(from, a) + '\n'.repeat((text.slice(a, b).match(/\n/g) ?? []).length); from = b; }
  return out + text.slice(from);
}
