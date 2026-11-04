import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { copiedTestWhilePlugin } from '../builtins/copied-test-while.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(src: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = copiedTestWhilePlugin.createTransformer({ onSite: e => sites.push(e.variable) });
  return { out: flat(emit(t(parse(src)) as AnyNode)), sites };
}

// BNNEWS_RoundToPowerOfTwo 0051d2f0.
const SITE = [
  'unsigned f(unsigned dwSize) {',
  '  unsigned uStripped;',
  '  if (dwSize < 8) {',
  '    unsigned uHighBit;',
  '    uStripped = dwSize - 1 & dwSize;',
  '    while (true) {',
  '      uHighBit = uStripped;',
  '      if (!uHighBit) {',
  '        break;',
  '      }',
  '      dwSize = uHighBit;',
  '      uStripped = uHighBit - 1 & uHighBit;',
  '    }',
  '  }',
  '  return dwSize;',
  '}',
].join('\n');

describe('copied-test-while', () => {
  it('tests and clears the low bit on the value itself', () => {
    const r = run(SITE);
    assert.deepStrictEqual(r.sites, ['dwSize']);
    assert.ok(r.out.includes('unsigned int f(unsigned int dwSize) { if (dwSize < 8) { while (dwSize & dwSize - 1) { dwSize &= dwSize - 1; } } return dwSize; }'), r.out);
  });

  it('writes another value as a plain store', () => {
    const r = run(SITE.replace('dwSize - 1 & dwSize;', 'dwSize >> 1;').replace('uHighBit - 1 & uHighBit;', 'uHighBit >> 1;'));
    assert.deepStrictEqual(r.sites, ['dwSize']);
    assert.ok(r.out.includes('while (dwSize >> 1) { dwSize = dwSize >> 1; }'), r.out);
  });

  it('leaves a copy read after the loop, a next value of another shape, and a call', () => {
    assert.deepStrictEqual(run(SITE.replace('  return dwSize;', '  return uStripped;')).sites, []);
    assert.deepStrictEqual(run(SITE.replace('uHighBit - 1 & uHighBit;', 'uHighBit - 2 & uHighBit;')).sites, []);
    assert.deepStrictEqual(run(SITE.replace('dwSize - 1 & dwSize;', 'g(dwSize);').replace('uHighBit - 1 & uHighBit;', 'g(uHighBit);')).sites, []);
  });
});
