import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { loopStrideHoistPlugin } from '../builtins/loop-stride-hoist.js';

function run(source: string): string {
  return emit(loopStrideHoistPlugin.createTransformer()(parse(source)) as AnyNode).replace(/\s+/g, ' ').trim();
}
const loop = 'int offset = 0; do { visit(offset); offset += step * 4; } while (offset < 256);';

describe('loop-stride-hoist', () => {
  const native = JSON.parse(readFileSync(new URL('./fixtures/loop-stride-missiles.json', import.meta.url), 'utf8'));
  for (const example of native.functions) {
    it(`${example.address} ${example.name}: recovers the native-measured strides`, () => {
      const ast = parse(example.definition, { recover: false });
      // These tree-wide unambiguous field types are declared by the published
      // D2DataTablesStrc headers, rather than guessed from their spelling.
      const code = emit(loopStrideHoistPlugin.createTransformer({ fieldTypes: {
        nTxtMissilesSize: 'int', pTxtMissiles: 'D2MissilesTxt *',
      } })(ast) as AnyNode);
      assert.equal((code.match(/const uint32_t nByteStride/g) ?? []).length, example.expectedStrides);
      assert.doesNotMatch(code, /\+=\s*\w+\s*\*\s*4/);
    });
  }

  it('hoists a separate unsigned stride before the counter without changing the step', () => {
    const code = run(`void f(int step) { ${loop} int after = step; }`);
    assert.match(code, /const uint32_t nByteStride = \(uint32_t\)step \* 4; int offset = 0;/);
    assert.match(code, /offset \+= nByteStride/);
    assert.match(code, /int after = step/);
    assert.doesNotMatch(code, /step \*=/);
  });

  it('uses reaching definitions to accept an initialized local with a clamp', () => {
    const code = run(`void f(int input) { int step; step = input; if (step < 1) { step = 1; } ${loop} }`);
    assert.match(code, /const uint32_t nByteStride/);
  });

  it('preserves separate strides in nested scopes and avoids existing names', () => {
    const code = run(`void f(int step) { int nByteStride = 9; if (step) { ${loop} } ${loop.replace(/offset/g, 'other')} }`);
    assert.match(code, /const uint32_t nByteStride2/);
    assert.match(code, /const uint32_t nByteStride3/);
  });

  it('avoids an unused parameter name as well as names read in the body', () => {
    const code = run(`void f(int step, int nByteStride) { ${loop} }`);
    assert.match(code, /const uint32_t nByteStride2/);
    assert.doesNotMatch(code, /const uint32_t nByteStride =/);
  });

  it('allows an early exit without introducing signed multiplication before that exit', () => {
    const code = run(`void f(int step, int stop) { int offset = 0; do { if (stop) return; visit(offset); offset += step * 4; } while (offset < 256); }`);
    assert.match(code, /const uint32_t nByteStride = \(uint32_t\)step \* 4/);
    assert.match(code, /if \(stop\) return;/);
  });

  it('allows ordinary scalar copies, casts and arithmetic without treating them as aliases', () => {
    const code = run(`void f(int step) { int copy = step; short narrow = (short)step;
      int twice; twice = step * 2; (void)step; ${loop} }`);
    assert.match(code, /const uint32_t nByteStride/);
  });

  it('requires a proven primitive field type before excluding overloaded operators', () => {
    const source = `void f(int step, Limits *p) { int copy = step + p->limit; ${loop} }`;
    const transform = (type?: string) => emit(loopStrideHoistPlugin.createTransformer({
      structFields: type ? { Limits: { limit: type } } : undefined,
    })(parse(source)) as AnyNode);
    assert.doesNotMatch(transform(), /nByteStride/);
    assert.doesNotMatch(transform('StepRef'), /nByteStride/);
    assert.match(transform('int'), /nByteStride/);
  });

  it('distinguishes a local from a same-named member or qualified global', () => {
    const code = run(`void f(Data *p) { int step = p->step; int copy = Scope::step;
      ${loop} }`);
    assert.match(code, /nByteStride/);
  });

  for (const [reason, source] of [
    ['an indeterminate local', `void f() { int step; ${loop} }`],
    ['a local initialized on only one path', `void f(int flag) { int step; if (flag) step = 4; ${loop} }`],
    ['a changing step', `void f(int step) { ${loop.replace('visit(offset);', 'step++; visit(offset);')} }`],
    ['another loop read of the step', `void f(int step) { ${loop.replace('visit(offset);', 'visit(step);')} }`],
    ['an address passed before the loop', `void f(int step) { bind(&step); ${loop} }`],
    ['a possible implicit reference argument', `void f(int step) { bind(step); ${loop} }`],
    ['a reference alias', `void f(int step) { int &alias = step; ${loop} }`],
    ['a converting constructor that can retain a reference', `void f(int step) { StepRef alias = step; ${loop} }`],
    ['an overloaded assignment that can retain a reference', `void f(int step) { StepRef alias; alias = step; ${loop} }`],
    ['a C-style class conversion', `void f(int step) { (StepRef)step; ${loop} }`],
    ['a named class conversion', `void f(int step) { static_cast<StepRef>(step); ${loop} }`],
    ['an explicit reference cast', `void f(int step) { (int&)step; ${loop} }`],
    ['a scalar initializer with an overloaded operator', `void f(int step) { int copied = step + marker; ${loop} }`],
    ['an overloaded comma expression', `void f(int step) { (step, marker); ${loop} }`],
    ['an overloaded subscript', `void f(int step) { indexRef[step]; ${loop} }`],
    ['an overloaded compound assignment destination', `void f(int step) { marker += step; ${loop} }`],
    ['an overloaded compound assignment with a scalar left side', `void f(int step) { step += marker; ${loop} }`],
    ['an unknown conditional conversion', `void f(int step, int flag) { (void)(flag ? step : marker); ${loop} }`],
    ['volatile storage', `void f(volatile int step) { ${loop} }`],
    ['an unknown alias that may be volatile', `void f(VolatileWord step) { ${loop} }`],
    ['a narrow step subject to integer promotion', `void f(unsigned char step) { ${loop} }`],
    ['a wide step', `void f(uint64_t step) { ${loop} }`],
    ['static storage another call can change', `void f() { static int step = 4; ${loop} }`],
    ['a global', `void f() { ${loop} }`],
    ['a shadowed name', `void f(int step) { if (step) { int step = 4; ${loop} } }`],
    ['an external entry into the loop', `void f(int step) { int offset = 0; L: do { visit(offset); offset += step * 4; } while (offset < 256); if (offset) goto L; }`],
    ['an initialization with side effects', `void f(int step) { ${loop.replace('= 0', '= init()')} }`],
    ['a wide multiplication literal', `void f(int step) { ${loop.replace('* 4', '* 4ULL')} }`],
  ]) {
    it(`declines ${reason}`, () => assert.doesNotMatch(run(source), /const uint32_t nByteStride/));
  }
});
