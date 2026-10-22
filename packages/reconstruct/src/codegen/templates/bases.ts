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
import { isFiller } from './layout.js';
import type { TemplateFamily, TemplateRegistry } from './registry.js';

/** Ghidra's prefix for a base-class component. */
export const BASE_COMPONENT_PREFIX = 'super_';

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
  const first = fields.find(f => !isFiller(f));
  if (!first?.name?.startsWith(BASE_COMPONENT_PREFIX) || first.offset !== 0) return undefined;
  const family = registry.family(first.name.slice(BASE_COMPONENT_PREFIX.length));
  if (!family) return undefined;
  const id = templateIdOf(parseTypeSpelling(first.dataType));
  if (!id || templateName(id) !== family.name) return undefined;
  return { field: first, family, type: first.dataType.trim() };
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
  members: Iterable<{ name: string; namespace?: string | null }>,
): BaseModel {
  const treeName = (name: string) => registry.instantiation(name)?.spelling ?? name;
  const structs = new Map<string, ExtractedStruct>();
  for (const dt of dataTypes) if (dt.kind === 'STRUCTURE') structs.set(treeName(dt.name), dt as ExtractedStruct);

  // The members a registered class declares beyond its fields: functions and static data.
  const scopeMembers = new Map<string, Set<string>>();
  for (const m of members) {
    const scope = m.namespace ? registry.scopeSpelling(m.namespace) : undefined;
    if (!scope) continue;
    let names = scopeMembers.get(scope);
    if (!names) scopeMembers.set(scope, (names = new Set()));
    names.add(m.name);
  }

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

  const ownNames = (name: string): Set<string> => {
    const st = structs.get(name);
    const names = new Set(scopeMembers.get(name) ?? []);
    for (const f of st ? ownFields(registry, st.fields) : []) if (f.name && !isFiller(f)) names.add(f.name);
    return names;
  };
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
  return {
    componentNames: [...componentNames].sort(),
    bases: [...baseOf.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    hiddenMembers: [...hidden].sort(),
  };
}
