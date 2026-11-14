/**
 * The MATCH ratchet: regenerating the tree never silently replaces a body that byte-matched
 * the original with one that might not, and never overwrites a body pinned by hand.
 *
 * Capture takes a function's body from a tree (the measured one for `match`, the hand-edited
 * one for `pin`) with the binding of every reference. Apply runs on every generated tree,
 * full regen and live daemon alike (codegen/index.ts writeProject): per record it compares
 * the fresh body with the stored one modulo spelling, and where they differ prints the stored
 * body again under the current names. See docs/ratchet.md.
 */
import { matchParams, paramIds, type ParamMatch } from './params.js';
import { bindSites, bodyForm, bindingKey, scanSites, type Binding, type SiteScan } from './refs.js';
import { rewriteBody } from './rewrite.js';
import type { RatchetRecord, RecordKind, StoredBody } from './store.js';
import type { SymbolIndex } from './symbol-index.js';
import { TokenKind } from '@ghidra-mcp/cpp-parser';
import { definitionSignature, lexTokens, misparsedTypes, type FunctionExtent } from './scan.js';

export interface Located {
  file: string;
  extent: FunctionExtent;
  text: string;
  /** The definition, signature and body. */
  definition: string;
  scope: string[];
}

export function locate(index: SymbolIndex, address: string): Located | undefined {
  const e = index.extents.get(address);
  if (!e) return undefined;
  const text = index.texts.get(e.file);
  if (text === undefined) return undefined;
  return {
    file: e.file,
    extent: e.extent,
    text,
    definition: text.slice(e.extent.start, e.extent.end),
    scope: [...e.extent.scope, ...e.extent.declarator.slice(0, -1)],
  };
}

export function storeBody(index: SymbolIndex, address: string): { body?: StoredBody; scan?: SiteScan; bindings?: Array<Binding | undefined>; error?: string } {
  const loc = locate(index, address);
  if (!loc) return { error: 'not defined in the tree' };
  const scan = scanSites(loc.definition);
  if (!scan) return { error: 'does not parse' };
  const bindings = bindSites(scan, index, loc.scope);
  const body: StoredBody = {
    address,
    name: index.fnByAddr.get(address)?.qname ?? [...loc.scope, loc.extent.declarator[loc.extent.declarator.length - 1]].join('::'),
    file: loc.file,
    scope: loc.scope,
    text: loc.definition,
    params: scan.params,
    ...(index.fnByAddr.get(address)?.storage && sameNames(index.fnByAddr.get(address)!.params, scan.params) ? { paramStorage: index.fnByAddr.get(address)!.storage } : {}),
    ...(index.fnByAddr.get(address)?.paramTypes ? { paramTypes: index.fnByAddr.get(address)!.paramTypes } : {}),
    ...(index.fnByAddr.get(address)?.retText !== undefined ? { ret: index.fnByAddr.get(address)!.retText } : {}),
    siteHash: scan.siteHash,
    bindings: bindings.flatMap((b, i) => (b ? [[i, b] as [number, Binding]] : [])),
  };
  return { body, scan, bindings };
}

/**
 * The file-static callees whose bodies decide a function's code: VC8 gives a static function
 * a custom register convention and may inline it, so the caller's bytes follow the callee's
 * shape. Transitive, same file only.
 */
export function staticClosure(index: SymbolIndex, root: string, bindingsOf: (a: string) => Array<Binding | undefined> | undefined): string[] {
  const file = index.extents.get(root)?.file;
  const out: string[] = [];
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const a = queue.shift()!;
    for (const b of bindingsOf(a) ?? []) {
      if (!b || b.k !== 'fn' || b.a.length !== 1) continue;
      const c = b.a[0];
      if (seen.has(c)) continue;
      const info = index.fnByAddr.get(c);
      if (!info || info.file !== file || !(info.isStatic || info.isInline)) continue;
      seen.add(c);
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

export function capture(index: SymbolIndex, address: string, kind: RecordKind, evidence: string, opts: { dh?: string; note?: string; closure?: boolean } = {}): { record?: RatchetRecord; error?: string } {
  const root = storeBody(index, address);
  if (!root.body) return { error: root.error };
  const members: StoredBody[] = [root.body];
  if (opts.closure !== false && kind === 'match') {
    const cache = new Map<string, Array<Binding | undefined> | undefined>([[address, root.bindings]]);
    const bodies = new Map<string, StoredBody>();
    const bindingsOf = (a: string) => {
      if (!cache.has(a)) {
        const r = storeBody(index, a);
        cache.set(a, r.bindings);
        if (r.body) bodies.set(a, r.body);
      }
      return cache.get(a);
    };
    for (const c of staticClosure(index, address, bindingsOf)) {
      const b = bodies.get(c);
      if (!b) return { error: `static callee ${c} does not parse` };
      members.push(b);
    }
  }
  return {
    record: {
      address,
      kind,
      evidence,
      captured: new Date().toISOString().slice(0, 10),
      ...(opts.dh ? { dh: opts.dh } : {}),
      ...(opts.note ? { note: opts.note } : {}),
      members,
    },
  };
}

export type ApplyStatus = 'equal' | 'kept' | 'pinned' | 'released' | 'unresolved' | 'gone' | 'shadowed' | 'stale';

export interface ApplyRow {
  address: string;
  name: string;
  /** The record this row is for, when it is a closure member. */
  record: string;
  kind: RecordKind;
  status: ApplyStatus;
  detail: string;
}

export interface ApplyOptions {
  /** Addresses whose generated body goes through (release.tsv plus `ratchet:release` tags). */
  releases?: Set<string>;
  /** Re-spell every stored body even where the fresh one is equivalent (a rewrite test). */
  forceKeep?: boolean;
}

export interface ApplyOutcome {
  rows: ApplyRow[];
  /** file -> new content, for every file that changed. */
  changed: Map<string, string>;
}

interface Planned { start: number; end: number; text: string }

function sameNames(a: string[] | undefined, b: string[]): boolean {
  return !!a && a.length === b.length && a.every((x, k) => x === b[k]);
}

/** Where each stored parameter is in the current signature (params.ts). */
function paramsNow(stored: StoredBody, freshParams: string[], index: SymbolIndex): ParamMatch {
  const info = index.fnByAddr.get(stored.address);
  const storage = info?.storage && sameNames(info.params, freshParams) ? info.storage : undefined;
  return matchParams(paramIds(stored.params, stored.paramStorage), paramIds(freshParams, storage));
}

/**
 * The stored signature's types. A record captured while the scanner read an attribute
 * group's parentheses as the parameter list (`__attribute__((noinline)) inline ..`) has
 * them wrong; its stored text has them right, so they are read again from it.
 */
export function storedSignature(stored: StoredBody): { paramTypes?: string[]; ret?: string } {
  if (!misparsedTypes(stored.paramTypes)) return { paramTypes: stored.paramTypes, ret: stored.ret };
  const sig = definitionSignature(stored.text);
  return sig && !misparsedTypes(sig.types) ? { paramTypes: sig.types, ret: sig.retText } : {};
}

/** Bindings with every parameter moved to where it is now. */
function remapParams(bindings: Array<Binding | undefined>, map: number[]): Array<Binding | undefined> {
  return bindings.map(b => (b && b.k === 'param' ? { k: 'param', i: map[b.i] } : b));
}

function sameForm(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Compare a stored body with the fresh one: equal modulo spelling? */
function compare(stored: StoredBody, storedScan: SiteScan, storedBindings: Array<Binding | undefined>, fresh: Located, freshScan: SiteScan | undefined, index: SymbolIndex): boolean {
  if (stored.text === fresh.definition) return true;
  if (!freshScan) return false;
  const m = paramsNow(stored, freshScan.params, index);
  if ('error' in m) return false;
  const fb = bindSites(freshScan, index, fresh.scope);
  return sameForm(bodyForm(storedScan, remapParams(storedBindings, m.map)), bodyForm(freshScan, fb));
}

/**
 * Apply the store to a generated tree. `index` is the tree's own index (it holds the file
 * texts); the outcome lists the files that change.
 */
export function applyRecords(index: SymbolIndex, records: RatchetRecord[], opts: ApplyOptions = {}): ApplyOutcome {
  const rows: ApplyRow[] = [];
  const releases = opts.releases ?? new Set<string>();
  const planned = new Map<string, Planned[]>();
  const claimed = new Map<string, string>();
  const inserts = new Map<string, Planned[]>();
  // Pins first, then the newest evidence: the first record to claim a body keeps it.
  const ordered = [...records].sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'pin' ? -1 : 1) || (b.captured.localeCompare(a.captured)) || a.address.localeCompare(b.address));

  for (const rec of ordered) {
    const rootName = rec.members[0]?.name ?? rec.address;
    const row = (m: StoredBody, status: ApplyStatus, detail = '') =>
      rows.push({ address: m.address, name: index.fnByAddr.get(m.address)?.qname ?? m.name, record: rec.address, kind: rec.kind, status, detail });
    if (rec.kind === 'match' && releases.has(rec.address)) {
      row(rec.members[0], 'released', 'release.tsv or ratchet:release');
      continue;
    }
    // Per member: where it is now, and whether its fresh body already is the stored one.
    type M = { stored: StoredBody; loc?: Located; scan?: SiteScan; bindings?: Array<Binding | undefined>; freshScan?: SiteScan; equal?: boolean; released: boolean };
    const ms: M[] = rec.members.map(stored => ({ stored, released: rec.kind === 'match' && releases.has(stored.address) }));
    let broken = '';
    for (const m of ms) {
      m.loc = locate(index, m.stored.address);
      if (!m.loc) { broken = `${m.stored.address} (${m.stored.name}) is not defined in the tree`; break; }
      if (m.released) continue;
      m.scan = scanSites(m.stored.text);
      if (!m.scan) { broken = `stored body of ${m.stored.address} no longer parses`; break; }
      if (m.scan.siteHash !== m.stored.siteHash) { broken = `stored body of ${m.stored.address} parses to other sites (parser changed): recapture it`; break; }
      m.bindings = new Array(m.scan.sites.length);
      for (const [i, b] of m.stored.bindings) m.bindings[i] = b;
      if (m.stored.text === m.loc.definition) { m.equal = true; continue; }
      m.freshScan = scanSites(m.loc.definition);
      m.equal = compare(m.stored, m.scan, m.bindings, m.loc, m.freshScan, index);
    }
    if (broken) {
      row(rec.members[0], broken.includes('not defined') ? 'gone' : 'stale', broken);
      continue;
    }
    const differs = ms.filter(m => !m.released && !m.equal);
    if (differs.length === 0 && !opts.forceKeep) {
      for (const m of ms) row(m.stored, m.released ? 'released' : 'equal');
      continue;
    }
    // Re-spell every member whose fresh body differs (all of them under forceKeep).
    const out: Array<{ m: M; text: string; renames: string[] }> = [];
    const errors: Array<{ m: M; errors: string[] }> = [];
    for (const m of ms) {
      if (m.released || (m.equal && !opts.forceKeep)) continue;
      const fresh = m.loc!;
      const freshScan = m.freshScan ?? scanSites(fresh.definition);
      const preferred = new Map<string, string>();
      if (freshScan) {
        const fb = bindSites(freshScan, index, fresh.scope);
        freshScan.sites.forEach((s, i) => {
          const b = fb[i];
          if (b && b.k !== 'param' && b.k !== 'fd' && b.k !== 'fdc') preferred.set(bindingKey(b), fresh.definition.slice(s.start, s.end));
        });
      }
      const params = freshScan?.params ?? index.fnByAddr.get(m.stored.address)?.params ?? [];
      const now = index.fnByAddr.get(m.stored.address);
      // Each stored parameter by its identity in the current signature, never its position.
      const pm = paramsNow(m.stored, params, index);
      if ('error' in pm) { errors.push({ m, errors: [pm.error] }); continue; }
      const retyped: string[] = [];
      const sig = storedSignature(m.stored);
      if (sig.ret !== undefined && now?.retText !== undefined && now.retText !== sig.ret) retyped.push(`returns ${now.retText}, was ${sig.ret}`);
      if (sig.paramTypes && now?.paramTypes && sig.paramTypes.length === now.paramTypes.length) {
        sig.paramTypes.forEach((t, k) => {
          const j = pm.map[k];
          if (t !== now.paramTypes![j]) retyped.push(`parameter ${k} retyped: ${t} -> ${now.paramTypes![j]}`);
        });
      }
      if (retyped.length > 0) { errors.push({ m, errors: retyped }); continue; }
      const r = rewriteBody(m.stored.text, m.scan!, m.bindings!, { index, scope: fresh.scope, params, paramMap: pm.map, preferred });
      if (r.text === undefined) errors.push({ m, errors: r.errors });
      else out.push({ m, text: relabel(r.text, m.stored.name, now?.qname), renames: r.renames });
    }
    if (errors.length > 0) {
      // Loud, per function, and the old body kept beside the new one for whoever fixes it.
      for (const e of errors) {
        row(e.m.stored, 'unresolved', e.errors.join('; '));
        const loc = e.m.loc!;
        const why = e.errors.join('; ').replace(/\n/gu, ' ');
        const block = `#if 0 // ratchet: the ${rec.kind} body of ${e.m.stored.address} (evidence ${rec.evidence}) could not be re-spelled: ${why}\n${e.m.stored.text}\n#endif\n`;
        const l = inserts.get(loc.file) ?? [];
        l.push({ start: loc.extent.markerStart, end: loc.extent.markerStart, text: block });
        inserts.set(loc.file, l);
      }
      for (const o of out) row(o.m.stored, 'unresolved', `not kept: ${rootName} could not be re-spelled as a whole`);
      continue;
    }
    for (const o of out) {
      const a = o.m.stored.address;
      const loc0 = o.m.loc!;
      if (o.text === loc0.text.slice(loc0.extent.bodyStart, loc0.extent.end) && !opts.forceKeep) {
        // Re-spelled, the stored body is the fresh one (a callee's arguments re-ordered, say).
        row(o.m.stored, 'equal', o.renames.length ? `after ${o.renames.join('; ')}` : '');
        continue;
      }
      const holder = claimed.get(a);
      if (holder) { row(o.m.stored, 'shadowed', `body already taken from record ${holder}`); continue; }
      claimed.set(a, rec.address);
      const loc = o.m.loc!;
      const l = planned.get(loc.file) ?? [];
      l.push({ start: loc.extent.bodyStart, end: loc.extent.end, text: o.text });
      planned.set(loc.file, l);
      row(o.m.stored, rec.kind === 'pin' ? 'pinned' : 'kept', o.renames.length ? o.renames.join('; ') : '');
    }
    for (const m of ms) if (m.released) row(m.stored, 'released', `member of ${rec.address}`);
    for (const m of ms) if (m.equal && !m.released && !opts.forceKeep && !out.some(o => o.m === m)) row(m.stored, 'equal');
  }

  const changed = new Map<string, string>();
  for (const file of new Set([...planned.keys(), ...inserts.keys()])) {
    const text = index.texts.get(file)!;
    const edits = [...(planned.get(file) ?? []), ...(inserts.get(file) ?? [])].sort((a, b) => b.start - a.start || b.end - a.end);
    let s = text;
    for (const e of edits) s = s.slice(0, e.start) + e.text + s.slice(e.end);
    changed.set(file, s);
  }
  return { rows, changed };
}

/**
 * A body names its own function in string labels the generator derives from it
 * (`D2_STATIC_GUARD(x, "NS::Fn::x")`): after a move or rename they follow the function.
 */
function relabel(body: string, oldName: string, newName: string | undefined): string {
  if (!newName || newName === oldName) return body;
  const toks = lexTokens(body);
  if (!toks) return body;
  const prefix = `"${oldName}::`;
  let out = body;
  for (const t of [...toks].reverse()) {
    if (t.kind === TokenKind.StringLiteral && t.text.startsWith(prefix)) {
      out = `${out.slice(0, t.start)}"${newName}::${t.text.slice(prefix.length)}${out.slice(t.end)}`;
    }
  }
  return out;
}

export function formatApplyReport(rows: ApplyRow[]): string {
  const order: ApplyStatus[] = ['unresolved', 'stale', 'gone', 'kept', 'pinned', 'released', 'shadowed', 'equal'];
  const sorted = [...rows].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.address.localeCompare(b.address));
  return `status\taddress\tname\trecord\tkind\tdetail\n${sorted.map(r => `${r.status}\t${r.address}\t${r.name}\t${r.record}\t${r.kind}\t${r.detail.replace(/[\t\n]/gu, ' ')}`).join('\n')}\n`;
}

export function summarize(rows: ApplyRow[]): Record<ApplyStatus, number> {
  const out = { equal: 0, kept: 0, pinned: 0, released: 0, unresolved: 0, gone: 0, shadowed: 0, stale: 0 } as Record<ApplyStatus, number>;
  for (const r of rows) out[r.status]++;
  return out;
}
