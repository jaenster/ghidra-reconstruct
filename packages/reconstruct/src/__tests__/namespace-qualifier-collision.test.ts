/**
 * Regression tests for collision-aware redundant-qualifier stripping.
 *
 * Bug: inside `namespace D2Common::Unit::Monster`, a fully-qualified call to
 * `D2Common::Path::DynamicPath::GetYPos(...)` was shortened to
 * `Path::DynamicPath::GetYPos(...)`. But a sibling namespace
 * `D2Common::Unit::Path` exists, so C++ resolves the leading `Path` to
 * `D2Common::Unit::Path` (which has no `DynamicPath` child) → compile error:
 *   'D2Common::Unit::Path::DynamicPath' has not been declared
 *
 * Fix: only strip an enclosing prefix when the remaining leading segment can't
 * be intercepted by a sibling namespace reachable from a deeper enclosing scope.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateImplementation, type ImplGenContext } from '../codegen/impl.js';
import type {
  ExtractedFunction,
  ReconstructOptions,
} from '../types.js';

const nsOptions: ReconstructOptions = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

function makeFunc(opts: Partial<ExtractedFunction> & Pick<ExtractedFunction, 'name' | 'decompiled'>): ExtractedFunction {
  return {
    address: '0x00400000',
    signature: `void ${opts.name}()`,
    returnType: 'void',
    parameters: [],
    localVariables: [],
    callingConvention: '__cdecl',
    size: 64,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    ...opts,
  };
}

describe('collision-aware namespace qualifier stripping', () => {
  it('keeps the fully-qualified call when shortening would collide with a sibling namespace', () => {
    const caller = makeFunc({
      name: 'Foo',
      namespace: 'D2Common::Unit::Monster',
      decompiled:
        'void Foo() {\n  int y = D2Common::Path::DynamicPath::GetYPos(pPath);\n}',
    });

    const context: ImplGenContext = {
      knownNamespaces: new Set([
        'D2Common',
        'D2Common::Unit',
        'D2Common::Unit::Monster',
        'D2Common::Unit::Path', // sibling that would shadow a bare `Path::`
        'D2Common::Path',
        'D2Common::Path::DynamicPath',
      ]),
    };

    const impl = generateImplementation(
      'D2Common::Unit::Monster',
      [caller],
      undefined,
      'D2Common/Unit/Monster.h',
      nsOptions,
      context,
      undefined,
      new Set<string>(),
    );

    // The call must remain reachable from the caller scope. The bare-`Path::`
    // form is the bug; either the fully-qualified name or the global-scoped form
    // resolves correctly.
    assert.ok(
      !/(?<![:\w])Path::DynamicPath::GetYPos/.test(impl),
      `must not shorten to ambiguous Path::DynamicPath:: — got:\n${impl}`,
    );
    assert.ok(
      impl.includes('D2Common::Path::DynamicPath::GetYPos'),
      `expected fully-qualified call to survive — got:\n${impl}`,
    );
  });

  it('still strips the enclosing prefix when there is no colliding sibling', () => {
    const caller = makeFunc({
      name: 'Bar',
      namespace: 'D2Common::Unit::Monster',
      decompiled:
        'void Bar() {\n  int x = D2Common::Seed::GetSeed(pUnit);\n}',
    });

    const context: ImplGenContext = {
      knownNamespaces: new Set([
        'D2Common',
        'D2Common::Unit',
        'D2Common::Unit::Monster',
        'D2Common::Seed', // no D2Common::Unit::Seed sibling → safe to strip
      ]),
    };

    const impl = generateImplementation(
      'D2Common::Unit::Monster',
      [caller],
      undefined,
      'D2Common/Unit/Monster.h',
      nsOptions,
      context,
      undefined,
      new Set<string>(),
    );

    assert.ok(
      impl.includes('Seed::GetSeed'),
      `expected redundant D2Common:: prefix to be stripped — got:\n${impl}`,
    );
    assert.ok(
      !impl.includes('D2Common::Seed::GetSeed'),
      `D2Common:: prefix should have been stripped — got:\n${impl}`,
    );
  });
});
