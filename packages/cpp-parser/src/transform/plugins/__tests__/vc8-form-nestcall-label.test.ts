import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';

const tables: Vc8FormTables = { functionReturnTypes: { Lookup: 'C*', Name: 'char*' }, functionParamTypes: {
  Lookup: ['U*', 'int'], Mark: ['C*'], Flags: ['C*'], Name: ['C*'],
  Save: ['U*', 'char*', 'int'], Use: ['C*'], Check: ['C*'], Capture: ['C*&'],
} };
function run(source: string, forms: string[], facts = tables) {
  const sites: Vc8FormSite[] = [];
  const before = emit(parse(source));
  const out = emit(applyVc8Forms(parse(source), forms.map(f => ({ form: parseVc8Form(f)! })), s => sites.push(s), facts));
  return { before, out, sites };
}
function refused(source: string, facts = tables) {
  const r = run(source, ['nestcall(p)'], facts);
  assert.equal(r.sites.length, 1);
  assert.equal(r.sites[0].applied, false, r.out);
  assert.equal(r.out, r.before);
}

describe('nestcall across pointer declarations and terminal labels', () => {
  it('nests the second client life and the name while retaining the first client life', () => {
    const r = run(`void f(U* unit, int online) {
      C* client;
      client = Lookup(unit, 1);
      Mark(client);
      if (online) { if (!Flags(client)) goto done; }
      int overwrite; overwrite = 0;
      client = Lookup(unit, 2);
      char* name;
      name = Name(client);
      Save(unit, name, overwrite);
    done:
      Finish(unit);
    }`, ['nestcall(client,2)', 'nestcall(name)']);
    assert.ok(r.sites.every(s => s.applied), JSON.stringify(r.sites));
    assert.match(r.out, /Save\(unit, Name\(Lookup\(unit, 2\)\), overwrite\)/);
    assert.match(r.out, /client = Lookup\(unit, 1\)/);
    assert.match(r.out, /Mark\(client\)/);
    assert.match(r.out, /Flags\(client\)/);
    assert.equal((r.out.match(/Lookup\(/g) ?? []).length, 2);
    assert.doesNotMatch(r.out, /char\* name/);
  });

  it('crosses more than one inert pointer declaration without moving the declarations', () => {
    const r = run('void f(U* unit) { C* p = Lookup(unit, 2); C* a; char* b; Use(p); done: Finish(unit); }', ['nestcall(p)']);
    assert.ok(r.sites[0].applied, r.sites[0].why);
    assert.match(r.out, /C\* a;\s+char\* b;\s+Use\(Lookup\(unit, 2\)\)/);
  });

  for (const [label, declaration] of [
    ['a class construction', 'Watch watch;'],
    ['an initialized pointer', 'C* scratch = Other();'],
    ['a static pointer', 'static C* scratch;'],
    ['an extern pointer', 'extern C* scratch;'],
    ['a volatile pointer', 'C* volatile scratch;'],
    ['a pointer to volatile data', 'volatile C* scratch;'],
    ['an array', 'C* scratch[2];'],
  ]) it(`refuses to cross ${label}`, () => {
    refused(`void f(U* unit) { C* p = Lookup(unit, 2); ${declaration} Use(p); done: Finish(unit); }`);
  });

  it('refuses a declaration shadowing an input of the moved lookup', () => {
    refused('void f(U* unit) { { C* p = Lookup(unit, 2); U* unit; Use(p); } }');
  });
  it('refuses a later read behind the label', () => {
    refused('void f(U* unit) { C* p = Lookup(unit, 2); Use(p); done: Use(p); }');
  });
  it('refuses a backward jump to an earlier read of the previous pointer value', () => {
    refused('void f(U* unit, int retry) { C* p = 0; again: Use(p); p = Lookup(unit, 2); Use(p); done: if (retry) goto again; }');
  });
  it('refuses a consumer arm that jumps back to an earlier pointer read', () => {
    refused('void f(U* unit) { C* p = 0; again: Use(p); p = Lookup(unit, 2); if (Check(p)) goto again; done: Finish(unit); }');
  });
  it('refuses the terminal-label exception inside a loop', () => {
    refused('void f(U* unit, int retry) { C* p = 0; while (retry) { Use(p); p = Lookup(unit, 2); Use(p); done: Finish(unit); } }');
  });
  it('refuses an escaped pointer object', () => {
    refused('void f(U* unit) { C* p; Remember(&p); p = Lookup(unit, 2); Use(p); done: Finish(unit); }');
  });
  it('refuses a local reference alias without an address-of expression', () => {
    refused('void f(U* unit) { C* p = 0; C*& alias = p; p = Lookup(unit, 2); Use(p); done: Use(alias); }');
  });
  it('refuses a constructor that could bind a reference to the pointer', () => {
    refused('void f(U* unit) { C* p = 0; Watch watch(p); p = Lookup(unit, 2); Use(p); done: Finish(unit); }');
  });
  it('refuses a reference parameter in an earlier call', () => {
    refused('void f(U* unit) { C* p = 0; Capture(p); p = Lookup(unit, 2); Use(p); done: Finish(unit); }');
  });
  it('refuses unknown parameter facts for the new shape', () => {
    refused('void f(U* unit) { C* p = Lookup(unit, 2); Use(p); done: Finish(unit); }', { functionParamTypes: {} });
  });
  it('refuses a converting or unknown lookup return type', () => {
    const source = 'void f(U* unit) { C* p = Lookup(unit, 2); Use(p); done: Finish(unit); }';
    refused(source, { ...tables, functionReturnTypes: {} });
    refused(source, { ...tables, functionReturnTypes: { Lookup: 'DerivedClient*' } });
    refused(source, { ...tables, functionReturnTypes: { Lookup: 'Other::C*' } });
  });
  it('refuses repeated local declarations with the same pointer name', () => {
    refused('void f(U* unit) { C* p = Lookup(unit, 2); Use(p); done: { C* p = 0; Use(p); } }');
  });
  it('retains the sibling-call restriction', () => {
    const r = run('void f(U* unit) { C* p = Lookup(unit, 2); char* name; Save(unit, Name(p), Other()); done: Finish(unit); }', ['nestcall(p)']);
    assert.equal(r.sites[0].applied, false);
    assert.equal(r.out, r.before);
  });
  it('does not extend label handling to an arbitrary class or integer temporary', () => {
    for (const type of ['int', 'Value']) refused(`void f(U* unit) { ${type} p = Lookup(unit, 2); Use(p); done: Finish(unit); }`);
  });
});
