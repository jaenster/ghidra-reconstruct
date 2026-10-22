/**
 * Class templates the tree defines for real (project.json `templates`).
 */

import type { TemplatesConfig } from '../../config/schema.js';
import type { AnalyzedDataSymbol, ExtractedDataType, ExtractedFunction, ExtractedString } from '../../types.js';
import { globalDefinition, sanitizeSymbolName, setInitializerNamespace } from '../globals-header.js';
import { collectTemplateNames } from '../template-names.js';
import { namespaceResolution } from '../namespace-resolution.js';
import { TemplateRegistry, templateRegistry } from './registry.js';

/**
 * The run's registry, from the model as Ghidra delivered it: every template
 * spelling a type, a field or a namespace carries. Undefined when the project
 * registers no templates.
 */
export function buildTemplateRegistry(
  config: TemplatesConfig | undefined,
  dataTypes: ExtractedDataType[],
  functions: ExtractedFunction[],
  globals: ReadonlyArray<{ namespace?: string | null }>,
  strings: ReadonlyArray<ExtractedString> | undefined,
): TemplateRegistry | undefined {
  if (!config) return undefined;
  const spellings = new Set(collectTemplateNames(dataTypes));
  for (const holder of [...functions, ...globals]) {
    if (holder.namespace?.includes('<')) spellings.add(holder.namespace);
  }
  const rtti = (strings ?? []).map(s => s.value).filter((v): v is string => typeof v === 'string' && v.startsWith('.?A'));
  return TemplateRegistry.build(config, spellings, rtti);
}

/**
 * How a member of a class the template header defines is named where it is
 * declared or defined outside the class: qualified by the class, and introduced
 * by `template<>` when the class is a template instantiation (an explicit
 * specialization of the member). Undefined for every other function.
 */
export function memberDefinitionScope(func: { address?: string; namespace?: string | null }): { prefix: string; qualifier: string } | undefined {
  const resolved = namespaceResolution().of(func);
  if (!resolved.classScope) return undefined;
  const scope = resolved.segments[0];
  return { prefix: templateRegistry()?.instantiation(scope) ? 'template<> ' : '', qualifier: `${scope}::` };
}

/**
 * The data types the template header defines itself: each instantiation's
 * struct (the header defines the template instead), the class's vtable struct
 * and its slot types, and the key classes.
 */
export function templateHeaderTypes(registry: TemplateRegistry, dataTypes: readonly ExtractedDataType[]): Set<string> {
  const out = new Set<string>(registry.keyClasses);
  for (const dt of dataTypes) {
    if (registry.instantiation(dt.name)) out.add(dt.name);
    const owner = dt.category?.split('/').filter(Boolean).pop();
    if (owner && registry.instantiation(owner) && (dt.kind === 'STRUCTURE' || dt.kind === 'FUNCTION_DEFINITION')) out.add(dt.name);
  }
  return out;
}

/** The registered class scope a symbol is a member of, as the tree spells it. */
export function classScopeOf(symbol: { address?: string; namespace?: string | null }): string | undefined {
  const resolved = namespaceResolution().of(symbol);
  return resolved.classScope ? resolved.segments[0] : undefined;
}

/**
 * The definitions of a class's static data members (`template<> void *
 * TSHashTable<CELLIST, HASHKEY_NONE>::vftable[4] = {...};`), rendered as
 * globals.cpp renders any datum, at root scope.
 */
export function templateDataDefinitions(globals: readonly AnalyzedDataSymbol[]): string {
  const lines = ['// Static data members', ''];
  setInitializerNamespace(undefined);
  for (const g of globals) {
    const scope = classScopeOf(g)!;
    const prefix = templateRegistry()?.instantiation(scope) ? 'template<> ' : '';
    lines.push(`${prefix}${globalDefinition(g, `${scope}::${sanitizeSymbolName(g.suggestedName || g.name)}`)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * A reference Ghidra spells through a registered class (`TSHashTable<CELLIST,HASHKEY_NONE>::InternalDelete`
 * in a vftable's initializer), respelled as the tree spells that class. Undefined
 * for any other reference.
 */
export function classScopedReference(raw: string): string | undefined {
  const registry = templateRegistry();
  if (!registry) return undefined;
  let depth = 0;
  let split = -1;
  for (let i = 0; i < raw.length - 1; i++) {
    const c = raw[i];
    if (c === '<') depth++;
    else if (c === '>') depth--;
    else if (depth === 0 && c === ':' && raw[i + 1] === ':') split = i;
  }
  if (split <= 0) return undefined;
  const scope = registry.scopeSpelling(raw.slice(0, split));
  const name = raw.slice(split + 2);
  return scope && /^[A-Za-z_]\w*$/.test(name) ? `${scope}::${name}` : undefined;
}

/**
 * The marker an orphan copy carries where it is declared and defined: it is
 * counted debt until Ghidra says whose COMDAT it is.
 */
export function orphanMarker(func: { address?: string; namespace?: string | null }): string | undefined {
  const registry = templateRegistry();
  if (!registry?.isOrphan(func.address)) return undefined;
  return `// stpl-orphan: a COMDAT copy in ${registry.scopeSpelling(func.namespace!) ?? func.namespace} that no member owns`;
}
