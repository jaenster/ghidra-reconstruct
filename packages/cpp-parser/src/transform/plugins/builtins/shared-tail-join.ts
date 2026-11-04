/**
 * Shared Tail Join Plugin
 *
 * An arm that ends in the same statements as the code after it,
 *
 *     if (c) {                                    if (c) {
 *       A;                                          A;
 *       T;                                        } else {
 *       return R;                       ->          B;
 *     }                                           }
 *     B;                                          T;
 *     T;                                          return R;
 *     return R;
 *
 * was written once, after an if/else. VC8 /O2 tail-duplicates a short exit into each way
 * that reaches it (each arm gets its own `pop esi; ret`, and its own copy of a store or two
 * ahead of it), and the decompiler prints the two copies as two exits. Compiled as printed,
 * VC8 cross-jumps the identical tails back into one copy, so the printed shape compiles to
 * the opposite layout (GFX_FreeGfxInfoEntry 0046e610: `mov eax, 1` materialised per path
 * after the join; SOUNDHDR_FreeSoundBuffer 004823e0: the two member stores in each arm).
 *
 * `if (c) { A; T } B; T`, the if without an else, T the longest common run of statements
 * at the end of the then-arm and of its enclosing block, becomes `if (c) { A } else { B } T`
 * when
 *   - T ends in a `return`, or the block is the function body and T falls off its end (an
 *     arm's trailing bare `return;` then matches the end of the body); a bare `return;`
 *     both end in does not count as T;
 *   - A and B are not empty: `if (c) T; B; T` is a guard (the return-copy rules' shape), and
 *     dropping an arm's copy of the exit with nothing after the if lost every match it
 *     touched (SKILLS_GetTotalSkillLevel 00644aa0, SetupUpdateFlag 00624690);
 *   - B holds no return, goto, break or continue: a chain of exits after the if was written
 *     with early returns (Q02_SequenceFilter 005910f0, WndProc 004f9a80);
 *   - T is not only `return x;` for a local x, a value both ways leave in EAX already
 *     (CheckCollision_Vector 0064d800), and T's return is not one the function writes more
 *     than twice: those are written per exit and cross-jumped (the quest StatusFilters'
 *     `return true`, Q31_StatusFilter 00586ce0);
 *   - nothing in T is declared in A or B, and no label, `case` or `default` sits in A, B
 *     or T; the function has no goto.
 * Runs bottom-up, so an else-if chain of such arms folds from its last arm outwards.
 *
 * Value-preserving: when c holds, A runs and then T, as before; otherwise B runs and then
 * T. T names nothing A or B declare, so each copy read the same declarations.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, Expression, FunctionDecl, Identifier, IfStmt, ParenExpr, ReturnStmt, Statement, VariableDecl,
} from '../../../ast/nodes.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import { Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { localTypesOf } from './compare-form.js';

export interface SharedTailJoinOptions extends PluginOptions {
  onSite?: (e: { statements: number; line: number }) => void;
}

const text = (s: ASTNode) => emit(s as unknown as AnyNode).replace(/\s+/g, ' ').trim();

function bodyOf(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? [...(s as CompoundStmt).statements] : [s];
}

function isBareReturn(s: Statement | undefined): boolean {
  return !!s && s.kind === NodeKind.ReturnStmt && !(s as ReturnStmt).value;
}

function declared(list: Statement[]): Set<string> {
  const out = new Set<string>();
  for (const s of list) for (const n of traverseAST(s)) if (n.kind === NodeKind.VariableDecl) out.add((n as VariableDecl).name.name);
  return out;
}

function named(list: Statement[]): Set<string> {
  const out = new Set<string>();
  for (const s of list) for (const n of traverseAST(s)) if (n.kind === NodeKind.Identifier) out.add((n as Identifier).name);
  return out;
}

function holdsLabel(list: Statement[]): boolean {
  for (const s of list) for (const n of traverseAST(s)) {
    if (n.kind === NodeKind.LabelStmt || n.kind === NodeKind.CaseStmt || n.kind === NodeKind.DefaultStmt) return true;
  }
  return false;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** `return x;` with x a local or parameter of the function. */
function returnsLocal(s: Statement, locals: ReadonlySet<string>): boolean {
  if (s.kind !== NodeKind.ReturnStmt || !(s as ReturnStmt).value) return false;
  const v = unwrap((s as ReturnStmt).value as Expression);
  return v.kind === NodeKind.Identifier && locals.has((v as Identifier).name);
}

/** Joins in one statement list; `atEnd`: the list is the function body. */
function joinList(list: Statement[], atEnd: boolean, options: SharedTailJoinOptions, fnLocals: ReadonlySet<string>, returnCounts: ReadonlyMap<string, number>): Statement[] | null {
  let changed = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (s.kind !== NodeKind.IfStmt) continue;
    const ifs = s as IfStmt;
    if (ifs.elseBranch || ifs.init) continue;
    let arm = bodyOf(ifs.thenBranch);
    const rest = list.slice(i + 1);
    if (!rest.length) continue;
    const last = rest[rest.length - 1];
    // The way out: a return ending both, or the end of the function body.
    const restReturns = last.kind === NodeKind.ReturnStmt;
    if (!restReturns) {
      if (!atEnd || !isBareReturn(arm[arm.length - 1])) continue;
      arm = arm.slice(0, -1);
    } else if (isBareReturn(last) && !isBareReturn(arm[arm.length - 1])) {
      continue;
    }
    let k = 0;
    while (k < arm.length && k < rest.length && text(arm[arm.length - 1 - k]) === text(rest[rest.length - 1 - k])) k++;
    // With nothing in common the arm must have ended in the bare return stripped above.
    if (!k && restReturns) continue;
    // A bare `return;` both end in is no tail of its own: what precedes it must be shared.
    const shared = restReturns && isBareReturn(last) ? k - 1 : k;
    const a = arm.slice(0, arm.length - k);
    const b = rest.slice(0, rest.length - k);
    const t = rest.slice(rest.length - k);
    if (!a.length || !b.length) continue;
    // B runs straight into T: an exit inside it is a guard chain the source wrote with early
    // returns (Q02_SequenceFilter 005910f0, WndProc 004f9a80 lost their matches joined).
    if (b.some(x => [...traverseAST(x)].some(n => n.kind === NodeKind.ReturnStmt || n.kind === NodeKind.GotoStmt
      || n.kind === NodeKind.BreakStmt || n.kind === NodeKind.ContinueStmt))) continue;
    // A tail that is only `return local;` hands back a register both ways already
    // (CheckCollision_Vector 0064d800 lost its match joined).
    if (shared === 1 && t.length === 1 && returnsLocal(t[0], fnLocals)) continue;
    // A return the function writes more than twice was written per exit, the copies VC8
    // cross-jumps (the quest StatusFilters' `return true`, Q31_StatusFilter 00586ce0).
    if (last.kind === NodeKind.ReturnStmt && (returnCounts.get(text(last)) ?? 0) > 2) continue;
    if (holdsLabel(a) || holdsLabel(b) || holdsLabel(t)) continue;
    const tNames = named(t);
    if ([...declared(a), ...declared(b)].some(n => tNames.has(n))) continue;
    if (!shared) continue;
    const thenBlock = Stmt.compound(a.map(x => cloneNode(x) as Statement));
    const elseBlock = Stmt.compound(b.map(x => cloneNode(x) as Statement));
    const joined = { ...ifs, thenBranch: thenBlock, elseBranch: elseBlock } as IfStmt;
    list.splice(i, list.length - i, joined, ...t);
    changed = true;
    options.onSite?.({ statements: k, line: ifs.location?.start.line ?? 0 });
  }
  return changed ? list : null;
}

function createSharedTailJoinTransformer(options: SharedTailJoinOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      for (const n of traverseAST(fn.body)) if (n.kind === NodeKind.GotoStmt) return undefined;
      const fnLocals = new Set<string>(localTypesOf(fn).keys());
      const returnCounts = new Map<string, number>();
      for (const n of traverseAST(fn.body)) {
        if (n.kind === NodeKind.ReturnStmt) returnCounts.set(text(n), (returnCounts.get(text(n)) ?? 0) + 1);
      }
      const body = cloneNode(fn.body) as CompoundStmt;
      let changed = false;
      const visit = (n: ASTNode, atEnd: boolean): void => {
        // Bottom-up: inner blocks first, then this one (an else-if chain folds outwards).
        for (const m of getChildren(n)) visit(m, false);
        if (n.kind === NodeKind.CompoundStmt) {
          const list = (n as CompoundStmt).statements;
          if (joinList(list, atEnd, options, fnLocals, returnCounts)) changed = true;
        }
      };
      visit(body, true);
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const sharedTailJoinPlugin: TransformPlugin = {
  id: 'shared-tail-join',
  name: 'Shared Tail Join',
  description: 'An arm ending in the statements that follow it becomes an if/else with the tail written once after it',
  version: '1.0.0',
  defaultEnabled: true,
  // After return-copy-join (989.98), whose guard shapes it leaves alone.
  priority: 989.981,
  tags: ['matching'],
  createTransformer: (options: SharedTailJoinOptions = {}) => createSharedTailJoinTransformer(options),
};
