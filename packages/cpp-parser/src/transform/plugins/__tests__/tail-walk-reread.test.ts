import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { tailWalkRereadPlugin } from '../builtins/tail-walk-reread.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(src: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = tailWalkRereadPlugin.createTransformer({ onSite: e => sites.push(e.variable) });
  return { out: flat(emit(t(parse(src)) as AnyNode)), sites };
}

// WALL2_InsertUnitDrawBelow 004dcfa0.
const SITE = [
  'void f(Node* p, Node* q) {',
  '  Node* pNext = p->pNext;',
  '  while (pNext) {',
  '    p = p->pNext;',
  '    pNext = p->pNext;',
  '  }',
  '  p->pNext = q;',
  '}',
].join('\n');

describe('tail-walk-reread', () => {
  it('tests the link in memory', () => {
    const r = run(SITE);
    assert.deepStrictEqual(r.sites, ['pNext']);
    assert.ok(r.out.includes('void f(Node* p, Node* q) { while (p->pNext) { p = p->pNext; } p->pNext = q; }'), r.out);
  });

  it('drops a bare declaration of the copy (AllocUiPartyFromRoster 0049a1d0)', () => {
    const r = run('Node* gp; void f(Node* q) { Node* pNext; pNext = gp->pNext; while (pNext) { gp = gp->pNext; pNext = gp->pNext; } gp->pNext = q; }');
    assert.deepStrictEqual(r.sites, ['pNext']);
    assert.ok(r.out.includes('void f(Node* q) { while (gp->pNext) { gp = gp->pNext; } gp->pNext = q; }'), r.out);
  });

  it('leaves a copy read after the loop, or one whose address is taken', () => {
    assert.deepStrictEqual(run(SITE.replace('  p->pNext = q;', '  g(pNext);')).sites, []);
    assert.deepStrictEqual(run(SITE.replace('  p->pNext = q;', '  g(&pNext);')).sites, []);
  });

  it('leaves a body that does more, or steps another link', () => {
    assert.deepStrictEqual(run(SITE.replace('    p = p->pNext;', '    g(p);\n    p = p->pNext;')).sites, []);
    assert.deepStrictEqual(run(SITE.replace('    p = p->pNext;', '    p = p->pPrev;')).sites, []);
  });
});
