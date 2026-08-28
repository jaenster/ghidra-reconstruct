/**
 * Data types that share a bare name across Ghidra categories.
 *
 * Ghidra's DataTypeManager scopes a type by CATEGORY, so two entirely different
 * types may carry the same bare name. C++ has no such scope, and the
 * deduplicator in `reconstruct()` keyed on the bare name alone: the first entry
 * won and every other one was dropped from the model outright — 141 of them in
 * the Ghidra v711 extraction.
 *
 * Where the duplicates are the same type filed twice (34 of the 47 in the Mac
 * extraction) dropping is right. Where they are DIFFERENT types it is a silent
 * loss of a signature, and the struct field that named the loser is left
 * pointing at the winner:
 *
 *     /Diablo2/GFX/D2GfxHelperStrc/fpDrawGroundTile     void (int,int,int,int)
 *     /Diablo2/GFX/D2RenderCallbackStrc/fpDrawGroundTile
 *                       BOOL (D2TileLibraryEntryStrc *, D2GfxLightExStrc *, ...)
 *
 * The second is the renderer's real ground-tile entry point; it never reached
 * the model, so `D2RendererFunctionsStrc.nfpDrawGroundTile` was emitted with the
 * four-int stub's signature. That compiles and is wrong at every call.
 *
 * This pass gives the losers a distinct name and repoints the struct that owns
 * them, the same way `disambiguateVtableTypes` does for `/X/vtable`. It is
 * deliberately ADDITIVE: the first entry keeps the bare name, so every reference
 * that resolves today keeps resolving to exactly what it resolves to now, and
 * the only change is that the previously-dropped types now exist.
 *
 * Must run BEFORE deduplication by name, and AFTER `disambiguateVtableTypes`
 * (which renames the `/X/vtable` collisions on its own, richer evidence).
 */

import type { ExtractedDataType, ExtractedStruct } from '../types.js';

/** The last segment of a category path, exactly as Ghidra spells it. */
function categoryLeaf(category: string | undefined): string | undefined {
  if (!category) return undefined;
  const segments = category.split('/').filter(Boolean);
  return segments[segments.length - 1] || undefined;
}

/**
 * The declared type a field names, with array extents and pointer stars removed.
 * `fpDrawGroundTile *` and `fpDrawGroundTile *[4]` both name `fpDrawGroundTile`.
 */
function baseTypeName(dataType: string | undefined): string {
  return String(dataType ?? '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[\s*]+$/, '')
    .trim();
}

/** The suffix (`*`, `* *`, `*[4]`) that has to survive a repoint. */
function typeSuffix(dataType: string | undefined): string {
  const text = String(dataType ?? '');
  const base = baseTypeName(text);
  return text.startsWith(base) ? text.slice(base.length) : '';
}

/** Everything that distinguishes two entries beyond their name. */
function structuralSignature(dt: ExtractedDataType): string {
  const any = dt as unknown as Record<string, unknown>;
  return JSON.stringify([
    dt.kind,
    any.fields ?? null,
    any.underlyingType ?? null,
    any.returnType ?? null,
    any.parameters ?? null,
    any.values ?? null,
  ]);
}

function flattenName(name: string): string {
  const flat = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^\d/.test(flat) ? `_${flat}` : flat;
}

export interface CategoryDuplicateDisambiguation {
  /** number of shadowed entries given a distinct name */
  renamed: number;
  /** number of struct fields repointed at a renamed entry */
  fieldsRepointed: number;
  /** duplicated names where no owner could be established, so nothing was done */
  unresolved: string[];
}

/**
 * Which struct owns a category, on the evidence of the fields that name its
 * contents.
 *
 * The obvious rule — the struct named after the category's last segment — is
 * right for `/Diablo2/GFX/D2GfxHelperStrc` and wrong for
 * `/Diablo2/GFX/D2RenderCallbackStrc`, whose struct was renamed in Ghidra to
 * `D2RendererFunctionsStrc` while the category kept the old spelling. So the
 * fallback is the struct whose fields actually name that category's types:
 * `D2RendererFunctionsStrc` names 54 of them, the runner-up names 2.
 *
 * The margin requirement is what makes this evidence rather than a guess — a tie
 * or a single shared reference resolves to nothing and the entry is left alone.
 */
function resolveOwner(
  category: string,
  duplicateName: string,
  structs: readonly ExtractedStruct[],
  byName: ReadonlyMap<string, ExtractedDataType>,
  namesInCategory: ReadonlySet<string>
): ExtractedStruct | undefined {
  const leaf = categoryLeaf(category);
  if (leaf) {
    const direct = byName.get(leaf);
    if (direct && (direct.kind === 'STRUCTURE' || direct.kind === 'UNION')) {
      return direct as ExtractedStruct;
    }
  }

  let best: ExtractedStruct | undefined;
  let bestScore = 0;
  let runnerUp = 0;
  for (const s of structs) {
    let score = 0;
    for (const f of s.fields ?? []) {
      if (namesInCategory.has(baseTypeName(f.dataType))) score++;
    }
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = s;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  // Two shared references and a strict margin, or it is not evidence.
  if (!best || bestScore < 2 || bestScore === runnerUp) return undefined;
  // And the owner must actually name the type in question.
  if (!(best.fields ?? []).some(f => baseTypeName(f.dataType) === duplicateName)) return undefined;
  return best;
}

/**
 * Rename every same-named data type that a bare-name dedup would silently drop,
 * and repoint the struct fields that meant it. Mutates `dataTypes` in place.
 */
export function disambiguateCategoryDuplicates(
  dataTypes: ExtractedDataType[]
): CategoryDuplicateDisambiguation {
  const byName = new Map<string, ExtractedDataType>();
  const groups = new Map<string, ExtractedDataType[]>();
  for (const dt of dataTypes) {
    if (!byName.has(dt.name)) byName.set(dt.name, dt);
    const list = groups.get(dt.name);
    if (list) list.push(dt);
    else groups.set(dt.name, [dt]);
  }

  const structs = dataTypes.filter(
    dt => dt.kind === 'STRUCTURE' || dt.kind === 'UNION'
  ) as ExtractedStruct[];

  const namesByCategory = new Map<string, Set<string>>();
  for (const dt of dataTypes) {
    if (dt.kind === 'POINTER') continue; // `X *` entries name no distinct type
    const cat = dt.category ?? '';
    const set = namesByCategory.get(cat);
    if (set) set.add(dt.name);
    else namesByCategory.set(cat, new Set([dt.name]));
  }

  const taken = new Set(dataTypes.map(dt => dt.name));
  const result: CategoryDuplicateDisambiguation = {
    renamed: 0,
    fieldsRepointed: 0,
    unresolved: [],
  };

  for (const [name, entries] of groups) {
    if (entries.length < 2) continue;
    // FUNCTION_DEFINITIONs only, and this restriction is load-bearing.
    //
    // A funcdef name reaches the tree in exactly one way — as the declared type
    // of a field or a variable — so giving one copy a distinct name splits
    // nothing that was ever joined. A STRUCTURE name is spoken all over the
    // tree, and its same-named copies are usually two revisions of ONE layout
    // rather than two types: the Mac extraction's two `D2StatInfoStrc` differ
    // only in a comment and in the name of the third field. Splitting that into
    // two C++ types would put a type mismatch on every assignment between them,
    // which is worse than the drop. ENUMs are merged downstream on purpose (two
    // `eCollisionFlags` are one enum split across categories).
    if (entries.some(e => e.kind !== 'FUNCTION_DEFINITION')) continue;
    // Identical entries are one type filed twice; dropping the copies is right.
    if (new Set(entries.map(structuralSignature)).size === 1) continue;

    // The first entry keeps the bare name: it is the one the dedup keeps today,
    // so nothing that resolves now changes meaning.
    for (const dt of entries.slice(1)) {
      const category = dt.category ?? '';
      const owner = resolveOwner(
        category,
        name,
        structs,
        byName,
        namesByCategory.get(category) ?? new Set()
      );
      if (!owner) {
        result.unresolved.push(`${category}/${name}`);
        continue;
      }

      const renamedTo = `${flattenName(owner.name)}_${flattenName(name)}`;
      if (taken.has(renamedTo)) {
        result.unresolved.push(`${category}/${name} (name ${renamedTo} already taken)`);
        continue;
      }

      dt.name = renamedTo;
      taken.add(renamedTo);
      result.renamed++;

      for (const field of owner.fields ?? []) {
        if (baseTypeName(field.dataType) !== name) continue;
        field.dataType = `${renamedTo}${typeSuffix(field.dataType)}`;
        result.fieldsRepointed++;
      }

      // Ghidra files a `X *` POINTER entry alongside the type in the same
      // category. It collides on the bare name too; carry it along so the pair
      // stays consistent.
      for (const p of dataTypes) {
        if (p.kind !== 'POINTER') continue;
        if ((p.category ?? '') !== category) continue;
        if (baseTypeName(p.name) !== name) continue;
        const suffix = typeSuffix(p.name);
        if (!suffix.trim()) continue;
        p.name = `${renamedTo}${suffix}`;
      }
    }
  }

  return result;
}
