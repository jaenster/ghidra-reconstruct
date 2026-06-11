/**
 * Transform Plugin System
 *
 * Provides a plugin architecture for extensible AST transformations.
 *
 * @example
 * ```typescript
 * import { defaultRegistry, createPlugin } from '@ghidra-mcp/cpp-parser';
 *
 * // Use the default registry with built-in plugins
 * const pipeline = defaultRegistry.createPipeline({ preset: 'full' });
 * const result = pipeline.execute(ast);
 *
 * // Or create a custom plugin
 * const myPlugin = createPlugin(
 *   'my-transform',
 *   'My Transform',
 *   'Does something useful',
 *   () => myTransformer
 * );
 * defaultRegistry.register(myPlugin);
 * ```
 */

// ============================================
// TYPES
// ============================================

export type {
  TransformPlugin,
  PluginOptions,
  InstructionInfo,
  AsmPatternMatcher,
  PipelineOptions,
  EnabledOptions,
  PluginRegistryEvent,
  PluginRegistryListener,
  TransformCacheKey,
  CachedTransformResult,
  CacheStats,
  CodeInjection,
  InjectionContext,
  InjectionTransformer,
} from './types.js';

// ============================================
// INJECTION SYSTEM
// ============================================

export {
  InjectionCollector,
  createInclude,
  createInlineFunction,
  createMacro,
  createTypedef,
} from './injection.js';

// ============================================
// REGISTRY
// ============================================

export {
  PluginRegistry,
  defaultRegistry,
  createPlugin,
  registerPlugins,
} from './registry.js';

// ============================================
// BUILT-IN PLUGINS: GHIDRA CLEANUP
// ============================================

export {
  cleanGhidraNamesPlugin,
  removeRedundantCastsPlugin,
  simplifyBooleanExpressionsPlugin,
  simplifyNullChecksPlugin,
  simplifyPointerArithmeticPlugin,
  addAddressCommentsPlugin,
  ghidraCleanupPlugins,
  type CleanNamesOptions,
} from './builtins/ghidra-cleanup.js';

// ============================================
// BUILT-IN PLUGINS: LOOP CANONICALIZATION
// ============================================

export {
  loopCanonicalizePlugin,
  type LoopCanonicalizeOptions,
} from './builtins/loop-canonicalize.js';

// ============================================
// BUILT-IN PLUGINS: ARRAY ACCESS
// ============================================

export {
  arrayAccessPlugin,
  type ArrayAccessOptions,
} from './builtins/array-access.js';

// ============================================
// BUILT-IN PLUGINS: STRUCT FIELD
// ============================================

export {
  structFieldPlugin,
  type StructFieldOptions,
  type StructLayout,
  type FieldInfo,
} from './builtins/struct-field.js';

// ============================================
// BUILT-IN PLUGINS: MEMORY PATTERNS
// ============================================

export {
  memoryPatternsPlugin,
  type MemoryPatternsOptions,
} from './builtins/memory-patterns.js';

// ============================================
// BUILT-IN PLUGINS: MAGIC DIVISION
// ============================================

export {
  magicDivisionPlugin,
  type MagicDivisionOptions,
} from './builtins/magic-division.js';

// ============================================
// BUILT-IN PLUGINS: TERNARY SIMPLIFICATION
// ============================================

export {
  ternarySimplifyPlugin,
  type TernarySimplifyOptions,
} from './builtins/ternary-simplify.js';

// ============================================
// BUILT-IN PLUGINS: VTABLE CALLS
// ============================================

export {
  vtableCallPlugin,
  type VTableCallOptions,
  type VTableInfo,
} from './builtins/vtable-calls.js';

// ============================================
// BUILT-IN PLUGINS: SWITCH RECONSTRUCTION
// ============================================

export {
  switchReconstructPlugin,
  type SwitchReconstructOptions,
} from './builtins/switch-reconstruct.js';

// ============================================
// BUILT-IN PLUGINS: NULLPTR CLEANUP
// ============================================

export {
  nullptrCleanupPlugin,
  type NullptrCleanupOptions,
} from './builtins/nullptr-cleanup.js';

// ============================================
// BUILT-IN PLUGINS: SIGNED LITERAL CLEANUP
// ============================================

export {
  signedLiteralPlugin,
  type SignedLiteralOptions,
} from './builtins/signed-literal.js';

// ============================================
// BUILT-IN PLUGINS: BOOLEAN CLEANUP
// ============================================

export {
  booleanCleanupPlugin,
  type BooleanCleanupOptions,
} from './builtins/boolean-cleanup.js';

// ============================================
// BUILT-IN PLUGINS: BOILERPLATE CLEANUP
// ============================================

export {
  boilerplateCleanupPlugin,
  type BoilerplateCleanupOptions,
} from './builtins/boilerplate-cleanup.js';

// ============================================
// BUILT-IN PLUGINS: INCREMENT SIMPLIFICATION
// ============================================

export {
  incrementSimplifyPlugin,
  type IncrementSimplifyOptions,
} from './builtins/increment-simplify.js';

// ============================================
// BUILT-IN PLUGINS: FOURCC LITERAL
// ============================================

export {
  fourccLiteralPlugin,
  type FourCCOptions,
} from './builtins/fourcc-literal.js';

// ============================================
// BUILT-IN PLUGINS: TYPE NORMALIZATION
// ============================================

export {
  typeNormalizePlugin,
  type TypeNormalizeOptions,
} from './builtins/type-normalize.js';

// ============================================
// BUILT-IN PLUGINS: CONCAT TRANSFORM
// ============================================

export {
  concatTransformPlugin,
  type ConcatTransformOptions,
} from './builtins/concat-transform.js';

// ============================================
// BUILT-IN PLUGINS: GOTO CLEANUP
// ============================================

export {
  gotoCleanupPlugin,
  type GotoCleanupOptions,
} from './builtins/goto-cleanup/index.js';

// ============================================
// BUILT-IN PLUGINS: LOOP ROTATION UNDO
// ============================================

export {
  loopRotationUndoPlugin,
} from './builtins/loop-rotation-undo.js';

// ============================================
// BUILT-IN PLUGINS: REDUNDANT PAREN CLEANUP
// ============================================

export {
  redundantParenCleanupPlugin,
  type RedundantParenCleanupOptions,
} from './builtins/redundant-paren-cleanup.js';

// ============================================
// BUILT-IN PLUGINS: SHORT-CIRCUIT FOLD
// ============================================

export {
  shortCircuitFoldPlugin,
} from './builtins/short-circuit-fold.js';

// ============================================
// BUILT-IN PLUGINS: DEAD BRANCH CLEANUP
// ============================================

export {
  deadBranchCleanupPlugin,
  type DeadBranchCleanupOptions,
} from './builtins/dead-branch-cleanup.js';

// ============================================
// BUILT-IN PLUGINS: REDUNDANT NEGATION
// ============================================

export {
  redundantNegationPlugin,
  type RedundantNegationOptions,
} from './builtins/redundant-negation.js';

// ============================================
// BUILT-IN PLUGINS: SBB BRANCHLESS CONDITIONAL
// ============================================

export {
  sbbBranchlessPlugin,
  type SbbBranchlessOptions,
} from './builtins/sbb-branchless.js';

export {
  branchlessSelectPlugin,
  type BranchlessSelectOptions,
} from './builtins/branchless-select.js';

export {
  earlyReturnPlugin,
  type EarlyReturnOptions,
} from './builtins/early-return.js';

export {
  commaExpandPlugin,
  type CommaExpandOptions,
} from './builtins/comma-expand.js';

export {
  arrayFillCollapsePlugin,
  type ArrayFillCollapseOptions,
} from './builtins/array-fill-collapse.js';

// ============================================
// BUILT-IN PLUGINS: DECLARATION-INITIALIZATION MERGE
// ============================================

export {
  declInitMergePlugin,
  type DeclInitMergeOptions,
} from './builtins/decl-init-merge.js';

// ============================================
// BUILT-IN PLUGINS: DECLARATION SCOPE SINK
// ============================================

export {
  declScopeSinkPlugin,
  type DeclScopeSinkOptions,
} from './builtins/decl-scope-sink.js';

// ============================================
// BUILT-IN PLUGINS: PHI-NODE TERNARY
// ============================================

export {
  phiNodeTernaryPlugin,
  type PhiNodeTernaryOptions,
} from './builtins/phi-node-ternary.js';

// ============================================
// BUILT-IN PLUGINS: VOID RETURN CLEANUP
// ============================================

export {
  voidReturnCleanupPlugin,
  type VoidReturnCleanupOptions,
} from './builtins/void-return-cleanup.js';

// ============================================
// BUILT-IN PLUGINS: FUNCTION POINTER LITERAL
// ============================================

export {
  funcPtrLiteralPlugin,
  type FuncPtrLiteralOptions,
} from './builtins/func-ptr-literal.js';

// ============================================
// BUILT-IN PLUGINS: PRNG TRANSFORM
// ============================================

export {
  prngTransformPlugin,
  type PrngTransformOptions,
} from './builtins/prng-transform.js';

// ============================================
// BUILT-IN PLUGINS: PRNG TEMP COLLAPSE
// ============================================

export {
  prngTempCollapsePlugin,
} from './builtins/prng-temp-collapse.js';

// ============================================
// BUILT-IN PLUGINS: BITFIELD ACCESS
// ============================================

export {
  bitfieldAccessPlugin,
  type BitfieldAccessOptions,
  type BitfieldCatalog,
  type BitfieldEntry,
} from './builtins/bitfield-access.js';

// ============================================
// BUILT-IN PLUGINS: INDIRECT CALL CLEANUP
// ============================================

export {
  indirectCallCleanupPlugin,
  type IndirectCallCleanupOptions,
} from './builtins/indirect-call-cleanup.js';

// ============================================
// BUILT-IN PLUGINS: METHOD CALL REWRITE
// ============================================

export {
  methodCallRewritePlugin,
  type MethodCallRewriteOptions,
  type MethodCallMapping,
} from './builtins/method-call-rewrite.js';

// ============================================
// BUILT-IN PLUGINS: POINTER CAST NORMALIZE
// ============================================

export {
  pointerCastNormalizePlugin,
} from './builtins/pointer-cast-normalize.js';

// ============================================
// ALL BUILT-IN PLUGINS
// ============================================

import { ghidraCleanupPlugins } from './builtins/ghidra-cleanup.js';
import { loopCanonicalizePlugin } from './builtins/loop-canonicalize.js';
import { arrayAccessPlugin } from './builtins/array-access.js';
import { structFieldPlugin } from './builtins/struct-field.js';
import { memoryPatternsPlugin } from './builtins/memory-patterns.js';
import { magicDivisionPlugin } from './builtins/magic-division.js';
import { ternarySimplifyPlugin } from './builtins/ternary-simplify.js';
import { vtableCallPlugin } from './builtins/vtable-calls.js';
import { switchReconstructPlugin } from './builtins/switch-reconstruct.js';
import { nullptrCleanupPlugin } from './builtins/nullptr-cleanup.js';
import { signedLiteralPlugin } from './builtins/signed-literal.js';
import { booleanCleanupPlugin } from './builtins/boolean-cleanup.js';
import { boilerplateCleanupPlugin } from './builtins/boilerplate-cleanup.js';
import { incrementSimplifyPlugin } from './builtins/increment-simplify.js';
import { fourccLiteralPlugin } from './builtins/fourcc-literal.js';
import { typeNormalizePlugin } from './builtins/type-normalize.js';
import { concatTransformPlugin } from './builtins/concat-transform.js';
import { redundantNegationPlugin } from './builtins/redundant-negation.js';
import { sbbBranchlessPlugin } from './builtins/sbb-branchless.js';
import { branchlessSelectPlugin } from './builtins/branchless-select.js';
import { earlyReturnPlugin } from './builtins/early-return.js';
import { commaExpandPlugin } from './builtins/comma-expand.js';
import { arrayFillCollapsePlugin } from './builtins/array-fill-collapse.js';
import { funcPtrLiteralPlugin } from './builtins/func-ptr-literal.js';
import { prngTransformPlugin } from './builtins/prng-transform.js';
import { prngTempCollapsePlugin } from './builtins/prng-temp-collapse.js';
import { bitfieldAccessPlugin } from './builtins/bitfield-access.js';
import { indirectCallCleanupPlugin } from './builtins/indirect-call-cleanup.js';
import { methodCallRewritePlugin } from './builtins/method-call-rewrite.js';
import { pointerCastNormalizePlugin } from './builtins/pointer-cast-normalize.js';
import { gotoCleanupPlugin, getGotoCleanupStats, resetGotoCleanupStats } from './builtins/goto-cleanup/index.js';
import { loopRotationUndoPlugin } from './builtins/loop-rotation-undo.js';
import { redundantParenCleanupPlugin } from './builtins/redundant-paren-cleanup.js';
import { shortCircuitFoldPlugin } from './builtins/short-circuit-fold.js';
import { deadBranchCleanupPlugin } from './builtins/dead-branch-cleanup.js';
import { declInitMergePlugin } from './builtins/decl-init-merge.js';
import { declOrderFixPlugin } from './builtins/decl-order-fix.js';
import { declScopeSinkPlugin } from './builtins/decl-scope-sink.js';
import { phiNodeTernaryPlugin } from './builtins/phi-node-ternary.js';
import { voidReturnCleanupPlugin } from './builtins/void-return-cleanup.js';
export { getGotoCleanupStats, resetGotoCleanupStats } from './builtins/goto-cleanup/index.js';
export type { GotoCleanupStats } from './builtins/goto-cleanup/index.js';
import type { TransformPlugin } from './types.js';

/**
 * All built-in plugins in recommended registration order
 */
export const allBuiltinPlugins: TransformPlugin[] = [
  indirectCallCleanupPlugin, // Cleanup: strip jumptable warnings, clean fn-ptr casts (priority 5)
  ...ghidraCleanupPlugins,
  typeNormalizePlugin,         // Cleanup: uint → uint32_t, undefined4 → auto/uint32_t (priority 15)
  pointerCastNormalizePlugin, // Cleanup: (int)&expr → (uintptr_t)&expr (priority 16)
  concatTransformPlugin,      // Cleanup: CONCAT31(a, b) → (a << 8) | b (priority 20)
  fourccLiteralPlugin,        // Cleanup: (char[4])L'\x...' → "abcd" (priority 25)
  methodCallRewritePlugin,    // C++ method call rewrite (priority 25, disabled by default)
  nullptrCleanupPlugin,       // Cleanup: (Type*)0x0 → nullptr (priority 25)
  signedLiteralPlugin,        // Cleanup: 0xffffffff → -1 (priority 30)
  incrementSimplifyPlugin,    // Cleanup: x = x + 1 → x++ (priority 35)
  redundantNegationPlugin,    // Cleanup: x + -y → x - y (priority 40)
  bitfieldAccessPlugin,       // Cleanup: field_0xNN & MASK → bitfieldName (priority 45)
  sbbBranchlessPlugin,        // Cleanup: -(uint32_t)(cond) & addr → cond ? addr : nullptr (priority 42)
  branchlessSelectPlugin,     // Cleanup: (cond - 1 & mask) + off → cond ? off : off+mask (priority 43)
  earlyReturnPlugin,          // Readability: flatten nested if(C){...}return X; → if(!C)return X; ... (priority 60)
  commaExpandPlugin,          // Readability: lower comma/short-circuit side effects into statements + guards (priority 13)
  arrayFillCollapsePlugin,    // Cleanup: collapse arr[i]=0 runs into memset (priority 50)
  gotoCleanupPlugin,          // Cleanup: if (cond) goto L; ... L: stmt; → if (!cond) { ... } stmt;
  redundantParenCleanupPlugin, // Cleanup: if((x)) → if(x) (priority 56)
  loopRotationUndoPlugin,     // Cleanup: if(C){do{...}while(C)} → while(C){...} (priority 56)
  shortCircuitFoldPlugin,     // Cleanup: if(a){if(b){...}} → if(a&&b){...} (priority 57)
  deadBranchCleanupPlugin,    // Cleanup: if(true)/if(false) dead branch elimination (priority 58)
  declInitMergePlugin,        // Cleanup: int x; x = expr; → int x = expr; (priority 60)
  declOrderFixPlugin,         // Cleanup: reorder merged decls to respect initializer deps (priority 61)
  declScopeSinkPlugin,        // Cleanup: sink decls into single-use scope (priority 62)
  phiNodeTernaryPlugin,       // Cleanup: int x; if(c){x=a;}else{x=b;} → int x = c?a:b; (priority 63)
  boilerplateCleanupPlugin,   // Cleanup: Remove security cookies, simplify ERROR assertions (priority 500)
  vtableCallPlugin,           // C++ vtable patterns (early)
  switchReconstructPlugin,    // Control flow reconstruction
  magicDivisionPlugin,        // Compiler optimizations
  loopCanonicalizePlugin,
  arrayAccessPlugin,
  structFieldPlugin,
  booleanCleanupPlugin,       // Cleanup: expr != false → expr (priority 50)
  ternarySimplifyPlugin,      // Boolean cleanup
  funcPtrLiteralPlugin,        // Cleanup: 0x5011f0 → FunctionName (priority 95)
  prngTransformPlugin,        // Pattern detection: PRNG (priority 80)
  prngTempCollapsePlugin,     // Cleanup: collapse PRNG temp variables (priority 85)
  voidReturnCleanupPlugin,    // Cleanup: trailing return; in void functions (priority 90)
  memoryPatternsPlugin,       // Pattern detection (late)
];

// ============================================
// REGISTER BUILT-IN PLUGINS
// ============================================

import { defaultRegistry, registerPlugins } from './registry.js';

// Auto-register all built-in plugins
registerPlugins(defaultRegistry, allBuiltinPlugins);
