/**
 * Two units whose paths differ only in case keep two texts.
 *
 * A function in a module's root namespace makes the unit `D2gfx/D2gfx.cpp` beside the
 * namespace unit `D2gfx/D2GFX.cpp`; the module layout writes the first as `D2gfxRoot.cpp`,
 * but the unit loop's kept text is keyed by the namespace path. On a case-insensitive disk
 * the two were one file, and an incremental run reused the root unit's text for D2GFX,
 * which then defined the root function twice and none of its own.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractedFunction, ProgramInfo, ReconstructOptions } from '../types.js';

// The cache path is read when the generator module loads.
const dir = mkdtempSync(join(tmpdir(), 'unit-text-case-'));
process.env.RECON_UNIT_IDENT_CACHE = join(dir, 'unit-identifiers.json');
const { generateProject, configureIncrementalEmit, unitTextPath } = await import('../codegen/index.js');

const programInfo: ProgramInfo = {
  name: 'T.exe', path: '/tmp/T.exe', format: 'PE', architecture: 'x86', compiler: 'msvc',
  imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
};

const options = {
  outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false,
  promoteStaticGlobals: false,
} as ReconstructOptions;

function fn(ns: string, name: string, address: string, body: string): ExtractedFunction {
  return {
    name, address, namespace: ns, returnType: 'int', signature: `int ${name}(void)`,
    parameters: [], localVariables: [], callingConvention: '__cdecl', size: 0x20,
    isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [],
    decompiled: `int ${name}(void)\n\n{\n  ${body}\n}\n`,
  } as ExtractedFunction;
}

const namespaces = [
  { name: 'Gfx', fullPath: 'Gfx', functions: [] },
  { name: 'GFX', fullPath: 'Gfx::GFX', functions: [] },
] as never[];
const functions = () => [
  fn('Gfx', 'Unreferenced_004f8dd0', '004f8dd0', 'return 0;'),
  fn('Gfx::GFX', 'GFX_DrawImage', '004f9000', 'return 7;'),
];

function generate(): Map<string, string> {
  const project = generateProject('t', functions(), [], [], [], namespaces, options, programInfo, []);
  return new Map([...project.files].map(([p, f]) => [p, f.content]));
}

describe('unit text kept per exact unit path', () => {
  configureIncrementalEmit(null, null);
  process.env.RECON_KEEP_ALL_INCLUDES = '1';
  const full = generate();
  const units = [...full.keys()].filter(p => p.endsWith('.cpp'));
  const root = units.find(p => full.get(p)!.includes('Unreferenced_004f8dd0'));
  const gfx = units.find(p => full.get(p)!.includes('GFX_DrawImage'));

  it('emits two units whose paths differ only in case', () => {
    assert.ok(root && gfx && root !== gfx, units.join(', '));
    assert.strictEqual(root.toLowerCase(), gfx.toLowerCase(), `${root} / ${gfx}`);
  });

  it('keeps each unit its own text', () => {
    assert.notStrictEqual(unitTextPath(root!)!.toLowerCase(), unitTextPath(gfx!)!.toLowerCase());
    for (const p of [root!, gfx!]) {
      assert.ok(existsSync(unitTextPath(p)!), `${p} has no kept text`);
      assert.strictEqual(readFileSync(unitTextPath(p)!, 'utf-8'), full.get(p), p);
    }
  });

  it('reuses each unit its own text', () => {
    configureIncrementalEmit([], dir);
    try {
      const incremental = generate();
      assert.match(incremental.get(gfx!)!, /GFX_DrawImage/);
      assert.doesNotMatch(incremental.get(gfx!)!, /Unreferenced_004f8dd0/);
      for (const [p, content] of full) assert.strictEqual(incremental.get(p), content, p);
    } finally {
      configureIncrementalEmit(null, null);
      delete process.env.RECON_KEEP_ALL_INCLUDES;
    }
  });
});
