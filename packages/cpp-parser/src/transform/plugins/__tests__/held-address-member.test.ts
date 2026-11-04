import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { heldAddressMemberPlugin } from '../builtins/held-address-member.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = heldAddressMemberPlugin.createTransformer({ onSite: (e: { name: string; uses: number }) => sites.push(`${e.name}:${e.uses}`) } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

const PRELUDE = [
  '#include <stdint.h>',
  'struct Link { Link* m_prevlink; int m_next; };',
  'struct List { int m_linkoffset; Link m_terminator; };',
  // The getter's result is where the back link goes; one cell per call keeps it observable.
  'static int g_back[4]; static int g_calls;',
  '#define D2_StormNextLink(p, off) ((intptr_t)&g_back[g_calls++ & 3])',
].join('\n');

// Destructor_Unreferenced 0044fc20 after its UnlinkAll call, as printed.
const unlinkTerminator = [
  'void f(List* pThis) {',
  '  int* pPrevLink;',
  '  Link* pTVar1 = &pThis->m_terminator;',
  '  Link* pNext = pTVar1->m_prevlink;',
  '  if (!pNext) {',
  '    return;',
  '  }',
  '  pPrevLink = (int*)D2_StormNextLink(pTVar1, -1);',
  '  *pPrevLink = (int)(intptr_t)pNext;',
  '  pTVar1->m_prevlink->m_next = pThis->m_terminator.m_next;',
  '  pTVar1->m_prevlink = 0;',
  '  pThis->m_terminator.m_next = 0;',
  '}',
].join('\n');

describe('held-address-member', () => {
  it('addresses the terminator link through the local', () => {
    const { out, sites } = run(unlinkTerminator);
    assert.deepStrictEqual(sites, ['pTVar1:2']);
    assert.ok(out.includes('pTVar1->m_prevlink->m_next = pTVar1->m_next;'), out);
    assert.ok(out.includes('pTVar1->m_next = 0;'), out);
    assert.ok(!out.includes('pThis->m_terminator.m_next'), out);
  });

  it('leaves a link the next-link getter does not run on, a moved root, and a second definition', () => {
    // TSList::SetLinkOffset 0044ee30 names the terminator off the list in the original.
    assert.deepStrictEqual(run(unlinkTerminator.replace('D2_StormNextLink(pTVar1, -1)', 'D2_StormNextLink(pNext, -1)')).sites, []);
    assert.deepStrictEqual(run(unlinkTerminator.replace('  pTVar1->m_prevlink = 0;', '  pThis = 0;')).sites, []);
    assert.deepStrictEqual(run(unlinkTerminator.replace('  pTVar1->m_prevlink = 0;', '  pTVar1 = 0;')).sites, []);
    assert.deepStrictEqual(run(unlinkTerminator.replace('  pTVar1->m_prevlink = 0;', '  g(&pThis);')).sites, []);
    assert.deepStrictEqual(run(unlinkTerminator.replace('  int* pPrevLink;', '  int* pPrevLink;\n  List* q = pThis;').replace('&pThis->m_terminator', '&q->m_terminator').replace('  pTVar1->m_prevlink = 0;', '  q = q + 1;')).sites, []);
  });

  it('leaves a path through a second pointer', () => {
    const code = [
      'struct Outer { List* pList; };',
      'void f(Outer* pThis) {',
      '  Link* pTVar1 = &pThis->pList->m_terminator;',
      '  int x = D2_StormNextLink(pTVar1, -1);',
      '  pThis->pList->m_terminator.m_next = x;',
      '}',
    ].join('\n');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('computes what the printed form computes (compiled)', { skip: !hasNativeGpp() }, () => {
    const a = run(unlinkTerminator).out;
    const prelude = [PRELUDE, unlinkTerminator.replace('void f(', 'void f0('), a.replace('void f(', 'void f1(')].join('\n');
    const res = compileAndRun(prelude, [
      'for (int k = 0; k < 2; k++) {',
      '  Link a[2]; List l[2];',
      '  for (int j = 0; j < 2; j++) {',
      '    a[j].m_prevlink = 0; a[j].m_next = 40;',
      '    l[j].m_linkoffset = 0; l[j].m_terminator.m_prevlink = k ? &a[j] : 0; l[j].m_terminator.m_next = 7;',
      '  }',
      '  g_calls = 0; f0(&l[0]); int b0 = g_back[0] == (int)(intptr_t)&a[0];',
      '  g_calls = 0; f1(&l[1]); int b1 = g_back[0] == (int)(intptr_t)&a[1];',
      '  printf("%d %d %d %d/%d %d %d %d\\n", l[0].m_terminator.m_prevlink != 0, l[0].m_terminator.m_next, a[0].m_next, k ? b0 : 1,',
      '    l[1].m_terminator.m_prevlink != 0, l[1].m_terminator.m_next, a[1].m_next, k ? b1 : 1);',
      '}',
    ].join('\n'));
    for (const line of res.trim().split('\n')) {
      const [x, y] = line.split('/');
      assert.strictEqual(x, y, res);
    }
  });
});
