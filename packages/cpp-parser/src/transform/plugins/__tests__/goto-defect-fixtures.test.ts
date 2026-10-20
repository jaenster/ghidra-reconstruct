/**
 * Four functions the generator shipped broken at Ghidra v1131, found by the translation
 * validator in log mode. Each fixture is the unedited `decompile` of its address.
 *
 * In every one a goto handler removed a label while a goto OUTSIDE the compound it was
 * rewriting still targeted it. `undefined-goto-label` then "repaired" the dangling goto with
 * an empty label at the end of the function - or `removeOrphanedGotos` deleted it outright -
 * so the jump silently went somewhere else:
 *
 *   SOUND_PlaySoundEffect 00514ec0          the cache-search loop's back edge went to the
 *                                           function's end: the search stopped after the
 *                                           first entry it did not match
 *   ITEMS_CalcTransactionCost 0062efb0      a goto into a price arm became a fallthrough
 *   GetItemName 0048c060                    a halt on bad item data returned instead
 *   DRLGLEVEL_FixDrlgLevelForSpiderForest   a halt returned instead
 *     00677880
 *
 * The test proves the WHOLE function: goto-cleanup's output must be an unfolding of the raw
 * body (transform/cfg/equivalence.ts) and must keep every goto's label. It is shown to fail
 * on the old behaviour by running the same input with the validator off.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../../../parser/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import { traverseAST } from '../../../ast/visitor.js';
import type { ASTNode, CompoundStmt, FunctionDecl, GotoStmt, LabelStmt, Statement } from '../../../ast/nodes.js';
import { gotoCleanupPlugin, setGotoValidatorMode } from '../builtins/goto-cleanup/index.js';
import { DEFAULT_NORETURN_FUNCTIONS } from '../builtins/goto-cleanup/types.js';
import { isUnfolding, countGotoTargets } from '../../cfg/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gotos');

const CASES = [
  { file: 'SOUND_PlaySoundEffect_00514ec0', label: 'LAB_00514ef4' },
  { file: 'ITEMS_CalcTransactionCost_0062efb0', label: 'switchD_0062f3a0_caseD_2' },
  { file: 'GetItemName_0048c060', label: 'LAB_0048c0e0' },
  { file: 'DRLGLEVEL_FixDrlgLevelForSpiderForest_00677880', label: 'LAB_00677aa7' },
];

function body(root: ASTNode): Statement[] {
  for (const n of traverseAST(root)) {
    if (n.kind === NodeKind.FunctionDecl && (n as FunctionDecl).body) return ((n as FunctionDecl).body as CompoundStmt).statements;
  }
  throw new Error('no function body');
}

function danglingGotos(stmts: Statement[]): string[] {
  const defined = new Set<string>();
  const used: string[] = [];
  for (const s of stmts) for (const n of traverseAST(s as ASTNode)) {
    if (n.kind === NodeKind.LabelStmt) defined.add((n as LabelStmt).label.name);
    if (n.kind === NodeKind.GotoStmt) used.push((n as GotoStmt).label.name);
  }
  return used.filter(l => !defined.has(l));
}

function run(file: string) {
  const src = fs.readFileSync(path.join(FIXTURES, `${file}.c`), 'utf8');
  // One parse for both sides: untouched statements keep their identity through the
  // transform, which is what lets a site-unique statement (GetInstructionPointer) match.
  const ast = parse(src);
  const before = body(ast);
  const out = body(gotoCleanupPlugin.createTransformer()(ast) as ASTNode);
  return { before, out };
}

describe('goto-cleanup keeps every jump target (v1131 defects)', () => {
  after(() => setGotoValidatorMode(null));
  for (const c of CASES) {
    it(`${c.file}: no dangling goto, and the output is an unfolding of the raw body`, () => {
      setGotoValidatorMode('enforce');
      const { before, out } = run(c.file);
      assert.deepEqual(danglingGotos(out), []);
      const proof = isUnfolding(before, out, {
        externalGotoCounts: countGotoTargets(before),
        followIsExit: false,
        noreturn: DEFAULT_NORETURN_FUNCTIONS,
      });
      assert.ok(proof.ok, proof.reason);
    });

    it(`${c.file}: with the validator off, the old defect reproduces (${c.label})`, () => {
      setGotoValidatorMode('off');
      const { out } = run(c.file);
      assert.ok(danglingGotos(out).includes(c.label), `expected ${c.label} to dangle without the validator`);
    });
  }
});
