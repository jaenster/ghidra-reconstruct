import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { searchLoopExitPlugin } from '../builtins/search-loop-exit.js';

const PRELUDE = 'struct Node { int nId; Node *pNext; };';
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = searchLoopExitPlugin.createTransformer({ onSite: (e: { function: string; variable: string }) => sites.push(`${e.function}:${e.variable}`) } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

// DRLGWARP_UpdateWarpRoomExSelect, 0066ab90, as printed.
const search = (exit: string, after = '') => [
  'int f(Node *pHead, int nId) {',
  '  Node *p = pHead;',
  '  int n = 0;',
  `  if (!p) { ${exit} }`,
  '  while (p->nId != nId) {',
  '    p = p->pNext;',
  '    n++;',
  `    if (!p) { ${exit} }`,
  '  }',
  after,
  '  return n * 100 + p->nId;',
  '}',
].join('\n');

describe('search-loop-exit', () => {
  // UpdateLifeAndArea 00479010: the guard tests the global the search starts from.
  it('takes a guard on the value the pointer was just given', () => {
    const code = [
      'Node *gpHead;',
      'void f(int nId, int v) {',
      '  Node *p;',
      '  p = gpHead;',
      '  if (!gpHead) { return; }',
      '  while (p->nId != nId) {',
      '    p = p->pNext;',
      '    if (!p) { return; }',
      '  }',
      '  p->nId = v;',
      '}',
    ].join('\n');
    const { out, sites } = run(code);
    assert.deepStrictEqual(sites, ['f:p']);
    assert.ok(out.includes('p = gpHead; while (p) { if (p->nId == nId) break; p = p->pNext; } if (!p) { return; } p->nId = v;'), out);
  });

  it('leaves a guard on a value the pointer was not given', () => {
    const code = [
      'Node *gpHead; Node *gpOther;',
      'void f(int nId, int v) {',
      '  Node *p;',
      '  p = gpHead;',
      '  if (!gpOther) { return; }',
      '  while (p->nId != nId) {',
      '    p = p->pNext;',
      '    if (!p) { return; }',
      '  }',
      '  p->nId = v;',
      '}',
    ].join('\n');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('loops on the pointer and tests it once after the loop', () => {
    const { out, sites } = run(search('return -1;'));
    assert.deepStrictEqual(sites, ['f:p']);
    assert.ok(out.includes('while (p) { if (p->nId == nId) break; p = p->pNext; n++; } if (!p) { return -1; } return n * 100'), out);
  });

  it('drops a copy of the exit test straight after the loop', () => {
    // D2WINLIST_GetSelectedIndex, 00507000, prints the test a third time.
    const { out } = run(search('return -1;', '  if (!p) { return -1; }'));
    assert.strictEqual(out.split('if (!p)').length - 1, 1, out);
  });

  it('leaves a short-circuit loop condition alone', () => {
    // GetSkillByIdAndOwner, 006439b0, matches as printed.
    const code = search('return -1;').replace('while (p->nId != nId)', 'while (p->nId != nId || p->pNext == pHead)');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('takes an unbraced guard and a braced bottom test as the same exit', () => {
    // GFX_IsUnitOnScreen, 0045a6c0: the pipeline holds the guard as a bare return and the
    // bottom test as a block; only the emitter braces both.
    const code = search('return -1;').replace('  if (!p) { return -1; }', '  if (!p) return -1;');
    const { out, sites } = run(code);
    assert.deepStrictEqual(sites, ['f:p']);
    assert.ok(out.includes('while (p) { if (p->nId == nId) break; p = p->pNext; n++; } if (!p) return -1; return n * 100'), out);
  });

  it('drops an unbraced copy of the exit test after the loop', () => {
    const code = search('return -1;', '  if (!p) return -1;').replace('  if (!p) { return -1; }', '  if (!p) return -1;');
    const { out } = run(code);
    assert.strictEqual(out.split('if (!p)').length - 1, 1, out);
  });

  it('needs the same exit when only one side is braced', () => {
    const code = search('return -1;').replace('  if (!p) { return -1; }', '  if (!p) return -2;');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('needs the same exit in the guard and at the bottom', () => {
    const code = search('return -1;').replace('    if (!p) { return -1; }', '    if (!p) { return -2; }');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('needs the exit to return', () => {
    const code = search('n = 7;');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('leaves a body with a continue, a break or a goto alone', () => {
    for (const jump of ['if (n == 3) continue;', 'if (n == 3) break;', 'if (n == 3) goto out;']) {
      const code = search('return -1;').replace('    n++;', `    n++;\n    ${jump}`);
      assert.deepStrictEqual(run(code).sites, [], jump);
    }
  });

  it('keeps a break of an inner loop', () => {
    const code = search('return -1;').replace('    n++;', '    n++;\n    for (;;) { break; }');
    assert.deepStrictEqual(run(code).sites, ['f:p']);
  });

  it('leaves a pointer whose address is taken, or a condition that calls', () => {
    const addressed = search('return -1;').replace('  int n = 0;', '  int n = 0;\n  Node **pp = &p;');
    assert.deepStrictEqual(run(addressed).sites, []);
    const calls = search('return -1;').replace('while (p->nId != nId)', 'while (g(p) != nId)');
    assert.deepStrictEqual(run(calls).sites, []);
  });

  it('computes what the printed loop computes (compiled)', { skip: !hasNativeGpp() }, () => {
    const code = search('return -1;', '  if (!p) { return -1; }');
    const { out } = run(code);
    const prelude = [PRELUDE, code.replace('int f(', 'int before('), out.replace('int f(', 'int after(')].join('\n');
    const r = compileAndRun(prelude, [
      'Node c = {3, 0}, b = {2, &c}, a = {1, &b};',
      'for (int id = 0; id < 5; id++) {',
      '  printf("%d %d\\n", before(&a, id), after(&a, id));',
      '  printf("%d %d\\n", before(0, id), after(0, id));',
      '}',
    ].join('\n'));
    for (const row of r.trim().split('\n')) {
      const [x, y] = row.split(' ');
      assert.strictEqual(x, y, r);
    }
  });
});
