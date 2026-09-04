/**
 * Address-Run Loop-Bound Plugin
 *
 * A pointer walks one global and stops at the address of the NEXT one:
 *
 *   pColorEntry = gbD2CompColorInitR + 1;
 *   do { ... pColorEntry += 3; }
 *   while ((int)pColorEntry < (uintptr_t)&gbCompItemEmblemColorTableTemp4);
 *
 * That is a faithful transcription of `cmp esi, 0x72e1bb` — the compiler folded
 * `&table[10]` into an absolute address, and `global-address-literal` resolved
 * that address back to the symbol that happens to sit there. In the original
 * image the two symbols are 31 bytes apart, so the loop runs ten times.
 *
 * The reconstruction does not preserve the data layout. The linker places the
 * two objects wherever it likes — in D2Comp.cpp the first is an initialized
 * static in `.data` and the second is a zero static in `.bss`, several megabytes
 * apart — and the same loop then runs millions of times, smearing its writes
 * across every global above the destination. This was the crash that killed the
 * 1.14d reconstruction at the main menu: `D2COMP_InitEmblemColorTables` wrote
 * 2.2MB of palette indices over the whole upper `.bss`, including the log
 * manager's open-file table, and the log thread then called `fclose` on a
 * palette byte.
 *
 * Resolving the bound to a SYMBOL is what breaks it, because the value the
 * machine compared is not that symbol's address — it is a fixed DISTANCE from
 * the array being walked. So the bound is respelled as that distance:
 *
 *   while ((int)pColorEntry < ((uintptr_t)&gbD2CompColorInitR + 31));
 *
 * which is relocation-proof, needs no adjacency, and is the same ten iterations
 * on any layout.
 *
 * The anchor is not guessed. It must be a global that FLOWS INTO the walking
 * pointer — named in the compared expression itself, or assigned into its root
 * variable somewhere in the same function — and it must lie below the bound.
 * Where several qualify the nearest one below wins, which is what makes a
 * function holding two such loops back to back resolve each against its own
 * table. No candidate, no address for either end, or a distance wider than a
 * single object's plausible extent: nothing is written and the address-of form
 * stands, still visible.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, VariableDecl, Expression, BinaryExpr, Identifier, UnaryExpr,
  CStyleCastExpr, ParenExpr, AssignExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Type, Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface AddressRunBoundOptions extends PluginOptions {
  /** Global variable name (as emitted) → its address in the image. */
  globalAddresses?: Record<string, number>;
  /**
   * Global variable name (as emitted) → the namespace segments its DEFINITION is
   * emitted in. Unused for the spelling — the anchor is respelled with the exact
   * identifier text the function already uses for it — but carried so the option
   * shape matches `global-address-literal`'s, which feeds this pass its table.
   */
  globalNamespaces?: Record<string, readonly string[]>;
}

/** Only an ORDERING comparison can carry a bound. `==` / `!=` is a sentinel test. */
const ORDERINGS = new Set(['<', '<=', '>', '>=']);

/**
 * The widest distance that can still be one object's extent. Beyond this the
 * "bound" is more likely two unrelated symbols that happen to be ordered, and
 * inventing a distance between them would be a guess.
 */
const MAX_RUN_BYTES = 0x20000;

function unwrap(e: Expression): Expression {
  let cur = e;
  for (;;) {
    if (cur.kind === NodeKind.ParenExpr) { cur = (cur as ParenExpr).expression as Expression; continue; }
    if (cur.kind === NodeKind.CStyleCastExpr) { cur = (cur as CStyleCastExpr).expression as Expression; continue; }
    return cur;
  }
}

/**
 * The name a comparison operand names as a BARE ADDRESS: `&sym`, or `sym` where
 * the global is an array and decays. Casts and parens are transparent — the
 * emitted form is `(uintptr_t)&sym`, and the cast says nothing about which
 * object the value belongs to.
 */
function boundName(e: Expression): string | undefined {
  const u = unwrap(e);
  if (u.kind === NodeKind.UnaryExpr) {
    const un = u as UnaryExpr;
    if (un.operator !== '&') return undefined;
    const inner = unwrap(un.operand as Expression);
    return inner.kind === NodeKind.Identifier ? (inner as Identifier).name : undefined;
  }
  return undefined;
}

/** Every identifier named anywhere inside an expression. */
function identifiersIn(node: ASTNode): string[] {
  return findNodesByKind(node, NodeKind.Identifier).map(n => (n as Identifier).name);
}

/**
 * The variable a compared expression walks. `(int)pColorEntry` and
 * `(int)(pEntry + 4)` both root at one local; anything that roots at several is
 * not a walk this pass can follow.
 */
function walkerRoot(e: Expression): string | undefined {
  const names = identifiersIn(unwrap(e));
  return names.length === 1 ? names[0] : undefined;
}

export function createAddressRunBoundTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as AddressRunBoundOptions;
  const addresses = o.globalAddresses ?? {};
  if (Object.keys(addresses).length === 0) return (unit: ASTNode) => unit;

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;

      // Where each local pointer gets its value: the declaration's initializer
      // and every later assignment, as the set of globals named in them. One
      // variable reused for two walks therefore carries both anchors, and the
      // nearest-below rule picks the right one at each comparison.
      const sources = new Map<string, Set<string>>();
      const record = (name: string, from: ASTNode | undefined) => {
        if (!from) return;
        let set = sources.get(name);
        if (!set) { set = new Set(); sources.set(name, set); }
        for (const id of identifiersIn(from)) if (addresses[id] !== undefined) set.add(id);
      };
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (v.initializer) record(v.name.name, v.initializer as ASTNode);
      }
      for (const a of findNodesByKind(node.body, NodeKind.AssignExpr)) {
        const asg = a as AssignExpr;
        const target = unwrap(asg.left as Expression);
        if (target.kind !== NodeKind.Identifier) continue;
        record((target as Identifier).name, asg.right as ASTNode);
      }

      let changed = false;
      const inner = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.BinaryExpr) return undefined;
          const b = n as BinaryExpr;
          if (!ORDERINGS.has(b.operator)) return undefined;

          const rewrite = (bound: Expression, walker: Expression): Expression | undefined => {
            const sym = boundName(bound);
            if (!sym) return undefined;
            const boundAddr = addresses[sym];
            if (boundAddr === undefined) return undefined;

            // Candidates: globals named in the walking expression itself, plus
            // every global that has ever been assigned into its root variable.
            const candidates = new Set<string>();
            for (const id of identifiersIn(unwrap(walker))) {
              if (addresses[id] !== undefined) candidates.add(id);
            }
            const root = walkerRoot(walker);
            if (root) for (const id of sources.get(root) ?? []) candidates.add(id);

            let anchor: string | undefined;
            let anchorAddr = -1;
            for (const id of candidates) {
              if (id === sym) continue;
              const a = addresses[id];
              if (a >= boundAddr) continue;
              if (a > anchorAddr) { anchorAddr = a; anchor = id; }
            }
            if (!anchor) return undefined;

            const delta = boundAddr - anchorAddr;
            if (delta <= 0 || delta > MAX_RUN_BYTES) return undefined;

            // The anchor is spelled with the identifier the function already
            // uses, so the reference resolves in exactly the scope the walk's
            // own reference does.
            return Expr.paren(Expr.binary(
              Expr.cast(Type.typedef('uintptr_t'), Expr.unary('&', Expr.identifier(anchor))),
              '+',
              Expr.intLiteral(delta),
            ));
          };

          const right = rewrite(b.right as Expression, b.left as Expression);
          if (right) { changed = true; return updateNode(b, { right } as Partial<BinaryExpr>); }
          const left = rewrite(b.left as Expression, b.right as Expression);
          if (left) { changed = true; return updateNode(b, { left } as Partial<BinaryExpr>); }
          return undefined;
        },
      });

      const newBody = inner(node.body);
      if (!changed) return undefined;
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const addressRunBoundPlugin: TransformPlugin = {
  id: 'address-run-bound',
  name: 'Address-Run Loop Bound',
  description:
    "Respells a loop bound given as another global's address as a fixed distance from the global being walked, so the run survives relinking",
  version: '1.0.0',
  // Just after `global-address-literal` (68), which is what produces the `&sym`
  // form this reads, and well before the cast passes at 600+ that would wrap it.
  priority: 69,
  defaultEnabled: true,
  tags: ['core', 'correctness'],
  createTransformer: createAddressRunBoundTransformer,
};
