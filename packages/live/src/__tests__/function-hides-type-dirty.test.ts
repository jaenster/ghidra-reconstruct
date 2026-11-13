/**
 * Whether a function hides a type is decided across units: the function lives in
 * one unit, the type is spelled (`struct ::D2WinImageEx`) in every unit that names
 * it. So a change that starts or stops the hiding must re-emit every unit that
 * spells the type, even one that never calls the function.
 *
 * The selection is name-keyed: a function whose hash moved puts its old and new
 * NAMES into the changed set, and a unit's dependency edge to the type carries the
 * same name. These tests pin that the coincidence the hiding rule relies on holds.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { selectDirtyUnits, computeHashCache } from '../dirty-units.js';
import type { ExtractedDataType, ExtractedFunction } from '@ghidra-mcp/reconstruct';

const fn = (address: string, name: string, namespace: string): ExtractedFunction =>
  ({ address, name, namespace, signature: `void ${name}(void)`, returnType: 'D2WinImageEx *', parameters: [], decompiled: `void ${name}(void) {}` } as unknown as ExtractedFunction);

const type = (name: string): ExtractedDataType =>
  ({ name, kind: 'STRUCTURE', size: 8, category: '/Diablo2/UI', fields: [] } as unknown as ExtractedDataType);

const buildInfo = {
  symbolIndex: {},
  symbolHashes: { x: 'x' },
  modules: [
    {
      id: 'D2Win/Src/D2WinImage.h', implPath: 'D2Win/Src/D2WinImage.cpp', unitName: 'D2Win::Src::D2WinImage',
      functionNames: ['D2WinImageEx_Make', 'D2WinImageEx'], ownedTypeNames: [], globalAddresses: [],
      deps: [{ symbol: 'D2WinImageEx', strength: 'type-ref' }],
    },
    {
      // Spells the type, never calls the function.
      id: 'D2Launch/CharSel.h', implPath: 'D2Launch/CharSel.cpp', unitName: 'D2Launch::CharSel',
      functionNames: ['CHARSEL_Draw'], ownedTypeNames: [], globalAddresses: [],
      deps: [{ symbol: 'D2WinImageEx', strength: 'type-ref' }],
    },
    {
      id: 'D2Launch/Other.h', implPath: 'D2Launch/Other.cpp', unitName: 'D2Launch::Other',
      functionNames: ['OTHER_Run'], ownedTypeNames: [], globalAddresses: [], deps: [],
    },
  ],
};

const others = [fn('00402000', 'CHARSEL_Draw', 'D2Launch::CharSel'), fn('00403000', 'OTHER_Run', 'D2Launch::Other')];
const select = (before: ExtractedFunction[], after: ExtractedFunction[], typesBefore = [type('D2WinImageEx')], typesAfter = typesBefore) =>
  selectDirtyUnits({
    buildInfo,
    previous: computeHashCache({ functions: before, dataTypes: typesBefore, globals: [] }),
    identCacheEmpty: false,
    functions: after,
    dataTypes: typesAfter,
    globals: [],
  }).units?.slice().sort() ?? null;

test('a function renamed to the type it returns re-emits every unit that spells the type', () => {
  const units = select(
    [fn('004fd770', 'D2WinImageEx_Make', 'D2Win::Src::D2WinImage'), ...others],
    [fn('004fd770', 'D2WinImageEx', 'D2Win::Src::D2WinImage'), ...others],
  );
  assert.deepStrictEqual(units, ['D2Launch::CharSel', 'D2Win::Src::D2WinImage']);
});

test('a function renamed away from the type re-emits them too', () => {
  const units = select(
    [fn('004fd770', 'D2WinImageEx', 'D2Win::Src::D2WinImage'), ...others],
    [fn('004fd770', 'D2WinImageEx_Make', 'D2Win::Src::D2WinImage'), ...others],
  );
  assert.deepStrictEqual(units, ['D2Launch::CharSel', 'D2Win::Src::D2WinImage']);
});

test('a hiding function moved to another namespace re-emits them', () => {
  const units = select(
    [fn('004fd770', 'D2WinImageEx', 'D2Win::Forms::D2WinImageEx'), ...others],
    [fn('004fd770', 'D2WinImageEx', 'D2Win::Src::D2WinImage'), ...others],
  );
  // A namespace move re-emits every unit (null), which includes CharSel.
  assert.strictEqual(units, null, JSON.stringify(units));
});

test('the hidden type renamed re-emits every unit that spelled it', () => {
  const functions = [fn('004fd770', 'D2WinImageEx', 'D2Win::Src::D2WinImage'), ...others];
  const units = select(functions, functions, [type('D2WinImageEx')], [type('D2WinImageExStrc')]);
  assert.ok(units?.includes('D2Launch::CharSel'), JSON.stringify(units));
  assert.ok(!units?.includes('D2Launch::Other'), JSON.stringify(units));
});
