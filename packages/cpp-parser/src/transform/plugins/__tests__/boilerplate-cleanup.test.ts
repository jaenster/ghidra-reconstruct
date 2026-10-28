/**
 * The D2_ASSERT macro names a SYMBOL, so it must be spelled the way the call
 * site that produced it was spelled.
 *
 * The macro used to carry `Fog::ErrorManager::ERROR_UnrecoverableInternalError_Halt`
 * as a string literal. Macro text never reaches the namespace resolver, so when
 * the symbol moved to `Fog::Src::ErrorManager` the ordinary call sites followed
 * and the macro did not, costing 30 `'Fog::ErrorManager' has not been declared`
 * errors across the tree — one per expansion. These tests hold the macro to the
 * callee the collapsed boilerplate actually named.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, ASTNode, VariableDecl } from '../../../ast/nodes.js';
import { NodeKind } from '../../../ast/kinds.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { boilerplateCleanupPlugin } from '../builtins/boilerplate-cleanup.js';
import { InjectionCollector } from '../injection.js';

function assertionBoilerplate(halt: string, addressGetter: string): string {
  return `void f(int nIndex) {
    int nLine;
    int nAddress;
    if (nIndex == 0) {
      nLine = 0x27;
      nAddress = ${addressGetter}(0x27);
      ${halt}("", nAddress, nLine);
    }
  }`;
}

function runInjection(code: string): { output: string; preamble: string } {
  const ast = parse(code);
  const collector = new InjectionCollector();
  const transformer = boilerplateCleanupPlugin.createInjectionTransformer!();
  const result = transformer(ast as ASTNode, collector);
  return { output: emit(result as AnyNode).trim(), preamble: collector.generatePreamble() };
}

describe('boilerplateCleanupPlugin D2_ASSERT injection', () => {
  it('names the halt function exactly as the collapsed call site named it', () => {
    const { output, preamble } = runInjection(
      assertionBoilerplate(
        'Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt',
        'Fog::Src::ErrorManager::GetAddress'
      )
    );

    assert.ok(output.includes('D2_ASSERT('), `boilerplate should collapse: ${output}`);
    assert.ok(
      preamble.includes('Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt'),
      `macro must call the site's callee: ${preamble}`
    );
    assert.ok(
      !preamble.includes('Fog::ErrorManager::ERROR_'),
      `macro must not carry a hardcoded qualifier: ${preamble}`
    );
  });

  it('follows the symbol when its namespace differs, instead of a baked-in one', () => {
    // Same source, different resolved namespace. Nothing else changes; the macro
    // must move with it, which a string literal could never do.
    const { preamble } = runInjection(
      assertionBoilerplate(
        'Some::Other::Place::ERROR_UnrecoverableInternalError_Halt',
        'Some::Other::Place::GetAddress'
      )
    );

    assert.ok(
      preamble.includes('Some::Other::Place::ERROR_UnrecoverableInternalError_Halt'),
      `macro must follow the symbol: ${preamble}`
    );
    assert.ok(!preamble.includes('Fog::'), `no Fog spelling may survive: ${preamble}`);
  });

  it('injects nothing when no assertion boilerplate was collapsed', () => {
    const { output, preamble } = runInjection(`void f(int a) { if (a == 0) { a = 1; } }`);
    assert.ok(!output.includes('D2_ASSERT'), `nothing to collapse: ${output}`);
    assert.ok(!preamble.includes('#define D2_ASSERT'), `no macro without a callee: ${preamble}`);
  });

  it('leaves a second site alone when it halts through a different function', () => {
    // One D2_ASSERT can only name one function. Collapsing a site whose callee
    // differs would redirect it, so that site stays expanded.
    const code = `void f(int a, int b) {
      int nLine;
      int nAddress;
      if (a == 0) {
        nLine = 0x27;
        nAddress = Fog::Src::ErrorManager::GetAddress(0x27);
        Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt("", nAddress, nLine);
      }
      if (b == 0) {
        nLine = 0x28;
        nAddress = Other::GetAddress(0x28);
        Other::ERROR_SomethingElse("", nAddress, nLine);
      }
    }`;
    const { output, preamble } = runInjection(code);

    assert.ok(
      preamble.includes('Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt'),
      `macro takes the first callee: ${preamble}`
    );
    assert.ok(
      output.includes('Other::ERROR_SomethingElse'),
      `the mismatched site must survive verbatim: ${output}`
    );
  });
});

function runCleanup(code: string): string {
  const transformer = boilerplateCleanupPlugin.createTransformer();
  return emit(transformer(parse(code) as ASTNode) as AnyNode).trim();
}

describe('boilerplateCleanupPlugin GuardStack removal', () => {
  it('drops the /GS epilogue call from every return path', () => {
    const output = runCleanup(`int f(int a) {
      if (a) {
        Fog::Debug::GuardStack();
        return 1;
      }
      Fog::Debug::GuardStack();
      return 0;
    }`);
    assert.ok(!output.includes('GuardStack'), output);
    assert.ok(output.includes('return 1;') && output.includes('return 0;'), output);
    assert.ok(!/^\s*;\s*$/m.test(output), `no stray empty statement in a block: ${output}`);
  });

  it('keeps a label that named the call, as an empty statement', () => {
    const output = runCleanup(`void f(int a) {
      if (a) goto LAB_1;
      g();
    LAB_1:
      Fog::Debug::GuardStack();
    }`);
    assert.ok(!output.includes('GuardStack'), output);
    assert.ok(/LAB_1:\s*;/.test(output), output);
  });

  it('leaves an unbraced branch a statement to own', () => {
    const output = runCleanup(`void f(int a) {
      if (a) Fog::Debug::GuardStack();
      g();
    }`);
    assert.ok(!output.includes('GuardStack'), output);
    assert.ok(output.includes('g();'), output);
  });

  it('still drops the older one- and two-argument forms', () => {
    const output = runCleanup(`void f(int a) {
      Fog::Debug::GuardStack(a);
      Fog::Debug::GuardStack(a, 0);
    }`);
    assert.ok(!output.includes('GuardStack'), output);
  });

  it('keeps a call whose value is used', () => {
    const output = runCleanup(`int f(int a) {
      int r;
      r = Fog::Debug::GuardStack(a);
      return r;
    }`);
    assert.ok(output.includes('Fog::Debug::GuardStack(a)'), output);
  });

  it('keeps calls that are not Fog::Debug::GuardStack', () => {
    const output = runCleanup(`void f() {
      GuardStack();
      Other::GuardStack();
      Fog::Debug::GuardStackDepth();
    }`);
    assert.ok(output.includes('GuardStack();'), output);
    assert.ok(output.includes('Other::GuardStack();'), output);
    assert.ok(output.includes('Fog::Debug::GuardStackDepth();'), output);
  });
});

describe('boilerplateCleanupPlugin /GS cookie seed', () => {
  function cookieDecls(code: string): VariableDecl[] {
    const out = boilerplateCleanupPlugin.createTransformer()(parse(code) as ASTNode);
    return findNodesByKind(out, NodeKind.VariableDecl) as VariableDecl[];
  }

  it('drops the seed store and marks the slot it seeded', () => {
    const code = `int f(int a) {
      uint dwSecurityCookie;
      dwSecurityCookie = DEFAULT_SECURITY_COOKIE ^ (uint)&stack0xfffffffc;
      return g(a);
    }`;
    const output = runCleanup(code);
    assert.ok(!output.includes('DEFAULT_SECURITY_COOKIE'), output);
    const decl = cookieDecls(code).find(d => d.name.name === 'dwSecurityCookie');
    assert.strictEqual(decl?.ghidraInfo?.securityCookie, true);
  });

  it('drops a seed written as the initializer', () => {
    const code = `int f(int a) {
      uint32_t local_8 = DEFAULT_SECURITY_COOKIE ^ (uintptr_t)0;
      return g(a);
    }`;
    const output = runCleanup(code);
    assert.ok(!output.includes('DEFAULT_SECURITY_COOKIE'), output);
    const decl = cookieDecls(code).find(d => d.name.name === 'local_8');
    assert.strictEqual(decl?.initializer, null);
    assert.strictEqual(decl?.ghidraInfo?.securityCookie, true);
  });

  it('keeps a slot whose address is a buffer end, unmarked', () => {
    const code = `int f(char *p) {
      uint32_t nEnd;
      nEnd = DEFAULT_SECURITY_COOKIE ^ (uintptr_t)0;
      return g(p, (uintptr_t)&nEnd);
    }`;
    const output = runCleanup(code);
    assert.ok(!output.includes('DEFAULT_SECURITY_COOKIE'), output);
    assert.ok(output.includes('&nEnd'), output);
    const decl = cookieDecls(code).find(d => d.name.name === 'nEnd');
    assert.ok(decl && !decl.ghidraInfo?.securityCookie, 'an addressed slot is a local like any other');
  });

  it('keeps the store when the value is read, so the read stays initialised', () => {
    const output = runCleanup(`uint32_t f(int a) {
      uint32_t uVar1 = DEFAULT_SECURITY_COOKIE ^ (uintptr_t)0;
      if (a) uVar1 = 0;
      return uVar1 & -256;
    }`);
    assert.ok(output.includes('DEFAULT_SECURITY_COOKIE'), output);
  });

  it('leaves an XOR with the cookie that is not a seed', () => {
    const output = runCleanup(`uint32_t f(uint32_t a) {
      uint32_t x;
      x = DEFAULT_SECURITY_COOKIE ^ g(a);
      return 0;
    }`);
    assert.ok(output.includes('DEFAULT_SECURITY_COOKIE ^ g(a)'), output);
  });
});
