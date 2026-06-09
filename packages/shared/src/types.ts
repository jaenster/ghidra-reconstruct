/**
 * Shared type definitions for Ghidra MCP
 */

import type { SymbolTag } from './protocol.js';

// =============================================================================
// Session Types
// =============================================================================

export interface Session {
  id: string;
  binaryPath: string;
  binaryHash: string;
  programPath?: string;
  createdAt: Date;
  lastAccessedAt: Date;
  clientCount: number;
  workerPid?: number;
  status: SessionStatus;
  aliases?: string[];
}

export type SessionStatus = 'starting' | 'analyzing' | 'ready' | 'error' | 'closing';

export interface SessionCreateOptions {
  binaryPath: string;
  autoAnalyze?: boolean;
  analysisTimeout?: number;
}

// =============================================================================
// Program/Binary Information
// =============================================================================

export interface ProgramInfo {
  name: string;
  path: string;
  format: string;
  architecture: string;
  compiler: string | null;
  imageBase: string;
  minAddress: string;
  maxAddress: string;
  languageId: string;
  endianness: 'big' | 'little';
  pointerSize: number;
  executableMD5?: string;
  executableSHA256?: string;
  creationDate?: string;
  analysisState?: string;
}

// =============================================================================
// Function Types
// =============================================================================

export interface FunctionInfo {
  name: string;
  address: string;
  entryPoint: string;
  signature: string;
  returnType: string;
  parameters: ParameterInfo[];
  localVariables: VariableInfo[];
  callingConvention: string;
  size: number;
  isThunk: boolean;
  isExternal: boolean;
  hasVarArgs: boolean;
  namespace?: string;
  parentClass?: string;
  comment?: string;
  tags?: SymbolTag[];
}

export interface FunctionSummary {
  name: string;
  address: string;
  signature: string;
  size: number;
  complexity: 'low' | 'medium' | 'high';
  callCount: number;
  callerCount: number;
  stringCount: number;
  calls: string[];
  calledBy: string[];
  stringsUsed: string[];
  interestingPatterns?: string[];
}

export interface ParameterInfo {
  name: string;
  dataType: string;
  size: number;
  ordinal: number;
  storage?: string;
}

export interface VariableInfo {
  name: string;
  dataType: string;
  size: number;
  storage: string;
  stackOffset?: number;
  register?: string;
}

// =============================================================================
// Decompilation Types
// =============================================================================

export interface DecompileResult {
  functionName: string;
  address: string;
  signature: string;
  pseudocode: string;
  rawPseudocode?: string;
  warnings?: string[];
  highFunction?: HighFunctionInfo;
  tags?: SymbolTag[];

  // Transformation metadata (populated when cpp-parser transforms the output)
  transformed?: boolean;
  renamedIdentifiers?: Array<{ original: string; renamed: string }>;
  transformWarnings?: string[];
  ast?: unknown;
  analysis?: {
    generatedNameCount: number;
    simplifiablePatternCount: number;
    improvementScore: number;
  };
}

export interface HighFunctionInfo {
  localSymbolCount: number;
  prototypeString: string;
  modelName: string;
}

// =============================================================================
// Disassembly Types
// =============================================================================

export interface DisassemblyResult {
  address: string;
  instructions: InstructionInfo[];
  functionName?: string;
  functionOffset?: string;
}

export interface InstructionInfo {
  address: string;
  bytes: string;
  mnemonic: string;
  operands: string;
  comment?: string;
  label?: string;
  xrefsTo?: string[];
  xrefsFrom?: string[];
}

export interface BasicBlock {
  startAddress: string;
  endAddress: string;
  instructions: InstructionInfo[];
  successors: string[];
  predecessors: string[];
}

// =============================================================================
// Cross-Reference Types
// =============================================================================

export interface XRef {
  fromAddress: string;
  toAddress: string;
  type: XRefType;
  isCall: boolean;
  isPrimary: boolean;
  fromFunction?: string;
  toFunction?: string;
  context?: string;
}

export type XRefType =
  | 'UNCONDITIONAL_CALL'
  | 'CONDITIONAL_CALL'
  | 'UNCONDITIONAL_JUMP'
  | 'CONDITIONAL_JUMP'
  | 'COMPUTED_CALL'
  | 'COMPUTED_JUMP'
  | 'DATA'
  | 'READ'
  | 'WRITE'
  | 'READ_WRITE'
  | 'PARAM'
  | 'EXTERNAL'
  | 'INDIRECTION'
  | 'UNKNOWN';

export interface XRefWithContext extends XRef {
  surroundingCode?: string[];
  inBlock?: string;
  nearbyStrings?: string[];
}

// =============================================================================
// Symbol Types
// =============================================================================

export interface SymbolInfo {
  name: string;
  address: string;
  type: SymbolType;
  namespace?: string;
  isPrimary: boolean;
  isGlobal: boolean;
  source: string;
  tags?: SymbolTag[];
}

export type SymbolType =
  | 'FUNCTION'
  | 'LABEL'
  | 'CLASS'
  | 'NAMESPACE'
  | 'PARAMETER'
  | 'LOCAL_VAR'
  | 'GLOBAL_VAR'
  | 'EXTERNAL';

export interface ImportInfo {
  name: string;
  address: string;
  library?: string;
  ordinal?: number;
}

export interface ExportInfo {
  name: string;
  address: string;
  ordinal?: number;
}

// =============================================================================
// Data Types
// =============================================================================

export interface DataTypeInfo {
  name: string;
  category: string;
  length: number;
  description?: string;
  kind: DataTypeKind;
}

export type DataTypeKind =
  | 'BUILT_IN'
  | 'POINTER'
  | 'ARRAY'
  | 'STRUCTURE'
  | 'UNION'
  | 'ENUM'
  | 'FUNCTION_DEFINITION'
  | 'TYPEDEF';

export interface StructureInfo extends DataTypeInfo {
  kind: 'STRUCTURE';
  fields: StructureField[];
  alignment: number;
  packed: boolean;
}

export interface StructureField {
  name: string;
  dataType: string;
  offset: number;
  length: number;
  comment?: string;
}

export interface EnumInfo extends DataTypeInfo {
  kind: 'ENUM';
  values: EnumValue[];
}

export interface EnumValue {
  name: string;
  value: number;
  comment?: string;
}

// =============================================================================
// Memory Types
// =============================================================================

export interface MemoryBlock {
  name: string;
  start: string;
  end: string;
  size: number;
  permissions: string;
  isInitialized: boolean;
  isVolatile: boolean;
  isMapped: boolean;
  sourceInfo?: string;
}

export interface DefinedData {
  address: string;
  label?: string;
  dataType: string;
  length: number;
  value?: string;
}

// =============================================================================
// String Types
// =============================================================================

export interface StringInfo {
  address: string;
  value: string;
  length: number;
  encoding: string;
  inFunction?: string;
  xrefCount: number;
}

// =============================================================================
// Search Types
// =============================================================================

export interface SearchOptions {
  pattern: string;
  type: SearchType | SearchType[];
  scope?: SearchScope;
  caseSensitive?: boolean;
  limit?: number;
  offset?: number;
  includeContext?: boolean;
}

export type SearchType =
  | 'functions'
  | 'strings'
  | 'symbols'
  | 'data'
  | 'imports'
  | 'exports'
  | 'namespaces'
  | 'comments'
  | 'all';

export interface SearchScope {
  type: 'program' | 'function' | 'namespace' | 'address_range';
  value?: string;
  startAddress?: string;
  endAddress?: string;
}

export interface SearchResult {
  type: SearchType;
  name: string;
  address: string;
  context?: string;
  match?: string;
  score?: number;
}

// =============================================================================
// Call Graph Types
// =============================================================================

export interface CallGraphNode {
  address: string;
  name: string;
  callers: CallGraphEdge[];
  callees: CallGraphEdge[];
}

export interface CallGraphEdge {
  address: string;
  name: string;
  callSite?: string;
  type: 'direct' | 'indirect' | 'virtual';
}

export interface CallPath {
  from: string;
  to: string;
  path: string[];
  depth: number;
}

// =============================================================================
// Namespace/Class Types
// =============================================================================

export interface NamespaceInfo {
  name: string;
  address?: string;
  parent?: string;
  symbolCount: number;
  childNamespaces: string[];
}

export interface ClassInfo extends NamespaceInfo {
  methods: FunctionInfo[];
  fields: StructureField[];
  vtableAddress?: string;
  parentClass?: string;
  interfaces?: string[];
}

// =============================================================================
// Comment Types
// =============================================================================

export interface CommentInfo {
  address: string;
  type: CommentType;
  text: string;
  inFunction?: string;
}

export type CommentType =
  | 'EOL'
  | 'PRE'
  | 'POST'
  | 'PLATE'
  | 'REPEATABLE';

// =============================================================================
// Bookmark Types
// =============================================================================

export interface BookmarkInfo {
  address: string;
  type: string;
  category: string;
  comment: string;
}

// =============================================================================
// PCode Types (Intermediate Representation)
// =============================================================================

export interface PCodeOp {
  address: string;
  opcode: string;
  inputs: PCodeVarnode[];
  output?: PCodeVarnode;
  sequenceNumber: number;
}

export interface PCodeVarnode {
  space: string;
  offset: string;
  size: number;
  isConstant: boolean;
  isRegister: boolean;
  isUnique: boolean;
  symbolName?: string;
}

// =============================================================================
// Modification Types
// =============================================================================

export interface RenameRequest {
  address: string;
  newName: string;
  type: 'function' | 'variable' | 'label' | 'data';
  scope?: string;
}

export interface SetTypeRequest {
  address: string;
  dataType: string;
  length?: number;
}

export interface SetCommentRequest {
  address: string;
  comment: string;
  type: CommentType;
}

export interface SetPrototypeRequest {
  functionAddress: string;
  prototype: string;
}

// =============================================================================
// Batch Operation Types
// =============================================================================

export interface BatchRenameItem {
  address: string;
  newName: string;
}

export interface BatchResult {
  success: number;
  failed: number;
  errors: BatchError[];
}

export interface BatchError {
  address: string;
  error: string;
}

// =============================================================================
// Script Execution Types
// =============================================================================

export interface ScriptRequest {
  code: string;
  timeout?: number;
  sandbox?: boolean;
}

export interface ScriptResult {
  success: boolean;
  result?: unknown;
  output?: string;
  error?: string;
  executionTime?: number;
}

// =============================================================================
// Analysis Hints
// =============================================================================

export interface AnalysisHint {
  address: string;
  type: AnalysisHintType;
  description: string;
  confidence: 'low' | 'medium' | 'high';
  suggestion?: string;
}

export type AnalysisHintType =
  | 'SUSPICIOUS_PATTERN'
  | 'UNANALYZED_CODE'
  | 'TYPE_MISMATCH'
  | 'POTENTIAL_VULN'
  | 'DEAD_CODE'
  | 'OPTIMIZATION_OPPORTUNITY';

// =============================================================================
// Error Types
// =============================================================================

export class GhidraMcpError extends Error {
  constructor(
    message: string,
    public code: ErrorCode,
    public details?: unknown
  ) {
    super(message);
    this.name = 'GhidraMcpError';
  }
}

export type ErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'WORKER_NOT_READY'
  | 'WORKER_CRASHED'
  | 'COMMAND_TIMEOUT'
  | 'INVALID_ADDRESS'
  | 'FUNCTION_NOT_FOUND'
  | 'DECOMPILE_FAILED'
  | 'ANALYSIS_FAILED'
  | 'BINARY_NOT_FOUND'
  | 'GHIDRA_NOT_FOUND'
  | 'JAVA_NOT_FOUND'
  | 'SCRIPT_ERROR'
  | 'PERMISSION_DENIED'
  | 'INTERNAL_ERROR';
