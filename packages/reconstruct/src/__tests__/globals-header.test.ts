/**
 * Tests for globals-header.ts — jump table artifact filtering
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { isSwitchTableSymbol, isJumpTableArtifact, generateGlobalsHeader } from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, ReconstructOptions } from '../types.js';

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
