/**
 * Advance the store on a measurement, and only on one.
 *
 * Input: the tree the VC8 oracle measured (source/modified at the evidence commit) and that
 * measurement's audit.tsv. A function MATCH there has its body captured (new) or refreshed
 * (its stored text re-taken when the tree's differs, e.g. after a rename). A stored match
 * that is not MATCH any more is reported, never advanced:
 *
 * - `phase-noise`: the tree still carries the stored body (the ratchet kept it, or nothing
 *   changed it) and it no longer matches. Something outside the body moved, a declaration
 *   order or a header (00633f40 at deploy 1163). The record stays.
 * - `lost`: the tree carries another body (a rewrite failed, the function moved out of the
 *   tree). The record stays; the apply report says why.
 * - `retired`: the function was released and the measurement shows what the release cost.
 *   The record and the release go: the generated body won deliberately.
 *
 * A release is consumed by the measurement that follows it either way.
 */
import { bindSites, bodyForm, scanSites, type Binding } from './refs.js';
import { capture, locate } from './ratchet.js';
import type { RatchetRecord, RatchetStore } from './store.js';
import { normalizeAddress } from './store.js';
import type { SymbolIndex } from './symbol-index.js';

export interface AuditRow { address: string; name: string; status: string }

export function readAudit(text: string): Map<string, AuditRow> {
  const out = new Map<string, AuditRow>();
  const lines = text.split('\n');
  const head = lines[0]?.split('\t') ?? [];
  const si = head.indexOf('status');
  const ni = head.indexOf('name');
  if (si < 0) throw new Error('audit.tsv: no status column');
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const c = line.split('\t');
    out.set(normalizeAddress(c[0]), { address: normalizeAddress(c[0]), name: c[ni] ?? '', status: c[si] ?? '' });
  }
  return out;
}

export type AdvanceStatus = 'new' | 'refreshed' | 'unchanged' | 'uncapturable' | 'pin' | 'hand' | 'phase-noise' | 'lost' | 'retired' | 'absent';

export interface AdvanceRow { address: string; name: string; status: AdvanceStatus; audit: string; detail: string }

/** Is the body the tree carries for every member the stored one, modulo spelling? */
export function treeCarries(index: SymbolIndex, rec: RatchetRecord): { equal: boolean; why?: string } {
  for (const m of rec.members) {
    const loc = locate(index, m.address);
    if (!loc) return { equal: false, why: `${m.address} not in the tree` };
    if (loc.definition === m.text) continue;
    const ss = scanSites(m.text);
    const fs = scanSites(loc.definition);
    if (!ss || !fs) return { equal: false, why: `${m.address} does not parse` };
    const sb: Array<Binding | undefined> = new Array(ss.sites.length);
    for (const [i, b] of m.bindings) sb[i] = b;
    const a = bodyForm(ss, sb);
    const b = bodyForm(fs, bindSites(fs, index, loc.scope));
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) return { equal: false, why: `${m.address} body differs` };
  }
  return { equal: true };
}

/** Same text and sites, and the same signature types read off it (a scanner fix re-reads them). */
function sameRecordText(a: RatchetRecord, b: RatchetRecord): boolean {
  const same = (x?: string[], y?: string[]) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  return a.members.length === b.members.length && a.members.every((m, i) => {
    const n = b.members[i];
    return m.address === n.address && m.text === n.text && m.siteHash === n.siteHash
      && m.ret === n.ret && same(m.paramTypes, n.paramTypes);
  });
}

/**
 * `regen`: the index of the source/regen tree the measured tree merged. A MATCH function whose
 * body differs there carries a hand edit: it is reported (`hand`, pin it) and not captured,
 * so a match record never smuggles hand-written code into source/regen.
 */
export function advance(index: SymbolIndex, store: RatchetStore, audit: Map<string, AuditRow>, evidence: string, opts: { dh?: Map<string, string>; dryRun?: boolean; regen?: SymbolIndex } = {}): AdvanceRow[] {
  const rows: AdvanceRow[] = [];
  const existing = new Map(store.list().map(r => [r.address, r]));
  const releases = store.releases();
  const released = new Set(releases.map(r => r.address));
  const consumed = new Set<string>();

  for (const row of audit.values()) {
    if (row.status !== 'MATCH') continue;
    const prev = existing.get(row.address);
    if (prev?.kind === 'pin') { rows.push({ address: row.address, name: row.name, status: 'pin', audit: row.status, detail: 'pinned body matches' }); continue; }
    if (!index.extents.has(row.address)) continue; // CRT and library code the tree does not define
    if (released.has(row.address)) consumed.add(row.address);
    if (opts.regen) {
      const here = locate(index, row.address);
      const there = locate(opts.regen, row.address);
      if (here && there && here.definition !== there.definition) {
        rows.push({ address: row.address, name: row.name, status: 'hand', audit: row.status, detail: 'body differs from source/regen: a hand edit; pin it to keep it' });
        continue;
      }
    }
    const c = capture(index, row.address, 'match', evidence, { dh: opts.dh?.get(row.address) });
    if (!c.record) { rows.push({ address: row.address, name: row.name, status: 'uncapturable', audit: row.status, detail: c.error ?? '' }); continue; }
    if (prev && sameRecordText(prev, c.record)) { rows.push({ address: row.address, name: row.name, status: 'unchanged', audit: row.status, detail: '' }); continue; }
    if (!opts.dryRun) store.put(c.record);
    rows.push({ address: row.address, name: row.name, status: prev ? 'refreshed' : 'new', audit: row.status, detail: prev ? `was ${prev.evidence}` : '' });
  }

  for (const rec of existing.values()) {
    if (rec.kind !== 'match') continue;
    const a = audit.get(rec.address);
    if (a?.status === 'MATCH') continue;
    const name = rec.members[0]?.name ?? '';
    const st = a?.status ?? 'not in audit';
    if (released.has(rec.address)) {
      consumed.add(rec.address);
      if (!opts.dryRun) store.remove(rec.address);
      rows.push({ address: rec.address, name, status: 'retired', audit: st, detail: 'released; the generated body won' });
      continue;
    }
    if (!a) { rows.push({ address: rec.address, name, status: 'absent', audit: st, detail: 'not measured' }); continue; }
    const carried = treeCarries(index, rec);
    rows.push(carried.equal
      ? { address: rec.address, name, status: 'phase-noise', audit: st, detail: 'the tree carries the stored body; not advanced' }
      : { address: rec.address, name, status: 'lost', audit: st, detail: carried.why ?? '' });
  }
  if (!opts.dryRun && consumed.size > 0) store.writeReleases(releases.filter(r => !consumed.has(r.address)));
  return rows;
}

export function formatAdvanceReport(rows: AdvanceRow[]): string {
  const order: AdvanceStatus[] = ['lost', 'phase-noise', 'hand', 'uncapturable', 'retired', 'new', 'refreshed', 'pin', 'absent', 'unchanged'];
  const sorted = [...rows].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.address.localeCompare(b.address));
  return `status\taddress\tname\taudit\tdetail\n${sorted.map(r => `${r.status}\t${r.address}\t${r.name}\t${r.audit}\t${r.detail.replace(/[\t\n]/gu, ' ')}`).join('\n')}\n`;
}
