/**
 * The extracted size of a data type is the size the daemon actually sends.
 *
 * The worker's DTOs (`GhidraEngine.DataTypeInfo` / `DataTypeDetail`) name that
 * field `size` - both are `dt.getLength()`. The extraction read `.length`, which
 * no response carries, so EVERY extracted data type arrived with
 * `size: undefined`; the codegen snapshot on disk has no `size` on a single row.
 * That is why a 2-byte enum reached the emitter indistinguishable from a 4-byte
 * one and got `typedef int`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractDataTypes, extractDataType } from '../extract/types.js';
import type { GhidraConnection, ExtractedStruct } from '../types.js';

function stubConnection(byCommand: Record<string, unknown>): GhidraConnection {
  return {
    async sendCommand(command: string) {
      if (!(command in byCommand)) throw new Error(`unexpected command ${command}`);
      return byCommand[command];
    },
  } as unknown as GhidraConnection;
}

describe('data type size comes off the wire', () => {
  it('a listing entry keeps the `size` the worker sends', async () => {
    const conn = stubConnection({
      list_data_types: {
        total: 1,
        dataTypes: [
          // Verbatim shape of GhidraEngine.DataTypeInfo.
          { name: 'eCollisionFlags', category: '/Diablo2/COLLISION', size: 2, description: '', type: 'enum' },
        ],
      },
    });
    const [dt] = await extractDataTypes(conn);
    assert.strictEqual(dt.size, 2, 'the 2-byte enum must arrive as 2 bytes');
    assert.strictEqual(dt.kind, 'ENUM');
  });

  it('a detail keeps the `size` the worker sends', async () => {
    const conn = stubConnection({
      get_data_type: {
        name: 'eCollisionFlags',
        category: '/Diablo2/COLLISION',
        size: 2,
        alignment: 2,
        type: 'enum',
        values: [{ name: 'COLBIT_NONE', value: 0 }, { name: 'COLBIT_DEAD', value: 32768 }],
      },
    });
    const dt = await extractDataType(conn, 'eCollisionFlags', '/Diablo2/COLLISION');
    assert.strictEqual(dt.size, 2);
    assert.strictEqual(dt.kind, 'ENUM');
  });

  it('an older daemon that sends `length` still works', async () => {
    const conn = stubConnection({
      get_data_type: {
        name: 'eD2MonsterAnimMode', category: '/Diablo2/UNIT/MODE',
        length: 4, type: 'enum', values: [],
      },
    });
    const dt = await extractDataType(conn, 'eD2MonsterAnimMode');
    assert.strictEqual(dt.size, 4);
  });

  it('struct fields already carried their size and still do', async () => {
    const conn = stubConnection({
      get_data_type: {
        name: 'D2RoomCollisionGridStrc', category: '/Diablo2/DRLG', size: 38, type: 'structure',
        fields: [
          { name: 'pMapStart', dataType: 'eCollisionFlags *', offset: 0x20, size: 4, comment: '' },
          { name: 'aMap', dataType: 'eCollisionFlags[1]', offset: 0x24, size: 2, comment: '' },
        ],
      },
    });
    const dt = await extractDataType(conn, 'D2RoomCollisionGridStrc');
    assert.strictEqual(dt.size, 38);
    const fields = (dt as ExtractedStruct).fields;
    // Ghidra models one element of aMap as 2 bytes - the stride the disassembly
    // uses (`MOVZX EAX, word ptr [ECX+ESI*0x2]`).
    assert.strictEqual(fields.find(f => f.name === 'aMap')!.size, 2);
  });
});
