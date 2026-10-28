/**
 * Fog allocations fold back to the D2_*_AT macros only where the call has a
 * literal file, a literal line and a trailing 0, and the macro keeps that file and
 * line so the expansion is the original call. D2_NEW_AT is a
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
    assert.ok(output.includes('p = D2_ALLOC_AT(n + 4, ".\\\\BnSend.cpp", 0x3bb);'), output);
    assert.ok(output.includes('D2_FREE_AT(p, ".\\\\BnSend.cpp", 0x3c0);'), output);
    assert.ok(output.includes('p = D2_REALLOC_AT(p, n, ".\\\\BnSend.cpp", 0x3c1);'), output);
    assert.ok(output.includes('p = D2_ALLOC_POOL_AT(pPool, n, ".\\\\SUnit.cpp", 0x10);'), output);
    assert.ok(output.includes('D2_FREE_POOL_AT(pPool, p, ".\\\\SUnit.cpp", 0x11);'), output);
    assert.ok(output.includes('p = D2_REALLOC_POOL_AT(pPool, p, n, ".\\\\SUnit.cpp", 0x12);'), output);
    assert.ok(preamble.includes(
      '#define D2_ALLOC_AT(size, szFile, nLine) Fog::Memory::AllocClientMemory((size), (szFile), (nLine), 0)'), preamble);
    assert.ok(preamble.includes(
      '#define D2_REALLOC_POOL_AT(pPool, p, size, szFile, nLine) Fog::Memory::ReAllocServerMemory((pPool), (p), (size), (szFile), (nLine), 0)'), preamble);
    assert.ok(preamble.includes('#ifndef D2_FREE_POOL_AT'), preamble);
    assert.ok(!preamble.includes('__FILE__') && !preamble.includes('__LINE__'), preamble);
    assert.deepStrictEqual(getAllocMacroStats().folded, {
      D2_ALLOC_AT: 1, D2_FREE_AT: 1, D2_REALLOC_AT: 1,
      D2_ALLOC_POOL_AT: 1, D2_FREE_POOL_AT: 1, D2_REALLOC_POOL_AT: 1,
    });
  });

  it('keeps the original file string and line constant, in the original order', () => {
    const { output } = run(
      `p = Fog::Memory::AllocServerMemory(pPool, 0x20, ".\\\\SOURCE\\\\SCOMP.CPP", 0x4c4, 0);`);
    assert.ok(output.includes('D2_ALLOC_POOL_AT(pPool, 0x20, ".\\\\SOURCE\\\\SCOMP.CPP", 0x4c4)'), output);
  });

  it('names the callee the way the call site spelled it', () => {
    const { preamble } = run(`p = Memory::AllocClientMemory(n, ".\\\\Excel.cpp", 0x20, 0);`);
    assert.ok(preamble.includes('#define D2_ALLOC_AT(size, szFile, nLine) Memory::AllocClientMemory('), preamble);
    assert.ok(!preamble.includes('Fog::Memory'), preamble);
  });

  it('makes D2_NEW_AT only for a struct whose Ghidra size is the literal size, with the size asserted', () => {
    const { output, preamble } = run(`
      BnMessQueue* q = (::BnMessQueue*)Fog::Memory::AllocClientMemory(300, ".\\\\BnMessQueue.cpp", 0x37, 0);
      D2UnitStrc* u = (D2UnitStrc*)Fog::Memory::AllocServerMemory(pPool, 0xf4, ".\\\\Units.cpp", 0x99, 0);`);
    assert.ok(output.includes('q = D2_NEW_AT(::BnMessQueue, ".\\\\BnMessQueue.cpp", 0x37);'), output);
    assert.ok(output.includes('u = D2_NEW_POOL_AT(pPool, D2UnitStrc, ".\\\\Units.cpp", 0x99);'), output);
    assert.ok(preamble.includes(
      '#define D2_NEW_AT(T, szFile, nLine) ((T*)D2_ALLOC_AT(sizeof(T), (szFile), (nLine)))'), preamble);
    assert.ok(preamble.includes(
      '#define D2_NEW_POOL_AT(pPool, T, szFile, nLine) ((T*)D2_ALLOC_POOL_AT((pPool), sizeof(T), (szFile), (nLine)))'), preamble);
    // D2_NEW_AT expands to D2_ALLOC_AT, so that macro must be defined too.
    assert.ok(preamble.includes('#define D2_ALLOC_AT(size, szFile, nLine)'), preamble);
    assert.ok(preamble.includes('#define D2_ALLOC_POOL_AT(pPool, size, szFile, nLine)'), preamble);
    assert.ok(preamble.includes(
      'static_assert(sizeof(void*) != 4 || sizeof(::BnMessQueue) == 0x12c,'), preamble);
    assert.ok(preamble.includes(
      'static_assert(sizeof(void*) != 4 || sizeof(::D2UnitStrc) == 0xf4,'), preamble);
    assert.deepStrictEqual(getAllocMacroStats().folded, {
      D2_ALLOC_AT: 0, D2_NEW_AT: 1, D2_ALLOC_POOL_AT: 0, D2_NEW_POOL_AT: 1,
    });
  });

  it('sees through a typedef of the struct', () => {
    const { output, preamble } = run(
      `p = (BnMessQueue_t*)Fog::Memory::AllocClientMemory(0x12c, ".\\\\X.cpp", 1, 0);`);
    assert.ok(output.includes('p = D2_NEW_AT(BnMessQueue_t, ".\\\\X.cpp", 1);'), output);
    assert.ok(preamble.includes('sizeof(::BnMessQueue_t) == 0x12c'), preamble);
  });

  it('keeps the cast and D2_ALLOC_AT when the size is not the struct size', () => {
    const { output, preamble } = run(`
      q = (BnMessQueue*)Fog::Memory::AllocClientMemory(0x200, ".\\\\X.cpp", 1, 0);
      r = (uint32_t*)Fog::Memory::AllocClientMemory(0x10, ".\\\\X.cpp", 2, 0);
      s = (D2Union*)Fog::Memory::AllocClientMemory(8, ".\\\\X.cpp", 3, 0);
      t = (BnMessQueue*)Fog::Memory::AllocClientMemory(n, ".\\\\X.cpp", 4, 0);`);
    assert.ok(output.includes('q = (BnMessQueue*)D2_ALLOC_AT(0x200, ".\\\\X.cpp", 1);'), output);
    assert.ok(output.includes('r = (uint32_t*)D2_ALLOC_AT(0x10, ".\\\\X.cpp", 2);'), output);
    assert.ok(output.includes('s = (D2Union*)D2_ALLOC_AT(8, ".\\\\X.cpp", 3);'), 'a union is not a struct: ' + output);
    assert.ok(output.includes('t = (BnMessQueue*)D2_ALLOC_AT(n, ".\\\\X.cpp", 4);'), output);
    assert.ok(!output.includes('D2_NEW'), output);
    assert.ok(!preamble.includes('static_assert'), preamble);
    assert.strictEqual(getAllocMacroStats().newSizeMismatch, 2);
  });

  it('keeps a nullptr pool explicit', () => {
    const { output } = run(`p = Fog::Memory::AllocServerMemory(nullptr, 0xf4, ".\\\\X.cpp", 1, 0);`);
    assert.ok(output.includes('p = D2_ALLOC_POOL_AT(nullptr, 0xf4, ".\\\\X.cpp", 1);'), output);
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
    assert.ok(output.includes('D2_FREE_AT(p, (char*)".\\\\X.cpp", 1);'), output);
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
