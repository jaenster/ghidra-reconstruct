import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { vc8FormSpec, vc8formBodyHash } from '../codegen/vc8form-spec.js';

describe('vc8-form join ordering', () => {
  it('runs a measured lifetime join after split and before fold regardless of tag order', () => {
    const decompiled = 'int f() { return 0; }';
    const dh = vc8formBodyHash(decompiled);
    const records = ['fold(tmp)', 'join(value,input)', 'split(v,int32_t,rename)'].map(form => ({
      type: 'vc8form', data: `${form};ev=0123456789;bh=16-00000000;dh=${dh}`,
    }));
    for (const tags of [records, [...records].reverse()]) {
      const spec = vc8FormSpec({ tags, size: 16, decompiled });
      assert.deepEqual(spec?.stale, []);
      assert.deepEqual(spec?.forms.map(entry => entry.form.op), ['split', 'join', 'fold']);
    }
  });
});
