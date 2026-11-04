import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { rotatedStepWhilePlugin } from '../builtins/rotated-step-while.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(src: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = rotatedStepWhilePlugin.createTransformer({ onSite: e => sites.push(e.copy) });
  return { out: flat(emit(t(parse(src)) as AnyNode)), sites };
}

// FreeGamePalShift 00476fb0.
const SITE = [
  'Node* gpHead;',
  'void f() {',
  '  if (gpHead) {',
  '    Node* pNext;',
  '    do {',
  '      pNext = gpHead->pNext;',
  '      Free(gpHead);',
  '      gpHead = pNext;',
  '    } while (pNext);',
  '    gpHead = 0;',
  '  }',
  '  g();',
  '}',
].join('\n');

describe('rotated-step-while', () => {
  it('loops on the pointer, declares the copy at its store and drops the zero store', () => {
    const r = run(SITE);
    assert.deepStrictEqual(r.sites, ['pNext']);
    assert.ok(r.out.includes('void f() { while (gpHead) { Node* pNext = gpHead->pNext; Free(gpHead); gpHead = pNext; } g(); }'), r.out);
  });

  it('keeps the declaration ahead of the loop when the copy is read before its store', () => {
    const r = run(SITE.replace('      Free(gpHead);', '      Free(gpHead);\n      h(pNext);').replace('      pNext = gpHead->pNext;\n', '      h(pNext);\n      pNext = gpHead->pNext;\n'));
    assert.deepStrictEqual(r.sites, ['pNext']);
    assert.ok(r.out.includes('void f() { Node* pNext; while (gpHead) { h(pNext);'), r.out);
  });

  it('leaves a body with a continue, a non-pointer copy, a store of something else, and an else', () => {
    assert.deepStrictEqual(run(SITE.replace('      Free(gpHead);', '      if (k()) continue;')).sites, []);
    assert.deepStrictEqual(run(SITE.replace('    Node* pNext;', '    int pNext;')).sites, []);
    assert.deepStrictEqual(run(SITE.replace('    gpHead = 0;', '    gpHead = 1;')).sites, []);
    assert.deepStrictEqual(run(SITE.replace('  }\n  g();', '  } else {\n    g();\n  }')).sites, []);
  });

  it('leaves a loop whose last store is not the copy', () => {
    assert.deepStrictEqual(run(SITE.replace('      gpHead = pNext;', '      gpHead = pNext;\n      k();')).sites, []);
  });
});
