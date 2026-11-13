import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateFunctionImplementation, getParseErrorCount } from '../codegen/impl.js';
import { createOutParamOracle, type OutParamOracle } from '../codegen/out-params.js';
import { parsePrologueSlots, applyPrologueSlots } from '../extract/prologue-slots.js';
import { withResolvedType } from '../extract/functions.js';

// Exact live caller/callee decompiles and metadata, with native PUSH rows from the
// unchanged Java extractor on an exact-byte SDK import. Not an owning snapshot.
const fixtureText = readFileSync(new URL('./fixtures/push-slot-storage-a3q2.json', import.meta.url), 'utf8');
const fresh = () => JSON.parse(fixtureText);
const sfileText = readFileSync(new URL('./fixtures/push-slot-storage-sfile.json', import.meta.url), 'utf8');
type Fixture = ReturnType<typeof fresh>;
const initializer = /pOperationArg\s*=\s*pOperation\b/;

function mapped(fn: Fixture['fn']) {
  return {
    ...fn,
    parameters: fn.parameters.map((p: { dataType: string; resolvedType?: string }) => ({
      ...p, dataType: withResolvedType(p.dataType, p.resolvedType),
    })),
    localVariables: fn.localVariables.map((v: { dataType: string; resolvedType?: string }) => ({
      ...v, dataType: withResolvedType(v.dataType, v.resolvedType),
    })),
  };
}

function oracleFor(f: Fixture): OutParamOracle {
  const parts = `${f.callee.namespace}::${f.callee.name}`.split('::');
  const byKey = new Map(parts.map((_, i) => [parts.slice(i).join('::'), mapped(f.callee)]));
  return createOutParamOracle(byKey, []);
}

function generate(f: Fixture, oracle = oracleFor(f)): string {
  const code = generateFunctionImplementation(mapped(f.fn), undefined, f.options, {
    funcPtrArgCasts: { ...f.tables, outParams: oracle },
  });
  assert.equal(getParseErrorCount(), 0);
  return code;
}

function slot(f: Fixture) {
  return f.fn.localVariables.find((v: { name: string }) => v.name === 'pOperationArg');
}

describe('native PUSH slots with narrow raw database storage', () => {
  it('keeps the raw byte record separate from the pointer-valued decompile and native slot', () => {
    const f = fresh();
    assert.equal(slot(f).storage, 'Stack[-0x8]:1');
    assert.equal(slot(f).size, 1);
    assert.equal(slot(f).resolvedType, 'D2ObjectOperateFnArg *');
    const resolved = mapped(f.fn).localVariables.find((v: { name: string }) => v.name === 'pOperationArg');
    assert.equal(resolved.dataType, 'D2ObjectOperateFnArg *');
    assert.equal(resolved.storage, 'Stack[-0x8]:1');
    assert.equal(applyPrologueSlots(parsePrologueSlots(f.prologueRows), [f.fn]), 1);
    assert.deepEqual(f.fn.pushSlots, [{ offset: -8, reg: 'ECX' }, { offset: -12, reg: 'ESI' }]);
    assert.equal(oracleFor(f).outParamWidth(f.callee.name, 3), 4);
  });

  it('lets the existing out-call proof remove the pointer initializer from a byte storage record', () => {
    const code = generate(fresh());
    assert.doesNotMatch(code, initializer);
    assert.match(code, /ITEM_RewardItemToDrop\(/);
    assert.match(code, /&pOperationArg/);
  });

  it('still handles an existing full-width database storage record', () => {
    const f = fresh();
    slot(f).storage = 'Stack[-0x8]:4';
    slot(f).size = 4;
    assert.doesNotMatch(generate(f), initializer);
  });

  it('uses the nonnull out-parameter proof for a local address passed to SFileOpenFileEx', () => {
    const f = JSON.parse(sfileText);
    const oracle = oracleFor(f);
    assert.equal(oracle.outParamWidth(f.callee.name, 3), null);
    assert.equal(oracle.outParamWidthNonNull(f.callee.name, 3), 4);
    const code = generate(f, oracle);
    assert.doesNotMatch(code, /pFileHandle\s*=\s*(?:\([^)]*\)\s*)?szFileName\b/);
    assert.match(code, /&pFileHandle/);
    assert.match(code, /SFileCloseFile\(pFileHandle\)/);
  });

  it('keeps the initializer without native PUSH evidence', () => {
    const f = fresh();
    delete f.fn.pushSlots;
    assert.match(generate(f), initializer);
  });

  it('keeps a volatile pointer store even when its later out-call overwrites it', () => {
    const f = fresh();
    slot(f).resolvedType = 'D2ObjectOperateFnArg * volatile';
    f.fn.decompiled = f.fn.decompiled.replace(
      'D2ObjectOperateFnArg *pOperationArg;',
      'D2ObjectOperateFnArg * volatile pOperationArg;',
    );
    const code = generate(f);
    assert.match(code, /volatile\s+pOperationArg/);
    assert.match(code, initializer);
  });

  it('keeps the initializer when the callee overwrite is unknown', () => {
    const f = fresh();
    assert.match(generate(f, createOutParamOracle(new Map(), [])), initializer);
  });

  it('requires an overwrite of the emitted pointer, not just the raw byte record', () => {
    const f = fresh();
    const oracle = oracleFor(f);
    assert.match(generate(f, {
      ...oracle,
      outParamWidth: () => 1,
      outParamWidthNonNull: () => 1,
      outParamWidthDocumented: () => 1,
    }), initializer);
  });

  it('does not associate an interior byte with the whole pushed parameter', () => {
    const f = fresh();
    slot(f).storage = 'Stack[-0x7]:1';
    slot(f).stackOffset = -7;
    assert.match(generate(f), initializer);
  });

  it('declines a raw storage range larger than the four-byte push', () => {
    const f = fresh();
    slot(f).storage = 'Stack[-0x8]:8';
    slot(f).size = 8;
    assert.match(generate(f), initializer);
  });
});
