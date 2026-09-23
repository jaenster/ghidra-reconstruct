/**
 * Which secondary binaries feed the tree.
 *
 * An `additionalSources` entry is merged only with `"enabled": true`. Without
 * it the source is left out entirely: it is not preflighted, not extracted and not merged, so the tree carries no
 * source-only functions, globals or types from it and no `| mac: X` anchors.
 *
 * A snapshot records the extraction AFTER the merge, so a codegen-only replay
 * (run.ts --codegen-only, the parallel shards, the live daemon) would otherwise
 * bring a disabled source straight back. `stripDisabledSources` removes every
 * record the merge tagged with that platform, and the anchors it attached.
 *
 * That replay strip is not byte-identical to a fresh run without the source.
 * The merge happens before type dedup and analysis, and neither is re-run on
 * replay: an enum whose values the secondary widened stays widened, a type the
 * category-duplicate pass renamed because of a secondary twin stays renamed,
 * and namespaces the secondary introduced are untagged and stay. A full run is
 * the authoritative output.
 */

import type { ProjectConfig, AdditionalSource } from './config/schema.js';
import type {
  ExtractedFunction,
  ExtractedDataType,
  AnalyzedDataSymbol,
} from './types.js';

export function isSourceEnabled(source: AdditionalSource): boolean {
  return source.enabled === true;
}

export function enabledAdditionalSources(config: ProjectConfig | undefined | null): AdditionalSource[] {
  return (config?.additionalSources ?? []).filter(isSourceEnabled);
}

export function disabledSourcePlatforms(config: ProjectConfig | undefined | null): Set<string> {
  return new Set(
    (config?.additionalSources ?? []).filter(s => !isSourceEnabled(s)).map(s => s.platform)
  );
}

export interface StripResult {
  functions: ExtractedFunction[];
  dataTypes: ExtractedDataType[];
  globals: AnalyzedDataSymbol[];
  removedFunctions: number;
  removedAnchors: number;
  removedDataTypes: number;
  removedGlobals: number;
}

/**
 * Drop everything a disabled source contributed to an already-merged record set.
 * Returns new arrays; a function that keeps its record but loses its anchor is
 * copied rather than mutated, so the caller's snapshot is left as it was read.
 */
export function stripDisabledSources(
  inputs: { functions: ExtractedFunction[]; dataTypes: ExtractedDataType[]; globals: AnalyzedDataSymbol[] },
  disabled: Set<string>
): StripResult {
  if (disabled.size === 0) {
    return {
      ...inputs,
      removedFunctions: 0, removedAnchors: 0, removedDataTypes: 0, removedGlobals: 0,
    };
  }

  let removedAnchors = 0;
  const functions: ExtractedFunction[] = [];
  for (const f of inputs.functions) {
    if (f.platform && disabled.has(f.platform)) continue;
    if (f.crossPlatformAddress && disabled.has(f.crossPlatformAddress.platform)) {
      const { crossPlatformAddress: _dropped, ...rest } = f;
      functions.push(rest as ExtractedFunction);
      removedAnchors++;
      continue;
    }
    functions.push(f);
  }
  const dataTypes = inputs.dataTypes.filter(dt => !(dt.platform && disabled.has(dt.platform)));
  const globals = inputs.globals.filter(g => !(g.platform && disabled.has(g.platform)));

  return {
    functions,
    dataTypes,
    globals,
    removedFunctions: inputs.functions.length - functions.length,
    removedAnchors,
    removedDataTypes: inputs.dataTypes.length - dataTypes.length,
    removedGlobals: inputs.globals.length - globals.length,
  };
}

export function describeStrip(r: StripResult, disabled: Set<string>): string {
  return `Disabled source(s) ${[...disabled].join(', ')} stripped from the snapshot: ` +
    `${r.removedFunctions} functions, ${r.removedAnchors} anchors, ` +
    `${r.removedGlobals} globals, ${r.removedDataTypes} data types`;
}
