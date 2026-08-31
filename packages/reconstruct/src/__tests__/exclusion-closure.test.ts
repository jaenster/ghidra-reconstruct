/**
 * Exclusion closure
 *
 * Ghidra's `compiler` / `CRT` / `_Wrappers` namespaces are dropped because they
 * hold statically-linked MSVC library code. Kept game code calls into them
 * anyway, and until now the answer was a declaration — which leaves the symbol
 * undefined at link even where the binary holds 373 bytes of body for it
 * (`compiler::PKWARE_explode` @`006b01b0`).
 *
 * These lock the two halves of the rule apart, because they answer different
 * questions and get confused with each other: REACHABILITY says kept code names
 * it, EMISSION says a body is the right answer rather than the C library's.
 *
 * Every address and size below is Ghidra's own for `/windows/lod/1.14d/Game.exe`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  emittedSpelling,
  hasRealBody,
  collectReferencedNames,
  indexCandidatesBySpelling,
  nextClosureFrontier,
  mayReferenceNamespaces,
  selectExclusionEmissions,
  setPlatformDefinedNames,
  setPlatformRootDeclaredNames,
  emitsAtRootScope,
  candidateSpellings,
  type ExclusionCandidate,
} from '../codegen/exclusion-closure.js';
import { platformDefinedFunctionNames, platformDeclaredFunctionNames } from '../codegen/platform-types.js';

function candidate(over: Partial<ExclusionCandidate> & { name: string; address: string }): ExclusionCandidate {
  return {
    namespace: 'compiler',
    size: 64,
    isThunk: false,
    isExternal: false,
    ...over,
  };
}

describe('emittedSpelling', () => {
  it('rewrites a Ghidra name the way Ghidra\'s own C emitter does', () => {
    // The FunctionID collision label carries a colon; the decompiler prints `_`.
    assert.equal(
      emittedSpelling('FID_conflict:___CxxFrameHandler3'),
      'FID_conflict____CxxFrameHandler3',
    );
    // The MSVC EH iterators carry a backtick and an apostrophe.
    assert.equal(
      emittedSpelling("`eh_vector_constructor_iterator'"),
      '_eh_vector_constructor_iterator_',
    );
    assert.equal(emittedSpelling('PKWARE_explode'), 'PKWARE_explode');
  });
});

describe('hasRealBody', () => {
  it('accepts a function with bytes in the binary', () => {
    assert.ok(hasRealBody(candidate({ name: 'PKWARE_explode', address: '006b01b0', size: 373 })));
  });

  it('refuses a thunk, whose decompilation is the TARGET\'s body under its name', () => {
    assert.equal(
      hasRealBody(candidate({ name: '___cxa_rethrow', address: '0030b0a8', isThunk: true })),
      false,
    );
  });

  it('refuses an external and a zero-length record', () => {
    assert.equal(hasRealBody(candidate({ name: 'X', address: '1', isExternal: true })), false);
    assert.equal(hasRealBody(candidate({ name: 'X', address: '2', size: 0 })), false);
  });
});

describe('collectReferencedNames', () => {
  it('reads a qualified call, keeping both spellings', () => {
    const names = collectReferencedNames(
      'void f(void) { compiler::PKWARE_explode(a, b, c, d); }',
    );
    assert.ok(names.has('compiler::PKWARE_explode'));
    assert.ok(names.has('PKWARE_explode'));
  });

  it('does not see a name inside a string literal or a comment', () => {
    const names = collectReferencedNames(
      'void f(void) { puts("compiler::PKWARE_explode"); /* compiler::PKWARE_implode */ }',
    );
    assert.equal(names.has('compiler::PKWARE_explode'), false);
    assert.equal(names.has('compiler::PKWARE_implode'), false);
    assert.ok(names.has('puts'));
  });

  it('walks a multi-segment path to its last segment', () => {
    const names = collectReferencedNames('void f(void) { A::B::C(); }');
    assert.ok(names.has('A::B::C'));
    assert.ok(names.has('C'));
    assert.equal(names.has('A::B'), false);
  });

  it('returns nothing rather than guessing when the body will not lex', () => {
    // An unterminated literal: there is no token stream to read references from.
    assert.equal(collectReferencedNames('void f(void) { "unterminated').size, 0);
  });
});

describe('indexCandidatesBySpelling', () => {
  const explode = candidate({ name: 'PKWARE_explode', address: '006b01b0', size: 373 });
  const conflict = candidate({ name: 'FID_conflict:___CxxFrameHandler3', address: '0068333c', size: 54 });
  const thunk = candidate({ name: 'Ordinal_1', address: '0030b0a8', isThunk: true });

  it('keys on the qualified spelling a referencing body would use', () => {
    const index = indexCandidatesBySpelling([explode, conflict]);
    assert.ok(index.has('compiler::PKWARE_explode'));
    assert.ok(index.has('compiler::FID_conflict____CxxFrameHandler3'));
  });

  it('never keys on the bare name, so a local of that name cannot drag a body in', () => {
    const index = indexCandidatesBySpelling([explode]);
    assert.equal(index.has('PKWARE_explode'), false);
  });

  it('leaves out anything with no real body', () => {
    assert.equal(indexCandidatesBySpelling([thunk]).size, 0);
  });

  it('collects the copies that share one name under one key', () => {
    const index = indexCandidatesBySpelling([
      conflict,
      candidate({ name: 'FID_conflict:___CxxFrameHandler3', address: '00683372', size: 54 }),
      candidate({ name: 'FID_conflict:___CxxFrameHandler3', address: '006833a8', size: 54 }),
    ]);
    assert.equal(index.get('compiler::FID_conflict____CxxFrameHandler3')?.length, 3);
  });
});

describe('nextClosureFrontier', () => {
  const explode = candidate({ name: 'PKWARE_explode', address: '006b01b0', size: 373 });
  const implode = candidate({ name: 'PKWARE_implode', address: '006b0870', size: 412 });
  const strLen = candidate({ name: 'CRT_StrLen', address: '006d5bd0', size: 15, namespace: '_Wrappers' });
  const index = indexCandidatesBySpelling([explode, implode, strLen]);

  it('returns exactly what the bodies name', () => {
    const frontier = nextClosureFrontier(
      ['void f(void) { compiler::PKWARE_explode(a, b, c, d); }'],
      index,
      new Set(),
    );
    assert.deepEqual(frontier.map(f => f.name), ['PKWARE_explode']);
  });

  it('is a step, not the whole set: it never returns what is already admitted', () => {
    const frontier = nextClosureFrontier(
      ['void f(void) { compiler::PKWARE_explode(a); compiler::PKWARE_implode(b); }'],
      index,
      new Set(['006b01b0']),
    );
    assert.deepEqual(frontier.map(f => f.name), ['PKWARE_implode']);
  });

  it('closes transitively when the frontier\'s own body is fed back in', () => {
    const first = nextClosureFrontier(
      ['void f(void) { compiler::PKWARE_explode(a); }'],
      index,
      new Set(),
    );
    const admitted = new Set(first.map(f => f.address));
    const second = nextClosureFrontier(
      ['byte PKWARE_explode(void) { return _Wrappers::CRT_StrLen(s); }'],
      index,
      admitted,
    );
    assert.deepEqual(second.map(f => f.name), ['CRT_StrLen']);
  });

  it('reports each candidate once however many bodies name it', () => {
    const bodies = [
      'void a(void) { compiler::PKWARE_explode(x); }',
      'void b(void) { compiler::PKWARE_explode(y); }',
    ];
    assert.equal(nextClosureFrontier(bodies, index, new Set()).length, 1);
  });
});

describe('mayReferenceNamespaces', () => {
  it('passes a body that names an excluded namespace and rejects one that cannot', () => {
    assert.ok(mayReferenceNamespaces('compiler::memset(p, 0, n);', ['compiler', '_Wrappers']));
    assert.equal(mayReferenceNamespaces('D2Common::Foo(x);', ['compiler', '_Wrappers']), false);
  });
});

describe('selectExclusionEmissions', () => {
  const body = 'void f(void) { return; }';

  it('emits a body for a name the platform layer only DECLARES', () => {
    setPlatformDefinedNames(platformDefinedFunctionNames());
    const selection = selectExclusionEmissions([
      // Both are `extern "C" …;` entries in EXCLUDED_SYMBOL_DECLS / the CRT stub
      // table — a prototype with nothing behind it, which is the whole gap.
      candidate({ name: '__strrev', address: '00687860', size: 53, decompiled: body }),
      candidate({ name: 'PKWARE_explode', address: '006b01b0', size: 373, decompiled: body }),
    ]);
    assert.deepEqual(selection.emit.map(f => f.name).sort(), ['PKWARE_explode', '__strrev']);
    assert.equal(selection.alreadyDefined.length, 0);
  });

  it('leaves a name the C library defines to the C library', () => {
    setPlatformDefinedNames(platformDefinedFunctionNames());
    const selection = selectExclusionEmissions([
      candidate({ name: 'memset', address: '00680000', size: 100, decompiled: body }),
      candidate({ name: '_sprintf', address: '00680100', size: 100, decompiled: body }),
    ]);
    assert.equal(selection.emit.length, 0);
    assert.deepEqual(selection.alreadyDefined.map(f => f.name).sort(), ['_sprintf', 'memset']);
  });

  it('leaves a name the platform header forwards inline to its forwarder', () => {
    setPlatformDefinedNames(platformDefinedFunctionNames());
    const selection = selectExclusionEmissions([
      candidate({ name: '__alldiv', address: '00680200', size: 100, decompiled: body }),
      // `__strnicmp` is an EXCLUDED_SYMBOL_DECLS entry whose text carries a body.
      candidate({ name: '__strnicmp', address: '00680300', size: 100, decompiled: body }),
    ]);
    assert.equal(selection.emit.length, 0);
    assert.equal(selection.alreadyDefined.length, 2);
  });

  it('emits one body for the three copies that print as one identifier', () => {
    setPlatformDefinedNames(new Set());
    const copies = ['0068333c', '00683372', '006833a8'].map(address =>
      candidate({ name: 'FID_conflict:___CxxFrameHandler3', address, size: 54, decompiled: body }),
    );
    const selection = selectExclusionEmissions(copies);
    assert.equal(selection.emit.length, 1);
    // Lowest address wins, so the choice does not depend on extraction order.
    assert.equal(selection.emit[0].address, '0068333c');
    assert.equal(selection.duplicates.length, 2);
  });

  it('refuses a candidate with no body, however reachable it is', () => {
    setPlatformDefinedNames(new Set());
    const selection = selectExclusionEmissions([
      candidate({ name: 'NeverDecompiled', address: '00680400', size: 100 }),
      candidate({ name: 'IsAThunk', address: '00680500', isThunk: true, decompiled: body }),
    ]);
    assert.equal(selection.emit.length, 0);
  });
});

describe('candidateSpellings', () => {
  it('answers to both the bare and the qualified name', () => {
    assert.deepEqual(
      candidateSpellings(candidate({ name: 'CRT_StrLen', address: '006d5bd0', namespace: '_Wrappers' })),
      ['CRT_StrLen', '_Wrappers::CRT_StrLen'],
    );
  });
});

describe('emitsAtRootScope', () => {
  it('sends a body to the scope the platform header declares the name in', () => {
    setPlatformRootDeclaredNames(platformDeclaredFunctionNames());
    // `d2_platform.h` writes this one at root, as `extern "C"`.
    assert.ok(emitsAtRootScope(candidate({ name: 'FID_conflict:___CxxFrameHandler3', address: '0068333c' })));
    assert.ok(emitsAtRootScope(candidate({ name: '__strrev', address: '00687860' })));
    // Declared inside `namespace _Wrappers`, so the definition belongs there.
    assert.equal(
      emitsAtRootScope(candidate({ name: 'CRT_StrLen', address: '006d5bd0', namespace: '_Wrappers' })),
      false,
    );
    // The platform layer says nothing about it, so Ghidra's namespace stands.
    assert.equal(emitsAtRootScope(candidate({ name: 'PKWARE_explode', address: '006b01b0' })), false);
  });
});
