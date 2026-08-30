/**
 * Regression test: a dot in a Ghidra name is not proof that the symbol lives
 * inside another one.
 *
 * `isInteriorLabel` was a pure name-shape test, and both globals emitters drop
 * whatever it says yes to — `generateExternDeclaration` returns '' and
 * `emitGlobalDefsWithIfdef` skips the symbol. So four symbols with real records,
 * real types and real values got neither a declaration nor a definition:
 *
 *   s_.I_00708874   char[4] ".I"   — Ghidra's auto-label for string data, whose
 *   s_.E_00708880   char[4] ".E"     text happens to start with a dot
 *   MPQ_d2kfixup.mpq  D2MPQFileStrc *  — a hand-given name carrying a filename
 *   lpGLIDE3x.dll     HMODULE
 *
 * The declaration closure reads the model rather than what the emitters did, so
 * it declared all four anyway. `extern char s__E_00708880[4];` with no
 * definition in any of the 22 globals units is an undefined symbol at link, and
 * five Storm bodies reference it.
 *
 * Interiority is now decided from addresses, so the test is about the data:
 * a label is interior when a real symbol's extent contains it, or when its root
 * segment carries Ghidra's `_<address>` suffix naming a different address.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import {
  isInteriorLabel,
  setInteriorLabelSymbols,
  resetInteriorLabelSymbols,
  generateExternDeclaration,
} from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol } from '../types.js';

const sym = (
  name: string, address: string, dataType: string, size: number,
  extra: Partial<AnalyzedDataSymbol> = {},
): AnalyzedDataSymbol => ({
  name, address, dataType, suggestedType: dataType, size,
  isInitialized: true, xrefCount: 1, scope: 'global', ...extra,
} as AnalyzedDataSymbol);

/** A slice of the 1.14d model, chosen so every branch of the rule is exercised. */
const MODEL: AnalyzedDataSymbol[] = [
  // A real table, and a field label genuinely inside it.
  sym('gaHashSeedTable', '006cee80', 'D2HashSeedPairStrc[16]', 128),
  sym('gaHashSeedTable[5].nHashHigh', '006cee9c', 'D2HashSeedPairStrc[16]', 128),
  // An interior label whose PARENT has no record of its own: the root segment
  // carries the parent's address.
  sym('dylib_command_00001bb0.dylib.current_version', '00001bc4', 'dylib_command', 24),
  // An interior label reports its parent's size, so it must never itself be
  // treated as a container — this one claims 288 bytes and would otherwise
  // swallow MPQ_d2kfixup.mpq at 007d5620.
  sym('gaPaletteBlendEntries[52].peRed', '007d5528', 'PALETTEENTRY[72]', 288),
  // The four that lost their definitions.
  sym('s_.I_00708874', '00708874', 'char[4]', 4, { value: '.I' }),
  sym('s_.E_00708880', '00708880', 'char[4]', 4, { value: '.E' }),
  sym('MPQ_d2kfixup.mpq', '007d5620', 'D2MPQFileStrc *', 4),
  sym('lpGLIDE3x.dll', '0087efa8', 'HMODULE', 4),
];

describe('interior labels are decided from addresses, not from the dot', () => {
  beforeEach(() => setInteriorLabelSymbols(MODEL));
  afterEach(() => resetInteriorLabelSymbols());

  it('keeps a field label that a real symbol contains', () => {
    assert.equal(isInteriorLabel('gaHashSeedTable[5].nHashHigh'), true);
  });

  it('keeps a field label whose root names the datum it sits in', () => {
    assert.equal(isInteriorLabel('dylib_command_00001bb0.dylib.current_version'), true);
  });

  it('does not let an interior label act as a container for what follows it', () => {
    assert.equal(isInteriorLabel('MPQ_d2kfixup.mpq'), false);
  });

  it('frees Ghidra string labels whose text begins with a dot', () => {
    assert.equal(isInteriorLabel('s_.I_00708874'), false);
    assert.equal(isInteriorLabel('s_.E_00708880'), false);
  });

  it('frees a hand-given name that carries a filename', () => {
    assert.equal(isInteriorLabel('lpGLIDE3x.dll'), false);
  });

  it('keeps every +N offset label interior', () => {
    assert.equal(isInteriorLabel('DAT_0043e7e0+1'), true);
  });

  it('declares the freed symbols under the shared identifier sanitizer', () => {
    assert.equal(
      generateExternDeclaration(MODEL.find(g => g.name === 's_.E_00708880')!),
      'extern char s__E_00708880[4];');
    assert.equal(
      generateExternDeclaration(MODEL.find(g => g.name === 'MPQ_d2kfixup.mpq')!),
      'extern D2MPQFileStrc * MPQ_d2kfixup_mpq;');
    assert.equal(
      generateExternDeclaration(MODEL.find(g => g.name === 'gaHashSeedTable[5].nHashHigh')!),
      '');
  });
});

describe('without a registered model the shape test still answers', () => {
  beforeEach(() => resetInteriorLabelSymbols());

  it('falls back to the name shape', () => {
    assert.equal(isInteriorLabel('g_chunks.capacity'), true);
    assert.equal(isInteriorLabel('s_.E_00708880'), true);
    assert.equal(isInteriorLabel('gnPrimaryClickState'), false);
  });
});
