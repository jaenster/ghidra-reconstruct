/**
 * `DAT_00000014` and friends are labels Ghidra makes at null-page addresses a body
 * dereferences (an inlined accessor returning NULL, then a field read). Bodies lower them
 * to volatile accesses at the address and the definitions drop them; the declarations
 * and the data initializers have to agree.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { emitDataValue, generateGlobalsHeader, generateGlobalsImpl } from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, ReconstructOptions } from '../types.js';

const options = {
  outputDir: '/tmp/test', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

const placeholder = (name: string, address: string): AnalyzedDataSymbol => ({
  name, address, dataType: 'undefined', size: 1, isInitialized: false, xrefCount: 1,
  referencingFunctions: ['D2Game::Monster::AI::AITHINK_Fn1_SpecialMounting'], scope: 'global', suggestedType: 'uint8_t',
});

describe('null-page placeholders', () => {
  it('are neither declared nor defined', () => {
    const gs = [placeholder('DAT_00000014', '00000014'), placeholder('DAT_0000003c', '0000003c'),
      { ...placeholder('gnReal', '00700000'), suggestedType: 'int' }];
    const text = generateGlobalsHeader(gs, options) + generateGlobalsImpl(gs, options);
    assert.doesNotMatch(text, /DAT_000000/);
    assert.match(text, /gnReal/);
  });
  it('as a pointer initializer, are the address they name (ChatDlg button table: .pfnDraw = 4)', () => {
    const out = emitDataValue({ kind: 'pointer', value: 'DAT_00000004' }, 0, 'void*');
    assert.doesNotMatch(out, /DAT_/);
    assert.match(out, /0x0*4\b/);
  });
});
