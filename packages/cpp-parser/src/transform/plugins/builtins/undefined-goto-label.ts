/**
 * Undefined Goto-Label Synthesis Plugin
 *
 * Ghidra's control-flow recovery sometimes emits a `goto LAB_xxxx;` whose target
 * label was never recovered (it sat in a dropped/unreachable block — often a
 * fault/error exit like `nLine = 0x63e; goto LAB_00677aa7;`). C++ then rejects
 * "label used but not defined". Define each such missing Ghidra label as an empty
 * statement at the end of the function body, so the goto compiles (jumps ≈ the
 * function's end / return) — a sound approximation for these dead-end exits.
 *
 * Operates on the AST: collects GotoStmt targets and LabelStmt definitions
 * structurally (no text scanning, so a `goto X` inside an expression or a
 * `X:` followed by a statement are handled correctly), and appends synthesized
 * LabelStmt(NullStmt) nodes. Only Ghidra-generated label names are touched.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, FunctionDecl, CompoundStmt, GotoStmt, LabelStmt } from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface UndefinedGotoLabelOptions extends PluginOptions {}

const isGhidraLabel = (n: string): boolean => /^(LAB|switchD|caseD|joined|code|UNRECOVERED)_/.test(n);

function createUndefinedGotoLabelTransformer(_options: UndefinedGotoLabelOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body || node.body.statements.length === 0) return undefined;

      const defined = new Set<string>();
      for (const l of findNodesByKind(node.body, NodeKind.LabelStmt)) {
        defined.add((l as LabelStmt).label.name);
      }
      const missing = new Set<string>();
      for (const g of findNodesByKind(node.body, NodeKind.GotoStmt)) {
        const name = (g as GotoStmt).label.name;
        if (isGhidraLabel(name) && !defined.has(name)) missing.add(name);
      }
      if (missing.size === 0) return undefined;

      const stubs = [...missing].map(name => Stmt.label(name));
      const newBody = updateNode(node.body, {
        statements: [...node.body.statements, ...stubs],
      } as Partial<CompoundStmt>);
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const undefinedGotoLabelPlugin: TransformPlugin = {
  id: 'undefined-goto-label',
  name: 'Undefined Goto-Label Synthesis',
  description: 'Defines Ghidra goto targets (LAB_/switchD_) that were never emitted as empty statements at function end',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 95,
  tags: ['cleanup', 'control-flow'],
  createTransformer: createUndefinedGotoLabelTransformer,
};
