/**
 * The binary operations whose 32-bit result the decompiler zero-extended to 64 bits.
 *
 * Ghidra prints an INT_ZEXT as a cast where its own type for the input is unsigned:
 * `(ulonglong)(nRadius * 2 + 1)`. That type belongs to a temporary the text never declares;
 * in C the operation has its operands' type, so with a signed `nRadius` the cast sign-extends
 * where the p-code zero-extends (MISSILE_CreateRandomSubInRadius @004cea00, D2Win Draw
 * @005005b0). Which operator tokens fed a ZEXT is read off the p-code (reconstruct's
 * extract/zext-sites.ts), so two steps:
 *
 *   zext-site     early, on the body as the decompiler printed it: ties each fact to its
 *                 binary operation by the operator's position in text order and tags it
 *   arith-idioms  on the final types: a 64-bit unsigned cast of a tagged operation whose
 *                 type is not already an unsigned dword is written `(T)(uint32_t)(expr)`
 *
 * A fact is tied only where the body prints exactly as many binary operations of that
 * spelling as the decompile had tokens of it, and the operation is the operand of a cast.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, BinaryExpr, CStyleCastExpr, FunctionDecl } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { unwrapParens } from './call-arg-cast.js';

/** One operator token whose result the decompiler zero-extended (extract/zext-sites.ts). */
export interface ZextOperatorSite {
  operator: string;
  ord: number;
}

export interface ZextSiteOptions extends PluginOptions {
  /** Per operator spelling, how many tokens of it the decompile printed. */
  counts?: Record<string, number>;
  sites?: ZextOperatorSite[];
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

export function createZextSiteTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as ZextSiteOptions;
  const sites = o.sites ?? [];
  const counts = o.counts ?? {};
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body || sites.length === 0) return undefined;
      // Each binary operation in text order: the operator sits just before its right operand.
      const byOperator = new Map<string, BinaryExpr[]>();
      const castOperands = new Set<ASTNode>();
      const find = (n: ASTNode) => {
        if (n.kind === NodeKind.BinaryExpr) {
          const b = n as BinaryExpr;
          byOperator.set(b.operator, [...(byOperator.get(b.operator) ?? []), b]);
        }
        if (n.kind === NodeKind.CStyleCastExpr) castOperands.add(unwrapParens((n as CStyleCastExpr).expression));
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
        if (be && castOperands.has(be) && be.location) tagged.add(be.location);
      }
      o.onCensus?.({ tagged: tagged.size, untied: sites.length - tagged.size });
      if (!tagged.size) return undefined;
      const t = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.BinaryExpr || !n.location || !tagged.has(n.location)) return undefined;
          return updateNode(n, { ghidraInfo: { ...(n.ghidraInfo ?? {}), zextOperand: true } } as Partial<ASTNode>);
        },
      });
      return updateNode(node, { body: t(node.body) } as Partial<FunctionDecl>);
    },
  });
}

export const zextSitePlugin: TransformPlugin = createPlugin(
  'zext-site',
  'Zero Extension Site',
  'Tags each binary operation whose 32-bit result the decompiler zero-extended to 64 bits',
  (options?: PluginOptions) => createZextSiteTransformer(options),
  {
    priority: 3, // before any pass reshapes the printed operations the facts are tied to
    defaultEnabled: true,
    tags: ['correctness'],
    version: '1.0.0',
  },
);
