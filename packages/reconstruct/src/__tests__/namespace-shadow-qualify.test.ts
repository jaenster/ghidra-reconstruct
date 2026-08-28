/**
 * Ghidra spells a cross-module reference with the callee's own root namespace
 * (`Game::Launcher::LAUNCHER_...`), but the body is emitted inside a different
 * namespace block whose scope chain declares a nested namespace with the same
 * leading segment. C++ lookup binds the qualifier to that nested one and stops:
 *
 *   D2Client/CharSel.cpp: error: 'D2Client::Game::Launcher' has not been declared
 *
 * The shadowed reference has to be root-qualified — and ONLY the shadowed one:
 * a reference that resolves to the sibling scope the generator meant, and a
 * reference whose qualifier is not a project namespace at all, are left alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateImplementation, type ImplGenContext } from '../codegen/impl.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const options: ReconstructOptions = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

function func(body: string[]): ExtractedFunction {
  return {
    name: 'CHARSEL_Delete',
    address: '0x00401070',
    signature: 'void CHARSEL_Delete(void)',
    returnType: 'void',
    parameters: [],
    localVariables: [],
    callingConvention: '__fastcall',
    size: 64,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    namespace: 'D2Client::CharSel',
    decompiled: ['void CHARSEL_Delete(void)', '{', ...body, '  return;', '}'].join('\n'),
  };
}

const context = (): ImplGenContext => ({
  knownNamespaces: new Set([
    'Game',
    'Game::Launcher',
    'D2Client',
    'D2Client::CharSel',
    'D2Client::Game',
    'D2Client::Renderer',
  ]),
});

function emit(body: string[], ctx: ImplGenContext = context()): string {
  return generateImplementation(
    'D2Client/CharSel', [func(body)], undefined, 'D2Client/CharSel.h',
    options, ctx, undefined, new Set<string>(),
  );
}

describe('namespace-shadow-qualify', () => {
  it('root-qualifies a reference whose leading qualifier an enclosing scope shadows', () => {
    const impl = emit(['  Game::Launcher::LAUNCHER_DeleteCharacterFiles();']);
    assert.match(impl, /::Game::Launcher::LAUNCHER_DeleteCharacterFiles/);
    assert.ok(
      !/(?<![:\w])Game::Launcher::/.test(impl),
      `D2Client::Game has no Launcher — got:\n${impl}`,
    );
  });

  it('leaves a reference that resolves to the sibling scope alone', () => {
    const impl = emit(['  Renderer::RENDERER_Present();']);
    assert.ok(
      /(?<![:\w])Renderer::RENDERER_Present/.test(impl),
      `D2Client::Renderer resolves — got:\n${impl}`,
    );
  });

  it('leaves a qualifier that is not a project namespace alone', () => {
    const impl = emit(['  Fog::FOG_Alloc();']);
    assert.ok(
      /(?<![:\w])Fog::FOG_Alloc/.test(impl),
      `no shadow can be proved for an unknown qualifier — got:\n${impl}`,
    );
  });

  it('leaves the enclosing namespace\'s own path alone despite a doubled segment', () => {
    // Ghidra carries `D2Net::D2Net`; without the own-scope guard a reference
    // spelled `D2Net::Client::f` inside `namespace D2Net::Client` looks shadowed.
    const ctx: ImplGenContext = {
      knownNamespaces: new Set(['D2Net', 'D2Net::D2Net', 'D2Net::Client']),
    };
    const fn = func(['  D2Net::Client::CLIENT_Recv();']);
    fn.namespace = 'D2Net::Client';
    const impl = generateImplementation(
      'D2Net/Client', [fn], undefined, 'D2Net/Client.h', options, ctx, undefined, new Set<string>(),
    );
    assert.ok(
      !impl.includes('::D2Net::Client::CLIENT_Recv'),
      `the reference is inside D2Net::Client — got:\n${impl}`,
    );
  });

  it('does nothing without a namespace table', () => {
    const impl = emit(['  Game::Launcher::LAUNCHER_DeleteCharacterFiles();'], {});
    assert.ok(
      /(?<![:\w])Game::Launcher::LAUNCHER_DeleteCharacterFiles/.test(impl),
      `no table means no decision to make — got:\n${impl}`,
    );
  });
});
