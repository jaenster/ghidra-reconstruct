/**
 * Allocation Macros Plugin
 *
 * Every Fog allocation in 1.14d passes the source file and line of the call, the
 * expansion of Blizzard's allocation macros:
 *
 *     Fog::Memory::AllocClientMemory(0x12c, ".\\BnMessQueue.cpp", 0x37, 0)
 *     Fog::Memory::FreeServerMemory(pPool, pUnit, ".\\SUnit.cpp", 0x2f1, 0)
 *
 * The call is folded to a macro that names the allocator and supplies the
 * trailing 0, keeping the original's file string and line constant as written:
 *
 *     AllocClientMemory(n, file, line, 0)          -> D2_ALLOC_AT(n, file, line)
 *     FreeClientMemory(p, file, line, 0)           -> D2_FREE_AT(p, file, line)
 *     ReAllocClientMemory(p, n, file, line, 0)     -> D2_REALLOC_AT(p, n, file, line)
 *     AllocServerMemory(pool, n, file, line, 0)    -> D2_ALLOC_POOL_AT(pool, n, file, line)
 *     FreeServerMemory(pool, p, file, line, 0)     -> D2_FREE_POOL_AT(pool, p, file, line)
 *     ReAllocServerMemory(pool, p, n, ...)         -> D2_REALLOC_POOL_AT(pool, p, n, file, line)
 *
 * Each macro expands to exactly the call the original makes: the same arguments
 * in the same order, the file and line being the binary's values (the
 * reconstruction's own `__FILE__`/`__LINE__` would change what is pushed).
 *
 * An allocation cast to a struct whose Ghidra size is exactly the literal size
 * becomes `D2_NEW_AT(T, file, line)` / `D2_NEW_POOL_AT(pool, T, file, line)`. That
 * fold is a claim about the layout, so each type it is made for gets a
 * static_assert beside the macros: on a 32-bit build sizeof(T) must still be the
 * size the binary allocated. The guard on the pointer size is deliberate - a
 * 64-bit build changes struct sizes and the macro is then the CORRECT spelling,
 * where the literal would not be.
 *
 * A pool argument is kept as written, `nullptr` included: a null pool is the
 * client allocator chosen explicitly, and folding it away would hide which
 * allocator the original called.
 *
 * Only a site whose file is a string literal, whose line is an integer literal and
 * whose trailing argument is literal 0 is folded. Anything else - a computed file,
 * a forwarded line, a non-zero flag - is left exactly as it stands and counted.
 *
 * The macro definitions are emitted like D2_ASSERT's (`boilerplate-cleanup`): a
 * per-unit preamble, each macro under its own `#ifndef`, naming the callee the
 * folded call site named. That spelling is a reference resolved like every other
 * one in the unit, so a symbol moved in Ghidra moves the macro with it. The pass
 * runs after the type passes and before `enclosing-namespace-strip`, so the name
 * it records is still the qualified one, valid anywhere in the unit.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CallExpr, CStyleCastExpr, Expression, Identifier, IntegerLiteralExpr,
  PointerType, QualifiedId, TypeNode, TypedefType, ElaboratedType,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions, InjectionContext } from '../types.js';
import { createMacroCall } from './boilerplate-cleanup.js';

export interface AllocMacrosOptions extends PluginOptions {
  /** Fold allocation calls into the D2_* macros (default: true). */
  allocationMacros?: boolean;
  /** Aggregate name -> Ghidra size in bytes. Without it no site becomes D2_NEW_AT. */
  aggregateSizes?: Record<string, number>;
  /** The aggregates that are unions; D2_NEW_AT is for structs only. */
  unionNames?: readonly string[];
  /** Typedef name -> its target spelling, to see through `typedef struct X X_t`. */
  typedefTargets?: Record<string, string>;
}

type AllocMacro =
  | 'D2_ALLOC_AT' | 'D2_FREE_AT' | 'D2_REALLOC_AT'
  | 'D2_ALLOC_POOL_AT' | 'D2_FREE_POOL_AT' | 'D2_REALLOC_POOL_AT';

interface AllocCallee {
  macro: AllocMacro;
  /** Arguments before the file, line and trailing 0. */
  kept: number;
  /** Index of the size argument, for the D2_NEW_AT fold. */
  sizeIndex?: number;
  /** Parameter names of the macro before the file and line, in order. */
  params: string[];
}

/** Keyed by the callee's own name; the namespace is checked separately. */
const ALLOC_CALLEES: Record<string, AllocCallee> = {
  AllocClientMemory: { macro: 'D2_ALLOC_AT', kept: 1, sizeIndex: 0, params: ['size'] },
  FreeClientMemory: { macro: 'D2_FREE_AT', kept: 1, params: ['p'] },
  ReAllocClientMemory: { macro: 'D2_REALLOC_AT', kept: 2, params: ['p', 'size'] },
  AllocServerMemory: { macro: 'D2_ALLOC_POOL_AT', kept: 2, sizeIndex: 1, params: ['pPool', 'size'] },
  FreeServerMemory: { macro: 'D2_FREE_POOL_AT', kept: 2, params: ['pPool', 'p'] },
  ReAllocServerMemory: { macro: 'D2_REALLOC_POOL_AT', kept: 3, params: ['pPool', 'p', 'size'] },
};

/** Why a call to an allocator was left alone. */
export type AllocUntouchedReason =
  | 'arity'
  | 'file-not-literal'
  | 'line-not-literal'
  | 'trailing-not-zero'
  | 'argument-not-macro-safe';

/** Counts of what the pass did, read by the tests and the dry-run census. */
export interface AllocMacroStats {
  /** Folded sites per macro, D2_NEW_AT and D2_NEW_POOL_AT included. */
  folded: Record<string, number>;
  /** Allocator calls left as they were, by reason. */
  untouched: Record<AllocUntouchedReason, number>;
  /** Casts to a known struct whose literal size was NOT the struct's size. */
  newSizeMismatch: number;
}

function emptyStats(): AllocMacroStats {
  return {
    folded: {},
    untouched: {
      'arity': 0, 'file-not-literal': 0, 'line-not-literal': 0,
      'trailing-not-zero': 0, 'argument-not-macro-safe': 0,
    },
    newSizeMismatch: 0,
  };
}

let stats = emptyStats();

export function getAllocMacroStats(): AllocMacroStats {
  return stats;
}

export function resetAllocMacroStats(): void {
  stats = emptyStats();
}

function bump(macro: string, by = 1): void {
  stats.folded[macro] = (stats.folded[macro] ?? 0) + by;
}

// ============================================
// AST HELPERS
// ============================================

function unwrapParens(expr: Expression): Expression {
  while (expr.kind === NodeKind.ParenExpr) expr = (expr as any).expression;
  return expr;
}

/** Parens and C-style casts off: `(char *)".\\X.cpp"` is still the literal. */
function unwrapParensAndCasts(expr: Expression): Expression {
  let e = unwrapParens(expr);
  while (e.kind === NodeKind.CStyleCastExpr) e = unwrapParens((e as CStyleCastExpr).expression);
  return e;
}

function integerLiteral(expr: Expression): bigint | undefined {
  const e = unwrapParensAndCasts(expr);
  return e.kind === NodeKind.IntegerLiteral ? (e as IntegerLiteralExpr).value : undefined;
}

function isPlainStringLiteral(expr: Expression): boolean {
  const e = unwrapParensAndCasts(expr);
  return e.kind === NodeKind.StringLiteral && !(e as any).prefix;
}

/**
 * The callee spelled the way the call site spells it, or undefined if it is not
 * one of the Fog allocators: the name must be one of them and its scope either
 * absent or a `Memory` namespace (Fog's, however much of it is written out).
 */
function allocCallee(callee: Expression): { callee: AllocCallee; spelling: string } | undefined {
  let parts: string[];
  let global = false;
  if (callee.kind === NodeKind.Identifier) {
    parts = [(callee as Identifier).name];
  } else if (callee.kind === NodeKind.QualifiedId) {
    const q = callee as QualifiedId;
    if (q.name.kind !== NodeKind.Identifier) return undefined;
    parts = [];
    for (const seg of q.qualifier) {
      if (seg.kind !== NodeKind.Identifier) return undefined;
      parts.push((seg as Identifier).name);
    }
    parts.push((q.name as Identifier).name);
    global = q.isGlobal;
  } else {
    return undefined;
  }
  const name = parts[parts.length - 1];
  const entry = Object.prototype.hasOwnProperty.call(ALLOC_CALLEES, name) ? ALLOC_CALLEES[name] : undefined;
  if (!entry) return undefined;
  if (parts.length > 1 && parts[parts.length - 2] !== 'Memory') return undefined;
  return { callee: entry, spelling: (global ? '::' : '') + parts.join('::') };
}

/**
 * A macro argument is split on top-level commas by the preprocessor, which knows
 * nothing of templates or braces. An argument that could carry one stays a call.
 */
function macroSafe(arg: Expression): boolean {
  if (arg.kind === NodeKind.CommaExpr) return false;
  for (const n of traverseAST(arg as ASTNode)) {
    if (n.kind === NodeKind.TemplateType && ((n as any).arguments?.length ?? 0) > 1) return false;
    if (n.kind === NodeKind.InitListExpr || n.kind === NodeKind.LambdaExpr) return false;
  }
  return true;
}

/** A cast's target as a bare root-scope name: `T*`, `::T*`, `struct T*`. */
function pointeeName(type: TypeNode): { name: string; node: TypeNode } | undefined {
  if (type.kind !== NodeKind.PointerType) return undefined;
  const ptr = type as PointerType;
  if (ptr.qualifiers.length > 0) return undefined;
  const pointee = ptr.pointee;
  let nameNode: Identifier | QualifiedId | undefined;
  if (pointee.kind === NodeKind.TypedefType) nameNode = (pointee as TypedefType).name;
  else if (pointee.kind === NodeKind.ElaboratedType) {
    const el = pointee as ElaboratedType;
    if (el.keyword !== 'struct' && el.keyword !== 'class') return undefined;
    nameNode = el.name;
  }
  if (!nameNode) return undefined;
  if (nameNode.kind === NodeKind.Identifier) return { name: (nameNode as Identifier).name, node: pointee };
  const q = nameNode as QualifiedId;
  if (q.qualifier.length === 0 && q.name.kind === NodeKind.Identifier) {
    return { name: (q.name as Identifier).name, node: pointee };
  }
  return undefined;
}

/** The struct a type name denotes, through one typedef, if Ghidra knows its size. */
function structSize(name: string, opts: AllocMacrosOptions): number | undefined {
  const sizes = opts.aggregateSizes ?? {};
  const unions = new Set(opts.unionNames ?? []);
  const own = (n: string): number | undefined =>
    Object.prototype.hasOwnProperty.call(sizes, n) && !unions.has(n) ? sizes[n] : undefined;
  const direct = own(name);
  if (direct !== undefined) return direct;
  const target = opts.typedefTargets?.[name]?.replace(/^(struct|class)\s+/, '').trim();
  return target && /^\w+$/.test(target) ? own(target) : undefined;
}

// ============================================
// TRANSFORMER
// ============================================

/** What one body folded: the callee each macro names, and the D2_NEW_AT types. */
export class AllocMacroUse {
  readonly callees = new Map<AllocMacro, string>();
  readonly newTypes = new Map<string, number>();
  newUsed = false;
  newPoolUsed = false;

  /** One macro names one callee; a second spelling in the same body stays a call. */
  willAccept(macro: AllocMacro, spelling: string): boolean {
    const have = this.callees.get(macro);
    return have === undefined || have === spelling;
  }
}

interface FoldedAlloc {
  macro: AllocMacro;
  size: Expression;
  pool?: Expression;
  file: Expression;
  line: Expression;
}

function createAllocTransformer(opts: AllocMacrosOptions, use: AllocMacroUse): Transformer {
  // The macro calls this pass made from an allocation, so the cast above one
  // (visited after it - the walk is post-order) can turn it into D2_NEW_AT.
  const folded = new WeakMap<ASTNode, FoldedAlloc>();

  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind === NodeKind.CallExpr) {
        const call = node as CallExpr;
        const hit = allocCallee(call.callee);
        if (!hit) return undefined;
        const { callee, spelling } = hit;
        const args = call.arguments;
        if (args.length !== callee.kept + 3) { stats.untouched['arity']++; return undefined; }
        if (!isPlainStringLiteral(args[callee.kept])) { stats.untouched['file-not-literal']++; return undefined; }
        if (integerLiteral(args[callee.kept + 1]) === undefined) { stats.untouched['line-not-literal']++; return undefined; }
        if (integerLiteral(args[callee.kept + 2]) !== 0n) { stats.untouched['trailing-not-zero']++; return undefined; }
        const kept = args.slice(0, callee.kept);
        if (!kept.every(macroSafe) || !use.willAccept(callee.macro, spelling)) {
          stats.untouched['argument-not-macro-safe']++;
          return undefined;
        }
        use.callees.set(callee.macro, spelling);
        bump(callee.macro);
        const file = args[callee.kept];
        const line = args[callee.kept + 1];
        const macroCall = createMacroCall(callee.macro, [...kept, file, line], call);
        macroCall.leadingTrivia = call.leadingTrivia ?? [];
        macroCall.trailingTrivia = call.trailingTrivia ?? [];
        if (callee.sizeIndex !== undefined) {
          folded.set(macroCall, {
            macro: callee.macro,
            size: kept[callee.sizeIndex],
            pool: callee.macro === 'D2_ALLOC_POOL_AT' ? kept[0] : undefined,
            file,
            line,
          });
        }
        return macroCall;
      }

      if (node.kind === NodeKind.CStyleCastExpr) {
        const cast = node as CStyleCastExpr;
        const inner = unwrapParens(cast.expression);
        const alloc = folded.get(inner);
        if (!alloc) return undefined;
        const target = pointeeName(cast.type);
        if (!target) return undefined;
        const size = structSize(target.name, opts);
        if (size === undefined) return undefined;
        if (integerLiteral(alloc.size) !== BigInt(size)) { stats.newSizeMismatch++; return undefined; }
        const isPool = alloc.macro === 'D2_ALLOC_POOL_AT';
        const macro = isPool ? 'D2_NEW_POOL_AT' : 'D2_NEW_AT';
        bump(alloc.macro, -1);
        bump(macro);
        if (isPool) use.newPoolUsed = true; else use.newUsed = true;
        use.newTypes.set(target.name, size);
        const typeArg = target.node as unknown as Expression;
        const macroArgs = isPool
          ? [alloc.pool!, typeArg, alloc.file, alloc.line]
          : [typeArg, alloc.file, alloc.line];
        const result = createMacroCall(macro, macroArgs, cast);
        result.leadingTrivia = cast.leadingTrivia ?? [];
        result.trailingTrivia = cast.trailingTrivia ?? [];
        return result;
      }
      return undefined;
    },
  });
}

// ============================================
// PREAMBLE
// ============================================

const MACRO_ORDER: AllocMacro[] = [
  'D2_ALLOC_AT', 'D2_FREE_AT', 'D2_REALLOC_AT', 'D2_ALLOC_POOL_AT', 'D2_FREE_POOL_AT', 'D2_REALLOC_POOL_AT',
];

const PARAMS: Record<AllocMacro, string[]> = Object.fromEntries(
  Object.values(ALLOC_CALLEES).map((c) => [c.macro, c.params]),
) as Record<AllocMacro, string[]>;

/** One guarded macro naming `callee`; a block of its own so units merge it by text. */
export function allocMacroDefinition(macro: AllocMacro, callee: string): string {
  const params = [...PARAMS[macro], 'szFile', 'nLine'];
  const passed = params.map((p) => `(${p})`).join(', ');
  return `
#ifndef ${macro}
#define ${macro}(${params.join(', ')}) ${callee}(${passed}, 0)
#endif
`;
}

const NEW_DEFINITIONS = {
  D2_NEW_AT: `
#ifndef D2_NEW_AT
#define D2_NEW_AT(T, szFile, nLine) ((T*)D2_ALLOC_AT(sizeof(T), (szFile), (nLine)))
#endif
`,
  D2_NEW_POOL_AT: `
#ifndef D2_NEW_POOL_AT
#define D2_NEW_POOL_AT(pPool, T, szFile, nLine) ((T*)D2_ALLOC_POOL_AT((pPool), sizeof(T), (szFile), (nLine)))
#endif
`,
};

/**
 * The layout claim behind a D2_NEW_AT(T, ...): the binary allocated exactly Ghidra's size
 * for T. Checked on 32-bit only; a 64-bit build is allowed to differ.
 */
export function allocNewSizeAssert(typeName: string, size: number): string {
  const hex = `0x${size.toString(16)}`;
  return `
static_assert(sizeof(void*) != 4 || sizeof(::${typeName}) == ${hex}, "D2_NEW_AT(${typeName}): the 32-bit layout must be the ${hex} bytes 1.14d allocates");
`;
}

/** Everything one body's folds need, as preamble blocks. */
export function allocMacroPreamble(use: AllocMacroUse): string[] {
  const blocks: string[] = [];
  for (const macro of MACRO_ORDER) {
    const callee = use.callees.get(macro);
    if (callee) blocks.push(allocMacroDefinition(macro, callee));
  }
  if (use.newUsed) blocks.push(NEW_DEFINITIONS.D2_NEW_AT);
  if (use.newPoolUsed) blocks.push(NEW_DEFINITIONS.D2_NEW_POOL_AT);
  for (const [name, size] of [...use.newTypes].sort(([a], [b]) => a.localeCompare(b))) {
    blocks.push(allocNewSizeAssert(name, size));
  }
  return blocks;
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export const allocMacrosPlugin: TransformPlugin = {
  id: 'alloc-macros',
  name: 'Allocation Macros',
  description:
    'Fold Fog allocator calls carrying a literal file/line into D2_ALLOC_AT/D2_FREE_AT/D2_NEW_AT macros',
  version: '1.0.0',
  defaultEnabled: true,
  // After the type passes (600-700) settled every cast on these calls, before
  // `enclosing-namespace-strip` (900) shortens the callee the macro must name.
  priority: 880,
  tags: ['cleanup', 'ghidra', 'decompiler'],

  createTransformer(options?: AllocMacrosOptions) {
    const opts = options ?? {};
    if (opts.allocationMacros === false) return (node: ASTNode) => node;
    return createAllocTransformer(opts, new AllocMacroUse());
  },

  createInjectionTransformer(options?: AllocMacrosOptions) {
    const opts = options ?? {};
    return (node: ASTNode, context: InjectionContext) => {
      if (opts.allocationMacros === false) return node;
      const use = new AllocMacroUse();
      const result = createAllocTransformer(opts, use)(node);
      for (const code of allocMacroPreamble(use)) {
        const id = `d2-alloc:${code.trim().split('\n')[0]}`;
        if (context.has(id)) continue;
        context.inject({ id, type: 'preamble', code, priority: 100 });
      }
      return result;
    };
  },
};
