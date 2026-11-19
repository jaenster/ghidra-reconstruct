/**
 * A do-while counting an unread counter down from n >= 1 is the for loop counting an index up
 * to n (countdown-index-for). The shapes are Ghidra's for OBJOP_A2Q2_OpenHoradricScrollChest
 * 00599c10 (guarded count) and SFILE_DeleteOldLogFiles 00407570 (constant count); the
 * refusals are the shapes where the rewrite would change how often the body runs or a value.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createCountdownIndexForTransformer } from '../builtins/countdown-index-for.js';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const run = (code: string) => norm(emit(createCountdownIndexForTransformer()(parse(code)) as AnyNode));
const same = (code: string) => assert.strictEqual(run(code), norm(emit(parse(code) as AnyNode)));

describe('countdown-index-for', () => {
  it('turns a guarded countdown into an index loop', () => {
    const out = run(`int f(unsigned int s) {
  int n = s % 5 + 5;
  if (n <= 0) {
    return 0;
  }
  do {
    g();
    n--;
  } while (n);
  return 0;
}`);
    assert.match(out, /for \(int i = 0; i < n; i\+\+\) \{ g\(\); \}/);
    assert.doesNotMatch(out, /n--/);
  });

  it('turns a constant countdown into a loop on the counter', () => {
    const out = run(`void f() {
  int a = 0;
  int iCount = 10;
  do {
    g(a);
    a--;
    iCount--;
  } while (iCount);
}`);
    assert.match(out, /for \(int iCount = 0; iCount < 10; iCount\+\+\) \{ g\(a\); a--; \}/);
  });

  it('leaves the then-branch of a positive test alone', () => {
    same(`void f(int n) {
  if (0 < n) {
    do {
      g();
      n = n + -1;
    } while (n != 0);
  }
}`);
  });

  it('folds a bare return guard into the loop that ends a void function', () => {
    const out = run(`void f(int n) {
  h();
  if (n <= 0) {
    return;
  }
  do {
    g();
    n--;
  } while (n);
}`);
    assert.strictEqual(out, norm('void f(int n) { h(); for (int i = 0; i < n; i++) { g(); } }'));
  });

  it('folds the guard when only a bare return follows the loop', () => {
    const out = run(`void f(int n) {
  if (n <= 0) {
    return;
  }
  do {
    g();
    n--;
  } while (n);
  return;
}`);
    assert.strictEqual(out, norm('void f(int n) { for (int i = 0; i < n; i++) { g(); } return; }'));
  });

  it('keeps a guard with code after the loop', () => {
    const out = run(`void f(int n) {
  if (n <= 0) {
    return;
  }
  do {
    g();
    n--;
  } while (n);
  h();
}`);
    assert.match(out, /if \(n <= 0\) \{ return; \} for \(int i = 0; i < n; i\+\+\)/);
  });

  it('refuses a counter the body reads', () => {
    same(`void f(int n) {
  if (n <= 0) return;
  do {
    g(n);
    n--;
  } while (n);
}`);
  });

  it('refuses a counter read after the loop', () => {
    same(`int f(int n) {
  if (n <= 0) return 0;
  do {
    g();
    n--;
  } while (n);
  return n;
}`);
  });

  it('refuses an unproven entry count', () => {
    same(`void f(int n) {
  do {
    g();
    n--;
  } while (n);
}`);
  });

  it('refuses a zero test guard for a signed counter', () => {
    same(`void f(int n) {
  if (n == 0) return;
  do {
    g();
    n--;
  } while (n);
}`);
  });

  it('refuses a continue that would skip the step', () => {
    same(`void f(int n) {
  if (n <= 0) return;
  do {
    if (h()) continue;
    g();
    n--;
  } while (n);
}`);
  });

  it('refuses a counter whose address escapes', () => {
    same(`void f(int n) {
  int* p = &n;
  if (n <= 0) return;
  do {
    g(p);
    n--;
  } while (n);
}`);
  });

  it('accepts an unsigned counter behind a zero test', () => {
    const out = run(`void f(unsigned int n) {
  if (n == 0) return;
  do {
    g();
    n--;
  } while (n);
  h();
}`);
    assert.match(out, /for \(unsigned int i = 0; i < n; i\+\+\)/);
  });
});
