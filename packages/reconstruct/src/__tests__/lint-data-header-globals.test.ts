/**
 * The lint's global table reads every extern a user TU can see: globals.h, at the top
 * level and inside namespace blocks, and each `<TU>.data.h` a homed global is declared
 * in. A global another TU defines is no longer in globals.h, so a check that resolves
 * a name to its declared type (scalar-extent-passed, adjacent-scalar-run) went blind to
 * it in every user TU.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ALL_CHECKS, buildSnapshot, parseSource, runChecks, treeFromFiles } from '../lint/index.js';
import type { SnapshotGlobal } from '../lint/snapshot.js';

const globalsH = `#pragma once
extern int gnRoot;
namespace D2Client::Draw::Weather {
extern int gnNamespaced;
} // namespace D2Client::Draw::Weather
`;
const dataH = `#pragma once
namespace Bnclient::SRP {
extern uint8_t g_srpSalt;
extern int gnNamespaced;
} // namespace Bnclient::SRP
`;
const user = `#include "globals/globals.h"
#include "Bnclient/SRP.data.h"
void SRP_Fill() {
    Storm::Source::SMemCopy(&g_srpSalt, gaSource, 0x40);
}
`;

describe('lint globals: data headers and namespace blocks', () => {
  const files = [parseSource('globals/globals.h', globalsH), parseSource('Bnclient/SRP.data.h', dataH), parseSource('Bnclient/net_sid.cpp', user)];
  for (const f of files) assert.deepStrictEqual(f.parseErrors, [], `${f.path} did not parse`);
  const tree = treeFromFiles('/nonexistent', files);

  it('collects top-level, namespaced and data-header externs; globals.h wins a shared name', () => {
    assert.ok(tree.globals.has('gnRoot'));
    assert.ok(tree.globals.has('g_srpSalt'));
    assert.strictEqual(tree.globals.get('gnNamespaced')!.line, 4, 'the globals.h declaration, read first');
  });

  it('sees a scalar declared in a data header handed to a copy with a larger count', () => {
    const globals: SnapshotGlobal[] = [
      { name: 'g_srpSalt', addressText: '00882640', size: 1, xrefCount: 1, dataType: 'byte' } as SnapshotGlobal,
      { name: 'gNext', addressText: '00882660', size: 4, xrefCount: 1, dataType: 'int' } as SnapshotGlobal,
    ];
    const functions = [{ name: 'SMemCopy', address: '00401000', namespace: 'Storm::Source', parameters: [
      { name: 'pDest', ordinal: 0 }, { name: 'pSrc', ordinal: 1 }, { name: 'nSize', ordinal: 2 }] }];
    const snap = buildSnapshot('', globals, [], undefined, () => functions as any);
    const r = runChecks(tree, snap, [ALL_CHECKS.find(c => c.id === 'scalar-extent-passed')!]);
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.findings.map(f => f.subject), ['g_srpSalt']);
  });
});
