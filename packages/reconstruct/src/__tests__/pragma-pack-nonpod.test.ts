/**
 * `__attribute__((packed))` on a struct does not pack a member GCC counts as
 * non-POD, and every struct the emitter gives conversion constructors is one.
 * D2SaveFileHeaderStrc (Ghidra: 335 bytes, alignment 1) holds D2SaveHotKeyStrc[16]
 * and four D2SaveHandSkillStrc; with the attribute GCC kept their 2-byte alignment
 * and the struct came out 336, so `pSaveFile + 1` read one byte into the quest
 * section. `#pragma pack(1)` is the spelling that reaches those members.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateStructDeclaration, setConstructorBearingStructs } from '../codegen/header.js';
import type { ExtractedStruct } from '../types.js';

const GPP = 'i686-w64-mingw32-g++';

const hotKey: ExtractedStruct = {
  name: 'D2SaveHotKeyStrc', kind: 'STRUCTURE', size: 4, alignment: 2, category: '/',
  fields: [
    { name: 'nSkillIdAndHand', dataType: 'short', offset: 0, size: 2 },
    { name: 'nItemIndex', dataType: 'short', offset: 2, size: 2 },
  ],
} as unknown as ExtractedStruct;

const header: ExtractedStruct = {
  name: 'D2SaveHeaderProbe', kind: 'STRUCTURE', size: 69, alignment: 1, category: '/', packed: true,
  fields: [
    { name: 'bFlag', dataType: 'byte', offset: 0, size: 1 },
    { name: 'pHotKeys', dataType: 'D2SaveHotKeyStrc[16]', offset: 1, size: 64 },
    { name: 'pLeftHand', dataType: 'D2SaveHotKeyStrc', offset: 65, size: 4 },
  ],
} as unknown as ExtractedStruct;

const plain: ExtractedStruct = {
  name: 'D2PlainPackedProbe', kind: 'STRUCTURE', size: 5, alignment: 1, category: '/', packed: true,
  fields: [
    { name: 'bFlag', dataType: 'byte', offset: 0, size: 1 },
    { name: 'dwValue', dataType: 'uint32_t', offset: 1, size: 4 },
  ],
} as unknown as ExtractedStruct;

describe('packed struct holding a constructor-bearing struct by value', () => {
  setConstructorBearingStructs([hotKey, header, plain]);

  it('is emitted under #pragma pack(1), not the attribute', () => {
    const out = generateStructDeclaration(header);
    assert.match(out, /^#pragma pack\(push, 1\)\nstruct D2SaveHeaderProbe \{/);
    assert.match(out, /\};\n#pragma pack\(pop\)$/);
    assert.ok(!out.includes('__attribute__((packed))'), out);
  });

  it('leaves a POD-only packed struct on the attribute', () => {
    const out = generateStructDeclaration(plain);
    assert.match(out, /^struct __attribute__\(\(packed\)\) D2PlainPackedProbe \{/);
    assert.ok(!out.includes('#pragma'), out);
  });

  it('gives the size Ghidra declares under g++ -m32 layout rules', { skip: !hasGpp() }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'pragma-pack-'));
    const src = join(dir, 'probe.cpp');
    writeFileSync(src, [
      '#include <cstdint>', 'typedef unsigned char byte;',
      generateStructDeclaration(hotKey),
      generateStructDeclaration(header),
      'static_assert(sizeof(D2SaveHeaderProbe) == 69, "Ghidra size");',
      'static_assert(alignof(D2SaveHeaderProbe) == 1, "Ghidra alignment");',
    ].join('\n'));
    execFileSync(GPP, ['-std=c++17', '-fsyntax-only', src], { stdio: 'pipe' });
  });
});

function hasGpp(): boolean {
  try { execFileSync(GPP, ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
}
