import { it } from 'node:test';
import assert from 'node:assert/strict';
import { countdownImplementation } from './fixtures/ptrwalk-countdown-codegen.js';

it('reconstructs the live HSL walk after complete type context has indexed it', () => {
  const before = countdownImplementation('none');
  assert.match(before, /pHSLPalette\[-nColorIndex \+ 256\]\.dLightness/);
  assert.doesNotMatch(before, /double\* pdHSLEntry/);
  const after = countdownImplementation('current');
  assert.match(after, /double\* pdHSLEntry = &pHSLPalette\[0\]\.dLightness;/);
  assert.match(after, /\*pdHSLEntry = dOldLightness \+ 0\.20000000298023224;/);
  assert.match(after, /pdHSLEntry \+= 3;\s+nColorIndex--;/);
  assert.doesNotMatch(after, /pHSLPalette\[-nColorIndex/);
});
it('keeps stale and absent countdown forms identical through full codegen', () => {
  assert.equal(countdownImplementation('stale'), countdownImplementation('none'));
});
