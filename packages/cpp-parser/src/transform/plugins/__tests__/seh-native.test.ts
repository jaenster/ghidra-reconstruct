/**
 * SEH-Native Plugin Tests, and the __try statement through the parser and emitter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { sehNativePlugin } from '../builtins/seh-native.js';

const run = (code: string): string =>
  emit(sehNativePlugin.createTransformer()(parse(code)) as AnyNode);
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('__try statements', () => {
  it('parses and re-emits __try/__except and __try/__finally', () => {
    const src = `void f(int* p) { __try { *p = 1; } __except (1) { p = 0; } __try { *p = 2; } __finally { p = 0; } }`;
    const out = flat(emit(parse(src) as AnyNode));
    assert.ok(out.includes('__try { *p = 1; } __except (1) { p = 0; }'), out);
    assert.ok(out.includes('__try { *p = 2; } __finally { p = 0; }'), out);
  });
});

describe('sehNativePlugin', () => {
  // D2Client.cpp: the __except shape seh-lowering writes. The parser takes the
  // scope's direct initialization in parentheses; seh-lowering builds it as a node.
  const exceptSrc = `void f(int* p) {
    int n;
    {
      // __try / __except (EXCEPTION_EXECUTE_HANDLER): scope table 007011a0
      D2SehScope __seh0(1);
      if (D2_SEH_SETJMP(__seh0) == 0) {
        __seh0.Enter();
        D2_SEH_FENCE();
        *p = 1;
        D2_SEH_FENCE();
        if (n) {
          D2_SEH_FENCE();
          *p = 2;
        }
      } else {
      }
    }
    n = 3;
  }`;

  it('puts a native __try/__except under _MSC_VER and keeps the lowering in #else', () => {
    const out = run(exceptSrc);
    const f = flat(out);
    assert.ok(f.includes('#if defined(_MSC_VER) __try { *p = 1; if (n) { *p = 2; } } __except (1) {} #else'), f);
    assert.ok(f.includes('#else D2SehScope __seh0{1}; if (D2_SEH_SETJMP(__seh0) == 0) { __seh0.Enter(); D2_SEH_FENCE(); *p = 1; D2_SEH_FENCE(); if (n) { D2_SEH_FENCE(); *p = 2; } } else {} #endif'), f);
    // Each directive on a line of its own.
    for (const d of ['#if defined(_MSC_VER)', '#else', '#endif']) {
      assert.ok(new RegExp(`^\\s*${d.replace(/[()]/g, '\\$&')}\\s*$`, 'm').test(out), out);
    }
  });

  // D2SoundUntil.cpp: the __finally shape. The parser reads neither `auto` nor a
  // lambda, so the test parses a placeholder and puts the lambda node in its place,
  // as seh-lowering builds it.
  it('puts a native __try/__finally in place of the lambda, the scope and the normal-path call', () => {
    const tu = parse(`int f(int* p) {
      volatile int b = 0;
      Fin __finally0 = 0;
      {
        D2SehScope __seh0 = __finally0;
        __seh0.Enter();
        D2_SEH_FENCE();
        b = 1;
        D2_SEH_FENCE();
      }
      __finally0();
      return b;
    }
    void g(int* p) { D2_SEH_FENCE(); *p = 0; }`) as any;
    const [f, g] = tu.declarations;
    const decl = f.body.statements[1].declarations[0];
    decl.initializer = {
      kind: 'LambdaExpr', captures: [], captureDefault: '&', parameters: [], returnType: null,
      body: g.body, specifiers: [], location: decl.location,
    };
    tu.declarations = [f];
    const out = flat(emit(sehNativePlugin.createTransformer()(tu) as AnyNode));
    assert.ok(out.includes('#if defined(_MSC_VER) __try { b = 1; } __finally { *p = 0; } #else Fin __finally0 = [&]'), out);
    assert.ok(out.includes('__finally0(); #endif return b;'), out);
  });

  it('leaves code without a lowered scope alone', () => {
    const src = `void f(int* p) { { int x = 1; if (x == 0) { *p = 1; } else { } } }`;
    assert.strictEqual(flat(run(src)), flat(emit(parse(src) as AnyNode)));
  });
});
