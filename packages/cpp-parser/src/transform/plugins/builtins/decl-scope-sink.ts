/**
 * Declaration Scope Sink Plugin
 *
 * Moves a declaration into the single child scope that references it.
 * For example, if a variable is declared at function top but only used
 * inside one branch of an if-statement, move the declaration there.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, DeclStmt, VariableDecl, Identifier,
  IfStmt, ForStmt, WhileStmt, DoWhileStmt,
} from '../../../ast/nodes.js';
import { findIdentifiers } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface DeclScopeSinkOptions extends PluginOptions {}

/** Ghidra's name for a frame address that owns no variable. */
const STACK_SLOT_NAME_RE = /^stack0x[0-9a-fA-F]+$/;

/**
 * Does this block still hold an unresolved `stack0xNNNN` frame address?
 *
 * `stack-frame-address` runs at priority 520, long after this pass, and
 * rewrites each of those into `&<local> ± k` — a BRAND NEW reference to a local
 * that may by then have been sunk into some inner scope, hundreds of lines
 * away. Nothing re-hoists it, so the emitted body names an out-of-scope
 * variable. While any such residue is present, nothing in the block may move.
 *
 * Declining to sink is always safe: a declaration left at function scope is
 * valid C++ wherever a sunk one would have been.
 *
 * Memoised per node. The visitor asks this of every compound it walks, and the
 * nested compounds of one function body overlap almost entirely; answering each
 * node once turns a quadratic re-scan of every enclosing block into one pass.
 */
const stackSlotResidue = new WeakMap<ASTNode, boolean>();

function hasUnresolvedStackSlot(node: ASTNode): boolean {
  const cached = stackSlotResidue.get(node);
  if (cached !== undefined) return cached;

  let found = node.kind === NodeKind.Identifier
    && STACK_SLOT_NAME_RE.test((node as Identifier).name);
  if (!found) {
    for (const key of Object.keys(node as object)) {
      if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia') continue;
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (isNode(c) && hasUnresolvedStackSlot(c)) { found = true; break; }
        }
      } else if (isNode(child) && hasUnresolvedStackSlot(child)) {
        found = true;
      }
      if (found) break;
    }
  }
  stackSlotResidue.set(node, found);
  return found;
}

function isNode(value: unknown): value is ASTNode {
  return typeof value === 'object' && value !== null
    && typeof (value as { kind?: unknown }).kind === 'string';
}

function createDeclScopeSinkTransformer(_options: DeclScopeSinkOptions = {}): Transformer {
  return createTransformer({
    visitCompoundStmt(node: CompoundStmt): ASTNode | undefined {
      if (hasUnresolvedStackSlot(node)) return undefined;
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
        }
        // NOT a switch. A switch body's statements begin at the first `case`
        // label, so a declaration prepended there is unreachable AND crosses
        // every label — `jump to case label` on each one. Leaving it where it
        // is keeps it before the switch, which is where it has to be.

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
