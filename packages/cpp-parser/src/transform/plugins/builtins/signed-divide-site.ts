/**
 * The `/` and `%` operations the original computes with a signed divide (IDIV).
 *
 * The decompiler prints a division of a zero-extended byte or word as unsigned whichever way
 * the original divided it: `(uint)pSystemTime->wYear % 100`. Compiled as printed, VC8
 * divides unsigned (`xor edx, edx; div`); the original's `cdq; idiv` (OpenLogFileWithTimestamp
 * 0040ebd0) is the division of the promoted int the source wrote. Which operator tokens are an
 * IDIV is read off the listing (reconstruct's extract/signed-divides.ts), so two steps:
 *
 *   signed-divide-site  early, on the body as the decompiler printed it: ties each fact to its
 *                       operation by the operator's position in text order and tags it
 *   arith-idioms        on the final types: `(uint32_t)x / K` or `% K`, tagged, x an unsigned
 *                       byte or word and K a positive int constant, is `(uint32_t)(x / K)`
 *
 * A fact is tied only where the body prints exactly as many operations of that spelling as the
 * decompile had tokens of it, and the operation's dividend is a cast.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, BinaryExpr, FunctionDecl } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { unwrapParens } from './call-arg-cast.js';

/** One operator token whose instruction is an IDIV (extract/signed-divides.ts). */
export interface SignedDivideOperatorSite {
  operator: string;
  ord: number;
}

export interface SignedDivideSiteOptions extends PluginOptions {
  /** Per operator spelling, how many tokens of it the decompile printed. */
  counts?: Record<string, number>;
  sites?: SignedDivideOperatorSite[];
  onCensus?: (c: { tagged: number; untied: number }) => void;
}

const SKIP_KEYS = new Set(['location', 'leadingTrivia', 'trailingTrivia', 'parent', 'ghidraInfo']);

function children(n: ASTNode): ASTNode[] {
  const out: ASTNode[] = [];
  for (const key of Object.keys(n)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = (n as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && typeof (x as ASTNode).kind === 'string') out.push(x as ASTNode); }
    else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') out.push(v as ASTNode);
  }
  return out;
}

export function createSignedDivideSiteTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as SignedDivideSiteOptions;
  const sites = o.sites ?? [];
  const counts = o.counts ?? {};
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body || sites.length === 0) return undefined;
      // Each binary operation in text order: the operator sits just before its right operand.
      const byOperator = new Map<string, BinaryExpr[]>();
      const find = (n: ASTNode) => {
        if (n.kind === NodeKind.BinaryExpr) {
          const b = n as BinaryExpr;
          byOperator.set(b.operator, [...(byOperator.get(b.operator) ?? []), b]);
        }
        for (const c of children(n)) find(c);
      };
      find(node.body);
      // By location: the transformer below copies every node it passes, a copy keeps its location.
      const tagged = new Set<unknown>();
      for (const s of sites) {
        const list = byOperator.get(s.operator) ?? [];
        if (list.length !== counts[s.operator]) continue;
        if (!list.every(b => b.right.location?.start?.offset !== undefined)) continue;
        const sorted = [...list].sort((a, b) => a.right.location!.start!.offset! - b.right.location!.start!.offset!);
        const be = sorted[s.ord];
        if (be && unwrapParens(be.left).kind === NodeKind.CStyleCastExpr && be.location) tagged.add(be.location);
      }
      o.onCensus?.({ tagged: tagged.size, untied: sites.length - tagged.size });
      if (!tagged.size) return undefined;
      const t = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.BinaryExpr || !n.location || !tagged.has(n.location)) return undefined;
          return updateNode(n, { ghidraInfo: { ...(n.ghidraInfo ?? {}), signedDivide: true } } as Partial<ASTNode>);
        },
      });
      return updateNode(node, { body: t(node.body) } as Partial<FunctionDecl>);
    },
  });
}

export const signedDivideSitePlugin: TransformPlugin = createPlugin(
  'signed-divide-site',
  'Signed Divide Site',
  'Tags each division or remainder of a cast dividend that the original computes with IDIV',
  (options?: PluginOptions) => createSignedDivideSiteTransformer(options),
  {
    priority: 3, // before any pass reshapes the printed operations the facts are tied to
    defaultEnabled: true,
    tags: ['correctness'],
    version: '1.0.0',
  },
);
