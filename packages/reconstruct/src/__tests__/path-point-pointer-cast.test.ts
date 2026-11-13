/**
 * PATH_CalculatePath (0x00649970) with D2PathTypeArg +0x00 typed as two
 * D2PathPointStrc (start, target), the layout of issue #264. The start point is
 * packed in the reused `pDynamicPath` stack slot, so the decompiler writes
 *
 *     sPathTypeArg.tStartCoord = (D2PathPointStrc)pDynamicPath;
 *
 * D2PathPointStrc is emitted with a converting constructor from `uint32_t`, and
 * an address reaches no integer implicitly, so that cast was "invalid cast from
 * type 'D2DynamicPathStrc*' to type 'D2PathPointStrc'" under the strict build
 * (Game.exe v2084). The instruction is `MOV [EBP-0x34],EDX` at 0x00649a0a: the
 * same four bytes, stored. The fixture is the v2086 decompile with the field
 * accesses Ghidra prints under that layout.
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

const point = {
  name: 'D2PathPointStrc', kind: 'STRUCTURE', size: 4, alignment: 2, category: '/_Source/Path',
  fields: [
    { name: 'nX', dataType: 'uint16_t', offset: 0, size: 2 },
    { name: 'nY', dataType: 'uint16_t', offset: 2, size: 2 },
  ],
} as unknown as ExtractedStruct;

const arg = {
  name: 'D2PathTypeArg', kind: 'STRUCTURE', size: 8, alignment: 2, category: '/_Source/Path',
  fields: [
    { name: 'tStartCoord', dataType: 'D2PathPointStrc', offset: 0, size: 4 },
    { name: 'tTargetCoord', dataType: 'D2PathPointStrc', offset: 4, size: 4 },
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
  setConstructorBearingStructs([point, arg]);
  const layout = {
    structFields: {
      D2PathPointStrc: { nX: 'uint16_t', nY: 'uint16_t' },
      D2PathTypeArg: { tStartCoord: 'D2PathPointStrc', tTargetCoord: 'D2PathPointStrc' },
    },
    structFieldOffsets: { D2PathPointStrc: { nX: 0, nY: 2 }, D2PathTypeArg: { tStartCoord: 0, tTargetCoord: 4 } },
    aggregateSizes: { D2PathPointStrc: 4, D2PathTypeArg: 8 },
    convertingAggregates: [point, arg].filter(s => hasConvertingConstructor(s.name, s.fields)).map(s => s.name),
  };
  assert.deepEqual(layout.convertingAggregates, ['D2PathPointStrc']);
  const src = readFileSync(new URL('./fixtures/path-point-cast-00649970.c', import.meta.url), 'utf8')
    .replace(/(?:\w+::)+(\w+)\s*\(/, '$1(');
  return transformGhidraCode(src, {
    preset: 'full', usePluginRegistry: true, tolerateErrors: false,
    pluginOptions: { pluginOptions: { 'float-pointer-bitcast': layout, 'arith-idioms': layout } as never },
  }).code;
}

/** The emitted statements from the slot's packing to the start-point store. */
function startPointStatements(code: string): string {
  const from = code.indexOf('pDynamicPath = (D2DynamicPathStrc*)');
  const store = code.indexOf('sPathTypeArg.tStartCoord = ', from);
  assert.ok(from >= 0 && store > from, code);
  return code.slice(from, code.indexOf(';', store) + 1);
}

/**
 * A translation unit around the emitted statements: the two structs as the header
 * emits them, the reinterpretation helpers as d2_platform.h emits them, and the
 * function's own locals.
 */
function unit(statements: string): string {
  const helpers = generatePlatformHeader({} as never).split('\n')
    .filter(l => /\bd2_bits_(?:of|as|word)\b/.test(l) && !l.startsWith('//'));
  return [
    '#include <stdint.h>', '#include <string.h>', ...helpers,
    'struct D2DynamicPathStrc;',
    generateStructDeclaration(point), generateStructDeclaration(arg),
    'extern "C" uint32_t PackStart(short sCurX, short sCurY) {',
    '  D2DynamicPathStrc* pDynamicPath;', '  D2PathTypeArg sPathTypeArg;',
    `  ${statements}`,
    '  return (uint32_t)sPathTypeArg.tStartCoord.nX | (uint32_t)sPathTypeArg.tStartCoord.nY << 16;',
    '}',
  ].join('\n');
}

describe('PATH_CalculatePath 00649970: a pointer slot stored into a D2PathPointStrc', () => {
  const code = transformed();
  const statements = startPointStatements(code);

  it('writes the store as the four-byte move, not a constructor call', () => {
    assert.match(statements, /sPathTypeArg\.tStartCoord = d2_bits_as<D2PathPointStrc>\(pDynamicPath\);$/, statements);
    assert.doesNotMatch(code, /\(D2PathPointStrc\)\s*pDynamicPath/);
  });

  it('leaves an integer cast into the same struct on its constructor', () => {
    assert.match(code, /sPathTypeArg\.tTargetCoord\.nX = pDynamicPath_00->nTargetX;/);
    assert.doesNotMatch(code, /d2_bits_as<D2PathPointStrc>\((?!pDynamicPath\))/);
  });

  it('compiles under the strict i686 flags', { skip: !has(GPP) }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'path-point-cast-'));
    try {
      writeFileSync(join(dir, 'u.cpp'), unit(statements));
      execFileSync(GPP, [...STRICT, '-o', join(dir, 'u.o'), join(dir, 'u.cpp')], { stdio: 'pipe' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('stores X at +0 and Y at +2, the packed X | Y << 16 the machine stored', { skip: !HOST }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'path-point-cast-'));
    try {
      const cases: Array<[number, number]> = [[0x1234, 0x0567], [-1, 1], [0, -2], [0x7fff, -0x8000]];
      const main = ['#include <stdio.h>', 'int main() {',
        ...cases.map(([x, y]) => `  printf("%08x\\n", PackStart(${x}, ${y}));`), '  return 0;', '}'].join('\n');
      writeFileSync(join(dir, 'u.cpp'), `${unit(statements)}\n${main}\n`);
      execFileSync(HOST![0], [...HOST!.slice(1), '-std=c++17', '-w', '-o', join(dir, 'u'), join(dir, 'u.cpp')], { stdio: 'pipe' });
      const got = execFileSync(join(dir, 'u'), { encoding: 'utf8' }).trim().split('\n');
      const want = cases.map(([x, y]) => (((y & 0xffff) << 16 | (x & 0xffff)) >>> 0).toString(16).padStart(8, '0'));
      assert.deepEqual(got, want);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
