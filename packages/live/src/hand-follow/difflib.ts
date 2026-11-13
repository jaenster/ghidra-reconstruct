/**
 * difflib.SequenceMatcher (isjunk=None, autojunk=True) and difflib.unified_diff, ported so
 * the patches hand-follow writes are the bytes CPython's difflib writes.
 */

type Op = [tag: string, i1: number, i2: number, j1: number, j2: number];
type Block = [i: number, j: number, k: number];

export class SequenceMatcher {
  private b2j = new Map<string, number[]>();

  constructor(
    private a: string[],
    private b: string[],
  ) {
    for (let i = 0; i < b.length; i++) {
      let idx = this.b2j.get(b[i]);
      if (!idx) this.b2j.set(b[i], (idx = []));
      idx.push(i);
    }
    // autojunk: elements more frequent than 1% of a sequence of 200+ are dropped
    const n = b.length;
    if (n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of [...this.b2j]) if (idxs.length > ntest) this.b2j.delete(elt);
    }
  }

  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Block {
    const { a, b, b2j } = this;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) (besti = i - k + 1), (bestj = j - k + 1), (bestsize = k);
      }
      j2len = newj2len;
    }
    // no junk: extend by equal elements on both ends (popular ones included)
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) besti--, bestj--, bestsize++;
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize])
      bestsize++;
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks(): Block[] {
    const la = this.a.length, lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: Block[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        blocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    let i1 = 0, j1 = 0, k1 = 0;
    const out: Block[] = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) out.push([i1, j1, k1]);
        (i1 = i2), (j1 = j2), (k1 = k2);
      }
    }
    if (k1) out.push([i1, j1, k1]);
    out.push([la, lb, 0]);
    return out;
  }

  getOpcodes(): Op[] {
    let i = 0, j = 0;
    const out: Op[] = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      let tag = '';
      if (i < ai && j < bj) tag = 'replace';
      else if (i < ai) tag = 'delete';
      else if (j < bj) tag = 'insert';
      if (tag) out.push([tag, i, ai, j, bj]);
      (i = ai + size), (j = bj + size);
      if (size) out.push(['equal', ai, i, bj, j]);
    }
    return out;
  }

  getGroupedOpcodes(n = 3): Op[][] {
    let codes = this.getOpcodes();
    if (!codes.length) codes = [['equal', 0, 1, 0, 1]];
    if (codes[0][0] === 'equal') {
      const [tag, i1, i2, j1, j2] = codes[0];
      codes[0] = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
    }
    const last = codes.length - 1;
    if (codes[last][0] === 'equal') {
      const [tag, i1, i2, j1, j2] = codes[last];
      codes[last] = [tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
    }
    const nn = n + n;
    const groups: Op[][] = [];
    let group: Op[] = [];
    for (let [tag, i1, i2, j1, j2] of codes) {
      if (tag === 'equal' && i2 - i1 > nn) {
        group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
        groups.push(group);
        group = [];
        (i1 = Math.max(i1, i2 - n)), (j1 = Math.max(j1, j2 - n));
      }
      group.push([tag, i1, i2, j1, j2]);
    }
    if (group.length && !(group.length === 1 && group[0][0] === 'equal')) groups.push(group);
    return groups;
  }
}

function formatRange(start: number, stop: number): string {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return `${beginning}`;
  if (!length) beginning -= 1;
  return `${beginning},${length}`;
}

/** ''.join(difflib.unified_diff(a, b, fromfile, tofile, n=n)) */
export function unifiedDiff(a: string[], b: string[], fromfile: string, tofile: string, n = 3): string {
  const out: string[] = [];
  let started = false;
  for (const group of new SequenceMatcher(a, b).getGroupedOpcodes(n)) {
    if (!started) {
      started = true;
      out.push(`--- ${fromfile}\n`, `+++ ${tofile}\n`);
    }
    const first = group[0], last = group[group.length - 1];
    out.push(`@@ -${formatRange(first[1], last[2])} +${formatRange(first[3], last[4])} @@\n`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === 'equal') {
        for (const l of a.slice(i1, i2)) out.push(' ' + l);
        continue;
      }
      if (tag === 'replace' || tag === 'delete') for (const l of a.slice(i1, i2)) out.push('-' + l);
      if (tag === 'replace' || tag === 'insert') for (const l of b.slice(j1, j2)) out.push('+' + l);
    }
  }
  return out.join('');
}
