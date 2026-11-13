import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormTables, type Vc8FormSite } from '../builtins/vc8-form.js';

const tables = (): Vc8FormTables => ({
  structFields: { Link: { prev: 'Link*', next: 'intptr_t' } },
  structLayouts: { Link: [{ name: 'prev', type: 'Link*', offset: 0, size: 4 }, { name: 'next', type: 'intptr_t', offset: 4, size: 4 }] },
  typedefTargets: { intptr_t: 'int' },
});
const SOURCE = 'Link* f(Link* p) { p->prev = 0; p->next = 0; p->prev = p; return p; }';
function run(code = SOURCE, t: Vc8FormTables = tables(), spelling = 'keepstore(p->prev)') {
  const form = parseVc8Form(spelling);
  assert.ok(form);
  const sites: Vc8FormSite[] = [];
  const original = parse(code);
  const out = applyVc8Forms(original, [{ form }], s => sites.push(s), t);
  return { text: emit(out), original: emit(original), site: sites[0] };
}
describe('keepstore', () => {
  it('parses only a positive occurrence and the right arity', () => {
    assert.deepEqual(parseVc8Form('keepstore(p->prev)'), { op: 'keepstore', expr: 'p->prev', index: 1 });
    assert.deepEqual(parseVc8Form('keepstore(p->prev,2)'), { op: 'keepstore', expr: 'p->prev', index: 2 });
    for (const f of ['keepstore()', 'keepstore(p->prev,0)', 'keepstore(p->prev,-1)', 'keepstore(p->prev,1,2)', 'keepstore(p->prev,@2)']) assert.equal(parseVc8Form(f), undefined);
  });
  it('qualifies exactly the existing zero destination, retaining every value and store', () => {
    const r = run();
    assert.equal(r.site.applied, true, r.site.why);
    assert.match(r.text, /\(\(volatile Link\*\)p\)->prev = 0;/);
    assert.match(r.text, /p->next = 0;/);
    assert.match(r.text, /p->prev = p;/);
    assert.equal((r.text.match(/ = /g) ?? []).length, 3);
    assert.equal((r.original.match(/volatile/g) ?? []).length, 0);
  });
  it('handles an aliased pointer local with one declaration', () => {
    const r = run('Link* f(List* list) { Link* p = &list->head; p->prev = 0; p->next = 0; p->prev = p; return p; }');
    assert.equal(r.site.applied, true, r.site.why);
  });
  it('proves the immediately preceding subobject alias without accepting another owner', () => {
    const t = tables();
    t.structFields!.List = { head: 'Link' };
    t.structLayouts!.List = [{ name: 'head', type: 'Link', offset: 4, size: 8 }];
    const code = 'Link* f(List* list, List* other) { Link* p = &list->head; p->prev = 0; list->head.next = 0; p->prev = p; return p; }';
    const r = run(code, t);
    assert.equal(r.site.applied, true, r.site.why);
    for (const bad of [code.replace('list->head.next = 0', 'other->head.next = 0'), code.replace('p->prev = 0;', 'int n = 0; p->prev = 0;'), code.replace('&list->head', '&Get()->head')]) {
      const r = run(bad, t);
      assert.equal(r.site.applied, false);
      assert.equal(r.text, r.original);
    }
  });
  it('takes the selected zero occurrence and refuses a missing one', () => {
    const code = 'void f(Link* p) { p->prev = 0; p->prev = p; p->prev = 0; p->prev = p; }';
    const r = run(code, tables(), 'keepstore(p->prev,2)');
    assert.equal(r.site.applied, true, r.site.why);
    assert.match(r.text, /p->prev = 0;\s*p->prev = p;\s*\(\(volatile Link\*\)p\)->prev = 0;/);
    const absent = run(code, tables(), 'keepstore(p->prev,3)');
    assert.equal(absent.site.applied, false);
    assert.equal(absent.text, absent.original);
  });
  for (const [label, middle] of [
    ['a call', 'g(p);'], ['a branch', 'if (flag) p->next = 0;'], ['a pointer update', 'p++;'],
    ['an alias read', 'q->next = p->next;'], ['a member read', 'p->next = p->next;'],
    ['a computed value', 'p->next = value + 1;'], ['a compound update', 'p->next += 1;'],
    ['a label', 'again: p->next = 0;'], ['an early return', 'return p;'],
  ]) it(`refuses ${label} between zero and overwrite`, () => {
    const r = run(`Link* f(Link* p, Link* q, int flag, int value) { p->prev = 0; ${middle} p->prev = p; return p; }`);
    assert.equal(r.site.applied, false);
    assert.equal(r.text, r.original);
  });
  it('refuses without an overwrite or for a nonzero/compound store', () => {
    for (const code of ['void f(Link* p) { p->prev = 0; p->next = 0; }', 'void f(Link* p) { p->prev = p; p->prev = 0; }', 'void f(Link* p) { p->next += 0; p->next = 0; }']) {
      const r = run(code);
      assert.equal(r.site.applied, false);
      assert.equal(r.text, r.original);
    }
  });
  it('refuses unknown, inconsistent, overlapping, bitfield and nonscalar layouts', () => {
    const variants: Vc8FormTables[] = [{}, { structFields: tables().structFields }, tables(), tables(), tables(), tables(), tables()];
    variants[2].structLayouts!.Link[0].bitSize = 1;
    variants[3].structLayouts!.Link[1].offset = 0;
    variants[4].structFields!.Link.prev = 'Other*';
    variants[5].structLayouts!.Link[0].type = variants[5].structFields!.Link.prev = 'int[4]';
    variants[6].structLayouts!.Link[0].type = variants[6].structFields!.Link.prev = 'float';
    for (const t of variants) {
      const r = run(SOURCE, t);
      assert.equal(r.site.applied, false, JSON.stringify(t));
      assert.equal(r.text, r.original);
    }
  });
  it('refuses qualified, shadowed, global and effectful base pointers', () => {
    for (const code of [SOURCE.replace('Link* p)', 'volatile Link* p)'), SOURCE.replace('Link* p)', 'const Link* p)'), 'void f(Link* p) { { Link* p; p->prev = 0; p->prev = p; } }', 'void f() { p->prev = 0; p->prev = p; }', 'void f(Link* p) { Get()->prev = 0; Get()->prev = p; }']) {
      const r = run(code);
      assert.equal(r.site.applied, false);
      assert.equal(r.text, r.original);
    }
  });
});
