import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { callResultDividePlugin, type CallDivideFact } from '../builtins/call-result-divide.js';

/** One statement per line; `[f/2]` tags the line with a call the original divides at once. */
function run(lines: string[]): string {
  const divides = new Map<number, CallDivideFact[]>();
  const text = lines.map((l, i) => {
    const m = l.match(/^\s*\[(\w+)\/(\d+)\]\s?(.*)$/);
    if (!m) return l;
    divides.set(i + 1, [{ name: m[1], k: Number(m[2]) }]);
    return m[3];
  });
  const t = callResultDividePlugin.createTransformer({ divides });
  return emit(t(parse(text.join('\n'))) as AnyNode).replace(/\s+/g, ' ');
}

describe('callResultDividePlugin', () => {
  // DRAW_UI_HelpXpac 00495410: `call DRAW_text0; cdq; sub eax, edx; push 0; sar eax, 1`.
  it('divides a call result in its assignment when the original divides at once', () => {
    const out = run([
      'void f(wchar_t *s) {',
      'int w;',
      '[DRAW_text0/2] w = DRAW_text0(s);',
      'DRAW_text(L, 0x108 - w / 2, 0x1fa);',
      'w = DRAW_text0(s);',
      'DRAW_text(L, 0x3b - w / 2, 0x1e1);',
      '}',
    ]);
    assert.match(out, /w = DRAW_text0\(s\) \/ 2; DRAW_text\(L, 0x108 - w, 0x1fa\);/);
    // The pair without the fact keeps the division at its use.
    assert.match(out, /w = DRAW_text0\(s\); DRAW_text\(L, 0x3b - w \/ 2, 0x1e1\);/);
  });

  it('folds into a declaration and a larger power of two', () => {
    const out = run(['int f(wchar_t *s, int c) {', '[g/4] int w = g(s);', 'return c - w / 4;', '}']);
    assert.match(out, /int w = g\(s\) \/ 4; return c - w;/);
  });

  it('leaves v when it is read again, by another divisor, or through a loop', () => {
    const again = run(['int f(int c) {', 'int w;', '[g/2] w = g();', 'h(c - w / 2);', 'return w;', '}']);
    assert.match(again, /w = g\(\); h\(c - w \/ 2\);/);
    const other = run(['int f(int c) {', 'int w;', '[g/2] w = g();', 'return c - w / 4;', '}']);
    assert.match(other, /return c - w \/ 4;/);
    const loop = run(['void f(int c) {', 'int w = 0;', 'while (c) {', 'h(w);', '[g/2] w = g();', 'h(c - w / 2);', '}', '}']);
    assert.match(loop, /w = g\(\); h\(c - w \/ 2\);/);
    const addr = run(['void f(int c) {', 'int w;', 'k(&w);', '[g/2] w = g();', 'h(c - w / 2);', '}']);
    assert.match(addr, /h\(c - w \/ 2\);/);
  });

  it('accepts a later plain write as the end of the value', () => {
    const out = run(['void f(int c) {', 'int w;', '[g/2] w = g();', 'h(c - w / 2);', 'w = g();', 'h(w);', '}']);
    assert.match(out, /w = g\(\) \/ 2; h\(c - w\); w = g\(\); h\(w\);/);
  });

  it('changes nothing without the facts', () => {
    const t = callResultDividePlugin.createTransformer({});
    assert.match(emit(t(parse('int f() { int w; w = g(); return 1 - w / 2; }')) as AnyNode), /w \/ 2/);
  });
});
