/**
 * Fog allocations fold back to the D2_* macros only where the call is exactly the
 * macro's expansion: a literal file, a literal line and a trailing 0. D2_NEW is a
 * layout claim, so it is made only where the literal size is Ghidra's size for the
 * struct the result is cast to, and the claim is written down as a static_assert.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, ASTNode } from '../../../ast/nodes.js';
import {
  allocMacrosPlugin, getAllocMacroStats, resetAllocMacroStats, type AllocMacrosOptions,
} from '../builtins/alloc-macros.js';
import { InjectionCollector } from '../injection.js';

const SIZES: AllocMacrosOptions = {
  aggregateSizes: { BnMessQueue: 0x12c, D2UnitStrc: 0xf4, D2Union: 8 },
  unionNames: ['D2Union'],
  typedefTargets: { BnMessQueue_t: 'BnMessQueue' },
};

function run(body: string, options: AllocMacrosOptions = SIZES): { output: string; preamble: string } {
  const ast = parse(`void f(D2PoolManagerStrc* pPool, void* p, int n, char* szFile, int nLine) {\n${body}\n}`);
  const collector = new InjectionCollector();
  const result = allocMacrosPlugin.createInjectionTransformer!(options)(ast as ASTNode, collector);
  return { output: emit(result as AnyNode), preamble: collector.generatePreamble() };
}

describe('alloc-macros', () => {
  beforeEach(() => resetAllocMacroStats());

  it('folds each allocator into its macro', () => {
    const { output, preamble } = run(`
      p = Fog::Memory::AllocClientMemory(n + 4, ".\\\\BnSend.cpp", 0x3bb, 0);
      Fog::Memory::FreeClientMemory(p, ".\\\\BnSend.cpp", 0x3c0, 0);
      p = Fog::Memory::ReAllocClientMemory(p, n, ".\\\\BnSend.cpp", 0x3c1, 0);
      p = Fog::Memory::AllocServerMemory(pPool, n, ".\\\\SUnit.cpp", 0x10, 0);
      Fog::Memory::FreeServerMemory(pPool, p, ".\\\\SUnit.cpp", 0x11, 0);
      p = Fog::Memory::ReAllocServerMemory(pPool, p, n, ".\\\\SUnit.cpp", 0x12, 0);`);
    assert.match(output, /p = D2_ALLOC\(n \+ 4\);/);
    assert.match(output, /D2_FREE\(p\);/);
    assert.match(output, /p = D2_REALLOC\(p, n\);/);
    assert.match(output, /p = D2_ALLOC_POOL\(pPool, n\);/);
    assert.match(output, /D2_FREE_POOL\(pPool, p\);/);
    assert.match(output, /p = D2_REALLOC_POOL\(pPool, p, n\);/);
    assert.ok(!output.includes('.cpp'), `no source-file literal may remain: ${output}`);
    assert.ok(preamble.includes(
      '#define D2_ALLOC(size) Fog::Memory::AllocClientMemory((size), __FILE__, __LINE__, 0)'), preamble);
    assert.ok(preamble.includes(
      '#define D2_REALLOC_POOL(pPool, p, size) Fog::Memory::ReAllocServerMemory((pPool), (p), (size), __FILE__, __LINE__, 0)'), preamble);
    assert.ok(preamble.includes('#ifndef D2_FREE_POOL'), preamble);
    assert.deepStrictEqual(getAllocMacroStats().folded, {
      D2_ALLOC: 1, D2_FREE: 1, D2_REALLOC: 1, D2_ALLOC_POOL: 1, D2_FREE_POOL: 1, D2_REALLOC_POOL: 1,
    });
  });

  it('names the callee the way the call site spelled it', () => {
    const { preamble } = run(`p = Memory::AllocClientMemory(n, ".\\\\Excel.cpp", 0x20, 0);`);
    assert.ok(preamble.includes('#define D2_ALLOC(size) Memory::AllocClientMemory('), preamble);
    assert.ok(!preamble.includes('Fog::Memory'), preamble);
  });

  it('makes D2_NEW only for a struct whose Ghidra size is the literal size, with the size asserted', () => {
    const { output, preamble } = run(`
      BnMessQueue* q = (::BnMessQueue*)Fog::Memory::AllocClientMemory(300, ".\\\\BnMessQueue.cpp", 0x37, 0);
      D2UnitStrc* u = (D2UnitStrc*)Fog::Memory::AllocServerMemory(pPool, 0xf4, ".\\\\Units.cpp", 0x99, 0);`);
    assert.match(output, /q = D2_NEW\(::BnMessQueue\);/);
    assert.match(output, /u = D2_NEW_POOL\(pPool, D2UnitStrc\);/);
    assert.ok(preamble.includes('#define D2_NEW(T) ((T*)D2_ALLOC(sizeof(T)))'), preamble);
    assert.ok(preamble.includes('#define D2_NEW_POOL(pPool, T) ((T*)D2_ALLOC_POOL((pPool), sizeof(T)))'), preamble);
    // D2_NEW expands to D2_ALLOC, so that macro must be defined too.
    assert.ok(preamble.includes('#define D2_ALLOC(size)'), preamble);
    assert.ok(preamble.includes('#define D2_ALLOC_POOL(pPool, size)'), preamble);
    assert.ok(preamble.includes(
      'static_assert(sizeof(void*) != 4 || sizeof(::BnMessQueue) == 0x12c,'), preamble);
    assert.ok(preamble.includes(
      'static_assert(sizeof(void*) != 4 || sizeof(::D2UnitStrc) == 0xf4,'), preamble);
    assert.deepStrictEqual(getAllocMacroStats().folded, {
      D2_ALLOC: 0, D2_NEW: 1, D2_ALLOC_POOL: 0, D2_NEW_POOL: 1,
    });
  });

  it('sees through a typedef of the struct', () => {
    const { output, preamble } = run(
      `p = (BnMessQueue_t*)Fog::Memory::AllocClientMemory(0x12c, ".\\\\X.cpp", 1, 0);`);
    assert.match(output, /p = D2_NEW\(BnMessQueue_t\);/);
    assert.ok(preamble.includes('sizeof(::BnMessQueue_t) == 0x12c'), preamble);
  });

  it('keeps the cast and D2_ALLOC when the size is not the struct size', () => {
    const { output, preamble } = run(`
      q = (BnMessQueue*)Fog::Memory::AllocClientMemory(0x200, ".\\\\X.cpp", 1, 0);
      r = (uint32_t*)Fog::Memory::AllocClientMemory(0x10, ".\\\\X.cpp", 2, 0);
      s = (D2Union*)Fog::Memory::AllocClientMemory(8, ".\\\\X.cpp", 3, 0);
      t = (BnMessQueue*)Fog::Memory::AllocClientMemory(n, ".\\\\X.cpp", 4, 0);`);
    assert.match(output, /q = \(BnMessQueue\*\)D2_ALLOC\(0x200\);/);
    assert.match(output, /r = \(uint32_t\*\)D2_ALLOC\(0x10\);/);
    assert.match(output, /s = \(D2Union\*\)D2_ALLOC\(8\);/, 'a union is not a struct');
    assert.match(output, /t = \(BnMessQueue\*\)D2_ALLOC\(n\);/);
    assert.ok(!output.includes('D2_NEW'), output);
    assert.ok(!preamble.includes('static_assert'), preamble);
    assert.strictEqual(getAllocMacroStats().newSizeMismatch, 2);
  });

  it('keeps a nullptr pool explicit', () => {
    const { output } = run(`p = Fog::Memory::AllocServerMemory(nullptr, 0xf4, ".\\\\X.cpp", 1, 0);`);
    assert.match(output, /p = D2_ALLOC_POOL\(nullptr, 0xf4\);/);
  });

  it('leaves a call alone unless file, line and flag are the literals the macro writes', () => {
    const { output, preamble } = run(`
      p = Fog::Memory::AllocClientMemory(n, szFile, 1, 0);
      p = Fog::Memory::AllocClientMemory(n, ".\\\\X.cpp", nLine, 0);
      p = Fog::Memory::AllocClientMemory(n, ".\\\\X.cpp", 1, 1);
      p = Fog::Memory::AllocClientMemory(n, ".\\\\X.cpp", 1);
      p = Other::AllocClientMemory(n, ".\\\\X.cpp", 1, 0);
      p = COMP_FreeServerMemory(pPool, p, ".\\\\X.cpp", 1, 0);`);
    assert.ok(!output.includes('D2_'), output);
    assert.strictEqual(preamble.trim(), '');
    const u = getAllocMacroStats().untouched;
    assert.strictEqual(u['file-not-literal'], 1);
    assert.strictEqual(u['line-not-literal'], 1);
    assert.strictEqual(u['trailing-not-zero'], 1);
    assert.strictEqual(u['arity'], 1);
  });

  it('accepts a cast on the file literal', () => {
    const { output } = run(`Fog::Memory::FreeClientMemory(p, (char *)".\\\\X.cpp", 1, 0);`);
    assert.match(output, /D2_FREE\(p\);/);
  });

  it('does nothing when switched off', () => {
    const { output, preamble } = run(
      `p = Fog::Memory::AllocClientMemory(n, ".\\\\X.cpp", 1, 0);`, { ...SIZES, allocationMacros: false });
    assert.ok(output.includes('Fog::Memory::AllocClientMemory'), output);
    assert.strictEqual(preamble.trim(), '');
  });

  it('runs after the type passes and before the namespace strip', () => {
    assert.ok(allocMacrosPlugin.priority > 700 && allocMacrosPlugin.priority < 900);
  });
});
