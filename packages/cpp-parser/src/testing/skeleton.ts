/**
 * Control-skeleton execution: compile a function's control flow with a real C++ compiler and
 * RUN it, before and after a rewrite, on the same decision streams.
 *
 * The validator (`transform/cfg/equivalence.ts`) is a proof over OUR model of C. This is the
 * independent check of that model: g++ decides where `break` binds, what `continue` does in a
 * `do`/`while`, how `&&` short-circuits, where a case falls through. A bug the validator and
 * a rewrite share has to get past both.
 *
 * Each function body becomes self-contained C++ with no D2 headers:
 *
 *   work statement       T(k);                  k indexes a key table shared by both sides
 *   valued return        { T(k); return; }
 *   noreturn call        { T(k); NR(); }        NR() longjmps out, recorded as its own end
 *   condition atom       D(k)                   the next bit of the decision stream; the
 *                                               operators around atoms are kept, so the
 *                                               compiler's own short-circuit rules are tested
 *   switch (e)           switch (S(k, n))       one of the n case values, or none
 *   labels, gotos, loops, break, continue, case labels: verbatim
 *
 * T/D/S append to a trace and count steps; a shared budget aborts runaway loops at the same
 * step on both sides when they are equivalent. Both sides run on 2,000 random streams, and
 * on every stream of the first 16 decision bits when the function has at most 12 decision
 * sites, at -O0 and at -O2.
 *
 * Every stream is assumed feasible, which over-approximates the real program: equivalence
 * for all streams implies equivalence for the real ones.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeKind } from '../ast/kinds.js';
import type {
  CaseStmt, CompoundStmt, DoWhileStmt, Expression, ForStmt, GotoStmt, IfStmt, LabelStmt,
  ReturnStmt, Statement, SwitchStmt, WhileStmt,
} from '../ast/nodes.js';
import { emit } from '../emit/index.js';
import { TriviaKind } from '../lexer/trivia.js';
import { isPureExpr } from '../transform/cfg/bcfg.js';

export class KeyTable {
  private ids = new Map<string, number>();
  /** scrutinee key -> case value key -> small int (1-based; 0 means "no case") */
  readonly caseValues = new Map<string, Map<string, number>>();
  id(key: string): number {
    let n = this.ids.get(key);
    if (n === undefined) { n = this.ids.size; this.ids.set(key, n); }
    return n;
  }
  caseValue(scrutinee: string, value: string): number {
    let m = this.caseValues.get(scrutinee);
    if (!m) { m = new Map(); this.caseValues.set(scrutinee, m); }
    let v = m.get(value);
    if (v === undefined) { v = m.size + 1; m.set(value, v); }
    return v;
  }
}

const NORETURN_WARNING = 'WARNING: Subroutine does not return';

function text(n: { kind: string }): string {
  return emit(n as never).trim();
}

function strip(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as unknown as { expression: Expression }).expression;
  return e;
}

export interface SkeletonOptions {
  noreturn?: ReadonlySet<string>;
  /** Wall-clock limit per compiled binary, seconds (DEFAULT_RUN_SECONDS). */
  runSeconds?: number;
}

/**
 * A REGION rather than a whole function: one compound the goto passes rewrote. It can be
 * entered at its start, at a label targeted from outside (`entries`), and at a case label
 * whose switch is outside; it can leave by falling off its end (the "follow"), by a goto to
 * a label it does not define, and by a `break`/`continue` with no binder inside it. Each way
 * out is traced as its own event, and the way in is drawn from the decision stream.
 */
export interface RegionSpec {
  entries: string[];
  followIsExit: boolean;
}

/** Emits one function body as a control skeleton. */
export class SkeletonEmitter {
  decisions = 0;
  private loops = 0;
  private breakables = 0;
  private defined = new Set<string>();
  /** Region mode: foreign case keys used, for the entry dispatch. */
  readonly foreign = new Set<string>();
  constructor(private keys: KeyTable, private opts: SkeletonOptions = {}, private region: RegionSpec | null = null) {}

  /** Emit a whole body (function mode) or a region with its entry dispatch and exits. */
  body(stmts: Statement[]): string {
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const node = n as { kind?: string; label?: { name: string } };
      if (node.kind === NodeKind.LabelStmt && node.label) this.defined.add(node.label.name);
      for (const [k, v] of Object.entries(node)) if (k !== 'location' && k !== 'leadingTrivia' && k !== 'trailingTrivia' && v && typeof v === 'object') walk(v);
    };
    walk(stmts);
    const inner = stmts.map(x => this.stmt(x)).join('\n');
    if (!this.region) return `{\n${inner}\n}`;
    const follow = this.region.followIsExit ? 'return;' : `T(${this.keys.id('~follow')}); return;`;
    const labelEntries = this.region.entries
      .filter(l => this.defined.has(l))
      .map(l => `case ${2000 + this.keys.id('entry:' + l)}: goto ${l};`).join(' ');
    return `{\nstatic const int ev[] = {@@ENTRIES@@};\nswitch (E(${this.keys.id('~entry')}, ev, (int)(sizeof(ev) / sizeof(ev[0])))) {\ncase 0: goto __start; ${labelEntries}\n__start:\n${inner}\n}\n${follow}\n}`;
  }

  private exitTo(name: string): string {
    return `{ T(${this.keys.id('~' + name)}); return; }`;
  }

  private isNoreturn(s: Statement): boolean {
    for (const t of s.leadingTrivia ?? []) {
      if ((t.kind === TriviaKind.BlockComment || t.kind === TriviaKind.LineComment) && t.text.includes(NORETURN_WARNING)) return true;
    }
    if (s.kind !== NodeKind.ExprStmt) return false;
    const e = strip((s as unknown as { expression: Expression }).expression);
    if (e.kind !== NodeKind.CallExpr) return false;
    const c = strip((e as unknown as { callee: Expression }).callee) as unknown as { kind: string; name: unknown };
    const name = c.kind === NodeKind.Identifier ? c.name as string
      : c.kind === NodeKind.QualifiedId ? ((c.name as { name?: string }).name ?? '') : '';
    return !!this.opts.noreturn?.has(name);
  }

  private work(s: Statement): string {
    const key = s.kind === NodeKind.ExprStmt
      ? 'e:' + text((s as unknown as { expression: Expression }).expression)
      : (s.kind === NodeKind.DeclStmt ? 'd:' : `s:${s.kind}:`) + text(s);
    return `T(${this.keys.id(key)});`;
  }

  cond(e: Expression): string {
    e = strip(e);
    if (e.kind === NodeKind.BoolLiteral) return (e as unknown as { value: boolean }).value ? 'true' : 'false';
    if (e.kind === NodeKind.IntegerLiteral) return (e as unknown as { value: bigint }).value !== 0n ? 'true' : 'false';
    if (e.kind === NodeKind.UnaryExpr && (e as unknown as { operator: string }).operator === '!') {
      return `!(${this.cond((e as unknown as { operand: Expression }).operand)})`;
    }
    if (e.kind === NodeKind.BinaryExpr) {
      const b = e as unknown as { operator: string; left: Expression; right: Expression };
      if (b.operator === '&&' || b.operator === '||') return `(${this.cond(b.left)} ${b.operator} ${this.cond(b.right)})`;
    }
    if (e.kind === NodeKind.ConditionalExpr) {
      const q = e as unknown as { condition: Expression; thenExpr: Expression; elseExpr: Expression };
      return `(${this.cond(q.condition)} ? ${this.cond(q.thenExpr)} : ${this.cond(q.elseExpr)})`;
    }
    if (e.kind === NodeKind.CommaExpr) {
      const xs = (e as unknown as { expressions: Expression[] }).expressions;
      const parts = xs.slice(0, -1).map(x => `T(${this.keys.id('e:' + text(x))})`);
      return `(${[...parts, this.cond(xs[xs.length - 1])].join(', ')})`;
    }
    this.decisions++;
    // A pure atom's value is a function of the program state, and only work changes the
    // state: model it as a hash of (stream, atom, work done so far), untraced. Evaluating
    // it twice between the same two statements gives the same answer, and not evaluating
    // it at all leaves no trace - exactly what "no side effect" means.
    return isPureExpr(e) ? `P(${this.keys.id(text(e))})` : `D(${this.keys.id(text(e))})`;
  }

  stmt(s: Statement): string {
    switch (s.kind) {
      case NodeKind.CompoundStmt:
        return `{\n${(s as CompoundStmt).statements.map(x => this.stmt(x)).join('\n')}\n}`;
      case NodeKind.NullStmt:
        return ';';
      case NodeKind.IfStmt: {
        const n = s as IfStmt;
        return `if (${this.cond(n.condition)}) ${this.stmt(n.thenBranch)}${n.elseBranch ? ` else ${this.stmt(n.elseBranch)}` : ''}`;
      }
      case NodeKind.WhileStmt: {
        const n = s as WhileStmt;
        return `while (${this.cond(n.condition)}) ${this.inLoop(() => this.stmt(n.body))}`;
      }
      case NodeKind.DoWhileStmt: {
        const n = s as DoWhileStmt;
        const b = this.inLoop(() => this.stmt(n.body));
        return `do ${b} while (${this.cond(n.condition)});`;
      }
      case NodeKind.ForStmt: {
        const n = s as ForStmt;
        const init = n.init ? this.stmt(n.init) : '';
        const c = n.condition ? this.cond(n.condition) : '';
        const inc = n.increment ? `T(${this.keys.id('e:' + text(n.increment))})` : '';
        return `{ ${init} for (; ${c}; ${inc}) ${this.inLoop(() => this.stmt(n.body))} }`;
      }
      case NodeKind.SwitchStmt: {
        const n = s as SwitchStmt;
        const scrut = 'sw:' + text(n.condition);
        this.breakables++;
        let body: string;
        try { body = this.withSwitch(scrut, () => this.stmt(n.body)); } finally { this.breakables--; }
        this.decisions++;
        // The case count is filled in once both sides are emitted (see runSkeletons), so
        // both draw from the same range.
        return `switch (S(${this.keys.id(scrut)}, @@CASES:${this.keys.id(scrut)}@@)) ${body}`;
      }
      case NodeKind.CaseStmt: {
        const n = s as CaseStmt;
        if (!this.switches.length) {
          this.foreign.add(text(n.value));
          return `case ${1000 + this.keys.id('foreign:' + text(n.value))}: ${this.stmt(n.statement)}`;
        }
        const v = this.keys.caseValue(this.switches[this.switches.length - 1], text(n.value));
        return `case ${v}: ${this.stmt(n.statement)}`;
      }
      case NodeKind.DefaultStmt: {
        const inner = this.stmt((s as unknown as { statement: Statement }).statement);
        if (!this.switches.length) {
          this.foreign.add('default');
          return `case ${1000 + this.keys.id('foreign:default')}: ${inner}`;
        }
        return `default: ${inner}`;
      }
      case NodeKind.LabelStmt: {
        const n = s as LabelStmt;
        return `${n.label.name}: ${this.stmt(n.statement)}`;
      }
      case NodeKind.GotoStmt: {
        const name = (s as GotoStmt).label.name;
        return this.region && !this.defined.has(name) ? this.exitTo('label:' + name) : `goto ${name};`;
      }
      case NodeKind.BreakStmt:
        return this.region && this.breakables === 0 ? this.exitTo('break') : 'break;';
      case NodeKind.ContinueStmt:
        return this.region && this.loops === 0 ? this.exitTo('continue') : 'continue;';
      case NodeKind.ReturnStmt: {
        const v = (s as ReturnStmt).value;
        return v ? `{ T(${this.keys.id('r:' + text(v))}); return; }` : 'return;';
      }
      default:
        return this.isNoreturn(s) ? `{ ${this.work(s)} NR(); }` : this.work(s);
    }
  }

  private inLoop(f: () => string): string {
    this.loops++; this.breakables++;
    try { return f(); } finally { this.loops--; this.breakables--; }
  }

  private switches: string[] = [];
  private withSwitch<T>(scrut: string, f: () => T): T {
    this.switches.push(scrut);
    try { return f(); } finally { this.switches.pop(); }
  }
}

export interface SkeletonPair {
  name: string;
  before: Statement[];
  after: Statement[];
  /** Present when the statements are a region, not a whole function body. */
  region?: RegionSpec;
}

export interface SkeletonResult {
  name: string;
  ok: boolean;
  /** First stream that told them apart, when not ok. */
  detail?: string;
  /**
   * The run was killed at its time limit before this pair reported: UNPROVEN, neither same
   * nor different. `ok` is false so that a caller that only reads `ok` never counts it as
   * agreement.
   */
  timedOut?: boolean;
}

/** Wall-clock limit for one compiled skeleton binary (all pairs of a batch, one level). */
export const DEFAULT_RUN_SECONDS = 120;
const COMPILE_SECONDS = 300;

const PRELUDE = String.raw`
#include <cstdint>
#include <cstdio>
#include <csetjmp>
#include <cstring>
#include <csignal>
#include <unistd.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif
// The binary bounds itself, so it cannot outlive the harness: it dies with its parent
// (Linux), and on its own alarm whatever happens to the parent.
static void guard(unsigned seconds) {
#ifdef __linux__
  prctl(PR_SET_PDEATHSIG, SIGKILL);
  if (getppid() == 1) _exit(125);
#endif
  signal(SIGALRM, SIG_DFL);
  alarm(seconds);
  setvbuf(stdout, nullptr, _IOLBF, 0);
}
static uint64_t g_state; static int g_exhaustive; static uint64_t g_bits; static int g_pos;
static uint32_t g_trace[4096]; static int g_len; static int g_steps; static jmp_buf g_jmp;
static const int BUDGET = 3000;
static inline void step() { if (++g_steps > BUDGET) longjmp(g_jmp, 2); }
static inline void rec(uint32_t v) { if (g_len < 4096) g_trace[g_len++] = v; }
static inline unsigned bit() {
  if (g_exhaustive) { unsigned b = g_pos < 64 ? (unsigned)((g_bits >> g_pos) & 1u) : 0u; g_pos++; return b; }
  g_state ^= g_state << 13; g_state ^= g_state >> 7; g_state ^= g_state << 17; return (unsigned)(g_state & 1u);
}
static uint64_t g_seed; static uint32_t g_work;
static void T(int k) { step(); g_work++; rec(0x10000000u | (uint32_t)k); }
static bool P(int k) {
  step();
  uint64_t h = g_seed * 0x9E3779B97F4A7C15ull ^ ((uint64_t)k << 32) ^ g_work;
  h ^= h >> 33; h *= 0xff51afd7ed558ccdull; h ^= h >> 33; h *= 0xc4ceb9fe1a85ec53ull; h ^= h >> 33;
  return (h & 1) != 0;
}
static bool D(int k) { step(); unsigned b = bit(); rec(0x20000000u | ((uint32_t)k << 1) | b); return b != 0; }
static int S(int k, int n) { step(); unsigned v = 0; for (int i = 0; i < 4; i++) v = (v << 1) | bit(); int r = (int)(v % (unsigned)(n + 1)); rec(0x30000000u | ((uint32_t)k << 8) | (uint32_t)r); return r; }
[[noreturn]] static void NR() { longjmp(g_jmp, 3); }
static int E(int k, const int* vals, int n) { step(); unsigned v = 0; for (int i = 0; i < 4; i++) v = (v << 1) | bit(); int r = vals[v % (unsigned)n]; rec(0x40000000u | ((uint32_t)k << 12) | (uint32_t)r); return r; }
typedef void (*Fn)();
static int run(Fn f, uint64_t seed, int exhaustive, uint32_t* out, int* outLen) {
  g_seed = seed; g_work = 0; g_state = seed * 0x9E3779B97F4A7C15ull + 1; g_exhaustive = exhaustive; g_bits = seed; g_pos = 0; g_len = 0; g_steps = 0;
  int end = setjmp(g_jmp);
  if (end == 0) { f(); end = 1; }
  memcpy(out, g_trace, sizeof(uint32_t) * g_len); *outLen = g_len; return end;
}
static int compare(const char* name, Fn a, Fn b, int exhaustive) {
  static uint32_t ta[4096], tb[4096]; int la, lb;
  int seeds = exhaustive ? 65536 : 2000;
  for (int s = 0; s < seeds; s++) {
    int ea = run(a, (uint64_t)s, exhaustive, ta, &la);
    int eb = run(b, (uint64_t)s, exhaustive, tb, &lb);
    if (ea != eb || la != lb || memcmp(ta, tb, sizeof(uint32_t) * la) != 0) {
      printf("MISMATCH %s seed=%d exhaustive=%d end=%d/%d len=%d/%d\n", name, s, exhaustive, ea, eb, la, lb);
      return 1;
    }
  }
  return 0;
}
`;

/**
 * Compile every pair at -O0 and -O2 with the host g++ and compare their traces. Returns one
 * result per pair. Throws when the compiler rejects the skeleton (that is a harness bug, or
 * a rewrite that produced C++ no compiler accepts).
 */
export function runSkeletons(pairs: SkeletonPair[], opts: SkeletonOptions = {}): SkeletonResult[] {
  const keys = new KeyTable();
  const fns: string[] = [];
  const calls: string[] = [];
  pairs.forEach((p, i) => {
    const eb = new SkeletonEmitter(keys, opts, p.region ?? null);
    let before = eb.body(p.before);
    const ea = new SkeletonEmitter(keys, opts, p.region ?? null);
    let after = ea.body(p.after);
    if (p.region) {
      // One entry set for both sides: the start, every outside-targeted label either side
      // defines, every foreign case either side holds.
      const vals = ['0',
        ...p.region.entries.map(l => String(2000 + keys.id('entry:' + l))),
        ...[...new Set([...eb.foreign, ...ea.foreign])].map(v => String(1000 + keys.id('foreign:' + v)))];
      const arr = vals.join(',');
      before = before.replace('@@ENTRIES@@', arr);
      after = after.replace('@@ENTRIES@@', arr);
      // A foreign case value both sides lack would be a case label with no target.
      const allCases = (side: SkeletonEmitter) => [...new Set([...eb.foreign, ...ea.foreign])]
        .filter(v => !side.foreign.has(v)).map(v => `case ${1000 + keys.id('foreign:' + v)}: T(${keys.id('~missing-case')}); return;`).join(' ');
      before = before.replace('case 0: goto __start;', `case 0: goto __start; ${allCases(eb)}`);
      after = after.replace('case 0: goto __start;', `case 0: goto __start; ${allCases(ea)}`);
      // Likewise an entry label one side no longer defines.
      for (const [side, em] of [['before', eb], ['after', ea]] as const) {
        const missing = p.region.entries.filter(l => !(em as unknown as { defined: Set<string> }).defined.has(l))
          .map(l => `case ${2000 + keys.id('entry:' + l)}: T(${keys.id('~missing-entry')}); return;`).join(' ');
        if (side === 'before') before = before.replace('case 0: goto __start;', `case 0: goto __start; ${missing}`);
        else after = after.replace('case 0: goto __start;', `case 0: goto __start; ${missing}`);
      }
    }
    fns.push(`static void before_${i}() ${before}\nstatic void after_${i}() ${after}`);
    calls.push(`{ int bad = compare("${i}", before_${i}, after_${i}, 0);`
      + (Math.max(eb.decisions, ea.decisions) <= 12 ? ` if (!bad) bad = compare("${i}", before_${i}, after_${i}, 1);` : '')
      + ` printf("%s ${i}\\n", bad ? "FAIL" : "PASS"); fflush(stdout); }`);
  });
  const caseCount = new Map<string, number>();
  for (const [scrut, m] of keys.caseValues) caseCount.set(String(keys.id(scrut)), m.size);
  const body = fns.join('\n').replace(/@@CASES:(\d+)@@/g, (_, k) => String(caseCount.get(k) ?? 0));
  const runLimit = Math.max(1, Math.ceil((opts.runSeconds ?? DEFAULT_RUN_SECONDS)));
  const src = `${PRELUDE}\n${body}\nint main() {\nguard(${runLimit});\n${calls.join('\n')}\nreturn 0;\n}\n`;
  const dir = mkdtempSync(join(tmpdir(), 'skeleton-'));
  try {
    const file = join(dir, 's.cpp');
    writeFileSync(file, src);
    const verdicts = new Map<string, { ok: boolean; detail: string[] }>();
    const timedOut = new Set<string>();
    for (const level of ['-O0', '-O2']) {
      const exe = join(dir, `s${level}`);
      const cc = spawnSync('g++', ['-std=c++17', level, '-w', file, '-o', exe], {
        stdio: 'pipe', timeout: COMPILE_SECONDS * 1000, killSignal: 'SIGKILL',
      });
      if (cc.status !== 0) {
        const why = cc.error ? String(cc.error) : cc.stderr?.toString() ?? '';
        throw new Error(`skeleton does not compile (${level}):\n${why.slice(0, 2000)}\n--- source ---\n${src.slice(0, 4000)}`);
      }
      // A hard limit from outside as well as the binary's own alarm: SIGKILL at the limit
      // plus a grace second. What it printed before then still counts.
      const run = spawnSync(exe, [], {
        encoding: 'utf8', maxBuffer: 64 << 20, timeout: (runLimit + 1) * 1000, killSignal: 'SIGKILL',
      });
      const out = run.stdout ?? '';
      const killed = run.status !== 0;
      for (const line of out.split('\n')) {
        const m = /^(PASS|FAIL) (.*)$/.exec(line);
        if (m) {
          const v = verdicts.get(m[2]) ?? { ok: true, detail: [] };
          if (m[1] === 'FAIL') v.ok = false;
          verdicts.set(m[2], v);
        } else if (line.startsWith('MISMATCH')) {
          const name = line.split(' ')[1];
          const v = verdicts.get(name) ?? { ok: true, detail: [] };
          v.detail.push(`${level} ${line}`);
          verdicts.set(name, v);
        }
      }
      if (killed) {
        // Every pair this level did not finish is unproven at this level.
        const reported = new Set(out.split('\n').map(l => /^(?:PASS|FAIL) (.*)$/.exec(l)?.[1]).filter(Boolean) as string[]);
        pairs.forEach((_, i) => { if (!reported.has(String(i))) timedOut.add(String(i)); });
      }
    }
    return pairs.map((p, i) => {
      const v = verdicts.get(String(i));
      if (timedOut.has(String(i)) && v?.ok !== false) {
        // A FAIL seen at the other level stands; otherwise nothing was shown.
        return { name: p.name, ok: false, timedOut: true, detail: 'killed at the time limit (or crashed) before reporting: unproven' };
      }
      return { name: p.name, ok: v?.ok ?? false, detail: v?.detail.join('; ') };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
