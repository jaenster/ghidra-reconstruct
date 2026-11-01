/**
 * Write effects of every function of the model: what a call to it may change.
 *
 * nest-call puts a call back inside an argument list. VC8 evaluates the arguments right
 * to left, GCC in an order of its own, so an argument that reads memory beside the nested
 * call may be read before the call under one compiler and after it under the other. That
 * is harmless exactly when the call cannot write what the argument reads, and this is the
 * evidence for it (DRAW_UI_HelpXpac's GetLocaleString writes no global, so a global read
 * beside it reads the same value either way).
 *
 * A function's summary is, from least to most:
 *
 *   none      it writes only its own locals and parameters;
 *   params    it writes memory reached through the pointers it was passed (by index);
 *   globals   it writes these globals, by name;
 *   memory    it writes memory behind a pointer of unknown provenance: any object whose
 *             address was ever taken, any heap block, any global;
 *   unknown   anything: an indirect call, a callee with no body and no contract, a body
 *             that does not parse, a recursion that does not settle.
 *
 * Summaries are computed from each body's AST and then bottom-up over the call graph, to a
 * fixpoint: a call adds its callee's summary, the callee's parameter writes translated to
 * what the caller passed there (its own local: nothing; its own parameter: that parameter;
 * a global's address: that global; anything else: memory). Recursion starts from nothing
 * and grows; a cycle that has not settled after the round limit is unknown.
 *
 * The statements of a block that ends the process (`exit`, `abort`, ...) from which no
 * path leaves the block another way contribute nothing: no caller runs after them.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CompoundStmt, Expression, Identifier, MemberExpr, ParenExpr,
  SubscriptExpr, UnaryExpr, VariableDecl, CStyleCastExpr, BinaryExpr,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { calleeName, bareName } from './call-arg-cast.js';

export interface WriteEffect {
  unknown?: true;
  memory?: true;
  /** Global names (leaf spelling) written directly. */
  globals?: string[];
  /** Indices of pointer parameters whose pointees are written. */
  params?: number[];
}

/** One function as the summary reads it. `body` null: it could not be read (unknown). */
export interface EffectFunction {
  /** Every spelling a call may name it by. */
  keys: readonly string[];
  /** Parameter names in order. */
  params: readonly string[];
  body: CompoundStmt | null;
}

export interface WriteEffectOptions {
  /** Names of globals declared as arrays: the name is the array's address. */
  globalArrays?: ReadonlySet<string>;
  /** Every global's name (leaf spelling). A name written that is neither a local nor one
   *  of these is a register value or alias the decompiler did not declare: the function's own. */
  globalNames?: ReadonlySet<string>;
  /** Called for each function found unknown on its own, with why. */
  onUnknown?: (key: string, why: string) => void;
  /** Callees without a body: name -> what a call may write. */
  contracts?: Record<string, WriteEffect>;
  /** Rounds before an unsettled recursion is declared unknown. */
  maxRounds?: number;
}

/** Callees the model has no body for, whose writes the C library or Win32 documents. */
export const WRITE_CONTRACTS: Record<string, WriteEffect> = (() => {
  const none: WriteEffect = {};
  const first: WriteEffect = { params: [0] };
  const out: Record<string, WriteEffect> = {};
  for (const n of ['strlen', 'wcslen', 'strcmp', 'wcscmp', 'strncmp', 'wcsncmp', '_stricmp', 'stricmp', '_strcmpi',
    'strcmpi', '_strnicmp', '_wcsicmp', 'memcmp', 'strchr', 'strrchr', 'wcschr', 'strstr', 'abs', 'labs', 'atoi',
    'atol', 'toupper', 'tolower', 'isalpha', 'isdigit', 'isspace', 'isalnum', 'lstrlenA', 'lstrlenW', 'lstrcmpA',
    'lstrcmpiA', 'GetTickCount', 'GetCurrentThreadId', 'GetCurrentProcessId', 'GetCurrentProcess', 'GetCurrentThread',
    'IsBadCodePtr', 'IsBadReadPtr', 'IsBadWritePtr', 'IsBadStringPtrA', 'GetModuleHandleA', 'GetKeyState',
    'GetAsyncKeyState', 'CloseHandle', 'WaitForSingleObject', 'CreateEventA', 'SetEvent', 'ResetEvent', 'CreateFileA',
    'VirtualAlloc', 'VirtualFree', 'Sleep', 'GetLastError', 'SetLastError']) out[n] = none;
  for (const n of ['memcpy', 'memmove', 'memset', 'strcpy', 'strncpy', 'strcat', 'strncat', 'wcscpy', 'wcsncpy',
    'wcscat', 'sprintf', 'vsprintf', '_snprintf', '_vsnprintf', 'swprintf', 'wsprintfA', 'wsprintfW', 'wvsprintfA',
    'lstrcpyA', 'lstrcpynA', 'lstrcatA', 'ZeroMemory', 'RtlZeroMemory', 'RtlMoveMemory', 'CopyMemory', 'builtin_strncpy',
    'builtin_memcpy', 'builtin_memset', 'EnterCriticalSection', 'LeaveCriticalSection', 'InitializeCriticalSection',
    'DeleteCriticalSection', 'InterlockedIncrement', 'InterlockedDecrement', 'InterlockedExchange',
    'InterlockedCompareExchange', 'InterlockedExchangeAdd', 'QueryPerformanceCounter', 'QueryPerformanceFrequency',
    'GetLocalTime', 'GetSystemTime', 'SetRect', 'SetRectEmpty', 'OffsetRect', 'GetCursorPos']) out[n] = first;
  // Win32 out-parameters other than the first.
  out.MultiByteToWideChar = { params: [4] };
  out.WideCharToMultiByte = { params: [4, 7] };
  out.WriteFile = { params: [3] };
  out.ReadFile = { params: [1, 3] };
  return out;
})();

/** Calls that end the process: nothing after them is observed by a caller. */
const NO_RETURN = new Set(['exit', '_exit', 'abort', 'ExitProcess', 'FatalAppExitA', '_amsg_exit']);

/** Ghidra's p-code operators printed as calls: they compute and write nothing. */
const PSEUDO_OP = /^(ADJ|LOCK|UNLOCK|CONCAT\d+|SUB\d+|ZEXT\d+|SEXT\d+|CARRY\d|SCARRY\d|SBORROW\d|POPCOUNT|LZCOUNT|ABS|SQRT|NAN|ROUND|TRUNC|FLOOR|CEIL|INT_\w+)$/;

type Prov = { kind: 'own' } | { kind: 'param'; index: number } | { kind: 'global'; name: string } | { kind: 'memory' };

interface Local { array: boolean; param: number }

interface CallSite { name: string | null; args: Prov[] }

interface Direct { unknown: boolean; memory: boolean; globals: Set<string>; params: Set<number>; calls: CallSite[] }

function unwrap(e: Expression): Expression {
  for (;;) {
    if (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
    else if (e.kind === NodeKind.CStyleCastExpr) e = (e as CStyleCastExpr).expression;
    else return e;
  }
}

function leafOf(e: Expression): string | null {
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name;
  if (e.kind === NodeKind.QualifiedId) {
    const n = calleeName(e);
    return n ? bareName(n) : null;
  }
  return null;
}

/** Statements that leave a block other than by falling off its end. */
function leaves(n: ASTNode): boolean {
  for (const m of traverseAST(n)) {
    if (m.kind === NodeKind.ReturnStmt || m.kind === NodeKind.GotoStmt || m.kind === NodeKind.LabelStmt
      || m.kind === NodeKind.BreakStmt || m.kind === NodeKind.ContinueStmt) return true;
  }
  return false;
}

/**
 * For a block that ends the process: the index of the first statement from which no path
 * leaves the block other than through that end, else -1. What runs from there on is never
 * seen by a caller.
 */
function deadTail(block: CompoundStmt): number {
  const last = block.statements[block.statements.length - 1];
  if (!last || last.kind !== NodeKind.ExprStmt) return -1;
  const e = unwrap((last as unknown as { expression: Expression }).expression);
  if (e.kind !== NodeKind.CallExpr) return -1;
  const name = calleeName((e as CallExpr).callee);
  if (!name || !NO_RETURN.has(bareName(name))) return -1;
  let from = block.statements.length - 1;
  while (from > 0 && !leaves(block.statements[from - 1])) from--;
  return from;
}

function analyse(fn: EffectFunction, opts: WriteEffectOptions): Direct {
  const d: Direct = { unknown: false, memory: false, globals: new Set(), params: new Set(), calls: [] };
  if (!fn.body) { d.unknown = true; return d; }
  const locals = new Map<string, Local>();
  fn.params.forEach((p, i) => locals.set(p, { array: false, param: i }));
  for (const n of traverseAST(fn.body)) {
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      locals.set(v.name.name, { array: v.type?.kind === NodeKind.ArrayType, param: -1 });
    }
  }
  const arrays = opts.globalArrays ?? new Set<string>();

  /** Where the pointer value `e` points. */
  const pointee = (e: Expression): Prov => {
    const u = unwrap(e);
    if (u.kind === NodeKind.BinaryExpr && ((u as BinaryExpr).operator === '+' || (u as BinaryExpr).operator === '-')) {
      return pointee((u as BinaryExpr).left as Expression);
    }
    if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '&') return root((u as UnaryExpr).operand);
    const name = leafOf(u);
    if (name !== null) {
      const l = u.kind === NodeKind.Identifier ? locals.get(name) : undefined;
      if (l) return l.array ? { kind: 'own' } : l.param >= 0 ? { kind: 'param', index: l.param } : { kind: 'memory' };
      if (arrays.has(name)) return { kind: 'global', name };
    }
    return { kind: 'memory' };
  };

  /** The object an lvalue designates part of. */
  const root = (e: Expression): Prov => {
    const u = unwrap(e);
    const name = leafOf(u);
    if (name !== null) {
      const l = u.kind === NodeKind.Identifier ? locals.get(name) : undefined;
      if (l) return { kind: 'own' };
      // A register value or alias Ghidra did not declare is the function's own.
      if (u.kind === NodeKind.Identifier && (/^(in_|unaff_|extraout_)/.test(name)
        || (opts.globalNames && !opts.globalNames.has(name)))) {
        return { kind: 'own' };
      }
      return { kind: 'global', name };
    }
    switch (u.kind) {
      case NodeKind.MemberExpr: {
        const m = u as MemberExpr;
        return m.isArrow ? pointee(m.object) : root(m.object);
      }
      case NodeKind.SubscriptExpr: {
        const s = u as SubscriptExpr;
        const base = unwrap(s.array);
        const bn = leafOf(base);
        const local = bn !== null && base.kind === NodeKind.Identifier ? locals.get(bn) : undefined;
        if ((local && local.array) || (bn !== null && !local && arrays.has(bn))) return root(base);
        return pointee(s.array);
      }
      case NodeKind.UnaryExpr:
        if ((u as UnaryExpr).operator === '*') return pointee((u as UnaryExpr).operand);
        return { kind: 'memory' };
      default:
        return { kind: 'memory' };
    }
  };

  const write = (p: Prov) => {
    if (p.kind === 'global') d.globals.add(p.name);
    else if (p.kind === 'param') d.params.add(p.index);
    else if (p.kind === 'memory') d.memory = true;
  };

  const visit = (n: ASTNode): void => {
    if (n.kind === NodeKind.CompoundStmt) {
      const tail = deadTail(n as CompoundStmt);
      if (tail >= 0) {
        for (const k of (n as CompoundStmt).statements.slice(0, tail)) visit(k);
        return;
      }
    }
    switch (n.kind) {
      case NodeKind.AssignExpr:
        write(root((n as AssignExpr).left));
        break;
      case NodeKind.PostfixExpr:
        write(root((n as unknown as { operand: Expression }).operand));
        break;
      case NodeKind.UnaryExpr: {
        const op = (n as UnaryExpr).operator;
        if (op === '++' || op === '--') write(root((n as UnaryExpr).operand));
        break;
      }
      case NodeKind.CallExpr: {
        const c = n as CallExpr;
        const callee = unwrap(c.callee);
        const name = callee.kind === NodeKind.Identifier || callee.kind === NodeKind.QualifiedId ? calleeName(callee) ?? null : null;
        const leaf = name ? bareName(name) : null;
        if (leaf && PSEUDO_OP.test(leaf)) break;
        // A name that is a variable holds a function pointer: an indirect call.
        const variable = !!leaf && callee.kind === NodeKind.Identifier && locals.has(leaf);
        d.calls.push({ name: variable ? null : name, args: c.arguments.map(a => pointee(a as Expression)) });
        break;
      }
      case NodeKind.NewExpr: case NodeKind.DeleteExpr:
        d.unknown = true;
        break;
    }
    for (const k of getChildren(n)) visit(k);
  };
  visit(fn.body);
  return d;
}

interface Sum { unknown: boolean; memory: boolean; globals: Set<string>; params: Set<number> }

const bottom = (): Sum => ({ unknown: false, memory: false, globals: new Set(), params: new Set() });

function fromEffect(w: WriteEffect): Sum {
  return { unknown: !!w.unknown, memory: !!w.memory, globals: new Set(w.globals ?? []), params: new Set(w.params ?? []) };
}

function toEffect(s: Sum): WriteEffect {
  if (s.unknown) return { unknown: true };
  const out: WriteEffect = {};
  if (s.memory) out.memory = true;
  if (s.globals.size) out.globals = [...s.globals].sort();
  if (s.params.size) out.params = [...s.params].sort((a, b) => a - b);
  return out;
}

function same(a: Sum, b: Sum): boolean {
  if (a.unknown && b.unknown) return true;
  if (a.unknown !== b.unknown || a.memory !== b.memory || a.globals.size !== b.globals.size || a.params.size !== b.params.size) return false;
  for (const g of a.globals) if (!b.globals.has(g)) return false;
  for (const p of a.params) if (!b.params.has(p)) return false;
  return true;
}

/** The summaries, keyed by every spelling of every function (joined where spellings collide). */
export function summarizeWriteEffects(fns: readonly EffectFunction[], opts: WriteEffectOptions = {}): Record<string, WriteEffect> {
  const contracts = opts.contracts ?? WRITE_CONTRACTS;
  const direct = fns.map(f => analyse(f, opts));
  const byKey = new Map<string, number[]>();
  fns.forEach((f, i) => {
    for (const k of f.keys) {
      let l = byKey.get(k);
      if (!l) byKey.set(k, l = []);
      l.push(i);
    }
  });
  let sums = fns.map(() => bottom());

  const calleeSum = (name: string | null, cur: Sum[]): Sum | null => {
    if (!name) return null;
    const owners = byKey.get(name) ?? byKey.get(bareName(name));
    if (owners) {
      const s = bottom();
      for (const i of owners) join(s, cur[i]);
      return s;
    }
    if (NO_RETURN.has(bareName(name))) return bottom();
    const c = contracts[bareName(name)];
    return c ? fromEffect(c) : null;
  };

  const step = (i: number, cur: Sum[]): Sum => {
    const d = direct[i];
    const s: Sum = { unknown: d.unknown, memory: d.memory, globals: new Set(d.globals), params: new Set(d.params) };
    for (const call of d.calls) {
      if (s.unknown) break;
      const c = calleeSum(call.name, cur);
      if (!c || c.unknown) {
        s.unknown = true;
        if (opts.onUnknown && (!c || direct[i].unknown)) opts.onUnknown(fns[i].keys[0], call.name ? `calls ${call.name}` : 'indirect call');
        break;
      }
      if (c.memory) s.memory = true;
      for (const g of c.globals) s.globals.add(g);
      for (const p of c.params) {
        const a = call.args[p];
        if (!a || a.kind === 'memory') s.memory = true;
        else if (a.kind === 'param') s.params.add(a.index);
        else if (a.kind === 'global') s.globals.add(a.name);
      }
    }
    return s;
  };

  const max = opts.maxRounds ?? 64;
  let settled = false;
  for (let round = 0; round < max; round++) {
    const next = sums.map((_s, i) => step(i, sums));
    let changed = false;
    for (let i = 0; i < next.length; i++) {
      // Monotone: never lose what an earlier round found.
      join(next[i], sums[i]);
      if (!same(next[i], sums[i])) changed = true;
    }
    sums = next;
    if (!changed) { settled = true; break; }
  }
  if (!settled) {
    // What still moves is part of a cycle that did not settle: unknown, and so is every
    // caller of it. Unknown absorbs, so this settles.
    for (let moved = true; moved;) {
      moved = false;
      const next = sums.map((_s, i) => step(i, sums));
      next.forEach((s, i) => {
        join(s, sums[i]);
        if (!same(s, sums[i])) { sums[i] = { ...bottom(), unknown: true }; moved = true; }
      });
    }
  }

  const out: Record<string, WriteEffect> = {};
  for (const [k, owners] of byKey) {
    const s = bottom();
    for (const i of owners) join(s, sums[i]);
    out[k] = toEffect(s);
  }
  return out;
}

function join(into: Sum, s: Sum): void {
  if (s.unknown) into.unknown = true;
  if (s.memory) into.memory = true;
  for (const g of s.globals) into.globals.add(g);
  for (const p of s.params) into.params.add(p);
}
