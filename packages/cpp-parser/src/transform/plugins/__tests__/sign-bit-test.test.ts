import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { signBitTestPlugin } from '../builtins/sign-bit-test.js';

function transform(code: string, options: Record<string, unknown> = {}): string {
  const ast = parse(code);
  return emit(signBitTestPlugin.createTransformer(options)(ast) as AnyNode);
}

describe('sign-bit-test', () => {
  it('spells a negative byte flag test as bit 7', () => {
    const out = transform("void f(unsigned x) { if ((char)x < '\\0') g(); }");
    assert.match(out, /if \(x & 0x80\)/);
  });

  it('spells a nonnegative byte flag test as a negated bit 7, including a nested guard', () => {
    const out = transform('void f(unsigned flags, bool ready) { if (!((char)flags >= 0 && ready)) g(); }');
    assert.match(out, /!\(!\(flags & 0x80\) && ready\)/);
  });

  it('spells a SHORT from GetAsyncKeyState as a bit 15 test', () => {
    const out = transform('void f() { SHORT nKeyState; nKeyState = GetAsyncKeyState(0x11); if (nKeyState < 0) g(); }');
    assert.match(out, /if \(nKeyState & 0x8000\)/);
  });

  it('handles a key-state assignment inside a comma predicate', () => {
    const out = transform('void f() { SHORT s; if ((s = GetKeyState(0x12), s >= 0) && ready()) g(); }');
    assert.match(out, /s = GetKeyState\(0x12\).*?!\(s & 0x8000\)/s);
  });

  it('leaves arithmetic uses of a comparison as 0/1', () => {
    const out = transform("int f(unsigned x) { return ((char)x < '\\0') + 1; }");
    assert.match(out, /\(char\)x < '\\0'/);
    assert.doesNotMatch(out, /x & 0x80/);
  });

  it('leaves an unrelated signed SHORT comparison alone', () => {
    const out = transform('void f(SHORT n) { if (n < 0) g(); }');
    assert.match(out, /n < 0/);
    assert.doesNotMatch(out, /n & 0x8000/);
  });

  it('leaves key-state locals with other writes alone', () => {
    const out = transform('void f() { SHORT n; n = GetKeyState(1); n = 5; if (n < 0) g(); }');
    assert.match(out, /n < 0/);
    assert.doesNotMatch(out, /n & 0x8000/);
  });

  it('leaves an inner variable shadowing a key-state SHORT alone', () => {
    const out = transform('void f() { SHORT s; s = GetKeyState(1); { int s = -1; if (s < 0) g(); } }');
    assert.match(out, /if \(s < 0\)/);
    assert.doesNotMatch(out, /s & 0x8000/);
  });

  it('does not bitwise-test a pointer cast to char', () => {
    const out = transform("void f(char* p) { if ((char)p < '\\0') g(); }");
    assert.match(out, /\(char\)p < '\\0'/);
    assert.doesNotMatch(out, /p & 0x80/);
  });

  it('leaves an unknown cast operand alone', () => {
    const out = transform("void f() { if ((char)getValue() < '\\0') g(); }");
    assert.match(out, /\(char\)getValue\(\) < '\\0'/);
    assert.doesNotMatch(out, /getValue\(\) & 0x80/);
  });

  it('uses owning field facts to admit a member flag', () => {
    const code = "void f(D2DamageStrc* pDamage) { if ((char)pDamage->dwHitFlags >= 0) g(); }";
    assert.match(transform(code), /\(char\)pDamage->dwHitFlags >= 0/);
    const out = transform(code, { structFields: { D2DamageStrc: { dwHitFlags: 'int' } } });
    assert.match(out, /!\(pDamage->dwHitFlags & 0x80\)/);
  });

  it('uses exact enum membership, not a type-name guess', () => {
    const code = "void f(eD2LevelId eFlags) { if ((char)eFlags >= 0) g(); }";
    assert.match(transform(code), /\(char\)eFlags >= 0/);
    assert.match(transform(code, { enumTypes: ['eD2LevelId'] }), /!\(eFlags & 0x80\)/);
  });
});
