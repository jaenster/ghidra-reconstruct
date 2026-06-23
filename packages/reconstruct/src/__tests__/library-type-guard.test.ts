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
