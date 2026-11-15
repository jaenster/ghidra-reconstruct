import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';

const TABLES: Vc8FormTables = {
  structLayouts: { Color: [
    { name: 'hue', type: 'double', offset: 0, size: 8 },
    { name: 'saturation', type: 'double', offset: 8, size: 8 },
    { name: 'lightness', type: 'double', offset: 16, size: 8 },
  ] }, aggregateSizes: { Color: 24 },
};
export const COUNTDOWN = `void f(Color* rows) {
  double old;
  int left = 4;
  do {
    if (rows[-left + 4].lightness != 0.0) {
      old = rows[-left + 4].lightness;
      rows[-left + 4].lightness = old + 0.2;
      if (1.0 < old + 0.2) rows[-left + 4].lightness = 1.0;
    }
    left--;
  } while (left);
}`;
export function project(code = COUNTDOWN, tables = TABLES, tag = 'ptrwalk(left,rows,cursor,double)') {
  const input = parse(code) as TranslationUnit;
  const before = emit(input as AnyNode);
  const sites: Vc8FormSite[] = [];
  const form = parseVc8Form(tag)!;
  const result = applyVc8Forms(input, [{ form }], site => sites.push(site), tables);
  return { before, code: emit(result as AnyNode), site: sites[0] };
}
function refused(code: string, tables = TABLES) {
  const result = project(code, tables);
  assert.equal(result.site.applied, false, result.site.why);
  assert.equal(result.code, result.before, 'refusal is atomic');
}

describe('ptrwalk: countdown over one scalar record field', () => {
  it('refuses a keyword pointer name without throwing or partly editing the function', () => {
    const result = project(COUNTDOWN, TABLES, 'ptrwalk(left,rows,class,double)');
    assert.equal(result.site.applied, false);
    assert.equal(result.code, result.before);
  });
  it('keeps the full scalar value and arithmetic, with the native field stride', () => {
    const result = project(); assert.ok(result.site.applied, result.site.why);
    assert.match(result.code, /double\* cursor = &rows\[0\]\.lightness;\s+int left = 4;/);
    assert.match(result.code, /if \(\*cursor != 0\.0\)/);
    assert.match(result.code, /old = \*cursor;/);
    assert.match(result.code, /\*cursor = old \+ 0\.2;/);
    assert.match(result.code, /cursor \+= 3;\s+left--;/);
    assert.doesNotMatch(result.code, /rows\[-left/);
  });
  it('recognizes K-i, explicit nonzero, and compound decrement', () => {
    const result = project(COUNTDOWN.replace(/-left \+ 4/g, '4 - left').replace('left--;', 'left -= 1;').replace('while (left)', 'while (left != 0)'));
    assert.ok(result.site.applied, result.site.why);
  });
  it('uses the production type-size callback when aggregateSizes is not passed to source forms', () => {
    const result = project(COUNTDOWN, { ...TABLES, aggregateSizes: {}, typeSize: type => type === 'Color' ? 24 : null });
    assert.ok(result.site.applied, result.site.why);
  });
  it('does not speculate an address for a zero, negative or computed countdown', () => {
    for (const value of ['0', '-4', 'limit', 'g()']) refused(COUNTDOWN.replace('left = 4', `left = ${value}`));
  });
  it('requires an automatic counter and cannot shadow a type or change a union lifetime', () => {
    refused(COUNTDOWN.replace('int left', 'static int left'));
    refused(COUNTDOWN.replace('Color* rows', 'cursor* rows'));
    refused(COUNTDOWN, { ...TABLES, unionNames: ['Color'] });
  });
  it('requires the exact nonvolatile scalar type, field and record stride', () => {
    for (const tables of [
      {}, { ...TABLES, aggregateSizes: { Color: 23 } },
      { ...TABLES, structLayouts: { Color: [{ name: 'lightness', type: 'float', offset: 16, size: 4 }] } },
      { ...TABLES, structLayouts: { Color: [{ name: 'lightness', type: 'volatile double', offset: 16, size: 8 }] } },
      { ...TABLES, structLayouts: { Color: [{ name: 'lightness', type: 'double', offset: 16, size: 8, bitSize: 1 }] } },
      { ...TABLES, structLayouts: { Color: [{ name: 'lightness', type: 'double', offset: 12, size: 8 }] } },
    ]) refused(COUNTDOWN, tables);
  });
  it('refuses another field, index, or use of the counter or base', () => {
    for (const code of [
      COUNTDOWN.replace('old = rows[-left + 4].lightness', 'old = rows[-left + 4].hue'),
      COUNTDOWN.replace('old = rows[-left + 4].lightness', 'old = rows[-left + 3].lightness'),
      COUNTDOWN.replace('old + 0.2', 'old + left'),
      COUNTDOWN.replace('left--;', 'rows++; left--;'),
      COUNTDOWN.replace('left--;', 'left--; left--;'),
    ]) refused(code);
  });
  it('refuses address escapes, reference bindings and shadowed names', () => {
    for (const code of [
      COUNTDOWN.replace('} while (left);', '} while (left); int* alias = &left;'),
      COUNTDOWN.replace('double old;', 'double old; Color*& alias = rows;'),
      COUNTDOWN.replace('double old;', 'double old; if (rows) { int left = 0; }'),
      COUNTDOWN.replace('double old;', 'double old; double* cursor;'),
      COUNTDOWN.replace('Color* rows', 'volatile Color* rows'),
      COUNTDOWN.replace('int left', 'volatile int left'),
    ]) refused(code);
  });
  it('refuses calls, escaping or nested control, and implicit class operations', () => {
    for (const body of ['g();', 'continue;', 'break;', 'return;', 'while (old) old = 0;', 'proxy = 1;']) {
      const code = COUNTDOWN.replace('double old;', 'double old; Proxy proxy;').replace('left--;', `${body} left--;`);
      refused(code);
    }
    refused(COUNTDOWN.replace('old + 0.2', '(Proxy)old + 0.2'));
    refused(COUNTDOWN.replace('old + 0.2', 'static_cast<Proxy>(old) + 0.2'));
    refused(COUNTDOWN.replace('old + 0.2', 'globalProxy + old'));
  });
  it('requires a first field access that is unconditionally evaluated', () => {
    const code = COUNTDOWN.replace('Color* rows)', 'Color* rows, int flag)');
    refused(code.replace('if (rows[-left + 4].lightness != 0.0)', 'if (flag && rows[-left + 4].lightness != 0.0)'));
    refused(code.replace('if (rows[-left + 4].lightness != 0.0)', 'if (flag)'));
  });
});
