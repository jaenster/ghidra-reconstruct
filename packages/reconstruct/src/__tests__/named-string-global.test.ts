/**
 * A user-named string datum is a variable the decompiler names, not a literal it inlines:
 * CHAT_HandleWhisperCommand passes `gszChatWhisperTargetName` (@00712ffc, `" "`) to strtok.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { namedStringAsCharArray } from '../extract/globals.js';
import { generateProject } from '../codegen/index.js';
import type { AnalyzedDataSymbol, ExtractedFunction, ReconstructOptions } from '../types.js';

describe('namedStringAsCharArray', () => {
  it('keeps a named string as its char array, and drops an auto label', () => {
    const g = { name: 'gszChatWhisperTargetName', address: '00712ffc', dataType: 'TerminatedCString', size: 2, value: ' ' };
    assert.deepStrictEqual(namedStringAsCharArray(g), { ...g, dataType: 'char[2]', initializedData: { kind: 'string', value: ' ' } });
    assert.strictEqual(namedStringAsCharArray({ ...g, name: 's_Hello_00712ffc' }), null);
    assert.strictEqual(namedStringAsCharArray({ ...g, value: 'too long' }), null);
  });

  it('is declared and defined, so the body that names it compiles', () => {
    const options: ReconstructOptions = { outputDir: './o', format: 'cpp', organization: 'namespace', generateCMake: false,
      generateSourceMaps: false, transformPreset: 'quick', includeAddressComments: false, promoteStaticGlobals: false };
    const g = namedStringAsCharArray({ name: 'gszChatWhisperTargetName', address: '00712ffc', dataType: 'TerminatedCString', size: 2, value: ' ',
      isInitialized: true, xrefCount: 2, referencingFunctions: ['A::F', 'A::G'], namespace: null } as unknown as AnalyzedDataSymbol)!;
    const sym = { ...g, scope: 'global', suggestedName: g.name, suggestedType: 'char[2]' } as unknown as AnalyzedDataSymbol;
    const fn = (name: string) => ({ name, address: name === 'F' ? '0047c1f0' : '0047c300', signature: `void ${name}(char *s)`, returnType: 'void',
      parameters: [{ name: 's', dataType: 'char *', size: 4, ordinal: 0 }], localVariables: [], callingConvention: '__cdecl', size: 16,
      isThunk: false, isExternal: false, hasVarArgs: false, namespace: 'A',
      decompiled: `void ${name}(char *s)\n{\n  strtok(s,gszChatWhisperTargetName);\n  return;\n}\n`, calledFunctions: [] } as unknown as ExtractedFunction);
    const project = generateProject('T', [fn('F'), fn('G')], [], [], [sym], [], options);
    const all = [...project.files.values()].map(f => f.content).join('\n');
    assert.match(all, /char gszChatWhisperTargetName\[2\] = (\{ )?" "( \})?;/);
    assert.match(all, /extern char gszChatWhisperTargetName\[2\];/);
  });
});
