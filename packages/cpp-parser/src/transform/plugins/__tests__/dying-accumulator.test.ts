import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { dyingAccumulatorPlugin } from '../builtins/dying-accumulator.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = dyingAccumulatorPlugin.createTransformer({
    onSite: (e: { accumulator: string; addend: string; op: string }) => sites.push(`${e.accumulator}${e.op}${e.addend}`),
  } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

const PRELUDE = 'unsigned g_n; unsigned g_set; int Stat(int k) { g_n++; return k * 3 + (int)g_n; } void Set(unsigned v) { g_set = g_set * 31 + v; }';

// RewardExperienceFromAncients 0058c5c0, the tail of its loop, as printed.
const reward = [
  'unsigned f(int k, unsigned nReward) {',
  '  int nCur;',
  '  unsigned nRemaining = nReward;',
  '  do {',
  '    if (nRemaining == 0) return g_set;',
  '    nCur = Stat(k);',
  '    if (nRemaining < (unsigned)nCur) {',
  '      nCur = Stat(k + 1);',
  '      Set(nRemaining + nCur);',
  '      nRemaining = 0;',
  '    } else {',
  '      Set(nCur);',
  '      nRemaining = nRemaining - nCur;',
  '    }',
  '    k++;',
  '  } while (k < 9);',
  '  return g_set;',
  '}',
].join('\n');

// CLIENT_UpdatePortalFlags 00537b00, as printed.
const portal = [
  'void g(int k) {',
  '  unsigned nFlags = (unsigned)Stat(k);',
  '  unsigned nLevelFlag = (unsigned)Stat(k + 1);',
  '  Set(nFlags | nLevelFlag);',
  '}',
].join('\n');

describe('dying-accumulator', () => {
  it('updates an accumulator that dies with the sum', () => {
    const { out, sites } = run(reward);
    assert.deepStrictEqual(sites, ['nRemaining+nCur']);
    assert.ok(out.includes('nRemaining += Stat(k + 1); Set(nRemaining); nRemaining = 0;'), out);
  });

  it('works for | with the addend declared', () => {
    const { out, sites } = run(portal.replace('(unsigned)Stat(k + 1)', 'g_n'));
    assert.deepStrictEqual(sites, ['nFlags|nLevelFlag']);
    assert.ok(out.includes('nFlags |= g_n; Set(nFlags);'), out);
  });

  it('leaves an accumulator read after the use', () => {
    const code = reward.replace('      nRemaining = 0;\n', '      k += nRemaining;\n');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('leaves a signed accumulator with an unsigned addend', () => {
    const code = portal.replace('unsigned nFlags', 'int nFlags').replace('(unsigned)Stat(k + 1)', 'g_n');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('leaves a parameter accumulator to in-place-operand', () => {
    const code = reward.replace("  'unsigned f(int k, unsigned nReward) {',", '').replace('unsigned f(int k, unsigned nReward) {\n  int nCur;\n  unsigned nRemaining = nReward;', 'unsigned f(int k, unsigned nRemaining) {\n  int nCur;');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('leaves a - with the addend on the left', () => {
    const code = reward.replace('Set(nRemaining + nCur)', 'Set(nCur - nRemaining)');
    assert.deepStrictEqual(run(code).sites, []);
  });

  // 004f0ab0: `nGameTick + nDuration` was worked in the call result's register.
  it('leaves a sum whose addend is printed first', () => {
    const code = reward.replace('Set(nRemaining + nCur)', 'Set(nCur + nRemaining)');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('computes the same values natively', { skip: !hasNativeGpp() }, () => {
    const before = `${PRELUDE}\n${reward}\n${portal.replace('(unsigned)Stat(k + 1)', 'g_n')}`;
    const after = `${PRELUDE}\n${run(reward).out}\n${run(portal.replace('(unsigned)Stat(k + 1)', 'g_n')).out}`;
    const main = 'unsigned s = 0; for (int k = 0; k < 6; k++) { s = s * 7 + f(k, 5u + (unsigned)k * 3u); g(k); s += g_set; } printf("%u\\n", s);';
    assert.strictEqual(compileAndRun(after, main), compileAndRun(before, main));
  });
});
