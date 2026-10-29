/**
 * Compare Signedness Plugin
 *
 * `compare-form` writes `X == 0` as `X <= 0` and `X != 0` as `X > 0` where the instructions
 * compare unsigned (`TEST r,r; JBE`), and casts X when its declared type is not unsigned.
 * Both forms equal the original only while X stays unsigned, and the passes between may give
 * X its final type (a register local folded onto its parameter, a global's real type). This
 * pass reads the tagged comparisons again with the final types and casts X to the unsigned
 * type of the compare's width wherever it no longer is unsigned. A constant that crossed zero
 * on a signed compare (`n >= 0` from `-1 < n`) is kept signed the same way.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, BinaryExpr, FunctionDecl } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { createExprShape } from './expr-shape.js';
import type { TypedefResolver } from './call-arg-cast.js';
import { localTypesOf, operandSignedness, compareCast } from './compare-form.js';

export interface CompareSignednessOptions extends PluginOptions {
  enumTypes?: string[];
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
}

export function createCompareSignednessTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as CompareSignednessOptions;
  const enumTypes = new Set(o.enumTypes ?? []);
  const typedefTargets = o.typedefTargets ?? {};
  // An enum is not unsigned whatever it is spelled with.
  const resolve: TypedefResolver = name => (enumTypes.has(name) ? undefined : typedefTargets[name]);

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      const shapeOf = createExprShape(localTypesOf(node), {
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });
      let changed = false;
      const inner = createTransformer({
        visitBinaryExpr(be: BinaryExpr): ASTNode | undefined {
          const unsignedWidth = be.ghidraInfo?.unsignedCompareWidth;
          const signedWidth = be.ghidraInfo?.signedCompareWidth;
          if (unsignedWidth) {
            const s = operandSignedness(be.left, shapeOf);
            if (s === 'unsigned' || s === 'pointer') return undefined;
            changed = true;
            return updateNode(be, { left: compareCast(be.left, unsignedWidth) } as Partial<BinaryExpr>);
          }
          if (signedWidth && operandSignedness(be.left, shapeOf) === 'unsigned') {
            changed = true;
            return updateNode(be, { left: compareCast(be.left, signedWidth, true) } as Partial<BinaryExpr>);
          }
          return undefined;
        },
      });
      const body = inner(node.body);
      return changed ? updateNode(node, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const compareSignednessPlugin: TransformPlugin = createPlugin(
  'compare-signedness',
  'Compare Signedness',
  'A comparison compare-form made unsigned stays unsigned under the final types',
  (options?: PluginOptions) => createCompareSignednessTransformer(options),
  {
    priority: 619, // after unsigned-range-compare (617): needs the final local and global types
    defaultEnabled: true,
    tags: ['correctness'],
    version: '1.0.0',
  },
);
