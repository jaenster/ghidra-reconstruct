import { test } from 'node:test';
import assert from 'node:assert';
import {
  enabledAdditionalSources,
  disabledSourcePlatforms,
  stripDisabledSources,
} from '../additional-sources.js';
import type { ProjectConfig } from '../config/schema.js';

const config = (enabled?: boolean): ProjectConfig => ({
  version: 1,
  project: 'T',
  additionalSources: [{ ghidra: 'g', platform: 'mac', ...(enabled === undefined ? {} : { enabled }) }],
});

test('a source is merged only with enabled:true; absent means off', () => {
  assert.equal(enabledAdditionalSources(config()).length, 0);
  assert.equal(enabledAdditionalSources(config(true)).length, 1);
  assert.equal(enabledAdditionalSources(config(false)).length, 0);
  assert.deepEqual([...disabledSourcePlatforms(config(false))], ['mac']);
  assert.deepEqual([...disabledSourcePlatforms(config())], ['mac']);
  assert.equal(disabledSourcePlatforms(config(true)).size, 0);
});

test('stripping a disabled source drops its records and its anchors, and nothing else', () => {
  const functions = [
    { name: 'Win', address: '1', crossPlatformAddress: { address: '9', platform: 'mac' } },
    { name: 'WinOnly', address: '2' },
    { name: 'MacOnly', address: '3', platform: 'mac', ifdef: 'D2_PLATFORM_MAC' },
  ] as any[];
  const globals = [{ name: 'g', platform: 'mac' }, { name: 'h' }] as any[];
  const dataTypes = [{ name: 'T', platform: 'mac' }, { name: 'U' }] as any[];

  const r = stripDisabledSources({ functions, globals, dataTypes }, new Set(['mac']));
  assert.deepEqual(r.functions.map(f => f.name), ['Win', 'WinOnly']);
  assert.equal(r.functions[0].crossPlatformAddress, undefined);
  assert.deepEqual(r.globals.map(g => g.name), ['h']);
  assert.deepEqual(r.dataTypes.map(t => t.name), ['U']);
  assert.equal(r.removedFunctions, 1);
  assert.equal(r.removedAnchors, 1);
  // The snapshot's own records are not mutated.
  assert.ok(functions[0].crossPlatformAddress);
});

test('with nothing disabled the inputs pass through untouched', () => {
  const functions = [{ name: 'A', address: '1', platform: 'mac' }] as any[];
  const r = stripDisabledSources({ functions, globals: [], dataTypes: [] }, new Set());
  assert.strictEqual(r.functions, functions);
});
