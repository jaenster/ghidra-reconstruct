import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { linkNextSelectPlugin } from '../builtins/link-next-select.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = linkNextSelectPlugin.createTransformer({ onSite: (e: { name: string }) => sites.push(e.name) } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

const PRELUDE = [
  'struct Head { int a; int b; int pNext; };',
].join('\n');

// TSList_HANDLER_UnlinkAll 0041c770, as printed (the node unlink reduced to a counter).
const unlinkAll = [
  'int f(Head* pList, int* pPool) {',
  '  int* pNode;',
  '  int n = 0;',
  '  while (true) {',
  '    int pNext;',
  '    pNode = (int*)pList->pNext;',
  '    if ((int)pNode <= 0) {',
  '      break;',
  '    }',
  '    n++;',
  '    pNext = *pNode;',
  '    pList->pNext = pNext;',
  '  }',
  '  return n;',
  '}',
].join('\n');

describe('link-next-select', () => {
  it('writes the sign test as the next-node select and a null test', () => {
    const { out, sites } = run(unlinkAll);
    assert.deepStrictEqual(sites, ['pNode']);
    assert.ok(out.includes('pNode = (int)(int*)pList->pNext > 0 ? (int*)pList->pNext : 0; if (!pNode) { break; }'), out);
  });

  it('takes a declaration and for (;;)', () => {
    const code = unlinkAll.replace('  int* pNode;\n', '').replace('while (true)', 'for (;;)').replace('    pNode = (int*)', '    int* pNode = (int*)');
    const { out, sites } = run(code);
    assert.deepStrictEqual(sites, ['pNode']);
    assert.ok(out.includes('int* pNode = (int)(int*)pList->pNext > 0 ? (int*)pList->pNext : 0;'), out);
  });

  it('leaves a link read after the loop, a value that calls, and a loop with a condition', () => {
    assert.deepStrictEqual(run(unlinkAll.replace('  return n;', '  return n + (int)pNode;')).sites, []);
    assert.deepStrictEqual(run(unlinkAll.replace('(int*)pList->pNext;', '(int*)Get(pList);')).sites, []);
    assert.deepStrictEqual(run(unlinkAll.replace('while (true)', 'while (n < 9)')).sites, []);
    assert.deepStrictEqual(run(unlinkAll.replace('(int)pNode <= 0', '(int)pNode <= 1')).sites, []);
    assert.deepStrictEqual(run(unlinkAll.replace('      break;', '      return 0;')).sites, []);
  });

  it('computes what the printed form computes (compiled)', { skip: !hasNativeGpp() }, () => {
    const a = run(unlinkAll).out;
    const prelude = [PRELUDE, unlinkAll.replace('int f(', 'int f0('), a.replace('int f(', 'int f1(')].join('\n');
    const res = compileAndRun(prelude, [
      'int chain[4] = {0, 0, 0, -8};',
      'for (int k = -1; k < 4; k++) {',
      '  Head h0 = {0, 0, k < 0 ? k : (k == 0 ? 0 : (int)(long)&chain[4 - k])}; Head h1 = h0;',
      '  chain[1] = (int)(long)&chain[2]; chain[2] = (int)(long)&chain[3]; chain[3] = -8;',
      '  int x = f0(&h0, 0);',
      '  chain[1] = (int)(long)&chain[2]; chain[2] = (int)(long)&chain[3]; chain[3] = -8;',
      '  printf("%d/%d\\n", x, f1(&h1, 0));',
      '}',
    ].join('\n'));
    for (const line of res.trim().split('\n')) {
      const [x, y] = line.split('/');
      assert.strictEqual(x, y, res);
    }
  });
});
