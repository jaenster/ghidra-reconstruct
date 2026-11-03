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
