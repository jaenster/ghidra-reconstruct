/**
 * Ghidra's /Demangler/_EXCEPTION_DISPOSITION was given its values at v1100. mingw's
 * <excpt.h> defines exactly those names as macros (`#define ExceptionContinueExecution 0`),
 * so d2_enums.h's `constexpr _EXCEPTION_DISPOSITION ExceptionContinueExecution = 0;`
 * expanded to `constexpr int 0 = 0;` in all 531 TUs (8,496 errors at v1103).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateProject } from '../codegen/index.js';
import type { ExtractedEnum, ReconstructOptions } from '../types.js';

const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'quick', includeAddressComments: false,
  promoteStaticGlobals: false,
};

const DISPOSITION = {
  name: '_EXCEPTION_DISPOSITION', category: '/Demangler', size: 4, kind: 'ENUM', description: '',
  values: [
    { name: 'ExceptionContinueExecution', value: 0 }, { name: 'ExceptionContinueSearch', value: 1 },
    { name: 'ExceptionNestedException', value: 2 }, { name: 'ExceptionCollidedUnwind', value: 3 },
  ],
} as unknown as ExtractedEnum;

describe('d2_enums.h: constants the SDK defines as macros', () => {
  it('guards _EXCEPTION_DISPOSITION\'s members out of a Win32 build', () => {
    const project = generateProject('T', [], [], [DISPOSITION], [], [], options);
    const enums = project.files.get('d2_enums.h')!.content;
    const guarded = enums.slice(enums.indexOf('#ifndef _WIN32'));
    assert.match(enums, /typedef int _EXCEPTION_DISPOSITION;/);
    for (const v of DISPOSITION.values) {
      const line = `constexpr _EXCEPTION_DISPOSITION ${v.name} = ${v.value};`;
      assert.ok(enums.includes(line), line);
      assert.ok(guarded.includes(line), `${v.name} is emitted outside the _WIN32 guard`);
    }
  });
});
