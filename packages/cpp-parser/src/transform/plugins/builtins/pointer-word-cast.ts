/**
 * Pointer-Word Cast Plugin
 *
 * Ghidra reaches every piece of address arithmetic through a 32-bit integer:
 * `(int)p < (int)q`, `(uint32_t)p & 3`, `(int)a - (int)b`, and above all
 * `(T *)((int)p + 0x10)` for an offset onto a pointer whose pointee it does not
 * know. On this 32-bit target `int` is exactly a pointer wide, so every one of
 * those is the machine's own operation - but the spelling ties the source to a
 * 32-bit pointer. A compiler for a wider pointer (VC8 x64 /Wp64: C4311 pointer
 * to int, C4312 int to pointer) flags each one, although the code is right.
 *
 * Where the integer is only ever a step in address arithmetic, the same
 * operation has a spelling that is pointer-sized everywhere and the very same
 * type on this target:
 *
 *   (T *)((int)p + K)        ->  (T *)((char *)p + K)       byte arithmetic
 *   (T *)(int)p              ->  (T *)p                     a pure round trip
 *   (int)p < (int)q          ->  (intptr_t)p < (intptr_t)q  compare
 *   (uint32_t)p & 3          ->  (uintptr_t)p & 3           alignment / hash
 *   (int)a - (int)b          ->  (intptr_t)a - (intptr_t)b  a distance
 *
 * Every form is value-preserving on the 32-bit target, and the integer forms
 * are type-identical: `intptr_t` IS `int` and `uintptr_t` IS `unsigned int`
 * there (mingw and MSVC alike), so a comparison keeps its signedness, an
 * overload or a conversion sees the same type, and VC8 generates the same code.
 * Only a cast spelled with a signed or unsigned machine `int` is touched:
 * `long`/`DWORD` are distinct types from `int`, and moving them onto `intptr_t`
 * would change a type, not only a spelling. `(char *)p + K` is the address
 * `(int)p + K` named, modulo 2^32, for any integer `K` of at most 32 bits, and
 * the outer `(T *)` converts it exactly as it converted the integer before.
 *
 * What is deliberately NOT touched is a pointer cast to an integer whose value
 * then lands in an integer-typed slot - an assignment, a call argument, a
 * return. There the declared type of the slot says `int` and the value says
 * pointer; that is a typing question for Ghidra, and the warning is the signal
 * that finds it. The same goes for an integer cast to a pointer whose operand
 * is an integer-typed variable: the retype belongs on the variable.
 *
 * Runs last, after every pass that reads Ghidra's `(int)p + K` shape to recover
 * a field, an index or a global (struct-field, strided-access,
 * global-distance-index, offset-induction-index, ...), and after the recorded
 * VC8 source forms, which anchor on the decompiler's text: this only respells
 * what all of them left.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, VariableDecl, ParameterDecl, Expression, BinaryExpr, CStyleCastExpr,
  TypeNode, BuiltinType, IntegerLiteralExpr, ParenExpr, UnaryExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Type, Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import {
  asCodeAddress, cachedSet, shapeOfNode, typeNodeName, unwrapParens,
  type TypedefResolver, type TypeShape,
} from './call-arg-cast.js';

export interface PointerWordCastOptions extends PluginOptions {
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  /** Typedef names that stand for a function pointer. */
  funcdefNames?: string[];
}

/** Per-form counts since the last reset, for the regen log and the tests. */
export interface PointerWordCastStats {
  byteArith: number;
  roundTrip: number;
  compare: number;
  bitwise: number;
  distance: number;
}

const stats: PointerWordCastStats = { byteArith: 0, roundTrip: 0, compare: 0, bitwise: 0, distance: 0 };
export function getPointerWordCastStats(): PointerWordCastStats { return { ...stats }; }
export function resetPointerWordCastStats(): void {
  stats.byteArith = stats.roundTrip = stats.compare = stats.bitwise = stats.distance = 0;
}

/**
 * Typedef spellings that ARE `int` / `unsigned int` on this target. A name that
 * only resolves there through the model (an enum `typedef int eX`, `BOOL`) is
 * left alone: it carries a meaning the cast was written for.
 */
const SIGNED_WORD_TYPEDEFS = new Set(['int32_t', 'INT', 'int4']);
const UNSIGNED_WORD_TYPEDEFS = new Set(['uint32_t', 'uint', 'undefined4', 'UINT', 'u_int', 'unsigned']);

/**
 * `intptr_t` / `uintptr_t` for a cast spelled with a 32-bit `int` /
 * `unsigned int`, otherwise null.
 */
export function pointerWordFor(t: TypeNode): 'intptr_t' | 'uintptr_t' | null {
  if (t.kind === NodeKind.BuiltinType) {
    const b = t as BuiltinType;
    if (b.name !== 'int') return null;
    const mods = b.modifiers ?? [];
    if (mods.length === 0) return 'intptr_t';
    if (mods.length === 1 && mods[0] === 'unsigned') return 'uintptr_t';
    if (mods.length === 1 && mods[0] === 'signed') return 'intptr_t';
    return null;
  }
  if (t.kind === NodeKind.TypedefType) {
    const n = typeNodeName((t as { name: unknown }).name);
    if (n === undefined) return null;
    if (SIGNED_WORD_TYPEDEFS.has(n)) return 'intptr_t';
    if (UNSIGNED_WORD_TYPEDEFS.has(n)) return 'uintptr_t';
  }
  return null;
}

const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);
/** Operators whose operand is read as the bits of the word: alignment tests, hashes, masks. */
const BITWISE = new Set(['&', '|', '^', '<<', '>>', '%', '/']);

/**
 * Integer bases a byte offset may have: at most 32 bits, so `(char *)p + K`
 * wraps at exactly the address the 32-bit sum did.
 */
const OFFSET_BASES = new Set([
  'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'wchar_t', 'bool',
  'int', 'unsigned int', 'long', 'unsigned long', 'intptr_t', 'uintptr_t', 'size_t', 'ssize_t',
]);

export function createPointerWordCastTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as PointerWordCastOptions;
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];
  const funcdefNames = cachedSet(o.funcdefNames);

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
      const shapeOf: ExprShape = createExprShape(localTypes, {
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });

      /** The object (not code) pointer a word cast's operand is, or null. */
      const objectPointer = (e: Expression): TypeShape | null => {
        const s = shapeOf(e);
        if (!s || s.stars === 0) return null;
        const code = asCodeAddress(s, funcdefNames);
        return code && code.base === '#code' ? null : s;
      };

      /** A cast of a pointer to a 32-bit machine word, with the word type it gets. */
      const wordCastOfPointer = (e: Expression): { cast: CStyleCastExpr; word: 'intptr_t' | 'uintptr_t' } | null => {
        const u = unwrapParens(e);
        if (u.kind !== NodeKind.CStyleCastExpr) return null;
        const cast = u as CStyleCastExpr;
        const word = pointerWordFor(cast.type);
        if (!word) return null;
        // A code address only qualifies for the integer forms, which name no pointee.
        const s = shapeOf(cast.expression);
        if (!s || s.stars === 0) {
          const code = asCodeAddress(s, funcdefNames);
          if (!code || code.stars === 0) return null;
        }
        return { cast, word };
      };

      /** An integer offset of at most 32 bits - certainly not a pointer. */
      const isOffset = (e: Expression): boolean => {
        const u = unwrapParens(e);
        switch (u.kind) {
          case NodeKind.IntegerLiteral: {
            const lit = u as IntegerLiteralExpr;
            return lit.value <= 0xffffffffn && !/ll/i.test(lit.suffix ?? '');
          }
          case NodeKind.SizeofExpr:
            return true;
          case NodeKind.UnaryExpr: {
            const op = (u as UnaryExpr).operator;
            return (op === '-' || op === '~' || op === '+') && isOffset((u as UnaryExpr).operand);
          }
          case NodeKind.BinaryExpr: {
            const b = u as BinaryExpr;
            if (b.operator === '+' || b.operator === '-' || b.operator === '*' || b.operator === '&'
                || b.operator === '|' || b.operator === '^' || b.operator === '<<' || b.operator === '>>'
                || b.operator === '/' || b.operator === '%') {
              return isOffset(b.left) && isOffset(b.right);
            }
            return false;
          }
          default: {
            const s = shapeOf(u);
            return !!s && s.stars === 0 && OFFSET_BASES.has(s.base);
          }
        }
      };

      /**
       * The additive chain under `e`: every `+`/`-` operand reachable through
       * parentheses, each with the sign it enters the sum with.
       */
      const additiveTerms = (e: Expression, sign: 1 | -1, out: Array<{ term: Expression; sign: 1 | -1 }>) => {
        const u = unwrapParens(e);
        if (u.kind === NodeKind.BinaryExpr) {
          const b = u as BinaryExpr;
          if (b.operator === '+' || b.operator === '-') {
            additiveTerms(b.left, sign, out);
            additiveTerms(b.right, b.operator === '-' ? (sign === 1 ? -1 : 1) : sign, out);
            return;
          }
        }
        out.push({ term: e, sign });
      };

      /** Rebuild `e` with `target` (a node inside its additive chain) replaced. */
      const replaceInChain = (e: Expression, target: Expression, by: Expression): Expression => {
        if (e === target) return by;
        if (e.kind === NodeKind.ParenExpr) {
          const p = e as ParenExpr;
          const inner = replaceInChain(p.expression, target, by);
          return inner === p.expression ? e : updateNode(p, { expression: inner } as Partial<ParenExpr>);
        }
        if (e.kind === NodeKind.BinaryExpr) {
          const b = e as BinaryExpr;
          if (b.operator !== '+' && b.operator !== '-') return e;
          const l = replaceInChain(b.left, target, by);
          const r = l === b.left ? replaceInChain(b.right, target, by) : b.right;
          if (l === b.left && r === b.right) return e;
          return updateNode(b, { left: l, right: r } as Partial<BinaryExpr>);
        }
        return e;
      };

      /**
       * `(T *)(<chain>)` where exactly one positive term of the chain is a word
       * cast of an object pointer and every other term is an offset: the cast
       * becomes `(char *)p`, and the chain is byte arithmetic on the pointer.
       */
      const byteArithmetic = (operand: Expression): Expression | null => {
        const terms: Array<{ term: Expression; sign: 1 | -1 }> = [];
        additiveTerms(operand, 1, terms);
        if (terms.length < 2) return null;
        let base: { term: Expression; cast: CStyleCastExpr } | null = null;
        for (const t of terms) {
          const w = wordCastOfPointer(t.term);
          if (w && objectPointer(w.cast.expression)) {
            if (base || t.sign !== 1) return null;
            base = { term: t.term, cast: w.cast };
            continue;
          }
          if (!isOffset(t.term)) return null;
        }
        if (!base) return null;
        const bytes = Expr.cast(Type.pointer(Type.char()), base.cast.expression);
        return replaceInChain(operand, base.term, bytes);
      };

      /** The same cast, spelled with the pointer-sized integer of the same type. */
      const respell = (w: { cast: CStyleCastExpr; word: 'intptr_t' | 'uintptr_t' }): CStyleCastExpr =>
        updateNode(w.cast, { type: Type.typedef(w.word) } as Partial<CStyleCastExpr>);

      /**
       * Respell every word cast of a pointer that is a term of `e`'s additive
       * chain, whatever its sign: the respelling is the same type, so the sum
       * is untouched. Returns `e` itself when there is none.
       */
      const respellChain = (e: Expression): { expr: Expression; hits: number } => {
        const terms: Array<{ term: Expression; sign: 1 | -1 }> = [];
        additiveTerms(e, 1, terms);
        let expr = e;
        let hits = 0;
        for (const t of terms) {
          const w = wordCastOfPointer(t.term);
          if (!w) continue;
          expr = replaceInChain(expr, t.term, respell(w));
          hits++;
        }
        return { expr, hits };
      };

      let changed = false;
      const inner = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind === NodeKind.CStyleCastExpr) {
            const cast = n as CStyleCastExpr;
            const target = shapeOfNode(cast.type, 0, resolve);
            if (!target || target.stars === 0) return undefined;
            // (T *)(int)p -> (T *)p
            const w = wordCastOfPointer(cast.expression);
            if (w && objectPointer(w.cast.expression)) {
              changed = true;
              stats.roundTrip++;
              return updateNode(cast, { expression: w.cast.expression } as Partial<CStyleCastExpr>);
            }
            // (T *)((int)p + K) -> (T *)((char *)p + K)
            const arith = byteArithmetic(cast.expression);
            if (arith) {
              changed = true;
              stats.byteArith++;
              return updateNode(cast, { expression: arith } as Partial<CStyleCastExpr>);
            }
            return undefined;
          }
          if (n.kind !== NodeKind.BinaryExpr) return undefined;
          const b = n as BinaryExpr;
          // (int)a - (int)b: a distance between two addresses.
          if (b.operator === '-') {
            const l = wordCastOfPointer(b.left);
            const r = wordCastOfPointer(b.right);
            if (!l || !r) return undefined;
            changed = true;
            stats.distance++;
            return updateNode(b, { left: respell(l), right: respell(r) } as Partial<BinaryExpr>);
          }
          const isCompare = COMPARISONS.has(b.operator);
          if (!isCompare && !BITWISE.has(b.operator)) return undefined;
          const left = respellChain(b.left);
          const right = respellChain(b.right);
          const hits = left.hits + right.hits;
          if (!hits) return undefined;
          changed = true;
          if (isCompare) stats.compare += hits; else stats.bitwise += hits;
          return updateNode(b, { left: left.expr, right: right.expr } as Partial<BinaryExpr>);
        },
      });

      const newBody = inner(node.body);
      if (!changed) return undefined;
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const pointerWordCastPlugin: TransformPlugin = {
  id: 'pointer-word-cast',
  name: 'Pointer-Word Cast',
  description:
    'Respells address arithmetic Ghidra routes through a 32-bit int in a pointer-sized form that is the same value and type on the 32-bit target: (char*)p + K, intptr_t/uintptr_t, no round trip',
  version: '1.0.0',
  // Last: every pass that recovers a field, index or global from `(int)p + K`
  // has run (the highest of them sit below 990).
  priority: 995,
  // After the vc8form source forms too: they anchor on `(int)p < (int)q` as
  // the decompiler printed it.
  afterSourceForms: true,
  defaultEnabled: true,
  tags: ['cleanup', 'type', 'portability'],
  createTransformer: createPointerWordCastTransformer,
};
