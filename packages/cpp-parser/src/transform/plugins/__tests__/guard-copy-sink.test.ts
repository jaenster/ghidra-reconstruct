import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { guardCopySinkPlugin } from '../builtins/guard-copy-sink.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(src: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = guardCopySinkPlugin.createTransformer({ onSite: e => sites.push(e.variable) });
  return { out: flat(emit(t(parse(src)) as AnyNode)), sites };
}

// TEXT_FreeStaticTextBox 0049e300.
const SITE = [
  'Box *gpPopup;',
  'void f() {',
  '  Box* pPopup = gpPopup;',
  '  if (!gpPopup) {',
  '    return;',
  '  }',
  '  g(gpPopup->pList);',
  '  h(pPopup);',
  '  gpPopup = 0;',
  '}',
].join('\n');

describe('guard-copy-sink', () => {
  it('moves the copy below the guard on the value it copies', () => {
    const r = run(SITE);
    assert.deepStrictEqual(r.sites, ['pPopup']);
    assert.ok(r.out.includes('void f() { if (!gpPopup) { return; } Box* pPopup = gpPopup; g(gpPopup->pList);'), r.out);
  });

  it('leaves a guard on the local itself, and an exit that reads it', () => {
    assert.deepStrictEqual(run(SITE.replace('if (!gpPopup)', 'if (!pPopup)')).sites, []);
    assert.deepStrictEqual(run(SITE.replace('    return;', '    h(pPopup);\n    return;')).sites, []);
  });

  it('leaves a copy of a parameter, and a copy in a loop', () => {
    assert.deepStrictEqual(run('void f(Box *p) { Box* q = p; if (!p) { return; } h(q); }').sites, []);
    assert.deepStrictEqual(run('Box *gp; void f() { while (g()) { Box* q = gp; if (!gp) { return; } h(q); } }').sites, []);
  });

  it('leaves an exit that falls through, and a local whose address is taken', () => {
    assert.deepStrictEqual(run(SITE.replace('    return;', '    g(0);')).sites, []);
    assert.deepStrictEqual(run(SITE.replace('  h(pPopup);', '  h(&pPopup);')).sites, []);
  });
});
