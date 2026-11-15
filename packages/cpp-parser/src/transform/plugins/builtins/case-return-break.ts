/**
 * Case Return Break Plugin
 *
 * A case of a switch that ends in the same `return K;` the switch is followed by was written
 * with `break;`: the original holds one copy of that return, which the case falls into and
 * the other ways reach by jumps (MISSMODE_CheckCollisionMode 005ada40: case 2's
 * `cmp; jne` into the shared `xor eax, eax; ret`, then the one `mov eax, 1; ret`). The
 * decompiler prints the copy in the case as a return of its own, and VC8, compiling that,
 * if-converts the case's test and its two returns into a SETcc.
 *
 * `return K;` ending a case group of a switch statement directly followed by `return K;`
 * becomes `break;` when the lines of both returns place them in one return copy of the
 * original (branch-layout/evidence.ts `sharedCopy`), and that copy is fallen into.
 *
 * Value-preserving: the break leaves the switch onto the same return.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, FunctionDecl, ReturnStmt, Statement, SwitchStmt,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { Stmt } from '../../../ast/factory.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { sameExpr } from './rotated-for-loop.js';
import { LayoutReader, type BranchLayoutEvidence } from './branch-layout/evidence.js';

export interface CaseReturnBreakOptions extends PluginOptions {
  branchLayout?: BranchLayoutEvidence | null;
  onSite?: (e: { line: number }) => void;
}

const isLabel = (s: Statement) => s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt;

function createCaseReturnBreakTransformer(options: CaseReturnBreakOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      const ev = options.branchLayout;
      if (!fn.body || !ev?.returns) return undefined;
      const body = cloneNode(fn.body) as CompoundStmt;
      const reader = new LayoutReader(ev, body);
      let changed = false;
      for (const n of traverseAST(body)) {
        if (n.kind !== NodeKind.CompoundStmt) continue;
        const list = (n as CompoundStmt).statements as Statement[];
        for (let i = 0; i + 1 < list.length; i++) {
          if (list[i].kind !== NodeKind.SwitchStmt || list[i + 1].kind !== NodeKind.ReturnStmt) continue;
          const after = list[i + 1] as ReturnStmt;
          if (!after.value) continue;
          const sw = list[i] as SwitchStmt;
          if (sw.body.kind !== NodeKind.CompoundStmt) continue;
          const cases = (sw.body as CompoundStmt).statements as Statement[];
          for (let k = 0; k < cases.length; k++) {
            const s = cases[k];
            if (s.kind !== NodeKind.ReturnStmt || !(s as ReturnStmt).value) continue;
            if (k + 1 < cases.length && !isLabel(cases[k + 1])) continue;
            // A return that is a case label's own statement starts its group: not a case's end.
            if (k === 0) continue;
            if (!sameExpr((s as ReturnStmt).value!, after.value)) continue;
            const copy = reader.sharedCopy([s as ReturnStmt, after]);
            if (!copy || copy.fallsIn !== true) continue;
            // Each return's line must place it (sharedCopy skips a return without evidence).
            if (reader.returnCopy(s as ReturnStmt) === null || reader.returnCopy(after) === null) continue;
            cases[k] = { ...Stmt.break_(), location: s.location } as Statement;
            options.onSite?.({ line: s.location?.start.line ?? 0 });
            changed = true;
          }
        }
      }
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const caseReturnBreakPlugin: TransformPlugin = {
  id: 'case-return-break',
  name: 'Case Return Break',
  description: 'A case ending in the return the switch is followed by, one copy in the original, breaks instead',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 989.987,
  tags: ['matching'],
  createTransformer: (options: CaseReturnBreakOptions = {}) => createCaseReturnBreakTransformer(options),
};
