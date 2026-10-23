/**
 * Plate comments: template lines are dropped, the text a person wrote is kept, a plate of
 * only template emits nothing - and the lint that catches template reaching the tree.
 * The plates below are real 1.14d plates, as get_function_info returns them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { cleanFunctionComment } from '../codegen/header.js';
import { generateFunctionDeclaration } from '../codegen/header.js';
import { stripPlateTemplate, plateLineRule } from '../codegen/plate-comment.js';
import { parseSource, plateTemplateComment, runChecks, treeFromFiles, type Finding } from '../lint/index.js';

/** FreeMemoryPool @ 00409c80: batch_rename header around the reverse team block. */
const FREE_MEMORY_POOL =
  '@function FreeMemoryPool\n@address Game.exe.ram:00409c80\n@date 2026.06.12\n@calling __cdecl\n' +
  '@description Diablo 2 1.14d reverse team\nhttps://blizzhackers.dev\n        \n' +
  '@Date: 2022.01.27\n@Author: dzik\n@Function: FreeMemoryPool\n@Address: Game.0x00409c80';

/** STRTABLE_GetStringByIndex @ 00524930: @params block, plain editor block, register warning. */
const GET_STRING_BY_INDEX =
  '@function STRTABLE_GetStringByIndex\n@address Game.exe.ram:00524930\n@date 2026.06.13\n@params\n' +
  '  pStrTable: ECX:4 (int32_t)\n  pEntryPtrTable: EDX:4 (int32_t)\n  wRawIndex: Stack[0x4]:2 (uint16_t)\n' +
  '  dwErrorCode: ESI:4 (DWORD)\n@description Diablo 2 1.14d reverse team\nhttps://blizzhackers.dev\n\n' +
  'Function: STRTABLE_GetStringByIndex\nAddress: Game.00524930\nDate: 2022.02.10\nLast editor: jaenster\n\n' +
  'Function uses custom registers for function arguments!\n[int32_t pStrTable@ECX:4]\n' +
  '[int32_t pEntryPtrTable@EDX:4]\n[uint16_t wRawIndex@Stack[0x4]:2]\n[DWORD dwErrorCode@ESI:4]';

describe('plate comment: template dropped', () => {
  it('the full dzik / blizzhackers block, @-tag form: nothing is left', () => {
    assert.strictEqual(cleanFunctionComment(FREE_MEMORY_POOL), '');
  });

  it('the @-tag header with an @params block and the plain editor block: nothing is left', () => {
    assert.strictEqual(cleanFunctionComment(GET_STRING_BY_INDEX), '');
  });

  it('Last editor, Author and the reverse team header lines each match a rule', () => {
    for (const l of ['Last editor: dzik', 'Last editor: jaenster', 'Author: dzik', '@Author: dzik',
      'Date: 2022.01.12', '@Date: 2022.01.27', 'Address: Game.00439af0', '@Address: Game.0x00409c80',
      'Function: UIMENU_CALLBACK_SetDificultySingleplayerTcpIp', '@Function: FreeMemoryPool',
      'Diablo 2 1.14d reverse team', 'https://blizzhackers.dev',
      'Already has a meaningful @description (applied via previous session).',
      '@sourcefile-basis Blizzard __FILE__ literal referenced from inside this function\'s body (1 site: 0062c71a). First-party 1.14d evidence, not inferred and not from D2R.']) {
      assert.ok(plateLineRule(l), `kept: ${l}`);
    }
  });

  it('a plate with real text and template keeps the text, in order, and @sourcefile', () => {
    const plate =
      '@function IsValidImbumeItem\n@address Game.exe.ram:0062c590\n@date 2026.06.13\n' +
      '@params\n  pUnit: Stack[0x4]:4 (D2UnitStrc *)\n' +
      '@description Returns 1 if pUnit is a valid target for the Imbue quest reward. Has a prior per-function @Author annotation.\n' +
      'Rejects gold and quest items.\n' +
      '@sourcefile .\\ITEMS\\Items.cpp\n' +
      '@sourcefile-basis Blizzard __FILE__ literal referenced from inside this function\'s body (1 site: 0062c63e). First-party 1.14d evidence, not inferred and not from D2R.';
    assert.strictEqual(cleanFunctionComment(plate),
      'Returns 1 if pUnit is a valid target for the Imbue quest reward.\n' +
      'Rejects gold and quest items.\n' +
      '@sourcefile .\\ITEMS\\Items.cpp');
  });

  it('the banner fused onto a sentence goes, the sentence stays', () => {
    assert.deepStrictEqual(
      stripPlateTemplate(['@description Diablo 2 1.14d reverse team. In-place constructor for the SRP context.']),
      ['In-place constructor for the SRP context.']);
  });

  it('text that only looks like a header field is kept', () => {
    const kept = [
      'Function: returns the address of the node, or null.',
      'Address of pNode\'s link in this list.',
      'Date: computed from the save header',
      // A tool note that carries a summary: kept, so the lint asks for the plate to be fixed in Ghidra.
      'Already has a meaningful @description (maximizes AC or damage stats when an enhanced property is applied).',
      '  nCount: the number of entries',
    ];
    assert.deepStrictEqual(stripPlateTemplate(kept), kept);
  });

  it('the @params block ends at the first line that is not a parameter', () => {
    assert.deepStrictEqual(
      stripPlateTemplate(['@params', '  nParam: EAX:4 (int32_t)', '  nExp: EDX:4,EAX:4 (ulonglong)',
        '  pGame: Stack[0x4]:4 (D2GameStrc *)', 'Rounds nParam up to a size class.']),
      ['Rounds nParam up to a size class.']);
  });

  it('a plate of only template emits no comment line above the declaration', () => {
    const decl = generateFunctionDeclaration({
      name: 'FreeMemoryPool', address: '00409c80', returnType: 'void', callingConvention: '__cdecl',
      parameters: [], comment: FREE_MEMORY_POOL,
    } as any, {} as any);
    assert.strictEqual(decl, 'void FreeMemoryPool(); // 1.14d: 00409c80');
  });
});

describe('lint: plate-template-comment', () => {
  function lint(src: string): Finding[] {
    const f = parseSource('a.cpp', src);
    assert.deepStrictEqual(f.parseErrors, []);
    const r = runChecks(treeFromFiles('/nonexistent', [f]), null, [plateTemplateComment]);
    assert.deepStrictEqual(r.errors, []);
    return r.findings;
  }
  const rules = (fs: Finding[]) => fs.map(f => f.subject).sort();

  it('flags each template shape that reaches a comment', () => {
    const fs = lint(
      '// Diablo 2 1.14d reverse team\n' +
      '// @date 2026.06.12\n' +
      '// @sourcefile-basis Blizzard __FILE__ literal, not from D2R.\n' +
      '// https://blizzhackers.dev\n' +
      '// Last editor: dzik\n' +
      '//   nParam: EAX:4 (int32_t)\n' +
      '//   nExp: EDX:4,EAX:4 (ulonglong)\n' +
      'int f(int nParam) {\n' +
      '    /* @function g\n       @address Game.exe.ram:0043077c */ return nParam;\n' +
      '}\n');
    assert.deepStrictEqual(rules(fs), [
      'blizzhackers-link', 'editor-block', 'params-block', 'params-block', 'reverse-team-banner', 'sourcefile-basis',
      'template-tag', 'template-tag', 'template-tag',
    ]);
    assert.ok(fs.every(f => f.file === 'a.cpp' && f.line! > 0));
  });

  it('is silent on real text, @sourcefile, the address anchor and strings', () => {
    const fs = lint(
      '// Returns the address of the node. Date: unknown.\n' +
      '// @sourcefile .\\ITEMS\\Items.cpp\n' +
      '// 1.14d: 00409dd0\n' +
      'const char* f() { return "Diablo 2 1.14d reverse team @date"; }\n');
    assert.deepStrictEqual(fs, []);
  });
});
