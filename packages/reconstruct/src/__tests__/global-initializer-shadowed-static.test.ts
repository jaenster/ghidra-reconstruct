/**
 * A symbol a global initializer names must never get internal linkage.
 *
 * `computeFileLocalGlobals` promotes a global to `static` in one .cpp when every
 * function Ghidra records as referencing it lands in that file. Ghidra's
 * referencing-function list counts code xrefs only — and not even all of them, a
 * read it classes non-primary is absent — so a pointer that one loader writes
 * and a global TABLE reads looks single-owner.
 *
 * The result is not a compile error and not a link error. `static void *X` in
 * MainMenus.cpp and `void *X` in globals.D2Launch.cpp are two objects with one
 * name, one internal and one external linkage, which C++ allows without a word:
 *
 *     01a65b80 b D2Launch::MainMenus::DC6_FrontEnd_amazon_amnu2  <- the loader writes here
 *     01bb094c B DC6_FrontEnd_amazon_amnu2                       <- the table reads here, always 0
 *
 * That is silent memory corruption — the char-select screen faulted on
 * IMAGE_GetFramesCount(NULL) because every animation row but the first pointed
 * at the copy nothing ever filled. So the address-taken test outranks the xref
 * count: an unnecessarily external symbol costs a relocation, a shadowed one
 * costs a crash nobody can see coming.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  computeFileLocalGlobals,
  collectInitializerReferencedNames,
  promoteInitializerReferencedGlobals,
} from '../codegen/index.js';
import type { AnalyzedDataSymbol } from '../types.js';

/** The DC6 pointer the loader writes and `gaCharSelectAnimFramesAmazon` reads. */
function makeTarget(over: Partial<AnalyzedDataSymbol> = {}): AnalyzedDataSymbol {
  return {
    name: 'DC6_FrontEnd_amazon_amnu2',
    address: '00779828',
    size: 4,
    dataType: 'DC6 *',
    scope: 'global',
    isInitialized: true,
    value: '0',
    // Only the loader shows up: the free loop's read is classed non-primary.
    referencingFunctions: ['IMAGE_LoadPredefinedImagesEx'],
    ...over,
  } as AnalyzedDataSymbol;
}

/** The `FORMS_AnimFrameStrc[5]` table whose slot 1 holds `&DC6_...amnu2`. */
function makeTable(): AnalyzedDataSymbol {
  return {
    name: 'gaCharSelectAnimFramesAmazon',
    address: '00708af0',
    size: 80,
    dataType: 'FORMS_AnimFrameStrc[5]',
    scope: 'global',
    isInitialized: true,
    initializedData: {
      kind: 'array',
      elements: [
        {
          kind: 'struct',
          fields: [
            { name: 'ppBaseImage', value: { kind: 'pointer', value: 'DC6_FrontEnd_amazon_amnu2' } },
          ],
        },
      ],
    },
    referencingFunctions: [],
  } as unknown as AnalyzedDataSymbol;
}

const funcToImpl = new Map([['IMAGE_LoadPredefinedImagesEx', 'D2Launch/MainMenus.cpp']]);

describe('a symbol a global initializer names keeps external linkage', () => {
  it('does not statify a target whose address a table takes', () => {
    const target = makeTarget();
    const globals = [makeTable(), target];

    computeFileLocalGlobals(globals, funcToImpl);

    assert.strictEqual(target.scope, 'global',
      'DC6_FrontEnd_amazon_amnu2 is named by gaCharSelectAnimFramesAmazon; ' +
      'a `static` in MainMenus.cpp is a second object under the same name');
    assert.strictEqual(target.ownerFile, undefined);
  });

  it('still statifies an identical symbol no initializer names', () => {
    const target = makeTarget({ name: 'gpDC6NobodyPointsAtMe' });
    computeFileLocalGlobals([makeTable(), target], funcToImpl);

    assert.strictEqual(target.scope, 'file-local',
      'the promotion must still fire where it is safe — the veto is the ' +
      'address-taken test, not a blanket refusal');
    assert.strictEqual(target.ownerFile, 'D2Launch/MainMenus.cpp');
  });

  it('sees a namespace-qualified initializer spelling', () => {
    const target = makeTarget();
    const table = makeTable();
    (table.initializedData as { elements: Array<{ fields: Array<{ value: { value: string } }> }> })
      .elements[0].fields[0].value.value = 'D2Launch::MainMenus::DC6_FrontEnd_amazon_amnu2';

    computeFileLocalGlobals([table, target], funcToImpl);
    assert.strictEqual(target.scope, 'global');
  });

  it('collects the leading identifier of an interior reference', () => {
    const names = collectInitializerReferencedNames([makeTable()]);
    assert.ok(names.has('DC6_FrontEnd_amazon_amnu2'));
  });

  it('promotes a file-local back, not just a function-local static', () => {
    // The stage-2 net, for anything a later pass demotes: both internal-linkage
    // classes have to come back, because the globals unit names the symbol at
    // namespace scope either way.
    const fileLocal = makeTarget({ scope: 'file-local', ownerFile: 'D2Launch/MainMenus.cpp' });
    const staticLocal = makeTarget({
      name: 'gaUnitSoundTableModeChange', address: '006fd0b0',
      scope: 'static-local', ownerFunction: 'UNIT_PlaySound',
    });
    const table = makeTable();
    (table.initializedData as { elements: Array<{ fields: Array<{ value: { value: string } }> }> })
      .elements[0].fields.push({ value: { kind: 'pointer', value: 'gaUnitSoundTableModeChange' } } as never);

    const n = promoteInitializerReferencedGlobals([table, fileLocal, staticLocal]);

    assert.strictEqual(n, 2);
    assert.strictEqual(fileLocal.scope, 'global');
    assert.strictEqual(fileLocal.ownerFile, undefined);
    assert.strictEqual(staticLocal.scope, 'global');
    assert.strictEqual(staticLocal.ownerFunction, undefined);
  });
});
