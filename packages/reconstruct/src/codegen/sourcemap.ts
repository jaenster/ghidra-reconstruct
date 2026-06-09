/**
 * Source map generation
 *
 * Generates .map files that map reconstructed source lines back to
 * original binary addresses for debugging purposes.
 */

import type {
  ExtractedFunction,
  SourceMap,
  FunctionMapping,
  LineMapping,
  DecompilerLineMapping,
  CrossPlatformMatch,
} from '../types.js';

/**
 * Generate a source map for a file
 *
 * @param crossPlatformMatches Map of function name → match info for same-named
 *   functions in other binaries (e.g. Mac↔Windows)
 */
export function generateSourceMap(
  filePath: string,
  functions: ExtractedFunction[],
  binaryName?: string,
  crossPlatformMatches?: Map<string, CrossPlatformMatch>
): SourceMap {
  const functionMappings: FunctionMapping[] = [];

  for (const func of functions) {
    if (func.isExternal || func.isThunk) continue;

    const mapping: FunctionMapping = {
      name: func.name,
      address: func.address,
      lines: [],
    };

    // Include namespace
    if (func.namespace) {
      mapping.namespace = func.namespace;
    }

    // If we have decompiled code, try to extract line mappings
    if (func.decompiled) {
      mapping.lines = extractLineMappings(func);
    }

    // Include called functions for cross-reference analysis
    if (func.calledFunctions && func.calledFunctions.length > 0) {
      mapping.calledFunctions = func.calledFunctions;
    }

    // Collect non-primitive types from signature and locals
    const usedTypes = extractUsedTypes(func);
    if (usedTypes.length > 0) {
      mapping.usedTypes = usedTypes;
    }

    // Include platform guard
    if (func.ifdef) {
      mapping.ifdef = func.ifdef;
    }

    // Include cross-platform match
    if (crossPlatformMatches?.has(func.name)) {
      mapping.crossPlatformMatch = crossPlatformMatches.get(func.name);
    }

    functionMappings.push(mapping);
  }

  return {
    version: 2,
    file: filePath,
    binary: binaryName,
    functions: functionMappings,
  };
}

/**
 * Extract line mappings from decompiled code
 *
 * This is a heuristic approach since we don't have actual line mapping
 * data from Ghidra in the current extraction.
 */
function extractLineMappings(func: ExtractedFunction): LineMapping[] {
  const mappings: LineMapping[] = [];

  if (!func.decompiled) return mappings;

  const lines = func.decompiled.split('\n');
  let currentLine = 1;

  // For now, we can only associate the function start with its address
  // More detailed mapping would require the get_line_mappings Java command
  mappings.push({
    line: 1,
    address: func.address,
  });

  return mappings;
}

/** Primitive / built-in types to exclude from usedTypes */
const PRIMITIVE_TYPES = new Set([
  'void', 'bool', 'char', 'uchar', 'short', 'ushort',
  'int', 'uint', 'long', 'ulong', 'longlong', 'ulonglong',
  'float', 'double', 'undefined', 'undefined1', 'undefined2', 'undefined4', 'undefined8',
  'byte', 'ubyte', 'word', 'dword', 'qword',
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'QWORD',
  'CHAR', 'UCHAR', 'SHORT', 'USHORT', 'INT', 'UINT', 'LONG', 'ULONG',
  'FLOAT', 'DOUBLE', 'HANDLE', 'HWND', 'HINSTANCE', 'HMODULE',
  'LPARAM', 'WPARAM', 'LRESULT', 'HRESULT',
  'LPVOID', 'LPCVOID', 'LPSTR', 'LPCSTR', 'LPWSTR', 'LPCWSTR',
  'SIZE_T', 'size_t', 'PVOID',
]);

/**
 * Extract non-primitive type names from a function's signature and locals
 */
function extractUsedTypes(func: ExtractedFunction): string[] {
  const types = new Set<string>();

  const addType = (raw: string) => {
    // Strip pointer/array suffixes to get base type
    const base = raw.replace(/\s*[\*\[\]0-9]+$/g, '').trim();
    if (!base || PRIMITIVE_TYPES.has(base)) return;
    // Skip pure numeric or tiny names
    if (base.length <= 2) return;
    types.add(base);
  };

  // Return type
  addType(func.returnType);

  // Parameters
  for (const param of func.parameters) {
    addType(param.dataType);
  }

  // Local variables
  for (const local of func.localVariables) {
    addType(local.dataType);
  }

  return [...types].sort();
}

/**
 * Merge line mappings from Ghidra decompiler tokens
 */
export function mergeDecompilerMappings(
  sourceMap: SourceMap,
  decompilerMappings: DecompilerLineMapping[]
): SourceMap {
  // Group mappings by function
  const functionMap = new Map<string, DecompilerLineMapping[]>();

  for (const mapping of decompilerMappings) {
    // Find which function this mapping belongs to based on address proximity
    const funcMapping = sourceMap.functions.find(f => {
      // Simple check - mapping address should be >= function start
      return compareAddresses(mapping.address, f.address) >= 0;
    });

    if (funcMapping) {
      if (!functionMap.has(funcMapping.name)) {
        functionMap.set(funcMapping.name, []);
      }
      functionMap.get(funcMapping.name)!.push(mapping);
    }
  }

  // Update source map with detailed line mappings
  for (const funcMapping of sourceMap.functions) {
    const detailedMappings = functionMap.get(funcMapping.name);
    if (detailedMappings) {
      funcMapping.lines = detailedMappings.map(dm => ({
        line: dm.line,
        col: dm.column,
        address: dm.address,
      }));
    }
  }

  return sourceMap;
}

/**
 * Compare two hex addresses
 */
function compareAddresses(a: string, b: string): number {
  const aNum = BigInt(a.startsWith('0x') ? a : '0x' + a);
  const bNum = BigInt(b.startsWith('0x') ? b : '0x' + b);

  if (aNum < bNum) return -1;
  if (aNum > bNum) return 1;
  return 0;
}

/**
 * Format source map as JSON
 */
export function formatSourceMap(sourceMap: SourceMap): string {
  return JSON.stringify(sourceMap, null, 2);
}

/**
 * Parse a source map from JSON
 */
export function parseSourceMap(json: string): SourceMap {
  return JSON.parse(json) as SourceMap;
}

/**
 * Generate inline address comments for source code
 */
export function generateInlineAddressComments(
  code: string,
  lineToAddress: Map<number, string>
): string {
  const lines = code.split('\n');

  return lines
    .map((line, index) => {
      const lineNum = index + 1;
      const address = lineToAddress.get(lineNum);
      if (address && line.trim()) {
        // Add address as end-of-line comment
        const paddedLine = line.padEnd(60);
        return `${paddedLine} // @${address}`;
      }
      return line;
    })
    .join('\n');
}

/**
 * Build a line-to-address map from function mappings
 */
export function buildLineAddressMap(
  sourceMap: SourceMap,
  lineOffset: number = 0
): Map<number, string> {
  const map = new Map<number, string>();

  for (const func of sourceMap.functions) {
    for (const lineMapping of func.lines) {
      map.set(lineMapping.line + lineOffset, lineMapping.address);
    }
  }

  return map;
}
