/**
 * A label's name is not structure: a Ghidra-named label is structured exactly as its default
 * spelling would be, and keeps its name when it survives.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { ASTNode } from '../../../ast/nodes.js';
import { gotoLabelCanonicalPlugin, gotoLabelRestorePlugin, canonicalLabels } from '../builtins/label-canonical.js';
import { gotoCleanupPlugin } from '../builtins/goto-cleanup/index.js';

const run = (code: string, flow: Record<string, { address: string; computed?: number }>) => {
  let ast = parse(code) as ASTNode;
  ast = gotoLabelCanonicalPlugin.createTransformer({ labelFlow: flow } as never)(ast);
  ast = gotoCleanupPlugin.createTransformer({ labelFlow: flow } as never)(ast);
  ast = gotoLabelRestorePlugin.createTransformer({ labelFlow: flow } as never)(ast);
  return emit(ast as never);
};

describe('label-canonical', () => {
  it('spells named labels as Ghidra defaults; case targets as switchD', () => {
    const m = canonicalLabels({ done: { address: '00401234' }, case_6: { address: '0042a061', computed: 1 }, LAB_00401000: { address: '00401000' }, ERROR: { address: '00558dd4' } });
    assert.deepEqual([...m], [['done', 'LAB_00401234'], ['case_6', 'switchD_0042a061_caseD_0042a061'], ['ERROR', 'LAB_00558dd4']]);
  });
  it('a named label is structured like the default one', () => {
    const src = (l: string) => `int f(int a) { if (a) goto ${l}; x(); ${l}: y(); return 1; }`;
    const named = run(src('done'), { done: { address: '00401234' } });
    const dflt = run(src('LAB_00401234'), {});
    assert.equal(named, dflt);
    assert.doesNotMatch(named, /goto/);
  });
  it('a surviving goto keeps its Ghidra name, macro-safe', () => {
    const src = `int f(int a, int b) { while (a) { if (b) goto ERROR; a = g(a); if (a < 0) goto ERROR; } use(a); return 1; ERROR: Release(a); Release(b); Log(a); Log(b); return 0; }`;
    const out = run(src, { ERROR: { address: '00558dd4' } });
    assert.match(out, /goto ERROR_lbl;/);
    assert.match(out, /ERROR_lbl:/);
    assert.doesNotMatch(out, /LAB_00558dd4/);
  });
});
