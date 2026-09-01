/**
 * Per-phase timing for the reconstruction pipeline.
 *
 * The pipeline is a ~20 minute black box: it printed phase MARKERS and one
 * total, so every claim about where the time went was folklore. This is a
 * process-wide recorder (one reconstruct() per process, so a singleton is
 * enough) that every phase reports into, and a compact table printed at the
 * end of the run — a dozen lines, not a firehose.
 *
 * Phases are reported in the order they COMPLETE. Nesting is expressed in the
 * name ("extract/decompile"); a parent phase is recorded with `parent: true`
 * so the summary can show it without double-counting its children in the
 * "unattributed" remainder.
 */

export interface PhaseRecord {
  name: string;
  ms: number;
  /** Free-form counts/bytes, printed after the percentage. */
  detail?: string;
  /** True when this phase's time is already covered by finer-grained children. */
  parent?: boolean;
}

let records: PhaseRecord[] = [];

export function resetTimings(): void {
  records = [];
}

export function recordPhase(name: string, ms: number, detail?: string, parent = false): void {
  records.push({ name, ms, detail, parent });
}

/** Time an async phase, recording it even when it throws. */
export async function timePhase<T>(
  name: string,
  fn: () => Promise<T>,
  detail?: (result: T) => string | undefined,
  parent = false
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    recordPhase(name, Date.now() - t0, detail?.(result), parent);
    return result;
  } catch (err) {
    recordPhase(`${name} (failed)`, Date.now() - t0, undefined, parent);
    throw err;
  }
}

/** Time a synchronous phase. */
export function timePhaseSync<T>(
  name: string,
  fn: () => T,
  detail?: (result: T) => string | undefined,
  parent = false
): T {
  const t0 = Date.now();
  try {
    const result = fn();
    recordPhase(name, Date.now() - t0, detail?.(result), parent);
    return result;
  } catch (err) {
    recordPhase(`${name} (failed)`, Date.now() - t0, undefined, parent);
    throw err;
  }
}

export function getTimings(): readonly PhaseRecord[] {
  return records;
}

/** "1.2 MB" / "912 kB" — decimal, matching how disk sizes are usually quoted. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(0)} kB`;
  if (bytes < 1000 * 1000 * 1000) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

/**
 * Render the timing table. `totalMs` is the whole-run wall clock, so the
 * table can show what fraction each phase owned and what is unaccounted for.
 */
export function formatTimings(totalMs: number, extraLines: string[] = []): string {
  if (records.length === 0) return '';

  const nameWidth = Math.max(20, ...records.map(r => r.name.length));
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const pct = (ms: number) => (totalMs > 0 ? `${((ms / totalMs) * 100).toFixed(1)}%` : '');

  const lines: string[] = [];
  lines.push(`Phase timings (total ${secs(totalMs)}):`);
  for (const r of records) {
    const cells = [
      '  ' + r.name.padEnd(nameWidth),
      secs(r.ms).padStart(8),
      pct(r.ms).padStart(6),
    ];
    if (r.detail) cells.push('  ' + r.detail);
    lines.push(cells.join(' '));
  }

  const attributed = records.filter(r => !r.parent).reduce((a, r) => a + r.ms, 0);
  const rest = totalMs - attributed;
  if (rest > 0) {
    lines.push(
      ['  ' + '(unattributed)'.padEnd(nameWidth), secs(rest).padStart(8), pct(rest).padStart(6)].join(' ')
    );
  }
  lines.push(...extraLines);
  return lines.join('\n');
}
