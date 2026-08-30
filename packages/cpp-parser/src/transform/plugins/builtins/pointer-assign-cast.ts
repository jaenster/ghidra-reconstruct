/**
 * Pointer Assignment Cast-Insertion Plugin
 *
 * Ghidra emits `T* x = (U*)expr` / `x = (U*)expr` for what is, in the original
 * binary, a bit-REINTERPRET of one pointer as another. That is valid in the
 * decompiler's model but ill-formed C++ ("cannot convert U* to T* in
 * assignment"). The faithful emission keeps the reinterpret explicit: insert the
 * target-type cast, `x = (T*)expr`.
 *
 * Only fires when BOTH sides are pointers whose pointee types DIFFER and are
 * determinable — so a genuine same-type assignment is untouched. The RHS pointer
 * type is read from a cast (`(U*)e`), an address-of-deref (`&*(U*)e`, which
 * cancels to `(U*)e`), or another pointer local/param. LHS types come from the
 * variable's declaration / parameter list in the same function (no external type
 * map needed — the assert-condition locals etc. are body-declared).
 *
 * AST-based, idempotent: a re-run sees `(T*)(U*)e`, reads the outer `T*`, finds
 * it equal to the target, and inserts nothing.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, VariableDecl, ParameterDecl, Identifier, TypeNode,
  PointerType, BuiltinType, TypedefType, ElaboratedType, Expression,
  CStyleCastExpr, UnaryExpr, ParenExpr, AssignExpr, CallExpr, QualifiedId, BinaryExpr,
  ArrayType, IntegerLiteralExpr, SubscriptExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import { Type } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { typeNodeName, builtinBase } from './call-arg-cast.js';

export interface PointerAssignCastOptions extends PluginOptions {
  /**
   * Names (bare AND qualified) of functions that return `void*`. Ghidra's
   * decompiler emits C, where `void*` converts to any object pointer
   * implicitly; C++ has never allowed that, so the original MSVC source had to
   * write the cast at every `T *p = SMemAlloc(...)`. The allocator's own type is
   * right — it really does return `void*` — so the cast is reconstructed, not a
   * cover for an undetermined type.
   */
  voidPointerFunctions?: string[];
}

/**
 * Stable equality key for a pointer/scalar type; null = can't reason about it.
 *
 * The parser splits a multi-word builtin into a head plus modifiers - `short`
 * is `{ name: 'int', modifiers: ['short'] }`, `unsigned char` is
 * `{ name: 'char', modifiers: ['unsigned'] }`. Reading the head alone collapses
 * short, long, long long and every unsigned variant onto `int`, and both
 * signednesses of char onto `char`, so `unsigned char *x = (char *)e` looked
 * like an identity and no cast was written, while a key that DID differ named
 * the wrong width when the cast was spelled from it. `builtinBase` puts the
 * modifiers back.
 */
function typeKey(t: TypeNode): string | null {
  switch (t.kind) {
    case NodeKind.PointerType: {
      const inner = typeKey((t as PointerType).pointee);
      return inner === null ? null : inner + '*';
    }
    case NodeKind.BuiltinType: {
      const b = t as BuiltinType;
      return builtinBase(b.name, b.modifiers).toLowerCase();
    }
    case NodeKind.TypedefType:
      return typeNodeName((t as TypedefType).name) ?? null;
    case NodeKind.ElaboratedType: {
      const e = t as ElaboratedType;
      const n = typeNodeName(e.name);
      return n !== undefined ? `${e.keyword} ${n}` : null;
    }
    // `T (*)[N]` is the type an array-of-array decays to, and the extent is
    // part of it: a `T (*)[5]` and a `T (*)[128]` are as different as two
    // unrelated struct pointers, and C++ rejects the assignment between them
    // exactly as loudly. Without the extent in the key the two answered alike
    // and the row width could be silently reinterpreted.
    case NodeKind.ArrayType: {
      const a = t as ArrayType;
      const elem = typeKey(a.elementType);
      if (elem === null) return null;
      const size = a.size;
      if (!size || size.kind !== NodeKind.IntegerLiteral) return null;
      return `${elem}[${(size as IntegerLiteralExpr).value}]`;
    }
    default:
      return null; // QualifiedType / funcptr — leave alone
  }
}

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** The spelled name of a call's callee, or undefined for a computed callee. */
function calleeName(expr: Expression): string | undefined {
  if (expr.kind === NodeKind.Identifier) return (expr as Identifier).name;
  if (expr.kind === NodeKind.QualifiedId) {
    const q = expr as QualifiedId;
    if (q.name.kind !== NodeKind.Identifier) return undefined;
    const parts: string[] = [];
    for (const part of q.qualifier) {
      if (part.kind !== NodeKind.Identifier) return undefined;
      parts.push((part as Identifier).name);
    }
    parts.push((q.name as Identifier).name);
    return parts.join('::');
  }
  return undefined;
}

/** The pointer TypeNode a RHS expression evaluates to, or null if not a clear pointer. */
function rhsPointerType(
  expr: Expression,
  typeByName: Map<string, TypeNode>,
  voidPointerFunctions?: Set<string>,
): TypeNode | null {
  const e = unwrapParens(expr);
  // A call to a function the model says returns `void*`.
  if (e.kind === NodeKind.CallExpr && voidPointerFunctions && voidPointerFunctions.size > 0) {
    const name = calleeName((e as CallExpr).callee);
    if (name) {
      const bare = name.includes('::') ? name.slice(name.lastIndexOf('::') + 2) : name;
      if (voidPointerFunctions.has(name) || voidPointerFunctions.has(bare)) {
        return Type.pointer(Type.void());
      }
    }
    return null;
  }
  // (U*)x
  if (e.kind === NodeKind.CStyleCastExpr) {
    const ct = (e as CStyleCastExpr).type;
    return ct.kind === NodeKind.PointerType ? ct : null;
  }
  // &*(U*)x  →  (U*)x  (address-of-deref cancels)
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '&') {
    const inner = unwrapParens((e as UnaryExpr).operand);
    if (inner.kind === NodeKind.UnaryExpr && (inner as UnaryExpr).operator === '*') {
      return rhsPointerType((inner as UnaryExpr).operand, typeByName, voidPointerFunctions);
    }
    return null;
  }
  // another pointer variable
  if (e.kind === NodeKind.Identifier) {
    const t = typeByName.get((e as Identifier).name);
    return t && t.kind === NodeKind.PointerType ? t : null;
  }
  return null;
}

/**
 * Word-sized integer slots a pointer can be stored into. Ghidra's decompiler
 * writes `*(uint *)&local_10 = pszName` for the machine's "store this address in
 * that 4-byte slot"; C++ needs the reinterpret spelled out. Restricted to
 * word-width names deliberately — a pointer into a `char` slot would be a
 * TRUNCATION, and if one ever shows up it is a modelling bug, not a missing cast.
 */
const WORD_INTEGER_TYPES = new Set([
  'int', 'unsigned int', 'unsigned', 'long', 'unsigned long', 'uint', 'ulong',
  'int32_t', 'uint32_t', 'undefined4', 'dword', 'ulong32', 'intptr_t', 'uintptr_t',
  'size_t', 'ssize_t', 'DWORD', 'LONG', 'ULONG', 'BOOL', 'UINT', 'INT', 'DWORD_PTR',
]);

/**
 * Integer types NARROWER than a pointer. `(short)pEnd` is a truncation the
 * machine really performed — the decompiler read a 16-bit slice of an address —
 * but C++ refuses to narrow a pointer in one step ("cast ... loses precision").
 * The faithful spelling widens to `uintptr_t` first and truncates from there,
 * the same two-step the pointer→word-slot store already writes.
 */
const NARROW_INTEGER_TYPES = new Set([
  'char', 'signed char', 'unsigned char', 'schar', 'uchar', 'byte', 'sbyte',
  'int8_t', 'uint8_t', 'undefined1', 'CHAR', 'UCHAR', 'BYTE', 'bool',
  'short', 'short int', 'unsigned short', 'unsigned short int', 'ushort',
  'int16_t', 'uint16_t', 'undefined2', 'SHORT', 'USHORT', 'WORD', 'word',
].map(n => n.toLowerCase()));

/** Is this cast target an integer narrower than a pointer? */
function isNarrowInteger(t: TypeNode): boolean {
  if (t.kind === NodeKind.BuiltinType) {
    const b = t as BuiltinType;
    // `(short)` parses as BuiltinType `int` with a `short` MODIFIER, so the name
    // alone never says how wide the target is.
    const mods = ((b.modifiers ?? []) as unknown as string[]).map(m => String(m).toLowerCase());
    if (mods.includes('long')) return false;
    const name = b.name.trim().toLowerCase();
    if (name === 'char') return true;
    if (mods.includes('short')) return true;
    return NARROW_INTEGER_TYPES.has(name);
  }
  if (t.kind === NodeKind.TypedefType) {
    const n = typeNodeName((t as TypedefType).name);
    return n !== undefined && NARROW_INTEGER_TYPES.has(n.toLowerCase());
  }
  return false;
}

/** The word-integer type of an lvalue, or null when it is not one. */
function wordIntegerType(t: TypeNode): TypeNode | null {
  if (t.kind === NodeKind.BuiltinType) {
    // Same head-plus-modifiers split as `typeKey`: reading the head alone made
    // `short` and `long long` answer to `int` and be treated as pointer-wide.
    const b = t as BuiltinType;
    return WORD_INTEGER_TYPES.has(builtinBase(b.name, b.modifiers).trim().toLowerCase())
      ? t : null;
  }
  if (t.kind === NodeKind.TypedefType) {
    const n = typeNodeName((t as TypedefType).name);
    if (n === undefined) return null;
    return WORD_INTEGER_TYPES.has(n) || WORD_INTEGER_TYPES.has(n.toLowerCase()) ? t : null;
  }
  return null;
}

/**
 * The integer type an assignment TARGET has, for `*(uint *)expr = <pointer>`
 * and for a plain word-integer variable. Anything else returns null.
 */
function integerAssignTarget(lhs: Expression, typeByName: Map<string, TypeNode>): TypeNode | null {
  const e = unwrapParens(lhs);
  if (e.kind === NodeKind.Identifier) {
    const t = typeByName.get((e as Identifier).name);
    return t ? wordIntegerType(t) : null;
  }
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '*') {
    const inner = unwrapParens((e as UnaryExpr).operand);
    if (inner.kind !== NodeKind.CStyleCastExpr) return null;
    const ct = (inner as CStyleCastExpr).type;
    if (ct.kind !== NodeKind.PointerType) return null;
    return wordIntegerType((ct as PointerType).pointee);
  }
  return null;
}

/**
 * The POINTER type an assignment TARGET has, for `*(T **)expr = <pointer>`.
 *
 * `underscore-storage-alias` spells a decompiler slot that overlays a narrower
 * declaration this way — `*(D2UnitStrc *(**)[5])&nServerId` is a 4-byte access
 * at a `uint16_t` parameter's stack slot — so the destination's type is written
 * right there in the cast and needs no type map.
 *
 * Restricted to a pointee that is a pointer to an ARRAY. That is the shape
 * whose extent Ghidra's model and the emitted header disagree about: a
 * multidimensional member decays to a pointer to its ROW, the decompiler walks
 * it one ELEMENT at a time and types the walking slot by the stride it uses, and
 * C++ rejects the assignment that C only warned about. Every other pointee is
 * left to the identifier path above, which has a declared type to compare.
 */
function pointerToArrayAssignTarget(lhs: Expression): TypeNode | null {
  const e = unwrapParens(lhs);
  if (e.kind !== NodeKind.UnaryExpr || (e as UnaryExpr).operator !== '*') return null;
  const inner = unwrapParens((e as UnaryExpr).operand);
  if (inner.kind !== NodeKind.CStyleCastExpr) return null;
  const ct = (inner as CStyleCastExpr).type;
  if (ct.kind !== NodeKind.PointerType) return null;
  const slot = (ct as PointerType).pointee;
  if (slot.kind !== NodeKind.PointerType) return null;
  return (slot as PointerType).pointee.kind === NodeKind.ArrayType ? slot : null;
}

/**
 * A NAMED object on the right of such an assignment — a member, a variable, a
 * subscript. A literal or a call is deliberately not one: the reinterpretation
 * being written back is of an object's ADDRESS, and there is no address to
 * reinterpret in `= 0`.
 */
function isNamedObject(expr: Expression): boolean {
  const e = unwrapParens(expr);
  return e.kind === NodeKind.MemberExpr
    || e.kind === NodeKind.Identifier
    || e.kind === NodeKind.QualifiedId
    || e.kind === NodeKind.SubscriptExpr;
}

/**
 * A pointer-valued RHS, for the pointer→integer store. Broader than
 * `rhsPointerType` because the VALUE is all that matters here, not its pointee:
 * `&x` and a bare array name both decay to an address.
 */
function isPointerValued(
  expr: Expression,
  typeByName: Map<string, TypeNode>,
  voidPointerFunctions?: Set<string>,
): boolean {
  const e = unwrapParens(expr);
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '&') return true;
  if (e.kind === NodeKind.Identifier) {
    const t = typeByName.get((e as Identifier).name);
    return !!t && (t.kind === NodeKind.PointerType || t.kind === NodeKind.ArrayType);
  }
  // `pEnd + 1` / `pEnd - pStart` — pointer arithmetic is still an address (the
  // difference is not, but it is not a pointer either, so it never reaches the
  // narrowing rule through this path unless one side stays a pointer).
  if (e.kind === NodeKind.BinaryExpr) {
    const b = e as BinaryExpr;
    if (b.operator === '+' || b.operator === '-') {
      return isPointerValued(b.left, typeByName, voidPointerFunctions)
        !== isPointerValued(b.right, typeByName, voidPointerFunctions);
    }
    return false;
  }
  return rhsPointerType(e, typeByName, voidPointerFunctions) !== null;
}

/**
 * Pointer typedefs the TARGET headers declare `const`, and the writable pointer
 * each one is a `const` view of.
 *
 * The const-ness is a fact about the header the reconstruction is compiled
 * against, not about the database: Ghidra records `LPCSTR` as `CHAR *` with no
 * qualifier at all, while `winnt.h` spells it `const CHAR *`. So the store rule
 * below cannot read the qualifier off the model, and this states the header's
 * own answer — the same standing as `WORD_INTEGER_TYPES` above.
 *
 * Only the unambiguous ones. `LPCTSTR` resolves through `TCHAR`, whose width
 * depends on `UNICODE`, and naming one of the two here would be a guess.
 */
const CONST_POINTER_TYPEDEFS: Record<string, string> = {
  LPCSTR: 'char',
  PCSTR: 'char',
  LPCCH: 'char',
  PCCH: 'char',
  LPCWSTR: 'wchar_t',
  PCWSTR: 'wchar_t',
  LPCVOID: 'void',
  LPCBYTE: 'BYTE',
};

/**
 * The writable pointer type a const-qualified pointer is a view of, or null.
 *
 * `const char *p` and `LPCSTR p` are the same object type to the machine; the
 * qualifier exists only in the C++ the reconstruction is being compiled as.
 */
function writableViewOf(t: TypeNode): TypeNode | null {
  if (t.kind === NodeKind.PointerType) {
    const pointee = (t as PointerType).pointee;
    if (pointee.kind !== NodeKind.QualifiedType) return null;
    const q = pointee as import('../../../ast/nodes.js').QualifiedType;
    const quals = ((q.qualifiers ?? []) as unknown as string[]).map(x => String(x));
    if (!quals.includes('const')) return null;
    return Type.pointer(q.type);
  }
  if (t.kind === NodeKind.TypedefType) {
    const n = typeNodeName((t as TypedefType).name);
    const pointee = n !== undefined ? CONST_POINTER_TYPEDEFS[n] : undefined;
    if (pointee === undefined) return null;
    return Type.pointer(pointee === 'void' ? Type.void()
      : pointee === 'char' ? Type.char()
      : Type.typedef(pointee));
  }
  return null;
}

/**
 * The identifier a STORE writes through, when the destination is addressed off
 * a base pointer: `p[i] = c`, `*p = c`, `*(p + i) = c`.
 *
 * Only an identifier base counts. A store through a cast already says what type
 * it writes through, and a store through a call result has no name to re-spell.
 */
function storeBaseIdentifier(lhs: Expression): Identifier | null {
  const e = unwrapParens(lhs);
  if (e.kind === NodeKind.SubscriptExpr) {
    const base = unwrapParens((e as SubscriptExpr).array);
    return base.kind === NodeKind.Identifier ? base as Identifier : null;
  }
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '*') {
    let inner = unwrapParens((e as UnaryExpr).operand);
    if (inner.kind === NodeKind.BinaryExpr) {
      const b = inner as BinaryExpr;
      if (b.operator !== '+' && b.operator !== '-') return null;
      const left = unwrapParens(b.left), right = unwrapParens(b.right);
      if (left.kind === NodeKind.Identifier) inner = left;
      else if (b.operator === '+' && right.kind === NodeKind.Identifier) inner = right;
      else return null;
    }
    return inner.kind === NodeKind.Identifier ? inner as Identifier : null;
  }
  return null;
}

/** Rebuild a `*p` / `*(p ± e)` destination with the base identifier re-spelled. */
function replaceIdentifier(lhs: Expression, base: Identifier, replacement: Expression): Expression {
  const rebuild = (e: Expression): Expression => {
    if (e === (base as unknown as Expression)) return replacement;
    if (e.kind === NodeKind.ParenExpr) {
      return updateNode(e, { expression: rebuild((e as ParenExpr).expression) } as Partial<ParenExpr>) as Expression;
    }
    if (e.kind === NodeKind.UnaryExpr) {
      return updateNode(e, { operand: rebuild((e as UnaryExpr).operand) } as Partial<UnaryExpr>) as Expression;
    }
    if (e.kind === NodeKind.BinaryExpr) {
      const b = e as BinaryExpr;
      return updateNode(b, {
        left: rebuild(b.left), right: rebuild(b.right),
      } as Partial<BinaryExpr>) as Expression;
    }
    return e;
  };
  return rebuild(lhs);
}

function needsCast(
  lhsType: TypeNode,
  rhs: Expression,
  typeByName: Map<string, TypeNode>,
  voidPointerFunctions?: Set<string>,
): boolean {
  if (lhsType.kind !== NodeKind.PointerType) return false;
  const rt = rhsPointerType(rhs, typeByName, voidPointerFunctions);
  if (!rt) return false;
  const lk = typeKey(lhsType), rk = typeKey(rt);
  if (lk === null || rk === null) return false;
  return lk !== rk;
}

function createPointerAssignCastTransformer(options?: PluginOptions): Transformer {
  const voidPointerFunctions = new Set(
    (options as PointerAssignCastOptions | undefined)?.voidPointerFunctions ?? [],
  );
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;

      // name → declared pointer type, from params + body-declared locals.
      const typeByName = new Map<string, TypeNode>();
      // `name` is null for unnamed parameters (`void f(void)`, `int f(int)`) - skip those.
      for (const p of node.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) typeByName.set(pd.name.name, pd.type);
      }
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!typeByName.has(v.name.name)) typeByName.set(v.name.name, v.type);
      }

      let changed = false;
      const inner = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          // x = (U*)e  where x is T* and T != U
          if (n.kind === NodeKind.AssignExpr) {
            const a = n as AssignExpr;
            // `pSrcName[i] = c` where `pSrcName` is `LPCSTR` — a STORE through a
            // const-qualified base. Ghidra emits it because the machine's
            // strength-reduced `strcpy` addresses the writable destination off
            // the SOURCE pointer (`MOV [EDX+EAX*1],CL` with `EDX = &dst - src`),
            // and the decompiler keeps the base it was given. The object written
            // is the writable one; C++ is the only party that objects, so the
            // base is re-spelled as the writable pointer it is a const view of.
            // A READ through the same base is well-formed and gets nothing.
            {
              const base = storeBaseIdentifier(a.left);
              const bt = base ? typeByName.get(base.name) : undefined;
              const writable = bt ? writableViewOf(bt) : null;
              if (base && writable) {
                changed = true;
                const recast = Expr.paren(Expr.cast(writable, base));
                const lhs = unwrapParens(a.left);
                if (lhs.kind === NodeKind.SubscriptExpr) {
                  return updateNode(a, {
                    left: updateNode(lhs, { array: recast } as Partial<SubscriptExpr>) as Expression,
                  } as Partial<AssignExpr>);
                }
                return updateNode(a, {
                  left: replaceIdentifier(lhs, base, recast),
                } as Partial<AssignExpr>);
              }
            }
            if (a.operator !== '=') return undefined;
            if (a.left.kind === NodeKind.Identifier) {
              const lt = typeByName.get((a.left as Identifier).name);
              if (lt && needsCast(lt, a.right, typeByName, voidPointerFunctions)) {
                changed = true;
                return updateNode(a, { right: Expr.cast(lt, a.right) } as Partial<AssignExpr>);
              }
            }
            // `*(uint *)&block = ptr` — the machine stores an ADDRESS into a
            // word-sized slot. C++ needs the pointer→integer reinterpret spelled
            // out; `(uintptr_t)` first so it is width-exact on the way in.
            // `*(T (**)[N])&slot = pStruct->aRows` — the member decays to a
            // pointer to ITS row, the slot is typed by the stride the walk
            // uses, and the two extents differ. The address is the same either
            // way, so the cast reinterprets and cannot change what is read; the
            // sibling statement that advances the same slot already carries the
            // identical cast, put there by Ghidra itself.
            const ptrTarget = pointerToArrayAssignTarget(a.left);
            if (ptrTarget && isNamedObject(a.right)) {
              const rt = rhsPointerType(a.right, typeByName, voidPointerFunctions);
              const lk = typeKey(ptrTarget);
              const rk = rt ? typeKey(rt) : null;
              // A determinable RHS of the very same type needs nothing. An
              // undeterminable one is the array member this rule exists for.
              if (lk !== null && (rk === null || rk !== lk)) {
                changed = true;
                return updateNode(a, { right: Expr.cast(ptrTarget, a.right) } as Partial<AssignExpr>);
              }
            }
            const intTarget = integerAssignTarget(a.left, typeByName);
            if (intTarget && isPointerValued(a.right, typeByName, voidPointerFunctions)) {
              changed = true;
              const widened = Expr.cast(Type.typedef('uintptr_t'), a.right);
              return updateNode(a, { right: Expr.cast(intTarget, widened) } as Partial<AssignExpr>);
            }
            return undefined;
          }
          // `(short)pEnd` — a NARROWING read of an address. Widen to
          // `uintptr_t` first so the truncation is the one the machine made
          // rather than an ill-formed one-step pointer narrowing.
          if (n.kind === NodeKind.CStyleCastExpr) {
            const c = n as CStyleCastExpr;
            if (!isNarrowInteger(c.type)) return undefined;
            const operand = unwrapParens(c.expression);
            // Already widened by a previous run — `(short)(uintptr_t)p`.
            if (operand.kind === NodeKind.CStyleCastExpr) return undefined;
            if (!isPointerValued(operand, typeByName, voidPointerFunctions)) return undefined;
            changed = true;
            return updateNode(c, {
              expression: Expr.cast(Type.typedef('uintptr_t'), c.expression),
            } as Partial<CStyleCastExpr>);
          }
          // T* x = (U*)e
          if (n.kind === NodeKind.VariableDecl) {
            const v = n as VariableDecl;
            const init = v.initializer;
            if (!init || init.kind === NodeKind.InitListExpr) return undefined;
            if (!needsCast(v.type, init as Expression, typeByName, voidPointerFunctions)) return undefined;
            changed = true;
            return updateNode(v, { initializer: Expr.cast(v.type, init as Expression) } as Partial<VariableDecl>);
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

export const pointerAssignCastPlugin: TransformPlugin = {
  id: 'pointer-assign-cast',
  name: 'Pointer Assignment Cast Insertion',
  description:
    'Inserts a reinterpret cast when a pointer variable is assigned a differently-typed pointer (faithful for decompiled bit-reinterprets)',
  version: '1.0.0',
  defaultEnabled: true,
  // Late, after boilerplate-cleanup (500): cast the FINAL assignment form.
  priority: 600,
  tags: ['cleanup', 'type'],
  createTransformer: createPointerAssignCastTransformer,
};
