/**
 * Funcptr-Arg-Cast Plugin
 *
 * A parameter declared with a function-pointer typedef takes the ADDRESS of a
 * function whose own prototype is different:
 *
 *   typedef void (*CONTAINER_TypeInitialValue)(void *pBuffer);
 *   CONTAINER_InitializeBuffer(0, 2, 100, STRING_ZeroOneWCHAR);  // void(uint16_t*)
 *
 * Both sides are right. `CONTAINER_InitializeBuffer` walks its buffer by
 * `nTypeSize` and is authentically generic, so `void*` is the truthful parameter
 * type; the callers genuinely disagree with each other about what they store
 * there (215 pass a `uint16_t*` initializer, one passes a `void*` one). Function
 * pointer types are INVARIANT in C++, so no spelling of either side makes the
 * assignment implicit — the original MSVC source must have written the cast, and
 * emitting it reconstructs that rather than papering over an unknown type.
 *
 * The cast is emitted ONLY where the model says the two prototypes differ: the
 * parameter's type must be a known function-pointer typedef, the argument must
 * name a known function, and their normalized signatures must not match. An
 * argument whose ARITY or calling convention differs is left alone and counted —
 * that is a different problem and wants a look, not a cast.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  AssignExpr,
  CallExpr,
  ConditionalExpr,
  Expression,
  Identifier,
  MemberExpr,
  QualifiedId,
  UnaryExpr,
} from '../../../ast/nodes.js';
import { Expr, Type } from '../../../ast/factory.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { functionPointerTypeFromSpellings, scopedLookup } from './call-arg-cast.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface FuncPtrArgCastOptions extends PluginOptions {
  /**
   * For each callable name (spelled bare AND fully qualified), the parameter
   * positions whose declared type is a function-pointer typedef, mapped to that
   * typedef's name.
   */
  paramFuncdefs?: Record<string, Record<number, string>>;
  /** Function-pointer typedef name → its normalized signature key. */
  funcdefSignatures?: Record<string, string>;
  /** Function name (bare AND qualified) → its own normalized signature key. */
  functionSignatures?: Record<string, string>;
  /**
   * Names that denote DATA, not a function. A data symbol may share a bare name
   * with a function (`fpInsertPlayCd` is a file-local flag in one module and a
   * callback elsewhere); the argument then denotes the variable, and casting it
   * to a funcdef is both wrong and — since the typedef need not be visible in
   * that translation unit — a syntax error.
   */
  variableNames?: string[];
  /**
   * Typedefs a function of the same name hides. The typedef is emitted at root
   * scope, so the cast has to be spelled `(::T)` to reach it — unqualified, the
   * function wins and the cast parses as a call.
   */
  rootQualifiedTypedefs?: string[];
  /**
   * Struct/union FIELD names whose declared type is `void*` in every type that
   * declares them. `sgptDataTables.charstats[i].fpLinker = DATATBLS_LookupStringId`
   * stores a function address in a slot that genuinely holds either a function or
   * a data address, so `void*` is the truthful field type and the original source
   * had to write `(void*)`. A field name that is `void*` in one struct and
   * something else in another is ambiguous from a member access alone and is
   * excluded.
   */
  voidPointerFields?: string[];
  /**
   * Struct/union FIELD name → the funcdef its declared type names, where every
   * aggregate declaring that name agrees. `pList->sControl.fpDraw = Draw;`
   * stores a `BOOL(D2WinList*)` into a slot the funcdef declares as
   * `BOOL(D2ControlStrc*)`. Both sides are right: `sControl` is the first member
   * of every form struct, so the derived callback genuinely receives the same
   * address — retyping either side would assert something false. Function
   * pointer types are invariant in C++, so the original source carried the cast
   * and writing it back is transcription, exactly as for the argument case.
   */
  fieldFuncdefs?: Record<string, string>;
  /**
   * Callable name → slot → the callback typedef the slot's own declaration
   * names, for callees whose declaration comes from a SYSTEM header rather than
   * from the model — `CreateThread`'s third parameter is
   * `LPTHREAD_START_ROUTINE`, and no reconstructed prototype says so.
   *
   * These slots are cast into ONLY when the supplied function takes no
   * parameters at all. A zero-parameter function passed as a callback that
   * receives one is not a disagreement any retype can settle: the function
   * really is `f(void)`, the slot really does hand it a parameter, and the
   * original source had to write the cast. Every other mismatch in the same
   * slot — a wrong return width, a wrong calling convention — IS settleable,
   * stays uncast, and stays loud.
   */
  zeroArityCallbackSlots?: Record<string, Record<number, string>>;
  /**
   * The namespace segments enclosing the body being transformed, outermost
   * first. A body writes `fpDraw = Draw;` with the bare name, and twelve
   * `Draw`s exist across `D2Client::Forms::*` — so the bare name is ambiguous
   * and the signature tables drop it. C++ resolves it by enclosing scope, from
   * the innermost outwards, and so does this.
   */
  enclosingSegments?: string[];
  /**
   * Bare names more than one emitted function carries. Casting such a name is
   * ill-formed on its own ("overloaded function with no contextual type
   * information"): a cast selects from an overload set only on an EXACT match,
   * and the slot's funcdef never matches — that disagreement is why the cast is
   * being written. The function's own type is spelled first so the set reduces
   * to one member.
   */
  overloadedFunctionNames?: string[];
  /** Callable name (bare AND qualified) → its emitted parameter type spellings */
  functionParamTypes?: Record<string, string[]>;
  /** Callable name (bare AND qualified) → its emitted return type spelling */
  functionReturnTypes?: Record<string, string>;
}

/** Slot marker for a parameter/field declared plain `void*` rather than a funcdef. */
export const VOID_POINTER_SLOT = 'void*';

/** How many arity mismatches were skipped — a cast cannot fix those. */
let arityMismatches = 0;

/**
 * Typedef names this plugin has spelled into a cast since the last drain. The
 * emitting file must declare them — the callee's header is not necessarily
 * included there — and only THESE names may be declared: a body identifier that
 * merely shares a name with a FUNCTION_DEFINITION (a local called `length`) must
 * not turn into a typedef.
 */
const usedTypedefs = new Set<string>();

/** The typedef names spelled since the last call, clearing the accumulator. */
export function takeFuncPtrArgCastTypedefs(): string[] {
  const names = [...usedTypedefs];
  usedTypedefs.clear();
  return names;
}

export function getFuncPtrArgCastArityMismatches(): number {
  return arityMismatches;
}

export function resetFuncPtrArgCastStats(): void {
  arityMismatches = 0;
}

/** The spelled name of an Identifier / QualifiedId, or undefined for anything else. */
function nameOf(expr: ASTNode | undefined): string | undefined {
  if (!expr) return undefined;
  if (expr.kind === NodeKind.Identifier) return (expr as Identifier).name;
  if (expr.kind === NodeKind.QualifiedId) {
    const q = expr as QualifiedId;
    if (q.name.kind !== NodeKind.Identifier) return undefined;
    const parts: string[] = [];
    for (const p of q.qualifier) {
      if (p.kind !== NodeKind.Identifier) return undefined;
      parts.push((p as Identifier).name);
    }
    parts.push((q.name as Identifier).name);
    return parts.join('::');
  }
  return undefined;
}

/** The bare last segment of a possibly qualified name. */
function bareOf(name: string): string {
  const cut = name.lastIndexOf('::');
  return cut === -1 ? name : name.slice(cut + 2);
}

/** The function an address-taking argument denotes: `f` or `&f`. */
function functionArgName(arg: Expression): string | undefined {
  if (arg.kind === NodeKind.UnaryExpr) {
    const u = arg as UnaryExpr;
    return u.operator === '&' ? nameOf(u.operand) : undefined;
  }
  return nameOf(arg);
}

/** The arity encoded in a signature key `ret(a,b,c)`; -1 when unparseable. */
function arityOf(sig: string): number {
  const open = sig.indexOf('(');
  if (open === -1 || !sig.endsWith(')')) return -1;
  const inner = sig.slice(open + 1, -1).trim();
  if (inner === '' || inner === 'void') return 0;
  return inner.split(',').length;
}

const transformerCache = new WeakMap<object, Transformer>();

function createFuncPtrArgCastTransformer(options: FuncPtrArgCastOptions = {}): Transformer {
  const cached = transformerCache.get(options);
  if (cached) return cached;
  const built = buildTransformer(options);
  transformerCache.set(options, built);
  return built;
}

function buildTransformer(options: FuncPtrArgCastOptions): Transformer {
  const paramFuncdefs = options.paramFuncdefs;
  const funcdefSignatures = options.funcdefSignatures;
  const functionSignatures = options.functionSignatures;
  if (!paramFuncdefs || !funcdefSignatures || !functionSignatures) {
    return (node: ASTNode) => node;
  }
  const variableNames = new Set(options.variableNames ?? []);
  const rootQualified = new Set(options.rootQualifiedTypedefs ?? []);
  const voidPointerFields = new Set(options.voidPointerFields ?? []);
  const fieldFuncdefs = options.fieldFuncdefs ?? {};

  const enclosingSegments = options.enclosingSegments ?? [];
  const overloaded = new Set(options.overloadedFunctionNames ?? []);
  const functionParamTypes = options.functionParamTypes ?? {};
  const functionReturnTypes = options.functionReturnTypes ?? {};

  /**
   * The value to cast, with the overload set reduced to one member first where
   * the name denotes more than one function. When the exact type is not
   * spellable the value is left alone — an inexact cast selects nothing.
   */
  const selectOverload = (value: Expression): Expression => {
    const fnName = functionArgName(value);
    if (!fnName || !overloaded.has(bareOf(fnName))) return value;
    const exact = functionPointerTypeFromSpellings(
      scopedLookup(functionReturnTypes, fnName, enclosingSegments),
      scopedLookup(functionParamTypes, fnName, enclosingSegments),
    );
    return exact ? (Expr.cast(exact, value) as Expression) : value;
  };

  const castTo = (typedefName: string, value: Expression): Expression => {
    usedTypedefs.add(typedefName);
    const castType = rootQualified.has(typedefName)
      ? Type.typedefAt(typedefName, true)
      : Type.typedef(typedefName);
    return Expr.cast(castType, selectOverload(value)) as Expression;
  };

  const slotsFor = (callee: string): Record<number, string> | undefined =>
    paramFuncdefs[callee] ?? paramFuncdefs[bareOf(callee)];

  const zeroAritySlots = options.zeroArityCallbackSlots ?? {};
  const zeroAritySlotsFor = (callee: string): Record<number, string> | undefined =>
    zeroAritySlots[callee] ?? zeroAritySlots[bareOf(callee)];

  const signatureFor = (fn: string): string | undefined => {
    // A name that also denotes data is not proof of a function.
    if (variableNames.has(bareOf(fn))) return undefined;
    return scopedLookup(functionSignatures, fn, enclosingSegments);
  };

  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      // `pTable[i].fpLinker = DATATBLS_LookupStringId;` — a function address
      // stored into a `void*` field. Same invariance rule as the argument case.
      if (n.kind === NodeKind.AssignExpr) {
        const assign = n as AssignExpr;
        if (assign.operator !== '=') return undefined;
        if (assign.left.kind !== NodeKind.MemberExpr) return undefined;
        const member = (assign.left as MemberExpr).member;
        if (member.kind !== NodeKind.Identifier) return undefined;
        const fieldName = (member as Identifier).name;

        if (voidPointerFields.has(fieldName)) {
          const fnName = functionArgName(assign.right);
          if (!fnName || signatureFor(fnName) === undefined) return undefined;
          return updateNode(assign, {
            right: Expr.cast(Type.pointer(Type.void()), assign.right) as Expression,
          } as Partial<AssignExpr>);
        }

        // `pList->sControl.fpDraw = Draw;` — a funcdef-typed slot taking a
        // function whose own prototype differs. Same invariance rule as the
        // argument case, and the same refusal to cast across an arity change.
        const typedefName = fieldFuncdefs[fieldName];
        if (!typedefName) return undefined;
        const target = funcdefSignatures[typedefName];
        if (target === undefined) return undefined;

        // `fpKey = nParam & 1 ? Key : nullptr;` — the branchless-select undo
        // leaves the function in a ternary ARM, where it is still a designator
        // whose type has to be spelled. Each arm stores into the same slot, so
        // each is decided on its own; a null arm needs nothing.
        if (assign.right.kind === NodeKind.ConditionalExpr) {
          const cond = assign.right as ConditionalExpr;
          const armCast = (arm: Expression): Expression => {
            const armFn = functionArgName(arm);
            if (!armFn) return arm;
            const armSig = signatureFor(armFn);
            if (armSig === undefined || armSig === target) return arm;
            if (arityOf(armSig) !== arityOf(target)) { arityMismatches++; return arm; }
            return castTo(typedefName, arm);
          };
          const thenExpr = armCast(cond.thenExpr);
          const elseExpr = armCast(cond.elseExpr);
          if (thenExpr === cond.thenExpr && elseExpr === cond.elseExpr) return undefined;
          return updateNode(assign, {
            right: updateNode(cond, { thenExpr, elseExpr } as Partial<ConditionalExpr>) as Expression,
          } as Partial<AssignExpr>);
        }

        const fnName = functionArgName(assign.right);
        if (!fnName) return undefined;
        const actual = signatureFor(fnName);
        if (actual === undefined || actual === target) return undefined;
        if (arityOf(actual) !== arityOf(target)) {
          arityMismatches++;
          return undefined;
        }
        return updateNode(assign, {
          right: castTo(typedefName, assign.right),
        } as Partial<AssignExpr>);
      }

      if (n.kind !== NodeKind.CallExpr) return undefined;
      const call = n as CallExpr;

      const callee = nameOf(call.callee);
      if (!callee) return undefined;

      // A system-header callback slot handed a function that takes nothing.
      const systemSlots = zeroAritySlotsFor(callee);
      if (systemSlots) {
        let systemChanged = false;
        const systemArgs = call.arguments.map((arg, i) => {
          const typedefName = systemSlots[i];
          if (!typedefName) return arg;
          const argFn = functionArgName(arg);
          if (!argFn) return arg;
          const actual = signatureFor(argFn);
          if (actual === undefined || arityOf(actual) !== 0) return arg;
          systemChanged = true;
          return castTo(typedefName, arg);
        });
        if (systemChanged) {
          return updateNode(call, { arguments: systemArgs } as Partial<CallExpr>);
        }
      }

      const slots = slotsFor(callee);
      if (!slots) return undefined;

      let changed = false;
      const args = call.arguments.map((arg, i) => {
        const typedefName = slots[i];
        if (!typedefName) return arg;

        // A plain `void*` parameter. A function pointer does not convert to
        // `void*` in C++ at all, so the disagreement is one of representation,
        // not of prototype — there is no signature to compare and the cast is
        // the only spelling that ever compiled.
        if (typedefName === VOID_POINTER_SLOT) {
          const fnName = functionArgName(arg);
          if (!fnName || signatureFor(fnName) === undefined) return arg;
          changed = true;
          return Expr.cast(Type.pointer(Type.void()), arg) as Expression;
        }

        const target = funcdefSignatures[typedefName];
        if (target === undefined) return arg;

        const argFn = functionArgName(arg);
        if (!argFn) return arg;
        const actual = signatureFor(argFn);
        if (actual === undefined || actual === target) return arg;

        // Arity (and by extension calling convention) is not something a cast
        // reconciles — the disagreement is real and wants reporting.
        if (arityOf(actual) !== arityOf(target)) {
          arityMismatches++;
          return arg;
        }

        changed = true;
        return castTo(typedefName, arg);
      });

      if (!changed) return undefined;
      return updateNode(call, { arguments: args } as Partial<CallExpr>);
    },
  });
}

import { createPlugin } from '../registry.js';

export const funcPtrArgCastPlugin: TransformPlugin = createPlugin(
  'funcptr-arg-cast',
  'Function Pointer Argument Cast',
  'Casts a function address passed to a function-pointer-typedef parameter whose prototype differs',
  (options?: PluginOptions) => createFuncPtrArgCastTransformer(options as FuncPtrArgCastOptions),
  {
    priority: 71,
    defaultEnabled: true,
    tags: ['type', 'cpp'],
    version: '1.0.0',
  }
);
