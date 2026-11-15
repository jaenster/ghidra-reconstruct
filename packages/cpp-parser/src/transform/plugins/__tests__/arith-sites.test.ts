import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { shiftMultiplyPlugin, addNestingPlugin, concatWidenPlugin, type ArithFact } from '../builtins/arith-sites.js';
import { pseudoOpLowerPlugin } from '../builtins/pseudo-op-lower.js';

type Plugin = typeof shiftMultiplyPlugin;

/** One statement per line; `[...]@@` opens a line with its facts as JSON items. */
function run(plugins: Plugin[], lines: string[]): string {
  const arith = new Map<number, ArithFact[]>();
  const text = lines.map((l, i) => {
    const m = l.match(/^\s*(\[.*?\])@@\s?(.*)$/);
    if (!m) return l;
    arith.set(i + 1, JSON.parse(m[1]) as ArithFact[]);
    return m[2];
  });
  let ast = parse(text.join('\n')) as unknown as AnyNode;
  for (const p of plugins) ast = p.createTransformer({ arith })(ast as never) as unknown as AnyNode;
  return emit(ast).replace(/\s+/g, ' ');
}

const shl = (log2: number) => JSON.stringify({ kind: 'mul', log2, evidence: 'shift' });
const hib = JSON.stringify({ kind: 'mul', log2: 8, evidence: 'highbyte' });
const oth = (log2: number) => JSON.stringify({ kind: 'mul', log2, evidence: 'other' });

describe('shiftMultiplyPlugin', () => {
  // OBJECT_ClientFn_OperateToOpened 004bde00: `xor edx, edx; mov dh, byte ptr [ecx + 0x12a]`.
  it('writes a multiply the original computed by a high-byte load as the shift', () => {
    const out = run([shiftMultiplyPlugin], ['int f(unsigned char *p, int n) {', `[${hib}]@@ return n == (unsigned int)p[1] * 0x100;`, '}']);
    assert.match(out, /n == \(unsigned int\)p\[1\] << 8;/);
    assert.doesNotMatch(out, /\* 0x100/);
  });

  it('keeps the precedence of a shift under an addition', () => {
    const out = run([shiftMultiplyPlugin], ['int f(int a, int b) {', `[${shl(4)}]@@ return a + b * 0x10;`, '}']);
    assert.match(out, /return a \+ \(b << 4\);/);
  });

  it('leaves a multiply the original computed otherwise, and a suffixed literal', () => {
    const out = run([shiftMultiplyPlugin], ['int f(int a, unsigned b) {', `[${oth(8)}]@@ a = a * 0x100;`, `[${shl(8)}]@@ b = b * 0x100u;`, 'return a + b;', '}']);
    assert.match(out, /a = a \* 0x100;/);
    assert.match(out, /b = b \* 0x100u;/);
  });

  it('leaves a line whose multiplies do not tie', () => {
    const out = run([shiftMultiplyPlugin], ['int f(int a, int b) {', `[${shl(8)}]@@ return a * 0x100 + b * 0x100;`, '}']);
    assert.match(out, /a \* 0x100 \+ b \* 0x100/);
  });
});

const add = (o: object) => JSON.stringify({ kind: 'add', width: 'int', ...o });

describe('addNestingPlugin', () => {
  // SKILLS_AddRandomSkillDamage 0056e170: `add eax, ebx; add [ecx + 8], eax`.
  it('splits the sum the original added into a variable in place', () => {
    const out = run([addNestingPlugin], [
      'void f(int *p, int nMin, unsigned int nRand) {',
      `[${add({})},${add({ consumer: 0, into: { input: 0, name: 'nRand' } })}]@@ p[2] = p[2] + nRand + nMin;`,
      '}',
    ]);
    assert.match(out, /nRand = nRand \+ nMin; p\[2\] = p\[2\] \+ nRand;/);
  });

  it('splits in an if arm, and not when a statement after the if reads the variable', () => {
    const into = `[${add({})},${add({ consumer: 0, into: { input: 0, name: 'nRand' } })}]@@`;
    const out = run([addNestingPlugin], ['void f(int *p, int nMin, unsigned int nRand) {', 'if (p) {', `${into} p[2] = p[2] + nRand + nMin;`, '}', '}']);
    assert.match(out, /if \(p\) \{ nRand = nRand \+ nMin; p\[2\] = p\[2\] \+ nRand; \}/);
    const kept = run([addNestingPlugin], ['int f(int *p, int nMin, int nRand) {', 'if (p) {', `${into} p[2] = p[2] + nRand + nMin;`, '}', 'return nRand;', '}']);
    assert.match(kept, /p\[2\] = p\[2\] \+ \(nRand \+ nMin\);/);
  });

  it('nests the sum without splitting when the variable is read later', () => {
    const out = run([addNestingPlugin], [
      'int f(int *p, int nMin, int nRand) {',
      `[${add({})},${add({ consumer: 0, into: { input: 0, name: 'nRand' } })}]@@ p[2] = p[2] + nRand + nMin;`,
      'return nRand;',
      '}',
    ]);
    assert.match(out, /p\[2\] = p\[2\] \+ \(nRand \+ nMin\);/);
  });

  it('nests a sum the p-code nests to the right', () => {
    const out = run([addNestingPlugin], ['int f(int x, int a, int b) {', `[${add({})},${add({ consumer: 0 })}]@@ return x + a + b;`, '}']);
    assert.match(out, /return x \+ \(a \+ b\);/);
  });

  it('leaves a sum the p-code nests as printed, and a floating one', () => {
    const out = run([addNestingPlugin], [
      'int f(int x, int a, int b, float c) {',
      `[${add({ consumer: 1 })},${add({})}]@@ x = x + a + b;`,
      `[${add({ width: 'other' })},${add({ consumer: 0, width: 'other' })}]@@ c = c + c + c;`,
      'return x;',
      '}',
    ]);
    assert.match(out, /x = x \+ a \+ b;/);
    assert.match(out, /c = c \+ c \+ c;/);
  });

  it('does not split in a loop or with an effect in the operands', () => {
    const out = run([addNestingPlugin], [
      'void f(int *p, int n, int a) {',
      'while (n) {',
      `[${add({})},${add({ consumer: 0, into: { input: 0, name: 'a' } })}]@@ p[0] = p[0] + a + n;`,
      'n = n - 1; }',
      `[${add({})},${add({ consumer: 0, into: { input: 0, name: 'a' } })}]@@ p[1] = p[1] + a + g(n);`,
      '}',
    ]);
    assert.doesNotMatch(out, /a = a \+/);
  });
});

describe('concatWidenPlugin', () => {
  // DRAW_SetTransparentColorRGB 00605320: `movzx ecx, ah; mov ch, al`, no 16-bit truncation.
  it('lowers a widened CONCAT without its truncation', () => {
    const lines = [
      'void f(unsigned int nRGB, unsigned int *p) {',
      `[${JSON.stringify({ kind: 'concat', bytes: 2, widened: true })}]@@ *p = (unsigned int)CONCAT11((char)nRGB,(char)(nRGB >> 8)) << 8;`,
      '}',
    ];
    const out = run([concatWidenPlugin, pseudoOpLowerPlugin as Plugin], lines);
    assert.doesNotMatch(out, /\(uint16_t\)\(\(uint16_t\)/);
    assert.match(out, /\(uint16_t\)\(uint8_t\)/);
    const plain = run([pseudoOpLowerPlugin as Plugin], lines);
    assert.match(plain, /\(uint16_t\)\(\(uint16_t\)/);
  });

  it('drops the inner truncation and mask of nested widened CONCATs', () => {
    const w = (bytes: number) => JSON.stringify({ kind: 'concat', bytes, widened: true });
    const out = run([concatWidenPlugin, pseudoOpLowerPlugin as Plugin], [
      'void f(unsigned char *h, unsigned int *p) {',
      `[${JSON.stringify({ kind: 'concat', bytes: 4, widened: false })},${w(3)},${w(2)}]@@ *p = CONCAT31(CONCAT21(CONCAT11(h[0],h[1]),h[2]),h[3]);`,
      '}',
    ]);
    assert.doesNotMatch(out, /\(uint16_t\)\(\(uint16_t\)/);
    assert.doesNotMatch(out, /0xffffff/);
  });
});
