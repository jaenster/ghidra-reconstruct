/**
 * Finding identity and the accepted-state baseline.
 *
 * The old baseline keyed site findings on `file:LINE`. Any edit above a site moved it, and a
 * moved site read as NEW: one merge took the "new" count from 57 to 82 with no change in the
 * findings at all. A key here is built from what the finding IS - the check, the file, the
 * enclosing function, the subject, and the location-free signature of the offending node -
 * with an ordinal only to separate genuinely identical sites in one function. A line number
 * is carried for the reader and never compared.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Finding } from './context.js';

export const BASELINE_VERSION = 2;

export interface KeyedFinding extends Finding {
  key: string;
}

export interface Baseline {
  version: number;
  /** check id -> key -> detail (for the reader; not compared). */
  checks: Record<string, Record<string, string>>;
}

function short(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/** Assign every finding its content key. Deterministic given the tree's content. */
export function keyFindings(findings: Finding[]): KeyedFinding[] {
  const sorted = [...findings].sort((a, b) =>
    (a.check).localeCompare(b.check) || (a.file ?? '').localeCompare(b.file ?? '') ||
    (a.line ?? 0) - (b.line ?? 0) || a.subject.localeCompare(b.subject) || a.detail.localeCompare(b.detail));
  const seen = new Map<string, number>();
  return sorted.map(f => {
    const identity = f.file
      ? [f.file, f.fn ?? '', f.subject, f.sig ? short(f.sig) : ''].join('|')
      : f.subject;
    const n = seen.get(`${f.check}|${identity}`) ?? 0;
    seen.set(`${f.check}|${identity}`, n + 1);
    return { ...f, key: n ? `${identity}#${n}` : identity };
  });
}

export function loadBaseline(path: string): Baseline | null {
  if (!existsSync(path)) return null;
  try {
    const b = JSON.parse(readFileSync(path, 'utf8'));
    if (b?.version !== BASELINE_VERSION || typeof b.checks !== 'object') return null;
    return b as Baseline;
  } catch {
    return null;
  }
}

export function toBaseline(findings: KeyedFinding[], checkIds: string[]): Baseline {
  const checks: Record<string, Record<string, string>> = {};
  for (const id of checkIds) checks[id] = {};
  for (const f of findings) {
    const where = f.file ? `${f.file}:${f.line ?? '?'} ` : '';
    checks[f.check][f.key] = `${where}${f.detail}`;
  }
  for (const id of Object.keys(checks)) {
    checks[id] = Object.fromEntries(Object.entries(checks[id]).sort(([a], [b]) => a.localeCompare(b)));
  }
  return { version: BASELINE_VERSION, checks };
}

export function saveBaseline(path: string, b: Baseline): void {
  writeFileSync(path, JSON.stringify(b, null, 1) + '\n');
}

/** Findings whose key the baseline does not know. A check absent from the baseline has all-new findings. */
export function newFindings(findings: KeyedFinding[], base: Baseline | null): KeyedFinding[] {
  if (!base) return findings;
  return findings.filter(f => !(base.checks[f.check] && f.key in base.checks[f.check]));
}

/** Baseline keys no longer found - fixed, or renamed out from under the baseline. */
export function goneFindings(findings: KeyedFinding[], base: Baseline | null): Array<{ check: string; key: string; detail: string }> {
  if (!base) return [];
  const have = new Set(findings.map(f => `${f.check}\u0000${f.key}`));
  const out: Array<{ check: string; key: string; detail: string }> = [];
  for (const [check, keys] of Object.entries(base.checks)) {
    for (const [key, detail] of Object.entries(keys)) {
      if (!have.has(`${check}\u0000${key}`)) out.push({ check, key, detail });
    }
  }
  return out;
}
