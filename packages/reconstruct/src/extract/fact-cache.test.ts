/**
 * The fact cache answers "current" only when every stamp and the decompile text agree,
 * names the first thing that moved otherwise, and survives a save and a load. A script
 * change drops the whole file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FactCache, type FactEntry } from './fact-cache.js';
import { javaStringHash } from './compare-sites.js';
import { parseFunctionFacts, selectFacts } from './function-facts.js';
import type { FunctionStamps } from './function-stamps.js';

const TEXT = 'void f(void)\n{\n  if (a == 1) {\n    g();\n  }\n  return;\n}\n';

function entry(): FactEntry {
  return {
    program: 'p1', self: 's1',
    deps: { '42': { full: 'F42', shape: 'S42' }, '7': { full: 'F7', shape: 'S7' } },
    textHash: javaStringHash(TEXT), textLength: TEXT.length,
    facts: { haltLines: { halts: [] } },
  };
}

function stamps(over: Partial<{ program: string; self: string; t42: { full: string; shape: string } }> = {}): FunctionStamps {
  return {
    program: over.program ?? 'p1',
    self: new Map([['00401000', over.self ?? 's1']]),
    types: new Map([['42', over.t42 ?? { full: 'F42', shape: 'S42' }], ['7', { full: 'F7', shape: 'S7' }]]),
  };
}

describe('FactCache.check', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fact-cache-'));
  const cache = new FactCache('test', 'v1', dir);
  cache.put('00401000', entry());

  it('is current when everything matches', () => {
    assert.strictEqual(cache.check('00401000', TEXT, stamps()), null);
  });
  it('names the first thing that moved', () => {
    assert.strictEqual(cache.check('00402000', TEXT, stamps()), 'new');
    assert.strictEqual(cache.check('00401000', TEXT, stamps({ program: 'p2' })), 'program');
    assert.strictEqual(cache.check('00401000', TEXT, stamps({ self: 's2' })), 'self');
    assert.strictEqual(cache.check('00401000', TEXT, stamps({ t42: { full: 'F42b', shape: 'S42b' } })), 'type-shape');
    assert.strictEqual(cache.check('00401000', TEXT, stamps({ t42: { full: 'F42b', shape: 'S42' } })), 'type-name');
    assert.strictEqual(cache.check('00401000', TEXT.replace('g()', 'h()'), stamps()), 'text');
  });
  it('treats a type the stamps no longer report as moved', () => {
    const s = stamps();
    s.types.delete('7');
    assert.strictEqual(cache.check('00401000', TEXT, s), 'type-shape');
  });
  it('finds dependents by type id', () => {
    assert.deepStrictEqual(cache.dependents(['7']), ['00401000']);
    assert.deepStrictEqual(cache.dependents(['8']), []);
  });
  it('round-trips, and a script change drops the file', () => {
    cache.setProgram('p1');
    cache.save();
    const again = new FactCache('test', 'v1', dir);
    assert.deepStrictEqual(again.get('00401000'), entry());
    assert.strictEqual(new FactCache('test', 'v2', dir).size, 0);
  });
});

describe('parseFunctionFacts / selectFacts', () => {
  const h = javaStringHash(TEXT).toString(16);
  const out = [
    'P\tprog',
    `F\t00401000\tself1\t${h}\t${TEXT.length}\t1`,
    'S\t0\t==\tINT_EQUAL\t4\t1\t1\tv:a\tc:1\t00401003\t00401006\tJNZ\t00401003\tCMP\t4\tm\ti\t1\t1',
    'B\t00401000\t7\t2:0;3:3,6\t3:6\t3:==,CMP,-,-,1,4,3',
    'O\t00401000\t7\t',
    'D\t42,F42,S42',
    'F\t00402000\tself2\tfail',
  ].join('\n');

  it('reads one row per function and drops failed ones', () => {
    const p = parseFunctionFacts(out);
    assert.strictEqual(p.program, 'prog');
    assert.deepStrictEqual([...p.rows.keys()], ['00401000']);
    const r = p.rows.get('00401000')!;
    assert.strictEqual(r.self, 'self1');
    assert.strictEqual(r.stable, true);
    assert.deepStrictEqual(r.deps, { '42': { full: 'F42', shape: 'S42' } });
  });
  it('attaches what each extractor would have, behind the text gate', () => {
    const r = parseFunctionFacts(out).rows.get('00401000')!;
    const f = selectFacts(TEXT, '00401000', r, true);
    assert.ok(f.compareSites?.startsWith('0\t==\tINT_EQUAL'));
    assert.strictEqual(f.branchLayout?.lineCount, 7);
    assert.strictEqual(f.callOrder, undefined, 'no temporary holds a call');
    assert.strictEqual(selectFacts(TEXT, '00401000', r, false).compareSites, undefined);
    assert.strictEqual(selectFacts(TEXT + ' ', '00401000', r, true).compareSites, undefined, 'another text');
  });
});
