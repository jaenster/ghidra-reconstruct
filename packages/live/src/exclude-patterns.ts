import type { ReconstructionOptions } from '@ghidra-mcp/reconstruct';

/**
 * The namespace exclusions, copied verbatim from `run.ts`.
 *
 * They reach `generateAndWrite` on the codegen-only path too, so they change
 * which functions are emitted. The type re-read (`rereadDataType`) applies them to
 * the same-named enums it merges, as the extraction's exclude filter does. run.ts is
 * the authority; if it gains or loses a pattern and this list does not follow, the
 * live tree and the batch tree stop matching and nothing reports it until a
 * `full_regen` diff is run.
 */
export const EXCLUDE_PATTERNS: RegExp[] = [
  /^compiler(::.*)?$/,
  /^VisualStudio$/,
  /^CRT$/,
  /^_Wrappers$/,
  /^DName(Node|StatusNode)?$/,
  /^pDNameNode$/,
  /^UnDecorator$/,
  /(^|::)Replicator$/,
  /^EXCEPTION$/i,
  /^LDBL12$/,
  /^LDOUBLE$/,
  /^charNode$/,
  /^pcharNode$/,
  /^type_info$/,
  /^localeinfo_struct$/,
  /^threadmbcinfostruct$/,
  /^tm$/,
  /^wchar_t$/,
  /^s$/,
  /^\/usr\//,
  /^usr_lib_libc/,
  /^std(:|$)/,
  /^\/System\//,
  /^MacSpecific$/,
  /^StormMac$/,
];

/**
 * The extraction options every live path runs with: the daemon's model (and so its
 * full re-extraction, `refreshAllFunctions`) and the codegen child. One object, so the
 * escalation path lists, excludes and closes over exactly the function set the batch
 * regen extracted. Without `excludePatterns` the full re-extraction admitted every
 * excluded-namespace function (661 at v2021: `compiler`, `_Wrappers`, `UnDecorator`),
 * none of which the batch extraction keeps unless a kept body reaches it.
 */
export const LIVE_EXTRACTION_OPTIONS: Pick<ReconstructionOptions, 'decompileTimeout' | 'excludeLibraryCode' | 'excludePatterns'> = {
  decompileTimeout: 60,
  excludeLibraryCode: false,
  excludePatterns: EXCLUDE_PATTERNS,
};
