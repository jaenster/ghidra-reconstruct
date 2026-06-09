/**
 * Worker ↔ Daemon communication protocol
 *
 * Communication flow:
 * 1. Daemon spawns Java worker with callback URL
 * 2. Worker connects back to daemon via HTTP
 * 3. Worker polls for commands, posts results
 */

import type {
  ProgramInfo,
  FunctionInfo,
  FunctionSummary,
  DecompileResult,
  DisassemblyResult,
  BasicBlock,
  XRef,
  XRefWithContext,
  SymbolInfo,
  ImportInfo,
  ExportInfo,
  DataTypeInfo,
  StructureInfo,
  MemoryBlock,
  DefinedData,
  StringInfo,
  SearchResult,
  CallGraphNode,
  CallPath,
  NamespaceInfo,
  ClassInfo,
  CommentInfo,
  BookmarkInfo,
  PCodeOp,
  BatchResult,
  ScriptResult,
  AnalysisHint
} from './types.js';

// =============================================================================
// Command Types (Daemon → Worker)
// =============================================================================

export type WorkerCommand =
  | LoadProgramCommand
  | CloseProgramCommand
  | GetProgramInfoCommand
  | ListFunctionsCommand
  | GetFunctionInfoCommand
  | GetFunctionSummaryCommand
  | DecompileCommand
  | GetDisassemblyCommand
  | GetBasicBlocksCommand
  | GetXrefsCommand
  | GetXrefsWithContextCommand
  | ListSymbolsCommand
  | ListImportsCommand
  | ListExportsCommand
  | ListDataTypesCommand
  | GetDataTypeCommand
  | ListSegmentsCommand
  | ListStringsCommand
  | SearchCommand
  | GetCallGraphCommand
  | FindCallPathCommand
  | ListNamespacesCommand
  | GetClassInfoCommand
  | ListCommentsCommand
  | ListBookmarksCommand
  | GetPcodeCommand
  | BatchPcodeCommand
  | ReadMemoryCommand
  | GetHexdumpCommand
  | RenameSymbolCommand
  | SetCommentCommand
  | SetDataTypeCommand
  | SetPrototypeCommand
  | SetCustomSignatureCommand
  | CreateStructureCommand
  | BatchRenameCommand
  | ExecuteScriptCommand
  | GetAnalysisHintsCommand
  | FindFunctionsMatchingCommand
  | TraceDataFlowCommand
  | SaveCommand
  | ShutdownCommand
  // New modification commands
  | AddBookmarkCommand
  | DeleteBookmarkCommand
  | DeleteCommentCommand
  | CreateLabelCommand
  | DeleteLabelCommand
  | CreateFunctionCommand
  | DeleteFunctionCommand
  | CreateEnumCommand
  | CreateUnionCommand
  | CreateTypedefCommand
  | UpdateStructureCommand
  | DeleteDataTypeCommand
  | DisassembleCommand
  | ClearListingCommand
  | SetFunctionVariableNameCommand
  | SetFunctionVariableTypeCommand
  | GetGlobalVariablesCommand
  | ReadDataValueCommand
  | BatchDecompileCommand
  | ListEquatesCommand
  | SetEquateCommand
  | DeleteEquateCommand
  // Function attribute/tag commands
  | SetFunctionAttributesCommand
  | AddFunctionTagCommand
  | RemoveFunctionTagCommand
  // Namespace commands
  | CreateNamespaceCommand
  | MoveSymbolToNamespaceCommand
  | RenameNamespaceCommand
  // Undo/redo commands
  | UndoCommand
  | RedoCommand
  | GetUndoHistoryCommand
  // Analysis commands
  | GetStackFrameCommand
  | ReanalyzeCommand
  // Switch table command
  | GetSwitchTableCommand
  | SetSwitchOverrideCommand
  // Data inspection commands
  | GetDataAtAddressCommand
  | DetectTableCommand
  | ExportTypeArchiveCommand
  | ImportTypeArchiveCommand
  // Batch tag command
  | BatchTagSymbolsCommand
  // Symbol navigation
  | GetSymbolAfterCommand
  // Multi-program commands
  | ListProgramsCommand
  // Version Tracking commands
  | VtCreateSessionCommand
  | VtRunCorrelatorCommand
  | VtListMatchesCommand
  | VtAcceptMatchesCommand
  | VtApplyMarkupCommand
  | VtGetCorrelatorsCommand;

// Base command interface
export interface BaseCommand {
  id: string;
  command: string;
  timeout?: number;
}

// Program management commands
export interface LoadProgramCommand extends BaseCommand {
  command: 'load_program';
  params: {
    binaryPath?: string;
    projectPath?: string;
    programPath?: string;
    analyze?: boolean;
    analysisTimeout?: number;
  };
}

export interface CloseProgramCommand extends BaseCommand {
  command: 'close_program';
  params: {
    save?: boolean;
  };
}

export interface GetProgramInfoCommand extends BaseCommand {
  command: 'get_program_info';
  params: Record<string, never>;
}

// Function commands
export interface ListFunctionsCommand extends BaseCommand {
  command: 'list_functions';
  params: {
    offset?: number;
    limit?: number;
    filter?: string;
    regex?: string;
    namespace?: string;
    includeChildren?: boolean;
  };
}

export interface GetFunctionInfoCommand extends BaseCommand {
  command: 'get_function_info';
  params: {
    address?: string;
    name?: string;
  };
}

export interface GetFunctionSummaryCommand extends BaseCommand {
  command: 'get_function_summary';
  params: {
    address?: string;
    name?: string;
    includeStrings?: boolean;
    includeXrefs?: boolean;
    maxCalls?: number;
    maxCallers?: number;
  };
}

// Decompilation commands
export interface DecompileCommand extends BaseCommand {
  command: 'decompile';
  params: {
    address?: string;
    name?: string;
    timeout?: number;
  };
}

export interface BatchDecompileCommand extends BaseCommand {
  command: 'batch_decompile';
  params: {
    addresses?: string[];
    names?: string[];
    filter?: string;
    regex?: string;
    namespace?: string;
    startAddress?: string;
    endAddress?: string;
    limit?: number;
    decompileTimeout?: number;
  };
}

// Disassembly commands
export interface GetDisassemblyCommand extends BaseCommand {
  command: 'get_disassembly';
  params: {
    address: string;
    count?: number;
    context?: number;
  };
}

export interface GetBasicBlocksCommand extends BaseCommand {
  command: 'get_basic_blocks';
  params: {
    address?: string;
    name?: string;
  };
}

// Cross-reference commands
export interface GetXrefsCommand extends BaseCommand {
  command: 'get_xrefs';
  params: {
    address: string;
    direction: 'to' | 'from' | 'both';
    limit?: number;
    refType?: string | string[];
  };
}

export interface GetXrefsWithContextCommand extends BaseCommand {
  command: 'get_xrefs_with_context';
  params: {
    address: string;
    direction: 'to' | 'from' | 'both';
    contextLines?: number;
    contextPattern?: string;
    limit?: number;
    refType?: string | string[];
  };
}

// Symbol commands
export interface ListSymbolsCommand extends BaseCommand {
  command: 'list_symbols';
  params: {
    offset?: number;
    limit?: number;
    filter?: string;
    regex?: string;
    type?: string;
  };
}

export interface ListImportsCommand extends BaseCommand {
  command: 'list_imports';
  params: {
    offset?: number;
    limit?: number;
    filter?: string;
    regex?: string;
  };
}

export interface ListExportsCommand extends BaseCommand {
  command: 'list_exports';
  params: {
    offset?: number;
    limit?: number;
    filter?: string;
    regex?: string;
  };
}

// Data type commands
export interface ListDataTypesCommand extends BaseCommand {
  command: 'list_data_types';
  params: {
    offset?: number;
    limit?: number;
    filter?: string;
    regex?: string;
    category?: string;
  };
}

export interface GetDataTypeCommand extends BaseCommand {
  command: 'get_data_type';
  params: {
    name: string;
    category?: string;
  };
}

// Memory commands
export interface ListSegmentsCommand extends BaseCommand {
  command: 'list_segments';
  params: {
    offset?: number;
    limit?: number;
  };
}

export interface ReadMemoryCommand extends BaseCommand {
  command: 'read_memory';
  params: {
    address: string;
    length: number;
  };
}

export interface GetHexdumpCommand extends BaseCommand {
  command: 'get_hexdump';
  params: {
    address: string;
    length: number;
    bytesPerLine?: number;
  };
}

// String commands
export interface ListStringsCommand extends BaseCommand {
  command: 'list_strings';
  params: {
    offset?: number;
    limit?: number;
    minLength?: number;
    filter?: string;
    regex?: string;
  };
}

// Search commands
export interface SearchCommand extends BaseCommand {
  command: 'search';
  params: {
    pattern?: string; // backward compat
    filter?: string;
    regex?: string;
    hexPattern?: string;
    type: string | string[];
    caseSensitive?: boolean;
    countOnly?: boolean;
    limit?: number;
    offset?: number;
    scope?: {
      type: string;
      value?: string;
      startAddress?: string;
      endAddress?: string;
    };
    functionFilter?: string;
    searchMode?: string;
    flowType?: string;
  };
}

// Call graph commands
export interface GetCallGraphCommand extends BaseCommand {
  command: 'get_call_graph';
  params: {
    address?: string;
    name?: string;
    depth?: number;
    direction?: 'callers' | 'callees' | 'both';
    maxNodes?: number;
  };
}

export interface FindCallPathCommand extends BaseCommand {
  command: 'find_call_path';
  params: {
    from: string;
    to: string;
    maxDepth?: number;
  };
}

// Namespace/class commands
export interface ListNamespacesCommand extends BaseCommand {
  command: 'list_namespaces';
  params: {
    offset?: number;
    limit?: number;
    filter?: string;
    regex?: string;
  };
}

export interface GetClassInfoCommand extends BaseCommand {
  command: 'get_class_info';
  params: {
    name: string;
  };
}

// Comment/bookmark commands
export interface ListCommentsCommand extends BaseCommand {
  command: 'list_comments';
  params: {
    offset?: number;
    limit?: number;
    type?: string;
    inFunction?: string;
  };
}

export interface ListBookmarksCommand extends BaseCommand {
  command: 'list_bookmarks';
  params: {
    offset?: number;
    limit?: number;
    type?: string;
    category?: string;
  };
}

// PCode command
export interface GetPcodeCommand extends BaseCommand {
  command: 'get_pcode';
  params: {
    address?: string;
    name?: string;
    highLevel?: boolean;
  };
}

export interface BatchPcodeCommand extends BaseCommand {
  command: 'batch_pcode';
  params: {
    addresses: string[];
    highLevel?: boolean;
  };
}

// Modification commands
export interface RenameSymbolCommand extends BaseCommand {
  command: 'rename_symbol';
  params: {
    address: string;
    newName: string;
    type: 'function' | 'variable' | 'label' | 'data';
    scope?: string;
    description?: string;
  };
}

export interface SetCommentCommand extends BaseCommand {
  command: 'set_comment';
  params: {
    address: string;
    comment: string;
    type: string;
  };
}

export interface SetDataTypeCommand extends BaseCommand {
  command: 'set_data_type';
  params: {
    address: string;
    dataType: string;
    length?: number;
  };
}

export interface SetPrototypeCommand extends BaseCommand {
  command: 'set_prototype';
  params: {
    functionAddress: string;
    prototype: string;
    description?: string;
  };
}

export interface CustomParameterDef {
  name: string;
  dataType: string;
  storage: string;  // e.g., "EAX", "ECX", "EDX", "stack:0x4"
}

export interface SetCustomSignatureCommand extends BaseCommand {
  command: 'set_custom_signature';
  params: {
    functionAddress: string;
    returnType?: string;
    parameters: CustomParameterDef[];
    description?: string;
  };
}

export interface CreateStructureCommand extends BaseCommand {
  command: 'create_structure';
  params: {
    name: string;
    fields: Array<{
      name: string;
      dataType: string;
      offset?: number;
      comment?: string;
    }>;
    category?: string;
    packed?: boolean;
  };
}

export interface BatchRenameCommand extends BaseCommand {
  command: 'batch_rename';
  params: {
    mappings: Array<{
      address: string;
      newName: string;
    }>;
    dryRun?: boolean;
    description?: string;
  };
}

// Script command
export interface ExecuteScriptCommand extends BaseCommand {
  command: 'execute_script';
  params: {
    code?: string;
    filePath?: string;
    language?: 'javascript' | 'python';
    timeout?: number;
    sandbox?: boolean;
  };
}

// Analysis hints command
export interface GetAnalysisHintsCommand extends BaseCommand {
  command: 'get_analysis_hints';
  params: {
    address?: string;
    function?: string;
  };
}

// Compound query commands
export interface FindFunctionsMatchingCommand extends BaseCommand {
  command: 'find_functions_matching';
  params: {
    calls?: string[];
    notCalls?: string[];
    referencesString?: string;
    inNamespace?: string;
    sizeMin?: number;
    sizeMax?: number;
    limit?: number;
  };
}

export interface TraceDataFlowCommand extends BaseCommand {
  command: 'trace_data_flow';
  params: {
    from: string;
    depth?: number;
    includeCalls?: boolean;
  };
}

// Equate commands
export interface ListEquatesCommand extends BaseCommand {
  command: 'list_equates';
  params: {
    offset?: number;
    limit?: number;
    filter?: string;
    regex?: string;
    value?: number;
  };
}

export interface SetEquateCommand extends BaseCommand {
  command: 'set_equate';
  params: {
    address: string;
    operandIndex?: number;
    value: number;
    name: string;
  };
}

export interface DeleteEquateCommand extends BaseCommand {
  command: 'delete_equate';
  params: {
    address: string;
    operandIndex?: number;
    name: string;
  };
}

// Function attribute/tag commands
export interface SetFunctionAttributesCommand extends BaseCommand {
  command: 'set_function_attributes';
  params: {
    address?: string;
    name?: string;
    callingConvention?: string;
    noReturn?: boolean;
    inline?: boolean;
    varArgs?: boolean;
  };
}

export interface AddFunctionTagCommand extends BaseCommand {
  command: 'add_function_tag';
  params: {
    address?: string;
    name?: string;
    tag: string;
  };
}

export interface RemoveFunctionTagCommand extends BaseCommand {
  command: 'remove_function_tag';
  params: {
    address?: string;
    name?: string;
    tag: string;
  };
}

// Namespace commands
export interface CreateNamespaceCommand extends BaseCommand {
  command: 'create_namespace';
  params: {
    name: string;
    parent?: string;
    isClass?: boolean;
  };
}

export interface MoveSymbolToNamespaceCommand extends BaseCommand {
  command: 'move_symbol_to_namespace';
  params: {
    address: string;
    namespace: string;
    type: 'function' | 'label' | 'data';
  };
}

export interface RenameNamespaceCommand extends BaseCommand {
  command: 'rename_namespace';
  params: {
    oldName: string;
    newName: string;
  };
}

// Undo/redo commands
export interface UndoCommand extends BaseCommand {
  command: 'undo';
  params: Record<string, never>;
}

export interface RedoCommand extends BaseCommand {
  command: 'redo';
  params: Record<string, never>;
}

export interface GetUndoHistoryCommand extends BaseCommand {
  command: 'get_undo_history';
  params: Record<string, never>;
}

// Analysis commands
export interface GetStackFrameCommand extends BaseCommand {
  command: 'get_stack_frame';
  params: {
    address?: string;
    name?: string;
  };
}

export interface ReanalyzeCommand extends BaseCommand {
  command: 'reanalyze';
  params: {
    address?: string;
  };
}

// Switch table command
export interface GetSwitchTableCommand extends BaseCommand {
  command: 'get_switch_table';
  params: {
    address: string;
  };
}

// Switch override command
export interface SetSwitchOverrideCommand extends BaseCommand {
  command: 'set_switch_override';
  params: {
    address: string;
    caseAddresses: string[];
  };
}

// Save command
export interface SaveCommand extends BaseCommand {
  command: 'save';
  params: Record<string, never>;
}

// Shutdown command
export interface ShutdownCommand extends BaseCommand {
  command: 'shutdown';
  params: {
    save?: boolean;
  };
}

// Bookmark commands
export interface AddBookmarkCommand extends BaseCommand {
  command: 'add_bookmark';
  params: {
    address: string;
    type?: string;
    category?: string;
    comment?: string;
  };
}

export interface DeleteBookmarkCommand extends BaseCommand {
  command: 'delete_bookmark';
  params: {
    address: string;
    type?: string;
  };
}

export interface DeleteCommentCommand extends BaseCommand {
  command: 'delete_comment';
  params: {
    address: string;
    type: string;
  };
}

// Label commands
export interface CreateLabelCommand extends BaseCommand {
  command: 'create_label';
  params: {
    address: string;
    name: string;
    namespace?: string;
    primary?: boolean;
  };
}

export interface DeleteLabelCommand extends BaseCommand {
  command: 'delete_label';
  params: {
    address: string;
    name?: string;
  };
}

// Function commands
export interface CreateFunctionCommand extends BaseCommand {
  command: 'create_function';
  params: {
    address: string;
    name?: string;
  };
}

export interface DeleteFunctionCommand extends BaseCommand {
  command: 'delete_function';
  params: {
    address: string;
  };
}

// Data type creation commands
export interface CreateEnumCommand extends BaseCommand {
  command: 'create_enum';
  params: {
    name: string;
    values: Record<string, number>;
    category?: string;
    size?: number;
  };
}

export interface CreateUnionCommand extends BaseCommand {
  command: 'create_union';
  params: {
    name: string;
    fields: Array<{
      name: string;
      dataType: string;
      comment?: string;
    }>;
    category?: string;
  };
}

export interface CreateTypedefCommand extends BaseCommand {
  command: 'create_typedef';
  params: {
    name: string;
    baseType: string;
    category?: string;
  };
}

export interface UpdateStructureCommand extends BaseCommand {
  command: 'update_structure';
  params: {
    name: string;
    operation: 'replaceAll' | 'updateFields' | 'insertField' | 'deleteField' | 'replace' | 'addField' | 'removeField';
    fields?: Array<{
      name?: string;
      dataType?: string;
      offset?: number;
      comment?: string;
      // updateFields-specific: identify field and apply partial updates
      fieldName?: string;   // identify by existing name
      newName?: string;     // rename to this
      newDataType?: string; // retype to this
    }>;
    fieldName?: string;
    category?: string;
    force?: boolean;  // override replaceAll size safety check
  };
}

export interface DeleteDataTypeCommand extends BaseCommand {
  command: 'delete_data_type';
  params: {
    name: string;
    category?: string;
  };
}

// Code manipulation commands
export interface DisassembleCommand extends BaseCommand {
  command: 'disassemble';
  params: {
    address: string;
    length?: number;
  };
}

export interface ClearListingCommand extends BaseCommand {
  command: 'clear_listing';
  params: {
    startAddress: string;
    endAddress?: string;
  };
}

// Variable management commands
export interface SetFunctionVariableNameCommand extends BaseCommand {
  command: 'set_function_variable_name';
  params: {
    functionAddress: string;
    oldName: string;
    newName: string;
    description?: string;
  };
}

export interface SetFunctionVariableTypeCommand extends BaseCommand {
  command: 'set_function_variable_type';
  params: {
    functionAddress: string;
    variableName: string;
    dataType: string;
    description?: string;
    force?: boolean;
  };
}

export interface GetGlobalVariablesCommand extends BaseCommand {
  command: 'get_global_variables';
  params: {
    offset?: number;
    limit?: number;
    filter?: string;
    regex?: string;
    segment?: string;
    sortBy?: string;
    dataType?: string;
  };
}

export interface ReadDataValueCommand extends BaseCommand {
  command: 'read_data_value';
  params: {
    address: string;
  };
}

export interface GetDataAtAddressCommand extends BaseCommand {
  command: 'get_data_at_address';
  params: {
    address: string;
    lookAhead?: number;
  };
}

export interface DetectTableCommand extends BaseCommand {
  command: 'detect_table';
  params: {
    address: string;
    maxEntries?: number;
    applyType?: boolean;
    name?: string;
  };
}

// Type archive commands
export interface ExportTypeArchiveCommand extends BaseCommand {
  command: 'export_type_archive';
  params: {
    archivePath: string;
    categories?: string[];
  };
}

export interface ImportTypeArchiveCommand extends BaseCommand {
  command: 'import_type_archive';
  params: {
    archivePath: string;
    categories?: string[];
  };
}

// Multi-program commands
export interface ListProgramsCommand extends BaseCommand {
  command: 'list_programs';
  params: Record<string, never>;
}

// Version Tracking commands
export interface VtCreateSessionCommand extends BaseCommand {
  command: 'vt_create_session';
  params: {
    sourceProgramPath: string;
    destProgramPath: string;
  };
}

export interface VtRunCorrelatorCommand extends BaseCommand {
  command: 'vt_run_correlator';
  params: {
    correlatorName: string;
  };
}

export interface VtListMatchesCommand extends BaseCommand {
  command: 'vt_list_matches';
  params: {
    minScore?: number;
    limit?: number;
  };
}

export interface VtAcceptMatchesCommand extends BaseCommand {
  command: 'vt_accept_matches';
  params: {
    acceptAll?: boolean;
    minScore?: number;
  };
}

export interface VtApplyMarkupCommand extends BaseCommand {
  command: 'vt_apply_markup';
  params: Record<string, never>;
}

export interface VtGetCorrelatorsCommand extends BaseCommand {
  command: 'vt_get_correlators';
  params: Record<string, never>;
}

// =============================================================================
// Response Types (Worker → Daemon)
// =============================================================================

export interface WorkerResponse<T = unknown> {
  id: string;
  success: boolean;
  result?: T;
  error?: WorkerError;
  executionTime?: number;
}

export interface WorkerError {
  code: string;
  message: string;
  details?: unknown;
  stackTrace?: string;
}

// Type-safe response mappings
export type CommandResultMap = {
  'load_program': { loaded: boolean; programInfo?: ProgramInfo };
  'close_program': { closed: boolean };
  'get_program_info': ProgramInfo;
  'list_functions': { functions: FunctionInfo[]; total: number };
  'get_function_info': FunctionInfo;
  'get_function_summary': FunctionSummary;
  'decompile': DecompileResult;
  'batch_decompile': { results: DecompileResult[]; failed: Array<{ address: string; name: string; error: string }>; total: number; decompiled: number };
  'get_disassembly': DisassemblyResult;
  'get_basic_blocks': { blocks: BasicBlock[] };
  'get_xrefs': { xrefs: XRef[] };
  'get_xrefs_with_context': { xrefs: XRefWithContext[] };
  'list_symbols': { symbols: SymbolInfo[]; total: number };
  'list_imports': { imports: ImportInfo[]; total: number };
  'list_exports': { exports: ExportInfo[]; total: number };
  'list_data_types': { dataTypes: DataTypeInfo[]; total: number };
  'get_data_type': DataTypeInfo | StructureInfo;
  'list_segments': { segments: MemoryBlock[] };
  'read_memory': { address: string; bytes: string; length: number };
  'get_hexdump': { address: string; hexdump: string };
  'list_strings': { strings: StringInfo[]; total: number };
  'search': { results?: SearchResult[]; total: number; offset: number; limit: number; hasMore: boolean; countOnly: boolean };
  'get_call_graph': CallGraphNode;
  'find_call_path': CallPath | null;
  'list_namespaces': { namespaces: NamespaceInfo[]; total: number };
  'get_class_info': ClassInfo;
  'list_comments': { comments: CommentInfo[]; total: number };
  'list_bookmarks': { bookmarks: BookmarkInfo[]; total: number };
  'get_pcode': { ops: PCodeOp[] };
  'batch_pcode': { results: Array<{ address: string; functionName: string; pcode: { ops: PCodeOp[] }; error?: string }> };
  'rename_symbol': { success: boolean; oldName?: string; newName?: string };
  'set_comment': { success: boolean };
  'set_data_type': { success: boolean };
  'set_prototype': { success: boolean };
  'set_custom_signature': { success: boolean };
  'create_structure': { success: boolean; dataType?: DataTypeInfo };
  'batch_rename': BatchResult;
  'execute_script': ScriptResult;
  'get_analysis_hints': { hints: AnalysisHint[] };
  'find_functions_matching': { functions: FunctionInfo[] };
  'trace_data_flow': { flow: DataFlowNode[] };
  'save': { success: boolean };
  'shutdown': { success: boolean };
  'list_equates': { equates: Array<{ name: string; value: number; hexValue: string; referenceCount: number; references: string[] }>; total: number };
  'set_equate': { success: boolean };
  'delete_equate': { success: boolean };
  // Function attributes/tags
  'set_function_attributes': { name: string; address: string; callingConvention: string; noReturn: boolean; inline: boolean; varArgs: boolean };
  'add_function_tag': { tags: string[] };
  'remove_function_tag': { tags: string[] };
  // Namespace
  'create_namespace': { name: string; parentNamespace: string; isClass: boolean };
  'move_symbol_to_namespace': { name: string; oldNamespace: string; newNamespace: string };
  'rename_namespace': { oldName: string; newName: string };
  // Undo/redo
  'undo': { undone: string; canUndo: boolean; canRedo: boolean };
  'redo': { redone: string; canUndo: boolean; canRedo: boolean };
  'get_undo_history': { undoStack: string[]; redoStack: string[]; canUndo: boolean; canRedo: boolean };
  // Analysis
  'get_stack_frame': { frameSize: number; localSize: number; parameterSize: number; returnAddrOffset: number; variables: Array<{ offset: number; name: string; dataType: string; size: number; comment: string | null; isParameter: boolean }> };
  'reanalyze': { success: boolean; scope: string };
  // Switch table
  'get_switch_table': { switchAddress: string; numCases: number; cases: Array<{ value: number; targetAddress: string; targetLabel?: string }>; defaultAddress?: string };
  'set_switch_override': { success: boolean; address: string; numCases: number; functionName: string };
  // Batch tagging
  'batch_tag_symbols': { success: boolean; applied: number; failed: Array<{ address: string; error: string }> };
  // Symbol navigation
  'get_symbol_after': { symbols: Array<{ address: string; name: string; fullName: string; symbolType: string; distance: number; namespace?: string; isFunction?: boolean; functionSize?: number; callingConvention?: string; dataType?: string; dataSize?: number; xrefCount: number }>; total: number };
  // Dirty tracking
  'get_dirty_symbols': { functions: string[]; dataTypes: string[]; globals: string[]; lastCleanVersion: number };
  'mark_clean': { version: number };
};

export interface DataFlowNode {
  address: string;
  type: 'source' | 'sink' | 'transform';
  description: string;
  function?: string;
  nextNodes?: DataFlowNode[];
}

// =============================================================================
// Worker Registration/Heartbeat
// =============================================================================

export interface WorkerRegistration {
  workerId: string;
  sessionId: string;
  pid: number;
  startTime: number;
  capabilities: string[];
}

export interface WorkerHeartbeat {
  workerId: string;
  sessionId: string;
  status: 'idle' | 'busy' | 'analyzing';
  memoryUsed?: number;
  currentCommand?: string;
  uptime: number;
  /** Whether the worker has dirty (modified) symbols since last clean mark */
  hasDirty?: boolean;
  /** Summary of dirty symbols (counts by type) */
  dirtySummary?: {
    functions: number;
    dataTypes: number;
    globals: number;
    since: number;
  };
  /** Thread pool status from CommandDispatcher */
  threads?: {
    readPoolSize: number;
    readPoolActive: number;
    activeThreads: string[];
    currentCommands: Record<string, string>;
  };
}

// =============================================================================
// Worker Reconnection (after daemon restart)
// =============================================================================

export interface WorkerReconnectRequest {
  sessionId: string;
  binaryPath: string;
  projectPath: string;
  readOnly: boolean;
  pid: number;
}

export interface WorkerReconnectResponse {
  success: boolean;
  workerId: string;
  sessionId: string;
}

// =============================================================================
// Structured Tag Types
// =============================================================================

/**
 * Structured tag for symbols (functions, data, etc.)
 *
 * Stored in Ghidra as "type" or "type:data" strings.
 *
 * Examples:
 *   { type: "method", data: "D2GameStrc" }           → instance method
 *   { type: "method", data: "D2GameStrc,static" }    → static method
 *   { type: "method", data: "D2GameStrc,ctor" }      → constructor
 *   { type: "method", data: "D2GameStrc,dtor" }      → destructor
 *   { type: "noreturn" }                              → function never returns
 *   { type: "inline" }                                → hint to inline
 *   { type: "vtable", data: "D2GameStrc" }            → vtable for class
 */
export interface SymbolTag {
  type: string;
  data?: string;
}

/**
 * Tag type constants
 */
export const TAG_TYPES = {
  METHOD: 'method',       // data: "ClassName" or "ClassName,static" or "ClassName,ctor" or "ClassName,dtor"
  NOT_METHOD: 'not-method',
  VTABLE: 'vtable',       // data: "ClassName"
  NORETURN: 'noreturn',
  INLINE: 'inline',
  VARARGS: 'varargs',
  PURE: 'pure',
  LEAF: 'leaf',
} as const;

export type StandardTagType = typeof TAG_TYPES[keyof typeof TAG_TYPES];

/**
 * Method tag modifiers — appended to class name in data field
 */
export const METHOD_MODIFIERS = {
  STATIC: 'static',
  CONSTRUCTOR: 'ctor',
  DESTRUCTOR: 'dtor',
} as const;

// =============================================================================
// Batch Tag Command
// =============================================================================

export interface BatchTagSymbolsCommand extends BaseCommand {
  command: 'batch_tag_symbols';
  params: {
    operations: Array<{
      address: string;
      tag: SymbolTag;
      action: 'add' | 'remove';
    }>;
  };
}

// =============================================================================
// Symbol Navigation
// =============================================================================

export interface GetSymbolAfterCommand extends BaseCommand {
  command: 'get_symbol_after';
  params: {
    address: string;
    count?: number;
  };
}

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_COMMAND_TIMEOUT = 30000; // 30 seconds
export const DEFAULT_ANALYSIS_TIMEOUT = 300000; // 5 minutes
export const WORKER_POLL_INTERVAL = 100; // 100ms
export const HEARTBEAT_INTERVAL = 5000; // 5 seconds
export const WORKER_STARTUP_TIMEOUT = 60000; // 1 minute
