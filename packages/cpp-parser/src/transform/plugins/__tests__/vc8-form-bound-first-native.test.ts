import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormTables } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

function transformed(source: string, condition: string, tables?: Vc8FormTables): string {
  let ast = parse(source);
  for (const text of ['clamp(v)', `tarms(${condition})`]) {
    const form = parseVc8Form(text), sites: { applied: boolean; why?: string }[] = [];
    assert.ok(form);
    ast = applyVc8Forms(ast, [{ form }], s => sites.push(s), tables);
    assert.equal(sites.length, 1);
    assert.ok(sites[0].applied, `${text}: ${sites[0].why}`);
  }
  return emit(ast as AnyNode);
}

const patterns = [
  { bound: '1', condition: 'value >= 1', select: 'value>=1' },
  { bound: '1', condition: '0 < value', select: 'value>=1' },
  { bound: '10', condition: 'value < 11', select: 'value<=10' },
  { bound: '0', condition: 'value > -1', select: 'value>=0' },
  { bound: '-100', condition: 'value >= -100', select: 'value>=-100' },
];
const pairs = patterns.map((p, i) => {
  const body = `(int32_t value) { int v = ${p.bound}; if (${p.condition}) v = value; return v; }`;
  return `int before${i}${body}\n${transformed(`int after${i}${body}`, p.select)}`;
}).join('\n');
const fieldBody = '(Reading *p) { int v = 1; if (0 < p->Param1) v = p->Param1; return v; }';
const field = transformed(`int afterField${fieldBody}`, 'p->Param1>=1', { structFields: { Reading: { Param1: 'int32_t' } } });

describe('bound-first clamp values from the actual combined AST forms', () => {
  it('emits both forms for direct, adjacent-threshold and field inputs', () => {
    assert.match(pairs, /value < 1 \? 1 : value/);
    assert.match(pairs, /value > 10 \? 10 : value/);
    assert.match(field, /p->Param1 < 1 \? 1 : p->Param1/);
  });

  for (const optimize of [false, true]) {
    it(`preserves signed32 extremes, negative and boundary inputs; optimized=${optimize}`, { skip: !hasNativeGpp() }, () => {
      const result = compileAndRun(`
struct Reading { int32_t Param1; };
${pairs}
int beforeField${fieldBody}
${field}`, `
int32_t special[] = { INT32_MIN, -1000, -1, 0, 1, 10, INT32_MAX };
unsigned checks = 0;
for (unsigned i = 0; i < 65543; ++i) {
  int32_t value = i < 65536 ? (int32_t)((int64_t)i * 65537 - 2147483648LL) : special[i - 65536];
  ${patterns.map((_, i) => `if (before${i}(value) != after${i}(value)) return 1; ++checks;`).join('\n  ')}
  Reading field = { value };
  if (beforeField(&field) != afterField(&field)) return 2;
  ++checks;
}
printf("%u\\n", checks);`, { optimize });
      assert.equal(result.trim(), String(65543 * (patterns.length + 1)));
    });
  }
});
