/**
 * goto-cleanup: a tail is copied to its goto sites only while it is small in NODES, not
 * in top-level statements. UI_SetMultipleButtonKeyBindings 00453640 is eight blocks of
 *
 *   if (idx != -1) { if (bound) { key = get(); if (ok) { store key; goto NEXT; } } store default; }
 *   NEXT:
 *
 * and each NEXT tail (the rest of the function, few statements) was copied into the goto
 * site, copies included, by the fixpoint: 126 lines became 4,377. The rewrite must still
 * do the same thing, so both forms are compiled and run for every combination of inputs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { gotoCleanupPlugin } from '../builtins/goto-cleanup/index.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const BLOCKS = 8;
const block = (k: number) => `
  if (idx[${k}] != -1) {
    if (bound[${k}] != 0) {
      key = keys[${k}];
      if (key < 0xe0) {
        out[${k}] = key;
        goto LAB_${k};
      }
    }
    out[${k}] = ${0xc0 + k};
  }
LAB_${k}:`;
const SRC = `void f(const int *idx, const int *bound, const int *keys, int *out) {
  int key;${Array.from({ length: BLOCKS }, (_, k) => block(k)).join('')}
  out[${BLOCKS}] = 1;
  return;
}`;

describe('goto-cleanup: tail copies bounded by node count', () => {
  const out = emit(gotoCleanupPlugin.createTransformer()(parse(SRC)) as AnyNode);

  it('stays near the size of the input', () => {
    const inLines = SRC.split('\n').length, outLines = out.split('\n').length;
    assert.ok(outLines < inLines * 3, `${inLines} lines became ${outLines}`);
  });

  it('runs the same as the goto form for every input combination', { skip: !hasNativeGpp() }, () => {
    const body = [
      'long bad = 0;',
      `for (int m = 0; m < (1 << ${BLOCKS * 3}); m++) {`,
      `  int idx[${BLOCKS}], bound[${BLOCKS}], keys[${BLOCKS}], o1[${BLOCKS + 1}] = {0}, o2[${BLOCKS + 1}] = {0};`,
      `  for (int k = 0; k < ${BLOCKS}; k++) { idx[k] = (m >> (3*k)) & 1 ? -1 : k; bound[k] = (m >> (3*k+1)) & 1; keys[k] = (m >> (3*k+2)) & 1 ? 0xf0 : 0x41 + k; }`,
      '  ref::f(idx, bound, keys, o1); low::f(idx, bound, keys, o2);',
      `  for (int k = 0; k <= ${BLOCKS}; k++) if (o1[k] != o2[k]) { bad++; break; }`,
      '}',
      'printf("%ld\\n", bad);',
    ].join('\n');
    const res = compileAndRun(`namespace ref {\n${SRC}\n}\nnamespace low {\n${out}\n}`, body, { optimize: true });
    assert.strictEqual(res.trim(), '0');
  });
});
