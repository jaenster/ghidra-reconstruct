/**
 * A switch-case tail ends in `break`, and that `break` belongs to the switch the
 * label sits in. Copying such a tail to a goto site outside the switch leaves a
 * `break` with nothing to break out of, which is a hard error — while Ghidra's
 * own spelling, a `goto` to a label at function scope, compiles verbatim.
 *
 * The reshaping that exposes this happens across several passes, so the check
 * runs the whole default pipeline rather than the goto plugin alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { allBuiltinPlugins } from '../index.js';

function runPipeline(code: string): string {
  let ast: AnyNode = parse(code) as AnyNode;
  const enabled = allBuiltinPlugins
    .filter(p => p.defaultEnabled)
    .sort((a, b) => a.priority - b.priority);
  for (const plugin of enabled) {
    try {
      ast = plugin.createTransformer({} as never)(ast) as AnyNode;
    } catch {
      // A plugin that needs options it was not given contributes nothing here.
    }
  }
  return emit(ast).trim();
}

/** `MONSTER_OnCreateAttachQuests` @ 005b1cf0, reduced to the shape that matters. */
const withTail = (tail: string) => `
void f(int nBaseId, int nQuestNo) {
  if (nBaseId < 0x1b3) {
    if (nBaseId == 0x1b2) {
      Attach(nQuestNo);
      return;
    }
    switch (nBaseId) {
      case 0x9c:
        InitUmods(1);
        break;
      case 0x192:
switchD_caseD_192:
        InitUmods(0x16);
        ${tail}
      default:
        return;
    }
    return;
  }
  if (nBaseId != 0x220) {
    return;
  }
  nQuestNo = 7;
LAB_2046:
  Attach(nQuestNo);
  goto switchD_caseD_192;
}
`;

describe('goto cleanup — a case tail whose break binds to the switch', () => {
  it('keeps the goto rather than copying the break out of the switch', () => {
    const out = runPipeline(withTail('break;'));
    assert.ok(out.includes('goto switchD_caseD_192;'), `goto eliminated:\n${out}`);
    assert.ok(out.includes('switchD_caseD_192:'), `label stripped from under a live goto:\n${out}`);
    // The `break` that survives is the one still inside the switch, not a copy
    // sitting after `LAB_2046:`.
    const afterLabel = out.slice(out.indexOf('LAB_2046:'));
    assert.ok(!afterLabel.includes('break;'), `break copied outside the switch:\n${out}`);
  });

  it('still inlines a tail that returns — nothing in it binds to the switch', () => {
    const out = runPipeline(withTail('return;'));
    assert.ok(!out.includes('goto switchD_caseD_192;'), `return tail no longer inlined:\n${out}`);
    assert.ok(out.includes('InitUmods(0x16);'), `tail lost:\n${out}`);
  });
});
