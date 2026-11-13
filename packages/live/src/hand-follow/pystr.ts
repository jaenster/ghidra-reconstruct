/**
 * The Python string semantics hand-follow's outputs depend on, so the TypeScript port writes
 * byte-identical files: UTF-8 with surrogateescape, str.splitlines / strip / split, code
 * point ordering and slicing, and json.dump(indent=1) with ensure_ascii.
 */

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** bytes.decode('utf-8', 'surrogateescape'): an undecodable byte b becomes U+DC00+b. */
export function decodeSE(buf: Uint8Array): string {
  try {
    return utf8.decode(buf);
  } catch {
    // not valid UTF-8: decode byte-wise below
  }
  const out: string[] = [];
  let run = 0;
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const len = seqLen(buf, i);
    if (len) {
      i += len;
      continue;
    }
    if (run < i) out.push(utf8.decode(buf.subarray(run, i)));
    out.push(String.fromCharCode(0xdc00 + buf[i]));
    i += 1;
    run = i;
  }
  if (run < n) out.push(utf8.decode(buf.subarray(run, n)));
  return out.join('');
}

/** Length of the well-formed UTF-8 sequence at i, or 0. */
function seqLen(buf: Uint8Array, i: number): number {
  const b = buf[i];
  if (b < 0x80) return 1;
  let k: number, lo = 0x80, hi = 0xbf;
  if (b >= 0xc2 && b <= 0xdf) k = 1;
  else if (b === 0xe0) (k = 2), (lo = 0xa0);
  else if (b === 0xed) (k = 2), (hi = 0x9f);
  else if (b >= 0xe1 && b <= 0xef) k = 2;
  else if (b === 0xf0) (k = 3), (lo = 0x90);
  else if (b === 0xf4) (k = 3), (hi = 0x8f);
  else if (b >= 0xf1 && b <= 0xf3) k = 3;
  else return 0;
  if (i + k >= buf.length) return 0;
  const c1 = buf[i + 1];
  if (c1 < lo || c1 > hi) return 0;
  for (let j = 2; j <= k; j++) {
    const c = buf[i + j];
    if (c < 0x80 || c > 0xbf) return 0;
  }
  return k + 1;
}

const surrogateError = (c: number) =>
  new Error(`'utf-8' codec can't encode character '\\u${c.toString(16)}': surrogates not allowed`);

/**
 * str.encode('utf-8', errors): 'surrogateescape' turns U+DC80..U+DCFF back into the byte;
 * 'strict' throws on any lone surrogate, as Python's default text-mode write does.
 */
export function encodeSE(s: string, errors: 'surrogateescape' | 'strict' = 'surrogateescape'): Buffer {
  if (!/[\ud800-\udfff]/.test(s)) return Buffer.from(s, 'utf8');
  const parts: Buffer[] = [];
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      throw surrogateError(c);
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      if (errors === 'strict' || c < 0xdc80 || c > 0xdcff) throw surrogateError(c);
      parts.push(Buffer.from(s.slice(run, i), 'utf8'), Buffer.from([c - 0xdc00]));
      run = i + 1;
    }
  }
  parts.push(Buffer.from(s.slice(run), 'utf8'));
  return Buffer.concat(parts);
}

/** subprocess text=True: universal newlines on the decoded output. */
export function universalNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Python's `\s` for str patterns (str.isspace), as a character class body. */
export const PY_WS =
  '\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
/** Python's `\w` for str patterns, as a character class body (needs the u flag). */
export const PY_W = '\\p{L}\\p{N}_';
const LEAD = new RegExp(`^[${PY_WS}]+`, 'u');
const TRAIL = new RegExp(`[${PY_WS}]+$`, 'u');
const SPLIT = new RegExp(`[${PY_WS}]+`, 'u');

export const strip = (s: string) => s.replace(LEAD, '').replace(TRAIL, '');
export const lstrip = (s: string) => s.replace(LEAD, '');

/** str.rstrip(chars) */
export function rstripChars(s: string, chars: string): string {
  let e = s.length;
  while (e > 0 && chars.includes(s[e - 1])) e--;
  return s.slice(0, e);
}

/** str.split() with no separator. */
export function splitWS(s: string): string[] {
  return s.split(SPLIT).filter((x) => x !== '');
}

const LINE_BREAK = /\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/g;

/** str.splitlines(keepends) */
export function splitlines(s: string, keepends = false): string[] {
  const out: string[] = [];
  let start = 0;
  LINE_BREAK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINE_BREAK.exec(s)) !== null) {
    const end = m.index + m[0].length;
    out.push(s.slice(start, keepends ? end : m.index));
    start = end;
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/** Code point order, as Python compares str. */
export function cmp(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800 && x <= 0xdbff) x += 0x10000;
    if (y >= 0xd800 && y <= 0xdbff) y += 0x10000;
    return x - y;
  }
  return a.length - b.length;
}

/** Python ordering of the str / int / tuple sort keys used here. */
export function cmpAny(a: unknown, b: unknown): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = cmpAny(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return cmp(String(a), String(b));
}

/** sorted(xs, key=key) */
export function sorted<T>(xs: Iterable<T>, key?: (x: T) => unknown): T[] {
  const arr = [...xs];
  return key ? arr.sort((p, q) => cmpAny(key(p), key(q))) : arr.sort((p, q) => cmpAny(p, q));
}

/** s[:n] in code points. */
export function head(s: string, n: number): string {
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join('');
}

/** s[-n:] in code points. */
export function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return Array.from(s.slice(-(2 * n + 2))).slice(-n).join('');
}

/** f'{s:<n}' */
export function ljust(s: string, n: number): string {
  const len = Array.from(s).length;
  return len >= n ? s : s + ' '.repeat(n - len);
}

/** json.dumps(x, indent=1), ensure_ascii on. */
export function pyJson(x: unknown): string {
  return JSON.stringify(x, null, 1).replace(/[\u007f-\uffff]/g, (c) => {
    const h = c.charCodeAt(0).toString(16);
    return '\\u' + '0000'.slice(h.length) + h;
  });
}

/** str.zfill for the unsigned hex strings used here. */
export const zfill = (s: string, n: number) => s.padStart(n, '0');
