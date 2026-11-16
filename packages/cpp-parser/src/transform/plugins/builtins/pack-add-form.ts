import { NodeKind as K } from '../../../ast/kinds.js';
import type { BinaryExpr, Expression, FunctionDecl } from '../../../ast/nodes.js';
import { emit } from '../../../emit/index.js';
import type { SelectArgumentOptions } from './select-argument.js';
import { privateValueEnv, unparen, spelling } from './private-value-env.js';

/** Two explicitly truncated unsigned halves have no overlapping set bits or carry. */
export function packByAddition(fn: FunctionDecl, low: string, high: string, tables: SelectArgumentOptions): string | undefined {
  const env = privateValueEnv(fn, tables);
  if (!env) return 'packing needs unambiguous bindings and no local types or opaque syntax';
  const cast = (e: Expression, type: string): Expression | undefined => {
    e = unparen(e);
    if (e.kind !== K.CStyleCastExpr) return undefined;
    const raw = emit(e.type);
    if (env.counts.has(raw) || env.resolve(raw) !== type) return undefined;
    return unparen(e.expression);
  };
  const half = (e: Expression): Expression | undefined => {
    const wide = cast(e, 'unsigned int');
    return wide && cast(wide, 'unsigned short');
  };
  const sites: BinaryExpr[] = [];
  for (const n of env.all) {
    if (n.kind !== K.BinaryExpr) continue;
    const binary = n as BinaryExpr;
    if (binary.operator !== '|') continue;
    const upper = unparen(binary.left), lower = half(binary.right);
    if (upper.kind !== K.BinaryExpr || upper.operator !== '<<' || !lower) continue;
    const shift = unparen(upper.right), value = half(upper.left);
    if (shift.kind !== K.IntegerLiteral || shift.value !== 16n || shift.suffix || !value) continue;
    if (spelling(lower) !== low.replace(/\s+/g, '') || spelling(value) !== high.replace(/\s+/g, '')) continue;
    if (!env.integer(env.typeOf(lower)) || !env.integer(env.typeOf(value))) continue;
    sites.push(binary);
  }
  if (sites.length !== 1) return `packing needs one proven unsigned 16+16 site, found ${sites.length}`;
  sites[0].operator = '+';
  return undefined;
}
