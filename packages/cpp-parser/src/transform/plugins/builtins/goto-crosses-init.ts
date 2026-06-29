/**
 * Goto Crosses-Initialization Fixup Plugin
 *
 * Ghidra-decompiled functions use `goto` heavily. When a `goto` jumps forward
 * over a local that has an initializer, C++ rejects it:
 *
 *   goto L;                         // jump
 *   int n = pUnit->nClassId;        // <-- "crosses initialization of 'int n'"
 *   ...
 *   L: ...
 *
 * For a scalar / pointer / trivial type a bare declaration (no initializer) is
 * legal to jump over, so we SPLIT the crossed declaration in place:
 *
 *   int n;                          // bare decl — legal to cross
 *   n = pUnit->nClassId;            // assignment stays at the original spot
 *
 * Semantics are preserved (the assignment keeps its original position, so no
 * RHS is hoisted above a guard). Runs LATE (after decl-init-merge, which would
 * otherwise re-merge the split back together).
 *
 * Scope: only declarations that appear before a goto-targeted label in the same
 * block are split, and only when the split is sound — initialized, non-array,
 * non-reference, non-const, non-static/extern, scalar-style initializer.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, CompoundStmt, DeclStmt, VariableDecl, LabelStmt,
  GotoStmt, Statement, Expression, TypeNode,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Stmt, Expr } from '../../../ast/factory.js';
import type { TransformPlugin } from '../types.js';

/** A bare declaration of this type is legal to jump over (so it can be split). */
function isSplittableType(t: TypeNode): boolean {
  // Arrays can't be assigned (`a = {..}` is ill-formed); references must init.
  if (t.kind === NodeKind.ArrayType || t.kind === NodeKind.ReferenceType) return false;
  return true;
}

function isConst(vd: VariableDecl): boolean {
  if (vd.specifiers.some(s => (s as string) === 'const')) return true;
  const t = vd.type as { qualifiers?: string[]; isConst?: boolean };
  return !!t.isConst || (Array.isArray(t.qualifiers) && t.qualifiers.includes('const'));
}

function createGotoCrossesInitTransformer(): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;

      const gotoTargets = new Set<string>();
      for (const g of findNodesByKind(node.body, NodeKind.GotoStmt)) {
        gotoTargets.add((g as GotoStmt).label.name);
      }
      if (gotoTargets.size === 0) return undefined;

      let changed = false;
      const inner = createTransformer({
        visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
          const stmts = block.statements;
          // Last goto-targeted label in this block: any initialized decl before
          // it may be jumped over.
          let lastTargetIdx = -1;
          for (let i = 0; i < stmts.length; i++) {
            const s = stmts[i];
            if (s.kind === NodeKind.LabelStmt && gotoTargets.has((s as LabelStmt).label.name)) {
              lastTargetIdx = i;
            }
          }
          if (lastTargetIdx < 0) return undefined;

          const out: Statement[] = [];
          let localChanged = false;
          for (let i = 0; i < stmts.length; i++) {
            const s = stmts[i];
            if (i < lastTargetIdx && s.kind === NodeKind.DeclStmt) {
              const ds = s as DeclStmt;
              const bareDecls: typeof ds.declarations = [];
              const assigns: Statement[] = [];
              let splitAny = false;
              for (const d of ds.declarations) {
                if (d.kind === NodeKind.VariableDecl) {
                  const vd = d as VariableDecl;
                  const init = vd.initializer;
                  if (init && init.kind !== NodeKind.InitListExpr
                      && isSplittableType(vd.type) && !isConst(vd)
                      && !vd.specifiers.some(sp => (sp as string) === 'static' || (sp as string) === 'extern')) {
                    bareDecls.push(updateNode(vd, { initializer: null } as Partial<VariableDecl>));
                    assigns.push(Stmt.expr(Expr.assign(Expr.identifier(vd.name.name), init as Expression)));
                    splitAny = true;
                    continue;
                  }
                }
                bareDecls.push(d);
              }
              if (splitAny) {
                out.push(updateNode(ds, { declarations: bareDecls } as Partial<DeclStmt>));
                out.push(...assigns);
                localChanged = true;
                continue;
              }
            }
            out.push(s);
          }
          if (!localChanged) return undefined;
          changed = true;
          return updateNode(block, { statements: out } as Partial<CompoundStmt>);
        },
      });

      const newBody = inner(node.body);
      if (!changed) return undefined;
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const gotoCrossesInitPlugin: TransformPlugin = {
  id: 'goto-crosses-init',
  name: 'Goto Crosses-Initialization Fixup',
  description:
    'Splits `T x = e;` into `T x; x = e;` for locals a forward goto jumps over (makes the jump well-formed)',
  version: '1.0.0',
  defaultEnabled: true,
  // Very late: after decl-init-merge (60) and the cast passes (~600), so the
  // split is the final form and nothing re-merges it.
  priority: 700,
  tags: ['cleanup', 'goto'],
  createTransformer: createGotoCrossesInitTransformer,
};
