/**
 * Per-class virtual function tables.
 *
 * Ghidra names every class's vtable STRUCTURE `vtable` and distinguishes them
 * only by DataTypeManager category: `/ButtonImplementation/vtable`,
 * `/ListBoxImplementation/vtable`, `/IgnoreList/vtable`, … Thirty-five of them
 * share the bare name.
 *
 * C++ has no such per-category scope, so all thirty-five collapsed onto one
 * name and the deduplicator kept a single arbitrary winner. The tree papered
 * over that with `typedef void vtable;`, which makes every `pVtable->Method()`
 * a member access on an incomplete type.
 *
 * Give each one the name of the class that owns it (`<Owner>Vtable`) and point
 * the owning struct's field at it, so the layout Ghidra already holds reaches
 * the tree intact.
 */

import type { ExtractedDataType, ExtractedStruct } from '../types.js';

/** The class a `/X/vtable` belongs to — the last segment of its category. */
function ownerOfCategory(category: string | undefined): string | undefined {
  if (!category) return undefined;
  const segments = category.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  // Template instantiations (`TSHashTable<struct_CELLIST,…>`) and other
  // non-identifier categories cannot name a C++ type; the emitter maps those
  // to `void` anyway.
  return last && /^[A-Za-z_]\w*$/.test(last) ? last : undefined;
}

/** `vtable`, `vtable *`, `vtable * *` → the trailing pointer stars, else undefined. */
function vtableStars(dataType: string | undefined): string | undefined {
  if (!dataType) return undefined;
  const m = dataType.match(/^\s*vtable\s*((?:\*\s*)*)$/);
  return m ? m[1].replace(/\s+/g, '') : undefined;
}

export interface VtableDisambiguation {
  /** owner class name → emitted vtable type name */
  byOwner: Map<string, string>;
  /** vtable member name → emitted vtable type name, only where unambiguous */
  byMember: Map<string, string>;
  /** number of vtable STRUCTUREs given a distinct name */
  renamed: number;
  /** number of struct fields repointed at a named vtable */
  fieldsRepointed: number;
}

/**
 * Rename every `vtable` STRUCTURE after its owning class and repoint the
 * `vtable *` fields that name it. Mutates `dataTypes` in place; must run
 * BEFORE deduplication by name, which would otherwise drop all but one.
 */
export function disambiguateVtableTypes(dataTypes: ExtractedDataType[]): VtableDisambiguation {
  const byOwner = new Map<string, string>();
  const byMember = new Map<string, string>();
  const ambiguousMembers = new Set<string>();
  let renamed = 0;
  let fieldsRepointed = 0;

  const vtables: Array<{ dt: ExtractedDataType; owner: string }> = [];
  for (const dt of dataTypes) {
    if (dt.name !== 'vtable') continue;
    if (dt.kind !== 'STRUCTURE' && dt.kind !== 'UNION') continue;
    const owner = ownerOfCategory(dt.category);
    if (!owner) continue;
    vtables.push({ dt, owner });
  }

  for (const { dt, owner } of vtables) {
    const emitted = `${owner}Vtable`;
    if (byOwner.has(owner)) continue; // one vtable per class
    byOwner.set(owner, emitted);
    dt.name = emitted;
    renamed++;

    for (const field of (dt as ExtractedStruct).fields ?? []) {
      const member = field.name;
      if (!member) continue;
      if (byMember.has(member) && byMember.get(member) !== emitted) {
        ambiguousMembers.add(member);
        continue;
      }
      byMember.set(member, emitted);
    }
  }
  for (const m of ambiguousMembers) byMember.delete(m);

  if (byOwner.size === 0) return { byOwner, byMember, renamed, fieldsRepointed };

  // Repoint the `vtable *` field of each owning struct. The owner is the struct
  // itself (`struct ButtonImplementation` ↔ `/ButtonImplementation/vtable`), or
  // failing that the category the struct sits in.
  for (const dt of dataTypes) {
    if (dt.kind !== 'STRUCTURE' && dt.kind !== 'UNION') continue;
    const fields = (dt as ExtractedStruct).fields;
    if (!fields) continue;
    const owner = byOwner.has(dt.name) ? dt.name : ownerOfCategory(dt.category);
    const emitted = owner ? byOwner.get(owner) : undefined;
    if (!emitted) continue;
    for (const field of fields) {
      const stars = vtableStars(field.dataType);
      if (stars === undefined) continue;
      field.dataType = stars ? `${emitted} ${stars}` : emitted;
      fieldsRepointed++;
    }
  }

  // Ghidra's own pointer entries (`vtable *` in each category) would collide by
  // name too; give them the renamed base so dedup keeps them apart.
  for (const dt of dataTypes) {
    if (dt.kind !== 'POINTER') continue;
    const stars = vtableStars(dt.name);
    if (!stars) continue;
    const owner = ownerOfCategory(dt.category);
    const emitted = owner ? byOwner.get(owner) : undefined;
    if (emitted) dt.name = `${emitted} ${stars.split('').join(' ')}`;
  }

  return { byOwner, byMember, renamed, fieldsRepointed };
}
