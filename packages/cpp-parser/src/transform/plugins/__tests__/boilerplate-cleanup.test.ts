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
import type { AnyNode, ASTNode } from '../../../ast/nodes.js';
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
