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
  category?: string
): Promise<ExtractedDataType | null> {
  const params: Record<string, unknown> = { name };
  if (category) params.category = category;

  try {
    const result = await connection.sendCommand<GhidraDataTypeDetail>(
      'get_data_type',
      params
    );
    return mapDataTypeDetail(result);
  } catch {
    return null;
  }
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
      const detail = await extractDataType(connection, type.name, type.category);
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
      const detail = await extractDataType(connection, type.name, type.category);
      if (detail && detail.kind === 'ENUM') {
        enums.push(detail as ExtractedEnum);
      }
    }
  }

  return enums;
}

/**
 * Map Ghidra data type info to our type
 */
function mapDataTypeInfo(info: GhidraDataTypeInfo): ExtractedDataType {
  return {
    name: info.name,
    category: info.category,
    size: info.length,
    kind: mapDataTypeKind(info.type),
    description: info.description,
  };
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
