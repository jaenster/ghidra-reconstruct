import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { accumulateSumPlugin } from '../builtins/accumulate-sum.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = accumulateSumPlugin.createTransformer({ onSite: (e: { target: string; operand: string }) => sites.push(`${e.target}+${e.operand}`) } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

const PRELUDE = 'int g_n; int Stat(int k) { g_n++; return k * 3 + g_n; } int Queue(int a, int b) { return a * 1000 + b; }';

// SendMercPackets, 005726c0, as printed.
const merc = [
  'int f(int k) {',
  '  int r = 0;',
  '  int nTmp = Stat(k);',
  '  int nSecond = Stat(k + 1);',
  '  r += Queue(0x15, nTmp + nSecond);',
  '  nTmp = Stat(k + 2);',
  '  nSecond = Stat(k + 3);',
  '  r += Queue(0x16, nSecond + nTmp);',
  '  return r;',
  '}',
].join('\n');

describe('accumulate-sum', () => {
  it('accumulates into the first variable', () => {
    const { out, sites } = run(merc);
    assert.deepStrictEqual(sites, ['nTmp+nSecond', 'nTmp+nSecond']);
    assert.ok(out.includes('int nTmp = Stat(k); int nSecond; nTmp += (int)Stat(k + 1); r += Queue(0x15, nTmp);'), out);
    assert.ok(out.includes('nTmp = Stat(k + 2); nTmp += (int)Stat(k + 3); r += Queue(0x16, nTmp);'), out);
  });

  it('leaves a sum whose first operand is read again', () => {
    const code = merc.replace('  nTmp = Stat(k + 2);', '  r += nTmp;\n  nTmp = Stat(k + 2);');
    assert.deepStrictEqual(run(code).sites, ['nTmp+nSecond']);
  });

  it('leaves a sum whose second operand is read again', () => {
    const code = merc.replace('  r += Queue(0x16, nSecond + nTmp);', '  r += Queue(0x16, nSecond + nTmp);\n  r += nSecond;');
    assert.deepStrictEqual(run(code).sites, ['nTmp+nSecond']);
  });

  it('needs one 32-bit integer type on both sides', () => {
    const code = merc.replace('int nSecond', 'short nSecond');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('needs the second value not to read the first variable', () => {
    const code = merc.replace('int nSecond = Stat(k + 1);', 'int nSecond = Stat(nTmp);');
    assert.deepStrictEqual(run(code).sites, ['nTmp+nSecond']);
  });

  it('leaves a variable whose address is taken', () => {
    const code = merc.replace('  int r = 0;', '  int r = 0;\n  int *p = &nTmp;').replace('int nTmp = Stat(k);', 'nTmp = Stat(k);').replace('{\n  int r', '{\n  int nTmp;\n  int r');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('computes what the printed form computes (compiled)', { skip: !hasNativeGpp() }, () => {
    const { out } = run(merc);
    const prelude = [PRELUDE, merc.replace('int f(', 'int before('), out.replace('int f(', 'int after(')].join('\n');
    const r = compileAndRun(prelude, [
      'for (int k = -3; k < 4; k++) {',
      '  g_n = k; int a = before(k); int na = g_n;',
      '  g_n = k; int b = after(k); int nb = g_n;',
      '  printf("%d/%d %d/%d\\n", a, na, b, nb);',
      '}',
    ].join('\n'));
    for (const row of r.trim().split('\n')) {
      const [x, y] = row.split(' ');
      assert.strictEqual(x, y, r);
    }
  });
});
