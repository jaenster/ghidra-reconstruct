import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { NodeKind as K } from '../../../ast/kinds.js';
import type { ExprStmt, FunctionDecl, IfStmt } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';

const source = 'int f(int src, int flag) { int result = 7; int value = src; if (flag) { result = value; value++; result += value; } return result; }';
function run(code = source, tables: Vc8FormTables = {}, spelling = 'guardinit(value)') {
  const before = emit(parse(code)), sites: Vc8FormSite[] = [], form = parseVc8Form(spelling);
  assert.ok(form);
  const out = emit(applyVc8Forms(parse(code), [{ form }], s => sites.push(s), tables));
  assert.equal(sites.length, 1);
  return { before, out, site: sites[0] };
}
function refuse(code: string, tables: Vc8FormTables = {}) {
  const r = run(code, tables); assert.equal(r.site.applied, false, r.out); assert.equal(r.out, r.before);
}

describe('guardinit', () => {
  it('moves a primitive declaration into its sole guarded lifetime', () => {
    const r = run(); assert.ok(r.site.applied, r.site.why);
    assert.match(r.out, /int result = 7;\s*if \(flag\)\s*{\s*int value = src;/);
    assert.equal((r.out.match(/int value/g) ?? []).length, 1);
  });
  for (const guard of ['value', '!value', 'value != 0', '(value & 7) == flag', '(unsigned int)value > 0']) it(`retargets the builtin guard ${guard}`, () => {
    const r = run(source.replace('if (flag)', `if (${guard})`)); assert.ok(r.site.applied, r.site.why);
    assert.doesNotMatch(r.out.slice(r.out.indexOf('if ('), r.out.indexOf('{', r.out.indexOf('if ('))), /\bvalue\b/);
    assert.match(r.out, /if \([^\n]*src/);
  });
  it('wraps a single statement and accepts an earlier initialized source local', () => {
    const r = run('void f(int x, int flag) { int src = x; int result = 0; int value = src; if (flag) result = value; }');
    assert.ok(r.site.applied, r.site.why); assert.match(r.out, /if \(flag\)\s*{\s*int value = src;\s*result = value;/);
  });
  it('preserves an existing pointer lifetime before the later guarded reset', () => {
    const r = run('void f(uint16_t *src, int flag) { uint16_t *value = src; for (int i=0; i<3; i++) { *value = i; value += 6; } value = src; if (flag) { do { *value = 8; value += 6; } while (--flag); } }');
    assert.ok(r.site.applied, r.site.why); assert.match(r.out, /uint16_t\* value = src;\s*for/);
    assert.match(r.out, /if \(flag\)\s*{\s*value = src;\s*do/);
  });
  it('uses ordinary field facts for a casted packet count without caching it', () => {
    const r = run(source.replace('int flag)', 'Packet *packet)').replace('if (flag)', 'if ((uint16_t)packet->count > 0)'), { structFields: { Packet: { count: 'int16_t' } } });
    assert.ok(r.site.applied, r.site.why); assert.match(r.out, /if \(\(uint16_t\)packet->count > 0\)/);
  });
  for (const type of ['const int', 'volatile int', 'int &', 'Value', 'Other::int32_t']) it(`refuses destination type ${type}`, () => refuse(source.replace('int value', `${type} value`)));
  for (const type of ['unsigned int', 'short', 'volatile int', 'const int', 'int &', 'Other::int32_t']) it(`refuses source type ${type}`, () => refuse(source.replace('int src', `${type} src`)));
  for (const storage of ['static', 'extern']) it(`refuses ${storage} storage`, () => refuse(source.replace('int value', `${storage} int value`)));
  for (const rhs of ['src + 0', 'Read()', '(int)src', 'globalValue']) it(`refuses a non-binding copy ${rhs}`, () => refuse(source.replace('value = src', `value = ${rhs}`)));
  for (const guard of ['Read()', 'flag++', '++flag', '(flag = 1)', 'flag, 1', '*unknown', 'unknown', 'object', 'object == 1']) it(`refuses impure or untyped guard ${guard}`, () => refuse(source.replace('if (flag)', `if (${guard})`)));
  it('refuses volatile and unknown member facts', () => {
    const code = source.replace('int flag)', 'Packet *packet)').replace('if (flag)', 'if (packet->count)');
    refuse(code); refuse(code, { structFields: { Packet: { count: 'volatile int' } } });
    refuse(code, { structFields: { Packet: { count: 'Value' } } });
    refuse(code, { structFields: { Packet: { count: 'int' } }, unionNames: ['Packet'] });
  });
  it('does not strip the namespace from member owner types', () => {
    const code = source.replace('int flag)', 'Other::Packet *packet)').replace('if (flag)', 'if (packet->count)');
    refuse(code, { structFields: { Packet: { count: 'int' } } });
    assert.ok(run(code, { structFields: { 'Other::Packet': { count: 'int' } } }).site.applied);
  });
  for (const use of ['Remember(&value);', 'Reference(value);', 'Value other = value;', 'const int &alias = value;', 'int &alias = (int &)value;', 'sizeof(value);', 'return value;', 'result = unknown = value;']) it(`refuses a slot escape or unknown use ${use}`, () => refuse(source.replace('result = value;', use)));
  it('rejects escapes in the prior lifetime as well', () => refuse(source.replace('int value = src;', 'int value = 0; Remember(&value); value = src;')));
  it('refuses later outer uses and an else', () => {
    refuse(source.replace('return result;', 'return value;'));
    refuse(source.replace('} return result;', '} else { result = 4; } return result;'));
  });
  it('requires an actual guarded use', () => refuse(source.replace('result = value; value++; result += value;', 'result = src;')));
  it('refuses nested sites and binding shadowing', () => {
    refuse(source.replace('int value = src;', 'int value; { value = src;').replace('return result;', '} return result;'));
    refuse(source.replace('return result;', '{ int src = 9; } return result;'));
  });
  it('requires a dominating initialized source', () => {
    refuse(source.replace('int src, int flag', 'int flag').replace('int result = 7;', 'int src; int result = 7;'));
    refuse(source.replace('int src, int flag', 'int flag').replace('int result = 7;', 'int result = 7;').replace('if (flag)', 'int src = 1; if (flag)'));
  });
  it('refuses direct, list, or multiple declarators', () => {
    refuse(source.replace('int value = src;', 'int value(src);'));
    refuse(source.replace('int value = src;', 'int value = {src};'));
    refuse(source.replace('int value = src;', 'int value = src, another = 0;'));
  });
  for (const prefix of ['done: ;', 'if (flag) goto done; done: ;', 'void Local();', 'typedef int Local;', '__try { Work(); } __except(1) { Recover(); }']) it(`refuses alternate entries or opaque local syntax ${prefix}`, () => refuse(source.replace('int result = 7;', `${prefix} int result = 7;`)));
  it('refuses lambda capture syntax represented by the AST', () => {
    const tu = parse(source), fn = tu.declarations[0] as FunctionDecl;
    fn.body!.statements.unshift({ kind: K.ExprStmt, expression: { kind: K.LambdaExpr, captures: [], captureDefault: '&', parameters: [], returnType: null, body: { kind: K.CompoundStmt, statements: [] }, specifiers: [] } } as ExprStmt);
    const before = emit(tu), sites: Vc8FormSite[] = [];
    assert.equal(emit(applyVc8Forms(tu, [{ form: parseVc8Form('guardinit(value)')! }], s => sites.push(s))), before);
    assert.equal(sites[0].applied, false);
  });
  it('refuses an if initializer without mutation', () => {
    const tu = parse(source), fn = tu.declarations[0] as FunctionDecl;
    (fn.body!.statements[2] as IfStmt).init = (parse('void helper() { int value = 9; }').declarations[0] as FunctionDecl).body!.statements[0];
    const before = emit(tu), sites: Vc8FormSite[] = [];
    assert.equal(emit(applyVc8Forms(tu, [{ form: parseVc8Form('guardinit(value)')! }], s => sites.push(s))), before);
    assert.equal(sites[0].applied, false);
  });
  for (const spelling of ['guardinit()', 'guardinit(value,src)', 'guardinit(value,@1)', 'guardinit(1x)', 'guardinit(p->value)']) it(`rejects invalid spelling ${spelling}`, () => assert.equal(parseVc8Form(spelling), undefined));
});
