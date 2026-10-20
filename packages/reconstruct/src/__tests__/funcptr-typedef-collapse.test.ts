/** A funcdef typedef is already the pointer, so it absorbs exactly one star of a spelling. */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { collapseFuncPtrTypedef } from '../codegen/platform-types.js';

const isFd = (n: string) => n === 'fnAppModeRun';

describe('collapseFuncPtrTypedef', () => {
  it('F * -> F, and F * * -> F * (AppModeLauncherInit returns fnAppModeRun * *)', () => {
    assert.strictEqual(collapseFuncPtrTypedef('fnAppModeRun *', isFd), 'fnAppModeRun');
    assert.strictEqual(collapseFuncPtrTypedef('fnAppModeRun * *', isFd), 'fnAppModeRun *');
    assert.strictEqual(collapseFuncPtrTypedef('fnAppModeRun **', isFd), 'fnAppModeRun *');
  });
  it('leaves other names and bare funcdefs', () => {
    assert.strictEqual(collapseFuncPtrTypedef('D2UnitStrc * *', isFd), 'D2UnitStrc * *');
    assert.strictEqual(collapseFuncPtrTypedef('fnAppModeRun', isFd), 'fnAppModeRun');
  });
});
