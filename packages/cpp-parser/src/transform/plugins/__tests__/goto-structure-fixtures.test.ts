/**
 * Real decompiles the structuring work is measured on (design 7.3), unedited `decompile`
 * output at Ghidra v1131. For each, goto-cleanup's output must be an unfolding of the raw
 * body (the whole function, proven), keep every case label, and leave exactly the pinned
 * number of gotos - a change in that number is a change in behaviour of the passes and has
 * to be looked at, in either direction.
 *
 *   ITEM_DeserializeFromBitBuffer 0062cbe0   Ghidra's if (false) arm holding the default
 *                                            handler; 21 extra gotos from copied labelled
 *                                            loops before step 3
 *   TXT_ParseDataAndPutIntoStructure 006bd780  five halt sites cross-jumped to one tail
 *   QUEST_OnPlayerJoinGame 00546270          a rotated loop entered at its body
 *   AUTOMAP_RevealUnitsInRoom 00458dc0       15 jumps to a latch that does work (for-loop
 *                                            recovery is step 7; pinned as kept)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../../../parser/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import { traverseAST } from '../../../ast/visitor.js';
import type { ASTNode, CompoundStmt, FunctionDecl, Statement } from '../../../ast/nodes.js';
import { gotoCleanupPlugin, getGotoCleanupStats, resetGotoCleanupStats } from '../builtins/goto-cleanup/index.js';
import { DEFAULT_NORETURN_FUNCTIONS } from '../builtins/goto-cleanup/types.js';
import { isUnfolding, countGotoTargets } from '../../cfg/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gotos');

const CASES: { file: string; raw: number; after: number }[] = [
  { file: 'ITEM_DeserializeFromBitBuffer_0062cbe0', raw: 35, after: 32 },
  { file: 'TXT_ParseDataAndPutIntoStructure_006bd780', raw: 24, after: 24 },
  { file: 'QUEST_OnPlayerJoinGame_00546270', raw: 12, after: 6 },
  { file: 'AUTOMAP_RevealUnitsInRoom_00458dc0', raw: 6, after: 6 },
];

function body(root: ASTNode): Statement[] {
  for (const n of traverseAST(root)) {
    if (n.kind === NodeKind.FunctionDecl && (n as FunctionDecl).body) return ((n as FunctionDecl).body as CompoundStmt).statements;
  }
  throw new Error('no function body');
}
const gotos = (s: Statement[]) => [...countGotoTargets(s).values()].reduce((a, b) => a + b, 0);
function caseLabels(s: Statement[]): number {
  let n = 0;
  for (const x of s) for (const node of traverseAST(x as ASTNode)) if (node.kind === NodeKind.CaseStmt || node.kind === NodeKind.DefaultStmt) n++;
  return n;
}

describe('structuring fixtures (v1131)', () => {
  for (const c of CASES) {
    it(`${c.file}: ${c.raw} gotos -> ${c.after}, proven equivalent, every case label kept`, () => {
      const ast = parse(fs.readFileSync(path.join(FIXTURES, `${c.file}.c`), 'utf8'));
      const before = body(ast);
      assert.equal(gotos(before), c.raw, 'the fixture itself changed');
      resetGotoCleanupStats();
      const after = body(gotoCleanupPlugin.createTransformer()(ast) as ASTNode);
      const proof = isUnfolding(before, after, {
        externalGotoCounts: countGotoTargets(before), followIsExit: false,
        noreturn: DEFAULT_NORETURN_FUNCTIONS, haltException: true,
      });
      assert.ok(proof.ok, proof.reason);
      assert.equal(caseLabels(after), caseLabels(before));
      assert.equal(gotos(after), c.after);
      const st = getGotoCleanupStats();
      assert.equal(st.vetoedUnsafe, 0, 'a handler produced a candidate the reachability net had to stop');
      assert.equal(st.orphanGoto, 0);
    });
  }
});
