import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

it('discovers precount only with actual non-null callee-body evidence and roundtrips it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'precount-'));
  try {
    const text = `int Count(Node **buckets){Node *cursor;int count=0;int index=0;do{
      if(buckets[index]){for(cursor=Test::ReadNext(buckets[index]);count++,cursor!=0;cursor=Test::ReadNext(cursor)){}}
      index++;}while(index<8);return count;}`;
    const fn = { name: 'ReadNext', address: '00401000', namespace: 'Test', signature: 'Node * Test::ReadNext(Node *p)',
      returnType: 'Node *', callingConvention: '__cdecl', size: 32, isThunk: false, isExternal: false, hasVarArgs: false,
      parameters: [{ name: 'p', dataType: 'Node *', size: 4, ordinal: 0 }], localVariables: [],
      decompiled: 'Node * Test::ReadNext(Node *p) { if (!p) { Fail(); } return p->next; }' };
    writeFileSync(join(dir, 'dataTypes.ndjson'), JSON.stringify({ name: 'Node', category: '/', kind: 'STRUCTURE', size: 8,
      fields: [{ name: 'next', dataType: 'Node *', offset: 0, size: 4 }] }) + '\n');
    const cli = fileURLToPath(new URL('./candidates.ts', import.meta.url));
    const run = (mode: string, items: unknown, types = true) => {
      writeFileSync(join(dir, 'in.json'), JSON.stringify(items));
      const args = ['--import', 'tsx', cli, mode, join(dir, 'in.json'), join(dir, 'out.json'), '--ops', 'precount'];
      if (types) args.push('--types', join(dir, 'dataTypes.ndjson'));
      const r = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
    };
    writeFileSync(join(dir, 'functions.ndjson'), JSON.stringify(fn) + '\n');
    const [row, observer] = run('singles', [{ id: 'one', text }, { id: 'observed', text: text.replace('index++;', 'Observe(count); index++;') }]);
    assert.deepEqual(row.candidates.map((c: { form: string }) => c.form), ['precount(count,cursor)']);
    assert.deepEqual(observer.candidates, []);
    const [applied] = run('apply', [{ id: 'one', text, forms: ['precount(count,cursor)'] }]);
    assert.deepEqual(applied.applied, ['precount(count,cursor)']);
    assert.equal(applied.text, row.candidates[0].text);
    const [unknown] = run('singles', [{ id: 'one', text }], false);
    assert.deepEqual(unknown.candidates, []);
    for (const decompiled of [fn.decompiled.replace('return p->next;', 'Observe(); return p->next;'), fn.decompiled.replace('p->next', 'p->Other()')]) {
      writeFileSync(join(dir, 'functions.ndjson'), JSON.stringify({ ...fn, decompiled }) + '\n');
      const [blocked] = run('singles', [{ id: 'one', text }]);
      assert.deepEqual(blocked.candidates, []);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
