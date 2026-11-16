import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

it('discovers compound-add splits only with unambiguous by-value model contracts and roundtrips them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'split-add-'));
  try {
    const text = 'void f(int start) { int v = start; Use(v); v += 3; Use(v); Use(v); }';
    const form = 'split(v,int,v_2,add)';
    writeFileSync(join(dir, 'in.json'), JSON.stringify([{ id: 'one', text }]));
    writeFileSync(join(dir, 'dataTypes.ndjson'), JSON.stringify({ name: 'int32_t', kind: 'TYPEDEF', size: 4, underlyingType: 'int' }) + '\n');
    const meta = (namespace: string | undefined, dataType: string) => ({ name: 'Use', namespace, address: '00100000', signature: `void Use(${dataType} value)`,
      returnType: 'void', callingConvention: '__cdecl', parameters: [{ name: 'value', dataType, ordinal: 0, size: 4, storage: 'Stack[0x4]:4' }],
      localVariables: [], size: 8, isThunk: false, isExternal: false, hasVarArgs: false });
    const functions = (items: unknown[]) => writeFileSync(join(dir, 'functions.ndjson'), items.map(f => JSON.stringify(f)).join('\n') + '\n');
    const cli = fileURLToPath(new URL('./candidates.ts', import.meta.url));
    const run = (mode: string, input: string, output: string, model: boolean) => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', cli, mode, join(dir, input), join(dir, output), '--ops', 'split',
        ...(model ? ['--types', join(dir, 'dataTypes.ndjson')] : [])], { encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(readFileSync(join(dir, output), 'utf8'));
    };
    functions([meta(undefined, 'int32_t')]);
    const [known] = run('singles', 'in.json', 'known.json', true);
    assert.equal(known.error, undefined); const found = known.candidates.find((c: { form: string }) => c.form === form); assert.ok(found);
    writeFileSync(join(dir, 'apply.json'), JSON.stringify([{ id: 'one', text, forms: [form] }]));
    const [applied] = run('apply', 'apply.json', 'applied.json', true); assert.deepEqual(applied.applied, [form]); assert.deepEqual(applied.refused, []); assert.equal(applied.text, found.text);
    const [missing] = run('singles', 'in.json', 'missing.json', false); assert.equal(missing.candidates.some((c: { form: string }) => c.form === form), false);
    functions([meta(undefined, 'int &')]); const [ref] = run('singles', 'in.json', 'ref.json', true); assert.equal(ref.candidates.some((c: { form: string }) => c.form === form), false);
    functions([meta('A', 'int'), meta('B', 'int &')]); const [ambiguous] = run('singles', 'in.json', 'ambiguous.json', true); assert.equal(ambiguous.candidates.some((c: { form: string }) => c.form === form), false);
    const real = JSON.parse(readFileSync(new URL('../../packages/reconstruct/src/__tests__/fixtures/split-add-act4-v2109.json', import.meta.url), 'utf8'));
    writeFileSync(join(dir, 'dataTypes.ndjson'), real.types.map((t: unknown) => JSON.stringify(t)).join('\n') + '\n');
    functions([real.fn, ...real.callees]);
    writeFileSync(join(dir, 'real.json'), JSON.stringify([{ id: '0067e6a0', text: real.rawBaseline }]));
    const [target] = run('singles', 'real.json', 'target.json', true);
    const actualForm = 'split(nPresetBaseB,int,nPresetBaseB_2,add)';
    const actual = target.candidates.find((c: { form: string }) => c.form === actualForm); assert.ok(actual);
    writeFileSync(join(dir, 'target-apply.json'), JSON.stringify([{ id: '0067e6a0', text: real.rawBaseline, forms: [actualForm] }]));
    const [roundtrip] = run('apply', 'target-apply.json', 'target-applied.json', true);
    assert.deepEqual(roundtrip.applied, [actualForm]); assert.deepEqual(roundtrip.refused, []); assert.equal(roundtrip.text, actual.text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
