/**
 * Stack-Frame-Address Plugin
 *
 * `stack0xNNNNNNNN` is the decompiler's name for a frame address that owns no
 * variable: `&stack0xfffffef3` is "the byte at frame offset -0x10d". It is an
 * address, and it is never zero.
 *
 * The emitter used to substitute the literal `0` for it, over the whole raw text.
 * Five sites reached the compiler as `(0)[i]` and failed; sixteen more reached it
 * as `*(T*)(0 + x)` and COMPILED, reading address `x` instead of `frame + x`.
 * That is the same shape as the `((T*)base)[N]` byte-offset bug fixed in
 * `ae2c1fc`: valid C++, wrong address, no diagnostic.
 *
 * So the frame reference is resolved against the frame Ghidra actually modelled:
 *
 *   - cast straight to an integer      → a frame IDENTITY, not an address. This
 *                                        is the security cookie
 *                                        (`COOKIE ^ (uintptr_t)&stack0xfffffffc`),
 *                                        whose value is only ever compared with
 *                                        itself, so the constant stands;
 *   - a slot AT that offset            → the slot itself (`&local_20`);
 *   - a slot whose extent COVERS it    → `((uint8_t*)&buf + delta)`, the same
 *                                        arithmetic the machine does, on the
 *                                        object that owns the storage;
 *   - one byte past the last PARAMETER → the same anchored form. This is
 *                                        `va_start`: every positive frame offset
 *                                        in the corpus is exactly the address
 *                                        after the last named argument of a
 *                                        varargs function, and the cdecl ABI —
 *                                        not the compiler's whim — fixes that
 *                                        layout, which is why the step is only
 *                                        taken across a parameter;
 *   - one byte BELOW an ARRAY          → `((uint8_t*)&arr - 1)`. MSVC starts an
 *                                        inlined `strcat`/`strlen` scan one byte
 *                                        under the buffer and pre-increments, so
 *                                        the first byte read is `arr[0]` and the
 *                                        walk stays inside the array. The step is
 *                                        taken only below an array, whose extent
 *                                        is what keeps the walk on the object
 *                                        that anchors it — one byte below a
 *                                        scalar means the frame is modelled too
 *                                        small, and that belongs in Ghidra;
 *   - nothing that owns it             → Ghidra's own name, left in place.
 *
 * The last case does not compile, and that is the point. An unowned frame slot
 * cannot be spelled in C++ without a frame pointer, so it fails loudly at the
 * exact offset rather than silently reading somewhere else.
 *
 * A slot is only bound when the emitted body actually DECLARES it: Ghidra lists
 * frame variables the emitter drops (the cookie's own `local_8` goes with the
 * cookie statement), and binding to one of those trades a wrong address for an
 * undeclared name.
 *
 * Runs after `boilerplate-cleanup` (priority 500), which recognises the security
 * cookie by the literal name `stack0x…`; rewriting first would leave every cookie
 * statement in the output.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  Identifier,
  UnaryExpr,
  ParenExpr,
  BinaryExpr,
  CStyleCastExpr,
  IntegerLiteralExpr,
  PointerType,
  TypedefType,
  TypeNode,
  BuiltinType,
  VariableDecl,
  ParameterDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createKindTransformer, sequence, type Transformer } from '../../transformer.js';
import { typeNodeName } from './call-arg-cast.js';
import { createPlugin } from '../registry.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

/** One entry of Ghidra's stack frame: a named variable at a signed byte offset. */
export interface StackSlot {
  name: string;
  offset: number;
  size: number;
  /** A parameter's frame position is fixed by the ABI; a local's is not. */
  isParameter?: boolean;
  /** An array's extent is what makes an address just below it walkable. */
  isArray?: boolean;
}

export interface StackFrameAddressOptions extends PluginOptions {
  /** The enclosing function's frame, from Ghidra's own local-variable list. */
  slots?: StackSlot[];
}

const STACK_NAME_RE = /^stack0x([0-9a-fA-F]+)$/;

/** The signed byte offset a `stack0xNNNNNNNN` name denotes, or null. */
export function stackNameOffset(name: string): number | null {
  const m = STACK_NAME_RE.exec(name);
  if (!m) return null;
  const raw = Number.parseInt(m[1], 16);
  if (!Number.isFinite(raw)) return null;
  // Ghidra prints the offset as an unsigned 32-bit word.
  return raw >= 0x80000000 ? raw - 0x100000000 : raw;
}

function unwrapParens(expr: Expression): Expression {
  while (expr.kind === NodeKind.ParenExpr) expr = (expr as ParenExpr).expression;
  return expr;
}

function makeIdentifier(name: string, from: ASTNode): Identifier {
  return {
    kind: NodeKind.Identifier,
    name,
    location: from.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
}

/** `(uint8_t*)&slot + delta`, parenthesised so it can sit anywhere an address can. */
function anchoredAddress(slot: StackSlot, delta: number, from: ASTNode): Expression {
  const at = { location: from.location, leadingTrivia: [], trailingTrivia: [] };

  const byteType: TypedefType = {
    kind: NodeKind.TypedefType,
    name: makeIdentifier('uint8_t', from),
    ...at,
  };
  const bytePointer: PointerType = {
    kind: NodeKind.PointerType,
    pointee: byteType,
    qualifiers: [],
    ...at,
  };
  const addressOfSlot: UnaryExpr = {
    kind: NodeKind.UnaryExpr,
    operator: '&',
    operand: makeIdentifier(slot.name, from),
    ...at,
  };
  const cast: CStyleCastExpr = {
    kind: NodeKind.CStyleCastExpr,
    type: bytePointer,
    expression: addressOfSlot,
    ...at,
  };

  const outer = {
    location: from.location,
    leadingTrivia: from.leadingTrivia ?? [],
    trailingTrivia: from.trailingTrivia ?? [],
  };
  if (delta === 0) {
    return { kind: NodeKind.ParenExpr, expression: cast, ...outer } as ParenExpr;
  }

  const magnitude: IntegerLiteralExpr = {
    kind: NodeKind.IntegerLiteral,
    value: BigInt(Math.abs(delta)),
    suffix: '',
    base: 10,
    raw: String(Math.abs(delta)),
    ...at,
  };
  const sum: BinaryExpr = {
    kind: NodeKind.BinaryExpr,
    operator: delta > 0 ? '+' : '-',
    left: cast,
    right: magnitude,
    ...at,
  };
  return { kind: NodeKind.ParenExpr, expression: sum, ...outer } as ParenExpr;
}

/** Names the emitted body declares — parameters included. */
function declaredNames(root: ASTNode): Set<string> {
  const names = new Set<string>();
  for (const n of traverseAST(root)) {
    if (n.kind === NodeKind.VariableDecl) {
      const name = (n as VariableDecl).name?.name;
      if (name) names.add(name);
    } else if (n.kind === NodeKind.ParameterDecl) {
      const name = (n as ParameterDecl).name?.name;
      if (name) names.add(name);
    }
  }
  return names;
}

/** The `&stack0xNNNN` a node is, once parens are off. Null when it is anything else. */
function frameAddressOffset(expr: Expression): number | null {
  const e = unwrapParens(expr);
  if (e.kind !== NodeKind.UnaryExpr) return null;
  const unary = e as UnaryExpr;
  if (unary.operator !== '&') return null;
  const operand = unwrapParens(unary.operand);
  if (operand.kind !== NodeKind.Identifier) return null;
  return stackNameOffset((operand as Identifier).name);
}

/** Is this type an integer — something a frame address is only ever cast to as a value? */
function isIntegerType(type: TypeNode): boolean {
  if (type.kind === NodeKind.BuiltinType) {
    return (type as BuiltinType).name !== 'void';
  }
  if (type.kind === NodeKind.TypedefType) {
    const n = typeNodeName((type as TypedefType).name) ?? '';
    return /^(u?int(8|16|32|64|ptr)?(_t)?|uint|ulong|ulonglong|size_t|ssize_t|ptrdiff_t|DWORD|ULONG|UINT|LONG|INT|DWORD_PTR|ULONG_PTR|UINT_PTR|INT_PTR)$/.test(n);
  }
  return false;
}

/**
 * `(uintptr_t)&stack0xfffffffc` — the security-cookie seed. The value is XORed
 * into a cookie and compared against itself; it is never dereferenced, so the
 * constant it has always been is faithful enough and stays.
 */
function createFrameIdentityTransformer(): Transformer {
  return createKindTransformer(NodeKind.CStyleCastExpr, (node) => {
    const cast = node as CStyleCastExpr;
    if (!isIntegerType(cast.type)) return undefined;
    if (frameAddressOffset(cast.expression) === null) return undefined;
    const zero: IntegerLiteralExpr = {
      kind: NodeKind.IntegerLiteral,
      value: 0n,
      suffix: '',
      base: 10,
      raw: '0',
      location: cast.location,
      leadingTrivia: [],
      trailingTrivia: [],
    };
    return { ...cast, expression: zero } as CStyleCastExpr;
  });
}

function createFrameSlotTransformer(slots: StackSlot[]): Transformer {
  const byOffset = new Map<number, StackSlot>();
  for (const s of slots) if (!byOffset.has(s.offset)) byOffset.set(s.offset, s);

  return (root: ASTNode) => {
    const declared = declaredNames(root);
    return createKindTransformer(NodeKind.UnaryExpr, (node) => {
      const unary = node as UnaryExpr;
      if (unary.operator !== '&') return undefined;
      const operand = unwrapParens(unary.operand);
      if (operand.kind !== NodeKind.Identifier) return undefined;
      const offset = stackNameOffset((operand as Identifier).name);
      if (offset === null) return undefined;

      // The slot that starts here: `&stack0xffffffe0` IS `&local_20`.
      const exact = byOffset.get(offset);
      if (exact && declared.has(exact.name)) {
        return { ...unary, operand: makeIdentifier(exact.name, operand) } as UnaryExpr;
      }

      // The slot whose storage covers this byte: a buffer indexed from part-way in.
      let owner: StackSlot | undefined;
      for (const s of slots) {
        if (s.size <= 1 || !declared.has(s.name)) continue;
        if (offset < s.offset || offset >= s.offset + s.size) continue;
        if (!owner || s.size < owner.size) owner = s;
      }
      if (owner) return anchoredAddress(owner, offset - owner.offset, unary);

      // One byte below an array. Nothing may own the byte itself — an owned byte
      // is the slot before it, and binding across a boundary the compiler chooses
      // is a guess. Below an array the walk immediately enters the array, so the
      // arithmetic stays on the object that anchors it.
      const ownedByAny = slots.some((s) => offset >= s.offset && offset < s.offset + Math.max(s.size, 1));
      if (!ownedByAny) {
        for (const s of slots) {
          if (!s.isArray || !declared.has(s.name)) continue;
          if (offset !== s.offset - 1) continue;
          return anchoredAddress(s, -1, unary);
        }
      }

      // The address just past a parameter: the varargs list. `va_start(ap, fmt)`
      // on cdecl is `&fmt + sizeof fmt`, and the ABI guarantees the adjacency —
      // so the step is taken across a parameter and never across a local, whose
      // frame position the compiler is free to choose.
      for (const s of slots) {
        if (!s.isParameter || !declared.has(s.name)) continue;
        if (offset !== s.offset + s.size) continue;
        return anchoredAddress(s, s.size, unary);
      }

      // Nothing in the frame owns this address. Leave Ghidra's name, so it fails
      // where it is instead of turning into a read of address `0 + index`.
      return undefined;
    })(root);
  };
}

function createStackFrameAddressTransformer(options: StackFrameAddressOptions = {}): Transformer {
  const slots = options.slots ?? [];
  // The identity pass runs first, so a cookie seed is settled before the frame is
  // consulted — and it runs even for a function with no modelled frame at all.
  return sequence(
    createFrameIdentityTransformer(),
    slots.length > 0 ? createFrameSlotTransformer(slots) : ((node: ASTNode) => node),
  );
}

export const stackFrameAddressPlugin: TransformPlugin = createPlugin(
  'stack-frame-address',
  'Stack Frame Address',
  'Resolves Ghidra `&stack0xNNNN` frame addresses against the function\'s own stack frame',
  (options?: PluginOptions) =>
    createStackFrameAddressTransformer(options as StackFrameAddressOptions),
  {
    // After boilerplate-cleanup (500), which matches the security cookie on the
    // literal `stack0x` name.
    priority: 520,
    defaultEnabled: true,
    tags: ['cleanup', 'memory'],
    version: '1.0.0',
  }
);
