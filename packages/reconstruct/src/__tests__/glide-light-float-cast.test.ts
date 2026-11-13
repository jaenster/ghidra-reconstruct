/**
 * RENDERER_GLIDE_DrawWallTilePerspective (0x0050cf70). The decompiler gives the
 * stack slot at EBP-0x30 one type, D2GfxLightStrc, while the machine uses it as
 * a subtile index in one live range and as a float in the next:
 *
 *     fSubtileIndex = (D2GfxLightStrc)(float)nScreenXOffset;   // FILD; FSTP float ptr [EBP-0x30]
 *     pfColorVertex->fX = (float)fSubtileIndex + pfColorVertex->fX;   // FLD float ptr [EBP-0x30]
 *
 * D2GfxLightStrc is emitted with a converting constructor from `uint32_t`, which
 * a float reaches implicitly, so the cast compiled and stored the TRUNCATED
 * VALUE; the read-back then took those integer bits as a float, a denormal near
 * zero, and the wall strip lost its screen X offset. The store is the four
 * bytes of the float. The fixture is the decompile's lines for that slot, with
 * a `double` product added to pin the narrowing to the four-byte store.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformGhidraCode } from '@ghidra-mcp/cpp-parser';
import { generatePlatformHeader } from '../codegen/platform-types.js';
import { generateStructDeclaration, hasConvertingConstructor, setConstructorBearingStructs } from '../codegen/header.js';
import type { ExtractedStruct } from '../types.js';

const light = {
  name: 'D2GfxLightStrc', kind: 'STRUCTURE', size: 4, alignment: 1, category: '/_Source/Glide',
  fields: [
    { name: 'nIntensity', dataType: 'uint8_t', offset: 0, size: 1 },
    { name: 'nRed', dataType: 'uint8_t', offset: 1, size: 1 },
    { name: 'nGreen', dataType: 'uint8_t', offset: 2, size: 1 },
    { name: 'nBlue', dataType: 'uint8_t', offset: 3, size: 1 },
  ],
} as unknown as ExtractedStruct;

const vertex = {
  name: 'D2GlideVertexStrc', kind: 'STRUCTURE', size: 8, alignment: 4, category: '/_Source/Glide',
  fields: [
    { name: 'fX', dataType: 'float', offset: 0, size: 4 },
    { name: 'fY', dataType: 'float', offset: 4, size: 4 },
  ],
} as unknown as ExtractedStruct;

const GPP = 'i686-w64-mingw32-g++';
const STRICT = ['-std=c++17', '-c', '-w', '-fms-extensions', '-fwrapv'];

const has = (cc: string): boolean => {
  try { execFileSync(cc, ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
};

/** A host C++ compiler that can also LINK and run here; `zig c++` first, as it carries its own libc. */
const HOST: string[] | undefined = [['zig', 'c++'], ['c++'], ['clang++'], ['g++']].find(([cc, ...pre]) => {
  const dir = mkdtempSync(join(tmpdir(), 'host-cc-'));
  try {
    writeFileSync(join(dir, 'p.cpp'), 'int main() { return 0; }\n');
    execFileSync(cc, [...pre, '-o', join(dir, 'p'), join(dir, 'p.cpp')], { stdio: 'pipe' });
    execFileSync(join(dir, 'p'), { stdio: 'pipe' });
    return true;
  } catch { return false; } finally { rmSync(dir, { recursive: true, force: true }); }
});

function transformed(): string {
  setConstructorBearingStructs([light, vertex]);
  const layout = {
    structFields: {
      D2GfxLightStrc: { nIntensity: 'uint8_t', nRed: 'uint8_t', nGreen: 'uint8_t', nBlue: 'uint8_t' },
      D2GlideVertexStrc: { fX: 'float', fY: 'float' },
    },
    structFieldOffsets: {
      D2GfxLightStrc: { nIntensity: 0, nRed: 1, nGreen: 2, nBlue: 3 },
      D2GlideVertexStrc: { fX: 0, fY: 4 },
    },
    aggregateSizes: { D2GfxLightStrc: 4, D2GlideVertexStrc: 8 },
    convertingAggregates: [light, vertex].filter(s => hasConvertingConstructor(s.name, s.fields)).map(s => s.name),
  };
  assert.deepEqual(layout.convertingAggregates, ['D2GfxLightStrc']);
  const src = readFileSync(new URL('./fixtures/glide-light-float-cast-0050cf70.c', import.meta.url), 'utf8')
    .replace(/(?:\w+::)+(\w+)\s*\(/, '$1(');
  return transformGhidraCode(src, {
    preset: 'full', usePluginRegistry: true, tolerateErrors: false,
    pluginOptions: { pluginOptions: { 'float-pointer-bitcast': layout, 'arith-idioms': layout } as never },
  }).code;
}

/** The emitted function body, between its outer braces. */
function body(code: string): string {
  return code.slice(code.indexOf('{') + 1, code.lastIndexOf('}'));
}

function unit(code: string): string {
  const helpers = generatePlatformHeader({} as never).split('\n')
    .filter(l => /\bd2_bits_(?:of|as|word|to_float)\b/.test(l) && !l.startsWith('//'));
  return [
    '#include <stdint.h>', '#include <string.h>', 'typedef unsigned int uint;', ...helpers,
    generateStructDeclaration(light), generateStructDeclaration(vertex),
    'extern "C" int32_t DrawStrip(int nScreenXOffset, short* pSubtile, D2GlideVertexStrc* pfColorVertex, double dScale) {',
    body(code),
    '}',
  ].join('\n');
}

describe('RENDERER_GLIDE_DrawWallTilePerspective 0050cf70: a float stored into a D2GfxLightStrc slot', () => {
  const code = transformed();

  it('writes the float store as the four-byte move, not the integer constructor', () => {
    assert.match(code, /fSubtileIndex = d2_bits_as<D2GfxLightStrc>\(\(float\)nScreenXOffset\);/, code);
    assert.doesNotMatch(code, /\(D2GfxLightStrc\)\s*\(float\)/);
  });

  it('narrows a double operand to the four-byte float the machine stored', () => {
    assert.match(code, /dwScaled = d2_bits_as<D2GfxLightStrc>\(\(float\)\(/, code);
  });

  it('leaves an integer cast into the same struct on its constructor', () => {
    assert.match(code, /fSubtileIndex = \(D2GfxLightStrc\)\(\(int\)\*pSubtile >> 5\);/, code);
  });

  it('compiles under the strict i686 flags', { skip: !has(GPP) }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'glide-light-cast-'));
    try {
      writeFileSync(join(dir, 'u.cpp'), unit(code));
      execFileSync(GPP, [...STRICT, '-o', join(dir, 'u.o'), join(dir, 'u.cpp')], { stdio: 'pipe' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reads the offset back as the float it stored', { skip: !HOST }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'glide-light-cast-'));
    try {
      const cases: Array<[number, number]> = [[0, 1.5], [80, 2], [-160, 0.5], [320, -1]];
      const main = ['#include <stdio.h>', 'int main() {',
        ...cases.map(([o, s]) => [
          `  { short sub = 0; D2GlideVertexStrc v = { 10.0f, 20.0f };`,
          `    DrawStrip(${o}, &sub, &v, ${s}); printf("%g %g\\n", (double)v.fX, (double)v.fY); }`,
        ].join('\n')), '  return 0;', '}'].join('\n');
      writeFileSync(join(dir, 'u.cpp'), `${unit(code)}\n${main}\n`);
      execFileSync(HOST![0], [...HOST!.slice(1), '-std=c++17', '-w', '-o', join(dir, 'u'), join(dir, 'u.cpp')], { stdio: 'pipe' });
      const got = execFileSync(join(dir, 'u'), { encoding: 'utf8' }).trim().split('\n');
      assert.deepEqual(got, cases.map(([o, s]) => `${10 + o} ${20 + o * s}`));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
