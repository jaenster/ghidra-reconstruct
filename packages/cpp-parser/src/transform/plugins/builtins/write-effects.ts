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
 *
 * Memory and parameter writes carry the typed regions they reach where the access says
 * (memory-regions.ts): RollRandomNumerUpToArgument stores only a D2SeedStrc, so a read of a
 * D2MonSoundsTxt field beside it reads the same either way. A region is the callee's own
 * access, so it holds whatever pointer the caller passed.
 *
 * A call through a global function pointer is a call to one of the functions it can hold:
 * its initial value and every function a body stores into it, when nothing else is ever
 * stored there and its address is never taken (D2WINFONT_GetStringPixelWidth's
 * `(*gpfnFontGetCharWidth)(c)` is FONT_GetCharWidthCallback or D2WINFONT_LookupGlyphEntry).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CompoundStmt, Expression, Identifier, MemberExpr, ParenExpr,
  SubscriptExpr, UnaryExpr, VariableDecl, CStyleCastExpr, BinaryExpr,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { calleeName, bareName, shapeOfNode, shapeOfSpelling, type TypeShape } from './call-arg-cast.js';
import { Regions, regionOf, type AggregateModel, type TypingEnv } from './memory-regions.js';

export interface WriteEffect {
  unknown?: true;
  memory?: true;
  /** Global names (leaf spelling) written directly. */
  globals?: string[];
  /** Indices of pointer parameters whose pointees are written. */
  params?: number[];
  /** With `memory`: the only regions it writes (memory-regions.ts); absent: any. */
  regions?: string[];
  /** Parameter index -> the only regions written through it; absent: any. */
  paramRegions?: Record<string, string[]>;
  /** What a call may read, in the same terms (absent: anything). */
  reads?: Omit<WriteEffect, 'reads'>;
}

/** One function as the summary reads it. `body` null: it could not be read (unknown). */
export interface EffectFunction {
  /** Every spelling a call may name it by. */
  keys: readonly string[];
  /** Parameter names in order. */
  params: readonly string[];
  /** Declared parameter type spellings, in the same order. */
  paramTypes?: readonly (string | undefined)[];
  body: CompoundStmt | null;
  /**
   * This function's own part, already read from `body` by `analyseWriteEffects` under
   * the same options: used instead of reading the body again. `body` is then unread.
   */
  analysis?: WriteEffectAnalysis;
}

/** One summary as plain data. */
interface PlainSum {
  unknown: boolean; memory: boolean; regions: string[] | null; globals: string[];
  params: number[]; paramRegions: [number, string[] | null][];
}

/**
 * What one function contributes to the summary on its own, as plain data: its direct
 * writes and reads with the calls it makes, and what it stores into global function
 * pointers. A function of its body, its parameters and the options alone, so it can be
 * computed once and kept.
 */
export interface WriteEffectAnalysis {
  w: PlainSum;
  r: PlainSum;
  calls: CallSite[];
  /** Global -> functions this body stores into it, in the order it stores them. */
  stored: [string, string[]][];
  /** Globals this body stores anything else into, or takes the address of. */
  poisoned: string[];
}

export interface WriteEffectOptions {
  /** Names of globals declared as arrays: the name is the array's address. */
  globalArrays?: ReadonlySet<string>;
  /** Every global's name (leaf spelling). A name written that is neither a local nor one
   *  of these is a register value or alias the decompiler did not declare: the function's own. */
  globalNames?: ReadonlySet<string>;
  /** Called for each function found unknown on its own, with why. */
  onUnknown?: (key: string, why: string) => void;
  /** Callees without a body: name -> what a call may write and read. */
  contracts?: Record<string, WriteEffect>;
  /** Rounds before an unsettled recursion is declared unknown. */
  maxRounds?: number;
  /** The aggregates, for the regions a write through a typed pointer reaches. */
  aggregates?: AggregateModel;
  /** Global (leaf spelling) -> declared type spelling. */
  globalTypes?: Record<string, string>;
  /** Global (leaf spelling) -> the functions its initial value may name ([] for null); null
   *  or absent: not known, so a call through it is not resolved. */
  globalInitialTargets?: Record<string, readonly string[] | null>;
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
  // What they read: the system's own state for these, memory for the rest.
  const system = new Set(['abs', 'labs', 'toupper', 'tolower', 'isalpha', 'isdigit', 'isspace', 'isalnum',
    'GetTickCount', 'GetCurrentThreadId', 'GetCurrentProcessId', 'GetCurrentProcess', 'GetCurrentThread',
    'GetModuleHandleA', 'GetKeyState', 'GetAsyncKeyState', 'CloseHandle', 'WaitForSingleObject', 'CreateEventA',
    'SetEvent', 'ResetEvent', 'VirtualAlloc', 'VirtualFree', 'Sleep', 'GetLastError', 'SetLastError',
    'QueryPerformanceCounter', 'QueryPerformanceFrequency', 'GetLocalTime', 'GetSystemTime', 'GetCursorPos']);
  for (const [n, e] of Object.entries(out)) out[n] = { ...e, reads: system.has(n) ? {} : { memory: true } };
  return out;
})();

function plainSum(s: Sum): PlainSum {
  return {
    unknown: s.unknown, memory: s.memory, regions: s.regions === null ? null : [...s.regions],
    globals: [...s.globals], params: [...s.params],
    paramRegions: [...s.paramRegions].map(([i, r]) => [i, r === null ? null : [...r]]),
  };
}

function sumOf(p: PlainSum): Sum {
  return {
    unknown: p.unknown, memory: p.memory, regions: p.regions === null ? null : new Set(p.regions),
    globals: new Set(p.globals), params: new Set(p.params),
    paramRegions: new Map(p.paramRegions.map(([i, r]) => [i, r === null ? null : new Set(r)])),
  };
}

/**
 * A reader of one function's own part, for `EffectFunction.analysis`. The options must
 * be the ones the summary is then made under.
 */
export function writeEffectAnalyser(opts: WriteEffectOptions = {}): (fn: EffectFunction) => WriteEffectAnalysis {
  const regions = opts.aggregates ? new Regions(opts.aggregates) : null;
  return fn => {
    const stores: PointerStores = { stored: new Map(), poisoned: new Set() };
    const { w, r } = analyse(fn, opts, regions, stores);
    return {
      w: plainSum(w), r: plainSum(r), calls: w.calls,
      stored: [...stores.stored].map(([g, t]) => [g, [...t]]),
      poisoned: [...stores.poisoned],
    };
  };
}

/** Calls that end the process: nothing after them is observed by a caller. */
const NO_RETURN = new Set(['exit', '_exit', 'abort', 'ExitProcess', 'FatalAppExitA', '_amsg_exit']);

/** Ghidra's p-code operators printed as calls: they compute and write nothing. */
const PSEUDO_OP = /^(ADJ|LOCK|UNLOCK|CONCAT\d+|SUB\d+|ZEXT\d+|SEXT\d+|CARRY\d|SCARRY\d|SBORROW\d|POPCOUNT|LZCOUNT|ABS|SQRT|NAN|ROUND|TRUNC|FLOOR|CEIL|INT_\w+)$/;

type Prov = { kind: 'own' } | { kind: 'param'; index: number } | { kind: 'global'; name: string } | { kind: 'memory' };

interface Local { array: boolean; param: number; decl?: VariableDecl; trusted: boolean }

/** A call; `via`: the global a call through a function pointer reads it from. */
interface CallSite { name: string | null; via?: string; args: Prov[] }

/** Regions: null is untyped (anything). */
type RegionSet = Set<string> | null;

interface Sum {
  unknown: boolean; memory: boolean; regions: RegionSet; globals: Set<string>;
  params: Set<number>; paramRegions: Map<number, RegionSet>;
}

interface Direct extends Sum { calls: CallSite[] }

/** Functions stored into globals by name; `poisoned`: anything else stored, or its address taken. */
interface PointerStores { stored: Map<string, Set<string>>; poisoned: Set<string> }

function unionRegions(a: RegionSet, b: RegionSet): RegionSet {
  if (a === null || b === null) return null;
  const out = new Set(a);
  for (const r of b) out.add(r);
  return out;
}

function addMemory(s: Sum, r: RegionSet): void {
  s.regions = s.memory ? unionRegions(s.regions, r) : r === null ? null : new Set(r);
  s.memory = true;
}

function addParam(s: Sum, i: number, r: RegionSet): void {
  s.params.add(i);
  s.paramRegions.set(i, s.paramRegions.has(i) ? unionRegions(s.paramRegions.get(i)!, r) : r === null ? null : new Set(r));
}

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

/** Whether a value is converted into its variable by a cast (a null constant aside). */
function convertsByCast(e: Expression): boolean {
  let u = e;
  while (u.kind === NodeKind.ParenExpr) u = (u as ParenExpr).expression;
  if (u.kind !== NodeKind.CStyleCastExpr) return false;
  const inner = unwrap(u);
  return !(inner.kind === NodeKind.IntegerLiteral && (inner as unknown as { value: bigint }).value === 0n);
}

/**
 * The function a store of `e` puts in a function pointer: its name, null for a null
 * pointer, undefined for anything else.
 */
function storedFunction(e: Expression): string | null | undefined {
  let u = unwrap(e);
  if (u.kind === NodeKind.IntegerLiteral) return (u as unknown as { value: bigint }).value === 0n ? null : undefined;
  if (u.kind === NodeKind.NullptrLiteral) return null;
  if (u.kind === NodeKind.Identifier && ((u as Identifier).name === 'NULL' || (u as Identifier).name === 'nullptr')) return null;
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '&') u = unwrap((u as UnaryExpr).operand);
  if (u.kind === NodeKind.Identifier || u.kind === NodeKind.QualifiedId) return calleeName(u) ?? undefined;
  return undefined;
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

/** What the body writes, and what it reads, on its own; both carry its calls. */
function analyse(fn: EffectFunction, opts: WriteEffectOptions, regions: Regions | null, stores: PointerStores): { w: Direct; r: Direct } {
  const d: Direct = { ...bottom(), calls: [] };
  const r: Direct = { ...bottom(), calls: d.calls };
  if (!fn.body) { d.unknown = true; r.unknown = true; return { w: d, r }; }
  const locals = new Map<string, Local>();
  fn.params.forEach((p, i) => locals.set(p, { array: false, param: i, trusted: true }));
  for (const n of traverseAST(fn.body)) {
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      const casts = !!v.initializer && convertsByCast(v.initializer as Expression);
      locals.set(v.name.name, { array: v.type?.kind === NodeKind.ArrayType, param: -1, decl: v, trusted: !casts });
    }
  }
  const arrays = opts.globalArrays ?? new Set<string>();
  const isGlobalName = (u: Expression, name: string): boolean => {
    if (u.kind === NodeKind.Identifier && locals.has(name)) return false;
    if (u.kind === NodeKind.Identifier && (/^(in_|unaff_|extraout_)/.test(name)
      || (opts.globalNames && !opts.globalNames.has(name)))) return false;
    return true;
  };
  // A pointer a cast converted into its variable, or whose address is taken, is not
  // trusted to hold what its declared type says.
  for (const n of traverseAST(fn.body)) {
    if (n.kind === NodeKind.AssignExpr) {
      const a = n as AssignExpr;
      const l = unwrap(a.left);
      if (l.kind === NodeKind.Identifier) {
        const local = locals.get((l as Identifier).name);
        if (local && a.operator === '=' && convertsByCast(a.right)) local.trusted = false;
      }
      const name = leafOf(l);
      if (name !== null && isGlobalName(l, name)) {
        const target = a.operator === '=' ? storedFunction(a.right) : undefined;
        if (target === undefined) stores.poisoned.add(name);
        else if (target !== null) {
          let s = stores.stored.get(name);
          if (!s) stores.stored.set(name, s = new Set());
          s.add(target);
        }
      }
    } else if (n.kind === NodeKind.UnaryExpr || n.kind === NodeKind.PostfixExpr) {
      const op = (n as unknown as { operator: string }).operator;
      const operand = (n as unknown as { operand: Expression }).operand;
      if (op !== '&' && op !== '++' && op !== '--') continue;
      for (const m of traverseAST(operand)) {
        if (m.kind !== NodeKind.Identifier && m.kind !== NodeKind.QualifiedId) continue;
        const name = leafOf(m as Expression);
        if (name === null) continue;
        const local = m.kind === NodeKind.Identifier ? locals.get(name) : undefined;
        if (local) { if (op === '&') local.trusted = false; }
        else if (isGlobalName(m as Expression, name)) stores.poisoned.add(name);
        if (op !== '&') break;
      }
    }
  }
  const env: TypingEnv = {
    nameType(e: Expression): TypeShape | null {
      const name = leafOf(e);
      if (name === null) return null;
      const l = e.kind === NodeKind.Identifier ? locals.get(name) : undefined;
      if (l) {
        if (!l.trusted || l.array) return null;
        if (l.param >= 0) {
          const t = fn.paramTypes?.[l.param];
          return t && regions ? shapeOfSpelling(t, regions.resolve) : null;
        }
        return l.decl?.type && regions ? shapeOfNode(l.decl.type, 0, regions.resolve) : null;
      }
      if (!isGlobalName(e, name)) return null;
      const g = opts.globalTypes?.[name];
      return g && regions ? shapeOfSpelling(g, regions.resolve) : null;
    },
  };
  const regionOfAccess = (e: Expression): RegionSet => {
    const at = regions ? regionOf(e, env, regions) : null;
    return at === null ? null : new Set([at]);
  };

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

  /** `p` as the access `at` reaches it. */
  const add = (into: Direct, p: Prov, at: Expression) => {
    if (p.kind === 'global') into.globals.add(p.name);
    else if (p.kind === 'param') addParam(into, p.index, regionOfAccess(at));
    else if (p.kind === 'memory') addMemory(into, regionOfAccess(at));
  };
  const write = (at: Expression) => add(d, root(at), at);
  const read = (p: Prov, at: Expression) => add(r, p, at);
  const callees = new Set<ASTNode>();
  for (const n of traverseAST(fn.body)) {
    if (n.kind === NodeKind.CallExpr) callees.add(unwrap((n as CallExpr).callee));
    // A member's name is not a variable.
    if (n.kind === NodeKind.MemberExpr) callees.add((n as MemberExpr).member);
  }

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
        write((n as AssignExpr).left);
        break;
      case NodeKind.PostfixExpr:
        write((n as unknown as { operand: Expression }).operand);
        break;
      case NodeKind.UnaryExpr: {
        const op = (n as UnaryExpr).operator;
        if (op === '++' || op === '--') write((n as UnaryExpr).operand);
        break;
      }
      case NodeKind.CallExpr: {
        const c = n as CallExpr;
        let callee = unwrap(c.callee);
        // `(*pfn)(..)` calls what `pfn` holds, as `pfn(..)` does.
        const deref = callee.kind === NodeKind.UnaryExpr && (callee as UnaryExpr).operator === '*';
        if (deref) callee = unwrap((callee as UnaryExpr).operand);
        const name = callee.kind === NodeKind.Identifier || callee.kind === NodeKind.QualifiedId ? calleeName(callee) ?? null : null;
        const leaf = name ? bareName(name) : null;
        if (leaf && PSEUDO_OP.test(leaf)) break;
        // A name that is a variable holds a function pointer: an indirect call.
        const variable = !!leaf && callee.kind === NodeKind.Identifier && locals.has(leaf);
        const via = !variable && leaf !== null && isGlobalName(callee, leaf) ? leaf : undefined;
        d.calls.push({ name: variable || deref ? null : name, via, args: c.arguments.map(a => pointee(a as Expression)) });
        break;
      }
      case NodeKind.NewExpr: case NodeKind.DeleteExpr:
        d.unknown = true;
        r.unknown = true;
        break;
      // Reads: a global by name, and memory behind a pointer. A write's target counts as
      // read too, which only ever adds.
      case NodeKind.Identifier: case NodeKind.QualifiedId: {
        if (callees.has(n)) break;
        const name = leafOf(n as Expression);
        if (!name || (n.kind === NodeKind.Identifier && locals.has(name))) break;
        if (n.kind === NodeKind.Identifier && (/^(in_|unaff_|extraout_)/.test(name)
          || (opts.globalNames && !opts.globalNames.has(name)))) break;
        r.globals.add(name);
        break;
      }
      case NodeKind.MemberExpr:
        if ((n as MemberExpr).isArrow) read(pointee((n as MemberExpr).object), n as Expression);
        break;
      case NodeKind.SubscriptExpr: {
        const sub = n as SubscriptExpr;
        const base = unwrap(sub.array);
        const bn = leafOf(base);
        const local = bn !== null && base.kind === NodeKind.Identifier ? locals.get(bn) : undefined;
        if (!(local && local.array) && !(bn !== null && !local && arrays.has(bn))) read(pointee(sub.array), n as Expression);
        break;
      }
    }
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '*') read(pointee((n as UnaryExpr).operand), n as Expression);
    for (const k of getChildren(n)) visit(k);
  };
  visit(fn.body);
  return { w: d, r };
}

function bottom(): Sum {
  return { unknown: false, memory: false, regions: new Set(), globals: new Set(), params: new Set(), paramRegions: new Map() };
}

function fromEffect(w: Omit<WriteEffect, 'reads'>): Sum {
  const s = bottom();
  s.unknown = !!w.unknown;
  if (w.memory) addMemory(s, w.regions ? new Set(w.regions) : null);
  for (const g of w.globals ?? []) s.globals.add(g);
  for (const p of w.params ?? []) {
    const r = w.paramRegions?.[String(p)];
    addParam(s, p, r ? new Set(r) : null);
  }
  return s;
}

function toEffect(s: Sum): Omit<WriteEffect, 'reads'> {
  if (s.unknown) return { unknown: true };
  const out: Omit<WriteEffect, 'reads'> = {};
  if (s.memory) {
    out.memory = true;
    if (s.regions !== null) out.regions = [...s.regions].sort();
  }
  if (s.globals.size) out.globals = [...s.globals].sort();
  if (s.params.size) {
    out.params = [...s.params].sort((a, b) => a - b);
    const typed: Record<string, string[]> = {};
    for (const p of out.params) {
      const r = s.paramRegions.get(p);
      if (r) typed[String(p)] = [...r].sort();
    }
    if (Object.keys(typed).length) out.paramRegions = typed;
  }
  return out;
}

function sameRegions(a: RegionSet | undefined, b: RegionSet | undefined): boolean {
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (a.size !== b.size) return false;
  for (const r of a) if (!b.has(r)) return false;
  return true;
}

function same(a: Sum, b: Sum): boolean {
  if (a.unknown && b.unknown) return true;
  if (a.unknown !== b.unknown || a.memory !== b.memory || a.globals.size !== b.globals.size || a.params.size !== b.params.size) return false;
  if (a.memory && !sameRegions(a.regions, b.regions)) return false;
  for (const g of a.globals) if (!b.globals.has(g)) return false;
  for (const p of a.params) if (!b.params.has(p) || !sameRegions(a.paramRegions.get(p), b.paramRegions.get(p))) return false;
  return true;
}

/** The summaries, keyed by every spelling of every function (joined where spellings collide). */
export function summarizeWriteEffects(fns: readonly EffectFunction[], opts: WriteEffectOptions = {}): Record<string, WriteEffect> {
  const contracts = opts.contracts ?? WRITE_CONTRACTS;
  const regions = opts.aggregates ? new Regions(opts.aggregates) : null;
  const stores: PointerStores = { stored: new Map(), poisoned: new Set() };
  const both = fns.map(f => {
    if (!f.analysis) return analyse(f, opts, regions, stores);
    const a = f.analysis;
    for (const [g, targets] of a.stored) {
      let into = stores.stored.get(g);
      if (!into) stores.stored.set(g, into = new Set());
      for (const t of targets) into.add(t);
    }
    for (const g of a.poisoned) stores.poisoned.add(g);
    const calls = a.calls;
    return { w: { ...sumOf(a.w), calls }, r: { ...sumOf(a.r), calls } };
  });
  const byKey = new Map<string, number[]>();
  fns.forEach((f, i) => {
    for (const k of f.keys) {
      let l = byKey.get(k);
      if (!l) byKey.set(k, l = []);
      l.push(i);
    }
  });
  const isFunction = (name: string) => byKey.has(name) || byKey.has(bareName(name)) || NO_RETURN.has(bareName(name))
    || !!contracts[bareName(name)];
  /** The functions a global function pointer may hold, or null when that is not known. */
  const targetsCache = new Map<string, string[] | null>();
  const targetsOf = (global: string): string[] | null => {
    if (targetsCache.has(global)) return targetsCache.get(global)!;
    let out: string[] | null = null;
    const initial = opts.globalInitialTargets?.[global];
    if (initial && !stores.poisoned.has(global) && !(opts.globalArrays?.has(global))
      && (!opts.globalNames || opts.globalNames.has(global)) && !isFunction(global)) {
      const all = [...new Set([...initial, ...(stores.stored.get(global) ?? [])])];
      out = all.every(isFunction) ? all : null;
    }
    targetsCache.set(global, out);
    return out;
  };
  const writes = settle(both.map(b => b.w), name => {
    const c = contracts[name];
    return c ? fromEffect(c) : null;
  }, opts.onUnknown);
  const reads = settle(both.map(b => b.r), name => {
    const c = contracts[name];
    return c ? (c.reads ? fromEffect(c.reads) : { ...bottom(), unknown: true }) : null;
  });

  const out: Record<string, WriteEffect> = {};
  for (const [k, owners] of byKey) {
    const w = bottom();
    const r = bottom();
    for (const i of owners) { join(w, writes[i]); join(r, reads[i]); }
    out[k] = { ...toEffect(w), reads: toEffect(r) };
  }
  return out;

  /** One summary per function from its own part and its callees', to a fixpoint. */
  function settle(direct: Direct[], contract: (name: string) => Sum | null, onUnknown?: (key: string, why: string) => void): Sum[] {
  let sums = fns.map(() => bottom());

  const named = (name: string, cur: Sum[]): Sum | null => {
    const owners = byKey.get(name) ?? byKey.get(bareName(name));
    if (owners) {
      const s = bottom();
      for (const i of owners) join(s, cur[i]);
      return s;
    }
    if (NO_RETURN.has(bareName(name))) return bottom();
    return contract(bareName(name));
  };

  const calleeSum = (call: CallSite, cur: Sum[]): Sum | null => {
    if (call.name && (isFunction(call.name) || !call.via)) return named(call.name, cur);
    if (call.via && isFunction(call.via)) return named(call.via, cur);
    const targets = call.via ? targetsOf(call.via) : null;
    if (!targets) return null;
    // A call through a null pointer does not return.
    const s = bottom();
    for (const t of targets) {
      const c = named(t, cur);
      if (!c) return null;
      join(s, c);
    }
    return s;
  };

  const step = (i: number, cur: Sum[]): Sum => {
    const d = direct[i];
    const s = bottom();
    join(s, d);
    for (const call of d.calls) {
      if (s.unknown) break;
      const c = calleeSum(call, cur);
      if (!c || c.unknown) {
        s.unknown = true;
        if (onUnknown && (!c || direct[i].unknown)) onUnknown(fns[i].keys[0], call.name ? `calls ${call.name}` : call.via ? `calls through ${call.via}` : 'indirect call');
        break;
      }
      if (c.memory) addMemory(s, c.regions);
      for (const g of c.globals) s.globals.add(g);
      for (const p of c.params) {
        const a = call.args[p];
        const r = c.paramRegions.has(p) ? c.paramRegions.get(p)! : null;
        if (!a || a.kind === 'memory') addMemory(s, r);
        else if (a.kind === 'param') addParam(s, a.index, r);
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

  return sums;
  }
}

function join(into: Sum, s: Sum): void {
  if (s.unknown) into.unknown = true;
  if (s.memory) addMemory(into, s.regions);
  for (const g of s.globals) into.globals.add(g);
  for (const p of s.params) addParam(into, p, s.paramRegions.has(p) ? s.paramRegions.get(p)! : null);
}
