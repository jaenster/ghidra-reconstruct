/**
 * Ghidra demangles Storm's hash-table templates back to their source spelling,
 * so the database carries type names, struct field names and decompiled bodies
 * full of `TSHashTable<struct_CELLIST,class_HASHKEY_NONE>` and
 * `super_TSHashTable<struct_SGAMEDATA,class_HASHKEY_NONE>`. Those templates were
 * never instantiated in the tree — only their flat instantiations exist — so
 * every angle bracket that reaches the output is a parse error
 * ("expected primary-expression before ',' / '>' token").
 *
 * The declaration side already flattens with `[^A-Za-z0-9_] -> _` (header field
 * names, static-local declarations, `sanitizeSymbolName`); the reference sides
 * did not, and the two drifted. Rather than add a second flattener at each
 * reference site, the WHOLE MODEL is normalized once, here, before any emission:
 * type names, field names, field types, function signatures, parameter and local
 * types, and the decompiled bodies. After this pass no downstream consumer can
 * see an angle bracket, so declaration and reference cannot disagree.
 *
 * The name set is closed and comes from Ghidra itself (every data type or field
 * whose name contains `<`), so ordinary text — a `%s<%d>` format string, a
 * `a < b` comparison — is never touched.
 *
 * An instantiation of a REGISTERED family (codegen/templates) is the exception:
 * the tree defines that template for real, so its spelling is kept and only
 * made the tree's one spelling of it (`TSHashTable<CELLIST, HASHKEY_NONE>`),
 * in every place the flattening reaches. The same holds for the per-class
 * vtable struct the extraction named after it (`TSHashTable_CELLIST_HASHKEY_NONE_Vtable`,
 * Ghidra's `/TSHashTable<CELLIST,HASHKEY_NONE>/vtable`): it is that class's
 * member type `Vtable`, the extraction's `<Owner>Vtable` scoped to the owner.
 */

import type { ExtractedDataType, ExtractedStruct, ExtractedFunction, ExtractedFunctionDefinition } from '../types.js';
import { ownerOfCategory, vtableTypeName } from '../modules/vtable-types.js';
import type { TemplateRegistry } from './templates/registry.js';
import { VTABLE_MEMBER_TYPE } from './templates/layout.js';

/** The one flattening rule, shared with `sanitizeSymbolName`. */
function flattenName(name: string): string {
  const out = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^\d/.test(out) ? `_${out}` : out;
}

/** Ghidra template spellings, longest first so a prefix never wins. */
export function collectTemplateNames(dataTypes: ExtractedDataType[]): string[] {
  const names = new Set<string>();
  const add = (n?: string) => {
    if (!n || !n.includes('<')) return;
    // Strip a pointer/array suffix: the BASE name is what gets replaced, so the
    // `*` survives as syntax rather than becoming part of the identifier.
    const base = n.replace(/\s*[*\[\]\d\s]+$/, '').trim();
    if (base.includes('<') && base.endsWith('>')) names.add(base);
  };
  for (const dt of dataTypes) {
    add(dt.name);
    const s = dt as ExtractedStruct;
    for (const f of s.fields ?? []) {
      add(f.name);
      add(f.dataType);
    }
  }
  return [...names].sort((a, b) => b.length - a.length);
}

/**
 * Replace every name of the closed set, longest first, with its spelling. A key
 * without `<` is an identifier and is only replaced as a whole token.
 */
function replaceAll(text: string, names: string[], spelling: ReadonlyMap<string, string>): string {
  if (!text) return text;
  let out = text;
  for (const n of names) {
    if (!out.includes(n)) continue;
    const to = spelling.get(n) ?? flattenName(n);
    if (n.includes('<')) {
      out = out.split(n).join(to);
    } else {
      out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${n}(?![A-Za-z0-9_])`, 'g'), to);
    }
  }
  return out;
}

/**
 * The spellings of every registered instantiation: Ghidra's and the display
 * form its decompiler prints in a declaration, where a negative argument loses
 * its sign to an underscore (`TSExplicitList<CELLIST,_572662307> *p;`, beside
 * `TSExplicitList<CELLIST,-572662307>::UnlinkAll(...)` in the same body), both
 * respelled as the tree spells the instantiation. Plus each one's vtable struct.
 */
function registeredSpellings(registry: TemplateRegistry, dataTypes: ExtractedDataType[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const inst of registry.instantiations()) {
    for (const ghidra of new Set([inst.ghidra, inst.spelling])) {
      if (ghidra !== inst.spelling) out.set(ghidra, inst.spelling);
      const display = ghidra.split('-').join('_');
      if (display !== ghidra) out.set(display, inst.spelling);
    }
  }
  for (const dt of dataTypes) {
    if (dt.kind !== 'STRUCTURE') continue;
    const owner = ownerOfCategory(dt.category);
    const inst = registry.instantiation(owner);
    if (inst && owner && dt.name === vtableTypeName(owner)) out.set(dt.name, `${inst.spelling}::${VTABLE_MEMBER_TYPE}`);
  }
  return out;
}

/** Flatten every template spelling in the model, in place. */
export function flattenTemplateNames(
  dataTypes: ExtractedDataType[],
  functions: ExtractedFunction[],
  globals: Array<{ name?: string; dataType?: string; suggestedType?: string; suggestedName?: string; namespace?: string | null }>,
  registry?: TemplateRegistry,
): void {
  // Namespaces are spelled from the same instantiations (`TSExplicitList<CELLIST,
  // -572662307>::UnlinkAll`, a Storm template whose instances are a shared struct,
  // so no data type carries the spelling). They join the closed set.
  const all = new Set(collectTemplateNames(dataTypes));
  for (const holder of [...functions, ...globals]) {
    for (const segment of holder.namespace?.split('::') ?? []) {
      if (segment.includes('<') && segment.endsWith('>')) all.add(segment);
    }
  }
  const spelling = registry ? registeredSpellings(registry, dataTypes) : new Map<string, string>();
  for (const n of all) {
    const inst = registry?.instantiation(n);
    if (inst) spelling.set(n, inst.spelling);
  }
  for (const n of spelling.keys()) all.add(n);
  const names = [...all].sort((a, b) => b.length - a.length);
  if (names.length === 0) return;
  const r = (t: string | undefined) => (t === undefined ? t : replaceAll(t, names, spelling));
  // Only the registered spellings, for the places the flattening never reached.
  const registeredNames = names.filter(n => spelling.has(n));
  const respell = (t: string) => replaceAll(t, registeredNames, spelling);

  for (const dt of dataTypes) {
    dt.name = r(dt.name)!;
    if (dt.category) dt.category = r(dt.category);
    const s = dt as ExtractedStruct;
    for (const f of s.fields ?? []) {
      f.name = r(f.name)!;
      f.dataType = r(f.dataType)!;
    }
    if (registeredNames.length > 0 && dt.kind === 'FUNCTION_DEFINITION') {
      const fd = dt as ExtractedFunctionDefinition;
      if (fd.returnType) fd.returnType = respell(fd.returnType);
      for (const p of fd.parameters ?? []) if (p.dataType) p.dataType = respell(p.dataType);
    }
  }

  for (const f of functions) {
    f.name = r(f.name)!;
    if (f.namespace) f.namespace = r(f.namespace);
    if (f.signature) f.signature = r(f.signature)!;
    if (f.returnType) f.returnType = r(f.returnType)!;
    if (f.decompiled) f.decompiled = r(f.decompiled)!;
    for (const p of f.parameters ?? []) p.dataType = r(p.dataType)!;
    for (const v of f.localVariables ?? []) v.dataType = r(v.dataType)!;
  }

  for (const g of globals) {
    if (g.name) g.name = r(g.name);
    if (g.suggestedName) g.suggestedName = r(g.suggestedName);
    if (g.dataType) g.dataType = r(g.dataType);
    if (g.suggestedType) g.suggestedType = r(g.suggestedType);
    if (g.namespace) g.namespace = r(g.namespace);
  }
}
