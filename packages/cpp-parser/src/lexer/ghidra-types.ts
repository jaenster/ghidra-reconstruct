/**
 * Ghidra-specific type names and intrinsics
 *
 * These are non-standard C/C++ patterns that appear in Ghidra decompiler output.
 * They are treated as identifiers (not keywords) but recognized specially.
 */

/**
 * Ghidra undefined types - represent unknown data sizes
 */
export const GHIDRA_UNDEFINED_TYPES = new Set([
  'undefined',   // Unknown - needs context
  'undefined1',  // uint8_t
  'undefined2',  // uint16_t
  'undefined3',  // 3-byte (rare)
  'undefined4',  // uint32_t
  'undefined5',  // 5-byte (rare)
  'undefined6',  // 6-byte (rare)
  'undefined7',  // 7-byte (rare)
  'undefined8',  // uint64_t
]);

/**
 * Ghidra bit-width integer types
 */
export const GHIDRA_INTEGER_TYPES = new Set([
  // Signed integers with odd sizes
  'int3',        // 3-byte integer
  'int4',        // (same as int32_t but Ghidra uses this)
  'int5',        // 5-byte integer
  'int6',        // 6-byte integer
  'int7',        // 7-byte integer

  // Common aliases
  'byte',        // uint8_t
  'sbyte',       // int8_t
  'word',        // uint16_t
  'sword',       // int16_t
  'dword',       // uint32_t
  'sdword',      // int32_t
  'qword',       // uint64_t
  'sqword',      // int64_t

  // Shorthand types
  'uint',        // unsigned int
  'ushort',      // unsigned short
  'ulong',       // unsigned long
  'longlong',    // long long
  'ulonglong',   // unsigned long long
]);

/**
 * Ghidra floating-point types
 */
export const GHIDRA_FLOAT_TYPES = new Set([
  'float10',     // 10-byte extended precision (x87)
  'float2',      // half precision
  'float8',      // double
  'float16',     // quad precision
]);

/**
 * All Ghidra types combined
 */
export const ALL_GHIDRA_TYPES = new Set([
  ...GHIDRA_UNDEFINED_TYPES,
  ...GHIDRA_INTEGER_TYPES,
  ...GHIDRA_FLOAT_TYPES,
]);

/**
 * Check if a name is a Ghidra-specific type
 */
export function isGhidraType(name: string): boolean {
  return ALL_GHIDRA_TYPES.has(name);
}

/**
 * Get the C standard equivalent for a Ghidra type
 */
export function getStandardEquivalent(ghidraType: string): string | null {
  const mapping: Record<string, string> = {
    // Undefined types
    'undefined1': 'uint8_t',
    'undefined2': 'uint16_t',
    'undefined4': 'uint32_t',
    'undefined8': 'uint64_t',

    // Byte types
    'byte': 'uint8_t',
    'sbyte': 'int8_t',
    'word': 'uint16_t',
    'sword': 'int16_t',
    'dword': 'uint32_t',
    'sdword': 'int32_t',
    'qword': 'uint64_t',
    'sqword': 'int64_t',

    // Shorthand
    'uint': 'unsigned int',
    'ushort': 'unsigned short',
    'ulong': 'unsigned long',
    'longlong': 'long long',
    'ulonglong': 'unsigned long long',

    // Floats
    'float10': 'long double',
    'float8': 'double',
    // Ghidra's 2-byte float. No portable 2-byte C++ float exists (`_Float16` is
    // not available on the i686-w64-mingw32 target), and every site that reaches
    // the tree is a value-carrying artifact of a 16-bit return composed through
    // a synthetic upper half - so it is spelled as the 2-byte integer it is
    // standing in for, which compiles and keeps the low 16 bits.
    'float2': 'uint16_t',
  };

  return mapping[ghidraType] || null;
}

// =============================================================================
// GHIDRA INTRINSIC FUNCTIONS
// =============================================================================

/**
 * Concatenation intrinsics - combine values of different sizes
 * CONCAT[source1_bytes][source2_bytes](a, b) -> combined value
 */
export const GHIDRA_CONCAT_INTRINSICS = new Set([
  'CONCAT11',    // 1+1 bytes -> 2 bytes
  'CONCAT12',    // 1+2 bytes -> 3 bytes
  'CONCAT13',    // 1+3 bytes -> 4 bytes
  'CONCAT14',    // 1+4 bytes -> 5 bytes
  'CONCAT21',    // 2+1 bytes -> 3 bytes
  'CONCAT22',    // 2+2 bytes -> 4 bytes
  'CONCAT24',    // 2+4 bytes -> 6 bytes
  'CONCAT31',    // 3+1 bytes -> 4 bytes
  'CONCAT33',    // 3+3 bytes -> 6 bytes
  'CONCAT44',    // 4+4 bytes -> 8 bytes
  'CONCAT48',    // 4+8 bytes -> 12 bytes
  'CONCAT88',    // 8+8 bytes -> 16 bytes
]);

/**
 * Zero-extension intrinsics
 * ZEXT[source][dest](a) -> zero-extended value
 */
export const GHIDRA_ZEXT_INTRINSICS = new Set([
  'ZEXT12',      // 1 byte -> 2 bytes
  'ZEXT14',      // 1 byte -> 4 bytes
  'ZEXT18',      // 1 byte -> 8 bytes
  'ZEXT24',      // 2 bytes -> 4 bytes
  'ZEXT28',      // 2 bytes -> 8 bytes
  'ZEXT48',      // 4 bytes -> 8 bytes
  'ZEXT816',     // 8 bytes -> 16 bytes
]);

/**
 * Sign-extension intrinsics
 * SEXT[source][dest](a) -> sign-extended value
 */
export const GHIDRA_SEXT_INTRINSICS = new Set([
  'SEXT12',      // 1 byte -> 2 bytes
  'SEXT14',      // 1 byte -> 4 bytes
  'SEXT18',      // 1 byte -> 8 bytes
  'SEXT24',      // 2 bytes -> 4 bytes
  'SEXT28',      // 2 bytes -> 8 bytes
  'SEXT48',      // 4 bytes -> 8 bytes
]);

/**
 * Arithmetic and flag intrinsics
 */
export const GHIDRA_ARITHMETIC_INTRINSICS = new Set([
  // Carry flag intrinsics
  'CARRY1',      // Carry from 1-byte addition
  'CARRY2',      // Carry from 2-byte addition
  'CARRY4',      // Carry from 4-byte addition
  'CARRY8',      // Carry from 8-byte addition

  // Signed borrow intrinsics
  'SBORROW1',    // Signed borrow from 1-byte subtraction
  'SBORROW2',    // Signed borrow from 2-byte subtraction
  'SBORROW4',    // Signed borrow from 4-byte subtraction
  'SBORROW8',    // Signed borrow from 8-byte subtraction

  // Subtraction with size conversion
  'SUB21',       // Special subtraction semantics
  'SUB41',       // Special subtraction semantics
  'SUB42',       // Special subtraction semantics
  'SUB81',       // Special subtraction semantics
  'SUB82',       // Special subtraction semantics
  'SUB84',       // Double-precision subtraction

  // Addition with size conversion
  'ADD21',
  'ADD41',
  'ADD42',
  'ADD81',
  'ADD82',
  'ADD84',
]);

/**
 * All Ghidra intrinsics combined
 */
export const ALL_GHIDRA_INTRINSICS = new Set([
  ...GHIDRA_CONCAT_INTRINSICS,
  ...GHIDRA_ZEXT_INTRINSICS,
  ...GHIDRA_SEXT_INTRINSICS,
  ...GHIDRA_ARITHMETIC_INTRINSICS,
]);

/**
 * Check if a name is a Ghidra intrinsic function
 */
export function isGhidraIntrinsic(name: string): boolean {
  return ALL_GHIDRA_INTRINSICS.has(name);
}

// =============================================================================
// GHIDRA CALLING CONVENTIONS
// =============================================================================

/**
 * Microsoft-specific calling conventions used in Ghidra output
 */
export const GHIDRA_CALLING_CONVENTIONS = new Set([
  '__fastcall',
  '__cdecl',
  '__thiscall',
  '__stdcall',
  '__vectorcall',
  '__clrcall',
]);

/**
 * Check if a name is a calling convention
 */
export function isCallingConvention(name: string): boolean {
  return GHIDRA_CALLING_CONVENTIONS.has(name);
}

// =============================================================================
// GHIDRA SPECIAL VARIABLE PATTERNS
// =============================================================================

/**
 * Regex patterns for Ghidra-generated variable names
 */
export const GHIDRA_VARIABLE_PATTERNS = {
  /** Unaffected register values: unaff_EAX, unaff_EDI, etc. */
  unaffected: /^unaff_[A-Z0-9_]+$/,

  /** Extra output registers: extraout_EAX, extraout_ECX_00, etc. */
  extraOutput: /^extraout_[A-Z0-9_]+(?:_\d+)?$/,

  /** Input registers: in_EAX, in_ECX, in_XMM0, etc. */
  inputRegister: /^in_[A-Z0-9_]+$/,

  /** Stack variables: in_stack_XXXXXXXX */
  stackInput: /^in_stack_[0-9a-f]+$/,

  /** XMM subfield access: in_XMM0._0_8_, in_XMM1._4_4_ */
  xmmSubfield: /^in_(XMM|YMM|ZMM)\d+\._\d+_\d+_$/,
};

/**
 * Check if a variable name indicates missing decompiler info
 * These are artifacts that suggest the decompiler couldn't fully analyze the function
 */
export function isDecompilerArtifact(name: string): boolean {
  return (
    GHIDRA_VARIABLE_PATTERNS.unaffected.test(name) ||
    GHIDRA_VARIABLE_PATTERNS.extraOutput.test(name) ||
    GHIDRA_VARIABLE_PATTERNS.inputRegister.test(name) ||
    GHIDRA_VARIABLE_PATTERNS.stackInput.test(name)
  );
}

/**
 * Extract register name from artifact variable
 */
export function extractRegisterFromArtifact(name: string): string | null {
  // unaff_EAX -> EAX
  // extraout_ECX -> ECX
  // in_XMM0 -> XMM0
  const match = name.match(/^(?:unaff|extraout|in)_([A-Z0-9]+)/);
  return match ? match[1] : null;
}

// =============================================================================
// GHIDRA ADDRESS-BASED NAMING
// =============================================================================

/**
 * Regex patterns for Ghidra address-based names
 */
export const GHIDRA_ADDRESS_PATTERNS = {
  /** Functions: FUN_00401000 */
  function: /^FUN_([0-9a-f]{8})$/i,

  /** Labels: LAB_00401050 */
  label: /^LAB_([0-9a-f]{8})$/i,

  /** Data: DAT_00402000 */
  data: /^DAT_([0-9a-f]{8})$/i,

  /** Thunks: thunk_FUN_00401000 */
  thunk: /^thunk_FUN_([0-9a-f]{8})$/i,

  /** Switch tables: switchD_00409255_caseD_0 */
  switchTable: /^switchD_([0-9a-f]+)(?:_caseD_\d+)?$/i,

  /** Switch data: switchdataD_0042b0e0 */
  switchData: /^switchdataD_([0-9a-f]+)$/i,
};

/**
 * Extract address from Ghidra-generated name
 */
export function extractAddressFromName(name: string): string | null {
  for (const pattern of Object.values(GHIDRA_ADDRESS_PATTERNS)) {
    const match = name.match(pattern);
    if (match) {
      return '0x' + match[1];
    }
  }
  return null;
}

// =============================================================================
// GHIDRA STRUCT FIELD PATTERNS
// =============================================================================

/**
 * Struct field with offset pattern: pFile[0x40]._base or local_1044._0_1_
 */
export const STRUCT_FIELD_OFFSET_PATTERN = /^([a-zA-Z_][a-zA-Z0-9_]*)\._(\d+)_(\d+)_$/;

/**
 * Parse a struct field offset access
 * Returns { variable, offset, size } or null
 */
export function parseFieldOffsetAccess(name: string): { variable: string; offset: number; size: number } | null {
  const match = name.match(STRUCT_FIELD_OFFSET_PATTERN);
  if (match) {
    return {
      variable: match[1],
      offset: parseInt(match[2], 10),
      size: parseInt(match[3], 10),
    };
  }
  return null;
}

// =============================================================================
// GHIDRA SPECIAL IDENTIFIERS
// =============================================================================

/**
 * Special identifiers that appear in Ghidra output
 */
export const GHIDRA_SPECIAL_IDENTIFIERS = new Set([
  '__return_storage_ptr__',
  'DEFAULT_SECURITY_COOKIE',
]);

/**
 * Check if an identifier is a Ghidra special identifier
 */
export function isSpecialIdentifier(name: string): boolean {
  return GHIDRA_SPECIAL_IDENTIFIERS.has(name);
}
