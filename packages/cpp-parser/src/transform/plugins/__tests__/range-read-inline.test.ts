import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { rangeReadInlinePlugin } from '../builtins/range-read-inline.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const STRUCTS = { Chan: { nSoundId: 'int', bStop: 'int', pNext: 'Chan *' } };

function run(src: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = rangeReadInlinePlugin.createTransformer({ structFields: STRUCTS, onSite: e => sites.push(`${e.variable}=${e.read}:${e.uses}`) });
  return { out: flat(emit(t(parse(src)) as AnyNode)), sites };
}

// SOUND_DebugPrintChannels 004baa50: the original compares the member twice (cmp; jl; cmp; jg).
const SITE = [
  'void f(Chan *pChan) {',
  '  int nSoundId;',
  '  nSoundId = pChan->nSoundId;',
  '  if (nSoundId >= 0xb76 && nSoundId <= 0x1230) {',
  '    g(nSoundId);',
  '    pChan->bStop = 1;',
  '  }',
  '}',
].join('\n');

describe('range-read-inline', () => {
  it('reads the member at each use of a local a constant range test reads', () => {
    const r = run(SITE);
    assert.deepStrictEqual(r.sites, ['nSoundId=pChan->nSoundId:3']);
    assert.ok(r.out.includes('void f(Chan* pChan) { if (pChan->nSoundId >= 0xb76 && pChan->nSoundId <= 0x1230) { g(pChan->nSoundId); pChan->bStop = 1; } }'), r.out);
  });

  it('takes the declaration with its value', () => {
    const r = run('int f(char *s) { char c = *s; if (c >= 0x41 && c <= 0x5a) { return 1; } return 0; }');
    assert.ok(r.out.includes('if (*s >= 0x41 && *s <= 0x5a)'), r.out);
  });

  // The declaration sits at the top of the function, the assignment in the loop body.
  it('takes a local declared in an enclosing block', () => {
    const src = [
      'void f(Chan *pHead) {',
      '  int nSoundId;',
      '  for (Chan *p = pHead; p; p = p->pNext) {',
      '    nSoundId = p->nSoundId;',
      '    if (nSoundId >= 0xb76 && nSoundId <= 0x1230) { g(nSoundId); }',
      '  }',
      '}',
    ].join('\n');
    const r = run(src);
    assert.deepStrictEqual(r.sites, ['nSoundId=p->nSoundId:3']);
    assert.ok(r.out.includes('void f(Chan* pHead) { for (Chan* p = pHead; p; p = p->pNext) { if (p->nSoundId >= 0xb76 && p->nSoundId <= 0x1230) { g(p->nSoundId); } } }'), r.out);
    const after = src.replace('  }\n}', '  }\n  h(nSoundId);\n}');
    assert.deepStrictEqual(run(after).sites, []);
  });

  // D2WINEDITBOX_FilterLetterChar 004fe790: the inverted test.
  it('takes the inverted test', () => {
    const r = run("int f(char *s) { char c = *s; if (!((c < 'a' || c > 'z') && (c < 'A' || c > 'Z'))) { return 1; } return 0; }");
    assert.ok(r.out.includes("if (!((*s < 'a' || *s > 'z') && (*s < 'A' || *s > 'Z')))"), r.out);
  });

  it('leaves a local read after a call', () => {
    const src = SITE.replace('    g(nSoundId);\n    pChan->bStop = 1;', '    g(0);\n    h(nSoundId);');
    assert.deepStrictEqual(run(src).sites, []);
  });

  it('leaves a local read after a store', () => {
    const src = SITE.replace('    g(nSoundId);\n    pChan->bStop = 1;', '    pChan->bStop = 1;\n    h(nSoundId);');
    assert.deepStrictEqual(run(src).sites, []);
  });

  it('leaves a local read after its pointer moves', () => {
    const src = SITE.replace('    g(nSoundId);\n    pChan->bStop = 1;', '    pChan = pChan->pNext;\n    h(nSoundId);');
    assert.deepStrictEqual(run(src).sites, []);
  });

  it('leaves a bound that is not a constant, and a type that differs', () => {
    assert.deepStrictEqual(run(SITE.replace('nSoundId <= 0x1230', 'nSoundId <= pChan->bStop')).sites, []);
    assert.deepStrictEqual(run(SITE.replace('  int nSoundId;', '  short nSoundId;')).sites, []);
  });

  it('leaves a local read in a loop that stores', () => {
    const src = [
      'void f(Chan *pChan) {',
      '  int n = pChan->nSoundId;',
      '  if (n >= 1 && n <= 5) { g(0); }',
      '}',
    ].join('\n');
    assert.deepStrictEqual(run(src).sites, ['n=pChan->nSoundId:2']);
    const loop = [
      'void f(Chan *pChan) {',
      '  int n = pChan->nSoundId;',
      '  while (pChan->bStop) { if (n >= 1 && n <= 5) { pChan->bStop = 0; } }',
      '}',
    ].join('\n');
    assert.deepStrictEqual(run(loop).sites, []);
  });
});
