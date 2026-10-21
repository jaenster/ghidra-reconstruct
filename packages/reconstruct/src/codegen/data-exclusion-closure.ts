/**
 * Data exclusion closure
 *
 * The statically-linked MSVC runtime is excluded from the tree by namespace
 * (`compiler`, `CRT`, `_Wrappers`, `std`, ...): its functions get no body unless kept
 * code reaches them (exclusion-closure.ts), and its types are filtered at extraction.
 * Its DATA was never part of that decision. A CRT global carries no namespace - Ghidra
 * files `gaCrtErrTable`, `gaCrtLockTable`, `_pow10pos` and the `__xi_a`/`__xc_a`
 * initializer tables at the root - so every one of them was still emitted, typed with
 * whatever the CRT category had given it. While those types were Ghidra's
 * placeholders that compiled; once Ghidra typed them with the CRT's own records
 * (`CrtErrEntry[45]`, `_PVFV *[3]`, `CRT_LcCategory[6]` holding `&___init_dummy`) the
 * definitions named types and functions the exclusion had removed, and `struct _PVFV;`
 * in globals.h broke all 531 translation units.
 *
 * So the data follows the code, by the same rule: a datum belongs to the excluded
 * runtime when only the excluded runtime uses it, and it is emitted again the moment
 * kept code - or kept data - does. Membership is decided from three records, none of
 * them text matching over emitted code:
 *
 *  - Ghidra's code xrefs (`referencingFunctions`): a datum every one of whose readers
 *    is an excluded function the closure did not keep is runtime data;
 *  - a datum no code reads at all is runtime data when its INITIALIZER points into
 *    the runtime and at no kept function (`gaCrtLocaleCategoryTable`'s `pfnInit`s, the
 *    `Thank_you` vftable holding `CRT_EmptyFunction`);
 *  - and either is revived when a kept function's instruction operands reach into its
 *    extent (`operandRefs`, the folded and derived addresses included), when a kept
 *    body names it (a name only one datum carries - `vftable` names dozens), or when
 *    a kept datum's initializer points at it - to a fixpoint, so a table that survives
 *    keeps what it points at.
 */

import type { DataValue, ExtractedFunction } from '../types.js';

/** The part of a global record the closure needs. */
export interface DataClosureCandidate {
  name: string;
  address: string;
  size?: number;
  namespace?: string | null;
  suggestedName?: string;
  referencingFunctions?: string[];
  initializedData?: DataValue;
}

export interface DataClosureInput<G extends DataClosureCandidate> {
  globals: readonly G[];
  /** The functions that are emitted (after the function exclusion closure). */
  keptFunctions: readonly ExtractedFunction[];
  /** Does this namespace path belong to the excluded runtime? */
  isExcludedNamespace: (namespace: string) => boolean;
}

export interface DataClosureResult<G> {
  excluded: G[];
  kept: G[];
}

/** `compiler::__lock` -> `compiler`; template arguments may hold `::` of their own. */
export function namespaceOfQualified(name: string): string | undefined {
  let depth = 0;
  for (let i = name.length - 1; i > 0; i--) {
    const c = name[i];
    if (c === '>') depth++;
    else if (c === '<') depth--;
    else if (depth === 0 && c === ':' && name[i - 1] === ':') return name.slice(0, i - 1);
  }
  return undefined;
}

function hexValue(address: string): number | undefined {
  const hex = address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
  if (!/^(0x)?[0-9a-fA-F]+$/.test(hex)) return undefined;
  const n = parseInt(hex.replace(/^0x/i, ''), 16);
  return Number.isFinite(n) ? n : undefined;
}

function pointerTargets(value: DataValue | undefined, out: string[]): void {
  if (!value) return;
  if (value.kind === 'pointer' && value.value) out.push(value.value);
  for (const e of value.elements ?? []) pointerTargets(e, out);
  for (const f of value.fields ?? []) pointerTargets(f.value, out);
}

/** Every identifier in a decompiled body - over-approximate on purpose: a name in a comment keeps a datum. */
function identifiersOf(body: string, into: Set<string>): void {
  const re = /[A-Za-z_]\w*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) into.add(m[0]);
}

export function selectDataExclusions<G extends DataClosureCandidate>(input: DataClosureInput<G>): DataClosureResult<G> {
  const { globals, keptFunctions, isExcludedNamespace } = input;

  const keptQualified = new Set<string>();
  const keptAddresses = new Set<number>();
  for (const f of keptFunctions) {
    keptQualified.add(f.namespace ? `${f.namespace}::${f.name}` : f.name);
    const a = hexValue(f.address);
    if (a !== undefined) keptAddresses.add(a);
  }
  /** A function reference (qualified spelling) that only the excluded runtime has. */
  const isExcludedCode = (ref: string): boolean => {
    if (keptQualified.has(ref)) return false;
    const ns = namespaceOfQualified(ref);
    return ns !== undefined && isExcludedNamespace(ns);
  };

  const spellingsOf = (g: G): string[] => {
    const names = [g.name];
    if (g.suggestedName && g.suggestedName !== g.name) names.push(g.suggestedName);
    return names;
  };

  // Seed 1: every code reader is excluded runtime code.
  const candidates = new Set<G>();
  for (const g of globals) {
    const refs = g.referencingFunctions ?? [];
    if (refs.length > 0 && refs.every(isExcludedCode)) candidates.add(g);
  }
  // Seed 2: no code reads it, and its initializer points into the runtime (code, or
  // data seed 1 already placed there) and at no kept function.
  const byName = new Map<string, G[]>();
  for (const g of globals) {
    for (const n of spellingsOf(g)) {
      const list = byName.get(n);
      if (list) list.push(g); else byName.set(n, [g]);
    }
  }
  for (const g of globals) {
    if ((g.referencingFunctions ?? []).length > 0 || candidates.has(g)) continue;
    const targets: string[] = [];
    pointerTargets(g.initializedData, targets);
    let intoRuntime = false;
    let intoKeptCode = false;
    for (const t of targets) {
      if (keptQualified.has(t)) { intoKeptCode = true; break; }
      const a = hexValue(t);
      if (a !== undefined && keptAddresses.has(a)) { intoKeptCode = true; break; }
      if (isExcludedCode(t)) intoRuntime = true;
      else if ((byName.get(t) ?? []).some(x => candidates.has(x))) intoRuntime = true;
    }
    if (intoRuntime && !intoKeptCode) candidates.add(g);
  }
  if (candidates.size === 0) return { excluded: [], kept: [...globals] };

  // Revival 1: a kept function's operands reach into the extent. The extent ends at the
  // next datum's start: Ghidra sizes every label of a run by the run's type, so an alias
  // or an interior label (`gaCRT_MsvcrtHelperData` @0074b500 inside `_pow10neg`) would
  // otherwise claim 348 bytes of its neighbours and be revived by their readers.
  const starts = [...new Set(globals.map(x => hexValue(x.address)).filter((a): a is number => a !== undefined))].sort((a, b) => a - b);
  const nextStart = (a: number): number | undefined => {
    let lo = 0, hi = starts.length - 1, at: number | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] > a) { at = starts[mid]; hi = mid - 1; } else lo = mid + 1;
    }
    return at;
  };
  const extentOf = (start: number, size: number): number => {
    const next = nextStart(start);
    return Math.max(1, next === undefined ? size : Math.min(size, next - start));
  };
  const extents = [...candidates]
    .map(g => { const start = hexValue(g.address); return { g, start, size: start === undefined ? 1 : extentOf(start, Math.max(1, g.size ?? 1)) }; })
    .filter((e): e is { g: G; start: number; size: number } => e.start !== undefined)
    .sort((a, b) => a.start - b.start);
  const widest = extents.reduce((m, e) => Math.max(m, e.size), 1);
  const reviveAt = (addr: string | undefined): void => {
    if (!addr) return;
    const a = hexValue(addr);
    if (a === undefined) return;
    // The last extent starting at or before `a`, then back over every extent that
    // could still cover it (several can share a start).
    let lo = 0, hi = extents.length - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (extents[mid].start <= a) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    for (let i = at; i >= 0 && extents[i].start + widest > a; i--) {
      if (a < extents[i].start + extents[i].size) candidates.delete(extents[i].g);
    }
  };
  // Revival 2: a kept body names it.
  const named = new Set<string>();
  for (const f of keptFunctions) {
    for (const r of f.operandRefs?.refs ?? []) reviveAt(r.to);
    for (const d of f.operandRefs?.derived ?? []) { reviveAt(d.to); reviveAt(d.value); }
    if (f.decompiled) identifiersOf(f.decompiled, named);
  }
  // A name several data share (`vftable` is the name of every class's table) says
  // nothing about WHICH one a body means; those are revived by operands alone.
  for (const g of [...candidates]) {
    if (spellingsOf(g).some(n => named.has(n) && (byName.get(n) ?? []).length === 1)) candidates.delete(g);
  }
  // Revival 3: a kept datum's initializer points at it - to a fixpoint.
  for (let changed = true; changed;) {
    changed = false;
    for (const g of globals) {
      if (candidates.has(g)) continue;
      const targets: string[] = [];
      pointerTargets(g.initializedData, targets);
      for (const t of targets) {
        for (const x of byName.get(t) ?? []) {
          if (candidates.delete(x)) changed = true;
        }
      }
    }
  }

  const excluded: G[] = [];
  const kept: G[] = [];
  for (const g of globals) (candidates.has(g) ? excluded : kept).push(g);
  return { excluded, kept };
}
