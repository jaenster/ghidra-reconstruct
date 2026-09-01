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
 */

import type { ExtractedDataType, ExtractedStruct, ExtractedFunction } from '../types.js';

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

function replaceAll(text: string, names: string[]): string {
  if (!text || !text.includes('<')) return text;
  let out = text;
  for (const n of names) {
    if (!out.includes(n)) continue;
    out = out.split(n).join(flattenName(n));
  }
  return out;
}

/** Flatten every template spelling in the model, in place. */
export function flattenTemplateNames(
  dataTypes: ExtractedDataType[],
  functions: ExtractedFunction[],
  globals: Array<{ name?: string; dataType?: string; suggestedType?: string; suggestedName?: string; namespace?: string | null }>,
): void {
  const names = collectTemplateNames(dataTypes);
  if (names.length === 0) return;
  const r = (t: string | undefined) => (t === undefined ? t : replaceAll(t, names));

  for (const dt of dataTypes) {
    dt.name = r(dt.name)!;
    if (dt.category) dt.category = r(dt.category);
    const s = dt as ExtractedStruct;
    for (const f of s.fields ?? []) {
      f.name = r(f.name)!;
      f.dataType = r(f.dataType)!;
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
