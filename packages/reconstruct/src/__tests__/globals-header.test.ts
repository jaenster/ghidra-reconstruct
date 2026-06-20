/**
 * Tests for globals-header.ts — jump table artifact filtering
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { isSwitchTableSymbol, isJumpTableArtifact, generateGlobalsHeader, generateExternDeclaration } from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, ReconstructOptions, ExtractedDataType } from '../types.js';

const defaultOptions: ReconstructOptions & { projectName?: string; binaryName?: string } = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

function makeSymbol(overrides: Partial<AnalyzedDataSymbol>): AnalyzedDataSymbol {
  return {
    name: 'testSymbol',
    address: '0x00700000',
    dataType: 'int',
    size: 4,
    isInitialized: false,
    xrefCount: 1,
    scope: 'global',
    ...overrides,
  };
}

describe('isSwitchTableSymbol', () => {
  it('should detect switchdataD_ prefixed names', () => {
    assert.ok(isSwitchTableSymbol('switchdataD_00401000'));
  });

  it('should detect PTR_caseD_ prefixed names', () => {
    assert.ok(isSwitchTableSymbol('PTR_caseD_3_00401000'));
  });

  it('should detect LAB_ prefixed names', () => {
    assert.ok(isSwitchTableSymbol('LAB_00401000'));
  });

  it('should not detect normal names', () => {
    assert.ok(!isSwitchTableSymbol('gaExcelFieldTypeDefaultWriters'));
  });
});

describe('isJumpTableArtifact', () => {
  it('should detect 4-byte int with single ref and small negative value', () => {
    const sym = makeSymbol({
      dataType: 'int',
      size: 4,
      value: '-42',
      referencingFunctions: ['SomeFunc'],
    });
    assert.ok(isJumpTableArtifact(sym));
  });

  it('should detect undefined4 jump table entries', () => {
    const sym = makeSymbol({
      dataType: 'undefined4',
      size: 4,
      value: '-100',
      referencingFunctions: ['SomeFunc'],
    });
    assert.ok(isJumpTableArtifact(sym));
  });

  it('should reject symbols with size != 4', () => {
    const sym = makeSymbol({
      dataType: 'int',
      size: 8,
      value: '-42',
      referencingFunctions: ['SomeFunc'],
    });
    assert.ok(!isJumpTableArtifact(sym));
  });

  it('should reject symbols referenced by multiple functions', () => {
    const sym = makeSymbol({
      dataType: 'int',
      size: 4,
      value: '-42',
      referencingFunctions: ['FuncA', 'FuncB'],
    });
    assert.ok(!isJumpTableArtifact(sym));
  });

  it('should reject symbols with no references', () => {
    const sym = makeSymbol({
      dataType: 'int',
      size: 4,
      value: '-42',
      referencingFunctions: [],
    });
    assert.ok(!isJumpTableArtifact(sym));
  });

  it('should reject symbols with positive values', () => {
    const sym = makeSymbol({
      dataType: 'int',
      size: 4,
      value: '42',
      referencingFunctions: ['SomeFunc'],
    });
    assert.ok(!isJumpTableArtifact(sym));
  });

  it('should reject symbols with non-int type', () => {
    const sym = makeSymbol({
      dataType: 'float',
      size: 4,
      value: '-42',
      referencingFunctions: ['SomeFunc'],
    });
    assert.ok(!isJumpTableArtifact(sym));
  });

  it('should reject symbols with very large negative value', () => {
    const sym = makeSymbol({
      dataType: 'int',
      size: 4,
      value: '-100000',
      referencingFunctions: ['SomeFunc'],
    });
    assert.ok(!isJumpTableArtifact(sym));
  });

  it('should not emit jump table artifacts in globals header', () => {
    const globals: AnalyzedDataSymbol[] = [
      makeSymbol({
        name: 'gaExcelFieldTypeDefaultWriters',
        suggestedName: 'gaExcelFieldTypeDefaultWriters',
        dataType: 'int',
        size: 4,
        value: '-42',
        scope: 'global',
        referencingFunctions: ['EXCEL_ProcessFile'],
      }),
      makeSymbol({
        name: 'gnRealGlobal',
        suggestedName: 'gnRealGlobal',
        dataType: 'int',
        size: 4,
        scope: 'global',
        referencingFunctions: ['FuncA', 'FuncB'],
      }),
    ];

    const header = generateGlobalsHeader(globals, defaultOptions);
    assert.ok(!header.includes('gaExcelFieldTypeDefaultWriters'), `Jump table artifact leaked into header: ${header}`);
    assert.ok(header.includes('gnRealGlobal'), `Real global missing from header: ${header}`);
  });
});

describe('Win32 library type forward declarations', () => {
  it('should NOT forward-declare a library type resolved via dataTypes category', () => {
    const globals: AnalyzedDataSymbol[] = [
      makeSymbol({
        name: 'gpWsaData',
        suggestedName: 'gpWsaData',
        dataType: 'LPWSADATA',
        suggestedType: 'LPWSADATA',
        size: 4,
        scope: 'global',
        referencingFunctions: ['NET_Init', 'NET_Shutdown'],
      }),
    ];
    const dataTypes: ExtractedDataType[] = [
      // category is a system-header path → isLibraryType() true
      { name: 'LPWSADATA', category: '/winsock.h', kind: 'TYPEDEF' } as unknown as ExtractedDataType,
    ];

    const header = generateGlobalsHeader(globals, defaultOptions, dataTypes);
    assert.ok(!/\bstruct\s+LPWSADATA;/.test(header), `Library typedef forward-declared: ${header}`);
    assert.ok(header.includes('gpWsaData'), `Global missing: ${header}`);
  });

  it('should NOT forward-declare a known Win32 typedef even without a dataTypes entry', () => {
    const globals: AnalyzedDataSymbol[] = [
      makeSymbol({
        name: 'gpRgb',
        suggestedName: 'gpRgb',
        dataType: 'RGBQUAD *',
        suggestedType: 'RGBQUAD *',
        size: 4,
        scope: 'global',
        referencingFunctions: ['GFX_Blit', 'GFX_Palette'],
      }),
      makeSymbol({
        name: 'gpNtHeaders',
        suggestedName: 'gpNtHeaders',
        dataType: 'IMAGE_NT_HEADERS32 *',
        suggestedType: 'IMAGE_NT_HEADERS32 *',
        size: 4,
        scope: 'global',
        referencingFunctions: ['PE_Parse', 'PE_Load'],
      }),
    ];

    // No dataTypes passed — relies on isKnownWin32Typedef fallback
    const header = generateGlobalsHeader(globals, defaultOptions);
    assert.ok(!/\bstruct\s+RGBQUAD;/.test(header), `RGBQUAD forward-declared: ${header}`);
    assert.ok(!/\bstruct\s+IMAGE_NT_HEADERS32;/.test(header), `IMAGE_* forward-declared: ${header}`);
  });

  it('should still forward-declare a normal D2 game type (not a library type)', () => {
    const globals: AnalyzedDataSymbol[] = [
      makeSymbol({
        name: 'gpUnit',
        suggestedName: 'gpUnit',
        dataType: 'D2UnitStrc *',
        suggestedType: 'D2UnitStrc *',
        size: 4,
        scope: 'global',
        referencingFunctions: ['UNIT_Init', 'UNIT_Free'],
      }),
    ];
    const header = generateGlobalsHeader(globals, defaultOptions);
    assert.ok(/\bstruct\s+D2UnitStrc;/.test(header), `D2 game type not forward-declared: ${header}`);
  });
});

describe('namespace-vs-global collision (IsRecording)', () => {
  it('should not emit a namespace named after a global variable', () => {
    const globals: AnalyzedDataSymbol[] = [
      // The BOOL global itself, living under the parent namespace.
      makeSymbol({
        name: 'IsRecording',
        suggestedName: 'IsRecording',
        dataType: 'BOOL',
        suggestedType: 'BOOL',
        size: 4,
        scope: 'global',
        namespace: 'D2Game::Game::Record',
        referencingFunctions: ['REC_Start', 'REC_Stop'],
      }),
      // A symbol whose Ghidra namespace appends the global's own name —
      // would otherwise emit `namespace IsRecording { ... }` and collide.
      makeSymbol({
        name: 'gFrameCounter',
        suggestedName: 'gFrameCounter',
        dataType: 'int',
        suggestedType: 'int',
        size: 4,
        scope: 'global',
        namespace: 'D2Game::Game::Record::IsRecording',
        referencingFunctions: ['REC_Tick'],
      }),
    ];

    const header = generateGlobalsHeader(globals, defaultOptions);
    assert.ok(!/namespace\s+IsRecording\b/.test(header), `Namespace collides with global: ${header}`);
    assert.ok(/extern\s+BOOL\s+IsRecording;/.test(header), `BOOL global declaration missing: ${header}`);
    assert.ok(header.includes('gFrameCounter'), `Inner symbol dropped: ${header}`);
  });
});

describe('array-suffix global names ("gFoo[91]")', () => {
  const g = (name: string, type: string): AnalyzedDataSymbol =>
    ({ name, dataType: type, suggestedName: name, suggestedType: type } as unknown as AnalyzedDataSymbol);

  it('emits a real array declaration instead of dropping it as invalid', () => {
    assert.strictEqual(
      generateExternDeclaration(g('gdwFogMemoryAllocFlags[91]', 'uint32_t')),
      'extern uint32_t gdwFogMemoryAllocFlags[91];'
    );
  });

  it('still skips genuinely invalid (RTTI/template) names', () => {
    assert.match(
      generateExternDeclaration(g('class_TSHashTable<struct_X>_RTTI', 'int')),
      /^\/\/ skipped:/
    );
  });

  it('leaves a plain global unchanged', () => {
    assert.strictEqual(generateExternDeclaration(g('gnSomething', 'int')), 'extern int gnSomething;');
  });
});

describe('function-pointer typedef globals collapse Ghidra double-indirection', () => {
  const g = (name: string, type: string): AnalyzedDataSymbol =>
    ({ name, dataType: type, suggestedName: name, suggestedType: type } as unknown as AnalyzedDataSymbol);

  it('emits a single-pointer array of funcdef typedefs (assignable from &Func)', () => {
    // Ghidra type is "D2SkillSrvStFunc *[91]" — array of function pointers. The
    // C++ typedef is pointer-style, so the name already carries one indirection;
    // the redundant "*" must be dropped or every "&Func" element mismatches.
    assert.strictEqual(
      generateExternDeclaration(g('SKILLSRVSTFUNCS', 'D2SkillSrvStFunc *[91]')),
      'extern D2SkillSrvStFunc SKILLSRVSTFUNCS[91];'
    );
  });

  it('collapses a scalar funcdef pointer global', () => {
    assert.strictEqual(
      generateExternDeclaration(g('pCurrentHandler', 'fpFlagOperations *')),
      'extern fpFlagOperations pCurrentHandler;'
    );
  });

  it('leaves a genuine pointer-to-struct array untouched', () => {
    assert.strictEqual(
      generateExternDeclaration(g('UNITS', 'D2UnitStrc *[91]')),
      'extern D2UnitStrc * UNITS[91];'
    );
  });
});

describe('CRT/EH-runtime metadata globals are excluded', () => {
  const sym = (name: string, type: string): AnalyzedDataSymbol =>
    ({ name, dataType: type, suggestedName: name, suggestedType: type, scope: 'global' } as unknown as AnalyzedDataSymbol);
  const opts = { outputDir: '/tmp', projectName: 'X' } as unknown as ReconstructOptions & { projectName?: string };

  it('drops a global whose type is an MSVC-EH internal (UnwindMapEntry) but keeps game globals', () => {
    const dts = [{ name: 'UnwindMapEntry', category: '/', kind: 'TYPEDEF', size: 8 }] as unknown as ExtractedDataType[];
    const header = generateGlobalsHeader(
      [sym('gEhTable', 'UnwindMapEntry'), sym('gRealGlobal', 'int')],
      opts, dts, new Map(),
    );
    assert.ok(!/UnwindMapEntry/.test(header), `EH metadata global leaked: ${header}`);
    assert.ok(/\bgRealGlobal\b/.test(header), `Game global wrongly dropped: ${header}`);
  });
});

describe('referenced-but-undeclared globals safety net', () => {
  it('emits an extern for a static-local symbol named in >1 function body', () => {
    const globals: AnalyzedDataSymbol[] = [
      makeSymbol({
        name: 'gdwUnitItemPropertyByIndex',
        suggestedName: 'gdwUnitItemPropertyByIndex',
        suggestedType: 'uint32_t',
        scope: 'static-local',
        ownerFunction: 'OwnerFn',
      }),
    ];
    const counts = new Map<string, number>([['gdwUnitItemPropertyByIndex', 3]]);
    const header = generateGlobalsHeader(globals, defaultOptions, undefined, undefined, undefined, counts);
    assert.ok(/Globals recovered from multi-function body references/.test(header),
      'recovered section header missing');
    assert.ok(/extern\s+uint32_t\s+gdwUnitItemPropertyByIndex;/.test(header),
      `recovered extern missing: ${header}`);
  });

  it('does NOT emit an extern for a static-local named in only 1 body', () => {
    const globals: AnalyzedDataSymbol[] = [
      makeSymbol({
        name: 'gdwSingleBodyLocal',
        suggestedName: 'gdwSingleBodyLocal',
        suggestedType: 'uint32_t',
        scope: 'static-local',
        ownerFunction: 'OwnerFn',
      }),
    ];
    const counts = new Map<string, number>([['gdwSingleBodyLocal', 1]]);
    const header = generateGlobalsHeader(globals, defaultOptions, undefined, undefined, undefined, counts);
    assert.ok(!/gdwSingleBodyLocal/.test(header),
      `single-body static-local should not be declared: ${header}`);
  });

  it('does NOT double-emit a symbol already emitted as a global extern', () => {
    const globals: AnalyzedDataSymbol[] = [
      makeSymbol({
        name: 'gAlreadyGlobal',
        suggestedName: 'gAlreadyGlobal',
        suggestedType: 'int',
        scope: 'global',
      }),
    ];
    const counts = new Map<string, number>([['gAlreadyGlobal', 5]]);
    const header = generateGlobalsHeader(globals, defaultOptions, undefined, undefined, undefined, counts);
    const occurrences = (header.match(/extern\s+int\s+gAlreadyGlobal;/g) || []).length;
    assert.equal(occurrences, 1, `expected single extern, got ${occurrences}: ${header}`);
    assert.ok(!/Globals recovered from multi-function body references/.test(header),
      'recovered section should be absent when nothing to recover');
  });
});
