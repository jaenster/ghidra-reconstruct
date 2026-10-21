/**
 * Tests for library-type detection and #ifndef _WIN32 guarding of
 * CRT / Win32 / MSVC-EH internal type definitions in generated headers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { isLibraryType } from '../codegen/platform-types.js';
import { generateHeader } from '../codegen/header.js';
import type {
  ExtractedDataType,
  ExtractedStruct,
  ReconstructOptions,
} from '../types.js';

const defaultOptions: ReconstructOptions = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'flat',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

// ── isLibraryType ────────────────────────────────────────────────────

describe('isLibraryType', () => {
  it('treats system-header categorized types as library types', () => {
    assert.strictEqual(isLibraryType('in_addr', '/inaddr.h'), true);
    assert.strictEqual(isLibraryType('hostent', '/winsock.h'), true);
  });

  it('treats MSVC-EH internals (root category) as library types', () => {
    assert.strictEqual(isLibraryType('FuncInfo', '/'), true);
  });

  it('does NOT treat game types as library types', () => {
    assert.strictEqual(isLibraryType('D2UnitStrc', '/'), false);
    assert.strictEqual(isLibraryType('D2RoomStrc', '/Diablo2/DRLG'), false);
  });
});

// ── #ifndef _WIN32 guarding in generateHeader ────────────────────────

describe('library type guarding in generateHeader', () => {
  function makeStruct(name: string, category: string): ExtractedStruct {
    return {
      name,
      category,
      size: 8,
      kind: 'STRUCTURE',
      fields: [
        { name: 'a', dataType: 'uint32_t', offset: 0, size: 4 },
        { name: 'b', dataType: 'uint32_t', offset: 4, size: 4 },
      ],
    };
  }

  it('guards library struct definitions but not game struct definitions', () => {
    const libStruct = makeStruct('in_addr', '/inaddr.h');
    const gameStruct = makeStruct('D2GameStrc', '/Diablo2');
    const dataTypes: ExtractedDataType[] = [libStruct, gameStruct];
    const ownedTypes = new Set(['in_addr', 'D2GameStrc']);

    const header = generateHeader(
      'TestUnit',
      [],
      undefined,
      dataTypes,
      [],
      defaultOptions,
      undefined,
      undefined,
      ownedTypes
    );

    // Both definitions present
    assert.ok(header.includes('struct in_addr {'), `Should define in_addr:\n${header}`);
    assert.ok(header.includes('struct D2GameStrc {'), `Should define D2GameStrc:\n${header}`);

    // Library struct sits inside an #ifndef _WIN32 ... #endif block; game struct does not.
    const guardStart = header.indexOf('#ifndef _WIN32  // provided by the Win32 SDK / CRT on Windows');
    assert.ok(guardStart >= 0, `Should emit the _WIN32 guard block:\n${header}`);
    const guardEnd = header.indexOf('#endif // _WIN32', guardStart);
    assert.ok(guardEnd > guardStart, `Guard block should close:\n${header}`);

    const libPos = header.indexOf('struct in_addr {');
    assert.ok(libPos > guardStart && libPos < guardEnd, `in_addr def must be inside the guard:\n${header}`);

    const gamePos = header.indexOf('struct D2GameStrc {');
    assert.ok(gamePos < guardStart, `D2GameStrc def must be OUTSIDE/before the guard:\n${header}`);
  });
});

// ── SDK types the platform header does not include (round 13) ─────────

describe('SDK types are the SDK\'s: never forward-declared or elaborated as structs', () => {
  const wfx: ExtractedStruct = {
    name: 'WAVEFORMATEX', category: '/mmsystem.h', size: 18, kind: 'STRUCTURE',
    fields: [
      { name: 'wFormatTag', dataType: 'WORD', offset: 0, size: 2 },
      { name: 'nChannels', dataType: 'WORD', offset: 2, size: 2 },
      { name: 'nSamplesPerSec', dataType: 'DWORD', offset: 4, size: 4 },
      { name: 'nAvgBytesPerSec', dataType: 'DWORD', offset: 8, size: 4 },
      { name: 'nBlockAlign', dataType: 'WORD', offset: 12, size: 2 },
      { name: 'wBitsPerSample', dataType: 'WORD', offset: 14, size: 2 },
      { name: 'cbSize', dataType: 'WORD', offset: 16, size: 2 },
    ],
  };
  const dsbd: ExtractedStruct = {
    name: 'DSBUFFERDESC', category: '/dsound.h', size: 20, kind: 'STRUCTURE',
    fields: [
      { name: 'dwSize', dataType: 'DWORD', offset: 0, size: 4 },
      { name: 'dwFlags', dataType: 'DWORD', offset: 4, size: 4 },
      { name: 'dwBufferBytes', dataType: 'DWORD', offset: 8, size: 4 },
      { name: 'dwReserved', dataType: 'DWORD', offset: 12, size: 4 },
      { name: 'lpwfxFormat', dataType: 'WAVEFORMATEX *', offset: 16, size: 4 },
    ],
  };

  it('a type filed under a header the platform does not include is ours, not a library type', () => {
    // <dsound.h> would redefine every C-shaped COM interface Ghidra models (IDirectSound, ...).
    assert.strictEqual(isLibraryType('DSBUFFERDESC', '/dsound.h'), false);
    assert.strictEqual(isLibraryType('WAVEFORMATEX', '/mmsystem.h'), true);
  });

  it('defines the 20-byte DSBUFFERDESC unguarded, names WAVEFORMATEX bare, and forward-declares it only without the SDK', () => {
    const header = generateHeader('Sound', [], undefined, [dsbd, wfx], [], defaultOptions,
      undefined, undefined, new Set(['DSBUFFERDESC', 'WAVEFORMATEX']));
    const lines = header.split('\n');
    const open = (i: number) => {
      let depth = 0;
      for (let k = 0; k < i; k++) {
        if (lines[k].startsWith('#ifndef _WIN32')) depth++;
        else if (lines[k].startsWith('#endif // _WIN32')) depth--;
      }
      return depth > 0;
    };
    const def = lines.findIndex(l => l.startsWith('struct DSBUFFERDESC {'));
    assert.ok(def >= 0 && !open(def), `DSBUFFERDESC is defined outside the SDK guard:\n${header}`);
    assert.ok(header.includes('WAVEFORMATEX * lpwfxFormat;') && !header.includes('struct WAVEFORMATEX * lpwfxFormat'),
      `the field names the SDK typedef without \`struct\`:\n${header}`);
    lines.forEach((l, i) => {
      if (/^struct WAVEFORMATEX\b/.test(l)) assert.ok(open(i), `line ${i + 1} declares WAVEFORMATEX outside the guard:\n${header}`);
    });
    const fwd = lines.findIndex(l => l === 'struct WAVEFORMATEX;');
    assert.ok(fwd >= 0 && fwd < def, `the no-SDK build still sees WAVEFORMATEX declared before its use:\n${header}`);
  });
});
