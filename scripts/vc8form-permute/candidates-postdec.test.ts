import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

it('discovers only applicable postdec forms and roundtrips the measured body', () => {
  const dir = mkdtempSync(join(tmpdir(), 'postdec-'));
  try {
    const text = `int f(uint16_t *a,uint16_t *b,int32_t count){uint16_t y;uint16_t x=*a;
      while(x && (y=*b) && count){a++;b++;if(x!=y)return x<y?-1:1;x=*a;count--;}return 0;}`;
    const items = [{ id: 'one', text }, { id: 'used', text: text.replace('return 0;', 'return count;') },
      { id: 'fresh', text: text.replace('int32_t count)', 'int32_t count,int nRemaining)') },
      { id: 'alias', text: text.replace('uint16_t y;', 'Keep(count);uint16_t y;') }];
    writeFileSync(join(dir, 'in.json'), JSON.stringify(items));
    const cli = fileURLToPath(new URL('./candidates.ts', import.meta.url));
    const run = (mode: string, input: string, output: string) => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', cli, mode, join(dir, input), join(dir, output), '--ops', 'postdec'], { encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return JSON.parse(readFileSync(join(dir, output), 'utf8'));
    };
    const rows = run('singles', 'in.json', 'out.json');
    for (const row of rows) assert.equal(row.error, undefined);
    assert.deepEqual(rows[0].candidates.map((c: { form: string }) => c.form), ['postdec(count,nRemaining)']);
    assert.equal(rows[0].candidates[0].adds, 1);
    assert.deepEqual(rows[1].candidates, []);
    assert.deepEqual(rows[2].candidates.map((c: { form: string }) => c.form), ['postdec(count,nRemaining2)']);
    assert.deepEqual(rows[3].candidates, []);
    writeFileSync(join(dir, 'apply.json'), JSON.stringify([{ id: 'one', text, forms: ['postdec(count,nRemaining)'] }]));
    const [applied] = run('apply', 'apply.json', 'applied.json');
    assert.deepEqual(applied.applied, ['postdec(count,nRemaining)']);
    assert.deepEqual(applied.refused, []);
    assert.equal(applied.text, rows[0].candidates[0].text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
