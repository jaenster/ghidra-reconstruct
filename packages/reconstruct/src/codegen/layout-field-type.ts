/**
 * A field's type as the layout table records it: Ghidra's string types spelled as the
 * char arrays the header emits (header.ts `normalizeFieldDeclaration`), so a pass that resolves a
 * byte offset sees `szName` as the array it is. `string` is a char array of the field's
 * size, `string {N}` one of N, `string {N} [M]` M rows of N; every other type is kept.
 */
export function layoutFieldType(dataType: string, size: number): string {
  const rows = dataType.match(/^string\s*\{(\d+)\}\s*\[(\d+)\]$/);
  if (rows) return `char[${rows[2]}][${rows[1]}]`;
  const sized = dataType.match(/^string\s*\{(\d+)\}$/);
  if (sized) return `char[${sized[1]}]`;
  if ((dataType === 'string' || dataType === 'TerminatedCString' || dataType === 'string-utf8') && size > 0) {
    return `char[${size}]`;
  }
  return dataType;
}
