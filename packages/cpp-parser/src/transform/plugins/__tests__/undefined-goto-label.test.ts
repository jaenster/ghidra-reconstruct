import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import {
  undefinedGotoLabelPlugin,
  getSynthesizedGotoLabels,
  resetSynthesizedGotoLabels,
} from '../builtins/undefined-goto-label.js';

describe('undefinedGotoLabelPlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = undefinedGotoLabelPlugin.createTransformer({});
    return emit(transformer(ast) as AnyNode);
  }

  it('defines a Ghidra goto target that was never emitted', () => {
    const out = transformCode('void f(int n) { if (3 < n) { goto LAB_00677aa7; } return; }');
    assert.ok(/LAB_00677aa7\s*:/.test(out), `expected synthesized label in:\n${out}`);
  });

  it('does NOT synthesize when the target IS defined', () => {
    const out = transformCode('void f(int n) { if (n) goto LAB_001; return; LAB_001: return; }');
    const defs = (out.match(/LAB_001\s*:/g) || []).length;
    assert.strictEqual(defs, 1, `expected exactly one LAB_001 label, got ${defs} in:\n${out}`);
  });

  it('leaves a non-Ghidra undefined label alone (real labels are not ours to invent)', () => {
    const out = transformCode('void f(int n) { if (n) goto cleanup; return; }');
    assert.ok(!/^\s*cleanup\s*:/m.test(out), `must not synthesize non-Ghidra label in:\n${out}`);
  });

  // A synthesized label means a goto whose target has no body: either Ghidra never
  // recovered the block, or a transform deleted it. The second case leaves a non-void
  // function able to fall off its end, so the stubs have to be countable, not silent.

  function record(code: string) {
    resetSynthesizedGotoLabels();
    transformCode(code);
    return getSynthesizedGotoLabels();
  }

  it('records every goto target it had to invent', () => {
    const recorded = record('uint32_t f(int n) { if (n) goto LAB_00677aa7; return 1; }');
    assert.deepStrictEqual(recorded, [{ functionName: 'f', label: 'LAB_00677aa7' }]);
  });

  it('records nothing when every goto target already has a body', () => {
    const recorded = record('void f(int n) { if (n) goto LAB_001; work(); LAB_001: done(); }');
    assert.deepStrictEqual(recorded, []);
  });

  it('resets the record on demand', () => {
    record('void f(int n) { if (n) goto LAB_002; }');
    resetSynthesizedGotoLabels();
    assert.deepStrictEqual(getSynthesizedGotoLabels(), []);
  });

  it('has correct metadata', () => {
    assert.strictEqual(undefinedGotoLabelPlugin.id, 'undefined-goto-label');
    assert.ok(undefinedGotoLabelPlugin.tags?.includes('control-flow'));
  });
});
