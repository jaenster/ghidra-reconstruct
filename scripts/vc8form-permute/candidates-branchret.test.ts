import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function collect(source: string, valueType = 'Counter', includeFacts = true) {
  const dir = mkdtempSync(join(tmpdir(), 'vc8-branchret-'));
  try {
    writeFileSync(join(dir, 'in.json'), JSON.stringify([{ id: 'f', text: source }]));
    const types = includeFacts ? [
      { kind: 'TYPEDEF', name: 'Counter', underlyingType: 'uint32_t', size: 4 },
      { kind: 'STRUCTURE', name: 'Reader', size: 8, fields: [
        { name: 'position', dataType: valueType, offset: 0, size: 4 },
        { name: 'pending', dataType: 'uint8_t', offset: 4, size: 1 },
      ] },
    ] : [];
    writeFileSync(join(dir, 'dataTypes.ndjson'), types.map(x => JSON.stringify(x)).join('\n'));
    writeFileSync(join(dir, 'functions.ndjson'), '');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = spawnSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'),
      fileURLToPath(new URL('./candidates.ts', import.meta.url)), 'singles', join(dir, 'in.json'), join(dir, 'out.json'),
      '--types', join(dir, 'dataTypes.ndjson'), '--ops', 'branchret'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const [row] = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
    assert.equal(row.error, undefined);
    return row.candidates as Array<{ form: string; text: string }>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('branchret collector candidates', () => {
  const source = 'uint32_t Next(Reader* reader) { Counter count = reader->position; if (reader->pending) count++; return count; }';

  it('discovers a renamed family through --ops branchret and resolves real typedef facts', () => {
    const result = collect(source);
    assert.deepEqual(result.map(x => x.form), ['branchret(count)']);
    assert.match(result[0].text, /if \(reader->pending\)/);
    assert.doesNotMatch(result[0].text, /count/);
  });

  it('refuses missing field facts, changed signedness, side effects, and volatile receivers', () => {
    assert.deepEqual(collect(source, 'Counter', false), []);
    assert.deepEqual(collect(source, 'int32_t'), []);
    assert.deepEqual(collect(source.replace('reader->pending)', 'Probe())')), []);
    assert.deepEqual(collect(source.replace('Reader* reader', 'volatile Reader* reader')), []);
  });
});
