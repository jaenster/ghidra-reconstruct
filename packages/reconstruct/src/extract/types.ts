/**
 * Data type extraction from Ghidra
 */

import type {
  GhidraConnection,
  ExtractedDataType,
  ExtractedStruct,
  ExtractedEnum,
  ExtractedTypedef,
  ExtractedUnion,
  ExtractedFunctionDefinition,
  FunctionDefinitionParam,
  StructField,
  EnumValue,
  DataTypeKind,
} from '../types.js';

/**
 * Options for data type extraction
 */
export interface TypeExtractionOptions {
  /** Filter by name pattern */
  filter?: string;

  /** Filter by category path */
  category?: string;

  /** Maximum number to extract */
  limit?: number;

  /** Offset for pagination */
  offset?: number;
}

interface GhidraDataTypeInfo {
  name: string;
  category: string;
  length: number;
  description?: string;
  /** Java sends this as `type`, not `kind` */
  type: string;
}

interface GhidraDataTypeDetail extends GhidraDataTypeInfo {
  fields?: Array<{
    name: string;
    dataType: string;
    offset: number;
    size: number;
    comment?: string;
  }>;
  values?: Array<{
    name: string;
    value: number;
    comment?: string;
  }>;
  underlyingType?: string;
  alignment?: number;
  packed?: boolean;
  // FunctionDefinition fields
  returnType?: string;
  parameters?: Array<{
    name: string;
    dataType: string;
    ordinal: number;
  }>;
  callingConvention?: string;
  hasVarArgs?: boolean;
}

/**
 * Extract data types with pagination
 */
export async function extractDataTypes(
  connection: GhidraConnection,
  options: TypeExtractionOptions = {}
): Promise<ExtractedDataType[]> {
  const { filter, category, limit = 100, offset = 0 } = options;

  const params: Record<string, unknown> = {
    offset,
    limit,
  };

  if (filter) params.filter = filter;
  if (category) params.category = category;
  params._commandTimeout = 300000; // 5 minutes — large binaries have thousands of types

  const result = await connection.sendCommand<{
    dataTypes: GhidraDataTypeInfo[];
    total: number;
  }>('list_data_types', params);

  return result.dataTypes.map(mapDataTypeInfo);
}

/**
 * Get detailed information about a specific data type
 */
export async function extractDataType(
  connection: GhidraConnection,
  name: string,
  category?: string,
  options: { timeoutMs?: number } = {}
): Promise<ExtractedDataType> {
  const params: Record<string, unknown> = { name };
  if (category) params.category = category;
  // A struct's detail is as big as the struct: `D2GameViewStrc` has 60,023
  // components and answers with ~5 MB. The 30 s default cut that off whenever
  // the daemon was busy, so give a detail the same headroom the listing gets.
  params._commandTimeout = options.timeoutMs ?? 300000;

  const result = await connection.sendCommand<GhidraDataTypeDetail>(
    'get_data_type',
    params
  );
  return mapDataTypeDetail(result);
}

/** The kinds whose listing entry carries no members until a detail fetch lands. */
export const DETAIL_KINDS: ReadonlySet<string> = new Set([
  'STRUCTURE', 'UNION', 'ENUM', 'TYPEDEF', 'FUNCTION_DEFINITION',
]);

export interface TypeDetailHydration {
  /** Types whose detail landed on the first pass. */
  fetched: number;
  /** Types whose first fetch failed and whose retry succeeded. */
  recovered: number;
}

/**
 * Replace every shallow listing entry with its detail, IN PLACE.
 *
 * A detail fetch that fails leaves an entry with no members, and for years that
 * was silent: the entry stayed, `detailUnavailable` had nowhere to be recorded,
 * and codegen emitted an empty body for a 60 KB struct. So every failure is
 * retried once on its own — the failure mode is a loaded daemon, and a lone
 * request after the batches have drained usually lands — and anything still
 * missing stops the extraction by name. A hole here is cheap to fix and
 * ruinous to carry: it is seven minutes into the run, and the alternative is a
 * tree that compiles the hole into a hundred errors an hour later.
 */
export async function hydrateDataTypeDetails(
  connection: GhidraConnection,
  dataTypes: ExtractedDataType[],
  options: { batchSize?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<TypeDetailHydration> {
  const batchSize = options.batchSize ?? 20;

  const index = new Map<string, number>();
  for (let i = 0; i < dataTypes.length; i++) {
    index.set(`${dataTypes[i].name}\u0000${dataTypes[i].category}`, i);
  }

  const pending: number[] = [];
  for (let i = 0; i < dataTypes.length; i++) {
    if (DETAIL_KINDS.has(dataTypes[i].kind)) pending.push(i);
  }

  const apply = (slot: number, detail: ExtractedDataType): void => {
    // The detail may name a different category than the listing did; the slot
    // the listing occupied is the one that has to be replaced either way.
    const at = index.get(`${detail.name}\u0000${detail.category}`) ?? slot;
    dataTypes[at] = detail;
  };

  const failures: { slot: number; error: Error }[] = [];
  let fetched = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async slot => {
        const t = dataTypes[slot];
        try {
          return { slot, detail: await extractDataType(connection, t.name, t.category) };
        } catch (e) {
          return { slot, error: e as Error };
        }
      })
    );
    for (const r of results) {
      if ('detail' in r && r.detail) { apply(r.slot, r.detail); fetched++; }
      else if ('error' in r && r.error) failures.push({ slot: r.slot, error: r.error });
    }
    options.onProgress?.(Math.min(i + batchSize, pending.length), pending.length);
  }

  let recovered = 0;
  const unresolved: { name: string; category: string; reason: string }[] = [];
  for (const f of failures) {
    const t = dataTypes[f.slot];
    console.warn(
      `[type-detail] ${t.name} (${t.category}) failed: ${f.error.message} — retrying alone`
    );
    try {
      apply(f.slot, await extractDataType(connection, t.name, t.category));
      recovered++;
    } catch (e) {
      unresolved.push({ name: t.name, category: t.category, reason: (e as Error).message });
    }
  }

  if (unresolved.length > 0) {
    const listed = unresolved
      .map(u => `  ${u.name} (${u.category}): ${u.reason}`)
      .join('\n');
    throw new Error(
      `${unresolved.length} data type(s) have no members because their detail fetch ` +
      `never landed. Their members are unknown, not absent, and emitting them would ` +
      `produce a type that compiles and then fails at every access:\n${listed}`
    );
  }

  return { fetched, recovered };
}

/**
 * Extract all structures
 */
export async function extractStructures(
  connection: GhidraConnection
): Promise<ExtractedStruct[]> {
  const allTypes: ExtractedStruct[] = [];
  const pageSize = 100;
  let offset = 0;

  // Get all data types
  const types = await extractDataTypes(connection, { limit: 10000 });

  // Filter to structures and get details
  for (const type of types) {
    if (type.kind === 'STRUCTURE') {
      // A convenience helper, not the pipeline: a type it cannot read is skipped
      // rather than fatal. `hydrateDataTypeDetails` is the one that must not.
      const detail = await extractDataType(connection, type.name, type.category)
        .catch(() => null);
      if (detail && detail.kind === 'STRUCTURE') {
        allTypes.push(detail as ExtractedStruct);
      }
    }
  }

  return allTypes;
}

/**
 * Extract all enums
 */
export async function extractEnums(
  connection: GhidraConnection
): Promise<ExtractedEnum[]> {
  const types = await extractDataTypes(connection, { limit: 10000 });

  const enums: ExtractedEnum[] = [];
  for (const type of types) {
    if (type.kind === 'ENUM') {
      const detail = await extractDataType(connection, type.name, type.category)
        .catch(() => null);
      if (detail && detail.kind === 'ENUM') {
        enums.push(detail as ExtractedEnum);
      }
    }
  }

  return enums;
}

/**
 * Map Ghidra data type info to our type
 *
 * `list_data_types` returns shallow listing entries (no fields/values). The
 * detailed shape is normally backfilled later by `extractDataType`, but that
 * fetch can return null (e.g. a transient daemon error), leaving the shallow
 * entry in place. So a STRUCTURE/UNION listing entry must already carry an
 * empty `fields` array — downstream codegen assumes `fields` is always an
 * array (buildBitfieldCatalog, computeTypeOwnership) and crashes otherwise.
 */
function mapDataTypeInfo(info: GhidraDataTypeInfo): ExtractedDataType {
  const base: ExtractedDataType = {
    name: info.name,
    category: info.category,
    size: info.length,
    kind: mapDataTypeKind(info.type),
    description: info.description,
  };

  // A shallow listing entry carries no detail arrays. Seed empty ones per kind
  // so a type whose detail fetch is later skipped/fails never reaches codegen
  // with an undefined fields/values/parameters array. The empty array is a
  // crash guard and nothing more, so mark the entry: until the detail lands,
  // "no members" means "not known yet".
  if (DETAIL_KINDS.has(base.kind)) base.detailUnavailable = true;

  if (base.kind === 'STRUCTURE' || base.kind === 'UNION') {
    return { ...base, fields: [] } as ExtractedStruct | ExtractedUnion;
  }
  if (base.kind === 'ENUM') {
    return { ...base, values: [] } as ExtractedEnum;
  }
  if (base.kind === 'FUNCTION_DEFINITION') {
    return { ...base, returnType: 'void', parameters: [] } as ExtractedFunctionDefinition;
  }

  return base;
}

/**
 * Map detailed data type info
 */
function mapDataTypeDetail(detail: GhidraDataTypeDetail): ExtractedDataType {
  const base: ExtractedDataType = {
    name: detail.name,
    category: detail.category,
    size: detail.length,
    kind: mapDataTypeKind(detail.type),
    description: detail.description,
  };

  switch (base.kind) {
    case 'STRUCTURE':
      return {
        ...base,
        kind: 'STRUCTURE',
        fields: (detail.fields || []).map(mapStructField),
        alignment: detail.alignment,
        packed: detail.packed,
      } as ExtractedStruct;

    case 'ENUM':
      return {
        ...base,
        kind: 'ENUM',
        values: (detail.values || []).map(mapEnumValue),
      } as ExtractedEnum;

    case 'TYPEDEF':
      return {
        ...base,
        kind: 'TYPEDEF',
        underlyingType: detail.underlyingType || 'void',
      } as ExtractedTypedef;

    case 'UNION':
      return {
        ...base,
        kind: 'UNION',
        fields: (detail.fields || []).map(mapStructField),
      } as ExtractedUnion;

    case 'FUNCTION_DEFINITION':
      return {
        ...base,
        kind: 'FUNCTION_DEFINITION',
        returnType: detail.returnType || 'void',
        parameters: (detail.parameters || []).map(p => ({
          name: p.name,
          dataType: p.dataType,
          ordinal: p.ordinal,
        })),
        callingConvention: detail.callingConvention,
        hasVarArgs: detail.hasVarArgs,
      } as ExtractedFunctionDefinition;

    default:
      return base;
  }
}

function mapDataTypeKind(kind: string): DataTypeKind {
  const kindMap: Record<string, DataTypeKind> = {
    'BuiltIn': 'BUILT_IN',
    'BUILT_IN': 'BUILT_IN',
    'builtin': 'BUILT_IN',
    'Pointer': 'POINTER',
    'POINTER': 'POINTER',
    'pointer': 'POINTER',
    'Array': 'ARRAY',
    'ARRAY': 'ARRAY',
    'array': 'ARRAY',
    'Structure': 'STRUCTURE',
    'STRUCTURE': 'STRUCTURE',
    'structure': 'STRUCTURE',
    'Union': 'UNION',
    'UNION': 'UNION',
    'union': 'UNION',
    'Enum': 'ENUM',
    'ENUM': 'ENUM',
    'enum': 'ENUM',
    'FunctionDefinition': 'FUNCTION_DEFINITION',
    'FUNCTION_DEFINITION': 'FUNCTION_DEFINITION',
    'function': 'FUNCTION_DEFINITION',
    'TypeDef': 'TYPEDEF',
    'TYPEDEF': 'TYPEDEF',
    'typedef': 'TYPEDEF',
  };
  return kindMap[kind] || 'BUILT_IN';
}

function mapStructField(field: NonNullable<GhidraDataTypeDetail['fields']>[0]): StructField {
  return {
    name: field.name,
    dataType: field.dataType,
    offset: field.offset,
    size: field.size,
    comment: field.comment,
  };
}

function mapEnumValue(value: NonNullable<GhidraDataTypeDetail['values']>[0]): EnumValue {
  return {
    name: value.name,
    value: value.value,
    comment: value.comment,
  };
}
