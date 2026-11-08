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
  TypeNode, BuiltinType, IntegerLiteralExpr, ParenExpr, UnaryExpr, AssignExpr, SubscriptExpr, ConditionalExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Type, Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { collectLocalStructs, createExprShape, type ExprShape } from './expr-shape.js';
import {
  asCodeAddress, bareName, cachedSet, calleeName, shapeOfNode, typeFromSpelling, typeNodeName, unwrapParens,
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
  /** Callable name (bare AND qualified) -> its parameter type spellings, in order. */
  functionParamTypes?: Record<string, string[]>;
}

/** Per-form counts since the last reset, for the regen log and the tests. */
export interface PointerWordCastStats {
  byteArith: number;
  roundTrip: number;
  compare: number;
  bitwise: number;
  distance: number;
  /** Words respelled inside an integer that becomes a pointer: `(T *)(<words>)`. */
  toPointer: number;
  /** Words respelled inside an offset onto a pointer: `p + <words>`, `p[<words>]`, `p += <words>`. */
  offset: number;
  /** Words respelled inside a value that lands in a pointer-sized integer: `(size_t)(<words>)`, `m_next = <words>`, `memset(p, 0, <words>)`. */
  sizedSlot: number;
  /** Words respelled in a sum whose addresses cancel, `(int)a + (n - (int)b)`: a distance, however reassociated. */
  balanced: number;
  /** `(int)(T *)K` -> `(int)K`: a constant's round trip through a pointer. */
  literal: number;
  /** `(I)(p + (n - (int)q))` -> `(I)(p - q + n)`: a byte distance the decompiler reassociated. */
  byteDistance: number;
  /** `(T *)(c ? 0 : (uint32_t)p)` -> `(c ? nullptr : (T *)p)`: a select between pointers. */
  select: number;
  /** `if ((int)p)`, `!(int)p`, `(int)p && x` -> the pointer itself: a truth test. */
  truth: number;
  /** Locals `int d = K - (int)p` used only to address memory, declared `intptr_t`. */
  relay: number;
}

const stats: PointerWordCastStats = {
  byteArith: 0, roundTrip: 0, compare: 0, bitwise: 0, distance: 0, toPointer: 0, offset: 0, sizedSlot: 0, balanced: 0, literal: 0,
  byteDistance: 0, select: 0, truth: 0, relay: 0,
};
export function getPointerWordCastStats(): PointerWordCastStats { return { ...stats }; }
export function resetPointerWordCastStats(): void {
  stats.byteArith = stats.roundTrip = stats.compare = stats.bitwise = stats.distance = 0;
  stats.toPointer = stats.offset = stats.sizedSlot = stats.balanced = stats.literal = 0;
  stats.byteDistance = stats.select = stats.truth = stats.relay = 0;
}

/** Pointees one byte wide: arithmetic on such a pointer is arithmetic on its address. */
const BYTE_POINTEES = new Set([
  'char', 'signed char', 'unsigned char', 'uchar', 'byte', 'BYTE', 'CHAR', 'UCHAR', 'int8_t', 'uint8_t', 'undefined1',
]);

/**
 * Integer types of at most 32 bits, as a cast spells them (resolved or not). Converting a
 * 32-bit address to one keeps the address's low bits, as converting the same 32-bit
 * integer does; a 64-bit one would zero-extend a pointer but sign-extend an `int`.
 */
const WORD_OR_NARROWER = new Set([
  'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int', 'long', 'unsigned long',
  'uchar', 'byte', 'BYTE', 'CHAR', 'UCHAR', 'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int32_t', 'uint32_t',
  'ushort', 'WORD', 'SHORT', 'USHORT', 'uint', 'INT', 'UINT', 'LONG', 'ULONG', 'DWORD', 'undefined4', 'int4', 'u_int',
  'unsigned', 'BOOL',
]);

/**
 * Integer types as wide as a pointer on every target, by the name a declaration
 * spells. A value that lands in one is a pointer word, whatever arithmetic made it.
 */
const POINTER_SIZED_INTEGERS = new Set([
  'intptr_t', 'uintptr_t', 'size_t', 'ssize_t', 'ptrdiff_t',
  'INT_PTR', 'UINT_PTR', 'LONG_PTR', 'ULONG_PTR', 'DWORD_PTR', 'SIZE_T', 'SSIZE_T',
]);

/** Operators along which an integer is still the same word: its value reaches the result. */
const SPINE_BINARY = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);
const SPINE_UNARY = new Set(['-', '~', '+']);

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

/**
 * The C library's size parameters, by position: the standard fixes them as `size_t`
 * where the program's model has no declaration of its own.
 */
const CRT_SIZE_PARAMS: Readonly<Record<string, readonly number[]>> = {
  memset: [2], memcpy: [2], memmove: [2], memcmp: [2], memchr: [2], strncpy: [2], strncmp: [2], strncat: [2],
  wcsncpy: [2], wcsncmp: [2], malloc: [0], calloc: [0, 1], realloc: [1],
};

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
      // A frame object (`__frame0.szBuf`) is a struct the body declares itself.
      const localStructs = collectLocalStructs(node.body);
      const shapeOf: ExprShape = createExprShape(localTypes, {
        localStructs,
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });

      // The declared type of a slot as spelled, typedefs unresolved: `intptr_t` is
      // `int` to the resolver, and here the difference is the point.
      const spelledShape: ExprShape = createExprShape(localTypes, {
        localStructs,
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
      });
      const isPointerSizedSlot = (e: Expression): boolean => {
        const s = spelledShape(e);
        return !!s && s.stars === 0 && POINTER_SIZED_INTEGERS.has(s.base.replace(/^::/, ''));
      };
      const isPointerSizedType = (t: TypeNode): boolean => {
        const s = shapeOfNode(t, 0);
        return !!s && s.stars === 0 && POINTER_SIZED_INTEGERS.has(s.base.replace(/^::/, ''));
      };
      /** A pointer value: an object or code pointer, not an integer. */
      const isPointerValue = (e: Expression): boolean => {
        const s = shapeOf(e);
        return !!s && s.stars > 0;
      };

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

      /**
       * A pointer already cast to a pointer-sized integer, `(intptr_t)p`: a word of an
       * address that needs no respelling, but still counts as one where a sum or a
       * difference is told apart by its words (`(intptr_t)p - (int)q` is a distance).
       */
      const sizedWordOfPointer = (e: Expression): boolean => {
        const u = unwrapParens(e);
        if (u.kind !== NodeKind.CStyleCastExpr) return false;
        const cast = u as CStyleCastExpr;
        const s = shapeOfNode(cast.type, 0);
        if (!s || s.stars !== 0 || (s.base !== 'intptr_t' && s.base !== 'uintptr_t')) return false;
        return isPointerValue(cast.expression);
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
       * The body-declared locals that are relay words: a 32-bit `int`/`unsigned int`
       * (spelled so, or `int32_t`/`uint32_t`) whose address is never taken, every store into
       * which is a sum of address words (`K - (int)p`, `(int)&buf + n`) and integer offsets
       * with at least one address word among all of them, and every read of which is a term
       * of address arithmetic: the index of a subscript of a pointer, a term of a sum that is
       * added to a pointer or converted to one, or a term of its own next store. Such a word
       * is the strength-reduced difference of two addresses (an inlined copy's destination
       * minus its source), never a number of its own. Its pointer-sized type is the same type
       * on the 32-bit target, so every value and every instruction stays as it was.
       */
      const relayWords = (body: ASTNode, types: ReadonlyMap<string, TypeNode>): Map<string, 'intptr_t' | 'uintptr_t'> => {
        const decls = new Map<string, VariableDecl[]>();
        for (const d of findNodesByKind(body, NodeKind.VariableDecl)) {
          const v = d as VariableDecl;
          decls.set(v.name.name, [...(decls.get(v.name.name) ?? []), v]);
        }
        const params = new Set(node.parameters.map(p => (p as ParameterDecl).name?.name).filter((n): n is string => !!n));
        const cand = new Map<string, 'intptr_t' | 'uintptr_t'>();
        for (const [name, ds] of decls) {
          if (ds.length !== 1 || params.has(name)) continue;
          const word = pointerWordFor(ds[0].type);
          if (!word || ds[0].type !== types.get(name)) continue;
          cand.set(name, word);
        }
        if (cand.size === 0) return cand;
        const refused = new Set<string>();
        const fed = new Set<string>();
        /** Read at least once as a term of address arithmetic: a word that is never spent is no relay. */
        const spent = new Set<string>();
        /** A store's value: address words and offsets (and the variable itself), true when it holds an address word. */
        const storedValue = (v: string, e: Expression, compound: boolean): void => {
          const terms: Array<{ term: Expression; sign: 1 | -1 }> = [];
          additiveTerms(e, 1, terms);
          for (const t of terms) {
            if (wordCastOfPointer(t.term) || sizedWordOfPointer(t.term)) { if (!compound) fed.add(v); continue; }
            const u = unwrapParens(t.term);
            if (u.kind === NodeKind.Identifier && (u as { name: string }).name === v) continue;
            if (!isOffset(t.term)) { refused.add(v); return; }
          }
        };
        const walk = (x: ASTNode, chain: ASTNode[]): void => {
          if (x.kind === NodeKind.Identifier) {
            const name = (x as unknown as { name: string }).name;
            if (cand.has(name) && !refused.has(name)) {
              if (readsAsAddress(x, chain, name)) spent.add(name); else refused.add(name);
            }
            return;
          }
          if (x.kind === NodeKind.VariableDecl) {
            const v = x as VariableDecl;
            if (cand.has(v.name.name) && v.initializer) {
              if (v.initializer.kind === NodeKind.InitListExpr) refused.add(v.name.name);
              else storedValue(v.name.name, v.initializer as Expression, false);
            }
            if (v.initializer) walk(v.initializer as ASTNode, [...chain, x]);
            return;
          }
          if (x.kind === NodeKind.AssignExpr) {
            const a = x as AssignExpr;
            const left = unwrapParens(a.left);
            if (left.kind === NodeKind.Identifier && cand.has((left as { name: string }).name)) {
              const name = (left as { name: string }).name;
              if (a.operator === '=') storedValue(name, a.right, false);
              else if (a.operator === '+=' || a.operator === '-=') storedValue(name, a.right, true);
              else refused.add(name);
              walk(a.right, [...chain, x]);
              return;
            }
          }
          if ((x.kind === NodeKind.UnaryExpr || x.kind === NodeKind.PostfixExpr)) {
            const op = (x as UnaryExpr).operator;
            const operand = unwrapParens((x as UnaryExpr).operand);
            if (op === '&' && operand.kind === NodeKind.Identifier) { refused.add((operand as { name: string }).name); return; }
            if ((op === '++' || op === '--') && operand.kind === NodeKind.Identifier && cand.has((operand as { name: string }).name)) {
              // A step of its own, as a whole statement: the word moves by one.
              const parent = chain[chain.length - 1];
              if (!parent || parent.kind !== NodeKind.ExprStmt) refused.add((operand as { name: string }).name);
              return;
            }
          }
          for (const [k, val] of Object.entries(x)) {
            if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
            if (Array.isArray(val)) { for (const i of val) if (i && typeof i === 'object' && 'kind' in i) walk(i as ASTNode, [...chain, x]); }
            else if (val && typeof val === 'object' && 'kind' in (val as object)) walk(val as ASTNode, [...chain, x]);
          }
        };
        /**
         * Whether the read `id` (its ancestors in `chain`) is a term of address arithmetic,
         * climbing the sum it is a term of.
         */
        const readsAsAddress = (id: ASTNode, chain: ASTNode[], name: string): boolean => {
          let child: ASTNode = id;
          for (let i = chain.length - 1; i >= 0; i--) {
            const p = chain[i];
            if (p.kind === NodeKind.ParenExpr) { child = p; continue; }
            if (p.kind === NodeKind.BinaryExpr && ((p as BinaryExpr).operator === '+' || (p as BinaryExpr).operator === '-')) {
              const b = p as BinaryExpr;
              const other = child === b.left ? b.right : b.left;
              // p + <sum>, <sum> + p, p - <sum>: an offset onto a pointer.
              if (isPointerValue(other) && !(b.operator === '-' && child === b.left)) return true;
              child = p;
              continue;
            }
            if (p.kind === NodeKind.SubscriptExpr) return child === (p as SubscriptExpr).index && isPointerValue((p as SubscriptExpr).array);
            if (p.kind === NodeKind.CStyleCastExpr) {
              const t = shapeOfNode((p as CStyleCastExpr).type, 0, resolve);
              return !!t && t.stars > 0;
            }
            if (p.kind === NodeKind.AssignExpr) {
              // A term of its own next store.
              const a = p as AssignExpr;
              const l = unwrapParens(a.left);
              return child === a.right && l.kind === NodeKind.Identifier && (l as { name: string }).name === name;
            }
            return false;
          }
          return false;
        };
        walk(body, []);
        for (const name of [...cand.keys()]) if (refused.has(name) || !fed.has(name) || !spent.has(name)) cand.delete(name);
        return cand;
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

      /** `e` with `target` (itself, or under parentheses) replaced. */
      const replaceInParens = (e: Expression, target: Expression, by: Expression): Expression => {
        if (e === target) return by;
        if (e.kind === NodeKind.ParenExpr) {
          const p = e as ParenExpr;
          return updateNode(p, { expression: replaceInParens(p.expression, target, by) } as Partial<ParenExpr>);
        }
        return e;
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

      /**
       * Respell every word cast of a pointer on `e`'s spine: the operands its value is
       * computed from by integer arithmetic (SPINE_BINARY, SPINE_UNARY, parentheses).
       * Not through a load, a call or a subscript, whose result is another value. The
       * respelling is the same type on the 32-bit target, so whatever the operators
       * do with the word, they do the same.
       */
      const respellSpine = (e: Expression): { expr: Expression; hits: number } => {
        const w = wordCastOfPointer(e);
        if (w) {
          // `(int)(p + K)`: the word of a sum; a cast inside its operand is another
          // word and stays as it is.
          return { expr: replaceInParens(e, w.cast, respell(w)), hits: 1 };
        }
        if (e.kind === NodeKind.ParenExpr) {
          const p = e as ParenExpr;
          const r = respellSpine(p.expression);
          return r.hits ? { expr: updateNode(p, { expression: r.expr } as Partial<ParenExpr>), hits: r.hits } : { expr: e, hits: 0 };
        }
        if (e.kind === NodeKind.BinaryExpr) {
          const b = e as BinaryExpr;
          if (!SPINE_BINARY.has(b.operator)) return { expr: e, hits: 0 };
          const l = respellSpine(b.left);
          const r = respellSpine(b.right);
          if (!l.hits && !r.hits) return { expr: e, hits: 0 };
          return { expr: updateNode(b, { left: l.expr, right: r.expr } as Partial<BinaryExpr>), hits: l.hits + r.hits };
        }
        if (e.kind === NodeKind.UnaryExpr) {
          const u = e as UnaryExpr;
          if (!SPINE_UNARY.has(u.operator)) return { expr: e, hits: 0 };
          const r = respellSpine(u.operand);
          return r.hits ? { expr: updateNode(u, { operand: r.expr } as Partial<UnaryExpr>), hits: r.hits } : { expr: e, hits: 0 };
        }
        return { expr: e, hits: 0 };
      };

      /**
       * The additive chain under `e`, when its word casts of pointers cancel: as many
       * enter it added as subtracted. Whatever the reassociation (`(int)a + (n - (int)b)`),
       * its value is a distance between addresses plus integers.
       */
      const balanced = (e: Expression): boolean => {
        const terms: Array<{ term: Expression; sign: 1 | -1 }> = [];
        additiveTerms(e, 1, terms);
        let up = 0, down = 0;
        let words = 0;
        for (const t of terms) {
          const w = wordCastOfPointer(t.term);
          if (w || sizedWordOfPointer(t.term)) { if (t.sign === 1) up++; else down++; if (w) words++; continue; }
          if (isPointerValue(t.term)) return false;
        }
        return up > 0 && up === down && words > 0;
      };

      /**
       * The object-pointer shape of `e`: its own, or for a sum with one positive object
       * pointer term and offsets otherwise (`p + 5`), that term's. Null when it is not one.
       */
      const addressShape = (e: Expression): TypeShape | null => {
        const own = objectPointer(e);
        if (own) return own;
        const terms: Array<{ term: Expression; sign: 1 | -1 }> = [];
        additiveTerms(e, 1, terms);
        if (terms.length < 2) return null;
        let base: TypeShape | null = null;
        for (const t of terms) {
          const s = objectPointer(t.term);
          if (s) { if (base || t.sign !== 1) return null; base = s; continue; }
          if (!isOffset(t.term)) return null;
        }
        return base;
      };
      /** An integer cast of at most 32 bits (or pointer-sized) of an object pointer. */
      const integerCastOfAddress = (e: Expression): { pointer: Expression; shape: TypeShape } | null => {
        const u = unwrapParens(e);
        if (u.kind !== NodeKind.CStyleCastExpr) return null;
        const c = u as CStyleCastExpr;
        const spelled = shapeOfNode(c.type, 0);
        const resolved = shapeOfNode(c.type, 0, resolve);
        const word = (s: TypeShape | null) => !!s && s.stars === 0 && (WORD_OR_NARROWER.has(s.base) || POINTER_SIZED_INTEGERS.has(s.base));
        if (!word(spelled) && !word(resolved)) return null;
        if (!pointerWordFor(c.type) && !isPointerSizedType(c.type)) return null;
        const shape = addressShape(c.expression);
        return shape ? { pointer: c.expression, shape } : null;
      };
      const byteShape = (s: TypeShape) => s.stars === 1 && BYTE_POINTEES.has(s.base.replace(/^::/, ''));
      const sameShape = (a: TypeShape, b: TypeShape) => a.base === b.base && a.stars === b.stars;
      const wrap = (e: Expression): Expression => {
        const u = e.kind === NodeKind.ParenExpr ? e : unwrapParens(e);
        return u.kind === NodeKind.BinaryExpr || u.kind === NodeKind.ConditionalExpr || u.kind === NodeKind.AssignExpr ? Expr.paren(u) : u;
      };

      /**
       * `(I)(p + (n - (int)q))`, I an integer of at most 32 bits: the decompiler's reassociation
       * of `p - q + n`, a distance between two addresses plus integers. The sum's terms are one
       * positive pointer p to a one-byte pointee (so its arithmetic is address arithmetic), one
       * negative integer cast of an address q, and integer offsets. It is written as the
       * difference `p - q` (both through `char *` where their types differ) plus the offsets in
       * their order: modulo 2^32 the same sum, every term at most 32 bits, and the cast to I
       * takes the same low bits of it.
       */
      const byteDistance = (cast: CStyleCastExpr): Expression | null => {
        const target = shapeOfNode(cast.type, 0);
        const resolved = shapeOfNode(cast.type, 0, resolve);
        if (!target || target.stars !== 0 || isPointerSizedType(cast.type)) return null;
        if (!WORD_OR_NARROWER.has(target.base) && !(resolved && WORD_OR_NARROWER.has(resolved.base))) return null;
        const terms: Array<{ term: Expression; sign: 1 | -1 }> = [];
        additiveTerms(cast.expression, 1, terms);
        if (terms.length < 2) return null;
        let p: { term: Expression; shape: TypeShape } | null = null;
        let q: { term: Expression; pointer: Expression; shape: TypeShape } | null = null;
        for (const t of terms) {
          const s = objectPointer(t.term);
          if (s) {
            if (p || t.sign !== 1 || !byteShape(s)) return null;
            p = { term: t.term, shape: s };
            continue;
          }
          if (!q && t.sign === -1) {
            const a = integerCastOfAddress(t.term);
            if (a) { q = { term: t.term, ...a }; continue; }
          }
          if (!isOffset(t.term)) return null;
        }
        if (!p || !q) return null;
        const bytes = (e: Expression) => Expr.cast(Type.pointer(Type.char()), wrap(e)) as unknown as Expression;
        const same = sameShape(p.shape, q.shape);
        let sum: Expression = Expr.binary(same ? wrap(p.term) : bytes(p.term), '-', same ? wrap(q.pointer) : bytes(q.pointer)) as unknown as Expression;
        for (const t of terms) {
          if (t.term === p.term || t.term === q.term) continue;
          // `+ -n` is `- n`: the same sum modulo 2^32.
          let term = unwrapParens(t.term);
          let sign = t.sign;
          if (term.kind === NodeKind.UnaryExpr && (term as UnaryExpr).operator === '-') { term = (term as UnaryExpr).operand; sign = sign === 1 ? -1 : 1; }
          sum = Expr.binary(sum, sign === 1 ? '+' : '-', wrap(term)) as unknown as Expression;
        }
        return Expr.paren(sum) as unknown as Expression;
      };

      /**
       * `(T *)(c ? 0 : (uint32_t)p)` (either arm), p an object pointer: the select the
       * decompiler printed in integers. As a select between pointers it is `(c ? nullptr : p)`
       * with p converted to T * where its type is another: the same address or null.
       */
      const pointerSelect = (cast: CStyleCastExpr): Expression | null => {
        const u = unwrapParens(cast.expression);
        if (u.kind !== NodeKind.ConditionalExpr) return null;
        const c = u as ConditionalExpr;
        const zero = (e: Expression) => {
          let x = unwrapParens(e);
          if (x.kind === NodeKind.CStyleCastExpr) x = unwrapParens((x as CStyleCastExpr).expression);
          return x.kind === NodeKind.IntegerLiteral && (x as IntegerLiteralExpr).value === 0n;
        };
        const target = shapeOfNode(cast.type, 0, resolve);
        if (!target) return null;
        const arm = (e: Expression): Expression | null => {
          if (zero(e)) return Expr.nullptr() as unknown as Expression;
          const a = integerCastOfAddress(e);
          if (!a) return null;
          return sameShape(a.shape, target) && objectPointer(a.pointer) ? wrap(a.pointer) : Expr.cast(cast.type, wrap(a.pointer)) as unknown as Expression;
        };
        if (zero(c.thenExpr) && zero(c.elseExpr)) return null;
        const t = arm(c.thenExpr), f = arm(c.elseExpr);
        if (!t || !f) return null;
        return Expr.paren(Expr.conditional(c.condition, t, f)) as unknown as Expression;
      };

      /** Whether argument `index` of `call` is a pointer-sized integer parameter. */
      const sizedParam = (callee: Expression, index: number): boolean => {
        const name = calleeName(callee);
        if (!name) return false;
        const params = o.functionParamTypes ? o.functionParamTypes[name] ?? o.functionParamTypes[bareName(name)] : undefined;
        if (params) {
          const t = index < params.length ? typeFromSpelling(params[index]) : null;
          return !!t && isPointerSizedType(t);
        }
        return (CRT_SIZE_PARAMS[bareName(name)] ?? []).includes(index);
      };

      /**
       * A truth test of a word cast of a pointer, `(int)p` as a condition: the word is
       * nonzero exactly when the pointer is not null (both are the same 32 bits), so the
       * pointer is tested itself. Null when `e` is not such a cast.
       */
      const truthOperand = (e: Expression | null | undefined): Expression | null => {
        if (!e) return null;
        const w = wordCastOfPointer(e);
        if (!w) return null;
        return wrap(w.cast.expression);
      };

      // Relay words: locals that carry an address word between the pointer arithmetic that
      // makes it and the pointer arithmetic that spends it, and nowhere else. They are
      // declared with the pointer-sized integer of the same type before the respelling
      // runs, which then sees them as the pointer-sized slots they are.
      const relays = relayWords(node.body, localTypes);
      let changed = false;
      if (relays.size > 0) {
        for (const [name, word] of relays) {
          localTypes.set(name, Type.typedef(word));
          stats.relay++;
        }
        changed = true;
      }
      const retypeRelays = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.VariableDecl) return undefined;
          const v = n as VariableDecl;
          const word = relays.get(v.name.name);
          return word ? updateNode(v, { type: Type.typedef(word) } as Partial<VariableDecl>) : undefined;
        },
      });

      const inner = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          // if ((int)p), while (!(int)p), (int)p && x, (int)p ? a : b -> the pointer tested.
          const truthIn = <T extends ASTNode>(node: T, fields: Array<keyof T>): ASTNode | undefined => {
            const patch: Partial<T> = {};
            let hits = 0;
            for (const f of fields) {
              const t = truthOperand(node[f] as unknown as Expression);
              if (t) { (patch as Record<string, unknown>)[f as string] = t; hits++; }
            }
            if (!hits) return undefined;
            changed = true;
            stats.truth += hits;
            return updateNode(node, patch);
          };
          switch (n.kind) {
            case NodeKind.IfStmt: case NodeKind.WhileStmt: case NodeKind.DoWhileStmt: case NodeKind.ForStmt:
              return truthIn(n as unknown as { condition: Expression } & ASTNode, ['condition']);
            case NodeKind.ConditionalExpr: {
              const r = truthIn(n as ConditionalExpr, ['condition']);
              if (r) return r;
              break;
            }
            case NodeKind.UnaryExpr:
              if ((n as UnaryExpr).operator === '!') return truthIn(n as UnaryExpr, ['operand']);
              break;
            case NodeKind.BinaryExpr:
              if ((n as BinaryExpr).operator === '&&' || (n as BinaryExpr).operator === '||') return truthIn(n as BinaryExpr, ['left', 'right']);
              break;
            default:
              break;
          }
          if (n.kind === NodeKind.CallExpr) {
            // f(..., <words>, ...) into a size_t parameter: a value made pointer-sized.
            const call = n as unknown as { callee: Expression; arguments: Expression[] };
            let hits = 0;
            const args = call.arguments.map((a, i) => {
              if (!sizedParam(call.callee, i)) return a;
              const spine = respellSpine(a);
              hits += spine.hits;
              return spine.expr;
            });
            if (!hits) return undefined;
            changed = true;
            stats.sizedSlot += hits;
            return updateNode(n, { arguments: args } as never);
          }
          if (n.kind === NodeKind.CStyleCastExpr) {
            const cast = n as CStyleCastExpr;
            const target = shapeOfNode(cast.type, 0, resolve);
            // (int)(T *)K -> (int)K: the constant is the same word either way.
            if (pointerWordFor(cast.type)) {
              const op = unwrapParens(cast.expression);
              if (op.kind === NodeKind.CStyleCastExpr) {
                const ps = shapeOfNode((op as CStyleCastExpr).type, 0, resolve);
                let k = unwrapParens((op as CStyleCastExpr).expression);
                const neg = k.kind === NodeKind.UnaryExpr && (k as UnaryExpr).operator === '-';
                if (neg) k = unwrapParens((k as UnaryExpr).operand);
                if (ps && ps.stars > 0 && k.kind === NodeKind.IntegerLiteral && (k as IntegerLiteralExpr).value <= 0xffffffffn) {
                  changed = true;
                  stats.literal++;
                  return updateNode(cast, { expression: unwrapParens((op as CStyleCastExpr).expression) } as Partial<CStyleCastExpr>);
                }
              }
            }
            // (I)(p + (n - (int)q)) -> (I)(p - q + n): a byte distance, reassociated.
            if (target && target.stars === 0) {
              const d = byteDistance(cast);
              if (d) {
                changed = true;
                stats.byteDistance++;
                return updateNode(cast, { expression: d } as Partial<CStyleCastExpr>);
              }
            }
            // (T *)(c ? 0 : (uint32_t)p) -> (c ? nullptr : (T *)p): a select between pointers.
            if (target && target.stars > 0) {
              const s = pointerSelect(cast);
              if (s) {
                changed = true;
                stats.select++;
                return s;
              }
            }
            if (!target || target.stars === 0) {
              // (size_t)(<words>): a value made pointer-sized on purpose.
              if (!isPointerSizedType(cast.type)) return undefined;
              const spine = respellSpine(cast.expression);
              if (!spine.hits) return undefined;
              changed = true;
              stats.sizedSlot += spine.hits;
              return updateNode(cast, { expression: spine.expr } as Partial<CStyleCastExpr>);
            }
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
            // Any other integer that becomes a pointer: (T *)~(uint32_t)p,
            // (T *)((int)p + (int)q - r) -> the words pointer-sized.
            const spine = respellSpine(cast.expression);
            if (spine.hits) {
              changed = true;
              stats.toPointer += spine.hits;
              return updateNode(cast, { expression: spine.expr } as Partial<CStyleCastExpr>);
            }
            return undefined;
          }
          if (n.kind === NodeKind.SubscriptExpr) {
            // p[<words>]: an offset onto a pointer.
            const sub = n as SubscriptExpr;
            if (!isPointerValue(sub.array)) return undefined;
            const spine = respellSpine(sub.index);
            if (!spine.hits) return undefined;
            changed = true;
            stats.offset += spine.hits;
            return updateNode(sub, { index: spine.expr } as Partial<SubscriptExpr>);
          }
          if (n.kind === NodeKind.AssignExpr) {
            const a = n as AssignExpr;
            // p += <words>, p -= <words>: an offset onto a pointer.
            const ontoPointer = (a.operator === '+=' || a.operator === '-=') && isPointerValue(a.left);
            // slot = <words>, into a pointer-sized integer (a link word, a size).
            const intoSized = !ontoPointer && isPointerSizedSlot(a.left)
              && (a.operator === '=' || a.operator === '+=' || a.operator === '-=');
            if (!ontoPointer && !intoSized) return undefined;
            const spine = respellSpine(a.right);
            if (!spine.hits) return undefined;
            changed = true;
            if (ontoPointer) stats.offset += spine.hits; else stats.sizedSlot += spine.hits;
            return updateNode(a, { right: spine.expr } as Partial<AssignExpr>);
          }
          if (n.kind === NodeKind.VariableDecl) {
            const v = n as VariableDecl;
            if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr || !isPointerSizedType(v.type)) return undefined;
            const spine = respellSpine(v.initializer as Expression);
            if (!spine.hits) return undefined;
            changed = true;
            stats.sizedSlot += spine.hits;
            return updateNode(v, { initializer: spine.expr } as Partial<VariableDecl>);
          }
          if (n.kind !== NodeKind.BinaryExpr) return undefined;
          const b = n as BinaryExpr;
          // p + <words>, <words> + p, p - <words>: an offset onto a pointer.
          if (b.operator === '+' || b.operator === '-') {
            const leftPointer = isPointerValue(b.left);
            const rightPointer = b.operator === '+' && !leftPointer && isPointerValue(b.right);
            if (leftPointer || rightPointer) {
              const side = leftPointer ? b.right : b.left;
              if (isPointerValue(side)) return undefined; // a pointer difference
              const spine = respellSpine(side);
              if (!spine.hits) return undefined;
              changed = true;
              stats.offset += spine.hits;
              return updateNode(b, (leftPointer ? { right: spine.expr } : { left: spine.expr }) as Partial<BinaryExpr>);
            }
          }
          // (int)a + (n - (int)b): a distance, reassociated.
          const wordOrSized = (e: Expression) => !!wordCastOfPointer(e) || sizedWordOfPointer(e);
          if ((b.operator === '+' || b.operator === '-') && balanced(b) && !(b.operator === '-' && wordOrSized(b.left) && wordOrSized(b.right))) {
            const chain = respellChain(b);
            if (chain.hits) {
              changed = true;
              stats.balanced += chain.hits;
              return chain.expr;
            }
          }
          // (int)a - (int)b: a distance between two addresses.
          if (b.operator === '-') {
            const l = wordCastOfPointer(b.left);
            const r = wordCastOfPointer(b.right);
            // One side may already be pointer-sized: `(intptr_t)p - (int)q`.
            if ((!l && !sizedWordOfPointer(b.left)) || (!r && !sizedWordOfPointer(b.right)) || (!l && !r)) return undefined;
            changed = true;
            stats.distance++;
            return updateNode(b, { left: l ? respell(l) : b.left, right: r ? respell(r) : b.right } as Partial<BinaryExpr>);
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

      const newBody = inner(relays.size > 0 ? retypeRelays(node.body) : node.body);
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
