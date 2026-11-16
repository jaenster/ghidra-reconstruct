import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const cli = fileURLToPath(new URL('./candidates.ts', import.meta.url));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'burst-values-'));
  const write = (name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data));
  const ndjson = (name: string, items: unknown[]) => writeFileSync(join(dir, name), items.map(x => JSON.stringify(x)).join('\n') + '\n');
  const run = (mode: string, name: string, items: unknown[], model = true) => {
    write(name + '-in.json', items);
    const r = spawnSync(process.execPath, ['--import', 'tsx', cli, mode, join(dir, name + '-in.json'), join(dir, name + '-out.json'), '--ops', 'delay,packadd',
      ...(model ? ['--types', join(dir, 'dataTypes.ndjson')] : [])], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(readFileSync(join(dir, name + '-out.json'), 'utf8'));
  };
  return { dir, ndjson, run, cleanup() { const actual = realpathSync(dir); assert.equal(dirname(actual), realpathSync(tmpdir())); assert.ok(basename(actual).startsWith('burst-values-')); rmSync(actual, { recursive: true, force: true }); } };
}
it('discovers and roundtrips both forms with real typedef spellings and unambiguous value-call contracts', () => {
  const f = fixture();
  try {
    f.ndjson('dataTypes.ndjson', [{ name: 'int32_t', kind: 'TYPEDEF', size: 4, underlyingType: 'int' }, { name: 'uint32_t', kind: 'TYPEDEF', size: 4, underlyingType: 'uint' }, { name: 'uint16_t', kind: 'TYPEDEF', size: 2, underlyingType: 'ushort' }]);
    const meta = (namespace: string | undefined, dataType: string) => ({ name: 'Capture', namespace, address: '00100000', returnType: 'void',
      callingConvention: '__cdecl', parameters: [{ name: 'value', dataType, ordinal: 0, size: 4, storage: 'Stack[0x4]:4' }], localVariables: [], size: 8, isThunk: false, isExternal: false, hasVarArgs: false });
    f.ndjson('functions.ndjson', [meta(undefined, 'int32_t')]);
    const items = [{ id: 'pack', text: 'uint32_t Pack(int x,int y){return (uint32_t)(uint16_t)y << 16 | (uint32_t)(uint16_t)x;}' },
      { id: 'delay', text: 'int Count(int32_t level,uint32_t count){Capture(level);level=count;if((int)count<=0)return 1;Capture(level);return level;}' }];
    const found = f.run('singles', 'known', items), forms = ['packadd(x,y)', 'delay(level,(int)count <= 0)'];
    const selected = found.map((r: { candidates: { form: string; text: string }[] }, i: number) => { const c = r.candidates.find(c => c.form === forms[i]); assert.ok(c, JSON.stringify(r)); return c; });
    const applied = f.run('apply', 'roundtrip', items.map((item, i) => ({ ...item, forms: [forms[i]] })));
    applied.forEach((r: { applied: string[]; refused: unknown[]; text: string }, i: number) => { assert.deepEqual(r.applied, [forms[i]]); assert.deepEqual(r.refused, []); assert.equal(r.text, selected[i].text); });
    const missing = f.run('singles', 'missing', items, false); assert.ok(missing.every((r: { candidates: unknown[] }) => r.candidates.length === 0));
    for (const [name, functions] of [['reference', [meta(undefined, 'int&')]], ['ambiguous', [meta('A', 'int'), meta('B', 'const int&')]]] as const) {
      f.ndjson('functions.ndjson', [...functions]); const [r] = f.run('singles', name, [items[1]]); assert.equal(r.candidates.some((c: { form: string }) => c.form === forms[1]), false);
    }
  } finally { f.cleanup(); }
});
it('discovers the real burst forms after its proved seq and applies tags in production order', () => {
  const real = JSON.parse(readFileSync(new URL('../../packages/reconstruct/src/__tests__/fixtures/burst-values-v2109.json', import.meta.url), 'utf8')), f = fixture();
  try {
    f.ndjson('dataTypes.ndjson', real.types); f.ndjson('functions.ndjson', [real.fn, ...real.callees]);
    const [sequenced] = f.run('apply', 'seq', [{ id: '005d5080', text: real.input, forms: [real.forms[0]] }]); assert.deepEqual(sequenced.applied, [real.forms[0]]);
    const [found] = f.run('singles', 'real', [{ id: '005d5080', text: sequenced.text }]);
    for (const form of real.forms.slice(1)) assert.ok(found.candidates.some((c: { form: string }) => c.form === form), form);
    const [applied] = f.run('apply', 'all', [{ id: '005d5080', text: real.input, forms: [...real.forms].reverse() }]);
    assert.deepEqual(applied.order, real.forms); assert.deepEqual(applied.applied, real.forms); assert.deepEqual(applied.refused, []); assert.equal(applied.text, real.candidate.trimEnd());
  } finally { f.cleanup(); }
});
