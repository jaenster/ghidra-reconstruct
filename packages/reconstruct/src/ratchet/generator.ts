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
import { evidencePrevious, repoOf } from './evidence.js';
import { previousTree, type PreviousTree } from './previous.js';
import type { RatchetRecord } from './store.js';
import { applyRecords, formatApplyReport, summarize } from './ratchet.js';
import { RatchetStore, normalizeAddress } from './store.js';
import { GLOBALS_INDEX_FILE, SymbolIndex, diskTree, formatGlobalsIndex, memoryTree } from './symbol-index.js';

function resolveDir(raw: string, options: ReconstructOptions): string {
  const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.resolve(options.projectDir ?? options.outputDir, expanded);
}

export function ratchetStoreDir(options: ReconstructOptions): string | undefined {
  if (process.env.RECON_RATCHET === '0') return undefined;
  const raw = process.env.RECON_RATCHET_STORE ?? options.projectConfig?.ratchet?.store;
  return raw ? resolveDir(raw, options) : undefined;
}

/**
 * An explicit previous tree for every record (previous.ts): `RECON_RATCHET_PREVIOUS` (empty:
 * none at all) or the project's `ratchet.previous`. Undefined when neither is set: each record
 * is then read against its evidence commit (evidence.ts).
 */
export function ratchetPreviousOverride(options: ReconstructOptions): { dir?: string } | undefined {
  const env = process.env.RECON_RATCHET_PREVIOUS;
  if (env !== undefined) return env ? { dir: resolveDir(env, options) } : {};
  const raw = options.projectConfig?.ratchet?.previous;
  return raw ? { dir: resolveDir(raw, options) } : undefined;
}

/** The tree the store sits in (`<modified>/ratchet`), when it carries a globals index. */
function storeTree(storeDir: string): string | undefined {
  const parent = path.dirname(storeDir);
  return fs.existsSync(path.join(parent, GLOBALS_INDEX_FILE)) ? parent : undefined;
}

/** Generated paths of a tree: hand-written directories are not part of its index. */
const GENERATED = (rel: string) => !rel.startsWith('Redivivus/') && !rel.startsWith('asm_matching/') && !rel.startsWith('ratchet/') && !rel.startsWith('support/');

function loadPrevious(dir: string | undefined, current: SymbolIndex): PreviousTree | undefined {
  if (!dir || !fs.existsSync(dir)) return undefined;
  try {
    return previousTree(SymbolIndex.build(diskTree(dir), GENERATED), current);
  } catch (e) {
    console.warn(`ratchet: the previous tree ${dir} could not be read (${(e as Error).message}); records are applied without it`);
    return undefined;
  }
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
  index.addParamStorage([...project.sourceMaps.values()].flatMap(m => m.functions ?? []));
  // Each record against the tree its text was captured from: its evidence commit in the
  // store's repo. The current tree the store sits in is no witness once a regen with renames
  // has been merged into it; it serves only records whose evidence the repo lacks.
  const override = ratchetPreviousOverride(options);
  let previous: PreviousTree | undefined;
  let previousFor: ((rec: RatchetRecord) => PreviousTree | undefined) | undefined;
  const used = new Map<PreviousTree, number>();
  let fellBack = 0;
  let fallback: PreviousTree | undefined | null = null;
  if (override) {
    previous = loadPrevious(override.dir, index);
  } else {
    const repo = repoOf(dir!);
    const byEvidence = repo ? evidencePrevious(repo, index, GENERATED) : undefined;
    previousFor = rec => {
      const p = byEvidence?.(rec.evidence);
      if (p) { used.set(p, (used.get(p) ?? 0) + 1); return p; }
      if (fallback === null) fallback = loadPrevious(storeTree(dir!), index);
      fellBack++;
      return fallback;
    };
  }
  const previousNote = () => {
    if (override) return previous ? `previous tree ${override.dir}, ${previous.types.size} type renames` : 'no previous tree';
    const parts = [...used].map(([p, n]) => `${n} records, ${p.types.size} type renames`);
    if (fellBack) parts.push(`${fellBack} records without one${fallback ? ' (read against the store\'s tree)' : ''}`);
    return `previous trees by evidence: ${parts.join('; ') || 'none'}`;
  };
  const releases = new Set(store.releases().map(r => r.address));
  for (const m of project.sourceMaps.values()) {
    for (const f of m.functions ?? []) if (f.ratchet === 'release') releases.add(normalizeAddress(f.address));
  }
  const records = store.list().filter(r => r.kind === 'match');
  const out = applyRecords(index, records, { releases, previous, previousFor });
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
    + `unresolved ${counts.unresolved}, stale ${counts.stale}, gone ${counts.gone} (${Date.now() - t0} ms)`
    + `; ${previousNote()}${reportPath ? `; report ${reportPath}` : ''}`);
  return { applied: true, counts, reportPath };
}
