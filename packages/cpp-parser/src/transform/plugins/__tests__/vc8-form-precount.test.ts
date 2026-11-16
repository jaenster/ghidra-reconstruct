import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';

export const source = `int f(Node **buckets) {
  Node *cursor;
  int count = 0;
  int index = 0;
  do {
    if (buckets[index]) {
      for (cursor = ReadNext(buckets[index]); count++, cursor != 0; cursor = ReadNext(cursor)) {}
    }
    index++;
  } while (index < 8);
  return count;
}`;
const fact = { parameterType: 'Node*', returnType: 'Node*', fieldType: 'Node*', member: 'next', offset: 4, functionAddress: '00401000' };
export const tables: Vc8FormTables = { nonNullFieldRead: (callee, argc) => callee === 'ReadNext' && argc === 1 ? fact : null };
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
export function run(text: string, evidence: Vc8FormTables = tables) {
  const form = parseVc8Form('precount(count,cursor)'); assert.ok(form);
  const sites: Vc8FormSite[] = [];
  const ast = parse(text) as TranslationUnit, before = emit(ast as AnyNode);
  const result = applyVc8Forms(ast, [{ form }], s => sites.push(s), evidence);
  assert.equal(emit(ast as AnyNode), before, 'input stays immutable');
  return { out: emit(result as AnyNode), site: sites[0], before };
}

describe('vc8-form: precount', () => {
  it('parses two distinct non-keyword identifiers', () => {
    assert.deepEqual(parseVc8Form('precount(count,cursor)'), { op: 'precount', counter: 'count', cursor: 'cursor' });
    for (const tag of ['precount(count)', 'precount(count,count)', 'precount(count,p.x)', 'precount(count,p,@1)', 'precount(int,p)']) assert.equal(parseVc8Form(tag), undefined);
  });
  it('moves the discarded increment before both getter calls and preserves call sites', () => {
    const r = run(source); assert.ok(r.site.applied, r.site.why);
    assert.match(flat(r.out), /for \(count\+\+\s*, cursor = ReadNext\(buckets\[index\]\); cursor != 0; count\+\+\s*, cursor = ReadNext\(cursor\)\)/);
    assert.equal(r.out.match(/ReadNext\(/g)?.length, 2);
  });
  it('also accepts explicit nonzero guards and a plain pointer argument', () => {
    const r = run(source.replace('Node **buckets', 'Node *bucket').split('buckets[index]').join('bucket').replace('if (bucket)', 'if (bucket != 0)'));
    assert.ok(r.site.applied, r.site.why);
  });
  it('does not change an untagged function', () => {
    const ast = parse(source) as TranslationUnit;
    assert.equal(emit(applyVc8Forms(ast, []) as AnyNode), emit(ast as AnyNode));
  });
  const cases: [string, string, Vc8FormTables?][] = [
    ['absent getter evidence', source, {}],
    ['unknown getter', source, { nonNullFieldRead: () => null }],
    ['incompatible getter', source, { nonNullFieldRead: () => ({ ...fact, returnType: 'Other*' }) }],
    ['global counter', source.replace('  int count = 0;', '')],
    ['uninitialised counter', source.replace('int count = 0', 'int count')],
    ['nonzero initial counter', source.replace('int count = 0', 'int count = 2')],
    ['static counter', source.replace('int count = 0', 'static int count = 0')],
    ['volatile counter', source.replace('int count = 0', 'volatile int count = 0')],
    ['BOOL counter', source.replace('int count = 0', 'BOOL count = 0')],
    ['narrow counter', source.replace('int count = 0', 'int16_t count = 0')],
    ['unsigned alias', source.replace('int count = 0', 'int32_t count = 0'), { ...tables, typedefTargets: { int32_t: 'unsigned int' } }],
    ['cyclic alias', source.replace('int count = 0', 'int32_t count = 0'), { ...tables, typedefTargets: { int32_t: 'Alias', Alias: 'int32_t' } }],
    ['converting type', source.replace('int count = 0', 'int32_t count = 0'), { ...tables, aggregateMembers: { int32_t: [] } }],
    ['counter observer', source.replace('index++;', 'Observe(count); index++;')],
    ['counter address', source.replace('index++;', 'Keep(&count); index++;')],
    ['counter-dependent argument', source.split('buckets[index]').join('buckets[count]')],
    ['shadowed counter', source.replace('index++;', '{ int count = 9; } index++;')],
    ['initialized cursor', source.replace('Node *cursor;', 'Node *cursor = 0;')],
    ['volatile cursor', source.replace('Node *cursor;', 'Node * volatile cursor;')],
    ['cursor observer', source.replace('index++;', 'Observe(cursor); index++;')],
    ['volatile bucket', source.replace('Node **buckets', 'Node * volatile *buckets')],
    ['volatile index', source.replace('int index = 0', 'volatile int index = 0')],
    ['global index', source.replace('  int index = 0;', '')],
    ['effectful index', source.split('buckets[index]').join('buckets[NextIndex()]')],
    ['converting index', source.replace('int index = 0', 'Index index = 0')],
    ['missing guard', source.replace('if (buckets[index])', 'if (Ready())')],
    ['intervening guard operation', source.replace('if (buckets[index]) {', 'if (buckets[index]) { Observe();')],
    ['loop body', source.replace(')) {}', ')) { Observe(); }')],
    ['different update getter', source.replace('ReadNext(cursor)', 'OtherNext(cursor)')],
    ['computed callee', source.split('ReadNext(').join('(*getter)(')],
    ['shadowed callee', source.replace('  Node *cursor;', '  Fn ReadNext; Node *cursor;')],
    ['different pointer test', source.replace('cursor != 0', 'cursor == 0')],
    ['extra condition', source.replace('count++, cursor != 0', 'count++, Ready(), cursor != 0')],
    ['label entry', source.replace('    if (buckets[index])', '    again: if (buckets[index])')],
    ['local typedef', source.replace('  Node *cursor;', '  typedef int Local; Node *cursor;')],
  ];
  for (const [name, text, evidence] of cases) it(`refuses ${name} without a partial edit`, () => {
    const r = run(text, evidence); assert.equal(r.site.applied, false, r.out); assert.equal(r.out, r.before);
  });
});
