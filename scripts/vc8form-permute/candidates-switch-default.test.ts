import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

it('measures native case-group seeds only after the same guards used by application', () => {
  const dir = mkdtempSync(join(tmpdir(), 'switch-default-candidates-'));
  try {
    const text = 'int f(E x) { switch(x) { case EXISTING: return 1; } return 0; }';
    writeFileSync(join(dir, 'dataTypes.ndjson'), JSON.stringify({ kind: 'ENUM', name: 'E', size: 4, values: [{ name: 'EXISTING', value: 0 }] }) + '\n');
    writeFileSync(join(dir, 'functions.ndjson'), '');
    writeFileSync(join(dir, 'in.json'), JSON.stringify([
      { id: 'none', text },
      { id: 'seeded', text, seedForms: ['swdefault(x,3,4,5)', 'swdefault(x,0)', 'swdefault(x,bad)'] },
      { id: 'unknown', text: text.replace('E x', 'Unknown x'), seedForms: ['swdefault(x,3)'] },
    ]));
    const cli = fileURLToPath(new URL('./candidates.ts', import.meta.url));
    const run = (mode: string, input: string, output: string) => {
      const r = spawnSync(process.execPath, ['--import', 'tsx', cli, mode, join(dir, input), join(dir, output), '--types', join(dir, 'dataTypes.ndjson'), '--ops', 'swdefault'], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return JSON.parse(readFileSync(join(dir, output), 'utf8'));
    };
    const rows = run('singles', 'in.json', 'out.json');
    for (const r of rows) assert.equal(r.error, undefined);
    assert.deepEqual(rows[0].candidates, []);
    assert.deepEqual(rows[1].candidates.map((c: { form: string }) => c.form), ['swdefault(x,3,4,5)']);
    assert.deepEqual(rows[2].candidates, []);
    writeFileSync(join(dir, 'apply.json'), JSON.stringify([{ id: 'seeded', text, forms: ['swdefault(x,3,4,5)'] }]));
    const [applied] = run('apply', 'apply.json', 'applied.json');
    assert.deepEqual(applied.applied, ['swdefault(x,3,4,5)']); assert.deepEqual(applied.refused, []);
    assert.equal(applied.text, rows[1].candidates[0].text);
    writeFileSync(join(dir, 'dataTypes.ndjson'), [
      { kind: 'ENUM', name: 'E', size: 4, values: [{ name: 'EXISTING', value: 0 }] },
      { kind: 'ENUM', name: 'Other', size: 4, values: [{ name: 'EXISTING', value: 3 }] },
    ].map(t => JSON.stringify(t)).join('\n') + '\n');
    const ambiguous = run('singles', 'in.json', 'ambiguous.json');
    assert.deepEqual(ambiguous[1].candidates, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
