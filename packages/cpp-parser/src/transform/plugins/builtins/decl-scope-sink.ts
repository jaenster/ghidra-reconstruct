/**
 * Declaration Scope Sink Plugin
 *
 * Moves a declaration into the single child scope that references it.
 * For example, if a variable is declared at function top but only used
 * inside one branch of an if-statement, move the declaration there.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, DeclStmt, VariableDecl,
  IfStmt, ForStmt, WhileStmt, DoWhileStmt, SwitchStmt,
} from '../../../ast/nodes.js';
import { findIdentifiers } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface DeclScopeSinkOptions extends PluginOptions {}

function createDeclScopeSinkTransformer(_options: DeclScopeSinkOptions = {}): Transformer {
  return createTransformer({
    visitCompoundStmt(node: CompoundStmt): ASTNode | undefined {
      const stmts = node.statements;

      for (let i = 0; i < stmts.length; i++) {
        const stmt = stmts[i];
        if (stmt.kind !== NodeKind.DeclStmt) continue;

        const declStmt = stmt as DeclStmt;
        if (declStmt.declarations.length !== 1) continue;

        const decl = declStmt.declarations[0];
        if (decl.kind !== NodeKind.VariableDecl) continue;

        const varDecl = decl as VariableDecl;
        if (varDecl.specifiers.some(s => s === 'static' || s === 'extern')) continue;

        const varName = varDecl.name.name;

        // Count which sibling statements reference the variable
        let refCount = 0;
        let refIndex = -1;
        for (let j = 0; j < stmts.length; j++) {
          if (j === i) continue; // skip the decl itself
          if (findIdentifiers(stmts[j], varName).length > 0) {
            refCount++;
            refIndex = j;
            if (refCount > 1) break;
          }
        }

        if (refCount !== 1) continue;

        const target = stmts[refIndex];

        // Try to sink into IfStmt branch
        if (target.kind === NodeKind.IfStmt) {
          const ifStmt = target as IfStmt;

          // Variable must NOT appear in the condition
          if (findIdentifiers(ifStmt.condition, varName).length > 0) continue;

          // Determine which branch uses it
          const inThen = ifStmt.thenBranch ? findIdentifiers(ifStmt.thenBranch, varName).length > 0 : false;
          const inElse = ifStmt.elseBranch ? findIdentifiers(ifStmt.elseBranch, varName).length > 0 : false;

          // Must be in exactly one branch
          if (inThen === inElse) continue; // both or neither

          const targetBranch = inThen ? ifStmt.thenBranch : ifStmt.elseBranch;
          if (!targetBranch || targetBranch.kind !== NodeKind.CompoundStmt) continue;

          const branchCompound = targetBranch as CompoundStmt;

          // Prepend declaration into the branch
          const newBranch = updateNode(branchCompound, {
            statements: [declStmt, ...branchCompound.statements],
          } as Partial<CompoundStmt>);

          // Update the if statement
          const ifUpdates: Partial<IfStmt> = {};
          if (inThen) {
            ifUpdates.thenBranch = newBranch;
          } else {
            ifUpdates.elseBranch = newBranch;
          }
          const newTarget = updateNode(ifStmt, ifUpdates);

          const newStmts = stmts.filter((_, idx) => idx !== i);
          const newRefIndex = refIndex > i ? refIndex - 1 : refIndex;
          newStmts[newRefIndex] = newTarget;

          return updateNode(node, { statements: newStmts } as Partial<CompoundStmt>);
        }

        // Try to sink into loop/switch body
        let bodyNode: ASTNode | null = null;
        let conditionParts: ASTNode[] = [];

        if (target.kind === NodeKind.ForStmt) {
          const forStmt = target as ForStmt;
          conditionParts = [forStmt.init, forStmt.condition, forStmt.increment].filter(Boolean) as ASTNode[];
          bodyNode = forStmt.body;
        } else if (target.kind === NodeKind.WhileStmt) {
          const whileStmt = target as WhileStmt;
          conditionParts = [whileStmt.condition];
          bodyNode = whileStmt.body;
        } else if (target.kind === NodeKind.DoWhileStmt) {
          const doWhileStmt = target as DoWhileStmt;
          conditionParts = [doWhileStmt.condition];
          bodyNode = doWhileStmt.body;
        } else if (target.kind === NodeKind.SwitchStmt) {
          const switchStmt = target as SwitchStmt;
          conditionParts = [switchStmt.condition];
          if (switchStmt.init) conditionParts.push(switchStmt.init);
          bodyNode = switchStmt.body;
        }

        if (!bodyNode) continue;

        // Variable must NOT appear in condition/init/increment
        if (conditionParts.some(part => findIdentifiers(part, varName).length > 0)) continue;

        if (bodyNode.kind !== NodeKind.CompoundStmt) continue;
        const bodyCompound = bodyNode as CompoundStmt;

        // Prepend declaration into the body
        const newBody = updateNode(bodyCompound, {
          statements: [declStmt, ...bodyCompound.statements],
        } as Partial<CompoundStmt>);

        // Update the target statement with new body
        const newTarget = updateNode(target, { body: newBody } as any);

        const newStmts = stmts.filter((_, idx) => idx !== i);
        const newRefIndex = refIndex > i ? refIndex - 1 : refIndex;
        newStmts[newRefIndex] = newTarget;

        return updateNode(node, { statements: newStmts } as Partial<CompoundStmt>);
      }

      return undefined;
    },
  });
}

export const declScopeSinkPlugin: TransformPlugin = {
  id: 'decl-scope-sink',
  name: 'Declaration Scope Sink',
  description: 'Moves declarations into the single scope that uses them',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 62,
  tags: ['cleanup', 'declaration'],
  createTransformer: createDeclScopeSinkTransformer,
};
