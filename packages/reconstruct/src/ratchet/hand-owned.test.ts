import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { advance, readAudit } from './advance.js';
import { handFailures, ratchetMerge } from './merge.js';
import { applyRecords, capture } from './ratchet.js';
import { RatchetStore, isHandOwned, migrateHandOwner, withHandOwner, type RatchetRecord } from './store.js';
import { SymbolIndex, memoryTree } from './symbol-index.js';

const HEADER = `#pragma once
struct D2UnitStrc {
    /* 0x00 */ int nType;
    /* 0x04 */ int nClassId;
};
namespace Game::Unit {
int __stdcall GetLevel(struct D2UnitStrc * pUnit, int nStat); // 1.14d: 00401000
}
`;

/** GetLevel with `nStat` of type `statType`, its body `expr`. */
function unit(expr: string, statType = 'int'): string {
  return `#include "Unit.h"
namespace Game::Unit {

// 1.14d: 00401000
int __stdcall GetLevel(struct D2UnitStrc * pUnit, ${statType} nStat) {
    return ${expr};
}

} // namespace Game::Unit
`;
}

const HAND = 'pUnit->nClassId + nStat';
const GENERATED = 'nStat + pUnit->nClassId';

function index(unitText: string, header = HEADER): SymbolIndex {
  return SymbolIndex.build(memoryTree(new Map([['Source/G/Unit.h', header], ['Source/G/Unit.cpp', unitText]])));
}

function handPin(ix: SymbolIndex, evidence = 'ev0'): RatchetRecord {
  const c = capture(ix, '00401000', 'pin', evidence, { closure: false, hand: true });
  assert.ok(c.record, c.error);
  return c.record!;
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('ratchet: hand-owned pins', () => {
  it('captures a pin as hand-owned, the owner right after the kind', () => {
    const rec = handPin(index(unit(HAND)));
    assert.equal(rec.owner, 'hand');
    assert.ok(isHandOwned(rec));
    assert.deepEqual(Object.keys(rec).slice(0, 3), ['address', 'kind', 'owner']);
  });

  it('survives a generated body that becomes equal: never released, the record stays', () => {
    const ix = index(unit(HAND));
    const rec = handPin(ix);
    const out = applyRecords(ix, [rec]);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].status, 'equal');
    assert.equal(out.rows[0].hand, true);
    assert.equal(out.changed.size, 0);

    // The measurement after it: MATCH, equal to the generator, and the record is still there.
    const dir = tempDir('ratchet-hand-');
    try {
      const store = new RatchetStore(dir);
      store.put(rec);
      const rows = advance(ix, store, readAudit('address\tname\tstatus\n00401000\tGame::Unit::GetLevel\tMATCH\n'), 'ev1');
      assert.deepEqual(rows.map(r => r.status), ['pin']);
      assert.deepEqual(store.get('00401000'), rec);
      // Not when it stops matching either.
      advance(ix, store, readAudit('address\tname\tstatus\n00401000\tGame::Unit::GetLevel\tOUR+3\n'), 'ev2');
      assert.deepEqual(store.get('00401000'), rec);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps its body over a different generated one, and a source-map tag does not release it', () => {
    const rec = handPin(index(unit(HAND)));
    const gen = index(unit(GENERATED));
    const tagged = applyRecords(gen, [rec], { releases: new Set(['00401000']), releaseRows: new Set() });
    assert.equal(tagged.rows[0].status, 'pinned');
    assert.match(tagged.changed.get('Source/G/Unit.cpp')!, /pUnit->nClassId \+ nStat/u);
  });

  it('leaves only through a release.tsv row: the generated body goes through, the next measurement removes it', () => {
    const rec = handPin(index(unit(HAND)));
    const gen = index(unit(GENERATED));
    const released = applyRecords(gen, [rec], { releases: new Set(['00401000']) });
    assert.equal(released.rows[0].status, 'released');
    assert.equal(released.changed.size, 0);

    const dir = tempDir('ratchet-hand-');
    try {
      const store = new RatchetStore(dir);
      store.put(rec);
      store.writeReleases([{ address: '00401000', reason: 'the generator emits it now' }]);
      const rows = advance(gen, store, readAudit('address\tname\tstatus\n00401000\tGame::Unit::GetLevel\tOUR+1\n'), 'ev1');
      assert.deepEqual(rows.map(r => r.status), ['retired']);
      assert.equal(store.get('00401000'), undefined);
      assert.deepEqual(store.releases(), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a hand-owned record that cannot be re-spelled as a merge failure, a legacy pin not', () => {
    const rec = handPin(index(unit(HAND)));
    const retyped = index(unit(GENERATED, 'char *'));
    const out = applyRecords(retyped, [rec]);
    assert.equal(out.rows[0].status, 'unresolved');
    assert.match(out.rows[0].detail, /parameter 1 retyped: int -> char \*/u);
    assert.deepEqual(handFailures(out.rows).map(r => r.address), ['00401000']);

    const { owner: _o, ...legacy } = rec;
    const old = applyRecords(retyped, [legacy as RatchetRecord]);
    assert.equal(old.rows[0].status, 'unresolved');
    assert.deepEqual(handFailures(old.rows), []);
  });
});

describe('ratchet: migrating pins to hand-owned', () => {
  it('marks every pin, keeps every other field and every match record, and is idempotent', () => {
    const ix = index(unit(HAND));
    const dir = tempDir('ratchet-own-');
    try {
      const store = new RatchetStore(dir);
      const { owner: _o, ...legacy } = handPin(ix);
      const pin = { ...legacy, note: 'why it exists', dh: 'abc' } as RatchetRecord;
      store.put(pin);
      const match = capture(ix, '00401000', 'match', 'ev0').record!;
      const matchAt = { ...match, address: '00402000', members: match.members.map(m => ({ ...m, address: '00402000' })) };
      store.put(matchAt);
      const before = fs.readFileSync(store.recordPath('00402000'), 'utf-8');

      const first = migrateHandOwner(store);
      assert.deepEqual(first, { changed: ['00401000'], already: 0 });
      const migrated = store.get('00401000')!;
      assert.deepEqual(migrated, { ...pin, owner: 'hand' });
      assert.deepEqual(Object.keys(migrated).slice(0, 3), ['address', 'kind', 'owner']);
      assert.equal(fs.readFileSync(store.recordPath('00402000'), 'utf-8'), before);

      const afterFirst = fs.readFileSync(store.recordPath('00401000'), 'utf-8');
      const second = migrateHandOwner(store);
      assert.deepEqual(second, { changed: [], already: 1 });
      assert.equal(fs.readFileSync(store.recordPath('00401000'), 'utf-8'), afterFirst);
      assert.deepEqual(withHandOwner(migrated), migrated);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ratchet merge: Gate A', () => {
  const cfg = ['commit.gpgsign=false', 'user.name=ratchet test', 'user.email=ratchet@test.invalid', 'init.defaultBranch=main'];
  const git = (dir: string, ...args: string[]) => {
    const r = spawnSync('git', [...cfg.flatMap(c => ['-c', c]), '-C', dir, ...args], { encoding: 'utf-8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (dir: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text, 'utf-8');
  };

  /** A repo whose main carries the hand body and a store with its pin, and a regen branch. */
  function repo(regenUnit: string, owner: boolean): { dir: string; head: string } {
    const dir = tempDir('ratchet-merge-');
    git(dir, 'init', '-q');
    write(dir, 'Source/G/Unit.h', HEADER);
    write(dir, 'Source/G/Unit.cpp', unit(GENERATED));
    git(dir, 'add', '--', 'Source');
    git(dir, 'commit', '-q', '-m', 'regen 1');
    git(dir, 'branch', 'regen');
    write(dir, 'Source/G/Unit.cpp', unit(HAND));
    const rec = handPin(index(unit(HAND)), git(dir, 'rev-parse', '--short=9', 'HEAD'));
    if (!owner) delete rec.owner;
    new RatchetStore(path.join(dir, 'ratchet')).put(rec);
    git(dir, 'add', '--', 'Source', 'ratchet');
    git(dir, 'commit', '-q', '-m', 'hand body');
    git(dir, 'checkout', '-q', 'regen');
    write(dir, 'Source/G/Unit.cpp', regenUnit);
    git(dir, 'add', '--', 'Source');
    git(dir, 'commit', '-q', '-m', 'regen 2');
    git(dir, 'checkout', '-q', 'main');
    return { dir, head: git(dir, 'rev-parse', 'HEAD') };
  }

  it('fails and aborts the merge when a hand-owned body cannot be re-spelled', () => {
    const { dir, head } = repo(unit(GENERATED, 'char *'), true);
    try {
      const r = ratchetMerge(dir, 'regen', { gitConfig: cfg });
      assert.equal(r.state, 'unresolved');
      assert.match(r.message ?? '', /00401000 Game::Unit::GetLevel unresolved: parameter 1 retyped: int -> char \*/u);
      assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
      assert.equal(spawnSync('git', ['-C', dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD']).status, 1);
      assert.equal(git(dir, 'status', '--porcelain'), '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges and carries the hand body when it can be re-spelled', () => {
    const { dir, head } = repo(unit(GENERATED).replace('return', '/* moved */ return'), true);
    try {
      const r = ratchetMerge(dir, 'regen', { gitConfig: cfg });
      assert.equal(r.state, 'clean', r.message);
      assert.notEqual(git(dir, 'rev-parse', 'HEAD'), head);
      assert.match(fs.readFileSync(path.join(dir, 'Source/G/Unit.cpp'), 'utf-8'), /return pUnit->nClassId \+ nStat;/u);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets the generated body through for a hand-owned pin with a release.tsv row', () => {
    const { dir } = repo(unit(GENERATED, 'char *'), true);
    try {
      new RatchetStore(path.join(dir, 'ratchet')).writeReleases([{ address: '00401000', reason: 'test' }]);
      git(dir, 'add', '--', 'ratchet');
      git(dir, 'commit', '-q', '-m', 'release');
      const r = ratchetMerge(dir, 'regen', { gitConfig: cfg });
      assert.equal(r.state, 'clean', r.message);
      assert.deepEqual(r.pins.map(p => p.status), ['released']);
      assert.match(fs.readFileSync(path.join(dir, 'Source/G/Unit.cpp'), 'utf-8'), /char \* nStat\) \{\n    return nStat \+ pUnit->nClassId;/u);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a legacy pin that cannot be re-spelled under #if 0 and does not fail', () => {
    const { dir } = repo(unit(GENERATED, 'char *'), false);
    try {
      const r = ratchetMerge(dir, 'regen', { gitConfig: cfg });
      assert.equal(r.state, 'clean', r.message);
      assert.match(fs.readFileSync(path.join(dir, 'Source/G/Unit.cpp'), 'utf-8'), /#if 0 \/\/ ratchet: the pin body of 00401000/u);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
