/**
 * Method conversion registry
 *
 * Converts flat C functions with struct-pointer-as-first-param into
 * C++ methods. Maps function addresses to their conversion config and
 * provides lookup indices for both codegen and cpp-parser plugin use.
 */

import type { MethodConversionEntry, ProjectConfig } from '../config/schema.js';
import { normalizeAddress } from '../config/loader.js';
import type { ExtractedFunction, ExtractedParameter, DetectedClass, DetectedMethod } from '../types.js';
import { isMethodTag, isStaticMethodTag, getMethodClassName, getMethodModifier, METHOD_MODIFIERS } from '@ghidra-mcp/shared';

// =============================================================================
// Resolved Conversion
// =============================================================================

export interface ResolvedConversion extends MethodConversionEntry {
  /** Function name before rename (e.g. "DRLG_Init") */
  originalName: string;
  /** Parameter name at thisParam index (e.g. "pDrlg") */
  thisParamName: string;
}

/**
 * Shape consumed by the cpp-parser method-call-rewrite plugin
 */
export interface MethodCallMapping {
  className: string;
  methodName: string;
  thisParam: number;
  originalName: string;
}

// =============================================================================
// Registry
// =============================================================================

export class MethodConversionRegistry {
  private byAddress = new Map<string, ResolvedConversion>();
  private byFunctionName = new Map<string, ResolvedConversion>();
  private entries: MethodConversionEntry[];

  constructor(entries: MethodConversionEntry[]) {
    this.entries = entries;
    for (const entry of entries) {
      // Store unresolved entries with placeholder names — they get
      // populated when indexByName() is called during applyMethodConversions()
      this.byAddress.set(normalizeAddress(entry.address), {
        ...entry,
        address: normalizeAddress(entry.address),
        thisParam: entry.thisParam ?? 0,
        originalName: '',
        thisParamName: '',
      });
    }
  }

  has(address: string): boolean {
    return this.byAddress.has(normalizeAddress(address));
  }

  get(address: string): ResolvedConversion | undefined {
    return this.byAddress.get(normalizeAddress(address));
  }

  getByFunctionName(name: string): ResolvedConversion | undefined {
    return this.byFunctionName.get(name);
  }

  /**
   * Resolve original name and this-param name from the function's actual
   * parameters. Must be called BEFORE renaming the function.
   */
  indexByName(address: string, functionName: string, params: ExtractedParameter[]): void {
    const key = normalizeAddress(address);
    const entry = this.byAddress.get(key);
    if (!entry) return;

    entry.originalName = functionName;
    const thisIdx = entry.thisParam ?? 0;
    entry.thisParamName = params[thisIdx]?.name ?? 'this';

    this.byFunctionName.set(functionName, entry);
  }

  /**
   * Build the mapping object consumed by the cpp-parser plugin
   */
  buildPluginMappings(): Record<string, MethodCallMapping> {
    const mappings: Record<string, MethodCallMapping> = {};
    for (const entry of this.byAddress.values()) {
      if (!entry.originalName) continue;
      mappings[entry.originalName] = {
        className: entry.className,
        methodName: entry.methodName ?? entry.originalName,
        thisParam: entry.thisParam ?? 0,
        originalName: entry.originalName,
      };
    }
    return mappings;
  }

  /**
   * Add entries to the registry, skipping addresses that already exist
   * (explicit entries take priority over auto-detected ones)
   */
  addEntries(entries: MethodConversionEntry[]): void {
    for (const entry of entries) {
      const key = normalizeAddress(entry.address);
      if (this.byAddress.has(key)) continue; // explicit priority
      this.byAddress.set(key, {
        ...entry,
        address: key,
        thisParam: entry.thisParam ?? 0,
        originalName: '',
        thisParamName: '',
      });
    }
  }

  get size(): number {
    return this.byAddress.size;
  }

  values(): IterableIterator<ResolvedConversion> {
    return this.byAddress.values();
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createMethodConversionRegistry(
  config: ProjectConfig | undefined
): MethodConversionRegistry | null {
  if (!config?.methodConversions || config.methodConversions.length === 0) {
    return null;
  }
  return new MethodConversionRegistry(config.methodConversions);
}

/**
 * Get an existing registry or create a new one with the given entries.
 * If `existing` is non-null, adds entries to it (skipping duplicates).
 * If null, creates a new registry from entries.
 */
export function getOrCreateRegistry(
  existing: MethodConversionRegistry | null,
  entries: MethodConversionEntry[]
): MethodConversionRegistry {
  if (existing) {
    existing.addEntries(entries);
    return existing;
  }
  return new MethodConversionRegistry(entries);
}

// =============================================================================
// Auto-detect method conversions from tags
// =============================================================================

/** True when a parameter dataType string is a pointer-to-pointer (`T**`) or
 *  deeper — counts trailing `*` tokens, ignoring whitespace. */
function isDoublePointerType(dataType: string | undefined): boolean {
  if (!dataType) return false;
  const stars = (dataType.match(/\*/g) ?? []).length;
  return stars >= 2;
}

/**
 * Detect method conversions from structured tags on functions.
 * Returns MethodConversionEntry[] that can be added to the registry.
 *
 * Looks for tags with type "method" and extracts class name and modifier
 * from data field (format: "ClassName" or "ClassName,static|ctor|dtor").
 */
export function detectMethodConversionsFromTags(
  functions: ExtractedFunction[]
): MethodConversionEntry[] {
  const entries: MethodConversionEntry[] = [];

  for (const func of functions) {
    if (!func.tags || func.tags.length === 0) continue;

    for (const tag of func.tags) {
      if (!isMethodTag(tag)) continue;

      const className = getMethodClassName(tag);
      if (!className) continue;

      // A real method's receiver is a single pointer (`this` is `T* const`). If
      // the would-be `this` param is a DOUBLE pointer (`T**`), the function is not
      // a method — it operates on a pointer SLOT (e.g. ReturnMonsterRegionEntryForLevel
      // (D2MonsterRegionStrc** ppRegion, ...)). Converting its call sites to
      // `recv->Method(...)` then dereferences one level too few and emits a member
      // access on a pointer ("...which is of pointer type 'T*'"). Leave it a free call.
      const isStatic = isStaticMethodTag(tag);
      if (!isStatic && isDoublePointerType(func.parameters?.[0]?.dataType)) break;

      entries.push({
        address: func.address,
        className,
        methodName: func.name,
        thisParam: isStatic ? -1 : 0,
      });
      break; // Only one method tag per function
    }
  }

  return entries;
}

// =============================================================================
// Apply conversions to extracted functions + classes
// =============================================================================

/**
 * Apply method conversions: populate the registry index, tag functions
 * with parentClass, add them to DetectedClass, and rename them.
 *
 * Must be called BEFORE any code generation.
 */
export function applyMethodConversions(
  functions: ExtractedFunction[],
  classes: DetectedClass[],
  registry: MethodConversionRegistry
): void {
  // Build address → function lookup
  const funcByAddr = new Map<string, ExtractedFunction>();
  for (const func of functions) {
    funcByAddr.set(normalizeAddress(func.address), func);
  }

  // Build className → DetectedClass lookup
  const classByName = new Map<string, DetectedClass>();
  for (const cls of classes) {
    classByName.set(cls.name, cls);
  }

  for (const entry of registry.values()) {
    const func = funcByAddr.get(normalizeAddress(entry.address));
    if (!func) continue;

    // Index BEFORE renaming — captures originalName and thisParamName
    registry.indexByName(entry.address, func.name, func.parameters);

    // Re-read the resolved entry (indexByName mutated it in place)
    const resolved = registry.get(entry.address)!;

    // Tag function as belonging to the class
    func.parentClass = entry.className;

    // Determine method name
    const methodName = entry.methodName ?? func.name;
    resolved.methodName = methodName;

    // Get or create DetectedClass
    let cls = classByName.get(entry.className);
    if (!cls) {
      cls = {
        name: entry.className,
        namespace: func.namespace ?? '',
        methods: [],
        fields: [],
        baseClasses: [],
      };
      classes.push(cls);
      classByName.set(entry.className, cls);
    }

    // Add as a method, or update existing one
    const isStatic = entry.thisParam === -1;
    const existing = cls.methods.find(m => m.address === func.address);
    if (existing) {
      existing.isStatic = isStatic;
      existing.name = methodName;
    } else {
      const method: DetectedMethod = {
        name: methodName,
        address: func.address,
        isVirtual: false,
        isStatic,
        isConstructor: methodName === entry.className,
        isDestructor: methodName === `~${entry.className}`,
        visibility: 'public',
      };
      cls.methods.push(method);
    }

    // Rename the function
    func.name = methodName;
  }
}
