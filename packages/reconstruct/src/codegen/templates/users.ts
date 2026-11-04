/**
 * Which translation units use each member of the registered class templates.
 *
 * A template member is a COMDAT: every object that calls it compiles its own
 * copy and the linker keeps one. Storm's map file shows the copy that survived
 * sitting among the functions of the object that used it (STORM.MAP lists a
 * `TSList<T>::UnlinkAll` beside each module that instantiates it), so a member
 * one unit alone uses was linked from that unit's object and is defined there
 * (templates/placement.ts). Defined there, it is also written as the COMDAT it
 * was: an inline function the compiler must not inline, which it then keeps in
 * the same register discipline as the original across the call.
 *
 * The uses are read from Ghidra's decompiled text, which spells every reference
 * to a member fully qualified (`TSList<CMDDEF,TSGetLink<CMDDEF>>::UnlinkAll(...)`,
 * a call or an address), plus each thunk's target and the members a datum holds
 * (a vtable slot). A member is used by the unit of each function that names it;
 * through a member that names it, by that member's users, to a fixpoint.
 */

import type { DataValue, ExtractedFunction } from '../../types.js';
import { normalizeUnitName } from '../namespace.js';
import { classScopedReference } from './index.js';
import type { TemplateRegistry } from './registry.js';

export interface MemberUses {
  /** The member's address -> the addresses of the functions naming it (itself excluded). */
  referrers: ReadonlyMap<string, ReadonlySet<string>>;
  /** Members whose qualified name several functions carry, so no reference can be told apart. */
  ambiguous: ReadonlySet<string>;
  /** Members a datum holds the address of. */
  held: ReadonlySet<string>;
  /** Every member's address. */
  members: ReadonlySet<string>;
  /** The member's address -> the units of its users, through members, to a fixpoint. */
  units: ReadonlyMap<string, ReadonlySet<string>>;
}

function isIdentifierChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_]/.test(c);
}

/** Ghidra's text without its block comments, which can quote a member's name. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * The qualifier written before `::` at `at`, as Ghidra spells it: identifiers,
 * `::` and template argument lists, balanced. Undefined when nothing precedes it.
 */
function qualifierBefore(text: string, at: number): string | undefined {
  let i = at;
  let depth = 0;
  while (i > 0) {
    const c = text[i - 1];
    if (c === '>') { depth++; i--; continue; }
    if (c === '<') {
      if (depth === 0) break;
      depth--; i--; continue;
    }
    if (depth > 0) { i--; continue; }
    if (isIdentifierChar(c)) { i--; continue; }
    if (c === ':' && text[i - 2] === ':') { i -= 2; continue; }
    break;
  }
  const q = text.slice(i, at);
  return q.length > 0 ? q.replace(/^::/, '') : undefined;
}

function heldPointers(value: DataValue | undefined, into: Set<string>): void {
  if (!value) return;
  if (value.kind === 'pointer' && value.value) into.add(value.value);
  for (const e of value.elements ?? []) heldPointers(e, into);
  for (const f of value.fields ?? []) heldPointers(f.value, into);
}

/** Is this function a member of a registered class, or an element's orphan copy. */
export function isTemplateMember(registry: TemplateRegistry, f: { address: string; namespace?: string | null }): boolean {
  return !!f.namespace && (registry.isClassScope(f.namespace) || registry.isOrphan(f.address));
}

export function memberUses(
  registry: TemplateRegistry,
  functions: readonly ExtractedFunction[],
  globals: ReadonlyArray<{ initializedData?: DataValue }>,
): MemberUses {
  const byQualified = new Map<string, string[]>();
  const names = new Set<string>();
  const members = new Set<string>();
  for (const f of functions) {
    if (!isTemplateMember(registry, f)) continue;
    members.add(f.address);
    names.add(f.name);
    const q = `${f.namespace}::${f.name}`;
    const list = byQualified.get(q) ?? [];
    list.push(f.address);
    byQualified.set(q, list);
  }
  const ambiguous = new Set<string>();
  for (const list of byQualified.values()) if (list.length > 1) for (const a of list) ambiguous.add(a);

  // A datum's pointer may be spelled as Ghidra spells the class or as the tree does.
  const bySpelled = new Map<string, string[]>();
  for (const [q, list] of byQualified) {
    const sep = q.lastIndexOf('::');
    const scope = registry.scopeSpelling(q.slice(0, sep));
    if (scope) bySpelled.set(`${scope}::${q.slice(sep + 2)}`, list);
  }
  const held = new Set<string>();
  for (const g of globals) {
    const raw = new Set<string>();
    heldPointers(g.initializedData, raw);
    for (const r of raw) {
      const spelled = classScopedReference(r, registry);
      for (const a of [...(byQualified.get(r) ?? []), ...(spelled ? bySpelled.get(spelled) ?? [] : [])]) held.add(a);
    }
  }

  const referrers = new Map<string, Set<string>>();
  const refer = (target: string, from: string) => {
    if (target === from) return;
    let s = referrers.get(target);
    if (!s) referrers.set(target, (s = new Set()));
    s.add(from);
  };
  for (const g of functions) {
    if (g.isThunk && g.thunkTarget?.address && members.has(g.thunkTarget.address)) refer(g.thunkTarget.address, g.address);
    const text = g.decompiled;
    if (!text || !text.includes('::')) continue;
    const body = withoutComments(text);
    for (let at = body.indexOf('::'); at >= 0; at = body.indexOf('::', at + 2)) {
      let end = at + 2;
      while (isIdentifierChar(body[end])) end++;
      const name = body.slice(at + 2, end);
      if (!names.has(name)) continue;
      if (!isIdentifierChar(body[at - 1]) && body[at - 1] !== '>') continue;
      const qualifier = qualifierBefore(body, at);
      if (!qualifier) continue;
      for (const a of byQualified.get(`${qualifier}::${name}`) ?? []) refer(a, g.address);
    }
  }

  const byAddress = new Map(functions.map(f => [f.address, f]));
  const units = new Map<string, Set<string>>();
  for (const m of members) units.set(m, new Set());
  const ownUnit = (f: ExtractedFunction | undefined, address: string) =>
    f?.namespace ? normalizeUnitName(f.namespace) : `?${address}`;
  for (let changed = true; changed;) {
    changed = false;
    for (const m of members) {
      const set = units.get(m)!;
      const before = set.size;
      for (const r of referrers.get(m) ?? []) {
        if (members.has(r)) for (const u of units.get(r)!) set.add(u);
        else set.add(ownUnit(byAddress.get(r), r));
      }
      if (set.size !== before) changed = true;
    }
  }
  return { referrers, ambiguous, held, members, units };
}

/**
 * The one unit whose own code names a member, when that unit's functions are all
 * that name it: no other member, no datum, no second unit. A member reached through
 * other members stays with them, in the instantiation's unit.
 */
export function soleUserUnit(uses: MemberUses, address: string): string | undefined {
  if (uses.held.has(address) || uses.ambiguous.has(address)) return undefined;
  const refs = uses.referrers.get(address);
  if (!refs || refs.size === 0 || [...refs].some(r => uses.members.has(r))) return undefined;
  const units = uses.units.get(address);
  if (!units || units.size !== 1) return undefined;
  const [unit] = units;
  return unit.startsWith('?') ? undefined : unit;
}

/**
 * The members defined as COMDATs: every function naming one is defined in the
 * member's own unit, no datum holds it, and a function of that unit that is not
 * itself a COMDAT reaches it, so the compiler still emits it. `unitOf` is the
 * final unit of every function.
 */
export function comdatMembers(uses: MemberUses, members: Iterable<string>, unitOf: (address: string) => string | undefined): Set<string> {
  const marked = new Set<string>();
  for (const m of members) {
    if (uses.held.has(m) || uses.ambiguous.has(m)) continue;
    const refs = uses.referrers.get(m);
    const unit = unitOf(m);
    if (!refs || refs.size === 0 || !unit) continue;
    if ([...refs].every(r => unitOf(r) === unit)) marked.add(m);
  }
  // Forward edges, referrer -> member, to walk from the units' non-COMDAT functions.
  const calls = new Map<string, string[]>();
  for (const [m, refs] of uses.referrers) for (const r of refs) {
    const list = calls.get(r) ?? [];
    list.push(m);
    calls.set(r, list);
  }
  for (let changed = true; changed;) {
    changed = false;
    const reached = new Set<string>();
    const stack = [...uses.referrers.values()].flatMap(s => [...s]).filter(r => !marked.has(r));
    for (const r of stack) reached.add(r);
    while (stack.length > 0) {
      const r = stack.pop()!;
      for (const m of calls.get(r) ?? []) {
        if (marked.has(m) && !reached.has(m)) { reached.add(m); stack.push(m); }
      }
    }
    for (const m of [...marked]) if (!reached.has(m)) { marked.delete(m); changed = true; }
  }
  return marked;
}
