/**
 * Ghidra Integration API
 *
 * High-level functions for transforming Ghidra decompiler output.
 * This is the main entry point for MCP integration.
 */

import { parse, ParserError } from './parser/index.js';
import { emit, CppEmitter, type EmitStyle, GOOGLE_STYLE, DEFAULT_STYLE, LLVM_STYLE, GNU_STYLE, MICROSOFT_STYLE } from './emit/index.js';
import {
  ghidraCleanup,
  ghidraQuickClean,
  ghidraFullClean,
  sequence,
  simplify,
  type GhidraCleanupOptions,
  type Transformer,
  type RenameMap,
  rename,
  extractRenameableIdentifiers,
  isGhidraGeneratedName,
  TransformPipeline,
  pipelineFromTransformers,
  type PipelineResult,
  defaultRegistry,
  type PipelineOptions,
} from './transform/index.js';
import type { TranslationUnit, FunctionDecl, Identifier, ASTNode } from './ast/nodes.js';
import { NodeKind } from './ast/kinds.js';
import { traverseAST } from './ast/visitor.js';

// ============================================
// GHIDRA PREPROCESSING
// ============================================

/**
 * Pre-process raw Ghidra decompiler output to fix syntax that the C++ parser
 * cannot handle. This runs **before** `parse()` on the raw text.
 *
 * Fixes applied:
 * 1. `this` as parameter/variable name → `self`  (reserved keyword)
 * 2. `Type[N] name;`  → `Type name[N];`          (Ghidra array declaration quirk)
 * 3. `Type[N]` in parameter lists → `Type*`       (Ghidra array-in-param quirk)
 * 4. Literal `\n` in `//` comments → actual newlines with `//` continuation
 */
export function preprocessGhidraCode(code: string): string {
  let result = code;

  // Fix 4: Literal \n in // comments → multi-line comments
  // Split each line, check for // comment containing \n, expand to multiple // lines
  result = result.replace(/^(.*\/\/.*)$/gm, (line) => {
    const commentStart = findLineCommentStart(line);
    if (commentStart === -1 || !line.includes('\\n', commentStart)) return line;
    const prefix = line.slice(0, commentStart);
    const comment = line.slice(commentStart + 2); // skip "//"
    const indent = prefix.match(/^(\s*)/)?.[1] ?? '';
    const parts = comment.split('\\n');
    return parts.map((part, i) => i === 0 ? `${prefix}// ${part.trimStart()}` : `${indent}// ${part.trimStart()}`).join('\n');
  });

  // Fix 1: Ghidra uses 'this' as a parameter name, but it's a reserved keyword in C++
  // Handle both pointer and non-pointer: "Type *this", "Type this"
  result = result.replace(/(\w+\s*\*\s*)this\b/g, '$1self');
  result = result.replace(/(\w+)\s+this\b/g, '$1 self');

  // Fix 2: Array declarations — Type[N] name; → Type name[N];
  // Matches: "  int[10] arr;" → "  int arr[10];"
  // Must be careful not to match things inside function calls or expressions
  result = result.replace(
    /^(\s*)(\w+)\[(\d+)\]\s+(\w+)\s*;/gm,
    '$1$2 $4[$3];'
  );

  // Fix 3: Array types in function parameters — Type[N] → Type*
  // This handles params like "int[10] param" → "int* param"
  // We need to match inside parenthesized parameter lists
  result = result.replace(
    /(\(|,)\s*(\w+)\[(\d+)\]\s+(\w+)/g,
    '$1 $2* $4'
  );

  return result;
}

/** Find the index of a // line comment start, skipping string literals */
function findLineCommentStart(line: string): number {
  let inString: string | null = null;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (ch === '\\') { i++; continue; }
    if (inString) {
      if (ch === inString) inString = null;
    } else if (ch === '"' || ch === "'") {
      inString = ch;
    } else if (ch === '/' && line[i + 1] === '/') {
      return i;
    }
  }
  return -1;
}

// ============================================
// HELPERS
// ============================================

/**
 * Resolve a style preset name to an EmitStyle object
 */
function resolveStylePreset(style: EmitStyle | string): EmitStyle {
  if (typeof style === 'object') return style;
  switch (style) {
    case 'google': return GOOGLE_STYLE;
    case 'llvm': return LLVM_STYLE;
    case 'gnu': return GNU_STYLE;
    case 'microsoft': return MICROSOFT_STYLE;
    default: return DEFAULT_STYLE;
  }
}

// ============================================
// MAIN API
// ============================================

/**
 * Options for transforming Ghidra decompiler output
 */
export interface TransformGhidraOptions {
  /** Transformation preset: 'quick', 'full', or 'custom'. Default: 'quick' */
  preset?: 'quick' | 'full' | 'custom';

  /** Custom cleanup options (when preset is 'custom') */
  cleanupOptions?: GhidraCleanupOptions;

  /** Additional simplifications (constant folding, etc.) */
  simplify?: boolean;

  /** Custom rename map to apply */
  renames?: RenameMap;

  /** Output style. Default: 'google' */
  style?: EmitStyle;

  /** Additional emit options */
  emitOptions?: Partial<EmitStyle>;

  /** Include original code as comment */
  includeOriginal?: boolean;

  /** Preserve parsing errors instead of throwing */
  tolerateErrors?: boolean;

  /** Use the plugin registry for transforms (default: false for backwards compat) */
  usePluginRegistry?: boolean;

  /** Plugin-specific options when using the registry */
  pluginOptions?: PipelineOptions;
}

/**
 * Result of transforming Ghidra output
 */
export interface TransformResult {
  /** The transformed C++ code */
  code: string;

  /** The parsed AST (for further processing) */
  ast: TranslationUnit;

  /** List of identifiers that were renamed */
  renamedIdentifiers: Array<{ original: string; renamed: string }>;

  /** Any warnings or issues encountered */
  warnings: string[];

  /** Whether parsing/transformation succeeded */
  success: boolean;

  /** Error message if success is false */
  error?: string;

  /** Preamble code (includes, inline helpers) from injection-aware plugins */
  preamble?: string;

  /** All identifiers referenced in the transformed AST */
  identifiers: Set<string>;

  /**
   * Names used as TYPES in the transformed AST. The visitor gives TypedefType
   * no children, so its name never reaches `identifiers` — but a body that
   * declares `pfnEHHandlerRoutine pExcHandler;` still needs that typedef
   * declared somewhere the file can see.
   */
  typeNames: Set<string>;
}

/**
 * Transform Ghidra decompiler output into cleaner C++ code
 *
 * @example
 * ```typescript
 * const result = transformGhidraCode(`
 *   void FUN_00401000(int param_1) {
 *     int local_8 = param_1;
 *     return;
 *   }
 * `);
 *
 * console.log(result.code);
 * // void func_00401000(int arg0) {
 * //   int var_8 = arg0;
 * //   return;
 * // }
 * ```
 */
export function transformGhidraCode(
  code: string,
  options: TransformGhidraOptions = {}
): TransformResult {
  const {
    preset = 'quick',
    cleanupOptions,
    simplify: doSimplify = false,
    renames,
    style = 'google',
    emitOptions = {},
    includeOriginal = false,
    tolerateErrors = false,
    usePluginRegistry = false,
    pluginOptions,
  } = options;

  const warnings: string[] = [];
  const renamedIdentifiers: Array<{ original: string; renamed: string }> = [];

  // Pre-process Ghidra quirks before parsing
  const preprocessed = preprocessGhidraCode(code);

  // Parse the code
  let ast: TranslationUnit;
  try {
    ast = parse(preprocessed);
  } catch (e) {
    if (tolerateErrors && e instanceof ParserError) {
      return {
        code,
        ast: { kind: NodeKind.TranslationUnit, declarations: [], location: {} as any, leadingTrivia: [], trailingTrivia: [] },
        renamedIdentifiers: [],
        warnings: [`Parse error: ${e.message}`],
        success: false,
        error: e.message,
        identifiers: new Set<string>(),
        typeNames: new Set<string>(),
      };
    }
    throw e;
  }

  // Build transformer chain
  let transformedAst: TranslationUnit;
  let preamble: string | undefined;

  if (usePluginRegistry) {
    // Use the plugin registry for transforms
    const pipelineOpts: PipelineOptions = {
      preset,
      ...pluginOptions,
    };

    const pipeline = defaultRegistry.createPipeline<TranslationUnit>(pipelineOpts);
    const result = pipeline.execute(ast);
    transformedAst = result.ast;
    preamble = result.preamble;

    // Apply custom renames if provided
    if (renames && Object.keys(renames).length > 0) {
      transformedAst = rename(renames as Record<string, string>)(transformedAst) as TranslationUnit;
      for (const [original, renamed] of Object.entries(renames)) {
        renamedIdentifiers.push({ original, renamed });
      }
    }
  } else {
    // Legacy transform chain (for backwards compatibility)
    const transforms: Transformer[] = [];

    // Apply preset or custom cleanup
    switch (preset) {
      case 'quick':
        transforms.push(ghidraQuickClean);
        break;
      case 'full':
        transforms.push(ghidraFullClean);
        break;
      case 'custom':
        if (cleanupOptions) {
          transforms.push(ghidraCleanup(cleanupOptions));
        }
        break;
    }

    // Apply additional simplifications
    if (doSimplify) {
      transforms.push(simplify());
    }

    // Apply custom renames
    if (renames && Object.keys(renames).length > 0) {
      transforms.push(rename(renames as Record<string, string>));

      // Track what was renamed
      for (const [original, renamed] of Object.entries(renames)) {
        renamedIdentifiers.push({ original, renamed });
      }
    }

    // Apply all transforms
    const transformer = sequence(...transforms);
    transformedAst = transformer(ast) as TranslationUnit;
  }

  // Track auto-renames from Ghidra cleanup
  const originalNames = new Set<string>();
  const transformedNames = new Map<string, string>();

  for (const node of traverseAST(ast)) {
    if (node.kind === NodeKind.Identifier) {
      const name = (node as Identifier).name;
      if (isGhidraGeneratedName(name)) {
        originalNames.add(name);
      }
    }
  }

  const identifiers = new Set<string>();
  const typeNames = new Set<string>();
  for (const node of traverseAST(transformedAst)) {
    if (node.kind === NodeKind.Identifier) {
      const name = (node as Identifier).name;
      identifiers.add(name);
    } else if (node.kind === NodeKind.TypedefType) {
      const named = (node as { name?: { kind: NodeKind; name?: string } }).name;
      if (named && named.kind === NodeKind.Identifier && named.name) typeNames.add(named.name);
    }
  }

  // Emit code
  const stylePreset = resolveStylePreset(style);
  const emitter = new CppEmitter({
    ...stylePreset,
    ...emitOptions,
  });

  let outputCode = emitter.emit(transformedAst);

  // Optionally include original as comment
  if (includeOriginal) {
    const originalComment = code
      .split('\n')
      .map(line => `// ${line}`)
      .join('\n');
    outputCode = `/* Original Ghidra output:\n${originalComment}\n*/\n\n${outputCode}`;
  }

  return {
    code: outputCode,
    ast: transformedAst,
    renamedIdentifiers,
    warnings,
    success: true,
    preamble,
    identifiers,
    typeNames,
  };
}

/**
 * Analyze Ghidra code and suggest improvements
 */
export interface AnalysisResult {
  /** Auto-generated names that could be renamed */
  generatedNames: Array<{
    name: string;
    kind: 'function' | 'variable' | 'parameter' | 'label';
    suggested: string;
    address?: string;
  }>;

  /** Patterns detected that could be simplified */
  simplifiablePatterns: Array<{
    description: string;
    location: { line: number; column: number };
  }>;

  /** Estimated improvement if transforms are applied */
  improvementScore: number;
}

/**
 * Analyze Ghidra decompiler output without transforming it
 */
export function analyzeGhidraCode(code: string): AnalysisResult {
  const generatedNames: AnalysisResult['generatedNames'] = [];
  const simplifiablePatterns: AnalysisResult['simplifiablePatterns'] = [];

  let ast: TranslationUnit;
  try {
    ast = parse(code);
  } catch {
    return { generatedNames, simplifiablePatterns, improvementScore: 0 };
  }

  const seenNames = new Set<string>();

  for (const node of traverseAST(ast)) {
    // Find generated names
    if (node.kind === NodeKind.Identifier) {
      const name = (node as Identifier).name;
      if (isGhidraGeneratedName(name) && !seenNames.has(name)) {
        seenNames.add(name);

        let kind: 'function' | 'variable' | 'parameter' | 'label' = 'variable';
        if (name.startsWith('FUN_')) kind = 'function';
        else if (name.startsWith('LAB_')) kind = 'label';
        else if (name.startsWith('param_')) kind = 'parameter';

        const { suggestBetterName, extractAddressFromName } = require('./transform/index.js');
        generatedNames.push({
          name,
          kind,
          suggested: suggestBetterName(name) ?? name,
          address: extractAddressFromName(name) || undefined,
        });
      }
    }

    // Find simplifiable patterns
    if (node.kind === NodeKind.BinaryExpr) {
      const binary = node as any;
      // Check for x != 0 or x == 0
      if (binary.operator === '!=' || binary.operator === '==') {
        const isZeroComparison =
          (binary.left.kind === NodeKind.IntegerLiteral && binary.left.value === 0n) ||
          (binary.right.kind === NodeKind.IntegerLiteral && binary.right.value === 0n);

        if (isZeroComparison) {
          simplifiablePatterns.push({
            description: `Comparison with zero can be simplified: ${binary.operator === '!=' ? 'x != 0 -> x' : 'x == 0 -> !x'}`,
            location: { line: node.location.start.line, column: node.location.start.column },
          });
        }
      }
    }

    // Check for redundant casts
    if (node.kind === NodeKind.CStyleCastExpr) {
      const cast = node as any;
      if (cast.expression.kind === NodeKind.IntegerLiteral) {
        simplifiablePatterns.push({
          description: 'Cast of literal can potentially be removed',
          location: { line: node.location.start.line, column: node.location.start.column },
        });
      }
    }
  }

  // Calculate improvement score (0-100)
  const nameScore = Math.min(generatedNames.length * 5, 50);
  const patternScore = Math.min(simplifiablePatterns.length * 10, 50);
  const improvementScore = nameScore + patternScore;

  return { generatedNames, simplifiablePatterns, improvementScore };
}

/**
 * Extract all function declarations from Ghidra code
 */
export function extractFunctions(code: string): Array<{
  name: string;
  address?: string;
  parameters: Array<{ name: string; type: string }>;
  returnType: string;
  bodyLength: number;
}> {
  let ast: TranslationUnit;
  try {
    ast = parse(code);
  } catch {
    return [];
  }

  const functions: ReturnType<typeof extractFunctions> = [];

  for (const decl of ast.declarations) {
    if (decl.kind === NodeKind.FunctionDecl) {
      const fn = decl as FunctionDecl;
      const name = (fn.name as Identifier).name;

      functions.push({
        name,
        address: name.startsWith('FUN_') ? '0x' + name.slice(4) : undefined,
        parameters: fn.parameters.map(p => ({
          name: p.name?.name || '',
          type: emit(p.type),
        })),
        returnType: emit(fn.returnType),
        bodyLength: fn.body?.statements.length || 0,
      });
    }
  }

  return functions;
}

/**
 * Create a reusable transformation pipeline for batch processing
 */
export function createGhidraPipeline(options: TransformGhidraOptions = {}) {
  const {
    preset = 'quick',
    cleanupOptions,
    simplify: doSimplify = false,
    style = 'google',
    emitOptions = {},
  } = options;

  const steps: Array<{ name: string; transformer: Transformer }> = [];

  // Add cleanup step
  switch (preset) {
    case 'quick':
      steps.push({ name: 'ghidra-quick-clean', transformer: ghidraQuickClean });
      break;
    case 'full':
      steps.push({ name: 'ghidra-full-clean', transformer: ghidraFullClean });
      break;
    case 'custom':
      if (cleanupOptions) {
        steps.push({ name: 'ghidra-custom-clean', transformer: ghidraCleanup(cleanupOptions) });
      }
      break;
  }

  // Add simplify step
  if (doSimplify) {
    steps.push({ name: 'simplify', transformer: simplify() });
  }

  const pipeline = pipelineFromTransformers(
    steps.map(s => [s.name, s.transformer] as [string, Transformer])
  );

  const stylePreset = resolveStylePreset(style);
  const emitter = new CppEmitter({ ...stylePreset, ...emitOptions });

  return {
    /**
     * Transform a single piece of code
     */
    transform(code: string): TransformResult {
      return transformGhidraCode(code, options);
    },

    /**
     * Transform multiple pieces of code
     */
    transformBatch(codes: string[]): TransformResult[] {
      return codes.map(code => transformGhidraCode(code, options));
    },

    /**
     * Get the underlying pipeline for advanced use
     */
    getPipeline() {
      return pipeline;
    },

    /**
     * Get the emitter for advanced use
     */
    getEmitter() {
      return emitter;
    },
  };
}

// Re-export useful types and functions
export { parse, ParserError } from './parser/index.js';
export { emit, CppEmitter, type EmitStyle } from './emit/index.js';
export {
  ghidraCleanup,
  ghidraQuickClean,
  ghidraFullClean,
  isGhidraGeneratedName,
  extractAddressFromName,
  suggestBetterName,
} from './transform/index.js';
