/**
 * Pointer-Comparison Cast-Insertion Plugin
 *
 * The machine compares two addresses. Ghidra's C reaches that with `pbScan <
 * pszEnd` across two differently-typed pointers, because the decompiler recovers
 * a pointee type per variable and the same register is often reused as `byte *`
 * in one place and `short *` in another. C++ rejects the comparison outright -
 * "comparison between distinct pointer types ... lacks a cast" - so the original
 * MSVC source carried a cast, and writing it back is transcription.
 *
 * A comparison is the safe operator to do this on. `==`, `!=`, `<`, `<=`, `>`
 * and `>=` compare the addresses themselves, so casting either operand to the
 * other's type cannot change the answer. Pointer SUBTRACTION is deliberately not
 * touched: `(T*)a - (T*)b` divides by `sizeof(T)`, and picking a side there would
 * change the value.
 *
 * The same argument settles a pointer compared against an INTEGER, which C++
 * also rejects. There the pointer side goes through `uintptr_t`: that is the
 * machine's own operation - a `cmp` of two 32-bit words - it is width-exact,
 * and `uintptr_t` is spellable everywhere, where the pointee type may not be.
 * Only a MACHINE-WORD integer qualifies; a narrower one would mean the model
 * disagrees about the width somewhere else, and that stays visible. The pointer
 * side is recognised by its shape, or — where no table types the operand, as
 * with a file-local static — by its being an `&` expression, which is a pointer
 * in the language regardless of what it points at. The same reach applies one
 * shape further along: a Ghidra STRING LABEL carries its `char[N]` by naming
 * convention alone, and an offset onto one (`s_label + 8`, how a folded interior
 * address into a string constant comes out) is that array walked, so the
 * convention has to survive the arithmetic.
 *
 * The cast is always spelled with a BUILTIN type - `(unsigned char*)`,
 * `(short*)`, `(void*)`. One of the two sides in this shape is essentially always
 * a raw byte/word walk, and confining the emitted spelling to a builtin means
 * the cast can never name a type that is out of scope at the comparison, or a
 * typedef that resolves differently in the header the comparison is emitted
 * into. Where neither side reduces to a builtin pointer - two function pointers,
 * two unrelated structs - nothing is written and the disagreement stays visible.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, VariableDecl, ParameterDecl, Expression, BinaryExpr, TypeNode,
  IntegerLiteralExpr, Identifier, UnaryExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Type, Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape } from './expr-shape.js';
import {
  SCALAR_BASES, sameShape, unwrapParens, type TypeShape, type TypedefResolver,
} from './call-arg-cast.js';

export interface PointerCompareCastOptions extends PluginOptions {
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
}

/** The comparisons that read only the addresses, never the pointee size. */
const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);

/** A shape that can be written as a cast with nothing but a builtin type name. */
const isBuiltinPointer = (s: TypeShape): boolean => s.stars > 0 && SCALAR_BASES.has(s.base);

/**
 * The integer widths a pointer's value fits in exactly. A narrower slot would
 * truncate the address, which the machine never did, so it is left visible.
 */
const WORD_INTEGER_BASES = new Set([
  'int', 'unsigned int', 'long', 'unsigned long', 'uintptr_t', 'intptr_t',
  'size_t', 'ssize_t', 'pointer32',
]);

const isWordInteger = (s: TypeShape) => s.stars === 0 && WORD_INTEGER_BASES.has(s.base);

/**
 * An integer LITERAL compared against a pointer. `expr-shape` deliberately has
 * no shape for a literal - it is not an object with a declared type - but
 * `3 < pnOddPart` is the same machine comparison as any other, and the literal
 * side needs no cast at all.
 */
const isIntegerLiteral = (e: Expression): boolean => {
  const u = unwrapParens(e);
  if (u.kind !== NodeKind.IntegerLiteral) return false;
  // `p == 0` is a null-pointer comparison and already legal; `nullptr-cleanup`
  // owns how it is spelled.
  return (u as IntegerLiteralExpr).value !== 0n;
};

function spell(s: TypeShape): TypeNode {
  let node: TypeNode = Type.builtin(s.base);
  for (let i = 0; i < s.stars; i++) node = Type.pointer(node);
  return node;
}

/**
 * Ghidra's auto-name for string data: `s_<mangled text>_<hex address>` — see
 * `declaration-closure.ts`'s `STRING_LABEL_RE`, which this mirrors (cpp-parser
 * has no dependency on the reconstruct package the closure lives in). A name
 * shaped like this can be referenced by a function body without ever having
 * become a `globals` model record at all: it was never sized, never typed,
 * never listed. The declaration closure still owes it a declaration, and the
 * only one it CAN write from a bare label is `extern char NAME[];` - the
 * bytes at that address, unsized. No `globalTypes` table this plugin is ever
 * handed will carry such a name, so `shapeOf` alone can never see it as a
 * pointer.
 *
 * `gaPKWARE_DistCodeTable`'s loop bound in `compiler.cpp` is exactly this: the
 * label Ghidra wrote for the byte immediately after the table, which happens
 * to be where a copyright string starts. The comparison is real - `psVar8` is
 * walking off the end of an array that a string just happens to sit past -
 * and the bound genuinely is `char*`, just not through any table this pass
 * reads. This is the one shape a Ghidra string-label identifier can be known
 * to have with no table at all: a bare use of a declared array decays to a
 * pointer to its element the same way any other one does.
 */
const GHIDRA_STRING_LABEL_RE = /^s_.*_[0-9a-fA-F]{6,}$/;

const isStringLabelIdentifier = (e: Expression): boolean => {
  const u = unwrapParens(e);
  return u.kind === NodeKind.Identifier && GHIDRA_STRING_LABEL_RE.test((u as Identifier).name);
};

/**
 * `&anything` is a pointer. Not a SHAPE — the pointee is exactly what is unknown
 * here — but the one fact the pointer-vs-word branch needs, and it is the
 * language's, not a model's.
 *
 * `shapeOf` declines an address-of whose operand it cannot type, and a
 * file-local static is precisely that: `LightMap.cpp` declares
 * `gaLightmapInterpBuffer` and `gnLightmapInterpDirX` `static` in its own
 * translation unit, so no globals table names either. The loop that walks the
 * first and stops at the address of the second came out as
 * `(int)pCollisionCell < &gnLightmapInterpDirX` — "ISO C++ forbids comparison
 * between pointer and integer" — with nothing in the model to say the right-hand
 * side was an address at all.
 *
 * Confined to that branch on purpose: it only needs to know THAT the side is an
 * address. The two-pointer branches still require a real shape, because they
 * have to SPELL a pointee type.
 */
const isAddressOf = (e: Expression): boolean => {
  const u = unwrapParens(e);
  return u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '&';
};

export function createPointerCompareCastTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as PointerCompareCastOptions;
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];

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

      const shapeOfModeled = createExprShape(localTypes, {
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });
      // A string-label identifier only falls back to the naming convention
      // when every modeled source declined - a local, a global, or a field
      // table naming it is always the more exact answer.
      //
      // The fallback has to be reachable at EVERY level of the walk, not only at
      // the top. `expr-shape` handles pointer arithmetic itself - `p + 8` keeps
      // p's type - but it resolves the base through its own tables, and a string
      // label is exactly the name no table carries. So an interior address folded
      // onto a string constant, `s___UI_SkillDesc_cpp_006dbf24 + 8`, came back
      // shapeless and the comparison stayed "pointer and integer". Recursing
      // here re-walks the same rule with the convention in hand.
      //
      // The arithmetic rule is copied from `expr-shape`, deliberately: `+`/`-`
      // with EXACTLY ONE pointer operand. `s_a - s_b` is a distance, an integer,
      // and must not come back a pointer.
      function shapeOf(e: Expression): TypeShape | null {
        const modeled = shapeOfModeled(e);
        if (modeled) return modeled;
        if (isStringLabelIdentifier(e)) return { base: 'char', stars: 1, isConst: false };
        const u = unwrapParens(e);
        if (u.kind !== NodeKind.BinaryExpr) return null;
        const b = u as BinaryExpr;
        if (b.operator !== '+' && b.operator !== '-') return null;
        const l = shapeOf(b.left as Expression);
        const r = shapeOf(b.right as Expression);
        if (l && l.stars > 0 && (!r || r.stars === 0)) return l;
        if (b.operator === '+' && r && r.stars > 0 && (!l || l.stars === 0)) return r;
        return null;
      }

      let changed = false;
      const inner = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.BinaryExpr) return undefined;
          const b = n as BinaryExpr;
          if (!COMPARISONS.has(b.operator)) return undefined;
          const left = shapeOf(b.left as Expression);
          const right = shapeOf(b.right as Expression);
          // A pointer against a machine word: the `cmp` reads both as words, so
          // the pointer goes through `uintptr_t` and the integer stays as it is.
          const wordCompare = (
            ptr: TypeShape | null, other: TypeShape | null,
            otherExpr: Expression, ptrExpr: Expression,
          ) => (ptr ? ptr.stars > 0 : isAddressOf(ptrExpr))
            && (isIntegerLiteral(otherExpr) ? true : !!other && isWordInteger(other));
          if (wordCompare(left, right, b.right as Expression, b.left as Expression)) {
            changed = true;
            return updateNode(b, {
              left: Expr.cast(Type.typedef('uintptr_t'), b.left as Expression),
            } as Partial<BinaryExpr>);
          }
          if (wordCompare(right, left, b.left as Expression, b.right as Expression)) {
            changed = true;
            return updateNode(b, {
              right: Expr.cast(Type.typedef('uintptr_t'), b.right as Expression),
            } as Partial<BinaryExpr>);
          }
          if (!left || !right) return undefined;
          if (left.stars === 0 || right.stars === 0) return undefined;
          if (sameShape(left, right)) return undefined;
          // Prefer to move the side that is NOT already a builtin pointer, so a
          // named struct is the one that gets reinterpreted and the surviving
          // spelling is the raw walk the machine actually performs.
          if (isBuiltinPointer(left)) {
            changed = true;
            return updateNode(b, {
              right: Expr.cast(spell(left), b.right as Expression),
            } as Partial<BinaryExpr>);
          }
          if (isBuiltinPointer(right)) {
            changed = true;
            return updateNode(b, {
              left: Expr.cast(spell(right), b.left as Expression),
            } as Partial<BinaryExpr>);
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

export const pointerCompareCastPlugin: TransformPlugin = {
  id: 'pointer-compare-cast',
  name: 'Pointer Comparison Cast Insertion',
  description:
    'Casts one side of a comparison between distinct pointer types, which C++ rejects and the machine performs on the addresses',
  version: '1.0.0',
  defaultEnabled: true,
  // After call-arg-cast (610), so an argument's final form is already settled.
  priority: 615,
  tags: ['cleanup', 'type'],
  createTransformer: createPointerCompareCastTransformer,
};
