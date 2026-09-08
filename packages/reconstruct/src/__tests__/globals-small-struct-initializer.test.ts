/**
 * A struct global of four bytes or fewer must have its .data bytes fetched.
 *
 * Ghidra returns a scalar `value` for a scalar datum but NOTHING for a composite,
 * so a small struct used to fall between the two: no scalar value, no fetched
 * bytes, and the renderer turned it into `= {}`. That is not a missing
 * initializer but a WRONG one - real .data replaced by zeroes, in code that still
 * compiles and links.
 *
 * `g_InventorySizesDefaultConfig` @0x7447b4 is the case that cost a crash: a
 * 2-byte D2InventorySizesStrc holding the belt grid {16, 1}. Emitted as {0, 0} it
 * made the grid allocation zero-length, so every belt item restored from a save
 * wrote past it and corrupted the pool the inventory's update list also lives in.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fetchInitializedData } from '../extract/globals.js';
import type { AnalyzedDataSymbol } from '../types.js';

function symbol(over: Partial<AnalyzedDataSymbol>): AnalyzedDataSymbol {
  return {
    name: 'g', address: '0x1000', dataType: 'int', size: 4,
    isInitialized: true, xrefCount: 1, scope: 'global',
    ...over,
  } as AnalyzedDataSymbol;
}

/** Records which addresses were asked for, and answers with a struct value. */
function recordingConnection(asked: string[]) {
  return {
    sendCommand: async (_cmd: string, args: { address: string }) => {
      asked.push(args.address);
      return { value: { kind: 'struct', fields: [
        { name: 'Width', value: { kind: 'scalar', value: '0x10' } },
        { name: 'Height', value: { kind: 'scalar', value: '0x1' } },
      ] } };
    },
  } as never;
}

describe('small struct globals', () => {
  it('fetches .data for a 2-byte struct global', async () => {
    const asked: string[] = [];
    const g = symbol({ name: 'g_InventorySizesDefaultConfig', address: '0x7447b4',
                       dataType: 'D2InventorySizesStrc', size: 2 });
    await fetchInitializedData(recordingConnection(asked), [g]);
    assert.deepEqual(asked, ['0x7447b4'], 'the 2-byte struct must be fetched');
    assert.ok(g.initializedData, 'its bytes must be attached to the symbol');
  });

  it('still skips a genuinely tiny SCALAR, whose value Ghidra already gives', async () => {
    const asked: string[] = [];
    const g = symbol({ name: 'gnCount', dataType: 'int', size: 4, value: '0x5' });
    await fetchInitializedData(recordingConnection(asked), [g]);
    assert.deepEqual(asked, [], 'scalars must not be fetched');
    assert.equal(g.initializedData, undefined);
  });

  it('still skips a pointer, which is not a struct', async () => {
    const asked: string[] = [];
    const g = symbol({ name: 'pThing', dataType: 'D2UnitStrc *', size: 4 });
    await fetchInitializedData(recordingConnection(asked), [g]);
    assert.deepEqual(asked, []);
  });

  it('still skips uninitialised .bss and anything over the 64KB cap', async () => {
    const asked: string[] = [];
    await fetchInitializedData(recordingConnection(asked), [
      symbol({ dataType: 'D2InventorySizesStrc', size: 2, isInitialized: false }),
      symbol({ dataType: 'D2BigStrc', size: 64 * 1024 + 1 }),
    ]);
    assert.deepEqual(asked, []);
  });

  it('still fetches large aggregates, as it always did', async () => {
    const asked: string[] = [];
    const g = symbol({ name: 'aTable', address: '0x2000', dataType: 'int[16]', size: 64 });
    await fetchInitializedData(recordingConnection(asked), [g]);
    assert.deepEqual(asked, ['0x2000']);
  });
});
