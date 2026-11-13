/** Remove ROUND only at a native-proven truncating FISTP, under its signed integer cast. */
import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, CallExpr, CStyleCastExpr, FunctionDecl, TypeNode } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { createPlugin } from '../registry.js';
import type { PluginOptions, TransformPlugin } from '../types.js';
import { unwrapParens } from './call-arg-cast.js';
import { emit } from '../../../emit/index.js';

export interface TruncatingRoundSiteOptions extends PluginOptions {
  count?: number;
  sites?: { ord: number; width: 4 | 8 }[];
}
const skip = new Set(['location', 'leadingTrivia', 'trailingTrivia', 'parent', 'ghidraInfo']);
function children(n: ASTNode): ASTNode[] {
  return Object.entries(n).filter(([key]) => !skip.has(key)).flatMap(([, value]) =>
    (Array.isArray(value) ? value : [value]).filter((v): v is ASTNode =>
      v !== null && typeof v === 'object' && typeof v.kind === 'string'));
}
function signedWidth(type: TypeNode): number {
  const name = emit(type).replace(/\s+/g, ' ').trim();
  // This early pass sees the decompiler's spellings; long is 32-bit on the target.
  if (/^(?:signed )?(?:int|long|long int|int32_t|__int32)$/.test(name)) return 4;
  if (/^(?:signed )?(?:longlong|long long|long long int|int64_t|__int64)$/.test(name)) return 8;
  return 0;
}
function isRound(n: ASTNode): n is CallExpr {
  return n.kind === NodeKind.CallExpr && (n as CallExpr).callee.kind === NodeKind.Identifier
    && ((n as CallExpr).callee as unknown as { name: string }).name === 'ROUND';
}

export function createTruncatingRoundSiteTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as TruncatingRoundSiteOptions;
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body || !o.sites?.length || !Number.isSafeInteger(o.count)) return undefined;
      const rounds: CallExpr[] = [];
      const casts = new Map<CallExpr, CStyleCastExpr>();
      const walk = (n: ASTNode) => {
        if (isRound(n)) rounds.push(n);
        if (n.kind === NodeKind.CStyleCastExpr) {
          const cast = n as CStyleCastExpr;
          const value = unwrapParens(cast.expression);
          if (isRound(value)) casts.set(value, cast);
        }
        for (const c of children(n)) walk(c);
      };
      walk(fn.body);
      if (rounds.length !== o.count || !rounds.every(r => r.location?.start?.offset !== undefined)) return undefined;
      rounds.sort((a, b) => a.location!.start!.offset! - b.location!.start!.offset!);
      const selected = new Set<unknown>();
      const seen = new Set<number>();
      for (const site of o.sites) {
        if (!Number.isSafeInteger(site.ord) || site.ord < 0 || site.ord >= rounds.length
            || seen.has(site.ord) || (site.width !== 4 && site.width !== 8)) return undefined;
        seen.add(site.ord);
        const round = rounds[site.ord], cast = casts.get(round);
        if (round.arguments.length === 1 && cast && signedWidth(cast.type) === site.width && cast.location)
          selected.add(cast.location);
      }
      if (!selected.size) return undefined;
      const replace = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.CStyleCastExpr) return undefined;
          const cast = n as CStyleCastExpr;
          if (!selected.has(cast.location)) return undefined;
          const round = unwrapParens(cast.expression);
          if (!isRound(round) || round.arguments.length !== 1) return undefined;
          return updateNode(cast, { expression: round.arguments[0] });
        },
      });
      return updateNode(fn, { body: replace(fn.body) } as Partial<FunctionDecl>);
    },
  });
}

export const truncatingRoundSitePlugin: TransformPlugin = createPlugin(
  'truncating-round-site', 'Truncating Round Site',
  'Preserves explicit native x87 truncation at integer conversions',
  createTruncatingRoundSiteTransformer,
  { priority: 3, defaultEnabled: true, tags: ['correctness'], version: '1.0.0' },
);
