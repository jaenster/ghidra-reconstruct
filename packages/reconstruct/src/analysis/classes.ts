/**
 * Class detection from Ghidra analysis
 *
 * Detects C++ classes from:
 * - Virtual function tables (vtables)
 * - Struct patterns with function pointers
 * - Constructor/destructor patterns
 * - 'this' pointer usage
 */

import type {
  ExtractedFunction,
  ExtractedStruct,
  ExtractedNamespace,
  DetectedClass,
  DetectedMethod,
  StructField,
  GhidraConnection,
} from '../types.js';
import { adoptGhidraLayout } from '../codegen/struct-packing.js';

export interface ClassDetectionResult {
  classes: DetectedClass[];
  stats: {
    vtableClasses: number;
    structClasses: number;
    namespaceClasses: number;
  };
}

/**
 * Detect classes from various sources
 */
export async function detectClasses(
  functions: ExtractedFunction[],
  structs: ExtractedStruct[],
  namespaces: ExtractedNamespace[],
  connection?: GhidraConnection
): Promise<DetectedClass[]> {
  const classes: DetectedClass[] = [];
  const classNames = new Set<string>();

  // Handle potentially undefined inputs
  const safeNamespaces = namespaces || [];
  const safeStructs = structs || [];
  const safeFunctions = functions || [];

  // 1. Detect from namespaces marked as classes
  for (const ns of safeNamespaces.filter(n => n.isClass)) {
    if (classNames.has(ns.name)) continue;
    classNames.add(ns.name);

    const classFunctions = safeFunctions.filter(f => f.namespace === ns.name);
    // Only add functions with a 'this' param as methods — others are free functions in the namespace
    const methodFunctions = classFunctions.filter(f =>
      f.parameters.some(p => p.name === 'this')
    );

    classes.push({
      name: ns.name,
      namespace: ns.parentNamespace || '',
      methods: methodFunctions.map(f => detectMethodType(f, ns.name)),
      fields: [], // Will be populated from struct matching
      baseClasses: [],
    });
  }

  // 2. Detect from struct patterns (if struct has same name as namespace class)
  for (const struct of safeStructs) {
    const existingClass = classes.find(c => c.name === struct.name);
    if (existingClass && struct.fields) {
      adoptGhidraLayout(existingClass, struct);
    }
  }

  // Steps 3 (vtable) and 4 (this-pointer) auto-detection removed.
  // Method-ness is now determined exclusively by structured tags in Ghidra
  // (type: "method", data: "ClassName") applied via batch_tag_symbols.
  // The tag-based detection runs in detectMethodConversionsFromTags().

  return classes;
}

/**
 * Detect classes from vtable patterns
 */
async function detectFromVtables(
  functions: ExtractedFunction[],
  structs: ExtractedStruct[],
  connection?: GhidraConnection
): Promise<DetectedClass[]> {
  const classes: DetectedClass[] = [];

  // Look for structs that look like vtables (array of function pointers)
  for (const struct of structs) {
    if (!isLikelyVtable(struct)) continue;

    // Extract class name from vtable name
    // Common patterns: vtable_ClassName, ClassName_vtable, __vftable_ClassName
    const className = extractClassNameFromVtable(struct.name);
    if (!className) continue;

    const methods: DetectedMethod[] = [];
    const fields = struct.fields || [];

    // Each field in the vtable should be a function pointer
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (!field || !field.dataType || !field.dataType.includes('*')) continue;

      // Try to find the function at this vtable slot
      // This would require additional Ghidra queries
      methods.push({
        name: field.name || `vfunc_${i}`,
        address: '', // Would need to be resolved
        isVirtual: true,
        isStatic: false,
        isConstructor: false,
        isDestructor: field.name?.includes('destructor') || false,
        visibility: 'public',
        vtableIndex: i,
      });
    }

    classes.push({
      name: className,
      namespace: '',
      vtableAddress: struct.category, // Using category as proxy for address
      methods,
      fields: [],
      baseClasses: [],
    });
  }

  return classes;
}

/**
 * Detect classes from 'this' pointer parameter patterns
 */
function detectFromThisPointer(
  functions: ExtractedFunction[],
  structs: ExtractedStruct[]
): DetectedClass[] {
  const classes = new Map<string, DetectedClass>();

  for (const func of functions) {
    // Check if first parameter is 'this' or looks like a struct pointer
    if (func.parameters.length === 0) continue;

    const firstParam = func.parameters[0];
    if (firstParam.name !== 'this' && !firstParam.dataType.endsWith('*')) continue;

    // Extract struct name from parameter type
    const typeName = firstParam.dataType.replace('*', '').trim();

    // Check if there's a matching struct
    const matchingStruct = structs.find(s => s.name === typeName);
    if (!matchingStruct) continue;

    // Add to or create class
    if (!classes.has(typeName)) {
      classes.set(typeName, {
        name: typeName,
        namespace: func.namespace || '',
        methods: [],
        fields: matchingStruct.fields || [],
        baseClasses: [],
      });
    }

    const cls = classes.get(typeName)!;
    cls.methods.push(detectMethodType(func, typeName));
  }

  return Array.from(classes.values());
}

/**
 * Detect method type (constructor, destructor, virtual, etc.)
 */
function detectMethodType(func: ExtractedFunction, className: string): DetectedMethod {
  const name = func.name;

  // Constructor patterns
  const isConstructor =
    name === className ||
    name.startsWith(`${className}::${className}`) ||
    name.includes('constructor') ||
    name.includes('ctor');

  // Destructor patterns
  const isDestructor =
    name === `~${className}` ||
    name.startsWith(`${className}::~${className}`) ||
    name.includes('destructor') ||
    name.includes('dtor');

  // Virtual function detection (heuristic)
  const isVirtual = func.decompiled?.includes('vtable') || false;

  return {
    name: func.name,
    address: func.address,
    isVirtual,
    isStatic: false,
    isConstructor,
    isDestructor,
    visibility: 'public', // Default to public, could refine with analysis
  };
}

/**
 * Check if a struct looks like a vtable
 */
function isLikelyVtable(struct: ExtractedStruct): boolean {
  // Handle structs without fields - must check BEFORE any other check
  if (!struct.fields || !Array.isArray(struct.fields) || struct.fields.length === 0) {
    return false;
  }

  // Vtable naming patterns
  const vtableNames = ['vtable', 'vftable', 'vtbl', 'vft'];
  const nameMatch = vtableNames.some(n => struct.name.toLowerCase().includes(n));

  // Even if name matches, we need fields to process it
  if (nameMatch) {
    return struct.fields.length > 0;
  }

  // Check if all fields are function pointers
  const funcPtrFields = struct.fields.filter(f =>
    f && f.dataType && f.dataType.includes('*') && f.dataType.includes('(')
  );

  // If most fields are function pointers, likely a vtable
  return funcPtrFields.length > 0 && funcPtrFields.length >= struct.fields.length * 0.8;
}

/**
 * Extract class name from vtable name
 */
function extractClassNameFromVtable(vtableName: string): string | null {
  // Common patterns
  const patterns = [
    /vtable_(.+)/i,
    /(.+)_vtable/i,
    /__vftable_(.+)/i,
    /(.+)_vftable/i,
    /vtbl_(.+)/i,
    /(.+)_vtbl/i,
  ];

  for (const pattern of patterns) {
    const match = vtableName.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}
