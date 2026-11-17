import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit, FunctionDecl, ExprStmt, LambdaExpr } from '../../../ast/nodes.js';
import { NodeKind } from '../../../ast/kinds.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const input = `void f(int early, uint32_t value) {
  uint32_t minimum;
  if (early) {
    minimum = value;
    Keep(minimum);
    return;
  }
  minimum = 0;
  Fill((int*)&minimum);
  Use(minimum);
}`;
const tables: Vc8FormTables = { functionParamTypes: { Keep: ['uint32_t'] } };
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
function run(source = input, context = tables, tag = 'split(minimum,uint32_t,minimumLocal)') {
  const sites: Vc8FormSite[] = [];
  const form = parseVc8Form(tag)!;
  const ast = applyVc8Forms(parse(source) as TranslationUnit, [{ form }], site => sites.push(site), context);
  return { code: emit(ast as AnyNode), site: sites[0] };
}
function refused(source: string, context = tables, tag?: string) {
  const { code, site } = run(source, context, tag);
  assert.equal(site.applied, false, source);
  assert.equal(flat(code), flat(emit(parse(source) as AnyNode)), 'refusal is atomic');
}

describe('vc8-form: split an addressed scalar after its unescaped lifetime', () => {
  it('splits the complete current SKILLDESC_DrawSkillDmgType3 emitted body', () => {
    const source = readFileSync(new URL('./fixtures/split-late-address-004ea310.cpp', import.meta.url), 'utf8');
    const context: Vc8FormTables = { functionParamTypes: { SKILLDESC_DrawSkillDmgPhysical: [
      'D2UnitStrc*', 'D2SkillStrc*', 'D2SkillsTxt*', 'int32_t', 'pfnSkillDescWeaponDmgCalc*',
      'int32_t', 'int', 'int32_t', 'int32_t', 'int32_t', 'int32_t',
    ] } };
    const { code, site } = run(source, context, 'split(nMinDamage,uint32_t,nMinDamageLocal)');
    assert.equal(site.applied, true, site.why);
    assert.match(code, /uint32_t nMinDamageLocal = 0;/);
    assert.match(code, /SKILLDESC_DrawDamageWithRange\(pUnit, \(int\*\)&nMinDamageLocal,/);
    assert.match(code, /SKILLDESC_DrawDamageNumbers\(nMinDamageLocal,/);
    assert.match(code, /SKILLDESC_DrawDamageWithRange, nMinDamage, pDamCalc2,/);
  });
  it('retains the early local and starts the later local at its dominating reset', () => {
    const { code, site } = run();
    assert.equal(site.applied, true, site.why);
    assert.match(flat(code), /minimum = value; Keep\(minimum\); return;/);
    assert.match(flat(code), /uint32_t minimumLocal = 0; Fill\(\(int\*\)&minimumLocal\); Use\(minimumLocal\);/);
  });
  it('retains the old initializer and preserves a later output alias', () => {
    const { code, site } = run(input.replace('uint32_t minimum;', 'uint32_t minimum = value;')
      .replace('Fill((int*)&minimum);', 'uint32_t* output = &minimum; Fill((int*)output);'));
    assert.equal(site.applied, true, site.why);
    assert.match(code, /uint32_t minimum = value;/);
    assert.match(code, /output = &minimumLocal/);
  });
  it('accepts parentheses around an earlier by-value read', () => {
    assert.equal(run(input.replace('Keep(minimum)', 'Keep((minimum))')).site.applied, true);
  });
  it('accepts an explicit integer conversion before an unknown call', () => {
    assert.equal(run(input.replace('Keep(minimum)', 'Keep((uint32_t)minimum)'), {}).site.applied, true);
  });
  for (const type of ['volatile uint32_t', 'const uint32_t', 'static uint32_t', 'float', 'uint16_t', 'uint64_t', 'Unknown', 'uint32_t*']) {
    it(`refuses original type ${type}`, () => refused(input.replace('uint32_t minimum;', `${type} minimum;`)));
  }
  it('refuses changing the scalar type', () => refused(input, tables, 'split(minimum,int32_t,minimumLocal)'));
  it('refuses an unknown earlier call contract', () => refused(input, {}));
  for (const type of ['uint32_t&', 'const uint32_t&', 'uint32_t&&', 'Unknown', 'uint32_t*']) {
    it(`refuses the earlier parameter type ${type}`, () => refused(input, { functionParamTypes: { Keep: [type] } }));
  }
  for (const statement of [
    'KeepAddress(&minimum);', 'uint32_t* saved = &minimum;', 'uint32_t& saved = minimum;',
    'const uint32_t& saved = minimum;', 'KeepAddress((uint32_t*)&minimum);',
    'KeepAddress((uint32_t&)minimum);', 'Capture(minimum = value);', 'Unknown sink = minimum;',
  ]) {
    it(`refuses an earlier identity escape: ${statement}`, () => refused(input.replace('Keep(minimum);', statement)));
  }
  it('refuses a parameter shadowing the local', () => refused(input.replace('int early', 'int minimum')));
  it('refuses a second local binding', () => refused(input.replace('Use(minimum);', '{ uint32_t minimum = 1; Use(minimum); }')));
  it('refuses a local call target despite a same-name context entry', () => refused(input.replace('int early', 'void (*Keep)(uint32_t&), int early')));
  it('refuses a reset in a nested block', () => refused(input.replace('minimum = 0;', '{ minimum = 0;') + '}'));
  for (const reset of ['minimum = value;', 'minimum = 0b1;', 'minimum = 1;', 'minimum += 0;']) {
    it(`refuses a different reset: ${reset}`, () => refused(input.replace('minimum = 0;', reset)));
  }
  it('refuses multiple outer zero resets', () => refused(input.replace('minimum = 0;', 'minimum = 0; minimum = 0;')));
  for (const statement of ['again: Use(minimum);', 'goto again;', 'while (value) { Use(minimum); }',
    '__try { Use(minimum); } __finally { Use(minimum); }',
    'enum E { minimum = 1 };', 'setjmp(value);', '_setjmp3(value);', '__builtin_setjmp(value);',
    'std::longjmp(value);', 'Use(ns::minimum);']) {
    it(`refuses unmodelled scope or control flow: ${statement}`, () => refused(input.replace('Use(minimum);', statement)));
  }
  it('refuses a fresh name already used as a global', () => refused(input.replace('Use(minimum);', 'Use(minimum + minimumLocal);')));
  it('refuses a malformed fresh name', () => refused(input, tables, 'split(minimum,uint32_t,new+name)'));

  it('preserves an unrelated member with the same spelling', () => {
    const { code, site } = run(input.replace('Use(minimum);', 'object.minimum = minimum;'));
    assert.equal(site.applied, true, site.why);
    assert.match(code, /object\.minimum = minimumLocal;/);
  });
  it('refuses a lambda supplied by an AST caller', () => {
    const ast = parse(input) as TranslationUnit;
    const fn = ast.declarations[0] as FunctionDecl;
    fn.body!.statements.push({ kind: NodeKind.ExprStmt, expression: {
      kind: NodeKind.LambdaExpr, captures: [], captureDefault: '&', parameters: [],
      returnType: null, specifiers: [], body: { kind: NodeKind.CompoundStmt, statements: [] },
    } as LambdaExpr } as ExprStmt);
    const before = emit(ast as AnyNode);
    let site: Vc8FormSite | undefined;
    const after = applyVc8Forms(ast, [{ form: parseVc8Form('split(minimum,uint32_t,minimumLocal)')! }], s => { site = s; }, tables);
    assert.equal(site?.applied, false);
    assert.equal(emit(after as AnyNode), before);
  });

  it('preserves branch results, output writes and event order for native inputs', { skip: !hasNativeGpp() }, () => {
    const transformed = run().code.replace('void f(', 'void changed(');
    const original = input.replace('void f(', 'void original(');
    const prelude = `#include <stdint.h>
#include <stdio.h>
static uint32_t result;
static unsigned events;
void Keep(uint32_t x) { result = x; events = events * 3 + 1; }
void Fill(int* p) { *p = 12345; events = events * 3 + 2; }
void Use(uint32_t x) { result = x; events = events * 3 + 1; }
${original}
${transformed}`;
    const output = compileAndRun(prelude, `for (unsigned i = 0; i < 16384; ++i) {
  for (int early = 0; early != 2; ++early) {
    uint32_t value = i * 2654435761u;
    result = 0; events = 0; original(early, value);
    uint32_t expected = result; unsigned expectedEvents = events;
    result = 0; events = 0; changed(early, value);
    if (result != expected || events != expectedEvents) return 1;
  }
}
printf("32768\\n");`);
    assert.equal(output.trim(), '32768');
  });
});
