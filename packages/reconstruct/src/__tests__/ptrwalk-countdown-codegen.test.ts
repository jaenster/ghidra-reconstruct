import { it } from 'node:test';
import assert from 'node:assert/strict';
import { countdownImplementation } from './fixtures/ptrwalk-countdown-codegen.js';

it('reconstructs the live HSL walk after complete type context has indexed it', () => {
  // Untagged, the countdown is the index loop (countdown-index-for); the measured form keeps it.
  const before = countdownImplementation('none');
  assert.match(before, /for \(int nColorIndex = 0; nColorIndex < 0x100; nColorIndex\+\+\)/);
  assert.doesNotMatch(before, /nColorIndex--/);
  const after = countdownImplementation('current');
  assert.match(after, /double\* pdHSLEntry = &pHSLPalette\[0\]\.dLightness;/);
  assert.match(after, /\*pdHSLEntry = dOldLightness \+ 0\.20000000298023224;/);
  assert.match(after, /pdHSLEntry \+= 3;\s+nColorIndex--;/);
  assert.doesNotMatch(after, /pHSLPalette\[-nColorIndex/);
});
it('keeps stale and absent countdown forms identical through full codegen', () => {
  assert.equal(countdownImplementation('stale'), countdownImplementation('none'));
});
