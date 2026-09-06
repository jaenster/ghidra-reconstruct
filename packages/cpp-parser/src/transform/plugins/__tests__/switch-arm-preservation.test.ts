/**
 * Switch arms must survive the pipeline.
 *
 * These four fixtures are unedited `decompile` output from the 1.14d `Game.exe` Ghidra
 * database, kept verbatim under `fixtures/switch-arms/`. Each one shipped through the
 * generator with live `case` arms missing, because `handleUnconditionalGoto` deleted the
 * span between a `goto` and its target and the span held a `case` label — an entry point
 * the switch dispatch jumps to, which its "is anything jumping in here?" guard only knew
 * how to look for as a `goto` target.
 *
 * 170 arms across 29 files were restored by hand before the cause was found. What that
 * cost buys is these fixtures: the shape is now pinned by real decompiler output rather
 * than by a reduction of it, so a future rewrite of the goto passes has to keep working
 * on the input that actually broke them.
 *
 * The counts below are the number of `case`/`default` labels Ghidra emits. They are not
 * arbitrary golden numbers — every one of them is a dispatch target, and losing one means
 * that value silently reaches the `default` arm at runtime.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../../../parser/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import { traverseAST } from '../../../ast/visitor.js';
import type { ASTNode, CaseStmt, CompoundStmt, FunctionDecl, Statement } from '../../../ast/nodes.js';
import { emit } from '../../../emit/index.js';
import { PluginRegistry, registerPlugins } from '../registry.js';
import { allBuiltinPlugins } from '../index.js';
import { gotoCleanupPlugin } from '../builtins/goto-cleanup/index.js';
import { getGotoCleanupStats, resetGotoCleanupStats } from '../builtins/goto-cleanup/stats.js';
import { preservesReachableWork } from '../../cfg/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'switch-arms');

interface Fixture {
  /** File under fixtures/switch-arms, without the extension. */
  name: string;
  address: string;
  /** Where the reconstructed tree puts it, for the next person chasing a regression. */
  file: string;
  /** `case` + `default` labels in Ghidra's output. Every one is a dispatch target. */
  labels: number;
  /**
   * What the shipped generator emitted instead, before the entry-point fix — counted in
   * `recon/diablo-2` (branch `source/regen`, pure generator output) against the same
   * function in `recon/modified`, where the arms were restored by hand.
   */
  wasEmitted: number;
  note: string;
}

const FIXTURE_LIST: Fixture[] = [
  {
    name: 'CheckCollision_BlockPlayer_Cross',
    address: '0064d4e0',
    file: 'D2Common/Collision.cpp',
    labels: 10,
    wasEmitted: 9,
    note: "case '\\f' hosts LAB_0064d748, which case '\\t' jumps into. The smallest reproducer.",
  },
  {
    name: 'ShowOogErrorDialog',
    address: '0043b9f0',
    file: 'D2Launch/Launcher.cpp',
    labels: 28,
    wasEmitted: 12,
    note: 'default: hosts both LAB_0043bdfd and LAB_0043be09; three arms jump into them.',
  },
  {
    name: 'DRLGPATH_FindPathDualScan',
    address: '0067bdf0',
    file: 'D2Common/Drlg/Path.cpp',
    labels: 5,
    wasEmitted: 2,
    note: 'case 3 hosts LAB_0067bf65, reached from case 0. Cases 1..3 went with it.',
  },
  {
    name: 'SKILLDESC_ProcessDescLine',
    address: '004edea0',
    file: 'D2Client/UI/SkillDesc.cpp',
    labels: 75,
    wasEmitted: 42,
    note: 'Seven cross-arm labels. The worst single loss in the tree: 33 arms.',
  },
];

function read(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, `${name}.c`), 'utf8');
}

function functionBody(root: ASTNode): Statement[] {
  for (const n of traverseAST(root)) {
    if (n.kind !== NodeKind.FunctionDecl) continue;
    const fn = n as FunctionDecl;
    if (fn.body?.kind === NodeKind.CompoundStmt) return (fn.body as CompoundStmt).statements;
  }
  throw new Error('fixture has no function body');
}

/** How many `case`/`default` labels the tree holds, at any nesting depth. */
function countDispatchLabels(root: ASTNode): number {
  let n = 0;
  for (const node of traverseAST(root)) {
    if (node.kind === NodeKind.CaseStmt || node.kind === NodeKind.DefaultStmt) n++;
  }
  return n;
}

/** The `case` label values, so a diff names the arm that went missing. */
function caseValues(root: ASTNode): string[] {
  const out: string[] = [];
  for (const node of traverseAST(root)) {
    if (node.kind === NodeKind.CaseStmt) out.push(emit((node as CaseStmt).value));
    else if (node.kind === NodeKind.DefaultStmt) out.push('default');
  }
  return out;
}

function fullPipeline(root: ASTNode): ASTNode {
  const registry = new PluginRegistry();
  registerPlugins(registry, allBuiltinPlugins);
  return registry.createPipeline({ preset: 'full' }).execute(root).ast;
}

describe('switch arms survive the pipeline', () => {
  for (const fx of FIXTURE_LIST) {
    describe(`${fx.name} (${fx.address}, ${fx.file})`, () => {
      it(`Ghidra emits ${fx.labels} dispatch labels — ${fx.note}`, () => {
        // Guards the fixture itself: if this number moves, the fixture was re-captured
        // from a changed database and the expectations below need re-deriving, not
        // silently relaxing.
        assert.strictEqual(countDispatchLabels(parse(read(fx.name))), fx.labels);
      });

      it('goto-cleanup alone keeps every one of them', () => {
        const before = parse(read(fx.name));
        const after = gotoCleanupPlugin.createTransformer({})(before);
        assert.deepStrictEqual(
          caseValues(after),
          caseValues(before),
          `arms lost by goto-cleanup (was emitting ${fx.wasEmitted} of ${fx.labels})`,
        );
      });

      it('the whole pipeline keeps every one of them', () => {
        const before = parse(read(fx.name));
        const after = fullPipeline(parse(read(fx.name)));
        assert.strictEqual(countDispatchLabels(after), fx.labels);
        // Spelling can legitimately change downstream (enum qualification, char escapes),
        // so the count is what is compared here; the identity check is the one above.
        assert.strictEqual(countDispatchLabels(before), fx.labels);
      });

      it('goto-cleanup preserves every reachable path, not just the labels', () => {
        // The labels surviving is necessary, not sufficient: an arm can keep its label and
        // lose its body, and a tail can be inlined at a goto site while its fallthrough
        // predecessor loses the path into it.
        const before = parse(read(fx.name));
        const after = gotoCleanupPlugin.createTransformer({})(before);
        const r = preservesReachableWork(functionBody(before), functionBody(after));
        assert.ok(
          r.ok,
          `lost keys:\n  ${r.lostKeys.join('\n  ')}\nlost edges:\n  ${r.lostEdges.slice(0, 20).join('\n  ')}`,
        );
      });

      it('needs no veto — the handlers decline on their own', () => {
        // The preservation check in processCompound is a net, not the mechanism. If this
        // starts failing, a handler has begun producing unsafe candidates again and is
        // only being saved by the net: fix the handler, then restore this assertion.
        resetGotoCleanupStats();
        gotoCleanupPlugin.createTransformer({})(parse(read(fx.name)));
        assert.strictEqual(getGotoCleanupStats().vetoedUnsafe, 0);
      });
    });
  }

  it('the fixtures between them cover every shape that was losing arms', () => {
    const total = FIXTURE_LIST.reduce((n, f) => n + f.labels, 0);
    const shipped = FIXTURE_LIST.reduce((n, f) => n + f.wasEmitted, 0);
    assert.strictEqual(total - shipped, 53, 'arms these four fixtures alone were losing');
  });
});
