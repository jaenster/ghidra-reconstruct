import { it } from 'node:test';
import assert from 'node:assert/strict';
import { emit } from '../index.js';
import { parse } from '../../parser/index.js';
import { compileAndRun, hasNativeGpp } from '../../testing/native-cpp.js';
import { assignmentGroupingFixture } from './assignment-grouping.fixture.js';

it('preserves native assignment targets, compound updates and comma effects', { skip: !hasNativeGpp() }, () => {
  const { prelude, body } = assignmentGroupingFixture(source => emit(parse(source)));
  assert.equal(compileAndRun(prelude, body, { optimize: true }).trim(), 'assignment checks=1000 failures=0');
});
