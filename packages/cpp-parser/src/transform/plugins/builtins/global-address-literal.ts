/**
 * Global Address Literal Resolution Plugin
 *
 * The data counterpart of `func-ptr-literal`. Where that pass resolves an
 * integer literal that IS a function's address into a reference to the
 * function, this one resolves a literal that is a GLOBAL's address — or a
 * folded expression over one — into a reference to the global.
 *
 * Transforms:
 * - `0x708360`    →  `&gSFileAsyncReqQueue`
 * - `0x708368`    →  `((char*)&gSFileAsyncReqQueue + 8)`
 * - `-7373669`    →  `~(uintptr_t)((char*)&gSFileAsyncReqQueue + 4)`
 *
 * ## Why the complement form exists
 *
 * Ghidra constant-folds `~&someGlobal` into ONE literal, which the emitter then
 * prints verbatim — as a signed 32-bit decimal, because that is how a word with
 * the top bit set reads. `gSFileAsyncReqQueue.pHead = (void*)-7373669` is a
 * Storm linked-list anchor: `-7373669` is `0xFF8F7C9B`, which is `~0x00708364`,
 * which is four bytes into the queue head. Kept as a literal it is an absolute
 * 1.14d image address, meaningless once the linker places the object somewhere
 * else — those four anchors are why the reconstructed `d2.exe` faulted with a
 * WRITE at 0x00000000 while loading its first MPQ. Written through the symbol,
 * the value follows the object.
 *
 * ## The rules, in order
 *
 * For a literal reduced to an unsigned 32-bit value `v`:
 *
 *  1. `v` is EXACTLY some global's address → `&name`. If two globals share the
 *     address the literal is left alone; picking one would be a guess.
 *  2. `v` falls strictly inside `[address, address + size)` of exactly ONE
 *     global → `((char*)&name + n)`. Sizes come from the extraction, never from
 *     the gap to the next symbol — an inferred extent would silently widen a
 *     global and swallow a neighbour's base.
 *  3. Neither matched, and `v`'s high bit is set → retry rules 1 and 2 against
 *     `~v`, and wrap the hit as `~(uintptr_t)<form>`.
 *
 * Rule 1 beats rule 2 where both fire: a literal that is one global's base and
 * another's interior names the base, which is the more specific fact. Rule 2
 * requires uniqueness among interiors only.
 *
 * ## Guards
 *
 * **The complement path needs the high bit.** Image addresses live around
 * 0x00400000-0x00900000, so `~address` always lands above 0xFF000000. Without
 * that floor every ordinary negative number in the tree becomes a complement
 * candidate, and `-1` starts resolving to whatever sits at address 0.
 *
 * **Every match is exact.** No nearest-symbol fallback, no fuzzy range, no
 * "closest preceding global". A literal that resolves to nothing stays a
 * literal; a wrong symbol is worse than an unresolved constant, because the
 * constant is at least visible as one.
 *
 * **A literal in an arithmetic context is NOT rewritten.** `base + 0x500100`,
 * `flags & 0x500100`, `n * 0x500100` — the pass reverts its own replacement the
 * way `func-ptr-literal` does. The reasoning: a genuine folded address in
 * arithmetic does exist (`*(int*)(0x708364 + i * 4)`), but so do masks, sizes
 * and scale factors that happen to collide with an address, and there is no
 * local evidence to tell them apart. Getting a real address wrong costs a wild
 * store; leaving one unresolved costs a compile-visible constant that the
 * hardcoded-address census still counts. The cheap failure is the one to take.
 *
 * A negation is the one arithmetic shape the pass DOES claim, because it is not
 * arithmetic on an address at all: the emitter's `-7373669` is how a
 * top-bit-set word prints, not a subtraction anyone wrote.
 */

import { NodeKind } from '../../../ast/kinds.js';
import { Expr, Type } from '../../../ast/factory.js';
import type {
  ASTNode,
  BinaryExpr,
  Expression,
  IntegerLiteralExpr,
  UnaryExpr,
} from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// Operators where an integer literal is a numeric operand, not an address
const ARITHMETIC_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);

/** `~address` of a 32-bit image address always lands above this. */
const COMPLEMENT_FLOOR = 0xff000000;

const WORD = 0x100000000;

/**
 * Below this, an "address" is not one.
 *
 * Ghidra manufactures a data symbol wherever it sees a reference it cannot
 * resolve, so the symbol table carries `DAT_00000000`, `DAT_00000001`,
 * `DAT_00000004` and dozens more at single-digit addresses — the residue of
 * `[reg + 4]` style operands, not objects. Admitting them makes every `0`, `1`
 * and `2` in the program an address: the first run of this pass rewrote
 * `pdwParam[1]` to `pdwParam[&DAT_00000001]` and failed 394 of 505 files.
 *
 * A Win32 process reserves the first 64KB and never maps an image there, so no
 * global can live below it. The bound is a property of the platform rather than
 * of this binary, which is why it is a constant here and not a configured base.
 */
const ADDRESS_FLOOR = 0x10000;

/**
 * At or above this, an "address" is not one either.
 *
 * The same placeholder machinery runs at the other end: a small NEGATIVE offset
 * becomes a symbol near the top of the word, so the table also carries
 * `DAT_fffffffb` and `hWndInsertAfter_fffffffe`. Those turned `pDstExtra[-5]`
 * into `pDstExtra[&DAT_fffffffb]`.
 *
 * A 32-bit Win32 process maps its image in the low half of the address space;
 * everything from 0x80000000 up is kernel-reserved and never holds a global.
 *
 * This bounds the CANDIDATE addresses only. It does not constrain the literal
 * VALUES the pass inspects, which is what `COMPLEMENT_FLOOR` is for — a folded
 * `~address` legitimately lands above 0xFF000000 and must still be tried.
 */
const ADDRESS_CEILING = 0x80000000;

interface Candidate {
  name: string;
  address: number;
  size: number;
}

/** A resolved literal: the global it names and the byte offset into it. */
interface Anchor {
  name: string;
  offset: number;
}

// ============================================
// RESOLUTION
// ============================================

/**
 * The global that owns unsigned address `v`, or null.
 *
 * Base-exact wins over interior. Either rule needs a UNIQUE owner: two globals
 * sharing a base, or two overlapping extents covering the same byte, both mean
 * the address does not identify one object and the literal stands.
 */
function ownerOf(v: number, candidates: readonly Candidate[]): Anchor | null {
  let base: Anchor | null = null;
  let baseCount = 0;
  let interior: Anchor | null = null;
  let interiorCount = 0;

  for (const c of candidates) {
    if (c.address === v) {
      base = { name: c.name, offset: 0 };
      baseCount++;
      continue;
    }
    if (c.size > 0 && v > c.address && v < c.address + c.size) {
      interior = { name: c.name, offset: v - c.address };
      interiorCount++;
    }
  }

  if (baseCount === 1) return base;
  if (baseCount > 1) return null;
  return interiorCount === 1 ? interior : null;
}

// ============================================
// EMISSION
// ============================================

/** `&name`, or `((char*)&name + n)` for a non-zero offset. */
function anchoredAddress(anchor: Anchor): Expression {
  const addressOf = Expr.unary('&', Expr.identifier(anchor.name));
  if (anchor.offset === 0) return addressOf;
  const bytes = Expr.cast(Type.pointer(Type.char()), addressOf);
  return Expr.paren(Expr.binary(bytes, '+', Expr.intLiteral(anchor.offset)));
}

/** `~(uintptr_t)<form>` — the complement the decompiler folded away. */
function complemented(form: Expression): Expression {
  return Expr.unary('~', Expr.cast(Type.typedef('uintptr_t'), form));
}

// ============================================
// TRANSFORMER
// ============================================

function createGlobalAddressLiteralTransformer(
  options: GlobalAddressLiteralOptions,
): Transformer {
  const addresses = options.globalAddresses ?? {};
  const sizes = options.globalSizes ?? {};

  const candidates: Candidate[] = [];
  for (const [name, address] of Object.entries(addresses)) {
    if (!Number.isSafeInteger(address) || address < ADDRESS_FLOOR || address >= ADDRESS_CEILING) {
      continue;
    }
    const size = sizes[name];
    candidates.push({
      name,
      address,
      size: Number.isSafeInteger(size) && size! > 0 ? size! : 0,
    });
  }
  if (candidates.length === 0) return createTransformer({});

  /**
   * Every replacement this pass produced, against the node it came from — the
   * same bookkeeping `func-ptr-literal` uses. `transformAST` hands the visitor's
   * own object to the parent, so a parent that turns out to be arithmetic
   * recognises the identical node and can put the original back.
   */
  const produced = new Map<ASTNode, ASTNode>();

  /** The literal `v`, or its complement, spelled through whichever global owns it. */
  function resolve(v: number): Expression | null {
    const direct = ownerOf(v, candidates);
    if (direct) return anchoredAddress(direct);
    if (v < COMPLEMENT_FLOOR) return null;
    const flipped = ownerOf((~v) >>> 0, candidates);
    return flipped ? complemented(anchoredAddress(flipped)) : null;
  }

  /** Carry the original node's trivia onto the replacement that stands in for it. */
  function replacing(original: ASTNode, replacement: Expression): ASTNode {
    return {
      ...replacement,
      location: original.location,
      leadingTrivia: original.leadingTrivia ?? [],
      trailingTrivia: original.trailingTrivia ?? [],
    } as ASTNode;
  }

  /** The literal behind a child, seeing through a replacement this pass made. */
  function literalBehind(node: ASTNode): IntegerLiteralExpr | null {
    const original = produced.get(node) ?? node;
    return original.kind === NodeKind.IntegerLiteral
      ? (original as IntegerLiteralExpr)
      : null;
  }

  return createTransformer({
    // Bottom-up: a literal is visited before the expression that contains it.
    visitNode(node: ASTNode) {
      if (node.kind !== NodeKind.IntegerLiteral) return undefined;

      const literal = node as IntegerLiteralExpr;
      if (literal.value < 0n || literal.value >= BigInt(WORD)) return undefined;

      const form = resolve(Number(literal.value));
      if (!form) return undefined;

      const ref = replacing(literal, form);
      produced.set(ref, literal);
      return ref;
    },

    // `-7373669` is one folded word, not a subtraction: reduce the negation and
    // the literal together, and undo any match the bare magnitude made on its own
    // (0x707C25 is as plausible an image address as 0xFF8F7C9B is).
    visitUnaryExpr(node: UnaryExpr) {
      if (node.operator !== '-') return undefined;

      const literal = literalBehind(node.operand);
      if (!literal) return undefined;
      if (literal.value <= 0n || literal.value > BigInt(WORD)) return undefined;

      const restored: UnaryExpr = { ...node, operand: literal };
      const form = resolve((WORD - Number(literal.value)) >>> 0);
      if (!form) {
        // No match for the negated word — put back whatever the magnitude alone
        // matched, so the number reads as the number it is.
        return produced.has(node.operand) ? restored : undefined;
      }

      const ref = replacing(node, form);
      produced.set(ref, restored);
      return ref;
    },

    // An address in arithmetic is indistinguishable from a mask or a scale
    // factor, so a replacement under an arithmetic operator is withdrawn.
    visitBinaryExpr(node: BinaryExpr) {
      if (!ARITHMETIC_OPS.has(node.operator)) return undefined;

      const left = produced.get(node.left);
      const right = produced.get(node.right);
      if (!left && !right) return undefined;

      return {
        ...node,
        left: (left ?? node.left) as Expression,
        right: (right ?? node.right) as Expression,
      };
    },
  });
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface GlobalAddressLiteralOptions extends PluginOptions {
  /** Global variable name (as emitted) → its address in the image. */
  globalAddresses?: Record<string, number>;
  /**
   * Global variable name (as emitted) → its size in bytes, as the extraction
   * reports it. A name absent here resolves only on its exact base: without a
   * real extent there is no interior to point into, and inferring one from the
   * distance to the next symbol would invent storage the global does not own.
   */
  globalSizes?: Record<string, number>;
}

export const globalAddressLiteralPlugin: TransformPlugin = {
  id: 'global-address-literal',
  name: 'Global Address Literal Resolution',
  description:
    'Resolve integer literals that are a global\'s address — including the ~&global form Ghidra folds into one constant — into a reference to the global, so the value survives relocation',
  version: '1.0.0',
  defaultEnabled: true,
  // Alongside `func-ptr-literal` (69), and for the same reason: after
  // `signed-literal` (30) has settled how a top-bit-set word is spelled, and
  // before the cast passes at 70+, which can only recognise a designator.
  priority: 68,
  tags: ['core', 'cleanup', 'correctness'],

  createTransformer(options?: GlobalAddressLiteralOptions) {
    return createGlobalAddressLiteralTransformer(options ?? {});
  },
};
