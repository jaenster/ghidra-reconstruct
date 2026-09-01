/**
 * Call-Argument Cast-Insertion Plugin
 *
 * Ghidra's decompiler emits C, and C converts freely across an argument
 * boundary: `void*` reaches any object pointer implicitly, and an integer
 * reaches a pointer (and back) with nothing worse than a warning. C++ has never
 * allowed either, so the original MSVC source carried a cast at every such call
 * site. Reconstructing it is transcription, not repair - the machine really does
 * hand the callee that word.
 *
 * For every call whose callee resolves to a known function, each argument whose
 * OWN type is determinable and whose pointer-ness or pointee differs from the
 * declared parameter is wrapped in a cast to the parameter type, spelled exactly
 * as the declaration spells it.
 *
 * Deliberately narrow:
 *  - only fires when at least one side is a pointer, because an integer-to-
 *    integer argument mismatch is legal C++ and needs no cast (a cast there
 *    would be pure noise);
 *  - never fires when the parameter is `void*`, which every object pointer
 *    still reaches implicitly;
 *  - never fires on a function-pointer parameter - `funcptr-arg-cast` owns
 *    those, and it compares whole prototypes rather than one slot;
 *  - never fires when the argument's type cannot be established, so an
 *    unmodelled expression is left exactly as the decompiler wrote it.
 *
 * AST-based and idempotent: a re-run reads the cast it inserted, finds it equal
 * to the parameter type, and inserts nothing.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, VariableDecl, ParameterDecl, Identifier, TypeNode,
  PointerType, BuiltinType, TypedefType, ElaboratedType, ArrayType, QualifiedType,
  Expression, CStyleCastExpr, UnaryExpr, ParenExpr, CallExpr, QualifiedId,
  MemberExpr, SubscriptExpr, BinaryExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Type, Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape } from './expr-shape.js';

export interface CallArgCastOptions extends PluginOptions {
  /** Callable name (bare AND qualified) → declared parameter type spellings */
  functionParamTypes?: Record<string, string[]>;
  /**
   * Imported-SDK callee → parameter type spellings, recovered from the
   * decompiler's own per-argument annotations. Consulted only where
   * `functionParamTypes` has no answer, and — the reason for the separate
   * table — a slot from it is cast into ONLY when the declared parameter AND
   * the argument are both pointers.
   *
   * That restriction is what keeps `int -> LPCSTR` loud. Those integers hold
   * packed inline string data (`0x73257325` is `"%s%s"` in an immediate), and a
   * cast there compiles into a wild pointer. Excluding them by construction is
   * the point; a list of exceptions would not survive the next regen.
   */
  pointerOnlyParamTypes?: Record<string, string[]>;
  /** Callable name (bare AND qualified) → declared return type spelling */
  functionReturnTypes?: Record<string, string>;
  /** Global variable name → its declared type spelling */
  globalTypes?: Record<string, string>;
  /** Callables with a `...` tail */
  varArgFunctions?: string[];
  /** Funcdef typedef names — a parameter spelled with one belongs to funcptr-arg-cast */
  funcdefNames?: string[];
  /**
   * Every spelling that denotes a FUNCTION. A function designator is not an
   * object and has no `TypeShape`, so this is what tells the pass that an
   * argument is a callback address rather than an unmodelled expression.
   */
  functionNames?: string[];
  /** Data-symbol names — a name that denotes data is never treated as a function */
  variableNames?: string[];
  /**
   * The enclosing function's own parameter and local type spellings. The body
   * is transformed inside a `void dummy()` wrapper, so a PARAMETER's type is
   * nowhere in the AST — and passing a parameter straight on to another call is
   * the commonest argument shape there is.
   */
  enclosingVarTypes?: Record<string, string>;
  /** Field name → declared type, where every aggregate declaring it agrees */
  fieldTypes?: Record<string, string>;
  /**
   * Typedef name → the spelling it stands for. `LPCANDIDATELIST` and `HACCEL`
   * ARE pointers with no star in the name; without this a pointer stored into
   * one of them reads as an integer store and no cast is written.
   */
  typedefTargets?: Record<string, string>;
  /**
   * Aggregate name → field name → declared type. Where the expression says
   * WHICH struct it walks, the field's type is exact and the unanimity rule
   * behind `fieldTypes` does not have to apply.
   */
  structFields?: Record<string, Record<string, string>>;
  /** Funcdef name → the return and parameter spellings the funcdef declares */
  funcdefDecls?: Record<string, FuncdefDecl>;
  /** Aggregate name → field name → the funcdef its declared type names */
  structFieldFuncdefs?: Record<string, Record<string, string>>;
  /** Field name → funcdef, where every aggregate declaring that name agrees */
  fieldFuncdefs?: Record<string, string>;
}

/**
 * What a funcdef declares. A call through a function-pointer field or variable
 * has no callee NAME, so every name-keyed table in this pass misses it and both
 * its result and its arguments come out untyped. The funcdef the slot is
 * declared with is the contract that call is made under, and this is it.
 */
export interface FuncdefDecl {
  returnType: string;
  paramTypes: string[];
  varArgs?: boolean;
}

/** The three tables that turn a computed callee into the funcdef it calls. */
export interface FuncdefCalleeTables {
  funcdefDecls?: Record<string, FuncdefDecl>;
  structFieldFuncdefs?: Record<string, Record<string, string>>;
  fieldFuncdefs?: Record<string, string>;
}

/**
 * Resolve the callee of a call made through a function pointer to the funcdef
 * that declares it — `gpBNetCallbacks->pfnBnetLoadAndReturn()`,
 * `pTable[i].fpUpdate(...)`, `(*pfn)(...)`, a funcdef-typed local or global.
 *
 * `shapeOf` supplies the type of an ordinary expression, which is how the
 * OBJECT side of a member access is identified; the field itself cannot come
 * from there, because a funcdef field is emitted as an inline declarator and so
 * carries no reducible type spelling at all.
 *
 * Returns undefined for anything the model does not place, which is what leaves
 * a call whose slot Ghidra typed as an integer exactly as the decompiler wrote
 * it — that disagreement belongs in the database, not under a cast.
 */
export function createFuncdefCalleeResolver(
  tables: FuncdefCalleeTables,
  shapeOf: (expr: Expression) => TypeShape | null,
): (callee: Expression) => FuncdefDecl | undefined {
  const decls = tables.funcdefDecls ?? {};
  const structFieldFuncdefs = tables.structFieldFuncdefs ?? {};
  const fieldFuncdefs = tables.fieldFuncdefs ?? {};
  if (Object.keys(decls).length === 0) return () => undefined;

  return (callee: Expression): FuncdefDecl | undefined => {
    let e = unwrapParens(callee);
    // `(*pfn)(...)` and `(**pfn)(...)` call the very same function `pfn` does:
    // dereferencing a function pointer yields the function, and the address of
    // a function is the function again. Peeling is exact, not an approximation.
    while (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '*') {
      e = unwrapParens((e as UnaryExpr).operand);
    }
    if (e.kind === NodeKind.MemberExpr) {
      const m = e as MemberExpr;
      const member = (m.member as { name?: string })?.name;
      if (typeof member !== 'string') return undefined;
      // Where the walk says WHICH aggregate it is in, the field is exact.
      const obj = shapeOf(m.object);
      if (obj && obj.stars === (m.isArrow ? 1 : 0)) {
        const own = structFieldFuncdefs[obj.base];
        // The aggregate this walks is known, so its own answer settles it -
        // including the answer "this field is not a function pointer", which a
        // unanimous table built from OTHER structs must not overrule.
        if (own) return own[member] ? decls[own[member]] : undefined;
      }
      const anyAggregate = fieldFuncdefs[member];
      return anyAggregate ? decls[anyAggregate] : undefined;
    }
    const shape = shapeOf(e);
    // A funcdef typedef IS the pointer type (`typedef void (*fnFoo)()`), so the
    // slot holding one is star-less; one more star is a pointer to that slot.
    if (!shape || shape.stars > 1) return undefined;
    return decls[shape.base];
  };
}

/**
 * A type reduced to what decides whether a conversion is legal: the pointee
 * chain depth and the canonical name underneath it. `null` means the spelling
 * carries something this plugin refuses to reason about (a function pointer, a
 * template, an array dimension) and the argument is left alone.
 */
export interface TypeShape { base: string; stars: number; isConst: boolean }

/**
 * A resolved parameter list plus how far it may be trusted. `pointerOnly` marks
 * a list recovered from the decompiler's argument annotations rather than from a
 * declaration, and restricts it to the pointer boundary. `variadic` marks a
 * callee with a `...` tail: `spellings` still covers only the NAMED
 * parameters, and an argument past that count has no declared type at all -
 * it is passed under default argument promotion, not a cast.
 */
interface Declared { spellings: string[]; pointerOnly: boolean; variadic: boolean }

/**
 * Spellings that name the SAME C++ type. Ghidra and the Windows headers each
 * have their own vocabulary for a machine word, and a cast between two names
 * for one type is noise. Getting an entry wrong is safe in both directions:
 * a missing alias adds a redundant cast, a wrong one skips a cast that was
 * never going to compile anyway - neither can change what the program does.
 *
 * `LONG`/`DWORD` are deliberately NOT folded into `int`: MSVC's `long` is a
 * distinct type from `int`, and `LONG*` really does not convert to `int*`.
 */
const TYPE_ALIASES: Record<string, string> = {
  'int32_t': 'int', 'INT': 'int', 'BOOL': 'int', 'int4': 'int',
  'uint32_t': 'unsigned int', 'uint': 'unsigned int', 'undefined4': 'unsigned int',
  'unsigned': 'unsigned int', 'UINT': 'unsigned int', 'u_int': 'unsigned int',
  'int16_t': 'short', 'short int': 'short', 'SHORT': 'short',
  'uint16_t': 'unsigned short', 'ushort': 'unsigned short', 'undefined2': 'unsigned short',
  'word': 'unsigned short', 'WORD': 'unsigned short', 'unsigned short int': 'unsigned short',
  'int8_t': 'signed char', 'sbyte': 'signed char',
  'uint8_t': 'unsigned char', 'byte': 'unsigned char', 'undefined1': 'unsigned char',
  'BYTE': 'unsigned char', 'uchar': 'unsigned char', 'UCHAR': 'unsigned char',
  'undefined': 'unsigned char',
  'int64_t': 'long long', 'longlong': 'long long', 'undefined8': 'unsigned long long',
  'uint64_t': 'unsigned long long', 'ulonglong': 'unsigned long long',
  'ulong': 'unsigned long', 'ULONG': 'unsigned long', 'DWORD': 'unsigned long',
  'LONG': 'long', 'long int': 'long',
  'CHAR': 'char',
};

/**
 * Integer types exactly as wide as a pointer on this target. A pointer (or a
 * function address) may be stored into one of these and read back; anything
 * narrower loses address bits, which is never what the machine did.
 */
export const WORD_INTEGER_BASES = new Set([
  'int', 'unsigned int', 'long', 'unsigned long', 'uintptr_t', 'intptr_t',
  'size_t', 'ssize_t', 'pointer32',
]);

export const isWordIntegerShape = (s: TypeShape) =>
  s.stars === 0 && WORD_INTEGER_BASES.has(s.base);

/**
 * Canonical bases that name an ARITHMETIC type. Everything reduces to one of
 * these through `TYPE_ALIASES`, so a base outside the set with no indirection is
 * a name whose real shape this pass never saw - a Win32 callback typedef such as
 * `FARPROC`, whose Ghidra record is self-referential and therefore dropped from
 * the typedef map.
 */
export const SCALAR_BASES = new Set([
  'char', 'signed char', 'unsigned char', 'short', 'unsigned short',
  'int', 'unsigned int', 'long', 'unsigned long', 'long long',
  'unsigned long long', 'float', 'double', 'long double', 'bool', 'void',
  'wchar_t', 'uintptr_t', 'intptr_t', 'size_t', 'ssize_t', 'pointer32',
]);

/**
 * True for a star-less base that is neither arithmetic nor an aggregate the model
 * knows: an opaque callback typedef (`FARPROC`) that hides a whole prototype, so
 * there is nothing to compare against and nothing a cast can freeze.
 */
/**
 * `new Set(names)` over a project-wide name table, memoised on the ARRAY. The
 * plugin options object is rebuilt for every function body while these tables
 * are built once and handed on unchanged, so without this the pass pays for a
 * 50,000-entry Set once per function.
 */
/**
 * The last segment of a possibly qualified name. Slicing at the separator index
 * plus two returns 1 for an UNQUALIFIED name and silently chops its first
 * character, so `gnData` was probed as `nData` - every bare-name lookup missed.
 */
export function bareName(name: string): string {
  const cut = name.lastIndexOf('::');
  return cut === -1 ? name : name.slice(cut + 2);
}

/**
 * The spelled name in a type node's `name` slot.
 *
 * That slot holds an `Identifier` as parsed, but a root-qualified type
 * (`::D2WinImage`, written by `shadowed-type-qualify` / `root-scope-qualify` so
 * a same-named namespace cannot hide the type) holds a `QualifiedId` instead.
 * Reading `.name` off it then yields a NODE, not a string, and every type table
 * keyed on the spelling silently missed — so every cast pass stopped reasoning
 * about exactly the types the emitter had to disambiguate. The tail is what the
 * tables are keyed on, so that is what comes back.
 */
export function typeNodeName(name: unknown): string | undefined {
  const n = name as { kind?: string; name?: unknown } | undefined | null;
  if (!n || typeof n !== 'object') return undefined;
  if (typeof n.name === 'string') return n.name;
  if (n.kind === NodeKind.QualifiedId) {
    const tail = n.name as { name?: unknown } | undefined;
    if (tail && typeof tail.name === 'string') return tail.name;
  }
  return undefined;
}

const setCache = new WeakMap<readonly string[], Set<string>>();
export function cachedSet(names: readonly string[] | undefined): Set<string> {
  if (!names) return new Set();
  let s = setCache.get(names);
  if (!s) { s = new Set(names); setCache.set(names, s); }
  return s;
}

export function isOpaqueCallbackBase(
  base: string, structFields: Record<string, Record<string, string>>,
): boolean {
  return !SCALAR_BASES.has(base) && !structFields[base];
}

/**
 * A cast to an AGGREGATE BY VALUE. No conversion exists from a pointer or a
 * machine word to a struct, so writing one produces "invalid cast from type X
 * to type Y" - a diagnostic the pass manufactured on top of whatever
 * disagreement was already there. Where the target is a known aggregate and
 * nothing indirects it, the store stays exactly as the decompiler wrote it and
 * the real disagreement stays visible.
 */
export function isAggregateValue(
  shape: TypeShape, structFields: Record<string, Record<string, string>>,
): boolean {
  return shape.stars === 0 && !!structFields[shape.base];
}

/**
 * Windows typedefs that carry the `const` inside the name. `LPCVOID` reaching a
 * `void*` parameter, or `LPCSTR` reaching `char*`, is the one conversion C did
 * silently that C++ refuses outright - so const has to survive the reduction.
 */
const CONST_POINTER_TYPEDEFS = new Set([
  'LPCVOID', 'LPCSTR', 'LPCWSTR', 'LPCTSTR', 'PCSTR', 'PCWSTR', 'PCTSTR', 'LPCCH', 'LPCBYTE',
]);

/**
 * Resolves a typedef NAME to the spelling it stands for, or undefined when the
 * name is not a typedef. Windows and Ghidra alike hide indirection inside a
 * name - `LPCANDIDATELIST` IS a pointer and `HACCEL` IS a pointer, with no star
 * in the spelling - so without this a pointer store into one of those slots
 * looks like an integer store and no cast is written.
 */
export type TypedefResolver = (name: string) => string | undefined;

/**
 * The base a parsed `BuiltinType` really names.
 *
 * The parser splits a multi-word builtin into a head plus modifiers - `short`
 * arrives as `{ name: 'int', modifiers: ['short'] }`, `unsigned char` as
 * `{ name: 'char', modifiers: ['unsigned'] }`. Reading `name` alone therefore
 * answers `int` for a `short *` and `char` for a `byte *`, which is both a
 * false equality (a `char *` and an `unsigned char *` reduce alike, so no cast
 * is written where C++ needs one) and a false spelling (a cast written from
 * that shape names `int *` over a 16-bit walk). The string path
 * (`shapeOfSpelling`) never had the problem, so the two reducers disagreed on
 * every modified builtin in the program.
 */
export function builtinBase(name: string, modifiers?: readonly string[]): string {
  const mods = (modifiers ?? []).filter(m => m !== 'const' && m !== 'volatile');
  const core = canonicalBase(name);
  if (mods.length === 0) return core;
  const isUnsigned = mods.includes('unsigned');
  const isSigned = mods.includes('signed');
  const isShort = mods.includes('short');
  const longs = mods.filter(m => m === 'long').length;
  if (core === 'char') {
    return isUnsigned ? 'unsigned char' : isSigned ? 'signed char' : 'char';
  }
  if (core === 'double') return longs > 0 ? 'long double' : 'double';
  if (core === 'int') {
    const width = isShort ? 'short' : longs >= 2 ? 'long long' : longs === 1 ? 'long' : 'int';
    if (!isUnsigned) return width;
    return width === 'int' ? 'unsigned int' : `unsigned ${width}`;
  }
  // A head the modifiers do not describe - `unsigned __int64`, `long float`.
  // Keeping the words produces a base no rule matches, which declines rather
  // than guesses, and that is the direction this pass errs in everywhere else.
  return canonicalBase(`${mods.join(' ')} ${core}`);
}

export function canonicalBase(name: string): string {
  const stripped = name
    .replace(/\b(const|volatile)\b/g, ' ')
    .replace(/^\s*(struct|class|union|enum)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return TYPE_ALIASES[stripped] ?? stripped;
}

/**
 * Follow a typedef chain to the type it really names, accumulating indirection
 * and const on the way. Depth-capped and self-reference-proof: Ghidra records
 * several typedefs as their own underlying type (`FARPROC -> FARPROC *`), and
 * following one of those forever is not a hypothetical.
 */
function resolveThroughTypedefs(
  shape: TypeShape, resolve: TypedefResolver | undefined, depth: number,
): TypeShape {
  if (!resolve || depth > 8) return shape;
  const under = resolve(shape.base);
  if (!under) return shape;
  const inner = shapeOfSpelling(under, resolve, depth + 1);
  if (!inner || inner.base === shape.base) return shape;
  return {
    base: inner.base,
    stars: inner.stars + shape.stars,
    isConst: shape.isConst || inner.isConst,
  };
}

/** Parse a declaration spelling ("uint8_t **", "D2UnitStrc *") into a shape. */
export function shapeOfSpelling(
  spelling: string, resolve?: TypedefResolver, depth = 0,
): TypeShape | null {
  let s = spelling.trim();
  if (!s) return null;
  // A declared array yields a pointer to its element wherever a VALUE is asked
  // for, which is the only thing this function is asked for. `shapeOfNode`
  // already decays one; refusing the string form left the two reducers
  // answering differently about the same struct field depending on which side
  // it was reached from, so an array-typed field or global was simply invisible
  // to every pass. Exactly ONE dimension is decayed: `T[a][b]` yields
  // `T(*)[b]`, which this model cannot spell, so it still declines. Nothing
  // builds a cast NODE from a spelling with a bracket - `typeFromSpelling`
  // keeps rejecting one - so this widens what can be reasoned about without
  // widening what can be written.
  const array = /^(.*?)\s*\[[^\[\]]*\]$/.exec(s);
  let arrayStars = 0;
  if (array) { s = array[1].trim(); arrayStars = 1; }
  // Function pointers, templates, references and further dimensions are out of scope.
  if (/[()<>&\[\]]/.test(s)) return null;
  let stars = arrayStars;
  while (s.endsWith('*')) { stars++; s = s.slice(0, -1).trim(); }
  if (s.includes('*')) return null; // pointer-to-const and the like, mid-spelling
  const base = canonicalBase(s);
  if (!base || /\s/.test(base) && !base.startsWith('unsigned') && !base.startsWith('signed')
      && !base.startsWith('long') && !base.startsWith('short')) return null;
  const isConst = /\bconst\b/.test(s) || CONST_POINTER_TYPEDEFS.has(s.trim());
  return resolveThroughTypedefs({ base, stars, isConst }, resolve, depth);
}

/** The same reduction, for a type already parsed into the AST. */
export function shapeOfNode(t: TypeNode, stars = 0, resolve?: TypedefResolver): TypeShape | null {
  switch (t.kind) {
    case NodeKind.PointerType:
      return shapeOfNode((t as PointerType).pointee, stars + 1, resolve);
    case NodeKind.ArrayType:
      // An array argument decays to a pointer to its element.
      return shapeOfNode((t as ArrayType).elementType, stars + 1, resolve);
    case NodeKind.QualifiedType: {
      const q = t as QualifiedType;
      const inner = shapeOfNode(q.type, stars, resolve);
      if (!inner) return null;
      return q.qualifiers?.includes('const') ? { ...inner, isConst: true } : inner;
    }
    case NodeKind.BuiltinType: {
      const b = t as BuiltinType;
      return resolveThroughTypedefs(
        {
          base: builtinBase(b.name, b.modifiers),
          stars,
          isConst: (b.modifiers ?? []).includes('const'),
        }, resolve, 0);
    }
    case NodeKind.TypedefType: {
      const n = typeNodeName((t as TypedefType).name);
      if (n === undefined) return null;
      return resolveThroughTypedefs(
        { base: canonicalBase(n), stars, isConst: CONST_POINTER_TYPEDEFS.has(n) },
        resolve, 0);
    }
    case NodeKind.ElaboratedType: {
      const n = typeNodeName((t as ElaboratedType).name);
      return n !== undefined
        ? resolveThroughTypedefs({ base: canonicalBase(n), stars, isConst: false }, resolve, 0)
        : null;
    }
    default:
      return null;
  }
}

/**
 * A bare string literal, written where the value is used.
 *
 * C++ has kept ONE exception to const-correctness for it: a string literal
 * still converts to `char *` (deprecated, and only a warning), which is why the
 * decompiled `f("...")` against a `char *` parameter compiles untouched and
 * needs no cast. The exception is for the literal ITSELF - once it has passed
 * through a conditional or any other operator the value is a plain
 * `const char *` and reaching a `char *` is a hard error. Distinguishing the
 * two is the difference between casting a handful of real conversions and
 * casting every string in the program.
 */
export function isBareStringLiteral(e: Expression): boolean {
  return unwrapParens(e).kind === NodeKind.StringLiteral;
}

export const sameShape = (a: TypeShape, b: TypeShape) => a.stars === b.stars && a.base === b.base;
export const isVoid = (s: TypeShape) => s.base === 'void';

/**
 * Ghidra's own `code` builtin - the type of a byte the disassembler knows is
 * executable and nothing more. The emitter spells it `typedef int code(...)`, so
 * `code *` is a function pointer that carries NO prototype: a slot Ghidra never
 * managed to type, not a slot whose type it disagrees about.
 *
 * That distinction is what makes it different from a funcdef typedef. Two
 * prototypes can be compared and the pass that compares them owns the store;
 * `code *` has nothing on one side to compare, so no prototype-comparing pass
 * can ever reach it, and the conversion C++ refuses is left to the sites that
 * spell it - which is exactly where the original source carried its cast.
 */
export const isGhidraCode = (s: TypeShape) => canonicalBase(s.base).replace(/^::/, '') === 'code';

/**
 * The base a CODE ADDRESS reduces to.
 *
 * A funcdef typedef names a whole prototype, which `shapeOfSpelling` refuses to
 * parse - so the chain stops on the typedef's own name and the shape reads as a
 * star-less opaque base. That is the wrong answer twice over: the slot holds one
 * indirection, and the thing it points at is not an object. Both errors cancel
 * for a funcdef-to-funcdef store (two opaque bases, no cast, which is
 * `funcptr-arg-cast`'s business anyway) and both show up the moment a code
 * address meets a data pointer:
 *
 *   - a function pointer read as star-less looked like a scalar that was not
 *     word-wide, so `pSymGetModuleBase64` reaching a `void *` parameter was
 *     declined as a truncating store;
 *   - and had it read as a pointer it would have been waved through by the
 *     "every object pointer reaches `void*`" rule, which a code address does
 *     not obey in either C++ or, formally, C.
 *
 * So a funcdef reduces to one indirection over a base of its own, distinct from
 * every object base. `void*` and a machine word then meet it across a real
 * boundary and the cast the original source carried is written back, while two
 * code addresses still reduce alike and stay with the pass that compares
 * prototypes.
 */
export const CODE_BASE = '#code';
export const isCodeAddress = (s: TypeShape) => s.base === CODE_BASE;

/**
 * The shape of a slot spelled with a funcdef typedef, as a code address.
 * Anything else is returned unchanged.
 *
 * Star-less AND one-star both mean the same slot, for the same reason
 * `createFuncdefCalleeResolver` peels both: the typedef IS the pointer type in
 * the emitted header (`pfnStackWalk64 pStackWalk64`), while Ghidra's own type
 * table spells the very same global `pfnStackWalk64 *` because it models the
 * funcdef as the FUNCTION and the variable as a pointer to it. Two stars is a
 * real pointer TO that slot and keeps its own shape.
 */
export function asCodeAddress(
  shape: TypeShape | null, funcdefNames: ReadonlySet<string>,
): TypeShape | null {
  if (!shape || shape.stars > 1) return shape;
  // A root-qualified `::fpDraw` names the very same funcdef as `fpDraw`, and the
  // two spellings reach this from different sides: a PARAMETER's spelling comes
  // from the table, which root-qualifies a typedef a same-named function hides,
  // while an ARGUMENT's comes from the parsed AST, where the qualifier is a
  // separate node and only the leaf survives the reduction. Reducing one and not
  // the other made the two sides disagree about a value that had not changed,
  // and the pass wrote a second, identical cast over the first.
  const bare = canonicalBase(shape.base).replace(/^::/, '');
  if (!funcdefNames.has(bare)) return shape;
  return { base: CODE_BASE, stars: 1, isConst: shape.isConst };
}

export function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** The spelled name of a call's callee, or undefined for a computed callee. */
export function calleeName(expr: Expression): string | undefined {
  const e = unwrapParens(expr);
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name;
  if (e.kind === NodeKind.QualifiedId) {
    const q = e as QualifiedId;
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

/** Turn a declaration spelling back into a type node the cast can be written with. */
/**
 * Look a callee name up in a table keyed by both bare and qualified spellings,
 * resolving an unqualified name the way C++ does: through the enclosing scopes,
 * innermost first.
 *
 * A bare name two functions disagree over is dropped from every such table, so
 * the walk is the ONLY thing that finds `Draw` from inside `D2Win::Src::…` — and
 * a name that arrives qualified is walked only DEEPER than its own qualifier,
 * because a qualifier that is not a prefix of where we sit names something else.
 */
export function scopedLookup<T>(
  table: Record<string, T>,
  name: string,
  enclosingSegments: readonly string[],
): T | undefined {
  const direct = table[name];
  if (direct !== undefined) return direct;
  const bare = bareName(name);
  const cut = name.lastIndexOf('::');
  const qualifier = cut === -1 ? '' : name.slice(0, cut);
  const qualifierDepth = qualifier === '' ? 0 : qualifier.split('::').length;
  const enclosingPath = enclosingSegments.join('::');
  const walkable = qualifier === ''
    || enclosingPath === qualifier
    || enclosingPath.startsWith(`${qualifier}::`);
  if (walkable) {
    for (let i = enclosingSegments.length; i > qualifierDepth; i--) {
      const found = table[`${enclosingSegments.slice(0, i).join('::')}::${bare}`];
      if (found !== undefined) return found;
    }
  }
  return table[bare];
}

/**
 * `ret (*)(a, b)` — the exact type of ONE function, built from the spellings the
 * header declares it with.
 *
 * This is what selects a single member of an overload set. `(::Draw)Draw` is
 * ill-formed the moment two `Draw`s share a scope: a cast resolves an overload
 * set only against an EXACT function type, and the funcdef the slot is declared
 * with is by construction not any overload's own type — that disagreement is
 * the whole reason the cast is there. Naming the function's own type first
 * picks the overload; the outer cast then reinterprets it, exactly as before.
 *
 * Returns null when any part of the signature is not spellable as a plain type,
 * because a cast that does not match the declaration EXACTLY selects nothing and
 * turns one error into another.
 */
export function functionPointerTypeFromSpellings(
  returnSpelling: string | undefined,
  paramSpellings: readonly string[] | undefined,
  callingConvention?: string,
): TypeNode | null {
  if (returnSpelling === undefined || paramSpellings === undefined) return null;
  const ret = typeFromSpelling(returnSpelling);
  if (!ret) return null;
  const params: TypeNode[] = [];
  for (const p of paramSpellings) {
    const node = typeFromSpelling(p);
    if (!node) return null;
    params.push(node);
  }
  return Type.pointer(Type.function(ret, params, false, callingConvention));
}

export function typeFromSpelling(spelling: string): TypeNode | null {
  let s = spelling.trim();
  if (!s || /[()<>&\[\]]/.test(s)) return null;
  let stars = 0;
  while (s.endsWith('*')) { stars++; s = s.slice(0, -1).trim(); }
  if (!s || s.includes('*')) return null;
  let node: TypeNode = Type.typedef(s);
  for (let i = 0; i < stars; i++) node = Type.pointer(node);
  return node;
}

export function createCallArgCastTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as CallArgCastOptions;
  const paramTypes = o.functionParamTypes;
  const pointerOnlyParamTypes = o.pointerOnlyParamTypes ?? {};
  const returnTypes = o.functionReturnTypes ?? {};
  const globalTypes = o.globalTypes ?? {};
  const varArgs = cachedSet(o.varArgFunctions);
  const funcdefNames = cachedSet(o.funcdefNames);
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
  if (!paramTypes || Object.keys(paramTypes).length === 0) {
    return createTransformer({});
  }

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;

      // name → declared type, from this function's params and body-declared locals.
      const localTypes = new Map<string, TypeNode>();
      for (const p of node.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) localTypes.set(pd.name.name, pd.type);
      }
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
      }

      // The shape resolver is shared with the other passes that need to know
      // what an expression's type is; see `expr-shape.ts`. The funcdef hook ties
      // the mutual recursion: resolving a call THROUGH a pointer needs the
      // resolver, and the resolver needs the funcdef's return type.
      let funcdefReturn: ((callee: Expression) => string | undefined) | undefined;
      const argShape = createExprShape(
        localTypes,
        { globalTypes, enclosingVarTypes, structFields, fieldTypes, returnTypes, resolve },
        (callee) => funcdefReturn?.(callee),
      );

      /** The funcdef a call through a function pointer is made under. */
      const funcdefOfCallee = createFuncdefCalleeResolver(funcdefTables, argShape);
      funcdefReturn = (callee) => funcdefOfCallee(callee)?.returnType;

      /**
       * True when the expression names a FUNCTION rather than a value: a bare
       * `f` or `&f` whose name the model knows as a callable and which nothing
       * nearer declares as data. A function designator has no `TypeShape` - it
       * is not an object - so `argShape` returns null for it and no cast is
       * written, which is why a callback handed to a `FARPROC`, a `void*` or an
       * `undefined4` parameter arrives uncast.
       */
      const functionDesignator = (expr: Expression): boolean => {
        let e = unwrapParens(expr);
        if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '&') {
          e = unwrapParens((e as UnaryExpr).operand);
        }
        if (e.kind !== NodeKind.Identifier && e.kind !== NodeKind.QualifiedId) return false;
        const name = calleeName(e);
        if (!name) return false;
        const bare = bareName(name);
        // A name that denotes data here is not a function, whatever else shares it.
        if (localTypes.has(name) || enclosingVarTypes[name] !== undefined) return false;
        if (localTypes.has(bare) || enclosingVarTypes[bare] !== undefined) return false;
        if (globalTypes[name] !== undefined || globalTypes[bare] !== undefined) return false;
        // A bare name a data symbol also claims is not proof of a function.
        if (dataNames.has(bare)) return false;
        return functionNames.has(name) || functionNames.has(bare);
      };

      /**
       * The declared parameter spellings this call fills, or undefined when the
       * model does not know them. Two routes, in order of certainty: the callee
       * NAMES a function the model has a signature for, or - for a call made
       * through a function pointer, which has no callee name at all - the slot
       * the pointer lives in is declared with a funcdef, and that funcdef is the
       * contract the call is made under.
       *
       * A `...` tail does not blank this out. It only bounds how much of the
       * call it can speak for: the NAMED parameters are still a declaration
       * exactly as fixed as any other, and get cast exactly as any other -
       * `variadic` tells the caller where that declared prefix ends, past which
       * default argument promotion applies and there is nothing to cast.
       */
      const declaredParametersOf = (call: CallExpr): Declared | undefined => {
        const name = calleeName(call.callee);
        if (name !== undefined) {
          const bare = bareName(name);
          const declared = paramTypes[name] ?? paramTypes[bare];
          if (declared) {
            const variadic = varArgs.has(name) || varArgs.has(bare);
            return { spellings: declared, pointerOnly: false, variadic };
          }
          const annotated = pointerOnlyParamTypes[name] ?? pointerOnlyParamTypes[bare];
          if (annotated) return { spellings: annotated, pointerOnly: true, variadic: false };
        }
        const fd = funcdefOfCallee(call.callee);
        return fd
          ? { spellings: fd.paramTypes, pointerOnly: false, variadic: !!fd.varArgs }
          : undefined;
      };

      let changed = false;
      const inner = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.CallExpr) return undefined;
          const call = n as CallExpr;
          const decl = declaredParametersOf(call);
          if (!decl) return undefined;
          const declared = decl.spellings;
          // A variadic callee only fixes the named prefix, so the call may
          // legitimately carry more arguments than `declared` has entries -
          // those extra slots have no declared type and are left alone below,
          // the same way an unmodelled expression already is. Fewer arguments
          // than the named prefix is still Ghidra's arity to fix, not ours.
          if (decl.variadic ? call.arguments.length < declared.length
                             : call.arguments.length !== declared.length) return undefined;

          let anyCast = false;
          const newArgs = call.arguments.map((arg, i) => {
            const spelling = declared[i];
            if (!spelling) return arg;
            const bareParam = spelling.replace(/[*\s]/g, '');
            if (funcdefNames.has(bareParam)) {
              // `funcptr-arg-cast` owns this slot because it can compare the two
              // PROTOTYPES. A `void*` has none to compare: it is an untyped
              // address the callee is about to call through, and C++ converts it
              // to a code pointer in neither direction, so the cast belongs here.
              if (functionDesignator(arg as Expression)) return arg;
              const voidArg = argShape(arg as Expression);
              if (!voidArg || voidArg.stars !== 1 || !isVoid(voidArg)) return arg;
              const castType = typeFromSpelling(spelling);
              if (!castType) return arg;
              anyCast = true;
              return Expr.cast(castType, arg as Expression);
            }
            const want = asCodeAddress(shapeOfSpelling(spelling, resolve), funcdefNames);
            // A signature recovered from the decompiler's annotations types only
            // the pointer boundary. Both sides must reduce to a pointer: an
            // integer reaching a pointer slot stays exactly as the decompiler
            // wrote it, and so does a function address, whose prototype this
            // table does not carry.
            if (decl.pointerOnly) {
              // A function address is not an integer and is never packed string
              // data, so it may reach a slot that holds an address - a pointer,
              // or an opaque Win32 callback typedef such as `FARPROC` that hides
              // one. Into a machine-word INTEGER it stays uncast, which is the
              // same boundary the pointer rule draws for every other argument.
              if (functionDesignator(arg as Expression)) {
                if (!want) return arg;
                if (want.stars === 0 && !isOpaqueCallbackBase(want.base, structFields)) return arg;
              } else {
                if (!want || want.stars === 0) return arg;
                const shape = argShape(arg as Expression);
                if (!shape || shape.stars === 0) return arg;
              }
            }
            // A function address reaching a slot that is not a function pointer of
            // the same prototype: C converted it silently and C++ converts it not
            // at all, in EITHER direction, so the original source carried a cast
            // here. `funcptr-arg-cast` owns the funcdef-typedef slots (it compares
            // whole prototypes and refuses an arity disagreement); what is left is
            // an object pointer, a machine word, or an opaque Win32 callback
            // typedef, and none of those has a prototype to freeze.
            if (functionDesignator(arg as Expression)) {
              const castType = typeFromSpelling(spelling);
              if (!castType) return arg;
              // `want` is null for a spelling this pass will not reduce - an
              // opaque typedef that hides a whole prototype. It is still a single
              // name, so the cast is spellable and is the only form that compiles.
              if (!want) { anyCast = true; return Expr.cast(castType, arg as Expression); }
              if (want.stars > 0) { anyCast = true; return Expr.cast(castType, arg as Expression); }
              // A star-less base that is neither arithmetic nor an aggregate this
              // model knows is an opaque callback typedef (`FARPROC`). It hides a
              // whole prototype, so there is nothing to compare and nothing to
              // freeze - the cast is the only spelling that ever compiled.
              if (isOpaqueCallbackBase(want.base, structFields)) {
                anyCast = true;
                return Expr.cast(castType, arg as Expression);
              }
              // Into a word-wide integer the address goes through `uintptr_t`, so
              // the reinterpret is width-exact. A narrower slot would TRUNCATE the
              // address, which the machine never did - leave it visible.
              if (!isWordIntegerShape(want)) return arg;
              anyCast = true;
              return Expr.cast(castType, Expr.cast(Type.typedef('uintptr_t'), arg as Expression));
            }
            if (!want) return arg;
            if (isAggregateValue(want, structFields)) return arg;
            const have = asCodeAddress(argShape(arg as Expression), funcdefNames);
            if (!have) return arg;
            // Any NON-const OBJECT pointer still reaches `void*` implicitly;
            // a const one has never reached a non-const slot in either language,
            // and a code address reaches it in no language at all.
            if (have.stars > 0 && !isCodeAddress(have) && want.stars === 1 && isVoid(want)
                && !want.isConst && !have.isConst) return arg;
            const losesConst = have.isConst && !want.isConst
              && !(sameShape(have, want) && isBareStringLiteral(arg as Expression));
            if (sameShape(have, want) && !losesConst) return arg;
            // Only a pointer boundary needs the cast; integer widths convert.
            if (want.stars === 0 && have.stars === 0 && !losesConst) return arg;
            const castType = typeFromSpelling(spelling);
            if (!castType) return arg;
            anyCast = true;
            return Expr.cast(castType, arg as Expression);
          });
          if (!anyCast) return undefined;
          changed = true;
          return updateNode(call, { arguments: newArgs } as Partial<CallExpr>);
        },
      });

      const newBody = inner(node.body);
      if (!changed) return undefined;
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const callArgCastPlugin: TransformPlugin = {
  id: 'call-arg-cast',
  name: 'Call Argument Cast Insertion',
  description:
    'Casts a call argument to its declared parameter type where C converted implicitly and C++ will not',
  version: '1.0.0',
  defaultEnabled: true,
  // After pointer-assign-cast (600), so the argument's final form is what is read.
  priority: 610,
  tags: ['cleanup', 'type'],
  createTransformer: createCallArgCastTransformer,
};
