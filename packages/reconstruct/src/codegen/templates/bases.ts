/**
 * Base classes of the registered classes and of the elements they hold.
 *
 * Ghidra models a base class as the struct's first component, named
 * `super_<Class>` (`TSHashTableReuse<CELLIST,HASHKEY_NONE,0>.super_TSHashTable`,
 * `CELLIST.super_TSHashObject`). Where that class is a registered family, the
 * tree declares a real base instead (`class TSHashTableReuse : public
 * TSHashTable<T, TKey>`, `struct CELLIST : public TSHashObject<CELLIST,
 * HASHKEY_NONE>`), and every access Ghidra spells through the component reads
 * the inherited member directly: `p->super_TSExportTableSimple.tKey` is
 * `p->tKey`. A base at offset 0 is the same object at the same address, so the
 * member access, a pointer to the base and a pointer to the whole object all
 * keep their value.
 *
 * The bodies are rewritten by member NAME (cpp-parser `base-class-access`),
 * which is sound only because every component of that name in the whole model
 * is such a base: `baseModel` checks it and stops the run otherwise.
 */

import type { ExtractedDataType, ExtractedStruct, StructField } from '../../types.js';
import { parseTypeSpelling, templateIdOf, templateName } from './identity.js';
import type { TemplateFamily, TemplateRegistry } from './registry.js';

/** Ghidra's prefix for a base-class component. */
export const BASE_COMPONENT_PREFIX = 'super_';

/** Ghidra's filler byte: an unnamed `undefined` component. The class template has none. */
export function isFiller(f: { name?: string | null; dataType?: string | null }): boolean {
  const t = (f.dataType ?? '').trim();
  return !f.name && /^undefined\d?$/.test(t);
}

/** The fields the base rule reads: Ghidra's components as the snapshot and the model both carry them. */
export interface ComponentLike {
  name?: string | null;
  dataType?: string | null;
  offset?: number | null;
}

/**
 * The base rule over any notion of which classes are bases: the struct's first
 * member, at offset 0, named `super_<Class>` for a class `classNamed` knows, and
 * typed as a template-id of that class. The generator knows the registered
 * families; the defect lint knows the base clauses the tree declares.
 */
export function baseComponentNamed<F extends ComponentLike, C>(
  fields: readonly F[],
  classNamed: (name: string) => C | undefined,
): { field: F; cls: C; type: string } | undefined {
  const first = fields.find(f => !isFiller(f));
  if (!first?.name?.startsWith(BASE_COMPONENT_PREFIX) || first.offset !== 0) return undefined;
  const name = first.name.slice(BASE_COMPONENT_PREFIX.length);
  const cls = classNamed(name);
  if (cls === undefined) return undefined;
  const id = templateIdOf(parseTypeSpelling(first.dataType ?? ''));
  if (!id || templateName(id) !== name) return undefined;
  return { field: first, cls, type: (first.dataType ?? '').trim() };
}

export interface BaseComponent {
  /** The component Ghidra models the base as. */
  field: StructField;
  family: TemplateFamily;
  /** The base class, as the component's type spells it. */
  type: string;
}

/**
 * The struct's base class: its first member, at offset 0, named
 * `super_<Family>` for a registered family and typed as that family's
 * template-id. Undefined for every other struct.
 */
export function baseComponentOf(registry: TemplateRegistry, fields: readonly StructField[]): BaseComponent | undefined {
  const base = baseComponentNamed(fields, name => registry.family(name));
  return base && { field: base.field, family: base.cls, type: base.type };
}

/** The struct's members without its base component. */
export function ownFields(registry: TemplateRegistry, fields: readonly StructField[]): StructField[] {
  const base = baseComponentOf(registry, fields);
  return base ? fields.filter(f => f !== base.field) : [...fields];
}

export interface BaseModel {
  /** Every base component's name (`super_TSHashTable`). */
  componentNames: string[];
  /** Each class with a base, as the tree spells it, and its direct base. */
  bases: Array<[derived: string, base: string]>;
  /**
   * Member names a derived class declares again, so an access through its base
   * component does not mean the same member through the derived class.
   */
  hiddenMembers: string[];
  /** Every name each class of a base chain declares itself (declaredNames), by its spelling. */
  declaredNames: Record<string, string[]>;
}

/**
 * Every name each class declares in its own scope: its fields without the base
 * component, and the functions and static data Ghidra places in its class
 * namespace. A class template's are its family's, as the primary template
 * declares every member any instantiation has. An element class's namespace
 * counts as its scope like a registered class's (`CELLIST::Destructor`): Ghidra
 * says the function is the class's. Orphan copies are no member of anything.
 */
export function declaredNames(
  registry: TemplateRegistry,
  structs: ReadonlyMap<string, ExtractedStruct>,
  members: Iterable<{ name: string; namespace?: string | null; address?: string }>,
): Map<string, Set<string>> {
  const scopeKey = (spelling: string) => {
    const inst = registry.instantiation(spelling);
    return inst ? `family ${inst.family.name}` : spelling;
  };
  const byScope = new Map<string, Set<string>>();
  for (const m of members) {
    if (!m.namespace || registry.isOrphan(m.address)) continue;
    const scope = registry.scopeSpelling(m.namespace) ?? (structs.has(m.namespace) ? m.namespace : undefined);
    if (!scope) continue;
    const key = scopeKey(scope);
    let names = byScope.get(key);
    if (!names) byScope.set(key, (names = new Set()));
    names.add(m.name);
  }
  const out = new Map<string, Set<string>>();
  for (const [name, st] of structs) {
    const names = new Set(byScope.get(scopeKey(name)) ?? []);
    for (const f of ownFields(registry, st.fields)) if (f.name && !isFiller(f)) names.add(f.name);
    out.set(name, names);
  }
  return out;
}

/**
 * Every base relation in the model. Stops the run when a component named like a
 * base is not one (it would be rewritten as one), and when two classes of one
 * chain declare the same data member (an access through the base would read
 * the derived class's).
 */
export function baseModel(
  registry: TemplateRegistry,
  dataTypes: readonly ExtractedDataType[],
  members: Iterable<{ name: string; namespace?: string | null; address?: string }>,
): BaseModel {
  const treeName = (name: string) => registry.instantiation(name)?.spelling ?? name;
  const structs = new Map<string, ExtractedStruct>();
  for (const dt of dataTypes) if (dt.kind === 'STRUCTURE') structs.set(treeName(dt.name), dt as ExtractedStruct);
  const declared = declaredNames(registry, structs, members);

  const problems: string[] = [];
  const baseOf = new Map<string, string>();
  const componentNames = new Set<string>();
  for (const [name, st] of structs) {
    const base = baseComponentOf(registry, st.fields);
    for (const f of st.fields) {
      if (!f.name?.startsWith(BASE_COMPONENT_PREFIX) || !registry.family(f.name.slice(BASE_COMPONENT_PREFIX.length))) continue;
      if (f !== base?.field) {
        problems.push(`${name}.${f.name} (+0x${f.offset.toString(16)}, ${f.dataType}) is named as a base of a registered family but is not the struct's first member at offset 0 of that family's type`);
      }
    }
    if (!base) continue;
    componentNames.add(base.field.name!);
    baseOf.set(name, treeName(base.type));
  }

  const ownNames = (name: string): Set<string> => declared.get(name) ?? new Set();
  const hidden = new Set<string>();
  for (const derived of baseOf.keys()) {
    const own = ownNames(derived);
    const seen = new Set<string>([derived]);
    for (let base = baseOf.get(derived); base && !seen.has(base); base = baseOf.get(base)) {
      seen.add(base);
      for (const name of ownNames(base)) {
        if (!own.has(name)) continue;
        hidden.add(name);
        const st = structs.get(base);
        if (st?.fields.some(f => f.name === name)) problems.push(`${derived} declares ${name}, which hides the data member of its base ${base}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`[templates] base classes:\n  ${problems.join('\n  ')}`);
  }
  const chained: Record<string, string[]> = {};
  for (const name of [...new Set([...baseOf.keys(), ...baseOf.values()])].sort()) {
    chained[name] = [...ownNames(name)].sort();
  }
  return {
    componentNames: [...componentNames].sort(),
    bases: [...baseOf.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    hiddenMembers: [...hidden].sort(),
    declaredNames: chained,
  };
}
