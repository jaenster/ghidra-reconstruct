/**
 * Type ownership scoring — assigns data types to compilation units.
 *
 * Each ExtractedDataType (struct, enum, union, typedef) gets assigned to
 * the header that "owns" its definition, based on scoring heuristics:
 *   +200 stripped name exact match (GraphNodeT → "Graph" matches unit "Util::Graph")
 *   +150 prefix match (≥3 chars)
 *   +100 exact name match (type name == unit name)
 *   +50  class struct match
 *   +1   per reference in function signatures / class fields
 *
 * Then containment, transitive field, explicit override, orphan rescue,
 * struct-colocated globals, single-use co-location, and dedup phases.
 *
 * Extracted from codegen/index.ts — heuristics unchanged.
 */

import type {
  ExtractedDataType,
  ExtractedFunction,
  ExtractedStruct,
  AnalyzedDataSymbol,
  DetectedClass,
} from '../types.js';
import { isPlatformOrBuiltinType } from '../codegen/platform-types.js';

// ── Helpers (relocated from codegen/index.ts) ──────────────────────────

export function stripTypeName(type: string): string {
  return type
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\*/g, '')
    .replace(/&/g, '')
    .replace(/const\s*/g, '')
    .trim();
}

export function extractStructTypeFromGlobal(typeStr: string): string | null {
  const stripped = stripTypeName(typeStr);
  if (!stripped || isPlatformOrBuiltinType(stripped)) return null;
  const primitives = new Set(['int', 'float', 'double', 'char', 'void',
                               'bool', 'short', 'long', 'auto']);
  if (primitives.has(stripped)) return null;
  return /^[A-Z]/.test(stripped) ? stripped : null;
}

export function stripStructAffixes(name: string): string {
  let stripped = name;
  for (const prefix of ['D2Common', 'D2Client', 'D2Game', 'D2']) {
    if (stripped.startsWith(prefix)) {
      stripped = stripped.slice(prefix.length);
      break;
    }
  }
  for (const suffix of ['Strc', 'Tbl', 'Txt']) {
    if (stripped.endsWith(suffix)) {
      stripped = stripped.slice(0, -suffix.length);
      break;
    }
  }
  return stripped;
}

export function countTypeReferences(
  funcs: ExtractedFunction[],
  classInfo: DetectedClass | undefined,
  typeName: string
): number {
  let count = 0;
  for (const func of funcs) {
    for (const param of func.parameters) {
      if (stripTypeName(param.dataType) === typeName) count++;
    }
    if (stripTypeName(func.returnType) === typeName) count++;
  }
  if (classInfo) {
    for (const field of classInfo.fields) {
      if (stripTypeName(field.dataType) === typeName) count++;
    }
  }
  return count;
}

function collectTypesFromBody(body: string, refs: Set<string>): void {
  const castPattern = /\b(?:struct\s+)?([A-Z][A-Za-z0-9_]*(?:Strc|Txt|Tbl)?)\s*\*/g;
  let match: RegExpExecArray | null;
  while ((match = castPattern.exec(body)) !== null) {
    const name = match[1];
    if (name.length > 2 && !/^[A-Z_]+$/.test(name)) {
      refs.add(name);
    }
  }
}

export function collectReferencedTypeNames(
  unitFunctions: ExtractedFunction[],
  classInfo?: DetectedClass
): Set<string> {
  const refs = new Set<string>();
  for (const func of unitFunctions) {
    for (const param of func.parameters) {
      const stripped = stripTypeName(param.dataType);
      if (stripped) refs.add(stripped);
    }
    const ret = stripTypeName(func.returnType);
    if (ret) refs.add(ret);
    if (func.decompiled) {
      collectTypesFromBody(func.decompiled, refs);
    }
  }
  if (classInfo) {
    for (const field of classInfo.fields) {
      const stripped = stripTypeName(field.dataType);
      if (stripped) refs.add(stripped);
    }
  }
  return refs;
}

export function collectReferencedTypeNamesFromTypes(
  types: ExtractedDataType[]
): Set<string> {
  const refs = new Set<string>();
  for (const dt of types) {
    if (dt.kind === 'STRUCTURE' || dt.kind === 'UNION') {
      const structType = dt as ExtractedStruct;
      if (!structType.fields) continue;
      for (const field of structType.fields) {
        const stripped = stripTypeName(field.dataType);
        if (stripped) refs.add(stripped);
      }
    }
    if (dt.kind === 'TYPEDEF') {
      const typedefType = dt as { underlyingType?: string };
      if (!typedefType.underlyingType) continue;
      const stripped = stripTypeName(typedefType.underlyingType);
      if (stripped) refs.add(stripped);
    }
  }
  return refs;
}

export function relocateTypesToSubdirectories(
  typeOwnerMap: Map<string, string>,
  unitHeaderPaths: Map<string, string>
): void {
  const knownDirs = new Map<string, string>();
  for (const filePath of unitHeaderPaths.values()) {
    const parts = filePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/');
      const dirName = parts[i - 1];
      knownDirs.set(dirPath, dirName);
    }
  }

  const pathRelocations = new Map<string, string>();
  for (const [typeName, headerPath] of typeOwnerMap) {
    if (pathRelocations.has(headerPath)) continue;
    const strippedType = stripStructAffixes(typeName);
    if (!strippedType) continue;
    const pathParts = headerPath.split('/');
    const filename = pathParts.pop()!;
    const parentDir = pathParts.join('/');

    let bestDir = '';
    let bestLen = 0;
    for (const [dirPath, dirName] of knownDirs) {
      const dirParent = dirPath.split('/').slice(0, -1).join('/');
      if (dirParent !== parentDir) continue;
      if (strippedType.startsWith(dirName) && dirName.length > bestLen) {
        bestDir = dirPath;
        bestLen = dirName.length;
      }
    }

    if (bestDir && !headerPath.startsWith(bestDir + '/')) {
      pathRelocations.set(headerPath, `${bestDir}/${filename}`);
    }
  }

  for (const [typeName, headerPath] of typeOwnerMap) {
    const newPath = pathRelocations.get(headerPath);
    if (newPath) typeOwnerMap.set(typeName, newPath);
  }

  for (const [unitName, unitPath] of unitHeaderPaths) {
    const newPath = pathRelocations.get(unitPath);
    if (newPath) unitHeaderPaths.set(unitName, newPath);
  }
}

// ── Main scoring function ──────────────────────────────────────────────

export interface TypeOwnershipInput {
  organized: Map<string, ExtractedFunction[]>;
  classes: DetectedClass[];
  dataTypes: ExtractedDataType[];
  globals: AnalyzedDataSymbol[];
  unitHeaderPaths: Map<string, string>;
  typeOwnershipOverrides: Map<string, string>;
  sharedEnumTypes?: Set<string>;
}

export interface TypeOwnershipResult {
  typeOwnerMap: Map<string, string>;
  structsWithOwnUnit: Set<string>;
  extraHeaderTypes: Map<string, Set<string>>;
}

/**
 * Run the full 8-phase type ownership scoring algorithm.
 * Returns the typeOwnerMap (typeName → headerPath) and associated metadata.
 *
 * Also mutates analyzedGlobals to classify struct-colocated globals.
 */
export function computeTypeOwnership(input: TypeOwnershipInput): TypeOwnershipResult {
  const {
    organized,
    classes,
    dataTypes,
    globals,
    unitHeaderPaths,
    typeOwnershipOverrides,
    sharedEnumTypes,
  } = input;

  const typeOwnerMap = new Map<string, string>();
  const declarableKinds = new Set(['STRUCTURE', 'ENUM', 'UNION', 'TYPEDEF']);

  // ── Phase 1: Reference-based scoring ────────────────────────────────
  const typeScores = new Map<string, Map<string, number>>();

  for (const [unitName, unitFunctions] of organized) {
    const classInfo = classes.find(cls => cls.name === unitName);
    const headerPath = unitHeaderPaths.get(unitName)!;
    const relevantTypeNames = collectReferencedTypeNames(unitFunctions, classInfo);

    for (const dt of dataTypes) {
      if (!declarableKinds.has(dt.kind)) continue;
      if (!relevantTypeNames.has(dt.name)) continue;
      if (isPlatformOrBuiltinType(dt.name)) continue;

      if (!typeScores.has(dt.name)) typeScores.set(dt.name, new Map());
      const scores = typeScores.get(dt.name)!;
      let score = scores.get(headerPath) ?? 0;

      const strippedType = stripStructAffixes(dt.name);
      const unitLastSegment = unitName.split('::').pop()!;

      if (strippedType && strippedType === unitLastSegment) score += 200;
      if (strippedType && strippedType !== unitLastSegment
          && unitLastSegment.length >= 3
          && strippedType.startsWith(unitLastSegment)) score += 150;
      if (dt.name === unitName) score += 100;
      if (classInfo && dt.name === classInfo.name) score += 50;

      score += countTypeReferences(unitFunctions, classInfo, dt.name);
      scores.set(headerPath, score);
    }

    if (classInfo) {
      const dtName = classInfo.name;
      if (!typeScores.has(dtName)) typeScores.set(dtName, new Map());
      const scores = typeScores.get(dtName)!;
      let score = scores.get(headerPath) ?? 0;
      score += 50;
      score += countTypeReferences(unitFunctions, classInfo, dtName);
      scores.set(headerPath, score);
    }
  }

  // Score types referenced by globals
  {
    const funcToHeader = new Map<string, string>();
    for (const [unitName, unitFunctions] of organized) {
      const headerPath = unitHeaderPaths.get(unitName)!;
      for (const func of unitFunctions) {
        funcToHeader.set(func.name, headerPath);
      }
    }

    const scorableGlobals = globals.filter(g => 'scope' in g);
    for (const g of scorableGlobals) {
      const typeNames = [g.dataType, g.suggestedType].filter(Boolean) as string[];
      for (const rawType of typeNames) {
        const stripped = stripTypeName(rawType);
        if (!stripped || isPlatformOrBuiltinType(stripped)) continue;

        const dt = dataTypes.find(d => d.name === stripped && declarableKinds.has(d.kind));
        if (!dt) continue;

        if (!typeScores.has(dt.name)) typeScores.set(dt.name, new Map());
        const scores = typeScores.get(dt.name)!;

        for (const [unitName] of organized) {
          const headerPath = unitHeaderPaths.get(unitName)!;
          const strippedType = stripStructAffixes(dt.name);
          const unitLastSegment = unitName.split('::').pop()!;

          if (strippedType && strippedType === unitLastSegment) {
            scores.set(headerPath, (scores.get(headerPath) ?? 0) + 200);
          } else if (strippedType && unitLastSegment.length >= 3 && strippedType.startsWith(unitLastSegment)) {
            scores.set(headerPath, (scores.get(headerPath) ?? 0) + 150);
          }
          if (dt.name === unitName) {
            scores.set(headerPath, (scores.get(headerPath) ?? 0) + 100);
          }
        }

        if (g.referencingFunctions) {
          for (const funcName of g.referencingFunctions) {
            const funcHeader = funcToHeader.get(funcName);
            if (funcHeader) {
              scores.set(funcHeader, (scores.get(funcHeader) ?? 0) + 1);
            }
          }
        }
      }
    }
  }

  // Assign ownership to highest-scoring header
  for (const [typeName, scores] of typeScores) {
    let bestPath = '';
    let bestScore = -1;
    for (const [headerPath, score] of scores) {
      if (score > bestScore) {
        bestScore = score;
        bestPath = headerPath;
      }
    }
    if (bestPath) typeOwnerMap.set(typeName, bestPath);
  }

  // ── Phase 2: Containment heuristic ──────────────────────────────────
  for (const [typeName] of typeOwnerMap) {
    const containerFiles = new Set<string>();
    for (const dt of dataTypes) {
      if (dt.kind !== 'STRUCTURE') continue;
      const struct = dt as ExtractedStruct;
      const usesType = struct.fields.some(f =>
        f.dataType.replace(/[*&]/g, '').trim() === typeName
      );
      if (usesType) {
        const containerOwner = typeOwnerMap.get(dt.name);
        if (containerOwner) containerFiles.add(containerOwner);
      }
    }
    if (containerFiles.size === 1) {
      typeOwnerMap.set(typeName, [...containerFiles][0]);
    }
  }

  // ── Phase 3: Transitive field type scoring ──────────────────────────
  for (const dt of dataTypes) {
    if (dt.kind !== 'STRUCTURE') continue;
    const struct = dt as ExtractedStruct;
    if (!struct.fields) continue;
    const structOwner = typeOwnerMap.get(dt.name);
    if (!structOwner) continue;

    for (const field of struct.fields) {
      const stripped = stripTypeName(field.dataType);
      if (!stripped || typeOwnerMap.has(stripped)) continue;
      if (isPlatformOrBuiltinType(stripped)) continue;
      const fieldDt = dataTypes.find(d => d.name === stripped && declarableKinds.has(d.kind));
      if (fieldDt) typeOwnerMap.set(stripped, structOwner);
    }
  }

  // ── Phase 4: Explicit overrides ─────────────────────────────────────
  for (const [typeName, headerPath] of typeOwnershipOverrides) {
    typeOwnerMap.set(typeName, headerPath);
    if (unitHeaderPaths.has(typeName)) {
      unitHeaderPaths.set(typeName, headerPath);
    }
  }

  relocateTypesToSubdirectories(typeOwnerMap, unitHeaderPaths);

  // ── Phase 5: Orphan rescue ──────────────────────────────────────────
  {
    const unownedTypes = new Set<string>();
    for (const dt of dataTypes) {
      if (!declarableKinds.has(dt.kind)) continue;
      if (isPlatformOrBuiltinType(dt.name)) continue;
      if (typeOwnerMap.has(dt.name)) continue;
      if (sharedEnumTypes?.has(dt.name)) continue;
      unownedTypes.add(dt.name);
    }
    if (unownedTypes.size > 0) {
      for (const typeName of unownedTypes) {
        for (const g of globals) {
          const gType = g.suggestedType || g.dataType;
          const stripped = stripTypeName(gType);
          if (stripped === typeName) {
            if (g.referencingFunctions?.length) {
              const refFunc = g.referencingFunctions[0];
              for (const [unitName, unitFunctions] of organized) {
                if (unitFunctions.some(f => f.name === refFunc)) {
                  typeOwnerMap.set(typeName, unitHeaderPaths.get(unitName)!);
                  break;
                }
              }
            }
            if (typeOwnerMap.has(typeName)) break;
          }
        }
        if (!typeOwnerMap.has(typeName)) {
          const strippedType = stripStructAffixes(typeName);
          if (strippedType) {
            for (const [unitName] of organized) {
              const seg = unitName.split('::').pop()!;
              if (seg.length >= 3 && strippedType.startsWith(seg)) {
                typeOwnerMap.set(typeName, unitHeaderPaths.get(unitName)!);
                break;
              }
            }
          }
        }
        // Outgoing D2GS packet structs (D2GSPacketClt0xNN) are used ONLY as by-value
        // locals in NET_D2GS_CLIENT_Send_* (`D2GSPacketClt0x67 packet;`), so no other
        // strategy places them and the local fails ("'packet' not declared"). Assign
        // each to the unit of a function that declares it as a local. SCOPED to these
        // packet structs deliberately: a broad local-only-orphan rescue regresses
        // (+43) because other orphans' by-value usage surfaces masked field-holes once
        // declared; these wire structs are pure write-targets and emit cleanly (−12).
        if (!typeOwnerMap.has(typeName) && /^D2GSPacketClt0x[0-9A-Fa-f]+$/.test(typeName)) {
          for (const [unitName, unitFunctions] of organized) {
            if (unitFunctions.some(f => (f.localVariables ?? []).some(lv => stripTypeName(lv.dataType) === typeName))) {
              typeOwnerMap.set(typeName, unitHeaderPaths.get(unitName)!);
              break;
            }
          }
        }
      }
    }
  }

  // ── Phase 6: Struct-colocated globals classification ────────────────
  const structTypeToNamespace = new Map<string, string>();
  for (const [unitName] of organized) {
    const headerPath = unitHeaderPaths.get(unitName)!;
    for (const [typeName, ownerPath] of typeOwnerMap) {
      if (ownerPath === headerPath) {
        structTypeToNamespace.set(typeName, unitName);
      }
    }
  }

  for (const global of globals) {
    if (global.scope !== 'global') continue;
    const structTypeName = extractStructTypeFromGlobal(
      global.suggestedType || global.dataType
    );
    if (!structTypeName) continue;
    const isStruct = dataTypes.some(dt =>
      dt.name === structTypeName && (dt.kind === 'STRUCTURE' || dt.kind === 'UNION')
    );
    if (!isStruct) continue;
    const structNs = structTypeToNamespace.get(structTypeName);
    if (global.namespace === structNs) {
      global.scope = 'struct-colocated';
      global.ownerStructType = structTypeName;
      global.ownerStructHeader = typeOwnerMap.get(structTypeName);
    }
  }

  // ── Phase 7: Single-use type co-location ────────────────────────────
  const typeUseCount = new Map<string, Set<string>>();
  for (const dt of dataTypes) {
    if (dt.kind !== 'STRUCTURE' && dt.kind !== 'UNION') continue;
    const struct = dt as ExtractedStruct;
    if (!struct.fields) continue;
    for (const field of struct.fields) {
      const stripped = stripTypeName(field.dataType);
      if (!stripped || isPlatformOrBuiltinType(stripped)) continue;
      const fieldType = dataTypes.find(d => d.name === stripped && declarableKinds.has(d.kind));
      if (!fieldType) continue;
      if (!typeUseCount.has(stripped)) typeUseCount.set(stripped, new Set());
      typeUseCount.get(stripped)!.add(dt.name);
    }
  }

  for (const [typeName, containerStructs] of typeUseCount) {
    if (containerStructs.size !== 1) continue;
    const containerStruct = [...containerStructs][0];
    const containerOwner = typeOwnerMap.get(containerStruct);
    if (!containerOwner) continue;
    const typeIsOwnUnit = organized.has(typeName);
    if (typeIsOwnUnit) continue;
    typeOwnerMap.set(typeName, containerOwner);
  }

  // ── Phase 8: Eliminate duplicate struct definitions ──────────────────
  const structsWithOwnUnit = new Set<string>();
  for (const [unitName, unitFunctions] of organized) {
    const hasMethods = unitFunctions.some(f => f.parentClass === unitName);
    if (hasMethods) structsWithOwnUnit.add(unitName);
  }

  // Collect extra headers not associated with a unit (type-only headers)
  const unitHeaderPathValues = new Set(unitHeaderPaths.values());
  const extraHeaderTypes = new Map<string, Set<string>>();
  for (const [typeName, ownerPath] of typeOwnerMap) {
    if (!unitHeaderPathValues.has(ownerPath)) {
      if (!extraHeaderTypes.has(ownerPath)) {
        extraHeaderTypes.set(ownerPath, new Set());
      }
      extraHeaderTypes.get(ownerPath)!.add(typeName);
    }
  }

  return { typeOwnerMap, structsWithOwnUnit, extraHeaderTypes };
}
