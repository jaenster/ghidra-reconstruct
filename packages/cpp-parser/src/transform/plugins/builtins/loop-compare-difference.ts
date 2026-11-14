/**
 * Reuse the subtraction behind a comparison loop's sole exit and signed result.
 *
 *   while (true) { ...; if (a != b) break; ...; }
 *   return (unsigned)(a != b && -1 < a - b) * 2 - 1;
 *
 * becomes a fresh signed difference assigned just before the test, tested for
 * nonzero there and for positive in the result. Both operands are uniquely
 * declared, nonvolatile signed 32-bit scalars that never escape. The return is
 * immediately after the loop and contains no other reads of either operand.
 *
 * The only newly evaluated subtraction is on equal operands, where it is zero
 * and cannot overflow. On an unequal pair the original immediately breaks and
 * evaluates that same subtraction. This does not introduce an overflowing path.
 * A fresh variable leaves both operands unchanged on the loop's continuing path.
 */
import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, BoolLiteralExpr, CallExpr, CompoundStmt, Expression,
  FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, ParameterDecl, ReturnStmt,
  Statement, TypeNode, UnaryExpr, VariableDecl, WhileStmt,
} from '../../../ast/nodes.js';
import { Decl, Expr, Stmt, Type } from '../../../ast/factory.js';
import { findNodesByKind, traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode } from '../../transformer.js';
import type { TransformPlugin } from '../types.js';
import { isPure } from './pseudo-op-lower.js';

const SIGNED = new Set(['int', 'signed', 'signed int', 'int32_t']);
const unwrap = (e: Expression): Expression => {
  while (e.kind === NodeKind.ParenExpr) e = (e as { expression: Expression }).expression;
  return e;
};
const nameOf = (e: Expression): string | null => {
  const n = unwrap(e);
  return n.kind === NodeKind.Identifier ? (n as Identifier).name : null;
};
function mentions(root: ASTNode, name: string): number {
  let n = 0;
  for (const x of traverseAST(root)) if (x.kind === NodeKind.Identifier && (x as Identifier).name === name) n++;
  return n;
}
function minusOne(e: Expression): boolean {
  const n = unwrap(e);
  if (n.kind === NodeKind.IntegerLiteral) return (n as IntegerLiteralExpr).value === -1n && !(n as IntegerLiteralExpr).suffix;
  return n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '-'
    && unwrap((n as UnaryExpr).operand).kind === NodeKind.IntegerLiteral
    && (unwrap((n as UnaryExpr).operand) as IntegerLiteralExpr).value === 1n
    && !(unwrap((n as UnaryExpr).operand) as IntegerLiteralExpr).suffix;
}
function notEqual(e: Expression): [string, string] | null {
  const n = unwrap(e);
  if (n.kind !== NodeKind.BinaryExpr || (n as BinaryExpr).operator !== '!=') return null;
  const a = nameOf((n as BinaryExpr).left), b = nameOf((n as BinaryExpr).right);
  return a && b && a !== b ? [a, b] : null;
}
function resultPair(e: BinaryExpr): [string, string] | null {
  if (e.operator !== '&&') return null;
  const pair = notEqual(e.left), sign = unwrap(e.right);
  if (!pair || sign.kind !== NodeKind.BinaryExpr || (sign as BinaryExpr).operator !== '<'
    || !minusOne((sign as BinaryExpr).left)) return null;
  const diff = unwrap((sign as BinaryExpr).right);
  return diff.kind === NodeKind.BinaryExpr && (diff as BinaryExpr).operator === '-'
    && nameOf((diff as BinaryExpr).left) === pair[0] && nameOf((diff as BinaryExpr).right) === pair[1] ? pair : null;
}
function onlyBreak(s: Statement): boolean {
  return s.kind === NodeKind.BreakStmt || (s.kind === NodeKind.CompoundStmt
    && (s as CompoundStmt).statements.length === 1 && (s as CompoundStmt).statements[0].kind === NodeKind.BreakStmt);
}

/** Preserve the identities of nodes selected in this structural proof. */
function replaceNode(root: ASTNode, target: ASTNode, replacement: ASTNode): ASTNode {
  if (root === target) return replacement;
  for (const [key, value] of Object.entries(root)) {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const child = value[i];
        if (!child || typeof child !== 'object' || !('kind' in child)) continue;
        const changed = replaceNode(child as ASTNode, target, replacement);
        if (changed !== child) {
          const items = value.slice(); items[i] = changed;
          return { ...root, [key]: items } as ASTNode;
        }
      }
    } else if (value && typeof value === 'object' && 'kind' in value) {
      const changed = replaceNode(value as ASTNode, target, replacement);
      if (changed !== value) return { ...root, [key]: changed } as ASTNode;
    }
  }
  return root;
}

function rewrite(fn: FunctionDecl): CompoundStmt | null {
  if (!fn.body) return null;
  const nodes = [...traverseAST(fn.body)];
  if (nodes.some(n => [NodeKind.GotoStmt, NodeKind.LabelStmt, NodeKind.LambdaExpr, NodeKind.AsmDecl, NodeKind.NewExpr].includes(n.kind))) return null;
  const types = new Map<string, TypeNode>(), duplicates = new Set<string>();
  const add = (name: string, type: TypeNode) => {
    if (types.has(name)) duplicates.add(name);
    types.set(name, type);
  };
  for (const p of fn.parameters) {
    const param = p as ParameterDecl;
    if (param.name) add(param.name.name, param.type);
  }
  for (const n of nodes) if (n.kind === NodeKind.VariableDecl) {
    const v = n as VariableDecl;
    add(v.name.name, v.type);
    if (v.specifiers.length) duplicates.add(v.name.name);
  }
  const eligible = (name: string) => {
    const t = types.get(name);
    return !!t && !duplicates.has(name) && SIGNED.has(emit(t as never).trim().replace(/^const\s+/, ''))
      && !nodes.some(n => {
        if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&' && nameOf((n as UnaryExpr).operand) === name) return true;
        if (n.kind === NodeKind.CallExpr && (n as CallExpr).arguments.some(a => mentions(a, name))) return true;
        if (n.kind === NodeKind.InitListExpr && mentions(n, name)) return true;
        // Includes reference aliases and constructor/conversion initializers.
        if (n.kind === NodeKind.VariableDecl && (n as VariableDecl).initializer && mentions((n as VariableDecl).initializer!, name)) return true;
        return false;
      });
  };
  const used = new Set([...types.keys(), ...nodes.filter(n => n.kind === NodeKind.Identifier).map(n => (n as Identifier).name)]);
  for (const n of nodes) if (n.kind === NodeKind.CompoundStmt) {
    const block = n as CompoundStmt;
    for (let i = 0; i + 1 < block.statements.length; i++) {
      const loop = block.statements[i], after = block.statements[i + 1];
      if (loop.kind !== NodeKind.WhileStmt || after.kind !== NodeKind.ReturnStmt) continue;
      const w = loop as WhileStmt, ret = after as ReturnStmt, condition = unwrap(w.condition);
      if (condition.kind !== NodeKind.BoolLiteral || !(condition as BoolLiteralExpr).value
        || w.body.kind !== NodeKind.CompoundStmt || !ret.value || !isPure(ret.value)
        || findNodesByKind(ret.value, NodeKind.CallExpr).length
        || findNodesByKind(w.body, NodeKind.BreakStmt).length !== 1) continue;
      const matches = findNodesByKind(ret.value, NodeKind.BinaryExpr).filter(x => !!resultPair(x as BinaryExpr)) as BinaryExpr[];
      if (matches.length !== 1) continue;
      const target = matches[0], [a, b] = resultPair(target)!;
      if (!eligible(a) || !eligible(b) || mentions(ret.value, a) !== 2 || mentions(ret.value, b) !== 2) continue;
      const body = w.body as CompoundStmt;
      const at = body.statements.findIndex(s => {
        if (s.kind !== NodeKind.IfStmt) return false;
        const branch = s as IfStmt, pair = notEqual(branch.condition);
        return !branch.elseBranch && onlyBreak(branch.thenBranch) && !!pair
          && ((pair[0] === a && pair[1] === b) || (pair[0] === b && pair[1] === a));
      });
      if (at < 0) continue;
      let fresh = 'nComparison', ordinal = 2;
      while (used.has(fresh)) fresh = `nComparison${ordinal++}`;
      const branch = body.statements[at] as IfStmt;
      const difference = Stmt.expr(Expr.assign(Expr.identifier(fresh), Expr.binary(Expr.identifier(a), '-', Expr.identifier(b))));
      const test = updateNode(branch, { condition: Expr.binary(Expr.identifier(fresh), '!=', Expr.intLiteral(0)) });
      const newLoop = updateNode(w, { body: updateNode(body, { statements: [...body.statements.slice(0, at), difference, test, ...body.statements.slice(at + 1)] }) });
      const value = replaceNode(ret.value, target, Expr.binary(Expr.identifier(fresh), '>', Expr.intLiteral(0))) as Expression;
      const replacement = updateNode(block, { statements: [...block.statements.slice(0, i), Stmt.declStmt([Decl.variable(fresh, Type.int())]), newLoop, updateNode(ret, { value }), ...block.statements.slice(i + 2)] });
      return replaceNode(fn.body, block, replacement) as CompoundStmt;
    }
  }
  return null;
}

export const loopCompareDifferencePlugin: TransformPlugin = {
  id: 'loop-compare-difference', name: 'Loop Compare Difference', version: '0.1.0',
  description: 'Reuse the difference that decides a comparison loop exit',
  defaultEnabled: true, priority: 989.952,
  tags: ['fidelity', 'loops'],
  createTransformer: () => createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      let current = fn;
      const limit = fn.body ? findNodesByKind(fn.body, NodeKind.WhileStmt).length : 0;
      for (let i = 0; i < limit; i++) {
        const body = rewrite(current);
        if (!body) break;
        current = updateNode(current, { body });
      }
      return current !== fn ? current : undefined;
    },
  }),
};
