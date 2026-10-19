/**
 * The `source: 'ghidra'` runtime declarations are copies of Ghidra prototypes, and the
 * program moves under them. At v1096 four had gone stale (`__CIsqrt`, `__local_unwind2`,
 * `__NLG_Notify`, `__CxxFrameHandler3`), each one a "too many arguments" error at every
 * call site. `ghidraDeclDrift` compares the copy to the program on every run.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { ghidraDeclDrift, EXCLUDED_SYMBOL_DECLS } from '../codegen/crt-mapping.js';

const p = (n: number) => Array.from({ length: n }, () => ({}));

describe('ghidraDeclDrift', () => {
  it('is silent when the declaration matches the program (v1096 prototypes)', () => {
    assert.deepStrictEqual(ghidraDeclDrift([
      { name: '__CIsqrt', address: '006879c0', parameters: p(1) },
      { name: '__local_unwind2', address: '00697fd9', parameters: p(3) },
      { name: '__NLG_Notify', address: '00698089', parameters: p(3) },
      { name: 'FID_conflict:___CxxFrameHandler3', address: '0068333c', parameters: p(5) },
      { name: '__aulldvrm', address: '00686b60', parameters: p(4) },
      { name: '___report_gsfailure', address: '006889d6', parameters: [] },
    ]), []);
  });

  it('names a declaration whose arity the program no longer has', () => {
    const drift = ghidraDeclDrift([{ name: '__CIsqrt', address: '006879c0', parameters: [] }]);
    assert.deepStrictEqual(drift, [{ emitted: '__CIsqrt', address: '006879c0', declArity: 1, ghidraArity: 0 }]);
  });

  it('matches Ghidra names through the decompiler spelling', () => {
    const drift = ghidraDeclDrift([{ name: 'FID_conflict:___CxxFrameHandler3', address: '00683372', parameters: p(4) }]);
    assert.strictEqual(drift.length, 1);
    assert.strictEqual(drift[0].declArity, 5);
  });

  it('the LLDVRM helpers return the quotient/remainder pair Ghidra types them with', () => {
    const d = EXCLUDED_SYMBOL_DECLS.find(x => x.emitted === '__aulldvrm');
    assert.ok(d && /^static inline LLDVRM_RESULT __aulldvrm\(/.test(d.decl), d?.decl);
  });
});
