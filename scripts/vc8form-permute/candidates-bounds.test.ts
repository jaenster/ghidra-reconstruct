import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const cli = fileURLToPath(new URL('./candidates.ts', import.meta.url));
it('discovers/roundtrips typed disjoint bounds and withholds unknown, aliased or ambiguous storage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounds-candidates-'));
  const write = (name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data));
  const ndjson = (name: string, rows: unknown[]) => writeFileSync(join(dir, name), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const input = [{ id: 'bounds', text: 'void f(int x,int y){ a=x-24; b=y-19; c=x+24; d=y+19; }' }];
  const globals = ['a', 'b', 'c', 'd'].map((name, i) => ({ name, dataType: 'int', address: (4096 + i * 4).toString(16), size: 4 }));
  const run = (mode: string, name: string, items: unknown[], model = true) => {
    write(name + '-in.json', items);
    const p = spawnSync(process.execPath, ['--import', 'tsx', cli, mode, join(dir, name + '-in.json'), join(dir, name + '-out.json'), '--ops', 'bounds',
      ...(model ? ['--globals', join(dir, 'globals.ndjson'), '--types', join(dir, 'dataTypes.ndjson')] : [])], { encoding: 'utf8', windowsHide: true });
    assert.equal(p.status, 0, p.stdout + p.stderr); return JSON.parse(readFileSync(join(dir, name + '-out.json'), 'utf8'));
  };
  try {
    ndjson('dataTypes.ndjson', []); ndjson('functions.ndjson', []); ndjson('globals.ndjson', globals);
    write('manifest.json', { provenance: { programInfo: { languageId: 'x86:LE:32:default', pointerSize: 4 } } });
    const [found] = run('singles', 'valid', input); const candidate = found.candidates.find((c: { form: string }) => c.form === 'bounds(a,b,c,d)');
    assert(candidate); const [applied] = run('apply', 'roundtrip', [{ ...input[0], forms: [candidate.form] }]);
    assert.deepEqual(applied.applied, [candidate.form]); assert.deepEqual(applied.refused, []); assert.equal(applied.text, candidate.text);
    assert.match(candidate.text, /c = a \+ 48/); assert.match(candidate.text, /d = b \+ 38/);
    const [missing] = run('singles', 'missing', input, false); assert.equal(missing.candidates.length, 0);
    for (const [name, rows] of [['aliased', globals.map(g => g.name === 'c' ? { ...g, address: '1000' } : g)],
      ['ambiguous', [...globals, { ...globals[0], address: '2000', namespace: 'Other' }]],
      ['ambiguous-type', [...globals, { ...globals[0], dataType: 'volatile int' }]],
      ['missing-type', globals.map(g => g.name === 'a' ? { ...g, dataType: '' } : g)],
      ['volatile', globals.map(g => g.name === 'a' ? { ...g, dataType: 'volatile int' } : g)]] as const) {
      ndjson('globals.ndjson', [...rows]); const [r] = run('singles', name, input); assert.equal(r.candidates.length, 0, name);
    }
  } finally {
    const actual = realpathSync(dir); assert.equal(dirname(actual), realpathSync(tmpdir())); assert(basename(actual).startsWith('bounds-candidates-'));
    rmSync(actual, { recursive: true, force: true });
  }
});
