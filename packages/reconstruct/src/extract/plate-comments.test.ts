/**
 * A global labelled inside a larger data item (gaColorDistanceLookupTable[256] at 008e9430,
 * inside the squares table that starts at 008e9030) has a plate comment Ghidra holds at its
 * address, but no code unit of its own. `list_comments` asks the code unit and skipped it,
 * so a full extraction emitted the global without its comment while the live daemon, which
 * reads `Listing.getComment` at the address, attached it. 46 such comments at v1861. The
 * full extraction reads them by script now; `list_comments` is only the fallback.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { extractAllGlobals, parsePlateComments, PLATE_COMMENT_SCRIPT } from './globals.js';
import type { GhidraConnection } from '../types.js';

const globals = [
  { name: 'gaColorDistanceLookupTable', address: '008e9030', dataType: 'int[512]', size: 2048 },
  { name: 'gaColorDistanceLookupTable[256]', address: '008e9430', dataType: 'int[512]', size: 2048 },
  { name: 'gszDot', address: '006ccad8', dataType: 'char[2]', size: 2 },
];

function connection(script: (code: string) => unknown): GhidraConnection & { asked: string[] } {
  const asked: string[] = [];
  return {
    sessionId: 'test',
    asked,
    async sendCommand<T>(command: string, params: Record<string, unknown> = {}): Promise<T> {
      asked.push(command);
      if (command === 'list_data_symbols') return { globals: globals.slice(Number(params.offset ?? 0)), total: globals.length } as T;
      // What the worker's list_comments answers: only addresses that start a code unit.
      if (command === 'list_comments') return { comments: Number(params.offset ?? 0) > 0 ? [] : [{ address: '008e9030', comment: 'the squares table' }], total: 1 } as T;
      if (command === 'execute_script') return script(String(params.code)) as T;
      throw new Error(`unexpected ${command}`);
    },
    async close() {},
  } as never;
}

describe('global plate comments', () => {
  it('attaches the comment at an interior label, as the daemon reads it', async () => {
    const conn = connection(code => {
      if (code !== PLATE_COMMENT_SCRIPT) return { success: true, output: '' };
      return {
        success: true,
        output: 'Game.exe.ram:008e9030\tthe squares table\n' +
          '008e9430\tthe ZERO ELEMENT of a signed-index table:\\n(&gaColorDistanceLookup)[i] = i*i, tab\\there, slash \\\\\n',
      };
    });
    const got = await extractAllGlobals(conn);
    assert.deepStrictEqual(got.map(g => [g.address, g.comment]), [
      ['008e9030', 'the squares table'],
      ['008e9430', 'the ZERO ELEMENT of a signed-index table:\n(&gaColorDistanceLookup)[i] = i*i, tab\there, slash \\'],
      ['006ccad8', undefined],
    ]);
    assert.ok(!conn.asked.includes('list_comments'));
  });

  it('falls back to list_comments when the script cannot run', async () => {
    const conn = connection(code => code === PLATE_COMMENT_SCRIPT ? { success: false, error: 'scripts disabled' } : { success: true, output: '' });
    const got = await extractAllGlobals(conn);
    assert.deepStrictEqual(got.map(g => g.comment), ['the squares table', undefined, undefined]);
    assert.ok(conn.asked.includes('list_comments'));
  });

  it('parses escapes and skips malformed rows', () => {
    const m = parsePlateComments('0089db90\tA\\nB\\r\\tC\\\\D\nnot an address\tx\n\n006ccaf4\t\n');
    assert.deepStrictEqual([...m], [['0089db90', 'A\nB\r\tC\\D']]);
  });
});
