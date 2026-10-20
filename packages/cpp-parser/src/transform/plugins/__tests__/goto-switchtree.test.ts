/**
 * Compare tree to switch (goto-cleanup/switchtree.ts, design step 8): MSVC's binary
 * search over a sparse switch's values, printed by Ghidra as nested ifs with every default
 * edge a goto, becomes the switch again.
 *
 * Each shape is compiled as written and as rewritten, for an int and an unsigned operand,
 * and run on every literal of the tree and its neighbours plus the extremes, each work
 * statement recording itself through W. Decline cases pin what is left alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { gotoCleanupPlugin, getGotoCleanupStats, resetGotoCleanupStats } from '../builtins/goto-cleanup/index.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

function run(src: string) {
  resetGotoCleanupStats();
  const out = emit(gotoCleanupPlugin.createTransformer()(parse(src)) as AnyNode);
  const st = getGotoCleanupStats();
  assert.equal(st.vetoedUnsafe, 0, 'the reachability net stopped a candidate');
  assert.equal(st.orphanGoto, 0);
  return { out, st };
}
const gotos = (s: string) => (s.match(/\bgoto\b/g) ?? []).length;

/** ref::f and low::f on the tree's literals, their neighbours and the extremes, typed T. */
function same(ref: string, low: string, T: string): string {
  const lits = [...new Set([...ref.matchAll(/\b(0x[0-9a-f]+|\d+)\b/g)].map(m => BigInt(m[1])))];
  const xs = new Set<string>(['0', '1', '-1', '2147483647', '-2147483647 - 1', '4294967295u', '2147483648u']);
  for (const k of lits) for (const d of [-1n, 0n, 1n]) xs.add(String(k + d));
  const prelude = [
    'static int trace[64]; static int nt;',
    'static int W(int k) { if (nt < 64) trace[nt++] = k; return k; }',
    `namespace ref {\n${ref.replace(/\bTX\b/g, T)}\n}`,
    `namespace low {\n${low.replace(/\bTX\b/g, T)}\n}`,
  ].join('\n');
  const body = [
    `const ${T} xs[] = {${[...xs].map(x => `(${T})(${x})`).join(', ')}};`,
    'long bad = 0;',
    'for (auto x : xs) {',
    '  static int t1[64], t2[64]; int n1, n2, r1, r2;',
    '  nt = 0; r1 = ref::f(x); n1 = nt; memcpy(t1, trace, sizeof t1);',
    '  nt = 0; r2 = low::f(x); n2 = nt; memcpy(t2, trace, sizeof t2);',
    '  if (r1 != r2 || n1 != n2 || memcmp(t1, t2, n1 * sizeof(int))) bad++;',
    '}',
    'printf("%ld\\n", bad);',
  ].join('\n');
  return compileAndRun(prelude, body).trim();
}

describe('switchtree: a compare tree whose default edges are gotos becomes a switch', () => {
  // QUEST_OnMonsterKilled 00543a30: the cases share one arm; one default leaf is the
  // default's tail, duplicated by the compiler.
  const QUEST = `int f(TX x) {
  int r = W(1);
  if (x < 0x188) {
    if (x != 0x187) {
      if (x < 0xf2) goto LAB_00543b4b;
      if (0xf3 < x) {
        r = r + W(9);
        return r;
      }
    }
  }
  else if (x != 0x220) goto LAB_00543b4b;
  r = W(2);
LAB_00543b4b:
  r = r + W(9);
  return r;
}`;
  it('QUEST_OnMonsterKilled: one stacked case arm, the duplicated default merged', () => {
    const r = run(QUEST.replace(/\bTX\b/g, 'uint32_t'));
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.switchTree, 2, r.out);
    assert.match(r.out, /switch \(x\) \{\s*case 0xf2:\s*case 0xf3:\s*case 0x187:\s*case 0x220:\s*r = W\(2\);\s*\}/, r.out);
  });
  for (const T of ['uint32_t', 'int']) {
    it(`QUEST_OnMonsterKilled (${T}): compiled, same behaviour`, { skip: !hasNativeGpp() }, () => {
      const out = run(QUEST.replace(/\bTX\b/g, T)).out;
      assert.equal(same(QUEST, out.replace(new RegExp(`\\b${T}\\b x`), 'TX x'), T), '0');
    });
  }

  // Own arms that return, a stacked pair, and an arm shared by the fall-off.
  const ARMS = `int f(TX x) {
  int r = 0;
  if (x < 10) {
    if (x == 3) { return W(3); }
    if (x != 7) goto LAB_1;
    return W(7);
  }
  else if (x < 0x15) {
    if (x < 0x14) goto LAB_1;
    return W(20);
  }
  else if (x != 0x1e) goto LAB_1;
  r = W(30);
LAB_1:
  return r + W(1);
}`;
  it('own arms keep their returns; the fall-off arm takes F', () => {
    const r = run(ARMS.replace(/\bTX\b/g, 'int'));
    assert.equal(gotos(r.out), 0, r.out);
    assert.match(r.out, /switch \(x\) \{\s*case 3:\s*return W\(3\);\s*case 7:\s*return W\(7\);\s*case 0x14:\s*return W\(20\);\s*case 0x1e:\s*r = W\(30\);\s*\}/, r.out);
  });
  for (const T of ['uint32_t', 'int']) {
    it(`own arms (${T}): compiled, same behaviour`, { skip: !hasNativeGpp() }, () => {
      const out = run(ARMS.replace(/\bTX\b/g, T)).out;
      assert.equal(same(ARMS, out.replace(new RegExp(`\\b${T}\\b x`), 'TX x'), T), '0');
    });
  }
  it('the harness catches a case value off by one', { skip: !hasNativeGpp() }, () => {
    const out = run(ARMS.replace(/\bTX\b/g, 'int')).out.replace('case 0x14:', 'case 0x15:');
    assert.notEqual(same(ARMS, out.replace(/\bint\b x/, 'TX x'), 'int'), '0');
  });
});

describe('switchtree: the tree ends a block that falls to the default', () => {
  // NPCMENU 004b5790: the tree and its arm are nested in two ifs; D follows them.
  const NPC = `int f(TX x) {
  int r = W(1);
  if (W(2) != 0) {
    if (W(3) != 0) {
      if (x < 0x10a) {
        if (x != 0x109) {
          if (x < 0xf4) goto LAB_004b57d5;
          if (0xf6 < x) {
            r = r + W(9);
            return r;
          }
        }
      }
      else if (x != 0x208) goto LAB_004b57d5;
      r = W(4);
      r = r + W(5);
    }
  }
LAB_004b57d5:
  r = r + W(9);
  return r;
}`;
  it('the switch ends the inner block; its default falls out to D', () => {
    const r = run(NPC.replace(/\bTX\b/g, 'uint32_t'));
    assert.equal(gotos(r.out), 0, r.out);
    assert.match(r.out, /switch \(x\) \{\s*case 0xf4:\s*case 0xf5:\s*case 0xf6:\s*case 0x109:\s*case 0x208:\s*r = W\(4\);\s*r = r \+ W\(5\);\s*\}/, r.out);
  });
  for (const T of ['uint32_t', 'int']) {
    it(`NPCMENU (${T}): compiled, same behaviour`, { skip: !hasNativeGpp() }, () => {
      const out = run(NPC.replace(/\bTX\b/g, T)).out;
      assert.equal(same(NPC, out.replace(new RegExp(`\\b${T}\\b x`), 'TX x'), T), '0');
    });
  }
});

describe('switchtree: what is not a switch', () => {
  it('declines when the signed and unsigned readings disagree (x < 0 holds only signed)', () => {
    const src = `int f(int x) {
  int r = 0;
  if (x < 0) return W(5);
  if (x < 3) {
    if (x != 1) goto LAB_1;
    r = W(2);
  }
LAB_1:
  return r;
}`;
    assert.equal(run(src).st.switchTree, 0);
  });
  it('declines an equality chain (no binary search: as likely an if-chain)', () => {
    const src = `int f(int x) {
  int r = 0;
  if (x != 3) {
    if (x != 7) goto LAB_1;
  }
  r = W(2);
LAB_1:
  return r;
}`;
    assert.equal(run(src).st.switchTree, 0);
  });
  it('declines an own leaf with many values that is not the default tail', () => {
    const src = `int f(int x) {
  int r = 0;
  if (x < 0x100) {
    if (x != 0x50) goto LAB_1;
    r = W(2);
  }
  else {
    return W(7);
  }
LAB_1:
  return r + W(1);
}`;
    assert.equal(run(src).st.switchTree, 0);
  });
});
