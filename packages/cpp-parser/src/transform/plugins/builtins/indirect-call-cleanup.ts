/**
 * Indirect Call Cleanup Plugin
 *
 * Handles Ghidra's "Could not recover jumptable" warnings and related artifacts:
 * 1. Strips WARNING trivia from function bodies
 * 2. Cleans up struct field function pointer casts: (*(code*)pVar->fp)(args) → pVar->fp(args)
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  UnaryExpr,
  CallExpr,
  MemberExpr,
  CStyleCastExpr,
  ParenExpr,
  Identifier,
  PointerType,
  TypedefType,
  FunctionDecl,
  ParameterDecl,
  VariableDecl,
  TypeNode,
} from '../../../ast/nodes.js';
import {
  createTransformer,
  updateNode,
  sequence,
  type Transformer,
} from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import type { TypedefResolver } from './call-arg-cast.js';
import { TriviaKind } from '../../../lexer/trivia.js';
import type { Trivia } from '../../../lexer/trivia.js';

// ============================================
// 2a: WARNING TRIVIA STRIPPING
// ============================================

const WARNING_PATTERNS = [
  'WARNING: Could not recover jumptable',
  'WARNING: Treating indirect jump as call',
];

function containsWarning(text: string): boolean {
  return WARNING_PATTERNS.some(p => text.includes(p));
}

function filterWarningTrivia(trivia: Trivia[] | undefined): Trivia[] | undefined {
  if (!trivia || trivia.length === 0) return trivia;
  const filtered = trivia.filter(t => {
    if (t.kind !== TriviaKind.BlockComment && t.kind !== TriviaKind.LineComment) return true;
    return !containsWarning(t.text);
  });
  if (filtered.length === trivia.length) return trivia;
  return filtered.length > 0 ? filtered : undefined;
}

function stripJumptableWarnings(): Transformer {
  return createTransformer({
    visitNode(node) {
      const n = node as ASTNode & { leadingTrivia?: Trivia[]; trailingTrivia?: Trivia[] };
      if (!n.leadingTrivia && !n.trailingTrivia) return undefined;

      const newLeading = filterWarningTrivia(n.leadingTrivia);
      const newTrailing = filterWarningTrivia(n.trailingTrivia);

      if (newLeading === n.leadingTrivia && newTrailing === n.trailingTrivia) return undefined;

      return updateNode(node, {
        leadingTrivia: newLeading ?? [],
        trailingTrivia: newTrailing ?? [],
      });
    },
  });
}

// ============================================
// 2b: STRUCT FIELD FN-PTR CLEANUP
// ============================================

function unwrapParens(expr: Expression): Expression {
  while (expr.kind === NodeKind.ParenExpr) {
    expr = (expr as ParenExpr).expression;
  }
  return expr;
}

function isDeref(expr: Expression): UnaryExpr | null {
  expr = unwrapParens(expr);
  if (expr.kind === NodeKind.UnaryExpr) {
    const unary = expr as UnaryExpr;
    if (unary.operator === '*') {
      return unary;
    }
  }
  return null;
}

function isMemberExpr(expr: Expression): MemberExpr | null {
  expr = unwrapParens(expr);
  if (expr.kind === NodeKind.MemberExpr) {
    return expr as MemberExpr;
  }
  return null;
}

function isCastToCode(expr: Expression): CStyleCastExpr | null {
  expr = unwrapParens(expr);
  if (expr.kind !== NodeKind.CStyleCastExpr) return null;

  const cast = expr as CStyleCastExpr;
  const castType = cast.type;

  // Direct cast to (code): TypedefType with name "code"
  if (castType.kind === NodeKind.TypedefType) {
    const td = castType as TypedefType;
    if (td.name.kind === NodeKind.Identifier && (td.name as Identifier).name === 'code') {
      return cast;
    }
  }

  // Cast to (code*) or (code**): PointerType whose pointee eventually is "code"
  if (castType.kind === NodeKind.PointerType) {
    let inner = (castType as PointerType).pointee;
    // Unwrap one more pointer level for code**
    if (inner.kind === NodeKind.PointerType) {
      inner = (inner as PointerType).pointee;
    }
    if (inner.kind === NodeKind.TypedefType) {
      const td = inner as TypedefType;
      if (td.name.kind === NodeKind.Identifier && (td.name as Identifier).name === 'code') {
        return cast;
      }
    }
  }

  return null;
}

/**
 * Detect pattern: (*(code*)pVar->fpField)(args) → pVar->fpField(args)
 *
 * AST: CallExpr where callee = UnaryExpr(*, CastExpr(code*, MemberExpr(obj, field)))
 * Also: (*pVar->fpField)(args) → pVar->fpField(args) when no cast present
 *
 * Pattern 1's cast is only noise when the field really is a function pointer.
 * Ghidra emits `(*(code *)X)()` precisely BECAUSE `X`'s type is not one - when
 * it is, the decompiler writes `(*X)()` and Pattern 2 handles it. So wherever
 * Ghidra put the cast on a field the model knows as plain data, the cast is what
 * makes the call legal at all, and stripping it produces "expression cannot be
 * used as a function". `D2PoolManagerStrc::pPools[0].nSize` (a `size_t` slot the
 * engine really does `call dword ptr` through) and `pLibrary` (a `void *`) are
 * both that shape.
 *
 * The gate is one-sided on purpose: the cast is KEPT only where the field's
 * declared type is known AND is not a function pointer. A field the model cannot
 * place keeps today's behaviour, so nothing that compiles now can start failing
 * - and in particular a genuinely funcdef-typed field never keeps a `(code *)`
 * that would collapse its return type to `typedef int code(...)`'s `int`.
 */
function cleanStructFieldFnPtrs(options: IndirectCallCleanupOptions): Transformer {
  const typedefTargets = options.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];
  const fieldTypes = options.fieldTypes ?? {};
  const structFields = options.structFields ?? {};
  const fieldFuncdefs = options.fieldFuncdefs ?? {};
  const structFieldFuncdefs = options.structFieldFuncdefs ?? {};

  /** A spelling that denotes a function pointer: `int (*)(T)`, `BOOL (__stdcall *)(T)`. */
  const spellsFunctionPointer = (t: string) => /\(\s*(__\w+\s+)?\*/.test(t);

  /**
   * True when the member is KNOWN to hold something other than a function
   * pointer, which is the only case in which the `(code *)` is load-bearing.
   *
   * `shapeOf` is scoped to the enclosing function so the OBJECT a member is read
   * from can be placed - `pWVar1[1].pLibrary` needs `pWVar1`'s declared type,
   * and that is a local.
   */
  const isKnownDataField = (member: MemberExpr, shapeOf: ExprShape): boolean => {
    if (member.member.kind !== NodeKind.Identifier) return false;
    const name = (member.member as Identifier).name;
    if (fieldFuncdefs[name]) return false;
    const obj = shapeOf(member.object as Expression);
    if (obj && obj.stars === (member.isArrow ? 1 : 0)) {
      if (structFieldFuncdefs[obj.base]?.[name]) return false;
      const exact = structFields[obj.base]?.[name];
      if (exact) return !spellsFunctionPointer(exact);
    }
    const spelled = fieldTypes[name];
    if (spelled === undefined) return false;
    return !spellsFunctionPointer(spelled);
  };

  const shapeForScope = (localTypes: ReadonlyMap<string, TypeNode>): ExprShape =>
    createExprShape(localTypes, {
      globalTypes: options.globalTypes ?? {},
      enclosingVarTypes: options.enclosingVarTypes ?? {},
      structFields,
      fieldTypes,
      resolve,
    });

  const cleanCalls = (shapeOf: ExprShape): Transformer => createTransformer({
    visitCallExpr(call: CallExpr) {
      const callee = unwrapParens(call.callee);

      // Must start with dereference
      const outerDeref = isDeref(callee);
      if (!outerDeref) return undefined;

      const derefOperand = unwrapParens(outerDeref.operand);

      // Pattern 1: (*(code*)pVar->fpField)(args)
      const codeCast = isCastToCode(derefOperand);
      if (codeCast) {
        const member = isMemberExpr(codeCast.expression);
        if (member) {
          if (isKnownDataField(member, shapeOf)) return undefined;
          return updateNode(call, {
            callee: member,
          });
        }
      }

      // Pattern 2: (*pVar->fpField)(args) — no cast, field already typed
      const member = isMemberExpr(derefOperand);
      if (member) {
        return updateNode(call, {
          callee: member,
        });
      }

      return undefined;
    },
  });

  // The scope a call sits in is the function that declares its locals, so each
  // body is rewritten under its own resolver: `pWVar1[1].pLibrary` cannot be
  // placed without `pWVar1`'s declared type, and that is a local. Traversal is
  // bottom-up, so the body reaching this has not been rewritten by anything
  // else in this pass.
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const localTypes = new Map<string, TypeNode>();
      for (const p of fn.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) localTypes.set(pd.name.name, pd.type);
      }
      for (const d of findNodesByKind(fn.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
      }
      const newBody = cleanCalls(shapeForScope(localTypes))(fn.body);
      if (newBody === fn.body) return undefined;
      return updateNode(fn, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

// ============================================
// 2c: TAIL-JUMP SELF-ARGUMENT
// ============================================

/**
 * A member-access chain, spelled as a comparable key. `null` for anything else,
 * so only the shapes this comparison actually understands are ever matched.
 */
function memberChainKey(expr: Expression): string | null {
  const e = unwrapParens(expr);
  if (e.kind === NodeKind.Identifier) {
    return `#${(e as Identifier).name}`;
  }
  if (e.kind === NodeKind.MemberExpr) {
    const m = e as MemberExpr;
    if (m.member.kind !== NodeKind.Identifier) return null;
    const base = memberChainKey(m.object);
    if (base === null) return null;
    return `${base}${m.isArrow ? '->' : '.'}${(m.member as Identifier).name}`;
  }
  return null;
}

/**
 * Drop the sole argument of an indirect call when it IS the callee.
 *
 * A zero-parameter slot reached by a tail `jmp [reg]` decompiles with the
 * register that held the callee re-inserted as argument 1:
 *
 *     bResult = (*RENDERER_CurrentRenderedFunctions->nfpCheckGamma)
 *                         (RENDERER_CurrentRenderedFunctions->nfpCheckGamma);
 *
 * Ghidra flags it — the same statement carries "Could not recover jumptable" and
 * "Treating indirect jump as call" — and a function pointer is never an argument
 * to itself, so the argument is the artifact and the call is a zero-argument
 * one. Matched only when the argument is the SAME member-access chain as the
 * callee, which is why nothing that passes a different callback is touched.
 */
function dropTailJumpSelfArgument(): Transformer {
  return createTransformer({
    visitCallExpr(call: CallExpr) {
      if (call.arguments.length !== 1) return undefined;
      const calleeKey = memberChainKey(call.callee);
      if (calleeKey === null) return undefined;
      if (memberChainKey(call.arguments[0]) !== calleeKey) return undefined;
      return updateNode(call, { arguments: [] });
    },
  });
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface IndirectCallCleanupOptions extends PluginOptions {
  /** Global name → declared spelling, for placing the object a member is read from. */
  globalTypes?: Record<string, string>;
  /** A name declared by the class/namespace body this function sits in. */
  enclosingVarTypes?: Record<string, string>;
  /** Field name → declared spelling, where every aggregate declaring it agrees. */
  fieldTypes?: Record<string, string>;
  /** Aggregate → field → declared spelling, exact where the object's type is known. */
  structFields?: Record<string, Record<string, string>>;
  /** Field name → the funcdef it is declared with, where every aggregate agrees. */
  fieldFuncdefs?: Record<string, string>;
  /** Aggregate → field → the funcdef the field is declared with. */
  structFieldFuncdefs?: Record<string, Record<string, string>>;
  /** Typedef name → the spelling it stands for. */
  typedefTargets?: Record<string, string>;
}

export const indirectCallCleanupPlugin: TransformPlugin = {
  id: 'indirect-call-cleanup',
  name: 'Indirect Call Cleanup',
  description:
    'Strip Ghidra jumptable warnings, clean fn-ptr casts, simplify indirect calls',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 5, // Very early — strip warnings + simplify before other transforms
  tags: ['core', 'cleanup'],

  createTransformer(options?: IndirectCallCleanupOptions) {
    return sequence(
      stripJumptableWarnings(),
      cleanStructFieldFnPtrs(options ?? {}),
      dropTailJumpSelfArgument(),
    );
  },
};
