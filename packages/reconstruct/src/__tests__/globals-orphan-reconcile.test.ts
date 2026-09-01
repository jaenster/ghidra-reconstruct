/**
 * Regression test: a global that exists in Ghidra, with a name and a type, must
 * never reach the output tree as nothing at all.
 *
 * Two passes DEMOTE a global out of globals.h on the promise that some other
 * file will emit it:
 *   - `computeFileLocalGlobals` -> scope 'file-local', ownerFile = an impl path;
 *   - the struct co-location pass -> scope 'struct-colocated', ownerStructHeader.
 * Both promises are made against paths recomputed independently of the paths the
 * file generator actually emits, so when the two disagree the global is emitted
 * by NOBODY — no extern, no definition, and every body that names it fails.
 *
 * Verified in Ghidra (1.14d Game.exe) against recon/diablo-2:
 *   gbNpcMenuTransactionConfirmed  @007c0de1  bool  3 xrefs
 *     (NPCMENU_HandleTradeAccepted, NPCMENU_HandleTransactionComplete, ShopAction)
 *   -> used at D2Client/UI/NpcMenu/NpcMenu.cpp:1120, 1872, 1875, 1936, 3256
 *   -> declared and defined nowhere in the tree.
 * Same shape for gbUICtrlConfigPendingKey (@007c02c0), gbNpcMenuShopTransactionActive
 * (@007c0de9), gbAuthCheckVersionValid (@008823ec), gbSIDVersionCheckComplete
 * (@008822c4).
 *
 * The demotion is therefore treated as an optimization that has to be VERIFIED:
 * the emitter that takes a global marks it claimed, and anything unclaimed goes
 * back to globals.h/globals.cpp.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  reconcileOrphanedGlobals,
  markGlobalsClaimed,
  generateGlobalsHeader,
  generateGlobalsImpl,
} from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, ReconstructOptions } from '../types.js';

const options = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

const npcMenuFlag = (): AnalyzedDataSymbol => ({
  name: 'gbNpcMenuTransactionConfirmed',
  address: '007c0de1',
  dataType: 'bool',
  suggestedType: 'bool',
  size: 1,
  isInitialized: true,
  xrefCount: 3,
  referencingFunctions: [
    'D2Client::UI::NpcMenu::NPCMENU_HandleTradeAccepted',
    'D2Client::UI::NpcMenu::NPCMENU_HandleTransactionComplete',
    'D2Client::UI::NpcMenu::ShopAction',
  ],
  scope: 'file-local',
  ownerFile: 'D2Client/UI/NpcMenu.cpp',
} as AnalyzedDataSymbol);

describe('a global that no output file claimed goes back into globals.h/cpp', () => {
  it('restores an unclaimed file-local global to global scope', () => {
    const g = npcMenuFlag();
    const restored = reconcileOrphanedGlobals([g]);

    assert.deepStrictEqual(restored.map(r => r.name), ['gbNpcMenuTransactionConfirmed']);
    assert.strictEqual(g.scope, 'global');
    assert.strictEqual(g.ownerFile, undefined);
  });

  it('leaves a file-local global alone once its impl file claimed it', () => {
    const g = npcMenuFlag();
    markGlobalsClaimed([g]);

    assert.deepStrictEqual(reconcileOrphanedGlobals([g]), []);
    assert.strictEqual(g.scope, 'file-local');
  });

  it('restores an unclaimed struct-colocated global too', () => {
    const g = {
      ...npcMenuFlag(),
      scope: 'struct-colocated',
      ownerFile: undefined,
      ownerStructType: 'D2NpcMenuOptions',
      ownerStructHeader: 'D2Client/UI/NpcMenuOptions.h',
    } as AnalyzedDataSymbol;

    assert.strictEqual(reconcileOrphanedGlobals([g]).length, 1);
    assert.strictEqual(g.scope, 'global');
    assert.strictEqual(g.ownerStructHeader, undefined);
  });

  it('the restored global then reaches BOTH globals.h and globals.cpp', () => {
    const g = npcMenuFlag();
    reconcileOrphanedGlobals([g]);

    assert.match(generateGlobalsHeader([g], options), /extern bool gbNpcMenuTransactionConfirmed;/);
    assert.match(generateGlobalsImpl([g], options), /^bool gbNpcMenuTransactionConfirmed = 0;$/m);
  });

  it('never touches a genuinely global symbol', () => {
    const g = { ...npcMenuFlag(), scope: 'global', ownerFile: undefined } as AnalyzedDataSymbol;
    assert.deepStrictEqual(reconcileOrphanedGlobals([g]), []);
    assert.strictEqual(g.scope, 'global');
  });
});
