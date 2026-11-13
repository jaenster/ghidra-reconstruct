import { it } from 'node:test';
import assert from 'node:assert/strict';
import { emit } from '../index.js';
import { parse } from '../../parser/index.js';
import { compileAndRun, hasNativeGpp } from '../../testing/native-cpp.js';
import { rightNestingFixture } from './right-nesting.fixture.js';

it('preserves native floating-point and overloaded-operator grouping', { skip: !hasNativeGpp() }, () => {
  const { prelude, body } = rightNestingFixture(source => emit(parse(source)));
  const output = compileAndRun(prelude, body, { optimize: true, flags: ['-fno-fast-math', '-ffp-contract=off'] });
  assert.equal(output.trim(), 'grouping failures=0');
});
