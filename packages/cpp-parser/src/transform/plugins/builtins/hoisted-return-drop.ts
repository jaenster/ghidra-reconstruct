/**
 * Hoisted Return Drop Plugin
 *
 * VC8 tail-duplicates a function's one exit into the paths that reach it, and where every
 * successor of a test returns the same constant it loads the constant once, above the test
 * (OBJOP_SpawnArmorDrop 00584160: `mov eax, 1` ahead of the `je` that skips the flag store,
 * both ways then `pop esi; ...; ret`). The decompiler prints the copy on the arm as a return
 * of its own:
 *
 *     if (!pUnit || dead) {                        if (!pUnit || dead) {
 *       ...;                                         ...;
 *       if (pUnit) {                       ->        if (pUnit) {
 *         pUnit->f &= ~2;                              pUnit->f &= ~2;
 *         return 1;                                  }
 *       }                                          }
 *     }                                            return 1;
 *     return 1;
 *
 * and early-return then turns the outer test into a guard the original never had. Where the
 * arm's `return K` prints code below the arm's own test's conditional branch (the load VC8
 * hoisted over the test), and the arm ends the last statement of a chain of ifs that each end
 * their enclosing arm right before the same `return K`, the arm's copy goes.
 *
 * Value-preserving: without the return, the arm falls out of each enclosing if in turn, with
 * nothing after any of them, onto the same `return K`.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, FunctionDecl, IfStmt, ReturnStmt, Statement,
} from '../../../ast/nodes.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { sameExpr } from './rotated-for-loop.js';
import { LayoutReader, type BranchLayoutEvidence } from './branch-layout/evidence.js';
import { constantValue } from './null-getter.js';

export interface HoistedReturnDropOptions extends PluginOptions {
  branchLayout?: BranchLayoutEvidence | null;
  onSite?: (e: { line: number }) => void;
}

function lowOffset(s: Statement, ev: BranchLayoutEvidence): number | null {
  if (!s.location) return null;
  let low: number | null = null;
  for (let l = s.location.start.line; l <= s.location.end.line; l++) {
    for (const o of ev.lines.get(l) ?? []) if (low === null || o < low) low = o;
  }
  return low;
}

/**
 * In the if `ifs`, whose fall-through reaches `ret`, drop a trailing copy of `ret` from the
 * innermost arm of the chain of trailing ifs. Returns the rebuilt if, or null.
 */
function dropIn(ifs: IfStmt, ret: ReturnStmt, ev: BranchLayoutEvidence, reader: LayoutReader, opts: HoistedReturnDropOptions): IfStmt | null {
  if (ifs.elseBranch || ifs.init || ifs.thenBranch.kind !== NodeKind.CompoundStmt) return null;
  const arm = (ifs.thenBranch as CompoundStmt).statements;
  if (arm.length === 0) return null;
  const last = arm[arm.length - 1];
  if (last.kind === NodeKind.ReturnStmt) {
    if (arm.length < 2 || !(last as ReturnStmt).value || !sameExpr((last as ReturnStmt).value!, ret.value!)) return null;
    const cb = reader.cbranch(ifs);
    const lo = lowOffset(last, ev);
    if (cb === null || lo === null || lo >= cb || reader.copied(last)) return null;
    opts.onSite?.({ line: last.location?.start.line ?? 0 });
    return updateNode(ifs, { thenBranch: updateNode(ifs.thenBranch as CompoundStmt, { statements: arm.slice(0, -1) } as Partial<CompoundStmt>) } as Partial<IfStmt>);
  }
  if (last.kind !== NodeKind.IfStmt) return null;
  const inner = dropIn(last as IfStmt, ret, ev, reader, opts);
  if (!inner) return null;
  return updateNode(ifs, { thenBranch: updateNode(ifs.thenBranch as CompoundStmt, { statements: [...arm.slice(0, -1), inner] } as Partial<CompoundStmt>) } as Partial<IfStmt>);
}

function createHoistedReturnDropTransformer(options: HoistedReturnDropOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      const ev = options.branchLayout;
      if (!fn.body || !ev) return undefined;
      const list = fn.body.statements;
      if (list.length < 2) return undefined;
      const ret = list[list.length - 1];
      const ifs = list[list.length - 2];
      if (ret.kind !== NodeKind.ReturnStmt || !(ret as ReturnStmt).value || !constantValue((ret as ReturnStmt).value!, () => undefined)) return undefined;
      if (ifs.kind !== NodeKind.IfStmt) return undefined;
      const reader = new LayoutReader(ev, fn.body);
      const r = dropIn(ifs as IfStmt, ret as ReturnStmt, ev, reader, options);
      if (!r) return undefined;
      const body = cloneNode(fn.body) as CompoundStmt;
      (body as { statements: Statement[] }).statements = [...list.slice(0, -2), r, list[list.length - 1]];
      return updateNode(fn, { body } as Partial<FunctionDecl>);
    },
  });
}

export const hoistedReturnDropPlugin: TransformPlugin = {
  id: 'hoisted-return-drop',
  name: 'Hoisted Return Drop',
  description: 'A copy of the final return on a trailing arm whose constant VC8 loaded above the test goes',
  version: '1.0.0',
  defaultEnabled: true,
  // Before early-return (60), which would make a guard of the outer test.
  priority: 59.9,
  tags: ['matching'],
  createTransformer: (options: HoistedReturnDropOptions = {}) => createHoistedReturnDropTransformer(options),
};
