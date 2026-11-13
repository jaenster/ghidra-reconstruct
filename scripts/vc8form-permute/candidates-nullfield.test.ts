import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = 'int* Choose(S* p, int c) { if (c) return &p->n; return (int*)4; }';
const fields = [{ name: 'n', dataType: 'int', offset: 4, size: 4 }];

function collect(info: object | undefined, fieldList = fields, text = source) {
  const dir = mkdtempSync(join(tmpdir(), 'vc8-nullfield-'));
  try {
    writeFileSync(join(dir, 'in.json'), JSON.stringify([{ id: 'f', text }]));
    writeFileSync(join(dir, 'dataTypes.ndjson'), JSON.stringify({ name: 'S', kind: 'STRUCTURE', size: 8, fields: fieldList }) + '\n');
    writeFileSync(join(dir, 'functions.ndjson'), '');
    if (info) writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ provenance: { programInfo: info } }));
    const result = spawnSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'),
      fileURLToPath(new URL('./candidates.ts', import.meta.url)), 'singles', join(dir, 'in.json'), join(dir, 'out.json'),
      '--types', join(dir, 'dataTypes.ndjson'), '--ops', 'nullfield'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const [row] = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
    assert.equal(row.error, undefined);
    return row.candidates as Array<{ form: string; text: string }>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('nullfield collector uses real snapshot context', () => {
  it('discovers a generic field address with languageId and no architecture property', () => {
    const result = collect({ languageId: 'x86:LE:32:default', pointerSize: 4 });
    assert.deepEqual(result.map(c => c.form), ['nullfield(p,S,n)']);
    assert.match(result[0].text, /\(uint32_t\)\(uintptr_t\)/);
  });

  it('refuses absent, non-x86, and non-32-bit target identity', () => {
    for (const info of [undefined, { architecture: 'x86', pointerSize: 4 },
      { languageId: 'ARM:LE:32:v7', pointerSize: 4 },
      { languageId: 'x86:LE:64:default', pointerSize: 8 },
      { languageId: 'x86:LE:32:default', pointerSize: 8 }]) assert.deepEqual(collect(info), []);
  });

  it('refuses mismatched offsets and side effects using the same candidate path', () => {
    const info = { languageId: 'x86:LE:32:default', pointerSize: 4 };
    assert.deepEqual(collect(info, [{ ...fields[0], offset: 8 }]), []);
    assert.deepEqual(collect(info, fields, source.replace('if (c)', 'if (Touch())')), []);
  });
});
