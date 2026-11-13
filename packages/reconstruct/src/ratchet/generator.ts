/**
 * The ratchet in the generator: the last step before the tree is written, on the full regen
 * and on every live-daemon rebuild alike (both end in writeProject with every unit's text,
 * re-emitted or reused).
 *
 * Only `match` records apply here. A `pin` is hand-written code: it lands on
 * source/modified through `ratchet merge`, never in source/regen, which stays what the
 * pipeline produces (plus the bodies it produced before and the oracle proved).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ReconstructedProject, ReconstructOptions } from '../types.js';
import { applyRecords, formatApplyReport, summarize } from './ratchet.js';
import { RatchetStore, normalizeAddress } from './store.js';
import { GLOBALS_INDEX_FILE, SymbolIndex, formatGlobalsIndex, memoryTree } from './symbol-index.js';

export function ratchetStoreDir(options: ReconstructOptions): string | undefined {
  if (process.env.RECON_RATCHET === '0') return undefined;
  const raw = process.env.RECON_RATCHET_STORE ?? options.projectConfig?.ratchet?.store;
  if (!raw) return undefined;
  const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.resolve(options.projectDir ?? options.outputDir, expanded);
}

/** The globals index every tree carries (symbol-index.ts reads it back). */
export function globalsIndexText(project: ReconstructedProject): string {
  return formatGlobalsIndex(project.globals as Array<{ address: string; name: string; namespace?: string; dataType?: string; platform?: string }>);
}

export interface GeneratorRatchetResult {
  applied: boolean;
  counts?: ReturnType<typeof summarize>;
  reportPath?: string;
}

/**
 * Apply the store's match records to the project's files in place. Writes the report beside
 * buildinfo.json and logs every function it could not keep.
 */
export function applyRatchetToProject(project: ReconstructedProject, options: ReconstructOptions, globalsText: string): GeneratorRatchetResult {
  const dir = ratchetStoreDir(options);
  const store = RatchetStore.open(dir);
  if (!store) {
    if (dir) console.warn(`ratchet: store ${dir} does not exist; nothing kept`);
    return { applied: false };
  }
  const t0 = Date.now();
  const texts = new Map<string, string>();
  for (const [p, f] of project.files) texts.set(p, f.content);
  texts.set(GLOBALS_INDEX_FILE, globalsText);
  const index = SymbolIndex.build(memoryTree(texts));
  const releases = new Set(store.releases().map(r => r.address));
  for (const m of project.sourceMaps.values()) {
    for (const f of m.functions ?? []) if (f.ratchet === 'release') releases.add(normalizeAddress(f.address));
  }
  const records = store.list().filter(r => r.kind === 'match');
  const out = applyRecords(index, records, { releases });
  for (const [p, text] of out.changed) {
    const f = project.files.get(p);
    if (f) f.content = text;
  }
  const counts = summarize(out.rows);
  const projectDir = options.projectDir ?? options.outputDir;
  const reportDir = path.join(projectDir, '.ghidra-mcp');
  let reportPath: string | undefined;
  try {
    fs.mkdirSync(reportDir, { recursive: true });
    reportPath = path.join(reportDir, 'ratchet-report.tsv');
    fs.writeFileSync(reportPath, formatApplyReport(out.rows), 'utf-8');
  } catch {
    reportPath = undefined;
  }
  for (const r of out.rows) {
    if (r.status === 'unresolved' || r.status === 'stale' || r.status === 'gone') {
      console.error(`RATCHET ${r.status.toUpperCase()} ${r.address} ${r.name}: ${r.detail}`);
    }
  }
  console.log(`ratchet: ${records.length} match records from ${dir}: kept ${counts.kept}, equal ${counts.equal}, released ${counts.released}, `
    + `unresolved ${counts.unresolved}, stale ${counts.stale}, gone ${counts.gone} (${Date.now() - t0} ms)${reportPath ? `; report ${reportPath}` : ''}`);
  return { applied: true, counts, reportPath };
}
