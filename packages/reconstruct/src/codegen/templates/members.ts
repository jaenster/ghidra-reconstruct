/**
 * Which members of the registered classes are non-static member functions.
 *
 * Ghidra models a member as `__thiscall` with the receiver as its first
 * parameter, named `this`. Such a member is a non-static member function: its
 * declaration lists no receiver, its body says `this`, and it is called on its
 * object (cpp-parser `member-call`). Two kinds stay static members that take
 * the receiver explicitly:
 *
 * - one whose address the program holds as a plain function pointer - every
 *   vtable slot, until the classes have real virtual functions. A non-static
 *   member's address is a pointer to member, which no `void *` slot holds and
 *   no `Vtable` slot calls;
 * - one with no `this` (`RoundToMultiple`, a `__stdcall` helper).
 *
 * A class template declares its members once, in the primary template, so the
 * choice is made per member NAME of a family and holds for every instantiation.
 * Orphan copies are free functions and no member at all.
 */

import { NodeKind } from '@ghidra-mcp/cpp-parser';
import type { PointerType } from '@ghidra-mcp/cpp-parser';
import type { DataValue, ExtractedFunction } from '../../types.js';
import { parseTypeSpelling, spellType, stripRootQualifiers } from './identity.js';
import { classScopedReference } from './index.js';
import type { TemplateRegistry } from './registry.js';

export interface MemberModel {
  /** The addresses of the non-static members. */
  instanceAddresses: ReadonlySet<string>;
  /** Class spelling → the names of its non-static member functions. */
  instanceMembers: Record<string, string[]>;
}

/** Ghidra's name for the receiver of a `__thiscall` function. */
const RECEIVER = 'this';

/** Every qualified name an initializer holds as a pointer, at any depth. */
function heldPointers(value: DataValue | undefined, into: Set<string>): void {
  if (!value) return;
  if (value.kind === 'pointer' && value.value) into.add(value.value);
  for (const e of value.elements ?? []) heldPointers(e, into);
  for (const f of value.fields ?? []) heldPointers(f.value, into);
}

/** The class a pointer spelling points at, spelled without root qualifiers, or undefined. */
export function pointeeClass(spelling: string): string | undefined {
  const t = parseTypeSpelling(spelling);
  if (t?.kind !== NodeKind.PointerType) return undefined;
  return spellType(stripRootQualifiers((t as PointerType).pointee));
}

/**
 * The run's member model. Stops the run, with the list, where a family's
 * instantiations disagree on whether a member has a receiver, and where a
 * receiver is not a pointer to its own class.
 */
export function memberModel(
  registry: TemplateRegistry,
  functions: readonly ExtractedFunction[],
  globals: ReadonlyArray<{ initializedData?: DataValue }>,
): MemberModel {
  // `Scope::name` of every member a datum holds the address of, in the tree's spelling.
  const held = new Set<string>();
  for (const g of globals) {
    const raw = new Set<string>();
    heldPointers(g.initializedData, raw);
    for (const r of raw) {
      const ref = classScopedReference(r, registry);
      if (ref) held.add(ref);
    }
  }

  interface Group { scopes: Map<string, ExtractedFunction[]>; receivers: Set<boolean>; held: boolean }
  const groups = new Map<string, Group>();
  const problems: string[] = [];
  for (const f of functions) {
    if (!registry.isClassScope(f.namespace) || registry.isOrphan(f.address)) continue;
    const scope = registry.scopeSpelling(f.namespace!)!;
    const inst = registry.instantiation(scope);
    const key = `${inst ? inst.family.name : scope}::${f.name}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { scopes: new Map(), receivers: new Set(), held: false }));
    const receiver = f.parameters?.[0]?.name === RECEIVER;
    if (receiver) {
      const cls = pointeeClass(f.parameters[0].dataType);
      const own = cls !== undefined ? (registry.instantiation(cls)?.spelling ?? cls) : undefined;
      if (own !== scope) problems.push(`${f.address} ${scope}::${f.name}: its receiver is ${f.parameters[0].dataType}, not a pointer to ${scope}`);
    }
    g.receivers.add(receiver);
    if (held.has(`${scope}::${f.name}`)) g.held = true;
    const list = g.scopes.get(scope) ?? [];
    list.push(f);
    g.scopes.set(scope, list);
  }

  const instanceAddresses = new Set<string>();
  const instanceMembers: Record<string, string[]> = {};
  for (const [key, g] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (g.receivers.size > 1) {
      problems.push(`${key}: some instantiations have a receiver and some have none`);
      continue;
    }
    if (!g.receivers.has(true) || g.held) continue;
    for (const [scope, fs] of g.scopes) {
      for (const f of fs) instanceAddresses.add(f.address);
      const names = (instanceMembers[scope] ??= []);
      if (!names.includes(fs[0].name)) names.push(fs[0].name);
    }
  }
  if (problems.length > 0) {
    throw new Error(`[templates] member functions:\n  ${problems.join('\n  ')}`);
  }
  for (const names of Object.values(instanceMembers)) names.sort();
  return { instanceAddresses, instanceMembers };
}
