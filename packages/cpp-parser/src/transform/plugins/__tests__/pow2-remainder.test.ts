/**
 * Tests for `pow2-remainder`: VC8's signed remainder by 2^k - `and r, 0x80000000|(2^k-1);
 * jns; dec r; or r, -2^k; inc r` - in the shapes the decompiler prints it in, back to `%`.
 *
 * Every example is a shape from Game.exe 1.14d (the function named above it). The value
 * check compiles each original/folded pair with the host compiler and compares them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { compileTo, exePath, hasNativeGpp, runExe } from '../../../testing/native-cpp.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import {
  pow2RemainderPlugin, getArithIdiomStats, resetArithIdiomStats, type ArithIdiomsOptions,
} from '../builtins/arith-idioms.js';

const OPTIONS: ArithIdiomsOptions = {
  structFields: { D2TimerQueueStrc: { nIndex: 'uint32_t' } },
  globalTypes: { gnStar: 'uint32_t', gbyCount: 'uint8_t' },
};

/**
 * `lines` one statement per line inside `void f(decls)`. Each line's code sits at 16 * line
 * unless `at` places it; an `if` line given in `jumps` has its conditional branch `gap`
 * bytes after the code of the line above it.
 */
function runLines(lines: string[], decls: string, jumps: Record<number, number> = {}, layout = true,
  at: Record<number, number[]> = {}): string {
  const src = [`void f(${decls}) {`, ...lines, '}'];
  const offs = new Map<number, number[]>();
  src.forEach((_, i) => offs.set(i + 1, at[i] ?? [16 * (i + 1)]));
  const ifs = new Map<number, number>();
  for (const [l, gap] of Object.entries(jumps)) ifs.set(Number(l) + 1, 16 * Number(l) + gap);
  const opts: ArithIdiomsOptions = { ...OPTIONS, branchLayout: layout ? { lines: offs, ifs } : undefined };
  const text = emit(pow2RemainderPlugin.createTransformer(opts)(parse(src.join('\n'))) as AnyNode);
  const m = /\{([\s\S]*)\}\s*$/.exec(text);
  return (m ? m[1] : text).replace(/\s+/g, ' ').trim();
}

/** Line numbers (as runLines counts them, from 1) of the `if` statements in `lines` that are given a jump `gap` bytes on. */
function jumpsAt(lines: string[], gap: number): Record<number, number> {
  const out: Record<number, number> = {};
  lines.forEach((l, i) => { if (/^\s*if \(\(int\)\w+ < 0\)/.test(l)) out[i + 1] = gap; });
  return out;
}

describe('pow2-remainder: the value', () => {
  // EVENT_DispatchAllTimers, 005414d0: `and eax, 0x8000003f; mov ebx, [esi+0xb8]; jns`.
  it('folds across a statement the compiler scheduled between the AND and the jump', () => {
    const lines = [
      '  r = n & 0x8000003f;',
      '  q = *p;',
      '  if ((int)r < 0) {',
      '    r = (r - 1 | 0xffffffc0) + 1;',
      '  }',
      '  g = r;',
    ];
    assert.strictEqual(runLines(lines, 'uint32_t n, uint32_t r, int q, int *p, uint32_t g', { 3: 6 }),
      'r = (int)n % 64; q = *p; g = r;');
  });

  // CODEC_AdvanceFrameIterator, 0060b2b0: the AND on the variable itself.
  it('folds the compound AND', () => {
    const lines = ['  r &= 0x80000003;', '  if ((int)r < 0) {', '    r = (r - 1 | -4) + 1;', '  }', '  g = r;'];
    assert.strictEqual(runLines(lines, 'uint32_t r, uint32_t g', { 2: 5 }), 'r = (int)r % 4; g = r;');
  });

  // MISSILE_CltDoFn19_FrozenOrb, 004d46d0: `inc eax; jns; neg eax` - the absolute value.
  it('keeps a sign test of the remainder that follows the fix-up', () => {
    const lines = [
      '  r &= 0x8000003f;',
      '  if ((int)r < 0) {',
      '    r = (r - 1 | -64) + 1;',
      '    if ((int)r < 0) {',
      '      r = -r;',
      '    }',
      '  }',
      '  g = r;',
    ];
    assert.strictEqual(runLines(lines, 'uint32_t r, uint32_t g', { 2: 5 }),
      'r = (int)r % 64; if ((int)r < 0) { r = -r; } g = r;');
  });

  // Drlg, 0066f... `uVar2 = uVar2 + 1 & 0x80000003`: the dividend in parentheses.
  it('parenthesises a compound dividend under its cast', () => {
    const lines = ['  r = r + 1 & 0x80000003;', '  if ((int)r < 0) {', '    r = (r - 1 | -4) + 1;', '  }'];
    assert.strictEqual(runLines(lines, 'uint32_t r', { 2: 5 }), 'r = (int)(r + 1) % 4;');
  });

  // DRAW_EscMenu, 0047e3d0: a global, before early-return makes the fix-up a guard.
  it('folds a global with nothing in between', () => {
    const lines = ['  gnStar = gnStar + 1 & 0x80000007;', '  if ((int)gnStar < 0) {', '    gnStar = (gnStar - 1 | -8) + 1;', '  }'];
    assert.strictEqual(runLines(lines, '', { 2: 6 }), 'gnStar = (int)(gnStar + 1) % 8;');
  });

  it('refuses a statement in between that mentions r, a call for a global r, or more than three', () => {
    const base = (mid: string[], decls = 'uint32_t n, uint32_t r, int q, int *p') => runLines(
      ['  r = n & 0x80000003;', ...mid, '  if ((int)r < 0) {', '    r = (r - 1 | -4) + 1;', '  }'],
      decls, { [mid.length + 2]: 5 });
    assert.ok(base(['  q = r;']).includes('& 0x80000003'));
    assert.ok(base(['  q = 1;', '  q = 2;', '  q = 3;', '  q = 4;']).includes('& 0x80000003'));
    const glob = runLines(['  gnStar = n & 0x80000003;', '  h();', '  if ((int)gnStar < 0) {', '    gnStar = (gnStar - 1 | -4) + 1;', '  }'],
      'uint32_t n', { 3: 5 });
    assert.ok(glob.includes('& 0x80000003'), glob);
  });

  it('refuses without the jump right after the last instruction of the run, or without layout facts', () => {
    const lines = ['  r = n & 0x8000003f;', '  q = *p;', '  if ((int)r < 0) {', '    r = (r - 1 | -64) + 1;', '  }'];
    const decls = 'uint32_t n, uint32_t r, int q, int *p';
    assert.ok(runLines(lines, decls, { 3: 12 }).includes('& 0x8000003f'));
    assert.ok(runLines(lines, decls, { 3: 6 }, false).includes('& 0x8000003f'));
    // The AND's own code after the jump: not this idiom.
    assert.ok(runLines(lines, decls, { 3: 6 }, true, { 1: [64] }).includes('& 0x8000003f'));
  });

  it('refuses an else, a different modulus in the fix-up, or a narrow r', () => {
    assert.ok(runLines(['  r = n & 0x80000003;', '  if ((int)r < 0) {', '    r = (r - 1 | -8) + 1;', '  }'], 'uint32_t n, uint32_t r', { 2: 5 })
      .includes('& 0x80000003'));
    assert.ok(runLines(['  r = n & 0x80000003;', '  if ((int)r < 0) {', '    r = (r - 1 | -4) + 1;', '  } else {', '    r = 0;', '  }'],
      'uint32_t n, uint32_t r', { 2: 5 }).includes('& 0x80000003'));
    assert.ok(runLines(['  r = n & 0x80000003;', '  if ((int)r < 0) {', '    r = (r - 1 | -4) + 1;', '  }'], 'uint32_t n, uint16_t r', { 2: 5 })
      .includes('& 0x80000003'));
  });
});

describe('pow2-remainder: the zero test', () => {
  // MISSILE_CreateSubWithSound, 004ce850: `and ecx, 0x80000001; jns; dec; or ecx, -2; inc; jnz`.
  const test = (flagInit: string, fix: string, after: string[] = ['  if (b) {', '    g = 1;', '  }']) => runLines([
    '  r = n & 0x80000001;',
    `  b = ${flagInit};`,
    '  if ((int)r < 0) {',
    `    b = ${fix};`,
    '  }',
    ...after,
  ], 'uint32_t n, uint32_t r, bool b, int g', { 3: 5 }, true, { 1: [48], 2: [48] });

  it('writes the flag as the remainder tested against 0', () => {
    assert.strictEqual(test('r == 0', '(r - 1 | 0xfffffffe) == 0xffffffff'), 'b = (int)n % 2 == 0; if (b) { g = 1; }');
    assert.strictEqual(test('!r', '(r - 1 | -2) == -1'), 'b = (int)n % 2 == 0; if (b) { g = 1; }');
    assert.strictEqual(test('r != 0', '(r - 1 | -2) != -1'), 'b = (int)n % 2 != 0; if (b) { g = 1; }');
  });

  it('refuses a flag whose two tests disagree, or an r read again', () => {
    assert.ok(test('r == 0', '(r - 1 | -2) != -1').includes('& 0x80000001'));
    assert.ok(test('!r', '(r - 1 | -2) == -1', ['  g = r;']).includes('& 0x80000001'));
    assert.ok(test('!r', '(r - 1 | -2) == -1', ['  if (b) {', '    g = r;', '  }']).includes('& 0x80000001'));
  });

  // MISSILE_CreateSubWithSound again: the same r tested twice, then reassigned and used.
  it('drops r where it is overwritten before it is read, also after an enclosing if', () => {
    const lines = [
      '  r = n & 0x80000001;',
      '  b = !r;',
      '  if ((int)r < 0) {',
      '    b = (r - 1 | -2) == -1;',
      '  }',
      '  if (!b) {',
      '    return;',
      '  }',
      '  if (k < 3) {',
      '    r = n & 0x8000000f;',
      '    b = !r;',
      '    if ((int)r < 0) {',
      '      b = (r - 1 | -16) == -1;',
      '    }',
      '    if (!b) {',
      '      return;',
      '    }',
      '  }',
      '  r = 4;',
      '  g = r;',
    ];
    const at: Record<number, number[]> = { 1: [48], 2: [48], 10: [192], 11: [192] };
    const out = runLines(lines, 'uint32_t n, uint32_t r, bool b, int k, uint32_t g', { 3: 5, 12: 5 }, true, at);
    assert.strictEqual(out,
      'b = (int)n % 2 == 0; if (!b) { return; } if (k < 3) { b = (int)n % 16 == 0; if (!b) { return; } } r = 4; g = r;');
  });

  it('keeps a global r: its value outlives the function', () => {
    const lines = [
      '  gnStar = n & 0x80000001;',
      '  b = !gnStar;',
      '  if ((int)gnStar < 0) {',
      '    b = (gnStar - 1 | -2) == -1;',
      '  }',
      '  gnStar = 4;',
    ];
    const out = runLines(lines, 'uint32_t n, bool b', { 3: 5 }, true, { 1: [48], 2: [48] });
    assert.ok(out.includes('& 0x80000001'), out);
  });

  it('refuses inside a loop where r is mentioned elsewhere', () => {
    const lines = [
      '  while (k) {',
      '    g = r;',
      '    r = n & 0x80000001;',
      '    b = !r;',
      '    if ((int)r < 0) {',
      '      b = (r - 1 | -2) == -1;',
      '    }',
      '    k = b;',
      '  }',
    ];
    const out = runLines(lines, 'uint32_t n, uint32_t r, bool b, int k, uint32_t g', { 5: 5 }, true, { 3: [80], 4: [80] });
    assert.ok(out.includes('& 0x80000001'), out);
  });
});

describe('pow2-remainder: the AND without its fix-up', () => {
  // Skills_SrvDoFunc_087_SpawnBehindTarget, 005cb3c0: `movzx eax, al; and eax, 0x80000007; jns; ...`.
  it('folds a zero-extended operand', () => {
    assert.strictEqual(runLines(['  uint32_t r = by & 0x80000007;', '  g = r;'], 'uint8_t by, uint32_t g'),
      'uint32_t r = (int)by % 8; g = r;');
    // FINDTILE_ComputeHash, 0060cd70.
    assert.strictEqual(runLines(['  r = (uint8_t)(a * 2 - c) & 0x8000007f;'], 'char a, char c, uint32_t r'),
      'r = (int)(uint8_t)(a * 2 - c) % 128;');
    // DAMAGE_GetElementalDamageTypeFlags, 0057ce30: a byte global.
    assert.strictEqual(runLines(['  r = gbyCount & 0x80000003;'], 'uint32_t r'), 'r = (int)gbyCount % 4;');
  });

  // Skills_CltDoFunc_Pal_Zeal_DirOffsetMissile, 004c9490: the remainder inside a sum masked to 3 bits.
  it('folds a 32-bit operand whose value is masked again below the modulus', () => {
    assert.strictEqual(runLines(['  r = k - 1 + (q + 4 & 0x80000007) & 7;'], 'uint32_t k, uint32_t q, uint32_t r'),
      'r = k - 1 + (int)(q + 4) % 8 & 7;');
  });

  it('refuses a 32-bit operand otherwise, a mask wider than the modulus, or a narrow target', () => {
    // RollArcaneTypePath, 006719f0: the decompiler knew the sum is not negative; the type does not.
    assert.ok(runLines(['  r = q / 0xf + k & 0x80000003;'], 'uint32_t k, uint32_t q, uint32_t r').includes('& 0x80000003'));
    assert.ok(runLines(['  r = k + (q & 0x80000007) & 0xf;'], 'uint32_t k, uint32_t q, uint32_t r').includes('& 0x80000007'));
    assert.ok(runLines(['  s = by & 0x80000007;'], 'uint8_t by, uint16_t s').includes('& 0x80000007'));
    assert.ok(runLines(['  r = sb & 0x80000007;'], 'char sb, uint32_t r').includes('& 0x80000007'));
  });

  it('counts each fold', () => {
    resetArithIdiomStats();
    runLines(['  r &= 0x80000003;', '  if ((int)r < 0) {', '    r = (r - 1 | -4) + 1;', '  }'], 'uint32_t r', { 2: 5 });
    runLines(['  uint32_t r = by & 0x80000007;'], 'uint8_t by');
    const st = getArithIdiomStats();
    assert.strictEqual(st['pow2-rem'], 1);
    assert.strictEqual(st['pow2-rem-mask'], 1);
  });
});

describe('pow2-remainder: values', () => {
  it('every fold has the value of what it replaces', { skip: !hasNativeGpp() }, () => {
    type Case = { decls: string; ret: string; lines: string[]; jumps: Record<number, number>; at?: Record<number, number[]> };
    const cases: Case[] = [];
    for (const k of [1, 2, 6, 30]) {
      const m = (1n << BigInt(k)) - 1n;
      const mask = `0x${(0x80000000n | m).toString(16)}`;
      const neg = `-0x${(m + 1n).toString(16)}`;
      const scheduled = [`  r = n & ${mask};`, '  q = n ^ 5;', '  if ((int)r < 0) {', `    r = (r - 1 | ${neg}) + 1;`, '  }', '  r = r + q;'];
      cases.push({ decls: 'uint32_t r = 0, q = 0;', ret: 'r', lines: scheduled, jumps: jumpsAt(scheduled, 6) });
      const abs = ['  r = n;', `  r &= ${mask};`, '  if ((int)r < 0) {', `    r = (r - 1 | ${neg}) + 1;`, '    if ((int)r < 0) {', '      r = -r;', '    }', '  }'];
      cases.push({ decls: 'uint32_t r = 0;', ret: 'r', lines: abs, jumps: jumpsAt(abs, 5) });
      for (const [init, fix] of [['!r', '== -1'], ['r != 0', '!= -1']]) {
        const zero = [`  r = n & ${mask};`, `  b = ${init};`, '  if ((int)r < 0) {', `    b = (r - 1 | ${neg}) ${fix};`, '  }'];
        cases.push({ decls: 'uint32_t r = 0; bool b = false;', ret: 'b', lines: zero, jumps: jumpsAt(zero, 5), at: { 1: [48], 2: [48] } });
      }
      const byte = [`  r = (uint8_t)n & ${mask};`];
      cases.push({ decls: 'uint32_t r = 0;', ret: 'r', lines: byte, jumps: {} });
      if (k >= 3) {
        const sum = [`  r = n * 3 - 1 + (n + 4 & ${mask}) & 7;`];
        cases.push({ decls: 'uint32_t r = 0;', ret: 'r', lines: sum, jumps: {} });
      }
    }
    let src = '#include <stdint.h>\n#include <stdio.h>\nstatic int failures = 0;\n';
    let main = 'int main(void) {\n';
    cases.forEach((c, i) => {
      const folded = runLines(c.lines, 'uint32_t n, uint32_t r, uint32_t q, bool b', c.jumps, true, c.at ?? {});
      assert.ok(!folded.includes('0x80000'), folded);
      src += `static uint32_t a${i}(uint32_t n) { ${c.decls} ${c.lines.join(' ')} return (uint32_t)${c.ret}; }\n`;
      src += `static uint32_t b${i}(uint32_t n) { ${c.decls} ${folded} return (uint32_t)${c.ret}; }\n`;
      main += `  { uint32_t v[] = { 0u, 1u, 2u, 3u, 4u, 5u, 7u, 8u, 63u, 64u, 65u, 0x3fffffffu, 0x40000000u, 0x7fffffffu, 0x80000000u, 0x80000001u, 0xbfffffffu, 0xc0000000u, 0xffffffc0u, 0xfffffff8u, 0xfffffffdu, 0xfffffffeu, 0xffffffffu };`
        + ` for (unsigned k = 0; k < sizeof v / sizeof v[0]; k++) { if (a${i}(v[k]) != b${i}(v[k])) { printf("case ${i} value %u\\n", k); failures++; } } }\n`;
    });
    main += '  return failures ? 1 : 0;\n}\n';
    const dir = mkdtempSync(join(tmpdir(), 'pow2-rem-'));
    writeFileSync(join(dir, 'check.cpp'), src + main);
    try {
      const exe = exePath(join(dir, 'check'));
      const cc = compileTo(join(dir, 'check.cpp'), exe, ['-O0', '-w', '-fwrapv']);
      assert.strictEqual(cc.status, 0, String(cc.error ?? cc.stderr));
      const res = runExe(exe);
      assert.strictEqual(res.stdout, '');
      assert.strictEqual(res.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
