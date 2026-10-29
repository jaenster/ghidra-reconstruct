/**
 * REP STOS/MOVS facts (extract/string-ops.ts) and what codegen makes of them
 * (codegen/rep-string-spec.ts, the `rep-string-form` pass), plus the byte compare with 1
 * that compare-form keeps as `== 1`.
 *
 * The rows are what the extraction script printed for GAMEDATA_GetCenteredTextX 0044d390,
 * NET_SERVER_SentPacketLog_Clear 0040b0c0 and SPELLSEL_Initialize 004a8a30 (Game.exe v1767).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parseStringOpRow, parseStringOps, printsRepLoop, STRING_OPS_SCRIPT } from '../extract/string-ops.js';
import { repStringOps } from '../codegen/rep-string-spec.js';
import { FUNCTION_FACTS_SCRIPT, parseFunctionFacts, selectFacts } from '../extract/function-facts.js';
import { generateFunctionImplementation } from '../codegen/impl.js';
import { compareFormDecision } from '../codegen/compare-form-spec.js';
import { compareSiteRows } from '../extract/compare-sites.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const CENTERED_C = "\n/* @function GAMEDATA_GetCenteredTextX\n   @address Game.exe.ram:0044d390\n   @date 2026.06.06\n   @calling __fastcall\n   @description Diablo 2 1.14d reverse team\n   https://blizzhackers.dev */\n\nint32_t __fastcall\nD2Client::GAME::Game::GAMEDATA_GetCenteredTextX(uint16_t nStringId,int32_t nCenterX)\n\n{\n  WCHAR *pSourceStr;\n  int32_t nTextWidth;\n  int iClear;\n  WCHAR wszText [100];\n  \n  pSourceStr = wszText;\n  for (iClear = 0x32; iClear != 0; iClear = iClear + -1) {\n    pSourceStr[0] = L'\\0';\n    pSourceStr[1] = L'\\0';\n    pSourceStr = pSourceStr + 2;\n  }\n  pSourceStr = D2Lang::StrTable::strtable::GetLocaleString(nStringId);\n  D2Lang::Unicode::UNISYS::STRING_CopyWideString(wszText,pSourceStr);\n  nTextWidth = D2Win::Src::D2WinFont::DRAW_text0(wszText);\n  return nCenterX - nTextWidth / 2;\n}\n\n";

const NPC_END_C = "\n/* @function NPCMENU_HandlePlayerInteractionEnd\n   @address Game.exe.ram:004b3e10\n   @date 2026.06.12\n   @calling __fastcall\n   @description Diablo 2 1.14d reverse team\n   https://blizzhackers.dev */\n\nvoid __fastcall D2Client::UI::npcmenu::NPCMENU_HandlePlayerInteractionEnd(D2UnitStrc *pUnit)\n\n{\n  D2UnitStrc *pPlayer;\n  void *nErrorAddr;\n  bool *pCurrentSpeech;\n  int nSpeechEntryIdx;\n  int32_t nErrorLine;\n  \n  pPlayer = D2Client::UNIT::Player::GetPlayerUnit_UI();\n  if (pUnit == pPlayer) {\n    nSpeechEntryIdx = 0;\n    if (0 < D2NPCSpeechCount) {\n      pCurrentSpeech = &D2NPCSpeech[0].field5_0x11;\n      do {\n        if (*pCurrentSpeech == true) {\n          *pCurrentSpeech = false;\n          pPlayer = D2Client::UNIT::Player::GetPlayerUnit_UI();\n          if (pPlayer == (D2UnitStrc *)0x0) {\n            nErrorLine = 0xfab;\n            nErrorAddr = Fog::Src::ErrorManager::GetInstructionPointer();\n            Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt(\"\",nErrorAddr,nErrorLine);\n                    /* WARNING: Subroutine does not return */\n            compiler::_exit(-1);\n          }\n          D2Client::UI::npcmenu::NPCMENU_SelectRandomDialogOption\n                    ((D2NPCSpeechStrc *)(pCurrentSpeech + -0x11));\n        }\n        pCurrentSpeech[4] = true;\n        nSpeechEntryIdx = nSpeechEntryIdx + 1;\n        pCurrentSpeech = pCurrentSpeech + 0x16;\n      } while (nSpeechEntryIdx < D2NPCSpeechCount);\n    }\n  }\n  return;\n}\n\n";

const NPC_END_SITES = [
  '0\t==\tINT_EQUAL\t4\t-1\t-\tv:pUnit\tv:pPlayer\t004b3e18\t004b3e1a\tJNZ\t004b3e18\tCMP\t4\tr\tr\t-\t1',
  '1\t<\tINT_SLESS\t4\t0\t0\tc:0\tv:D2NPCSpeechCount\t004b3e29\t004b3e29\tJLE\t004b3e23\tCMP\t4\tm\tz\t0\t1',
  '2\t==\tINT_EQUAL\t1\t1\t1\te\tc:1\t004b3e30\t004b3e33\tJNZ\t004b3e30\tCMP\t1\tm\ti\t1\t1',
  '3\t==\tINT_EQUAL\t4\t1\t0\tv:pPlayer\tc:0\t004b3e3d\t004b3e3f\tJZ\t004b3e3d\tTEST\t4\tr\tz\t0\t1',
  '4\t<\tINT_SLESS\t4\t-1\t-\tv:nSpeechEntryIdx\tv:D2NPCSpeechCount\t004b3e5a\t004b3e5a\tJL\t004b3e54\tCMP\t4\tr\tm\t-\t1',
].join('\n');

const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
  generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false, promoteStaticGlobals: false,
};

describe('string-ops extraction', () => {
  it('parses the rows the script printed', () => {
    const ops = parseStringOpRow('1c,STOSD.REP,32,0,iClear|pSourceStr;1a7,STOSD.REP,3c,ffffffff,iClear|pSlotPtr;1d,MOVSD.REP,1fe,-,nCopyCount|pDst|pSrc');
    assert.deepStrictEqual(ops, [
      { at: 0x1c, op: 'stos', unit: 4, ecx: 0x32, eax: 0, names: ['iClear', 'pSourceStr'] },
      { at: 0x1a7, op: 'stos', unit: 4, ecx: 0x3c, eax: 0xffffffff, names: ['iClear', 'pSlotPtr'] },
      { at: 0x1d, op: 'movs', unit: 4, ecx: 0x1fe, names: ['nCopyCount', 'pDst', 'pSrc'] },
    ]);
    assert.deepStrictEqual(parseStringOpRow('2,STOSB.REP,-,0,n|p')[0], { at: 2, op: 'stos', unit: 1, eax: 0, names: ['n', 'p'] });
    assert.deepStrictEqual(parseStringOpRow('2,CMPSB.REPE,4,-,n'), []);
    const byFn = parseStringOps('R\t0044d390\t1c,STOSD.REP,32,0,iClear|pSourceStr\nR\t00401000\t\n');
    assert.deepStrictEqual([...byFn.keys()], ['0044d390']);
  });

  it('reads only functions that print a counted loop', () => {
    assert.ok(printsRepLoop(CENTERED_C));
    assert.ok(!printsRepLoop('for (i = 0; i < 4; i = i + 1) {'));
  });

  it('rides on the combined facts script and is selected like the other facts', () => {
    assert.match(FUNCTION_FACTS_SCRIPT, /STOSD|\.REP/);
    assert.match(STRING_OPS_SCRIPT, /\.REP/);
    const out = `P\tprog\nF\t0044d390\tself\t1\t2\t1\nR\t0044d390\t1c,STOSD.REP,32,0,iClear|pSourceStr\nD\t\n`;
    const row = parseFunctionFacts(out).rows.get('0044d390')!;
    assert.strictEqual(row.stringRow, '1c,STOSD.REP,32,0,iClear|pSourceStr');
    const facts = selectFacts(CENTERED_C, '0044d390', row, false);
    assert.deepStrictEqual(facts.stringOps, [{ at: 0x1c, op: 'stos', unit: 4, ecx: 0x32, eax: 0, names: ['iClear', 'pSourceStr'] }]);
    assert.strictEqual(selectFacts('int f() { return 0; }', '0044d390', row, false).stringOps, undefined);
  });
});

describe('rep-string spec', () => {
  it('keeps an instruction with an immediate count, and a fill only with a known EAX', () => {
    const ops = repStringOps({
      address: '0044d390',
      stringOps: [
        { at: 0x1c, op: 'stos', unit: 4, ecx: 0x32, eax: 0, names: ['iClear', 'pSourceStr'] },
        { at: 0x30, op: 'stos', unit: 4, names: ['n', 'p'] },
        { at: 0x40, op: 'stos', unit: 4, ecx: 8, names: ['n', 'p'] },
        { at: 0x50, op: 'movs', unit: 4, ecx: 10, names: ['n', 'd', 's'] },
      ],
    });
    assert.deepStrictEqual(ops, [
      { op: 'stos', unit: 4, count: 0x32, fill: 0, names: ['iClear', 'pSourceStr'], address: '0044d3ac' },
      { op: 'movs', unit: 4, count: 10, names: ['n', 'd', 's'], address: '0044d3e0' },
    ]);
    assert.strictEqual(repStringOps({ address: '0044d390' }), undefined);
  });
});

describe('rep-string-form and the byte compare with 1 in codegen', () => {
  const centered = (stringOps?: ExtractedFunction['stringOps']): ExtractedFunction => ({
    name: 'GAMEDATA_GetCenteredTextX', address: '0044d390',
    signature: 'int32_t GAMEDATA_GetCenteredTextX(uint16_t nStringId, int32_t nCenterX)', returnType: 'int32_t',
    parameters: [
      { name: 'nStringId', dataType: 'uint16_t', size: 2, ordinal: 0, storage: 'CX:2' },
      { name: 'nCenterX', dataType: 'int32_t', size: 4, ordinal: 1, storage: 'EDX:4' },
    ],
    localVariables: [], callingConvention: '__fastcall', size: 0x4e, isThunk: false, isExternal: false, hasVarArgs: false,
    decompiled: CENTERED_C, ...(stringOps ? { stringOps } : {}),
  } as ExtractedFunction);

  it('GAMEDATA_GetCenteredTextX: the rep stosd fill is the index loop over wszText', () => {
    const out = generateFunctionImplementation(
      centered([{ at: 0x1c, op: 'stos', unit: 4, ecx: 0x32, eax: 0, names: ['iClear', 'pSourceStr'] }]), undefined, options);
    assert.match(out, /for \(iClear = 0; iClear < 0x64; iClear\+\+\) \{\s*wszText\[iClear\] = (L'\\0'|0);\s*\}/);
    assert.doesNotMatch(out, /pSourceStr\[1\]/);
    assert.doesNotMatch(out, /pSourceStr = wszText/);
  });

  it('leaves the pointer loop without the fact, or with a fact for another count', () => {
    for (const ops of [undefined, [{ at: 0x1c, op: 'stos' as const, unit: 4 as const, ecx: 0x31, eax: 0, names: ['iClear', 'pSourceStr'] }]]) {
      const out = generateFunctionImplementation(centered(ops), undefined, options);
      assert.match(out, /pSourceStr\[1\]/);
    }
  });

  const npcEnd = (compareSites?: string): ExtractedFunction => ({
    name: 'NPCMENU_HandlePlayerInteractionEnd', address: '004b3e10',
    signature: 'void NPCMENU_HandlePlayerInteractionEnd(D2UnitStrc *pUnit)', returnType: 'void',
    parameters: [{ name: 'pUnit', dataType: 'D2UnitStrc *', size: 4, ordinal: 0, storage: 'ECX:4' }],
    localVariables: [], callingConvention: '__fastcall', size: 0x80, isThunk: false, isExternal: false, hasVarArgs: false,
    decompiled: NPC_END_C, ...(compareSites ? { compareSites } : {}),
  } as ExtractedFunction);

  it('the decision for `cmp byte ptr [x], 1` carries the constant', () => {
    const [cmpOne] = compareSiteRows(NPC_END_SITES).filter(r => r.ord === 2);
    const o = compareFormDecision(cmpOne);
    assert.ok('decision' in o);
    assert.deepStrictEqual({ keep: o.decision.keep, k: o.decision.k, width: o.decision.width }, { keep: true, k: 1, width: 1 });
  });

  it('NPCMENU_HandlePlayerInteractionEnd: `cmp byte ptr [eax], 1` stays a compare with 1', () => {
    const out = generateFunctionImplementation(npcEnd(NPC_END_SITES), undefined, options);
    assert.match(out, /\*pCurrentSpeech == 1\)/);
    const plain = generateFunctionImplementation(npcEnd(), undefined, options);
    assert.match(plain, /if \(\*pCurrentSpeech\) \{/);
  });
});
