/**
 * Type Normalization Plugin
 *
 * Normalizes Ghidra's non-standard type names to modern C++ fixed-width types.
 *
 * Part A - Shorthand renames:
 * - uint -> uint32_t, ulong -> uint32_t, ushort -> uint16_t
 * - longlong -> int64_t, ulonglong -> uint64_t
 * - sbyte -> int8_t, word -> uint16_t, sword -> int16_t
 * - dword -> uint32_t, sdword -> int32_t, qword -> uint64_t, sqword -> int64_t
 *
 * Part B - Undefined types:
 * - undefined4 x = expr; (initialized local) -> auto x = expr;
 * - undefined4 x; (uninitialized local) -> uint32_t x;
 * - undefined4 in params/returns -> uint32_t
 * - undefined/undefined1 -> uint8_t fallback
 * - undefined3/5/6/7 -> kept as-is (odd sizes)
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  TypedefType,
  AutoType,
  Identifier,
  VariableDecl,
  QualifiedId,
} from '../../../ast/nodes.js';
import { createTransformer, sequence, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// MAPS
// ============================================

/** Ghidra shorthand -> C++ fixed-width type */
const SHORTHAND_MAP: ReadonlyMap<string, string> = new Map([
  ['uint', 'uint32_t'],
  ['ulong', 'uint32_t'],      // MSVC 32-bit: long = 32 bits
  ['ushort', 'uint16_t'],
  ['longlong', 'int64_t'],
  ['ulonglong', 'uint64_t'],
  ['sbyte', 'int8_t'],
  ['word', 'uint16_t'],
  ['sword', 'int16_t'],
  ['dword', 'uint32_t'],
  ['sdword', 'int32_t'],
  ['qword', 'uint64_t'],
  ['sqword', 'int64_t'],
]);

/** Windows scalar typedefs -> C++ fixed-width type (32-bit x86) */
const WINDOWS_SCALAR_MAP: ReadonlyMap<string, string> = new Map([
  ['BOOL', 'int32_t'],
  ['BYTE', 'uint8_t'],
  ['WORD', 'uint16_t'],
  ['DWORD', 'uint32_t'],
  ['LONG', 'int32_t'],
  ['ULONG', 'uint32_t'],
  ['USHORT', 'uint16_t'],
  ['SHORT', 'int16_t'],
  ['WCHAR', 'uint16_t'],
  ['CHAR', 'int8_t'],
  ['SIZE_T', 'uint32_t'],     // 32-bit x86
  ['DWORD_PTR', 'uint32_t'],  // 32-bit x86
  ['HRESULT', 'int32_t'],
  // Pointer typedefs — on 32-bit x86 these are all 4-byte pointers.
  // Map to uint32_t since constructing PointerType nodes from here isn't practical.
  ['LPVOID', 'uint32_t'],
  ['LPCVOID', 'uint32_t'],
  ['HANDLE', 'uint32_t'],
  ['HMODULE', 'uint32_t'],
  ['HINSTANCE', 'uint32_t'],
  ['HWND', 'uint32_t'],
  ['LPSTR', 'uint32_t'],
  ['LPCSTR', 'uint32_t'],
  ['LPWSTR', 'uint32_t'],
  ['LPCWSTR', 'uint32_t'],
  ['FARPROC', 'uint32_t'],
  ['LRESULT', 'int32_t'],
  ['WPARAM', 'uint32_t'],
  ['LPARAM', 'int32_t'],
  ['ATOM', 'uint16_t'],
  ['HGLOBAL', 'uint32_t'],
  ['HDC', 'uint32_t'],
  ['HBITMAP', 'uint32_t'],
  ['HFONT', 'uint32_t'],
  ['HBRUSH', 'uint32_t'],
  ['HPEN', 'uint32_t'],
  ['HKEY', 'uint32_t'],
  ['HCURSOR', 'uint32_t'],
  ['HICON', 'uint32_t'],
  ['HMENU', 'uint32_t'],
  ['HPALETTE', 'uint32_t'],
  ['HRGN', 'uint32_t'],
  ['HRSRC', 'uint32_t'],
  ['SOCKET', 'uint32_t'],
  ['CRITICAL_SECTION', 'uint32_t'],
]);

/** Ghidra float artifacts -> standard C types */
const GHIDRA_FLOAT_MAP: ReadonlyMap<string, string> = new Map([
  ['unkfloat1', 'float'],
  ['float10', 'long double'],
]);

/** undefined[N] -> sized fallback (for non-auto contexts) */
const UNDEFINED_FALLBACK_MAP: ReadonlyMap<string, string> = new Map([
  ['undefined', 'uint8_t'],
  ['undefined1', 'uint8_t'],
  ['undefined2', 'uint16_t'],
  ['undefined4', 'uint32_t'],
  ['undefined8', 'uint64_t'],
]);

/** Odd-sized undefined types that we leave alone */
const UNDEFINED_ODD_SIZES = new Set([
  'undefined3', 'undefined5', 'undefined6', 'undefined7',
]);

// ============================================
// HELPERS
// ============================================

/** Get the name string from a TypedefType's name field */
function getTypedefName(node: TypedefType): string {
  if (node.name.kind === NodeKind.Identifier) {
    return (node.name as Identifier).name;
  }
  // QualifiedId - check the last segment
  const qid = node.name as QualifiedId;
  if (qid.name.kind === NodeKind.Identifier) {
    return (qid.name as Identifier).name;
  }
  return '';
}

/** Check if a TypedefType is an undefined type (any size) */
function isUndefinedType(name: string): boolean {
  return UNDEFINED_FALLBACK_MAP.has(name) || UNDEFINED_ODD_SIZES.has(name);
}

/** Create a TypedefType node with a new name */
function createTypedefTypeNode(newName: string, original: ASTNode): TypedefType {
  return {
    kind: NodeKind.TypedefType,
    name: {
      kind: NodeKind.Identifier,
      name: newName,
      location: original.location,
      leadingTrivia: [],
      trailingTrivia: [],
    } as Identifier,
    location: original.location,
    leadingTrivia: original.leadingTrivia || [],
    trailingTrivia: original.trailingTrivia || [],
  };
}

/** Create an AutoType node */
function createAutoTypeNode(original: ASTNode): AutoType {
  return {
    kind: NodeKind.AutoType,
    isDecltypeAuto: false,
    location: original.location,
    leadingTrivia: original.leadingTrivia || [],
    trailingTrivia: original.trailingTrivia || [],
  };
}

// ============================================
// TRANSFORMERS
// ============================================

export interface TypeNormalizeOptions extends PluginOptions {
  /** Normalize shorthand types like uint, ulong, etc. (default: true) */
  normalizeShorthands?: boolean;

  /** Convert undefined types to auto when initialized (default: true) */
  undefinedToAuto?: boolean;

  /** Keep 'byte' as-is instead of converting to uint8_t (default: true) */
  keepByte?: boolean;
}

/**
 * Pass 1: Auto-promotion for initialized undefined locals
 * Visits VariableDecl nodes and replaces undefined types with auto when initialized.
 */
function createAutoPromotionPass(options: TypeNormalizeOptions = {}): Transformer {
  const { undefinedToAuto = true } = options;

  if (!undefinedToAuto) {
    return (node: ASTNode) => node;
  }

  return createTransformer({
    visitVariableDecl(node: VariableDecl): ASTNode | undefined {
      // Only promote if there's an initializer
      if (!node.initializer) {
        return undefined;
      }

      // Check if the type is a TypedefType with an undefined name
      if (node.type.kind !== NodeKind.TypedefType) {
        return undefined;
      }

      const typeName = getTypedefName(node.type as TypedefType);
      if (!UNDEFINED_FALLBACK_MAP.has(typeName)) {
        return undefined;
      }

      // Replace the type with auto
      return updateNode(node, {
        type: createAutoTypeNode(node.type),
      } as Partial<VariableDecl>);
    },
  });
}

/**
 * Pass 2: Rename all remaining Ghidra TypedefType names
 * This catches params, return types, uninitialized locals, etc.
 */
function createTypeRenamePass(options: TypeNormalizeOptions = {}): Transformer {
  const { normalizeShorthands = true, keepByte = true } = options;

  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind !== NodeKind.TypedefType) {
        return undefined;
      }

      const typedefNode = node as TypedefType;
      const typeName = getTypedefName(typedefNode);
      if (!typeName) return undefined;

      // Check shorthand map
      if (normalizeShorthands) {
        // Handle byte specially
        if (typeName === 'byte' && keepByte) {
          return undefined;
        }
        if (typeName === 'byte' && !keepByte) {
          return createTypedefTypeNode('uint8_t', node);
        }

        const shorthandReplacement = SHORTHAND_MAP.get(typeName);
        if (shorthandReplacement) {
          return createTypedefTypeNode(shorthandReplacement, node);
        }
      }

      // Check Windows scalar/pointer typedefs
      const windowsReplacement = WINDOWS_SCALAR_MAP.get(typeName);
      if (windowsReplacement) {
        return createTypedefTypeNode(windowsReplacement, node);
      }

      // Check Ghidra float artifacts
      const floatReplacement = GHIDRA_FLOAT_MAP.get(typeName);
      if (floatReplacement) {
        return createTypedefTypeNode(floatReplacement, node);
      }

      // Check undefined fallback map (for non-auto contexts - params, returns, uninitialized)
      const undefinedReplacement = UNDEFINED_FALLBACK_MAP.get(typeName);
      if (undefinedReplacement) {
        return createTypedefTypeNode(undefinedReplacement, node);
      }

      // Odd-sized undefined types are kept as-is
      return undefined;
    },
  });
}

/**
 * Create the combined type normalization transformer.
 * Uses sequence() to run auto-promotion before type rename.
 */
function createTypeNormalizeTransformer(options: TypeNormalizeOptions = {}): Transformer {
  return sequence(
    createAutoPromotionPass(options),
    createTypeRenamePass(options),
  );
}

// ============================================
// PLUGIN EXPORT
// ============================================

/**
 * Type Normalization Plugin
 *
 * Normalizes Ghidra's non-standard type names (uint, ulong, undefined4, etc.)
 * to modern C++ fixed-width types (uint32_t, int64_t, etc.) and converts
 * undefined types to auto when the variable is initialized.
 */
export const typeNormalizePlugin: TransformPlugin = {
  id: 'type-normalize',
  name: 'Type Normalization',
  description:
    'Normalize Ghidra type names (uint, ulong, undefined4) to C++ fixed-width types (uint32_t, auto)',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 15, // After ghidra-cleanup (10), before concat (20)
  tags: ['core', 'cleanup', 'types'],

  createTransformer(options?: TypeNormalizeOptions) {
    return createTypeNormalizeTransformer(options);
  },
};
