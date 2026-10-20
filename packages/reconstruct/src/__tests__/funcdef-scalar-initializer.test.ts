/**
 * A 4-byte function-pointer global's value is a function address. The three AppMode
 * run pointers (PTR_fAPPMODE_*_ReturnAppMode_Caller) were initialised with the raw
 * 1.14d address `(fnAppModeRun)0x0044b430`, which nothing relocates.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { renderGlobalScalarInitializer, setInitializerFunctionAddresses, setKnownFuncDefTypedefs, setInitializerAddressTable, setInitializerOwnerAddress } from '../codegen/globals-header.js';

describe('renderGlobalScalarInitializer: a funcdef slot holding a function address', () => {
  it('names the function', () => {
    setKnownFuncDefTypedefs(['fnAppModeRun']);
    setInitializerAddressTable({ globalAddresses: {}, stringConstantNames: [], referenceableNames: new Set(), imageBase: 0x400000 });
    setInitializerOwnerAddress('0070ee0c');
    setInitializerFunctionAddresses(new Map([[0x0044b430n, { name: 'fAPPMODE_client_ReturnAppMode_Caller', namespaceSegments: ['D2Client', 'ClientModeInGame'] }]]));
    const out = renderGlobalScalarInitializer('0044b430', 'fnAppModeRun *');
    assert.ok(out.includes('fAPPMODE_client_ReturnAppMode_Caller') && !out.includes('0x0044b430'), out);
    assert.strictEqual(renderGlobalScalarInitializer('00000000', 'fnAppModeRun *').includes('0x'), true);
    setInitializerFunctionAddresses(undefined);
    setInitializerOwnerAddress(undefined);
    setInitializerAddressTable(undefined);
  });
});
