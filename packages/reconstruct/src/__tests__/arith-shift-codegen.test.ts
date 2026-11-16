import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateFunctionImplementation } from '../codegen/impl.js';
import { buildFuncPtrArgCastTables } from '../codegen/index.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

// Current MCP function/decompile with two explicitly adapted arithmetic sites.
// The fixture records that these are not a full snapshot-script facts export.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/arith-shift-v2109.json', import.meta.url), 'utf8'));
const fn = fixture.fn as ExtractedFunction, options = fixture.options as ReconstructOptions;

it('005d0c40: fixes both signed sites through production generation without changing the surrounding body', () => {
  const after = generateFunctionImplementation(fn, undefined, options, { targetPointerSize: 4 });
  assert.equal((after.match(/::d2_shift_left\(nCalcVal, 8\)/g) ?? []).length, 2);
  assert.equal(after.replace(/::d2_shift_left\(nCalcVal, 8\)/g, 'nCalcVal << 8'), fixture.baseline);
});

it('requires arithmetic instruction facts rather than rewriting an unmarked multiply', () => {
  const after = generateFunctionImplementation({ ...fn, arithSites: undefined }, undefined, options, { targetPointerSize: 4 });
  assert.doesNotMatch(after, /d2_shift_left|nCalcVal << 8/);
  assert.equal((after.match(/nCalcVal \* 0x100/g) ?? []).length, 2);
});

it('forwards current model return and global types to the integer proof', () => {
  const decompiled = 'int sample() {\nreturn gValue * 256 + nextValue() * 256;\n}\n';
  const sample = { ...fn, name: 'sample', namespace: '', returnType: 'int', parameters: [], localVariables: [], tags: [], decompiled,
    arithSites: { lineCount: 3, lines: [[2, [{ kind: 'mul', log2: 8, evidence: 'shift' }, { kind: 'mul', log2: 8, evidence: 'shift' }]]] } } as ExtractedFunction;
  const callee = { ...sample, name: 'nextValue', returnType: 'long', decompiled: undefined, arithSites: undefined };
  const tables = buildFuncPtrArgCastTables([sample, callee], [], [], []);
  tables.globalTypes.gValue = 'long';
  const after = generateFunctionImplementation(sample, undefined, options, { funcPtrArgCasts: tables, targetPointerSize: 4 });
  assert.equal((after.match(/::d2_shift_left/g) ?? []).length, 2);
});
