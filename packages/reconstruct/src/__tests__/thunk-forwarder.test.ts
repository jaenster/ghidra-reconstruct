/**
 * A Ghidra thunk is one JMP instruction. It has no body of its own — asking the
 * decompiler for one returns the TARGET's body under the thunk's name — so the
 * only honest definition is a forwarder to the function it jumps to.
 *
 * The dangerous failure is not a missing definition, it is a forwarder that
 * calls ITSELF. Ten thunks in 1.14d target a function whose leaf name is theirs
 * in another namespace, and the four import thunks target a Win32 function of
 * exactly their own name: an unqualified call inside `namespace Fog::System`
 * binds to the enclosing function and becomes infinite recursion that compiles
 * and links clean. Every test here exists to make that impossible.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateThunkForwarder, type ThunkForward, type ImplGenContext } from '../codegen/impl.js';
import { namespaceResolution } from '../codegen/namespace-resolution.js';
import { platformDeclaredFunctionNames } from '../codegen/platform-types.js';
import { generateProject } from '../codegen/index.js';
import { buildCallGraph } from '../analysis/callgraph.js';
import type {
  ExtractedFunction,
  ExtractedDataType,
  AnalyzedDataSymbol,
  DetectedClass,
  ExtractedNamespace,
  ProgramInfo,
  ReconstructOptions,
} from '../types.js';

function thunk(
  name: string,
  address: string,
  namespace: string,
  returnType: string,
  params: Array<{ name: string; dataType: string }> = [],
  target?: ExtractedFunction['thunkTarget']
): ExtractedFunction {
  return {
    name,
    address,
    signature: `${returnType} ${name}()`,
    returnType,
    parameters: params.map((p, i) => ({ ...p, size: 4, ordinal: i })),
    localVariables: [],
    namespace,
    callingConvention: '__cdecl',
    size: 5,
    isThunk: true,
    isExternal: false,
    hasVarArgs: false,
    thunkTarget: target,
  };
}

function body(
  name: string,
  address: string,
  namespace: string,
  returnType: string,
  params: Array<{ name: string; dataType: string }> = []
): ExtractedFunction {
  const list = params.map(p => `${p.dataType} ${p.name}`).join(', ') || 'void';
  return {
    name,
    address,
    signature: `${returnType} ${name}(${list})`,
    returnType,
    parameters: params.map((p, i) => ({ ...p, size: 4, ordinal: i })),
    localVariables: [],
    namespace,
    callingConvention: '__cdecl',
    size: 0x40,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    decompiled: `${returnType} ${name}(${list})\n{\n  return;\n}\n`,
    calledFunctions: [],
  };
}

function contextWith(address: string, forward: ThunkForward): ImplGenContext {
  return { thunkForwards: new Map([[address, forward]]) };
}

describe('thunk forwarder', () => {
  it('calls the target from the root, so a homonym cannot bind to itself', () => {
    // The 1.14d shape: D2Game::GAME::SCmd::NET_..._Incoming0x52 jumps to the
    // D2Client-side handler of the SAME leaf name.
    const f = thunk(
      'Incoming0x52', '0x0045cc00', 'D2Game::GAME::SCmd', 'void',
      [{ name: 'pBytes', dataType: 'char *' }],
      { address: '0x004a40d0', name: 'Incoming0x52', namespace: 'D2Client::UI::QuestLog', isExternal: false }
    );
    const ctx = contextWith(f.address, {
      qualified: '::D2Client::UI::QuestLog::Incoming0x52',
      returnType: 'void',
      parameterCount: 1,
    });
    const out = generateThunkForwarder(
      f, ctx, namespaceResolution().resolvePath('D2Game::GAME::SCmd')
    );
    assert.ok(out, 'a forwarder must be emitted');
    assert.match(out!, /::D2Client::UI::QuestLog::Incoming0x52\(pBytes\);/);
    // The call must never be spelled bare — inside the SCmd namespace that is
    // this very function.
    assert.doesNotMatch(out!, /(?<![:\w])Incoming0x52\(pBytes\)/);
  });

  it('forwards an import thunk to global scope', () => {
    const f = thunk(
      'GetCurrentThreadId', '0x00401690', 'Fog::System', 'DWORD', [],
      { address: 'EXTERNAL:0000003c', name: 'GetCurrentThreadId', namespace: 'KERNEL32.DLL', isExternal: true }
    );
    const ctx = contextWith(f.address, {
      qualified: '::GetCurrentThreadId',
      returnType: 'DWORD',
      parameterCount: 0,
    });
    const out = generateThunkForwarder(
      f, ctx, namespaceResolution().resolvePath('Fog::System')
    );
    assert.ok(out);
    assert.match(out!, /return ::GetCurrentThreadId\(\);/);
    // `return GetCurrentThreadId();` inside namespace Fog::System is the
    // infinite recursion this whole guard exists for.
    assert.doesNotMatch(out!, /return GetCurrentThreadId\(\)/);
  });

  it('refuses to define a thunk whose callee would be itself', () => {
    const f = thunk(
      'Release', '0x00509fd0', 'D2Glide::Renderer::Glide', 'BOOL', [],
      { address: '0x00509e10', name: 'Release', namespace: 'D2Glide::Renderer::Glide', isExternal: false }
    );
    const ctx = contextWith(f.address, {
      qualified: '::D2Glide::Renderer::Glide::Release',
      returnType: 'BOOL',
      parameterCount: 0,
    });
    const out = generateThunkForwarder(
      f, ctx, namespaceResolution().resolvePath('D2Glide::Renderer::Glide')
    );
    assert.strictEqual(out, undefined,
      'a self-naming forwarder must be left undefined, never emitted');
  });

  it('leaves a thunk undefined when nothing resolved its target', () => {
    const f = thunk('Orphan', '0x00500000', 'D2Game', 'void');
    assert.strictEqual(generateThunkForwarder(f, {}, undefined), undefined);
    assert.strictEqual(generateThunkForwarder(f, undefined, undefined), undefined);
  });

  it('refuses when the two sides disagree on the signature', () => {
    const f = thunk(
      'Handler', '0x00500100', 'D2Game', 'int',
      [{ name: 'pUnit', dataType: 'D2UnitStrc *' }],
      { address: '0x00500200', name: 'Other', namespace: 'D2Client', isExternal: false }
    );
    // Target returns void — forwarding would have to invent a return value.
    assert.strictEqual(
      generateThunkForwarder(f, contextWith(f.address, {
        qualified: '::D2Client::Other', returnType: 'void', parameterCount: 1,
      }), namespaceResolution().resolvePath('D2Game')),
      undefined
    );
    // Target takes a different number of arguments.
    assert.strictEqual(
      generateThunkForwarder(f, contextWith(f.address, {
        qualified: '::D2Client::Other', returnType: 'int', parameterCount: 2,
      }), namespaceResolution().resolvePath('D2Game')),
      undefined
    );
  });

  it('refuses a variadic thunk, which cannot pass its arguments on', () => {
    const f = thunk(
      'LogLine', '0x00500300', 'Fog', 'void', [{ name: 'szFmt', dataType: 'char *' }],
      { address: '0x00500400', name: 'RealLogLine', namespace: 'Fog::Src', isExternal: false }
    );
    f.hasVarArgs = true;
    assert.strictEqual(
      generateThunkForwarder(f, contextWith(f.address, {
        qualified: '::Fog::Src::RealLogLine', returnType: 'void', parameterCount: 1,
      }), namespaceResolution().resolvePath('Fog')),
      undefined
    );
  });
});

describe('thunk target wiring', () => {
  it('gives the platform header a declaration for every import a thunk forwards to', () => {
    const declared = platformDeclaredFunctionNames();
    for (const name of ['GetCurrentThreadId', 'GetTickCount', 'WSAGetLastError', 'WSACleanup']) {
      assert.ok(declared.has(name), `${name} must be declared by the platform header`);
    }
  });

  it('makes the target a call edge, so its header reaches the thunk"s unit', () => {
    const t = body('RealHandler', 'Game.exe.ram:00502000', 'D2Client::UI', 'void');
    const f = thunk('Handler', 'Game.exe.ram:00501000', 'D2Game', 'void', [],
      { address: '00502000', name: 'RealHandler', namespace: 'D2Client::UI', isExternal: false });
    const graph = buildCallGraph([f, t]);
    assert.ok(graph.edges.get(f.address)?.has(t.address),
      'a thunk must depend on its target even though it has no body to scan');
  });
});

const options: ReconstructOptions = {
  outputDir: './out',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'quick',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

const programInfo: ProgramInfo = {
  name: 'Thunk.exe',
  path: '/tmp/Thunk.exe',
  format: 'PE',
  architecture: 'x86',
  compiler: 'msvc',
  imageBase: '0x400000',
  languageId: 'x86:LE:32:default',
  endianness: 'little',
  pointerSize: 4,
};

describe('thunk forwarders through the whole emitter', () => {
  it('defines the thunk, root-qualified, and never recursively', () => {
    const target = body(
      'Incoming0x52', 'Game.exe.ram:004a40d0', 'D2Client::UI::QuestLog', 'void',
      [{ name: 'pBytes', dataType: 'char *' }]
    );
    const homonym = thunk(
      'Incoming0x52', 'Game.exe.ram:0045cc00', 'D2Game::GAME::SCmd', 'void',
      [{ name: 'pBytes', dataType: 'char *' }],
      { address: '004a40d0', name: 'Incoming0x52', namespace: 'D2Client::UI::QuestLog', isExternal: false }
    );
    const importThunk = thunk(
      'GetCurrentThreadId', 'Game.exe.ram:00401690', 'Fog::System', 'DWORD', [],
      { address: 'EXTERNAL:0000003c', name: 'GetCurrentThreadId', namespace: 'KERNEL32.DLL', isExternal: true }
    );
    // Nothing declares this import, so no forwarder may be written for it.
    const unknownImport = thunk(
      'NotAWin32Name', 'Game.exe.ram:00401700', 'Fog::System', 'int', [],
      { address: 'EXTERNAL:00000099', name: 'NotAWin32Name', namespace: 'MYSTERY.DLL', isExternal: true }
    );

    const functions: ExtractedFunction[] = [target, homonym, importThunk, unknownImport];
    const dataTypes: ExtractedDataType[] = [];
    const classes: DetectedClass[] = [];
    // A data symbol sitting ON the target's entry point. Ghidra has these
    // (`nlist_0061b2d0` on `DRLGROOMEX_ActivateRoomEx`), and it claims the
    // address after the function does — so an address-keyed namespace lookup
    // answers root scope and the forwarder loses its qualifier.
    const globals: AnalyzedDataSymbol[] = [
      {
        name: 'nlist_004a40d0',
        address: 'Game.exe.ram:004a40d0',
        dataType: 'undefined4',
        size: 4,
        isInitialized: false,
        xrefCount: 1,
        scope: 'global',
      },
    ];
    const namespaces: ExtractedNamespace[] = [
      { name: 'D2Client::UI::QuestLog', fullPath: 'D2Client::UI::QuestLog', functionCount: 1, isClass: false },
      { name: 'D2Game::GAME::SCmd', fullPath: 'D2Game::GAME::SCmd', functionCount: 1, isClass: false },
      { name: 'Fog::System', fullPath: 'Fog::System', functionCount: 2, isClass: false },
    ];

    const project = generateProject(
      'thunks', functions, classes, dataTypes, globals, namespaces, options, programInfo
    );

    const impls = [...project.files.values()].filter(f => f.type === 'implementation');
    const all = impls.map(f => f.content).join('\n');

    assert.match(all, /::D2Client::UI::QuestLog::Incoming0x52\(pBytes\);/,
      'the homonym thunk must forward to the root-qualified target');
    assert.match(all, /return ::GetCurrentThreadId\(\);/,
      'the import thunk must forward to global scope');
    assert.doesNotMatch(all, /NotAWin32Name\s*\(\s*\)\s*;/,
      'an import with no declaration must be left undefined, not called');

    // The standing check: in every emitted definition, the call it makes must
    // not be to the function being defined.
    const definition = /^([A-Za-z_][\w :*&]*?)\b(\w+)\((.*?)\)\s*\{\n([\s\S]*?)^\}/gm;
    for (const file of impls) {
      let m: RegExpExecArray | null;
      while ((m = definition.exec(file.content)) !== null) {
        const name = m[2];
        const inner = m[4];
        assert.doesNotMatch(
          inner,
          new RegExp(`(?<![:\\w])${name}\\s*\\(`),
          `${name} in ${file.path} calls itself unqualified`
        );
      }
    }
  });
});
