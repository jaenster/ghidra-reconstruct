/**
 * Tests for the quest-union field offset-remap.
 *
 * D2QuestDataStrc.pQuestSpecificData is a 32-member union of per-quest structs.
 * Ghidra resolves it to an ARBITRARY member, so a body in quest A5Q5 decompiles
 * as `((pQuestData->pQuestSpecificData).pA1Q3)->field_0x00`. The codegen switches
 * the member to the function's own quest (.pA5Q5) AND must remap the field by its
 * byte offset to that struct's real field at the same offset (field_0x00 → the
 * A5Q5 field at offset 0). Without the remap the member switch alone produces
 * "D2QuestDataA5Q5Strc has no member named 'field_0x00'".
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';

import { generateImplementation, setQuestStructLayouts, type ImplGenContext } from '../codegen/impl.js';
import type { ExtractedFunction, ReconstructOptions, StructField } from '../types.js';

function field(name: string, offset: number, dataType = 'int', size = 4): StructField {
  return { name, dataType, offset, size };
}

// Minimal layouts: only the offsets the test body touches.
const A5Q5 = {
  name: 'D2QuestDataA5Q5Strc',
  fields: [
    field('bAncientsDefeated', 0, 'byte', 1),
    field('nResurrectionCount', 12),
    field('bAncientsFightStarted', 17, 'byte', 1),
    field('nPlayersOnSummit', 84),
  ],
};
const A1Q3 = {
  name: 'D2QuestDataA1Q3Strc',
  fields: [field('field_0x00', 0, 'byte', 1), field('field_0x0c', 12)],
};
const A2Q1 = {
  name: 'D2QuestDataA2Q1Strc',
  // bRewardPending sits at offset 84 in A2Q1 → must remap to A5Q5's nPlayersOnSummit.
  fields: [field('bRewardPending', 84, 'byte', 1)],
};

const options: ReconstructOptions = {
  outputDir: './out',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

function makeFunc(name: string, decompiled: string): ExtractedFunction {
  return {
    name,
    address: '0x0058cf00',
    signature: `void ${name}(D2GameStrc * pGame)`,
    returnType: 'void',
    parameters: [{ name: 'pGame', dataType: 'D2GameStrc *', size: 4, ordinal: 0, storage: 'register' }],
    localVariables: [],
    callingConvention: '__fastcall',
    size: 64,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    decompiled,
  };
}

describe('quest-union field offset-remap', () => {
  before(() => setQuestStructLayouts([A5Q5, A1Q3, A2Q1]));

  it('remaps a field ABSENT on the decompiler member; keeps fields it actually has', () => {
    // The union members all alias offset 0, so `.pSRC->FIELD` already compiles and
    // reads the same bytes whenever FIELD is a real member of pSRC. Only an access
    // whose FIELD is ABSENT on the decompiler's member fails to compile and needs
    // remapping to the function's own quest struct.
    const func = makeFunc(
      'Q35_OnPlayerDeath',
      'void Q35_OnPlayerDeath(D2GameStrc *pGame) {\n' +
      '  D2QuestDataStrc *pQuestData;\n' +
      '  if (((pQuestData->pQuestSpecificData).pA1Q3)->field_0x00 == 0) {\n' +
      '    ((pQuestData->pQuestSpecificData).pA1Q3)->field_0x0c = 1;\n' +
      '    ((pQuestData->pQuestSpecificData).pA2Q1)->field_0x11 = 0;\n' +
      '  }\n' +
      '}'
    );
    const context: ImplGenContext = { sourceFileName: 'D2Game/Quests/A5Q5.cpp' };
    const impl = generateImplementation('A5Q5', [func], undefined, 'A5Q5.h', options, context);

    // field_0x00 / field_0x0c ARE members of A1Q3 (offsets 0 / 12) → the access
    // already compiles, so the decompiler member is kept (no clobber).
    assert.ok(impl.includes('.pA1Q3->field_0x00'), `present field_0x00 should be kept in:\n${impl}`);
    assert.ok(impl.includes('.pA1Q3->field_0x0c'), `present field_0x0c should be kept in:\n${impl}`);
    // field_0x11 (offset 17) is ABSENT on A2Q1 (only has bRewardPending@84) → must
    // remap to the function quest's field at offset 17 = bAncientsFightStarted.
    assert.ok(impl.includes('.pA5Q5->bAncientsFightStarted'), `absent-field remap missing in:\n${impl}`);
    assert.ok(!/\.pA2Q1->field_0x11\b/.test(impl), `stale absent field_0x11 in:\n${impl}`);
  });

  it('keeps a genuine cross-quest read of another quest\'s NAMED field', () => {
    // An A2Q1 function that reads A5Q5's bAncientsDefeated via the union. The
    // decompiler deliberately resolved pA5Q5 (the field is real there); forcing the
    // file quest pA2Q1 would invent "A2Q1 has no member bAncientsDefeated".
    const func = makeFunc(
      'Q08_CheckAncients',
      'void Q08_CheckAncients(D2GameStrc *pGame) {\n' +
      '  D2QuestDataStrc *pQuestData;\n' +
      '  ((pQuestData->pQuestSpecificData).pA5Q5)->bAncientsDefeated = 1;\n' +
      '}'
    );
    const impl = generateImplementation('A2Q1', [func], undefined, 'A2Q1.h', options, { sourceFileName: 'D2Game/Quests/A2Q1.cpp' });
    assert.ok(impl.includes('.pA5Q5->bAncientsDefeated'), `cross-quest named read should be kept in:\n${impl}`);
    assert.ok(!impl.includes('.pA2Q1->bAncientsDefeated'), `must not force file quest in:\n${impl}`);
  });

  it('keeps the decompiler member for structured continuation accesses (->FIELD.sub / [i])', () => {
    // An A3Q6 function whose body reads `.pA1Q1->sQuestGUID.aPlayerGUID[5]`. A3Q6
    // has no sQuestGUID; the decompiler picked pA1Q1 (which does) so the chain is
    // valid. Switching the member to pA3Q6 would deref a scalar → must be KEPT.
    setQuestStructLayouts([
      A5Q5, A1Q3, A2Q1,
      { name: 'D2QuestDataA1Q1Strc', fields: [field('sQuestGUID', 0, 'D2QuestGUIDStrc', 24)] },
      { name: 'D2QuestDataA3Q6Strc', fields: [field('bQuestTimerActive', 0, 'bool', 1)] },
    ]);
    const func = makeFunc(
      'Q23_NotifyGuardianStateToPlayers',
      'void Q23_NotifyGuardianStateToPlayers(D2GameStrc *pGame) {\n' +
      '  D2QuestDataStrc *pQuestData;\n' +
      '  int x = ((pQuestData->pQuestSpecificData).pA1Q1)->sQuestGUID.aPlayerGUID[5];\n' +
      '}'
    );
    const impl = generateImplementation('A3Q6', [func], undefined, 'A3Q6.h', options, { sourceFileName: 'D2Game/Quests/A3Q6.cpp' });
    assert.ok(impl.includes('.pA1Q1->sQuestGUID.aPlayerGUID'), `continuation access should keep pA1Q1 member in:\n${impl}`);
    assert.ok(!impl.includes('.pA3Q6->bQuestTimerActive.aPlayerGUID'), `must NOT switch member for structured access in:\n${impl}`);
    // restore the minimal layouts for other tests
    setQuestStructLayouts([A5Q5, A1Q3, A2Q1]);
  });

  it('corrects a bare assignment to a cross-quest-typed local to that local\'s own member', () => {
    setQuestStructLayouts([A5Q5, A1Q3, A2Q1]);
    // A1Q5 function with a local typed D2QuestDataA1Q4Strc* assigned from the union.
    // step 1b forces the function quest (.pA1Q5) → "cannot convert A1Q5Strc* to
    // A1Q4Strc*"; step 3 must rewrite the member to pA1Q4 (the local's own quest).
    const func: ExtractedFunction = {
      name: 'Q05_CrossQuest',
      address: '0x00500000',
      signature: 'void Q05_CrossQuest(D2GameStrc * pGame)',
      returnType: 'void',
      parameters: [{ name: 'pGame', dataType: 'D2GameStrc *', size: 4, ordinal: 0, storage: 'register' }],
      localVariables: [{ name: 'pCross', dataType: 'D2QuestDataA1Q4Strc *', size: 4 } as any],
      callingConvention: '__fastcall', size: 64, isThunk: false, isExternal: false, hasVarArgs: false,
      decompiled:
        'void Q05_CrossQuest(D2GameStrc *pGame) {\n' +
        '  D2QuestDataStrc *pQuestData;\n' +
        '  D2QuestDataA1Q4Strc *pCross;\n' +
        '  pCross = (pQuestData->pQuestSpecificData).pA1Q1;\n' +
        '}',
    };
    const impl = generateImplementation('A1Q5', [func], undefined, 'A1Q5.h', options, { sourceFileName: 'D2Game/Quests/A1Q5.cpp' });
    assert.ok(impl.includes('pCross = ') && impl.includes('.pA1Q4'), `assignment should use pA1Q4 (local's quest) in:\n${impl}`);
    assert.ok(!/pCross = [^;]*\.pA1Q5/.test(impl), `must not force function quest pA1Q5 in:\n${impl}`);
  });

  it('leaves the access untouched when the target quest has no field at that offset', () => {
    // offset 12 has no A5Q5 mapping if we feed an unknown offset (field_0x40 = 64).
    const func = makeFunc(
      'Q35_Unknown',
      'void Q35_Unknown(D2GameStrc *pGame) {\n' +
      '  D2QuestDataStrc *pQuestData;\n' +
      '  ((pQuestData->pQuestSpecificData).pA1Q3)->field_0x40 = 1;\n' +
      '}'
    );
    const impl = generateImplementation('A5Q5', [func], undefined, 'A5Q5.h', options, { sourceFileName: 'D2Game/Quests/A5Q5.cpp' });
    // member still switches to the function quest, but field_0x40 (no A5Q5 field at 64) is kept.
    assert.ok(impl.includes('.pA5Q5->field_0x40'), `expected member-switch with kept field in:\n${impl}`);
  });
});
