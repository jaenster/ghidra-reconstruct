/**
 * Unprototyped-Call-Cast Plugin
 *
 * `FARPROC` is `INT_PTR (WINAPI *)()` - an UNPROTOTYPED function pointer. C
 * reads that empty parameter list as "unspecified", so calling one with
 * arguments is legal and the call is made with FARPROC's own `__stdcall`
 * convention. C++ reads `()` as "no parameters" ([dcl.fct]), so the same call
 * is an error:
 *
 *     FARPROC pfnKeyhook = GetProcAddress(ghKeyhookDll, "InstallKeyboardHook");
 *     (*pfnKeyhook)(hWnd);            // too many arguments to function
 *
 * The slot's DECLARATION cannot be corrected, because the slot is honestly
 * unprototyped. `ApplicationMain` (00405c30) calls through the same variable
 * twice with two different arities - `InstallKeyboardHook(HWND)` pushes one
 * argument at 00405d92/00405d98, `UninstallKeyboardHook()` pushes none at
 * 00405eaa - and Ghidra models both as one EAX:4 symbol, so any single funcdef
 * would be wrong for one of them.
 *
 * The parameter list is therefore a property of the CALL, not of the slot,
 * which is what C said all along. Restore it there: cast the callee to the
 * typedef's own return type and calling convention, with the parameter types
 * the call site shows.
 *
 * `(...)` is not an alternative. GCC makes a variadic function `__cdecl` and
 * warns off `__stdcall`, so a `(...)` call to a `__stdcall` hook would compile
 * and then leave four bytes on the stack at every invocation - the exact
 * failure this pass exists to avoid.
 *
 * Held to what the call site can show:
 *   - a call with NO arguments is already valid C++ and is left alone;
 *   - the callee must be a plain name whose DECLARED type is one of the
 *     registered unprototyped typedefs - a properly prototyped function pointer
 *     already carries its own parameter list and is none of this pass's
 *     business;
 *   - EVERY argument's type must be determinable. One that is not leaves the
 *     call untouched, because a parameter list guessed from an unknown argument
 *     is precisely the stack corruption above.
 *
 * Argument types are read WITHOUT the typedef resolver, so the cast names each
 * parameter as the call site declares it (`HWND`) rather than as whatever the
 * typedef chain bottoms out in (`void *`). Both spell the same machine type;
 * only the first is readable, and only the first stays right if the typedef is
 * ever corrected.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  CallExpr,
  Expression,
  FunctionDecl,
  Identifier,
  ParameterDecl,
  TypeNode,
  TypedefType,
  UnaryExpr,
  VariableDecl,
} from '../../../ast/nodes.js';
import { Expr, Type } from '../../../ast/factory.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import {
  typeFromSpelling, typeNodeName, unwrapParens, type TypeShape,
} from './call-arg-cast.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

/** What an unprototyped function-pointer typedef declares apart from its parameters. */
export interface UnprototypedFuncPtr {
  /** The typedef's own return spelling. */
  returnType: string;
  /** The typedef's own calling convention, omitted when it declares none. */
  callingConvention?: string;
}

/**
 * The unprototyped function-pointer typedefs this tree can meet.
 *
 * FARPROC is `INT_PTR (FAR WINAPI *FARPROC)()` in <winnt.h>, and mingw's
 * `windows.h` wins over anything the emitted platform header declares, so the
 * cast has to agree with the SDK: pointer-wide return, `__stdcall`. The
 * disassembly agrees independently - `CALL EDI` at 00405d98 is followed by no
 * ESP fixup, so the callee pops.
 */
const DEFAULT_UNPROTOTYPED_FUNC_PTRS: Record<string, UnprototypedFuncPtr> = {
  FARPROC: { returnType: 'intptr_t', callingConvention: '__stdcall' },
};

export interface UnprototypedCallCastOptions extends PluginOptions {
  /** Typedef name → the return type and calling convention it declares. */
  unprototypedFuncPtrs?: Record<string, UnprototypedFuncPtr>;
  /** Global name → declared spelling. */
  globalTypes?: Record<string, string>;
  /** A name declared by the class/namespace body this function sits in. */
  enclosingVarTypes?: Record<string, string>;
  /** Aggregate → field → declared spelling. */
  structFields?: Record<string, Record<string, string>>;
  /** Field name → declared spelling, where every aggregate declaring it agrees. */
  fieldTypes?: Record<string, string>;
  /** Function name → return spelling. */
  returnTypes?: Record<string, string>;
}

/** The name a declaration spells, when it is a bare typedef name and nothing else. */
function typedefNameOfNode(t: TypeNode): string | undefined {
  if (t.kind !== NodeKind.TypedefType) return undefined;
  return typeNodeName((t as TypedefType).name);
}

/** The same, for a declaration recorded as a spelling rather than a parsed type. */
function typedefNameOfSpelling(spelling: string): string | undefined {
  const s = spelling.trim();
  return /^[A-Za-z_]\w*$/.test(s) ? s : undefined;
}

/**
 * The type node a shape names, spelled the way the shape reads.
 *
 * Routed through `typeFromSpelling` so exactly the spellings that pass can be
 * WRITTEN - a base carrying a bracket, a parenthesis or the `#code` marker for
 * an address the model never typed is refused here rather than emitted as a
 * parameter type nobody can parse.
 */
function typeNodeFromShape(shape: TypeShape): TypeNode | null {
  if (shape.base.includes('#')) return null;
  const spelling = `${shape.isConst ? 'const ' : ''}${shape.base}${'*'.repeat(shape.stars)}`;
  return typeFromSpelling(spelling);
}

/** `(*fp)(...)` and `fp(...)` reach the same slot; both name it directly. */
function calleeSlot(callee: Expression): Expression {
  const e = unwrapParens(callee);
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '*') {
    return unwrapParens((e as UnaryExpr).operand);
  }
  return e;
}

function castUnprototypedCalls(options: UnprototypedCallCastOptions): Transformer {
  const registry = options.unprototypedFuncPtrs ?? DEFAULT_UNPROTOTYPED_FUNC_PTRS;
  const globalTypes = options.globalTypes ?? {};
  const enclosingVarTypes = options.enclosingVarTypes ?? {};

  const registered = (name: string | undefined): UnprototypedFuncPtr | undefined =>
    name === undefined ? undefined : registry[name];

  const rewrite = (
    localTypes: ReadonlyMap<string, TypeNode>, shapeOf: ExprShape,
  ): Transformer => createTransformer({
    visitCallExpr(call: CallExpr): ASTNode | undefined {
      // A zero-argument call through an unprototyped pointer is already what
      // C++ means by `()`. Nothing to restore, and nothing to get wrong.
      if (call.arguments.length === 0) return undefined;

      const slot = calleeSlot(call.callee);
      if (slot.kind !== NodeKind.Identifier) return undefined;
      const name = (slot as Identifier).name;

      const local = localTypes.get(name);
      const declared = local
        ? registered(typedefNameOfNode(local))
        : registered(typedefNameOfSpelling(enclosingVarTypes[name] ?? globalTypes[name] ?? ''));
      if (!declared) return undefined;

      const parameters: TypeNode[] = [];
      for (const argument of call.arguments) {
        const shape = shapeOf(argument);
        if (!shape) return undefined;
        const node = typeNodeFromShape(shape);
        if (!node) return undefined;
        parameters.push(node);
      }

      const returnType = typeFromSpelling(declared.returnType);
      if (!returnType) return undefined;

      const signature = Type.pointer(
        Type.function(returnType, parameters, false, declared.callingConvention),
      );
      return updateNode(call, { callee: Expr.cast(signature, Expr.identifier(name)) });
    },
  });

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
      // No `resolve`: a parameter type is written as the call site declares it.
      const shapeOf = createExprShape(localTypes, {
        globalTypes,
        enclosingVarTypes,
        structFields: options.structFields ?? {},
        fieldTypes: options.fieldTypes ?? {},
        returnTypes: options.returnTypes ?? {},
      });
      const newBody = rewrite(localTypes, shapeOf)(fn.body);
      if (newBody === fn.body) return undefined;
      return updateNode(fn, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const unprototypedCallCastPlugin: TransformPlugin = {
  id: 'unprototyped-call-cast',
  name: 'Unprototyped Call Cast',
  description:
    'Restore the parameter list C left unspecified when a call goes through an '
    + 'unprototyped function-pointer typedef such as FARPROC',
  version: '1.0.0',
  defaultEnabled: true,
  // After the argument casts (call-arg-cast 610, assign-cast 615,
  // narrow-cast-through-uintptr 620), so the argument expressions this reads its
  // parameter types from are final.
  priority: 622,
  tags: ['core', 'types'],

  createTransformer(options?: UnprototypedCallCastOptions) {
    return castUnprototypedCalls(options ?? {});
  },
};
