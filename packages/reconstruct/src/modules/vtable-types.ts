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

import type { ExtractedDataType, ExtractedStruct, ExtractedFunction } from '../types.js';

/**
 * The class a `/X/vtable` belongs to — the last segment of its category, exactly
 * as Ghidra spells it. The spelling is kept RAW because it is also the key that
 * matches the owning struct's own `name`, and template flattening has not run at
 * this point.
 */
function ownerOfCategory(category: string | undefined): string | undefined {
  if (!category) return undefined;
  const segments = category.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  return last || undefined;
}

/**
 * The C++ name for a vtable owned by `owner`.
 *
 * A template instantiation category (`TSHashTable<struct_SGAMEDATA,class_HASHKEY_NONE>`)
 * used to be REJECTED here, on the reasoning that it cannot name a C++ type. It
 * can: the tree already carries those classes under the flattened spelling the
 * template pass produces, and their bodies index the vtable by member
 * (`pListHead->FUN_004503f0`). Rejecting them left those vtables sharing the bare
 * name `vtable`, which the deduplicator then collapsed to one — so the members
 * bodies name belonged to no declared type at all.
 *
 * Flattened with the same `[^A-Za-z0-9_] -> _` rule the template pass uses, so
 * `<Owner>Vtable` lines up with the class name the rest of the tree gets.
 */
function vtableTypeName(owner: string): string {
  const flat = owner.replace(/[^A-Za-z0-9_]/g, '_');
  return `${/^\d/.test(flat) ? `_${flat}` : flat}Vtable`;
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
    const emitted = vtableTypeName(owner);
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

/**
 * Point a body's `vtable` references at the vtable it actually indexes.
 *
 * Renaming the STRUCTUREs fixes the `_vfptr` FIELD of each owning class, but a
 * decompiled body also holds the table in its own locals, and Ghidra types those
 * with the bare `vtable *` — which the tree can only render as `void *`:
 *
 *     vtable *pListHead = (vtable *)(pGameDataHashTable + 2);
 *     pListHead->FUN_004503f0 = (FUN_004503f0 *)pListHead;   // member on void*
 *
 * The member names say which vtable it is: `FUN_004503f0` is a slot of exactly
 * one class's table, and `byMember` has already dropped every member name that
 * more than one vtable claims, so a hit is unambiguous by construction.
 *
 * A body is rewritten only when EVERY vtable slot it names belongs to the SAME
 * table — one function touching two classes' tables is left alone, because the
 * one type name would then be wrong somewhere. Nothing is inferred from a
 * variable's name or shape; the evidence is the member the body itself reads.
 *
 * The declaration lives in the body text (Ghidra emits `vtable *pListHead;`
 * inside the function), so the substitution has to be on the body as well as on
 * the variable list, or the two would disagree.
 */
export function retypeVtableLocals(
  functions: ExtractedFunction[],
  byMember: ReadonlyMap<string, string>,
): number {
  if (byMember.size === 0) return 0;
  const BARE_VTABLE = /\bvtable\b/g;
  // `x->M`, `x[i].M`, `x.M` — any member read, whatever the base expression is.
  const MEMBER_READ = /(?:->|\.)\s*([A-Za-z_]\w*)/g;
  let retyped = 0;

  for (const fn of functions) {
    const body = fn.decompiled;
    if (!body) continue;

    const slots = [...(fn.parameters ?? []), ...(fn.localVariables ?? [])]
      .filter(v => vtableStars(v.dataType) !== undefined);
    const bodyNamesVtable = BARE_VTABLE.test(body);
    BARE_VTABLE.lastIndex = 0;
    if (slots.length === 0 && !bodyNamesVtable) continue;

    const implied = new Set<string>();
    for (const m of body.matchAll(MEMBER_READ)) {
      const owner = byMember.get(m[1]);
      if (owner) implied.add(owner);
    }
    if (implied.size !== 1) continue;
    const emitted = [...implied][0];

    for (const v of slots) {
      const stars = vtableStars(v.dataType)!;
      v.dataType = stars ? `${emitted} ${stars}` : emitted;
    }
    if (bodyNamesVtable) fn.decompiled = body.replace(BARE_VTABLE, emitted);
    retyped++;
  }

  return retyped;
}

/**
 * Recover the member → vtable-type map from types that have already been
 * through `disambiguateVtableTypes`.
 *
 * The rename happens upstream of the codegen snapshot, so a `--codegen-only`
 * replay never runs it and cannot be handed its result. A renamed vtable is
 * still identifiable from the model alone — it is the STRUCTURE whose name is
 * exactly `vtableTypeName(<last segment of its own category>)` — so the map can
 * simply be rebuilt here, and both the live path and the replay path get it.
 *
 * Members claimed by more than one vtable are dropped, exactly as they are
 * during the rename: an ambiguous member is no evidence at all.
 */
export function vtableMembersByType(dataTypes: ExtractedDataType[]): Map<string, string> {
  const byMember = new Map<string, string>();
  const ambiguous = new Set<string>();

  for (const dt of dataTypes) {
    if (dt.kind !== 'STRUCTURE' && dt.kind !== 'UNION') continue;
    const owner = ownerOfCategory(dt.category);
    if (!owner || vtableTypeName(owner) !== dt.name) continue;

    for (const field of (dt as ExtractedStruct).fields ?? []) {
      const member = field.name;
      if (!member) continue;
      if (byMember.has(member) && byMember.get(member) !== dt.name) {
        ambiguous.add(member);
        continue;
      }
      byMember.set(member, dt.name);
    }
  }
  for (const m of ambiguous) byMember.delete(m);
  return byMember;
}
