import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';

function run(source: string, spelling: string, tables?: Vc8FormTables) {
  const sites: Vc8FormSite[] = [], before = emit(parse(source));
  const form = parseVc8Form(`dup(${spelling})`);
  assert.ok(form);
  const out = emit(applyVc8Forms(parse(source), [{ form }], s => sites.push(s), tables));
  return { before, out, sites };
}
function refuse(source: string, spelling = 'uint32_t value = Convert(t)', tables?: Vc8FormTables) {
  const r = run(source, spelling, tables);
  assert.equal(r.sites.length, 1);
  assert.equal(r.sites[0].applied, false, r.out);
  assert.equal(r.out, r.before);
}

describe('dup of an initialized 32-bit integer', () => {
  it('keeps one bare declaration outside the branches and assigns in both arms', () => {
    const r = run('uint32_t f(int ear, uint32_t t) { if (ear) { t = 0x20726165; } else { t = Read(); if (t == 3) t = 4; } uint32_t value = Convert(t); return value; }', 'uint32_t value = Convert(t)');
    assert.ok(r.sites[0].applied, r.sites[0].why);
    assert.match(r.out, /uint32_t value;\s+if \(ear\)/);
    assert.equal((r.out.match(/value = Convert\(t\)/g) ?? []).length, 2);
    assert.equal((r.out.match(/uint32_t value/g) ?? []).length, 1);
    assert.match(r.out, /return value/);
  });
  it('assigns every arm of a complete else-if chain', () => {
    const r = run('uint32_t f(int n, uint32_t t) { if (n == 0) t = 1; else if (n == 1) t = 2; else t = 3; uint32_t value = Convert(t); return value; }', 'uint32_t value = Convert(t)');
    assert.ok(r.sites[0].applied, r.sites[0].why);
    assert.equal((r.out.match(/value = Convert\(t\)/g) ?? []).length, 3);
  });
  it('retains the explicit scalar conversion performed by the initializer', () => {
    const r = run('int32_t f(int n, uint32_t t) { if (n) t = 0xffffffff; else t = 0x80000000; int32_t value = (int32_t)Convert(t); return value; }', 'int32_t value = (int32_t)Convert(t)');
    assert.ok(r.sites[0].applied, r.sites[0].why);
    assert.equal((r.out.match(/value = \(int32_t\)Convert\(t\)/g) ?? []).length, 2);
  });
  for (const type of ['const uint32_t', 'volatile uint32_t', 'uint16_t', 'uint64_t', 'bool', 'float', 'Value', 'Value*', 'Other::uint32_t']) {
    it(`refuses an unsupported ${type} declaration`, () => {
      refuse(`void f(int n, uint32_t t) { if (n) t = 1; else t = 2; ${type} value = Convert(t); Use(value); }`, `${type} value = Convert(t)`);
    });
  }
  it('does not treat a user typedef as a canonical integer spelling', () => {
    refuse('void f(int n, uint32_t t) { if (n) t = 1; else t = 2; User32 value = Convert(t); Use(value); }', 'User32 value = Convert(t)', { typedefTargets: { User32: 'unsigned int' } });
  });
  it('does not match only the first initializer of a multi-variable declaration', () => {
    refuse('void f(int n, uint32_t t) { if (n) t = 1; else t = 2; uint32_t value = Convert(t), other = Read(); Use(value); }');
  });
  it('refuses a bare declaration with no initializer', () => {
    refuse('void f(int n, uint32_t t) { if (n) t = 1; else t = 2; uint32_t value; Use(value); }', 'uint32_t value');
  });
  it('refuses list initialization', () => {
    refuse('void f(int n, uint32_t t) { if (n) t = 1; else t = 2; uint32_t value = {Convert(t)}; Use(value); }', 'uint32_t value = {Convert(t)}');
  });
  for (const specifier of ['static', 'extern']) it(`refuses ${specifier} storage`, () => {
    refuse(`void f(int n, uint32_t t) { if (n) t = 1; else t = 2; ${specifier} uint32_t value = Convert(t); Use(value); }`, `${specifier} uint32_t value = Convert(t)`);
  });
  it('refuses an incomplete conditional', () => {
    refuse('void f(int n, uint32_t t) { if (n) t = 1; uint32_t value = Convert(t); Use(value); }');
  });
  it('refuses a condition that would be captured by the earlier local declaration', () => {
    refuse('void f(uint32_t t) { if (value) t = 1; else t = 2; uint32_t value = Convert(t); Use(value); }');
  });
  it('refuses a hidden type-name capture as well as an expression identifier', () => {
    refuse('void f(uint32_t t) { if (sizeof(value) == 8) t = 1; else t = 2; uint32_t value = Convert(t); Use(value); }');
  });
  it('refuses an initializer that reads its own uninitialized local', () => {
    refuse('void f(int n, uint32_t t) { if (n) t = 1; else t = 2; uint32_t value = Convert(value); Use(value); }', 'uint32_t value = Convert(value)');
  });
  it('refuses a branch-local object whose destructor must precede the common call', () => {
    refuse('void f(int n, uint32_t t) { if (n) { Watch guard; t = 1; } else t = 2; uint32_t value = Convert(t); Use(value); }');
  });
  it('conservatively refuses even scalar declarations in an arm', () => {
    refuse('void f(int n, uint32_t t) { if (n) { int spare = 0; t = 1; } else t = 2; uint32_t value = Convert(t); Use(value); }');
  });
  it('refuses an exit in an arm', () => {
    refuse('void f(int n, uint32_t t) { if (n) return; else t = 2; uint32_t value = Convert(t); Use(value); }');
  });
  it('refuses labels and gotos even when outside the selected conditional', () => {
    refuse('void f(int n, uint32_t t) { start: if (n-- > 2) goto start; if (n) t = 1; else t = 2; uint32_t value = Convert(t); Use(value); }');
  });
  it('refuses a structured exception handler inside an arm', () => {
    refuse('void f(int n, uint32_t t) { if (n) { __try { Act(); } __except (1) { Recover(); } } else t = 2; uint32_t value = Convert(t); Use(value); }');
  });
});
