/**
 * Immediate Not Address Plugin
 *
 * `DecodeCpuModelName` (0040e300) names a Cyrix MediaGX family 5, model >= 4 part by
 * storing four bytes into the caller's buffer in one instruction:
 *
 *     0040e386  MOV dword ptr [EDI],0x6d5847      ; "GXm\0"
 *
 * The source was `strcpy(pOutName, "GXm")`, which MSVC inlined to a single dword store of
 * the literal's bytes; its siblings are `memcpy(pOutName, "MediaGX", 8)` and so on. The
 * immediate happens to fall inside the image, and the decompiler, which prints a mapped
 * value in a pointer-typed slot as a pointer, writes
 *
 *     *(undefined **)pOutName = &UNK_006d5847;
 *
 * There is no symbol, no data and no reference at 006d5847. The tree declared
 * `UNK_006d5847`, nothing defined it, and the link failed; had something been defined
 * there, the rebuild would have stored the address of a relocated byte instead of "GXm".
 *
 * The evidence is on the instruction, not in the value: the extraction records every
 * 32-bit scalar operand whose value is a mapped address while the instruction carries no
 * reference to it (extract/operand-refs.ts, `S` rows; codegen/immediate-constant-spec.ts
 * keeps the immediates whose value nothing else in the function references, encodes as a
 * displacement, or derives). Given those values, a `&UNK_v` / `&DAT_v` whose name is
 * Ghidra's default label for v itself, with no global of that name and no global whose
 * extent covers v, is the constant v, and is emitted as one:
 *
 *  1. stored through a pointer-to-pointer cast into a `char` buffer, with the four bytes
 *     three printable characters and a NUL: the literal copy the siblings use,
 *     `memcpy(p, "GXm", 4)` - the same four bytes;
 *  2. stored through a pointer-to-pointer cast otherwise: `*(uint32_t *)p = 0xv` - the
 *     same four-byte store, of the integer;
 *  3. anywhere else: `(undefined *)0xv`, the integer in the expression's own type.
 *
 * Never inferred from the value alone: no `S` row, no rewrite.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, ArrayType, AssignExpr, BuiltinType, CStyleCastExpr, Expression, FunctionDecl, Identifier,
  ParameterDecl, ParenExpr, PointerType, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { Expr, Type } from '../../../ast/factory.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';

export interface ImmediateNotAddressOptions extends PluginOptions {
  /** Immediates of this function that are constants, by the instruction (see the header). */
  constants?: readonly { value: number; ins: string }[];
  /** Every global name the tables know: a name the program defines is a symbol. */
  globalNames?: readonly string[];
  /** The global or string whose extent covers an address, or null when nothing is there. */
  dataAt?: (address: number) => string | null;
  onRewrite?: (info: { name: string; value: number; ins: string; form: string }) => void;
  onRefusal?: (reason: string) => void;
}

const DEFAULT_LABEL = /^(?:UNK|DAT)_([0-9a-fA-F]{8})$/;

function unwrap(e: Expression): Expression {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as ParenExpr).expression;
  return x;
}

/** `&NAME`, NAME an Identifier: the name, else null. */
function addressOfName(e: Expression): string | null {
  const x = unwrap(e);
  if (x.kind !== NodeKind.UnaryExpr || (x as UnaryExpr).operator !== '&') return null;
  const o = unwrap((x as UnaryExpr).operand);
  return o.kind === NodeKind.Identifier ? (o as Identifier).name : null;
}

function isPlainChar(t: TypeNode): boolean {
  if (t.kind !== NodeKind.BuiltinType) return false;
  const b = t as BuiltinType & { modifiers?: string[] };
  return b.name === 'char' && !(b.modifiers ?? []).includes('unsigned') && !(b.modifiers ?? []).includes('signed');
}

/** A `char *` or `char[N]` variable: the store target is a char buffer. */
function isCharBuffer(t: TypeNode | undefined): boolean {
  if (!t) return false;
  if (t.kind === NodeKind.PointerType) return isPlainChar((t as PointerType).pointee);
  if (t.kind === NodeKind.ArrayType) return isPlainChar((t as ArrayType).elementType);
  return false;
}

/** The 4 bytes of `v` as a C string, when they are 3 printable characters and a NUL. */
function asCString(v: number): string | null {
  const b = [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  if (b[3] !== 0) return null;
  for (let i = 0; i < 3; i++) {
    if (b[i] < 0x20 || b[i] > 0x7e) return null;
  }
  return String.fromCharCode(b[0], b[1], b[2]);
}

function hexLiteral(v: number): Expression {
  return Expr.intLiteral(v, 16);
}

export function createImmediateNotAddressTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as ImmediateNotAddressOptions;
  const constants = o.constants ?? [];
  if (constants.length === 0) return (n: ASTNode) => n;
  const names = new Set(o.globalNames ?? []);
  // No table, no evidence that the address is empty: nothing is rewritten.
  if (!o.dataAt) return (n: ASTNode) => n;
  const dataAt = o.dataAt;
  const byValue = new Map<number, string>();
  for (const c of constants) byValue.set(c.value, c.ins);

  /** The constant `&name` stands for, or null. */
  function constantOf(name: string | null): { value: number; ins: string } | null {
    if (!name) return null;
    const m = DEFAULT_LABEL.exec(name);
    if (!m) return null;
    const value = Number.parseInt(m[1], 16);
    const ins = byValue.get(value);
    if (ins === undefined) return null;
    if (names.has(name)) {
      o.onRefusal?.(`${name}: a global of that name exists`);
      return null;
    }
    const at = dataAt(value);
    if (at) {
      o.onRefusal?.(`${name}: 0x${value.toString(16)} lies in ${at}`);
      return null;
    }
    return { value, ins };
  }

  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const types = new Map<string, TypeNode>();
      for (const p of findNodesByKind(fn, NodeKind.ParameterDecl)) {
        const d = p as ParameterDecl;
        if (d.name) types.set(d.name.name, d.type);
      }
      for (const v of findNodesByKind(fn.body, NodeKind.VariableDecl)) {
        const d = v as VariableDecl;
        types.set(d.name.name, d.type);
      }

      // First, the four-byte stores.
      const sub = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind === NodeKind.AssignExpr) {
            const a = n as AssignExpr;
            if (a.operator !== '=') return undefined;
            const name = addressOfName(a.right);
            const c = constantOf(name);
            if (!c) return undefined;
            // *(T **)p = &UNK_v: a four-byte store of v.
            const l = unwrap(a.left);
            if (l.kind !== NodeKind.UnaryExpr || (l as UnaryExpr).operator !== '*') return undefined;
            const cast = unwrap((l as UnaryExpr).operand);
            if (cast.kind !== NodeKind.CStyleCastExpr) return undefined;
            const ct = (cast as CStyleCastExpr).type;
            if (ct.kind !== NodeKind.PointerType || (ct as PointerType).pointee.kind !== NodeKind.PointerType) return undefined;
            const target = (cast as CStyleCastExpr).expression;
            const t = unwrap(target);
            const text = asCString(c.value);
            if (text !== null && t.kind === NodeKind.Identifier && isCharBuffer(types.get((t as Identifier).name))) {
              o.onRewrite?.({ name: name!, value: c.value, ins: c.ins, form: `memcpy("${text}", 4)` });
              return Expr.call('memcpy', [target, Expr.stringLiteral(text), Expr.intLiteral(4)]);
            }
            o.onRewrite?.({ name: name!, value: c.value, ins: c.ins, form: 'uint32_t store' });
            return updateNode(a, {
              left: Expr.deref(Expr.cast(Type.pointer(Type.typedef('uint32_t')), target)),
              right: hexLiteral(c.value),
            } as Partial<AssignExpr>);
          }
          return undefined;
        },
      });
      // Second, every other `&UNK_v` (a separate walk, so a store is judged whole first).
      const rest = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
            const name = addressOfName(n as Expression);
            const c = constantOf(name);
            if (!c) return undefined;
            o.onRewrite?.({ name: name!, value: c.value, ins: c.ins, form: 'integer' });
            return Expr.paren(Expr.cast(Type.pointer(Type.typedef('undefined')), hexLiteral(c.value)));
          }
          return undefined;
        },
      });
      return updateNode(fn, { body: rest(sub(fn.body)) } as Partial<FunctionDecl>);
    },
  });
}

export const immediateNotAddressPlugin: TransformPlugin = createPlugin(
  'immediate-not-address',
  'Immediate Not Address',
  'An immediate the decompiler printed as &UNK_/&DAT_ with no reference on the instruction, emitted as the constant it is',
  (options?: PluginOptions) => createImmediateNotAddressTransformer(options),
  {
    priority: 9, // before ghidra-cleanup (10) and type-normalize (15) touch the cast or the name
    defaultEnabled: true,
    tags: ['correctness'],
    version: '1.0.0',
  },
);
