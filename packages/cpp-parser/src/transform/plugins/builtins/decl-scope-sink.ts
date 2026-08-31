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
  Expression, ExprStmt, ReturnStmt, ParenExpr,
  AssignExpr, UnaryExpr, PostfixExpr, MemberExpr,
} from '../../../ast/nodes.js';
import { findIdentifiers, getChildren } from '../../../ast/visitor.js';
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

// ============================================
// LOOP BACK-EDGE LIVENESS
// ============================================

/**
 * How a region of code first touches a variable, along EVERY path through it.
 *
 * - `overwrites` - every path assigns the whole variable before reading it, so
 *   nothing that reaches this region can be observed.
 * - `observes` - some path may read the incoming value first. Also the answer
 *   whenever the shape is beyond this analysis: unproven is treated as unsafe.
 * - `none` - no path touches the variable at all.
 */
type FirstTouch = 'none' | 'overwrites' | 'observes';

/** Strip parentheses and casts down to the expression they wrap. */
function unwrap(expr: ASTNode): ASTNode {
  let cur = expr;
  for (;;) {
    if (cur.kind === NodeKind.ParenExpr) { cur = (cur as ParenExpr).expression; continue; }
    if (cur.kind === NodeKind.CStyleCastExpr || cur.kind === NodeKind.StaticCastExpr
      || cur.kind === NodeKind.ReinterpretCastExpr || cur.kind === NodeKind.ConstCastExpr) {
      cur = (cur as unknown as { expression: Expression }).expression;
      continue;
    }
    return cur;
  }
}

/** Is `expr` the bare variable itself, so that assigning it replaces the whole value? */
function isWholeVarRef(expr: ASTNode, varName: string): boolean {
  const inner = unwrap(expr);
  return inner.kind === NodeKind.Identifier && (inner as Identifier).name === varName;
}

/**
 * Does anything in `node` write `varName` itself?
 *
 * `*p = x` and `p[i] = x` write through the variable, not to it, and do not
 * count. `&p` does count: whatever receives the address may store through it.
 */
function writesVar(node: ASTNode, varName: string): boolean {
  if (node.kind === NodeKind.AssignExpr && isWholeVarRef((node as AssignExpr).left, varName)) return true;
  if ((node.kind === NodeKind.UnaryExpr || node.kind === NodeKind.PostfixExpr)) {
    const un = node as UnaryExpr | PostfixExpr;
    if ((un.operator === '++' || un.operator === '--' || un.operator === '&')
      && isWholeVarRef(un.operand, varName)) return true;
  }
  return getChildren(node).some(child => writesVar(child, varName));
}

/** First touch of `varName` in `expr`, in evaluation order. */
function firstTouchInExpr(expr: ASTNode, varName: string): FirstTouch {
  switch (expr.kind) {
    case NodeKind.Identifier:
      return (expr as Identifier).name === varName ? 'observes' : 'none';

    case NodeKind.MemberExpr:
      // `x->varName` selects a field; only the object position is a use.
      return firstTouchInExpr((expr as MemberExpr).object, varName);

    case NodeKind.AssignExpr: {
      const assign = expr as AssignExpr;
      // The right-hand side counts first: `p = p + 1` reads before it writes.
      // C++ leaves the order of the two operands unspecified before C++17, so
      // any read on either side is taken as happening first.
      const rhs = firstTouchInExpr(assign.right, varName);
      if (rhs !== 'none') return rhs;
      if (isWholeVarRef(assign.left, varName)) {
        return assign.operator === '=' ? 'overwrites' : 'observes';
      }
      return firstTouchInExpr(assign.left, varName);
    }

    case NodeKind.UnaryExpr:
    case NodeKind.PostfixExpr: {
      const un = expr as UnaryExpr | PostfixExpr;
      if ((un.operator === '++' || un.operator === '--' || un.operator === '&')
        && isWholeVarRef(un.operand, varName)) return 'observes';
      return firstTouchInExpr(un.operand, varName);
    }

    default: {
      const children = getChildren(expr);
      // A node kind `getChildren` does not descend into is a blind spot; if the
      // name is anywhere under it, assume the worst.
      if (children.length === 0) {
        return findIdentifiers(expr, varName).length > 0 ? 'observes' : 'none';
      }
      for (const child of children) {
        const touch = firstTouchInExpr(child, varName);
        if (touch !== 'none') return touch;
      }
      return 'none';
    }
  }
}

/** Merge the two arms of a branch. Only an overwrite on both arms is an overwrite. */
function mergeBranches(a: FirstTouch, b: FirstTouch): FirstTouch {
  if (a === 'none' && b === 'none') return 'none';
  if (a === 'overwrites' && b === 'overwrites') return 'overwrites';
  // One arm writes and the other does not: a later read may still see the
  // incoming value.
  return 'observes';
}

function firstTouchInStmts(stmts: readonly ASTNode[], varName: string): FirstTouch {
  for (const stmt of stmts) {
    const touch = firstTouchInStmt(stmt, varName);
    if (touch !== 'none') return touch;
  }
  return 'none';
}

function firstTouchInStmt(stmt: ASTNode, varName: string): FirstTouch {
  switch (stmt.kind) {
    case NodeKind.CompoundStmt:
      return firstTouchInStmts((stmt as CompoundStmt).statements, varName);

    case NodeKind.ExprStmt:
      return firstTouchInExpr((stmt as ExprStmt).expression, varName);

    case NodeKind.DeclStmt: {
      for (const decl of (stmt as DeclStmt).declarations) {
        if (decl.kind !== NodeKind.VariableDecl) {
          if (findIdentifiers(decl, varName).length > 0) return 'observes';
          continue;
        }
        const varDecl = decl as VariableDecl;
        // An inner declaration of the same name shadows it; the reference
        // counting that got us here no longer describes this body.
        if (varDecl.name.name === varName) return 'observes';
        if (varDecl.initializer) {
          const touch = firstTouchInExpr(varDecl.initializer, varName);
          if (touch !== 'none') return touch;
        }
      }
      return 'none';
    }

    case NodeKind.IfStmt: {
      const ifStmt = stmt as IfStmt;
      const cond = firstTouchInExpr(ifStmt.condition, varName);
      if (cond !== 'none') return cond;
      const thenTouch = firstTouchInStmt(ifStmt.thenBranch, varName);
      const elseTouch = ifStmt.elseBranch ? firstTouchInStmt(ifStmt.elseBranch, varName) : 'none';
      return mergeBranches(thenTouch, elseTouch);
    }

    case NodeKind.ReturnStmt: {
      const value = (stmt as ReturnStmt).value;
      return value ? firstTouchInExpr(value, varName) : 'none';
    }

    // A nested loop, a switch, a try or a label is a control-flow shape this
    // analysis does not model. Any mention of the variable inside one is taken
    // as a possible read of the incoming value.
    default:
      return findIdentifiers(stmt, varName).length > 0 ? 'observes' : 'none';
  }
}

/** Does the body contain a jump that this straight-line reasoning cannot follow? */
function hasUnstructuredJump(node: ASTNode): boolean {
  if (node.kind === NodeKind.GotoStmt || node.kind === NodeKind.LabelStmt) return true;
  return getChildren(node).some(hasUnstructuredJump);
}

/**
 * Is `initializer` safe to evaluate once per iteration instead of once?
 *
 * Two ways it is not: it has a side effect of its own (a call, an assignment,
 * an increment), or it reads something the body then changes, which would make
 * later iterations start from a different value. An initialiser that only reads
 * memory is taken as invariant - nothing in the AST can prove otherwise.
 */
function initializerSurvivesReevaluation(initializer: ASTNode, body: ASTNode): boolean {
  const hasSideEffect = (node: ASTNode): boolean => {
    if (node.kind === NodeKind.CallExpr || node.kind === NodeKind.AssignExpr) return true;
    if (node.kind === NodeKind.UnaryExpr || node.kind === NodeKind.PostfixExpr) {
      const op = (node as UnaryExpr | PostfixExpr).operator;
      if (op === '++' || op === '--') return true;
    }
    return getChildren(node).some(hasSideEffect);
  };
  if (hasSideEffect(initializer)) return false;

  const names = new Set<string>();
  const collect = (node: ASTNode): void => {
    if (node.kind === NodeKind.Identifier) { names.add((node as Identifier).name); return; }
    if (node.kind === NodeKind.MemberExpr) { collect((node as MemberExpr).object); return; }
    for (const child of getChildren(node)) collect(child);
  };
  collect(initializer);
  for (const name of names) {
    if (writesVar(body, name)) return false;
  }
  return true;
}

/**
 * May a declaration move into this loop body?
 *
 * Only if the variable is dead at the back-edge: no iteration can observe a
 * value a previous one left behind. `lpCriticalSection = DebugMemoryCriticalSection;`
 * before a `do { InitializeCriticalSection(lpCriticalSection); lpCriticalSection++; }`
 * is the shape that must not move - sunk, the cursor resets to the array base
 * every iteration and only element zero is ever initialised.
 */
function loopBodyAcceptsDecl(
  body: CompoundStmt,
  varName: string,
  initializer: ASTNode | null,
): boolean {
  if (initializer && !initializerSurvivesReevaluation(initializer, body)) return false;

  // Nothing writes it, so every iteration sees the same value it does today.
  if (!writesVar(body, varName)) return true;

  if (hasUnstructuredJump(body)) return false;
  return firstTouchInStmts(body.statements, varName) === 'overwrites';
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

        // A loop has a back-edge, so the declaration may only move in if no
        // iteration can observe what the previous one left in the variable.
        if (!loopBodyAcceptsDecl(bodyCompound, varName, varDecl.initializer)) continue;

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
