import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

it('discovers precise fence anchors and measures the same body application emits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fence-candidates-'));
  try {
    const text = 'void f(Node* p) { p->next = 0; p->prev = 0; if (p->payload) use(p->payload); }';
    const twice = text.replace(' }', ' p->next = 0; p->prev = 0; if (p->payload) use(p->payload); }');
    const fields = ['next', 'prev', 'payload'].map((name, i) => ({ name, dataType: 'Node*', offset: i * 4, size: 4 }));
    writeFileSync(join(dir, 'dataTypes.ndjson'), JSON.stringify({ kind: 'STRUCTURE', name: 'Node', size: 12, fields }) + '\n');
    writeFileSync(join(dir, 'functions.ndjson'), '');
    writeFileSync(join(dir, 'in.json'), JSON.stringify([
      { id: 'one', text }, { id: 'two', text: twice },
      { id: 'gap', text: text.replace('p->prev', 'touch(); p->prev') },
      { id: 'unknown', text: text.replace('Node*', 'Unknown*') },
    ]));
    const cli = fileURLToPath(new URL('./candidates.ts', import.meta.url));
    const run = (mode: string, input: string, output: string) => {
      const p = spawnSync(process.execPath, ['--import', 'tsx', cli, mode, join(dir, input), join(dir, output), '--types', join(dir, 'dataTypes.ndjson'), '--ops', 'fence'], { encoding: 'utf8' });
      assert.equal(p.status, 0, p.stdout + p.stderr);
      return JSON.parse(readFileSync(join(dir, output), 'utf8'));
    };
    const rows = run('singles', 'in.json', 'out.json');
    for (const row of rows) assert.equal(row.error, undefined);
    assert.deepEqual(rows[0].candidates.map((c: { form: string }) => c.form), ['fence(p->next,p->prev)']);
    assert.deepEqual(rows[1].candidates.map((c: { form: string }) => c.form), ['fence(p->next,p->prev,@1)', 'fence(p->next,p->prev,@2)']);
    assert.deepEqual(rows[2].candidates, []); assert.deepEqual(rows[3].candidates, []);
    writeFileSync(join(dir, 'apply.json'), JSON.stringify([{ id: 'one', text, forms: ['fence(p->next,p->prev)'] }]));
    const [applied] = run('apply', 'apply.json', 'applied.json');
    assert.deepEqual(applied.applied, ['fence(p->next,p->prev)']); assert.deepEqual(applied.refused, []);
    assert.equal(applied.text, rows[0].candidates[0].text);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
