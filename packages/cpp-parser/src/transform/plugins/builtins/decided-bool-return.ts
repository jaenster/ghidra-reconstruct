/**
 * A bool return whose value the guard before it has already decided.
 *
 * The decompiler prints every exit of a `bool` function that returns the truth of a BOOL as
 * `return v != 0;`. Once the guard `if (!v) { ... }` is made, its arm returns that test of a
 * value it has just found zero, and the return after a guard that leaves returns it of a
 * value found non-zero. Compiled as printed, VC8 tests the register again at each exit; the
 * original loads the constant (D2FILE_CreateProcess 00516d8b: `test eax, eax; jnz; xor al,
 * al; jmp` and `mov al, 1` after the two CloseHandle calls).
 *
 * In a function whose return type is `bool`, for a guard `if (!v)` or `if (v == 0)` with no
 * else, v a parameter or local whose address is never taken:
 *
 *   - the arm's last statement `return v != 0;` becomes `return false;`
 *   - when the arm ends in a return, the first `return v != 0;` among the statements that
 *     follow the guard in its block becomes `return true;`
 *
 * Only where nothing between the test and the return stores to v (an assignment, ++/--, a
 * declaration of the same name) and no label or case label sits between them, so the return
 * is reached only through the test. The wider form (any returned v the guard decided, as 0)
 * changes no code and is not made.
 *
 * Value-preserving: on the arm v is zero, after a guard that leaves it is not, and v is not
 * changed on the way, so `v != 0` is the constant written.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CompoundStmt, Expression, FunctionDecl, Identifier, IfStmt,
  MemberExpr, ParameterDecl, ParenExpr, PostfixExpr, ReturnStmt, Statement, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { Expr } from '../../../ast/factory.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface DecidedBoolReturnOptions extends PluginOptions {
  onSite?: (e: { variable: string; value: boolean }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function name(e: Expression | null | undefined): string | null {
  if (!e) return null;
  const u = unwrap(e);
  return u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
}

function isZero(e: Expression): boolean {
  const u = unwrap(e);
  return u.kind === NodeKind.IntegerLiteral && (u as unknown as { value: bigint }).value === 0n;
}

/** `!v` or `v == 0`: v. */
function zeroTest(c: Expression): string | null {
  const u = unwrap(c);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') return name((u as UnaryExpr).operand);
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '==' && isZero((u as BinaryExpr).right)) {
    return name((u as BinaryExpr).left);
  }
  return null;
}

/** `return v != 0;` */
function returnsTruth(s: Statement, v: string): boolean {
  if (s.kind !== NodeKind.ReturnStmt || !(s as ReturnStmt).value) return false;
  const e = unwrap((s as ReturnStmt).value!);
  return e.kind === NodeKind.BinaryExpr && (e as BinaryExpr).operator === '!='
    && name((e as BinaryExpr).left) === v && isZero((e as BinaryExpr).right);
}

/** Whether n stores to v, declares a v of its own, or holds a label control could enter by. */
function blocks(n: ASTNode, v: string): boolean {
  const members = new Set<ASTNode>();
  for (const m of traverseAST(n)) {
    switch (m.kind) {
      case NodeKind.LabelStmt: case NodeKind.CaseStmt: case NodeKind.DefaultStmt:
        return true;
      case NodeKind.MemberExpr:
        members.add((m as MemberExpr).member);
        break;
      case NodeKind.VariableDecl:
        if ((m as VariableDecl).name.name === v) return true;
        break;
      case NodeKind.AssignExpr:
        if (name((m as AssignExpr).left) === v) return true;
        break;
      case NodeKind.UnaryExpr: {
        const u = m as UnaryExpr;
        if ((u.operator === '++' || u.operator === '--' || u.operator === '&') && name(u.operand) === v) return true;
        break;
      }
      case NodeKind.PostfixExpr:
        if (name((m as PostfixExpr).operand) === v) return true;
        break;
    }
  }
  return false;
}

function isBool(fn: FunctionDecl): boolean {
  const t = fn.returnType as unknown as { kind: string; name?: string };
  return t?.kind === NodeKind.BuiltinType && t.name === 'bool';
}

function createDecidedBoolReturnTransformer(options: DecidedBoolReturnOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body || !isBool(fn)) return undefined;
      const all = [...traverseAST(fn.body)];
      const params = new Set((fn.parameters as ParameterDecl[]).map(p => p.name?.name).filter(Boolean) as string[]);
      const declCount = new Map<string, number>();
      for (const n of all) if (n.kind === NodeKind.VariableDecl) {
        const d = n as VariableDecl;
        declCount.set(d.name.name, (declCount.get(d.name.name) ?? 0) + 1);
      }
      const addressed = new Set<string>();
      for (const n of all) if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
        const o = name((n as UnaryExpr).operand);
        if (o) addressed.add(o);
      }
      // A parameter, or a local declared once (not static: a static keeps its value across calls,
      // which is still the value just tested, but the rule stays with plain storage).
      const own = (v: string) => !addressed.has(v) && (params.has(v)
        ? !declCount.has(v)
        : declCount.get(v) === 1 && !all.some(n => n.kind === NodeKind.VariableDecl
          && (n as VariableDecl).name.name === v && (n as VariableDecl).specifiers.includes('static')));

      const body = cloneNode(fn.body) as CompoundStmt;
      const sites: Array<{ list: Statement[]; i: number; value: boolean; v: string }> = [];
      const visit = (n: ASTNode): void => {
        for (const k of getChildren(n)) visit(k);
        if (n.kind !== NodeKind.CompoundStmt) return;
        const list = (n as CompoundStmt).statements;
        for (let i = 0; i < list.length; i++) {
          if (list[i].kind !== NodeKind.IfStmt) continue;
          const g = list[i] as IfStmt;
          if (g.elseBranch || g.init) continue;
          const v = zeroTest(g.condition);
          if (!v || !own(v)) continue;
          const arm = g.thenBranch.kind === NodeKind.CompoundStmt ? (g.thenBranch as CompoundStmt).statements : [g.thenBranch];
          if (arm.length === 0) continue;
          const last = arm[arm.length - 1];
          const before = arm.slice(0, -1);
          if (returnsTruth(last, v) && !before.some(s => blocks(s, v))) {
            if (g.thenBranch.kind === NodeKind.CompoundStmt) sites.push({ list: arm, i: arm.length - 1, value: false, v });
            else sites.push({ list, i, value: false, v });
          }
          if (last.kind !== NodeKind.ReturnStmt) continue;
          for (let j = i + 1; j < list.length; j++) {
            if (returnsTruth(list[j], v)) { sites.push({ list, i: j, value: true, v }); break; }
            if (blocks(list[j], v)) break;
          }
        }
      };
      visit(body);
      if (sites.length === 0) return undefined;
      for (const s of sites) {
        const value = Expr.boolLiteral(s.value);
        const at = s.list[s.i];
        if (at.kind === NodeKind.ReturnStmt) {
          s.list[s.i] = updateNode(at as ReturnStmt, { value } as Partial<ReturnStmt>);
        } else {
          // An arm that is the return itself.
          const g = at as IfStmt;
          s.list[s.i] = updateNode(g, { thenBranch: updateNode(g.thenBranch as ReturnStmt, { value } as Partial<ReturnStmt>) } as Partial<IfStmt>);
        }
        options.onSite?.({ variable: s.v, value: s.value });
      }
      return updateNode(fn, { body } as Partial<FunctionDecl>);
    },
  });
}

export const decidedBoolReturnPlugin: TransformPlugin = {
  id: 'decided-bool-return',
  name: 'Decided Bool Return',
  description: 'A bool return of `v != 0` that a guard on v has already decided is written as the constant',
  version: '1.0.0',
  defaultEnabled: true,
  // With the other late matching shapes, after early-return made the guard and after copied-test-while (989.866).
  priority: 989.867,
  tags: ['matching'],
  createTransformer: (options: DecidedBoolReturnOptions = {}) => createDecidedBoolReturnTransformer(options),
};
