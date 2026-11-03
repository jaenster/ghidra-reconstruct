/**
 * The input the daemon does not get from Ghidra: the hand-written sources built
 * beside the tree (`foreignReferences` in project.json, e.g. recon/modified/support).
 *
 * The generator reads them to decide which functions are static and which get an
 * extern entry, and which structs keep constructors. A commit there changes the
 * tree with no Ghidra check-in to say so. The generator reads them from the
 * committed HEAD and records a fingerprint of what it read in buildinfo.json;
 * this compares that with the fingerprint now and, on a change, asks for an
 * ordinary rebuild. Nothing in the model moved, so the selection picks no unit
 * and the generator's own reuse checks re-emit exactly the units whose static and
 * extern set, or constructor answers, changed.
 *
 * The fingerprint is a content hash of the foreign files at HEAD (a git tree id),
 * not the HEAD commit: the daemon's own merge into source/modified moves HEAD and
 * must not trigger anything.
 */

export interface ForeignWatchHost {
  /** The fingerprint of the foreign sources now; throws when they cannot be read. */
  current(): string;
  /** What the tree on disk was generated from; null when unknown (older buildinfo). */
  built(): string | null;
  /** True when a rebuild may be queued now: nothing running or queued, not blocked, paused or held. */
  idle(): boolean;
  /** Queue the rebuild; resolves with what it re-emitted. */
  rebuild(from: string | null, to: string): Promise<RebuildOutcome>;
  log(message: string): void;
}

/**
 * What a rebuild re-emitted: the units whose .cpp it changed, or, when the rebuild
 * re-emitted everything for another reason (a new generator, no hash cache), that
 * reason - a full run says nothing about this input's own effect.
 */
export interface RebuildOutcome {
  units: number | null;
  full?: string;
}

export type ForeignCheck = 'unchanged' | 'busy' | 'unreadable' | 'rebuilt' | 'failed';

export interface ForeignChange {
  at: string;
  from: string | null;
  to: string;
  unitsChanged: number | null;
  /** Set when the rebuild re-emitted every unit, with the reason. */
  full?: string;
  outcome: 'rebuilt' | 'failed';
}

export class ForeignSourceWatch {
  last: ForeignChange | null = null;
  lastError: string | null = null;
  private running = false;

  /**
   * `label` names the input in the log. The same watch serves the generator's own
   * inputs (build-fingerprint.ts generatorFingerprint), whose change makes the
   * rebuild a full one.
   */
  constructor(private readonly host: ForeignWatchHost, private readonly label = 'foreign sources') {}

  async check(): Promise<ForeignCheck> {
    if (this.running || !this.host.idle()) return 'busy';
    let now: string;
    try {
      now = this.host.current();
      this.lastError = null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message !== this.lastError) this.host.log(`${this.label} unreadable: ${message}`);
      this.lastError = message;
      return 'unreadable';
    }
    const built = this.host.built();
    if (built === now) return 'unchanged';
    // A rebuild for this very change already failed: it is reported, and retried
    // when the sources move again or a rebuild runs for another reason.
    if (this.last?.outcome === 'failed' && this.last.to === now && this.last.from === built) return 'failed';
    this.running = true;
    try {
      this.host.log(`${this.label} changed (${built ?? 'unknown'} -> ${now}): rebuilding`);
      const r = await this.host.rebuild(built, now);
      this.last = { at: new Date().toISOString(), from: built, to: now, unitsChanged: r.units, outcome: 'rebuilt', ...(r.full ? { full: r.full } : {}) };
      this.host.log(r.full
        ? `${this.label} changed: applied by a full re-emission (${r.full}); ${r.units ?? '?'} unit(s) differ in total`
        : `${this.label} changed: ${r.units ?? '?'} unit(s) re-emitted`);
      return 'rebuilt';
    } catch (e) {
      this.last = { at: new Date().toISOString(), from: built, to: now, unitsChanged: null, outcome: 'failed' };
      this.host.log(`${this.label} rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
      return 'failed';
    } finally {
      this.running = false;
    }
  }
}
