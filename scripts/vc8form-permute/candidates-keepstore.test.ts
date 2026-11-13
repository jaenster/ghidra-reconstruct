import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

it('discovers only the guarded existing zero with snapshot field layouts', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'keepstore-candidates-'));
  const source = 'void f(Link* p) { p->prev = 0; p->next = 0; p->prev = p; }';
  try {
    writeFileSync(join(dir, 'in.json'), JSON.stringify([{ id: 'f', text: source }, { id: 'call', text: source.replace('p->next = 0;', 'g(p);') }]));
    writeFileSync(join(dir, 'dataTypes.ndjson'), JSON.stringify({ kind: 'STRUCTURE', name: 'Link', size: 8, fields: [
      { name: 'prev', dataType: 'Link*', offset: 0, size: 4 }, { name: 'next', dataType: 'int', offset: 4, size: 4 },
    ] }) + '\n');
    writeFileSync(join(dir, 'functions.ndjson'), '');
    const run = (typed: boolean) => {
      const r = spawnSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'scripts/vc8form-permute/candidates.ts'),
        'singles', join(dir, 'in.json'), join(dir, 'out.json'), '--ops', 'keepstore', ...(typed ? ['--types', join(dir, 'dataTypes.ndjson')] : [])], { cwd: root, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
    };
    const typed = run(true);
    assert.deepEqual(typed[0].candidates.map((x: { form: string }) => x.form), ['keepstore(p->prev,1)']);
    assert.match(typed[0].candidates[0].text, /volatile Link/);
    assert.deepEqual(typed[1].candidates, []);
    assert.deepEqual(run(false)[0].candidates, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
