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

import { extractStructures } from './types.js';
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
