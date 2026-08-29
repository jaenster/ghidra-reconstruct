import { describe, it } from 'node:test';
import assert from 'node:assert';
import { transformGhidraCode } from '../../../index.js';

const run = (src: string) =>
  transformGhidraCode(src, { usePluginRegistry: true, preset: 'full' as const });

describe('array-block-assign', () => {
  it('turns a whole-array copy into memcpy, keeping the width', () => {
    const r = run(`void f(uint8_t *pPacket) {
  char local_10 [4];
  local_10 = *(char (*) [4])(pPacket + 5);
}`);
    assert.ok(r.success, r.error);
    assert.ok(/memcpy\(local_10, pPacket \+ 5, sizeof\(local_10\)\)/.test(r.code), r.code);
    // The 4-byte read must not have decayed to a 1-byte subscript.
    assert.ok(!/pPacket\[5\]/.test(r.code), r.code);
  });

  it('turns a whole-array clear into memset', () => {
    const r = run(`void f(void) {
  uint16_t wszClanTag [2];
  wszClanTag = (WCHAR  [2])0x0;
}`);
    assert.ok(r.success, r.error);
    assert.ok(/memset\(wszClanTag, 0, sizeof\(wszClanTag\)\)/.test(r.code), r.code);
  });

  it('leaves a non-zero scalar assigned to an array alone', () => {
    const r = run(`void f(void) {
  char szExt [4];
  szExt = (char  [4])((int)szExt + 1);
}`);
    assert.ok(r.success, r.error);
    assert.ok(!r.code.includes('memcpy'), r.code);
    assert.ok(!r.code.includes('memset'), r.code);
  });

  it('leaves a scalar local alone', () => {
    const r = run(`void f(uint8_t *pPacket) {
  int n;
  n = *(int *)(pPacket + 5);
}`);
    assert.ok(r.success, r.error);
    assert.ok(!r.code.includes('memcpy'), r.code);
  });
});
