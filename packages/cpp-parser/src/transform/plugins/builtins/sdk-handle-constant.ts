/**
 * SDK Handle Constant Plugin
 *
 * The Win32 SDK names a few handle values the program passes as constants:
 *
 *   (HKEY)0x80000001                       ->  HKEY_CURRENT_USER
 *   (HKEY)(c ? 0x80000002 : 0x80000001)    ->  (c ? HKEY_LOCAL_MACHINE : HKEY_CURRENT_USER)
 *   LoadImageA(h, (LPCSTR)0x66, ...)       ->  LoadImageA(h, MAKEINTRESOURCEA(0x66), ...)
 *
 * Ghidra prints the value; the source spelled the macro. The two are the same 32 bits
 * on this target, but not the same pointer on a wider one: the SDK defines the
 * predefined keys as `(HKEY)(ULONG_PTR)((LONG)0x80000001)`, sign-extended, while
 * `(HKEY)0x80000001` converts an unsigned 32-bit integer and zero-extends it. The macro
 * is the program's value at every width; the literal is only on this one.
 *
 * Only the SDK's own definitions are used, and only where the cast's type says which:
 * a cast to `HKEY` of one of the predefined key values, and a resource name (`LPCSTR`,
 * `LPSTR`, `LPCWSTR`, `LPWSTR`) passed to a resource loader whose argument is an integer
 * resource id (1..0xffff). A ternary of such constants becomes a ternary of the names.
 * Anything else - `(HKEY)0`, an id outside the 16-bit range, a name argument of any
 * other function - is left as it is.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CallExpr, CStyleCastExpr, ConditionalExpr, Expression, IntegerLiteralExpr,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { bareName, calleeName, typeNodeName, unwrapParens } from './call-arg-cast.js';

/** winreg.h: the predefined keys. */
const PREDEFINED_KEYS: ReadonlyMap<bigint, string> = new Map([
  [0x80000000n, 'HKEY_CLASSES_ROOT'],
  [0x80000001n, 'HKEY_CURRENT_USER'],
  [0x80000002n, 'HKEY_LOCAL_MACHINE'],
  [0x80000003n, 'HKEY_USERS'],
  [0x80000004n, 'HKEY_PERFORMANCE_DATA'],
  [0x80000005n, 'HKEY_CURRENT_CONFIG'],
  [0x80000006n, 'HKEY_DYN_DATA'],
]);

/**
 * Resource loaders and the argument index of the resource name, which takes an integer
 * id through MAKEINTRESOURCE. The macro's character width follows the function's.
 */
const RESOURCE_NAME_ARGS: Readonly<Record<string, { index: number; macro: string }>> = {
  LoadImageA: { index: 1, macro: 'MAKEINTRESOURCEA' },
  LoadImageW: { index: 1, macro: 'MAKEINTRESOURCEW' },
  LoadIconA: { index: 1, macro: 'MAKEINTRESOURCEA' },
  LoadIconW: { index: 1, macro: 'MAKEINTRESOURCEW' },
  LoadCursorA: { index: 1, macro: 'MAKEINTRESOURCEA' },
  LoadCursorW: { index: 1, macro: 'MAKEINTRESOURCEW' },
  LoadBitmapA: { index: 1, macro: 'MAKEINTRESOURCEA' },
  LoadBitmapW: { index: 1, macro: 'MAKEINTRESOURCEW' },
  LoadMenuA: { index: 1, macro: 'MAKEINTRESOURCEA' },
  LoadMenuW: { index: 1, macro: 'MAKEINTRESOURCEW' },
  LoadAcceleratorsA: { index: 1, macro: 'MAKEINTRESOURCEA' },
  LoadAcceleratorsW: { index: 1, macro: 'MAKEINTRESOURCEW' },
  DialogBoxParamA: { index: 1, macro: 'MAKEINTRESOURCEA' },
  DialogBoxParamW: { index: 1, macro: 'MAKEINTRESOURCEW' },
  CreateDialogParamA: { index: 1, macro: 'MAKEINTRESOURCEA' },
  CreateDialogParamW: { index: 1, macro: 'MAKEINTRESOURCEW' },
};

const RESOURCE_NAME_TYPES = new Set(['LPCSTR', 'LPSTR', 'LPCWSTR', 'LPWSTR']);

let rewrites = 0;
export function getSdkHandleConstantCount(): number { return rewrites; }
export function resetSdkHandleConstantCount(): void { rewrites = 0; }

function literalValue(e: Expression): bigint | null {
  const u = unwrapParens(e);
  if (u.kind !== NodeKind.IntegerLiteral) return null;
  const lit = u as IntegerLiteralExpr;
  if (/ll/i.test(lit.suffix ?? '')) return null;
  return lit.value;
}

/**
 * `e` with every constant arm named, through `?:`: `name(v)` for a literal, the same
 * conditional for a select between named constants. Null when an arm has no name.
 */
function named(e: Expression, name: (v: bigint) => Expression | null): Expression | null {
  const u = unwrapParens(e);
  if (u.kind === NodeKind.ConditionalExpr) {
    const c = u as ConditionalExpr;
    const t = named(c.thenExpr, name);
    const f = named(c.elseExpr, name);
    if (!t || !f) return null;
    return Expr.paren(Expr.conditional(c.condition, t, f)) as unknown as Expression;
  }
  const v = literalValue(u);
  return v === null ? null : name(v);
}

function castTypeName(cast: CStyleCastExpr): string | undefined {
  const t = cast.type as unknown as { kind: NodeKind; name?: unknown };
  return t.kind === NodeKind.TypedefType ? typeNodeName(t.name) : undefined;
}

export function createSdkHandleConstantTransformer(_options?: PluginOptions): Transformer {
  const key = (v: bigint): Expression | null => {
    const n = PREDEFINED_KEYS.get(v);
    return n ? Expr.identifier(n) as unknown as Expression : null;
  };
  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind === NodeKind.CStyleCastExpr) {
        const cast = n as CStyleCastExpr;
        if (castTypeName(cast) !== 'HKEY') return undefined;
        const r = named(cast.expression, key);
        if (!r) return undefined;
        rewrites++;
        return r;
      }
      if (n.kind !== NodeKind.CallExpr) return undefined;
      const call = n as CallExpr;
      const callee = calleeName(call.callee);
      const site = callee ? RESOURCE_NAME_ARGS[bareName(callee)] : undefined;
      if (!site || site.index >= call.arguments.length) return undefined;
      const arg = unwrapParens(call.arguments[site.index]);
      if (arg.kind !== NodeKind.CStyleCastExpr) return undefined;
      const t = castTypeName(arg as CStyleCastExpr);
      if (!t || !RESOURCE_NAME_TYPES.has(t)) return undefined;
      const id = (v: bigint): Expression | null => v >= 1n && v <= 0xffffn
        ? Expr.call(site.macro, [Expr.intLiteral(v, 16) as unknown as Expression]) as unknown as Expression
        : null;
      const r = named((arg as CStyleCastExpr).expression, id);
      if (!r) return undefined;
      rewrites++;
      const args = call.arguments.slice();
      args[site.index] = r;
      return updateNode(call, { arguments: args } as Partial<CallExpr>);
    },
  });
}

export const sdkHandleConstantPlugin: TransformPlugin = {
  id: 'sdk-handle-constant',
  name: 'SDK Handle Constant',
  description:
    'Spells a predefined registry key ((HKEY)0x80000001) and an integer resource id passed to a resource loader with the SDK macro that defines them: HKEY_CURRENT_USER, MAKEINTRESOURCEA(id)',
  version: '1.0.0',
  // With the other portability respellings, after every pass that reads the literal.
  priority: 994,
  afterSourceForms: true,
  defaultEnabled: true,
  tags: ['cleanup', 'portability'],
  createTransformer: createSdkHandleConstantTransformer,
};
