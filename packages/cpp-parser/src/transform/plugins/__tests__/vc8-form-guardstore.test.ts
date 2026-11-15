import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { FunctionDecl, IfStmt } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';

const facts: Vc8FormTables = {
  functionReturnTypes: { Check: 'Status' }, functionParamTypes: { Check: ['Game *', 'uint32_t'] },
  enumTypes: ['Status'], enumValues: { OK: 0 },
};
const source = 'uint32_t f(Game *game, uint32_t nSize, uint32_t code) { nSize = Check(game, code); if (nSize != OK) return Observe(&nSize); Place(game, &nSize); return nSize; }';
function run(code = source, tables: Vc8FormTables = facts, spelling = 'guardstore(nSize,status)') {
  const before = emit(parse(code)), sites: Vc8FormSite[] = [], form = parseVc8Form(spelling);
  assert.ok(form);
  const out = emit(applyVc8Forms(parse(code), [{ form }], s => sites.push(s), tables));
  assert.equal(sites.length, 1);
  return { before, out, site: sites[0] };
}
function refuse(code = source, tables = facts) {
  const r = run(code, tables); assert.equal(r.site.applied, false, r.out); assert.equal(r.out, r.before);
}

describe('guardstore', () => {
  it('preserves the original object and return expression on both paths', () => {
    const r = run(); assert.ok(r.site.applied, r.site.why);
    assert.match(r.out, /uint32_t status = Check\(game, code\);/);
    assert.match(r.out, /if \(status != OK\)\s*{\s*nSize = status;\s*return Observe\(&nSize\);/);
    assert.match(r.out, /}\s*nSize = status;\s*Place\(game, &nSize\);\s*return nSize;/);
    assert.equal((r.out.match(/Check\(/g) ?? []).length, 1);
  });
  for (const condition of ['nSize', '!nSize', '(nSize)', '!(nSize)']) it(`accepts the canonical scalar truth guard ${condition}`, () => {
    const r = run(source.replace('nSize != OK', condition)); assert.ok(r.site.applied, r.site.why);
    assert.equal((r.out.match(/nSize = status/g) ?? []).length, 2);
    assert.match(r.out, condition.startsWith('!') ? /if \(!status\)/ : /if \(status\)/);
  });
  for (const table of ['globalTypes', 'enclosingVarTypes'] as const) {
    it(`refuses an enumerator hidden by ${table}`, () => refuse(source, { ...facts, [table]: { OK: 'Watch' } }));
    it(`refuses a namespaced enumerator hidden by ${table}`, () => refuse(source, { ...facts, [table]: { 'GameCode::OK': 'Watch' }, enclosingSegments: ['GameCode'] }));
    it(`refuses a callable hidden by ${table}`, () => refuse(source, { ...facts, [table]: { Check: 'Callback' } }));
  }
  it('uses the declared signed type and keeps conversion before the comparison', () => {
    const r = run('int32_t f(Game *game, int32_t nSize, uint32_t code) { nSize = Check(game, code); if (nSize == -1) return nSize; return Observe(&nSize); }');
    assert.ok(r.site.applied, r.site.why); assert.match(r.out, /int32_t status = Check/); assert.match(r.out, /if \(status == -1\)/);
  });
  it('accepts a preceding nonstatic local and the mirrored comparison', () => {
    const r = run('uint32_t f(Game *game, uint32_t code) { uint32_t nSize = 9; nSize = Check(game, code); if (0 != nSize) return nSize; return Observe(&nSize); }');
    assert.ok(r.site.applied, r.site.why); assert.match(r.out, /if \(0 != status\)/);
  });
  it('resolves typed calls through their enclosing namespace', () => {
    const r = run(source, { ...facts, functionReturnTypes: { 'GameCode::Check': 'Status' }, functionParamTypes: { 'GameCode::Check': ['Game *', 'uint32_t'] }, enclosingSegments: ['GameCode'] });
    assert.ok(r.site.applied, r.site.why);
  });
  it('accepts a qualified function and enum constant without stripping type namespaces', () => {
    const r = run(source.replace('Check(', 'GameCode::Check(').replace('!= OK', '!= Result::OK'), { ...facts, functionReturnTypes: { 'GameCode::Check': 'Result::Status' }, functionParamTypes: { 'GameCode::Check': ['Game *', 'uint32_t'] }, enumTypes: ['Result::Status'], enumValues: { 'Result::OK': 0 } });
    assert.ok(r.site.applied, r.site.why);
  });
  it('permits an escaped destination whose identity and updates stay intact', () => {
    const r = run(source.replace('nSize = Check', 'uint32_t *alias = &nSize; Remember(alias); nSize = Check').replace('return Observe(&nSize)', 'return Observe(alias)'));
    assert.ok(r.site.applied, r.site.why); assert.match(r.out, /nSize = status;\s*return Observe\(alias\)/);
  });
  for (const t of ['volatile uint32_t', 'const uint32_t', 'uint16_t', 'uint64_t', 'bool', 'Value', 'Other::uint32_t', 'uint32_t &']) it(`refuses destination ${t}`, () => {
    refuse(source.replace('uint32_t nSize', `${t} nSize`));
  });
  for (const t of ['Value', 'Value &', 'Other::uint32_t', 'uint32_t *', 'void']) it(`refuses call return ${t}`, () => {
    refuse(source, { ...facts, functionReturnTypes: { Check: t } });
  });
  it('requires declared enum return facts instead of guessing from an unknown type', () => refuse(source, { ...facts, enumTypes: [] }));
  it('requires both return and parameter facts', () => { refuse(source, {}); refuse(source, { ...facts, functionParamTypes: {} }); });
  for (const t of ['Value', 'const Value &', 'uint32_t &', 'Other::uint32_t']) it(`refuses class or reference parameter ${t}`, () => {
    refuse(source, { ...facts, functionParamTypes: { Check: ['Game *', t] } });
  });
  it('refuses incomplete arity facts and implicit default arguments', () => {
    refuse(source, { ...facts, functionParamTypes: { Check: ['Game *'] } });
    refuse(source, { ...facts, functionParamTypes: { Check: ['Game *', 'uint32_t', 'Watch'] } });
  });
  it('refuses a class argument with an implicit scalar conversion', () => refuse(source.replace('uint32_t code', 'Value code')));
  it('refuses volatile argument reads', () => refuse(source.replace('uint32_t code', 'volatile uint32_t code')));
  for (const e of ['MakeCode()', 'code + 1', 'globalCode', '(uint32_t)code']) it(`refuses argument ${e}`, () => refuse(source.replace('Check(game, code)', `Check(game, ${e})`)));
  for (const c of ['nSize < OK', 'nSize != Read()', 'nSize != code', 'nSize != globalOK', 'nSize++ != 0', '!!nSize', 'nSize && code', '+nSize', '!Read()']) it(`refuses guard ${c}`, () => refuse(source.replace('nSize != OK', c)));
  it('refuses a shadowed enumerator even with a matching enum-value fact', () => refuse(source.replace('uint32_t code)', 'uint32_t code, uint32_t OK)')));
  it('refuses a local callable shadowing the function table', () => refuse(source.replace('uint32_t code)', 'uint32_t code, Callback Check)')));
  it('refuses a computed wrapper callee', () => refuse(source.replace('Check(game, code)', 'Wrapper(Check)(game, code)')));
  it('refuses a constructor-style value instead of a direct typed call', () => refuse(source.replace('Check(game, code)', '(uint32_t)Check(game, code)')));
  it('refuses an else, an extra arm statement, and a bare return', () => {
    refuse(source.replace('return Observe(&nSize);', '{ return Observe(&nSize); } else Keep();'));
    refuse(source.replace('return Observe(&nSize);', '{ Log(); return Observe(&nSize); }'));
    refuse(source.replace('return Observe(&nSize);', 'return;'));
  });
  it('refuses an if initializer that could observe the old destination', () => {
    // The frontend does not yet parse C++17 if initializers; the AST supports them.
    const tu = parse(source), fn = tu.declarations[0] as FunctionDecl;
    (fn.body!.statements[1] as IfStmt).init = (parse('void helper() { Watch watcher = MakeWatch(&nSize); }').declarations[0] as FunctionDecl).body!.statements[0];
    const before = emit(tu), sites: Vc8FormSite[] = [];
    assert.equal(emit(applyVc8Forms(tu,[{form:parseVc8Form('guardstore(nSize,status)')!}],s=>sites.push(s),facts)),before);
    assert.equal(sites[0].applied,false);
  });
  it('refuses a nested site', () => refuse(source.replace('nSize = Check', '{ nSize = Check').replace('Place(game', '} Place(game')));
  it('refuses ambiguous multiple matching sites', () => refuse(source.replace('Place(game, &nSize);', 'nSize = Check(game, code); if (nSize != OK) return nSize;')));
  it('refuses a shadowed argument or destination in another scope', () => refuse(source.replace('Place(game, &nSize);', '{ uint32_t code = 1; Use(code); }')));
  for (const storage of ['static', 'extern']) it(`refuses a ${storage} destination`, () => refuse(source.replace('uint32_t nSize, ', '').replace('{ nSize =', `{ ${storage} uint32_t nSize; nSize =`)));
  it('refuses a global destination', () => refuse(source.replace('uint32_t nSize, ', '')));
  for (const prefix of ['done: ;', 'if (code) goto done; done: ;', 'void Local();', 'typedef int Local;', '__try { Log(); } __except(1) { Recover(); }']) it(`refuses control-flow or local declaration ${prefix}`, () => refuse(source.replace('{ nSize =', `{ ${prefix} nSize =`)));
  it('refuses a temporary name that captures an existing expression or type', () => {
    refuse(source.replace('Place(game, &nSize);', 'status(game);'));
    refuse(source.replace('Place(game, &nSize);', 'status *pointer; Use(pointer);'));
  });
  for (const spelling of ['guardstore(nSize)', 'guardstore(nSize,status,1)', 'guardstore(nSize,status,@1)', 'guardstore(nSize,nSize)', 'guardstore(nSize,return)', 'guardstore(nSize,1x)']) it(`rejects invalid spelling ${spelling}`, () => assert.equal(parseVc8Form(spelling), undefined));
});
