/**
 * Assignment / Initialiser Cast-Insertion Plugin
 *
 * The sibling of `call-arg-cast`, running the same type environment over the
 * other two places C converted silently and C++ will not: an assignment and a
 * variable initialiser.
 *
 * Ghidra emits C. In C an unrelated object pointer reaches another pointer with
 * a warning, `void*` reaches anything at all, and a pointer and a machine word
 * are interchangeable. C++ allows none of it, so the original MSVC source
 * carried a cast at each of these sites; writing it back is transcription.
 *
 * What makes this pass possible at all is that the transform pipeline has no
 * type environment of its own: bodies are parsed inside a `void dummy()`
 * wrapper, so PARAMETERS are not in the AST, and globals, fields and callee
 * return types were never there. `call-arg-cast` introduced the tables that
 * supply them (`enclosingVarTypes`, `globalTypes`, `fieldTypes`,
 * `functionReturnTypes`); this pass reads the same tables for the left-hand
 * side as well as the right.
 *
 * Runs over assignments, variable initialisers and `return` statements.
 *
 * Deliberately narrow, the same constraints that made the argument pass safe:
 *  - fires only when a pointer boundary is crossed or const is lost - two
 *    integers assign to one another perfectly legally and a cast there is noise;
 *  - never casts INTO a non-const `void*`, which every object pointer reaches;
 *  - never touches a slot spelled with a funcdef typedef - `funcptr-arg-cast`
 *    owns whole-prototype comparison;
 *  - a pointer and an integer only meet when the integer is machine-word wide,
 *    and that store is spelled `(T)(uintptr_t)p` so it is width-exact. A
 *    pointer into a narrower slot is a TRUNCATION and a modelling bug
 *    somewhere else, so it is left visible;
 *  - arrays, references and function types reduce to `null` and are left alone.
 *
 * AST-based and idempotent: a re-run reads the cast it inserted, finds its
 * shape equal to the target, and inserts nothing.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, VariableDecl, ParameterDecl, Identifier, TypeNode,
  PointerType, ArrayType, Expression, CStyleCastExpr, UnaryExpr, CallExpr,
  MemberExpr, SubscriptExpr, AssignExpr, QualifiedType, ReturnStmt, BinaryExpr,
  StringLiteralExpr, ConditionalExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Type, Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import {
  type TypeShape, type TypedefResolver, shapeOfNode, shapeOfSpelling, isBareStringLiteral,
  isAggregateValue,
  typeFromSpelling, unwrapParens, calleeName, sameShape, isVoid, canonicalBase,
  isWordIntegerShape, isOpaqueCallbackBase, cachedSet, bareName,
  asCodeAddress, isCodeAddress, isGhidraCode,
  createFuncdefCalleeResolver, type FuncdefDecl, type FuncdefCalleeTables,
  functionPointerTypeFromSpellings, scopedLookup,
} from './call-arg-cast.js';

export interface AssignCastOptions extends PluginOptions {
  /** Callable name (bare AND qualified) → declared return type spelling */
  functionReturnTypes?: Record<string, string>;
  /** Global variable name → its declared type spelling */
  globalTypes?: Record<string, string>;
  /** Funcdef typedef names — a slot spelled with one belongs to funcptr-arg-cast */
  funcdefNames?: string[];
  /**
   * Funcdef typedefs a FUNCTION of the same name hides. `Draw` is both the
   * callback typedef and one of the callbacks; unqualified, the function wins
   * and `(Draw)p` parses as a call. The typedef is emitted at root scope, so the
   * cast has to say `(::Draw)` to reach it.
   */
  rootQualifiedTypedefs?: string[];
  /** The enclosing function's own parameter and local type spellings */
  enclosingVarTypes?: Record<string, string>;
  /** Field name → declared type, where every aggregate declaring it agrees */
  fieldTypes?: Record<string, string>;
  /** Typedef name → the spelling it stands for (`HACCEL` IS a pointer) */
  typedefTargets?: Record<string, string>;
  /** Aggregate name → field name → declared type, exact where the walk is known */
  structFields?: Record<string, Record<string, string>>;
  /** Funcdef name → the return and parameter spellings the funcdef declares */
  funcdefDecls?: Record<string, FuncdefDecl>;
  /** Aggregate name → field name → the funcdef its declared type names */
  structFieldFuncdefs?: Record<string, Record<string, string>>;
  /** Field name → funcdef, where every aggregate declaring that name agrees */
  fieldFuncdefs?: Record<string, string>;
  /**
   * Every spelling that denotes a FUNCTION. A function designator is not an
   * object and has no `TypeShape`, so this is what tells the pass that the value
   * stored is a callback address rather than an unmodelled expression.
   */
  functionNames?: string[];
  /** Data-symbol names — a name that denotes data is never treated as a function */
  variableNames?: string[];
  /** Callable name (bare AND qualified) → its emitted parameter type spellings */
  functionParamTypes?: Record<string, string[]>;
  /**
   * Bare names more than one emitted function carries. `(code*)Draw` names an
   * overload SET, and a cast reduces one only on an EXACT function type — so the
   * function's own type is spelled first and the reinterpret goes on top.
   */
  overloadedFunctionNames?: string[];
  /**
   * Callable name (bare AND qualified) → the calling convention its emitted
   * declaration carries, for the conventions the emitter spells. The convention
   * is part of the function's type, so an overload-selecting cast that omits it
   * names a type no overload has and selects nothing.
   */
  functionConventions?: Record<string, string>;
  /** The namespace segments enclosing this body, outermost first */
  enclosingSegments?: string[];
}

/**
 * Integer types exactly as wide as a pointer on this target. A pointer may be
 * stored into one of these and read back; anything narrower loses address bits,
 * which is never what the machine did.
 */
const WORD_INTEGER_BASES = new Set([
  'int', 'unsigned int', 'long', 'unsigned long', 'uintptr_t', 'intptr_t',
  'size_t', 'ssize_t', 'pointer32',
]);

const isWordInteger = (s: TypeShape) => s.stars === 0 && WORD_INTEGER_BASES.has(s.base);

/** A target type reduced to what a cast needs: its shape and a node to spell it. */
interface Target { shape: TypeShape; node: TypeNode }

/** Peel one indirection off a target (for `*p = x` and `p[i] = x`). */
function peel(t: Target): Target | null {
  if (t.shape.stars === 0) return null;
  const shape: TypeShape = { ...t.shape, stars: t.shape.stars - 1 };
  if (t.node.kind === NodeKind.PointerType) return { shape, node: (t.node as PointerType).pointee };
  if (t.node.kind === NodeKind.ArrayType) return { shape, node: (t.node as ArrayType).elementType };
  return null;
}

/** `T[N]` -> the element spelling, or null when the spelling is not an array. */
const arraySpellingElement = (spelling: string): string | null => {
  const m = /^(.*?)\s*\[[^\[\]]*\]$/.exec(spelling.trim());
  return m ? m[1].trim() : null;
};

function targetFromSpelling(spelling: string, resolve?: TypedefResolver): Target | null {
  const shape = shapeOfSpelling(spelling, resolve);
  if (!shape) return null;
  // The same decay `targetFromNode` performs, for a type that arrived as a
  // string. `shapeOfSpelling` reduces `void *[252]` to `void **`, but the array
  // type ITSELF cannot be cast to, so the node has to decay with the shape or
  // the two disagree and every read of an array global stays untyped.
  const element = arraySpellingElement(spelling);
  const node = element !== null
    ? (() => { const e = typeFromSpelling(element); return e ? Type.pointer(e) : null; })()
    : typeFromSpelling(spelling);
  return node ? { shape, node } : null;
}

const arrayTypeOf = (node: TypeNode): ArrayType | null => {
  if (node.kind === NodeKind.ArrayType) return node as ArrayType;
  if (node.kind === NodeKind.QualifiedType) return arrayTypeOf((node as QualifiedType).type);
  return null;
};

function targetFromNode(node: TypeNode, resolve?: TypedefResolver): Target | null {
  const shape = shapeOfNode(node, 0, resolve);
  if (!shape) return null;
  // `shapeOfNode` decays an array to a pointer, which is right for the VALUE an
  // array name yields - but the array type itself cannot be cast to ("ISO C++
  // forbids casting to an array type"), so the node has to decay with it.
  const arr = arrayTypeOf(node);
  return { shape, node: arr ? Type.pointer(arr.elementType) : node };
}

export function createAssignCastTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as AssignCastOptions;
  const returnTypes = o.functionReturnTypes ?? {};
  const globalTypes = o.globalTypes ?? {};
  const funcdefNames = cachedSet(o.funcdefNames);
  const rootQualifiedTypedefs = cachedSet(o.rootQualifiedTypedefs);
  const enclosingVarTypes = o.enclosingVarTypes ?? {};
  const fieldTypes = o.fieldTypes ?? {};
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];
  const structFields = o.structFields ?? {};
  const functionNames = cachedSet(o.functionNames);
  const dataNames = cachedSet(o.variableNames);
  const funcdefTables: FuncdefCalleeTables = {
    funcdefDecls: o.funcdefDecls,
    structFieldFuncdefs: o.structFieldFuncdefs,
    fieldFuncdefs: o.fieldFuncdefs,
  };
  const enclosingSegments = o.enclosingSegments ?? [];
  const overloadedNames = cachedSet(o.overloadedFunctionNames);
  const paramTypeSpellings = o.functionParamTypes ?? {};
  const conventions = o.functionConventions ?? {};

  /**
   * A function designator whose name denotes an overload set, wrapped in its own
   * exact type so the set reduces to one member. Without it the reinterpret cast
   * below has nothing to resolve against — "overloaded function with no
   * contextual type information" — and an INEXACT type selects nothing, so a
   * signature this cannot spell is left as it is.
   */
  const selectOverload = (rhs: Expression, name: string): Expression => {
    if (!overloadedNames.has(bareName(name))) return rhs;
    const exact = functionPointerTypeFromSpellings(
      scopedLookup(returnTypes, name, enclosingSegments),
      scopedLookup(paramTypeSpellings, name, enclosingSegments),
      scopedLookup(conventions, name, enclosingSegments),
    );
    return exact ? (Expr.cast(exact, rhs) as Expression) : rhs;
  };

  const haveTables =
    Object.keys(globalTypes).length > 0 ||
    Object.keys(enclosingVarTypes).length > 0 ||
    Object.keys(fieldTypes).length > 0 ||
    Object.keys(returnTypes).length > 0 ||
    Object.keys(o.structFields ?? {}).length > 0;
  if (!haveTables) return createTransformer({});

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;

      const localTypes = new Map<string, TypeNode>();
      for (const p of node.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) localTypes.set(pd.name.name, pd.type);
      }
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
      }

      /** True when this lvalue names an array, which nothing can be stored into. */
      const isArrayLvalue = (expr: Expression): boolean => {
        const e2 = unwrapParens(expr);
        // A MEMBER that is an array is no more assignable than a named one, and
        // the field tables now carry the dimension, so the store has to be
        // refused here rather than silently cast.
        if (e2.kind === NodeKind.MemberExpr) {
          const me = e2 as MemberExpr;
          const m = me.member as { name?: string };
          if (typeof m?.name !== 'string') return false;
          const obj = lvalueTarget(me.object);
          const exact = obj && obj.shape.stars === (me.isArrow ? 1 : 0)
            ? structFields[obj.shape.base]?.[m.name] : undefined;
          const spelled = exact ?? fieldTypes[m.name];
          return typeof spelled === 'string' && spelled.includes('[');
        }
        if (e2.kind !== NodeKind.Identifier) return false;
        const t = localTypes.get((e2 as Identifier).name);
        if (t) return arrayTypeOf(t) !== null;
        const spelled = enclosingVarTypes[(e2 as Identifier).name]
          ?? globalTypes[(e2 as Identifier).name];
        return typeof spelled === 'string' && spelled.includes('[');
      };

      /** The declared type of a named thing, wherever the environment records it. */
      const namedTarget = (name: string): Target | null => {
        const local = localTypes.get(name);
        if (local) return targetFromNode(local, resolve);
        const declared = enclosingVarTypes[name];
        if (declared) return targetFromSpelling(declared, resolve);
        const g = globalTypes[name];
        return g ? targetFromSpelling(g, resolve) : null;
      };

      /** The type an assignment writes into, or null when it is not determinable. */
      const lvalueTarget = (expr: Expression): Target | null => {
        const e = unwrapParens(expr);
        switch (e.kind) {
          case NodeKind.Identifier:
            return namedTarget((e as Identifier).name);
          case NodeKind.QualifiedId: {
            const q = calleeName(e);
            if (!q) return null;
            const bare = bareName(q);
            const g = globalTypes[q] ?? globalTypes[bare];
            return g ? targetFromSpelling(g, resolve) : null;
          }
          case NodeKind.MemberExpr: {
            const me = e as MemberExpr;
            const m = me.member as { name?: string };
            if (typeof m?.name !== 'string') return null;
            // If the object's own type is known, the field's type is exact -
            // `pNext` may mean a different type in every struct that has one.
            const obj = lvalueTarget(me.object);
            if (obj && obj.shape.stars === (me.isArrow ? 1 : 0)) {
              const exact = structFields[obj.shape.base]?.[m.name];
              if (exact) return targetFromSpelling(exact, resolve);
            }
            const t = fieldTypes[m.name];
            return t ? targetFromSpelling(t, resolve) : null;
          }
          case NodeKind.UnaryExpr: {
            const u = e as UnaryExpr;
            if (u.operator !== '*') return null;
            // `*(T*)e = x` says its own type outright; anything else peels.
            const inner = unwrapParens(u.operand);
            if (inner.kind === NodeKind.CStyleCastExpr) {
              const t = targetFromNode((inner as CStyleCastExpr).type, resolve);
              return t ? peel(t) : null;
            }
            const base = lvalueTarget(u.operand);
            return base ? peel(base) : null;
          }
          case NodeKind.SubscriptExpr: {
            const base = lvalueTarget((e as SubscriptExpr).array);
            return base ? peel(base) : null;
          }
          default:
            return null;
        }
      };

      /** The type of a value expression, or null when it is not determinable. */
      const valueShape = (expr: Expression): TypeShape | null => {
        const e = unwrapParens(expr);
        switch (e.kind) {
          case NodeKind.CStyleCastExpr:
            return shapeOfNode((e as CStyleCastExpr).type, 0, resolve);
          // A string literal is an array of CONST char that decays to
          // `const char *` - const with nothing in the source spelling it. C let
          // it reach a `char *` slot and C++ has not since C++11, so the store
          // the decompiler wrote needs the cast the original source did not.
          case NodeKind.StringLiteral: {
            const prefix = (e as StringLiteralExpr).prefix ?? '';
            if (prefix === '') return { base: 'char', stars: 1, isConst: true };
            if (prefix === 'L') return { base: 'wchar_t', stars: 1, isConst: true };
            return null;
          }
          // `c ? a : b` has one type; where the arms disagree the conversion
          // happened inside the conditional and either answer would be a guess.
          case NodeKind.ConditionalExpr: {
            const c = e as ConditionalExpr;
            const a = valueShape(c.thenExpr);
            const b2 = valueShape(c.elseExpr);
            if (!a || !b2 || !sameShape(a, b2)) return null;
            return { ...a, isConst: a.isConst || b2.isConst };
          }
          case NodeKind.UnaryExpr: {
            const u = e as UnaryExpr;
            if (u.operator === '*') {
              const p = valueShape(u.operand);
              return p && p.stars > 0 ? { ...p, stars: p.stars - 1 } : null;
            }
            if (u.operator !== '&') return null;
            const inner = valueShape(u.operand);
            return inner ? { ...inner, stars: inner.stars + 1 } : null;
          }
          case NodeKind.Identifier:
          case NodeKind.QualifiedId:
          case NodeKind.MemberExpr:
          case NodeKind.SubscriptExpr: {
            const t = lvalueTarget(e);
            return t ? t.shape : null;
          }
          case NodeKind.CallExpr: {
            const callee = (e as CallExpr).callee;
            const cn = calleeName(callee);
            const rt = cn !== undefined
              ? returnTypes[cn] ?? returnTypes[bareName(cn)]
              : undefined;
            if (rt) return shapeOfSpelling(rt, resolve);
            // No name matched — a call THROUGH a function pointer. Its result
            // type is in the funcdef the slot is declared with and nowhere else,
            // so without this every such store is left untyped and uncast.
            const fd = funcdefOfCallee(callee);
            return fd ? shapeOfSpelling(fd.returnType, resolve) : null;
          }
          case NodeKind.BinaryExpr: {
            // Pointer arithmetic keeps the pointer's type - see the same case in
            // `call-arg-cast`.
            const b = e as BinaryExpr;
            if (b.operator !== '+' && b.operator !== '-') return null;
            const l = valueShape(b.left);
            const r = valueShape(b.right);
            if (l && l.stars > 0 && (!r || r.stars === 0)) return l;
            if (b.operator === '+' && r && r.stars > 0 && (!l || l.stars === 0)) return r;
            return null;
          }
          default:
            return null;
        }
      };

      /** The funcdef a call through a function pointer is made under. */
      const funcdefOfCallee = createFuncdefCalleeResolver(funcdefTables, valueShape);

      /**
       * True when the expression names a FUNCTION rather than a value: a bare
       * `f` or `&f` the model knows as a callable and which nothing nearer
       * declares as data.
       */
      const functionDesignator = (expr: Expression): string | undefined => {
        let e = unwrapParens(expr);
        if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '&') {
          e = unwrapParens((e as UnaryExpr).operand);
        }
        if (e.kind !== NodeKind.Identifier && e.kind !== NodeKind.QualifiedId) return undefined;
        const name = calleeName(e);
        if (!name) return undefined;
        const bare = bareName(name);
        if (localTypes.has(name) || localTypes.has(bare)) return undefined;
        if (enclosingVarTypes[name] !== undefined || enclosingVarTypes[bare] !== undefined) return undefined;
        if (globalTypes[name] !== undefined || globalTypes[bare] !== undefined) return undefined;
        if (dataNames.has(bare)) return undefined;
        return functionNames.has(name) || functionNames.has(bare) ? name : undefined;
      };

      /**
       * The cast this store needs, or null when it needs none. Returns the
       * finished expression so the pointer→word case can spell its two steps.
       */
      /**
       * The funcdef slot's type, spelled so it reaches the TYPEDEF. A funcdef
       * whose name a function shares is hidden by that function at every scope
       * the cast could be written in, so it is named from the root.
       */
      const funcdefCastType = (want: Target): TypeNode => {
        const name = canonicalBase(want.shape.base).replace(/^::/, '');
        return rootQualifiedTypedefs.has(name) ? Type.typedefAt(name, true) : want.node;
      };

      const castFor = (want: Target, rhs: Expression): Expression | null => {
        if (funcdefNames.has(canonicalBase(want.shape.base))) {
          // `funcptr-arg-cast` owns this slot because it can compare the two
          // PROTOTYPES. A `void*` has none to compare - it is an untyped address
          // the code is about to call through - and C++ converts between an
          // object pointer and a code pointer in neither direction, so the cast
          // the original source carried belongs here.
          if (functionDesignator(rhs) !== undefined) return null;
          const untyped = valueShape(rhs);
          // Ghidra's `code *` is the same case from the other side: a code
          // address the decompiler never gave a prototype to, so there is no
          // second prototype for `funcptr-arg-cast` to compare and the store
          // would otherwise reach no pass at all.
          if (!untyped || untyped.stars !== 1 || !(isVoid(untyped) || isGhidraCode(untyped))) return null;
          return Expr.cast(funcdefCastType(want), rhs);
        }
        // Nothing converts to a struct by value; writing the cast only invents
        // an "invalid cast" on top of the disagreement already there.
        if (isAggregateValue(want.shape, structFields)) return null;
        // A function address stored into a slot that is not a function pointer of
        // the same prototype. C++ converts it in NEITHER direction - not even to
        // `void*` - so the original source carried a cast; `funcptr-arg-cast` owns
        // the funcdef-typedef slots, and what is left has no prototype to freeze.
        const designated = functionDesignator(rhs);
        if (designated !== undefined) {
          const value = selectOverload(rhs, designated);
          if (want.shape.stars > 0) return Expr.cast(want.node, value);
          if (isOpaqueCallbackBase(want.shape.base, structFields)) {
            return Expr.cast(want.node, value);
          }
          // Into a word-wide integer the address goes through `uintptr_t`; a
          // narrower slot would truncate it, which the machine never did.
          if (!isWordIntegerShape(want.shape)) return null;
          return Expr.cast(want.node, Expr.cast(Type.typedef('uintptr_t'), value));
        }
        const have = asCodeAddress(valueShape(rhs), funcdefNames);
        if (!have) return null;
        // Any non-const OBJECT pointer still reaches `void*` implicitly. A code
        // address reaches it in no language, so it crosses a real boundary here.
        if (have.stars > 0 && !isCodeAddress(have) && want.shape.stars === 1 && isVoid(want.shape)
            && !want.shape.isConst && !have.isConst) return null;
        const losesConst = have.isConst && !want.shape.isConst
          && !(sameShape(have, want.shape) && isBareStringLiteral(rhs));
        if (sameShape(have, want.shape) && !losesConst) return null;
        // Two integers assign to one another; only a pointer boundary needs a cast.
        if (want.shape.stars === 0 && have.stars === 0 && !losesConst) return null;
        if (want.shape.stars > 0 && have.stars === 0) {
          // A word becomes a pointer only from a word-wide slot.
          if (!isWordInteger(have)) return null;
          return Expr.cast(want.node, rhs);
        }
        if (want.shape.stars === 0 && have.stars > 0) {
          // The machine stores an ADDRESS into a word-sized slot. `(uintptr_t)`
          // first so the reinterpret is width-exact on the way in.
          if (!isWordInteger(want.shape)) return null;
          return Expr.cast(want.node, Expr.cast(Type.typedef('uintptr_t'), rhs));
        }
        return Expr.cast(want.node, rhs);
      };

      // `return e;` stores into the function's own return slot, and is the third
      // place C converted silently. It is reachable only because the body is
      // parsed inside a wrapper carrying the real return type - under the old
      // `void dummy()` wrapper every function looked like it returned void.
      const returnTarget = (() => {
        const t = targetFromNode(node.returnType, resolve);
        if (!t) return null;
        // `return;` in a void function has no value to cast; `void *` does.
        return t.shape.stars === 0 && isVoid(t.shape) ? null : t;
      })();

      let changed = false;
      const inner = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind === NodeKind.ReturnStmt) {
            const r = n as ReturnStmt;
            if (!r.value || !returnTarget) return undefined;
            const cast = castFor(returnTarget, r.value);
            if (!cast) return undefined;
            changed = true;
            return updateNode(r, { value: cast } as Partial<ReturnStmt>);
          }
          if (n.kind === NodeKind.AssignExpr) {
            const a = n as AssignExpr;
            if (a.operator !== '=') return undefined;
            // An array name is not an assignable slot; casting the value stored
            // into it asserts a conversion the declaration never allowed.
            if (isArrayLvalue(a.left)) return undefined;
            const want = lvalueTarget(a.left);
            if (!want) return undefined;
            const cast = castFor(want, a.right);
            if (!cast) return undefined;
            changed = true;
            return updateNode(a, { right: cast } as Partial<AssignExpr>);
          }
          if (n.kind === NodeKind.VariableDecl) {
            const v = n as VariableDecl;
            const init = v.initializer;
            if (!init || init.kind === NodeKind.InitListExpr) return undefined;
            // An array declarator is not a pointer slot - `T a[N] = e` never
            // takes a cast, and decaying its type here would assert otherwise.
            if (arrayTypeOf(v.type)) return undefined;
            const want = targetFromNode(v.type, resolve);
            if (!want) return undefined;
            const cast = castFor(want, init as Expression);
            if (!cast) return undefined;
            changed = true;
            return updateNode(v, { initializer: cast } as Partial<VariableDecl>);
          }
          return undefined;
        },
      });

      const newBody = inner(node.body);
      if (!changed) return undefined;
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const assignCastPlugin: TransformPlugin = {
  id: 'assign-cast',
  name: 'Assignment and Initialiser Cast Insertion',
  description:
    'Casts an assigned value to the declared type of the slot it is stored in, where C converted implicitly and C++ will not',
  version: '1.0.0',
  defaultEnabled: true,
  // After call-arg-cast (610), so an argument already cast is what this reads.
  priority: 615,
  tags: ['cleanup', 'type'],
  createTransformer: createAssignCastTransformer,
};
