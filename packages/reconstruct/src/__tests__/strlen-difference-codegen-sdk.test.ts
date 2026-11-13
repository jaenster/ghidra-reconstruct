import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateFunctionImplementation, getParseErrorCount } from '../codegen/impl.js';
import { javaStringHash } from '../extract/compare-sites.js';

// Produced by the actual standalone and combined Java extractors on an isolated
// Ghidra12.2 import. Copied native-verified type/storage models; not an owning export.
const fixtureText = readFileSync(new URL('./fixtures/strlen-difference-gfx-sdk.json', import.meta.url), 'utf8');
const fresh = () => JSON.parse(fixtureText);
type Fixture = ReturnType<typeof fresh>;
function generate(f: Fixture): string {
  const code = generateFunctionImplementation(f.fn, undefined, f.options, f.context);
  assert.equal(getParseErrorCount(), 0);
  return code;
}
const nested = /D2FILE_AllocAndLoadD2File\(D2Win::Src::D2WinArchive::ReturnZero\(\)/;
const memberLength = /strlen\(pDVar3->szName\)/;

describe('strlen-difference in full codegen with SDK-extracted facts', () => {
  it('retains the exact extracted Windows text and native call storage', () => {
    const f = fresh(), expected = f.provenance.nativeText;
    assert.ok(f.fn.decompiled.includes('\r\n'));
    assert.equal(f.fn.decompiled.length, expected.length);
    assert.equal(javaStringHash(f.fn.decompiled), expected.javaStringHash);
    assert.equal(f.fn.callOrder.lineCount, expected.lines);
    const calls = f.fn.callOrder.calls.flatMap((row: [number, unknown[]]) => row[1]);
    const getter = calls.find((c: { name: string }) => c.name === 'ReturnZero');
    const allocation = calls.find((c: { name: string }) => c.name === 'D2FILE_AllocAndLoadD2File');
    assert.deepEqual([getter.at, getter.pushes, getter.slots], [29, 3, []]);
    assert.deepEqual([allocation.at, allocation.prev, allocation.pushes, allocation.slots], [39, 29, 0, [0, 0, 1, 1, 1]]);
  });

  it('recovers the typed member length alongside native-attested call nesting', () => {
    const code = generate(fresh());
    assert.match(code, memberLength);
    assert.match(code, nested);
    assert.doesNotMatch(code, /strlen\(pcVar5\)/);
  });

  it('keeps the end-pointer scan when the exact member declaration is absent', () => {
    const f = fresh();
    delete f.context.funcPtrArgCasts.structFields.D2CofTextureCacheEntryStrc.szName;
    const code = generate(f);
    assert.doesNotMatch(code, memberLength);
    assert.match(code, /strlen\(pcVar5\)/);
    assert.match(code, nested);
  });

  it('keeps the getter separate when the native push evidence does not fit nesting', () => {
    const f = fresh();
    for (const [, calls] of f.fn.callOrder.calls) {
      for (const call of calls) if (call.name === 'ReturnZero') call.pushes = 0;
    }
    const code = generate(f);
    assert.doesNotMatch(code, nested);
    assert.match(code, memberLength);
  });

  it('rejects call-order rows whose text line count has changed', () => {
    const f = fresh();
    f.fn.callOrder.lineCount++;
    const code = generate(f);
    assert.doesNotMatch(code, nested);
    assert.match(code, memberLength);
  });
});
