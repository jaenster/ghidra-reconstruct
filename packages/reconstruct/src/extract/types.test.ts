/**
 * Tests for data-type extraction shape guarantees.
 *
 * Codegen (buildBitfieldCatalog, computeTypeOwnership) assumes every
 * STRUCTURE/UNION carries `fields` as an array. The extractor must uphold
 * that invariant even when Ghidra returns a struct detail without a `fields`
 * property — historically that produced `fields: undefined` and crashed
 * codegen far downstream.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { extractDataTypes, extractStructures, hydrateDataTypeDetails } from './types.js';
import type { GhidraConnection, ExtractedStruct } from '../types.js';

/** A fake connection that replays a fixed command→response map. */
function fakeConnection(handler: (command: string, params?: Record<string, unknown>) => unknown): GhidraConnection {
  return {
    sessionId: 'test',
    async close() {},
    async sendCommand<T>(command: string, params?: Record<string, unknown>): Promise<T> {
      return handler(command, params) as T;
    },
  };
}

describe('extractStructures field invariant', () => {
  it('defaults fields to [] when the struct detail omits fields', async () => {
    const conn = fakeConnection((command) => {
      if (command === 'list_data_types') {
        return {
          dataTypes: [{ name: 'D2EmptyStrc', category: '/D2', length: 8, type: 'Structure' }],
          total: 1,
        };
      }
      if (command === 'get_data_type') {
        // Detail with NO `fields` key — the exact shape that used to crash codegen.
        return { name: 'D2EmptyStrc', category: '/D2', length: 8, type: 'Structure' };
      }
      throw new Error(`unexpected command ${command}`);
    });

    const structs = await extractStructures(conn);
    assert.equal(structs.length, 1);
    const s = structs[0] as ExtractedStruct;
    assert.ok(Array.isArray(s.fields), 'fields must be an array');
    assert.deepEqual(s.fields, []);
  });

  it('preserves fields when the detail provides them', async () => {
    const conn = fakeConnection((command) => {
      if (command === 'list_data_types') {
        return {
          dataTypes: [{ name: 'D2PointStrc', category: '/D2', length: 8, type: 'Structure' }],
          total: 1,
        };
      }
      if (command === 'get_data_type') {
        return {
          name: 'D2PointStrc',
          category: '/D2',
          length: 8,
          type: 'Structure',
          fields: [
            { name: 'x', dataType: 'int', offset: 0, size: 4 },
            { name: 'y', dataType: 'int', offset: 4, size: 4 },
          ],
        };
      }
      throw new Error(`unexpected command ${command}`);
    });

    const structs = await extractStructures(conn);
    assert.equal(structs.length, 1);
    assert.equal(structs[0].fields.length, 2);
    assert.equal(structs[0].fields[0].name, 'x');
  });
});

/**
 * A shallow listing entry carries no members. When the detail fetch that is
 * supposed to replace it fails — `get_data_type` for the 60,023-component
 * `D2GameViewStrc` returns ~5 MB and outran the RPC timeout on a loaded daemon —
 * the entry survived with `fields: []` and nothing said so. Codegen then emitted
 * `struct D2GameViewStrc {};`, which compiles and costs 123 errors at the member
 * accesses. The hole has to be visible.
 */
describe('a failed type-detail fetch is a hole, not an empty type', () => {
  const listing = {
    dataTypes: [
      { name: 'D2GameViewStrc', category: '/Diablo2', length: 60092, type: 'Structure' },
      { name: 'D2PointStrc', category: '/D2', length: 8, type: 'Structure' },
    ],
    total: 2,
  };

  it('throws, naming the type, when the detail never arrives', async () => {
    const conn = fakeConnection((command, params) => {
      if (command === 'list_data_types') return listing;
      if (command === 'get_data_type') {
        if (params?.name === 'D2GameViewStrc') {
          throw new Error('The operation was aborted due to timeout');
        }
        return {
          name: 'D2PointStrc', category: '/D2', length: 8, type: 'Structure',
          fields: [{ name: 'x', dataType: 'int', offset: 0, size: 4 }],
        };
      }
      throw new Error(`unexpected command ${command}`);
    });

    const types = await extractDataTypes(conn, { limit: 10 });
    await assert.rejects(
      () => hydrateDataTypeDetails(conn, types),
      (err: Error) => {
        assert.match(err.message, /D2GameViewStrc/);
        assert.match(err.message, /timeout/i);
        return true;
      }
    );
    const gv = types.find(t => t.name === 'D2GameViewStrc') as ExtractedStruct;
    assert.equal(gv.detailUnavailable, true, 'the hole must stay marked');
  });

  it('recovers a type whose first fetch failed and clears the mark', async () => {
    let attempts = 0;
    const conn = fakeConnection((command, params) => {
      if (command === 'list_data_types') return listing;
      if (command === 'get_data_type') {
        if (params?.name === 'D2GameViewStrc' && attempts++ === 0) {
          throw new Error('The operation was aborted due to timeout');
        }
        return {
          name: params?.name, category: params?.category, type: 'Structure',
          fields: [{ name: 'nFlags', dataType: 'undefined4', offset: 0, size: 4 }],
        };
      }
      throw new Error(`unexpected command ${command}`);
    });

    const types = await extractDataTypes(conn, { limit: 10 });
    const result = await hydrateDataTypeDetails(conn, types);
    assert.equal(result.recovered, 1);
    const gv = types.find(t => t.name === 'D2GameViewStrc') as ExtractedStruct;
    assert.equal(gv.fields.length, 1);
    assert.ok(!gv.detailUnavailable, 'a recovered type carries no hole mark');
  });

  it('clears the mark on every type it fetches', async () => {
    const conn = fakeConnection((command, params) => {
      if (command === 'list_data_types') return listing;
      if (command === 'get_data_type') {
        return {
          name: params?.name, category: params?.category, type: 'Structure',
          fields: [{ name: 'nFlags', dataType: 'undefined4', offset: 0, size: 4 }],
        };
      }
      throw new Error(`unexpected command ${command}`);
    });

    const types = await extractDataTypes(conn, { limit: 10 });
    await hydrateDataTypeDetails(conn, types);
    for (const t of types) {
      assert.ok(!t.detailUnavailable, `${t.name} still marked`);
    }
  });
});
