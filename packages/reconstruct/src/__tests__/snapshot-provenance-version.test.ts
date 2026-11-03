/**
 * A snapshot names the Ghidra version its reads came from. The local worker opens one
 * version and reads only that one; the server's latest, asked when the snapshot is written,
 * can already be the next check-in. A full extraction labelled "1860" printed eleven
 * functions as they were before v1860, and a correct live model looked stale in all of
 * them when compared with it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { captureProvenance, openedProgramVersion } from '../index.js';
import type { GhidraConnection } from '../types.js';

function connection(opened: { version: number; latest: number } | null, serverVersion: number): GhidraConnection {
  return {
    sessionId: 'test',
    async sendCommand<T>(command: string): Promise<T> {
      if (command === 'get_program_version') {
        if (!opened) throw new Error('Unknown tool: get_program_version');
        return opened as T;
      }
      if (command === 'list_programs') {
        return { programs: [{ name: 'Game.exe', path: '/windows/lod/1.14d/Game.exe', contentType: 'Program', version: serverVersion }] } as T;
      }
      throw new Error(`Unknown tool: ${command}`);
    },
    async close() {},
  } as never;
}

const info = { name: 'Game.exe' } as never;
const PROJECT = 'ghidra://ghidra.typeguru.nl:13100/Diablo2Lod';
const PROGRAM = '/windows/lod/1.14d/Game.exe';

describe('snapshot provenance version', () => {
  it('names the version the worker read, and says the server moved on', async () => {
    const p = await captureProvenance(connection({ version: 1859, latest: 1860 }, 1860), PROJECT, PROGRAM, info);
    assert.equal(p.programVersion, 1859);
    assert.match(p.programVersionError ?? '', /read from v1859; the server was at v1860/);
  });

  it('agrees with the server when nothing was checked in during the run', async () => {
    const p = await captureProvenance(connection({ version: 1861, latest: 1861 }, 1861), PROJECT, PROGRAM, info);
    assert.equal(p.programVersion, 1861);
    assert.equal(p.programVersionError, undefined);
  });

  it('falls back to the server listing where the worker cannot say (the cloud daemon)', async () => {
    assert.equal(await openedProgramVersion(connection(null, 1860)), null);
    const p = await captureProvenance(connection(null, 1860), PROJECT, PROGRAM, info);
    assert.equal(p.programVersion, 1860);
  });
});
