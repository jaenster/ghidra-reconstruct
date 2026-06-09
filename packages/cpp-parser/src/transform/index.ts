/**
 * AST Transformation Module
 *
 * Provides utilities for immutable AST transformations including:
 * - Base transformer interface and combinators
 * - Transformation pipelines for composing transformers
 * - Built-in transformers for common operations (rename, simplify)
 */

// Core transformer utilities
export {
  // Types
  type Transformer,
  type TransformOptions,
  type TransformResult,

  // Core functions
  createTransformer,
  createKindTransformer,
  transform,
  transformWithTracking,

  // Node utilities
  cloneNode,
  updateNode,
  nodesEqual,
  replaceNode,
  filterNodes,

  // Combinators
  identity,
  sequence,
  when,
  firstMatch,
  fixpoint,
} from './transformer.js';

// Pipeline utilities
export {
  // Types
  type TransformStep,
  type PipelineResult,
  type StepResult,
  type PipelineExecutionOptions,
  type InjectionCollectorInterface,

  // Pipeline class and builder
  TransformPipeline,
  createPipeline,
  pipelineFromTransformers,
  createFixpointPipeline,
  createParallelPipeline,
} from './pipeline.js';

// Built-in transformers
export {
  // Rename transformer
  type RenameMap,
  type RenameOptions,
  type RenameContext,
  createRenameTransformer,
  rename,
  renameSingle,
  renameWith,
  renameGhidraFunctions,
  renameGhidraVariables,
  autoRenameGhidra,
  extractRenameableIdentifiers,
} from './builtins/rename.js';

export {
  // Simplify transformer
  type SimplifyOptions,
  createSimplifyTransformer,
  simplify,
  constantFold,
  algebraicSimplify,
  booleanSimplify,
  removeParens,
  createConstantFoldingTransformer,
  createAlgebraicSimplificationTransformer,
  createBooleanSimplificationTransformer,
  createRemoveParensTransformer,
} from './builtins/simplify.js';

export {
  // Ghidra-specific transforms
  type NameContext,
  type GhidraCleanupOptions,
  isGhidraGeneratedName,
  extractAddressFromName,
  suggestBetterName,
  cleanGhidraNames,
  removeRedundantCasts,
  simplifyPointerArithmetic,
  simplifyBooleanExpressions,
  simplifyNullChecks,
  addAddressComments,
  ghidraCleanup,
  ghidraQuickClean,
  ghidraFullClean,
} from './builtins/ghidra.js';

// Plugin system
export * from './plugins/index.js';
