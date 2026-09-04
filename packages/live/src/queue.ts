/**
 * The daemon's single work queue.
 *
 * Everything that touches the model, the output tree or git goes through here,
 * one task at a time. Not for tidiness - the operations genuinely cannot overlap:
 *
 * - two rebuilds share the scratch output directory, the reuse directory and the
 *   identifier cache. Run them together and the second reads the first's
 *   half-written files as if they were the previous run's output, which produces a
 *   tree that is wrong in a way nothing downstream can detect.
 * - a merge while a rebuild is writing hands git a moving tree.
 * - a commit while the rsync is mid-flight commits half a tree.
 *
 * The change stream already coalesces bursts into batches; this serialises those
 * batches against the operations an operator can trigger from MCP at any moment
 * (`rebuild`, `retry_merge`, `full_regen`), which is where the overlap would
 * otherwise come from.
 *
 * Nothing is ever preempted. A change arriving mid-rebuild does not cancel it -
 * it lands in the next task, because a rebuild that is 30 seconds in is 30 seconds
 * of work that would have to be redone, and the change will be picked up in the
 * batch that follows.
 */

export type TaskKind = 'apply' | 'rebuild' | 'merge' | 'full-regen' | 'measure';

export interface Task<T = unknown> {
  kind: TaskKind;
  /** Shown in `status` so an operator can see what is running and why. */
  describe: string;
  run: () => Promise<T>;
  /**
   * Fold a newly-submitted task of the same kind into this one instead of
   * queueing a second. Returns true when it absorbed the other. Used so a burst
   * of change batches becomes one rebuild rather than a backlog of them.
   */
  absorb?: (next: Task) => boolean;
}

export interface QueuedEntry {
  kind: TaskKind;
  describe: string;
  queuedAt: number;
}

export interface QueueStatus {
  running: { kind: TaskKind; describe: string; startedAt: number } | null;
  pending: QueuedEntry[];
  blocked: string | null;
  completed: number;
  lastError: string | null;
}

/**
 * Why the queue is refusing work. A blocked daemon must REFUSE, not queue: the
 * two blocking conditions (a merge left conflict markers, or an undo made the
 * in-memory model untrustworthy) both mean that further work would be computed
 * from a state nobody has confirmed. Queueing it would run that work later,
 * silently, which is the outcome to avoid.
 */
export type BlockReason = string;

export class WorkQueue {
  private readonly pending: Array<{ task: Task; resolve: (v: never) => void; reject: (e: unknown) => void }> = [];
  private running: { kind: TaskKind; describe: string; startedAt: number } | null = null;
  private blocked: BlockReason | null = null;
  private completed = 0;
  private lastError: string | null = null;
  private draining = false;

  constructor(private readonly log: (msg: string) => void = () => {}) {}

  /**
   * Submit a task. Resolves with the task's result once it has run.
   *
   * Rejects immediately when the queue is blocked, so a caller learns now rather
   * than waiting on work that will never be scheduled.
   */
  submit<T>(task: Task<T>): Promise<T> {
    if (this.blocked && task.kind !== 'merge' && task.kind !== 'measure') {
      return Promise.reject(new Error(`daemon is blocked: ${this.blocked}`));
    }

    // Fold into an already-queued task of the same kind where the task says it
    // can. Only entries that have not started are candidates - the running task
    // is past the point where its inputs can change.
    for (const entry of this.pending) {
      if (entry.task.kind === task.kind && entry.task.absorb?.(task as Task)) {
        this.log(`queue: folded ${task.kind} into the pending one (${task.describe})`);
        return entry as unknown as Promise<T>;
      }
    }

    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        task: task as Task,
        resolve: resolve as (v: never) => void,
        reject,
      });
      void this.drain();
    });
  }

  /**
   * Stop scheduling. Existing pending tasks are rejected rather than left to run
   * later against state that has since been declared untrustworthy.
   */
  block(reason: BlockReason): void {
    this.blocked = reason;
    this.log(`queue: BLOCKED - ${reason}`);
    while (this.pending.length > 0) {
      const entry = this.pending.shift()!;
      entry.reject(new Error(`daemon is blocked: ${reason}`));
    }
  }

  unblock(): void {
    if (!this.blocked) return;
    this.log(`queue: unblocked (was: ${this.blocked})`);
    this.blocked = null;
    void this.drain();
  }

  get isBlocked(): boolean {
    return this.blocked !== null;
  }

  status(): QueueStatus {
    return {
      running: this.running,
      pending: this.pending.map(e => ({
        kind: e.task.kind,
        describe: e.task.describe,
        queuedAt: Date.now(),
      })),
      blocked: this.blocked,
      completed: this.completed,
      lastError: this.lastError,
    };
  }

  /** Resolves once the queue has no running or pending work. For tests. */
  async idle(): Promise<void> {
    while (this.running || this.pending.length > 0) {
      await new Promise(r => setTimeout(r, 25));
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0 && !this.blocked) {
        const entry = this.pending.shift()!;
        this.running = {
          kind: entry.task.kind,
          describe: entry.task.describe,
          startedAt: Date.now(),
        };
        this.log(`queue: ${entry.task.kind} - ${entry.task.describe}`);
        try {
          const result = await entry.task.run();
          this.completed++;
          entry.resolve(result as never);
        } catch (err) {
          // One failed task must not take the queue down with it: the operator
          // needs the daemon still answering `status` to find out what broke.
          this.lastError = err instanceof Error ? err.message : String(err);
          this.log(`queue: ${entry.task.kind} FAILED - ${this.lastError}`);
          entry.reject(err);
        } finally {
          this.running = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
