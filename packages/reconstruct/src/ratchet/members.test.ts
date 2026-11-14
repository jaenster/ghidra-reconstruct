import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { advance, readAudit } from './advance.js';
import { formatFreshBodies } from './generator.js';
import { readFreshBodies, releaseNonMatchMembers, type TrialCompiler, type UnitTrial } from './members.js';
import { applyRecords, capture } from './ratchet.js';
import { RatchetStore, bodyHash } from './store.js';
import { SymbolIndex, memoryTree } from './symbol-index.js';

const HEADER = `#pragma once
struct D2UnitStrc {
    /* 0x00 */ int nType;
    /* 0x04 */ int nClassId;
};
namespace Game::Unit {
void __fastcall Award(struct D2UnitStrc * pUnit, int nXp); // 1.14d: 00401100
void __fastcall Bonus(struct D2UnitStrc * pUnit, int nXp); // 1.14d: 00401200
}
`;

/** Award (MATCH) and Bonus call the file-static GetLevel (not MATCH) and Scale (not MATCH). */
const UNIT = `#include "Unit.h"
namespace Game::Unit {

// 1.14d: 00401000
static int __stdcall GetLevel(struct D2UnitStrc * pUnit, int nStat) {
    return pUnit->nClassId + nStat;
}

// 1.14d: 00401050
static int __stdcall Scale(struct D2UnitStrc * pUnit, int nStat) {
    return pUnit->nType * nStat;
}

// 1.14d: 00401100
void __fastcall Award(struct D2UnitStrc * pUnit, int nXp) {
    int nLevel = GetLevel(pUnit, 12) + Scale(pUnit, 2);
    pUnit->nType = nXp + nLevel;
}

// 1.14d: 00401200
void __fastcall Bonus(struct D2UnitStrc * pUnit, int nXp) {
    pUnit->nType = GetLevel(pUnit, nXp);
}

} // namespace Game::Unit
`;

const FILE = 'Source/G/Unit.cpp';
const OLD_LEVEL = 'return pUnit->nClassId + nStat;';
const NEW_LEVEL = 'int n = nStat;\n    return pUnit->nClassId + n;';
const OLD_SCALE = 'return pUnit->nType * nStat;';
const NEW_SCALE = 'return nStat * pUnit->nType;';

function tree(unit: string): SymbolIndex {
  return SymbolIndex.build(memoryTree(new Map([['Source/G/Unit.h', HEADER], [FILE, unit]])));
}

function auditOf(st: Record<string, string>) {
  const rows = Object.entries(st).map(([a, s]) => `${a}\t0\tf${a}\tSource/G/Unit\tm\t1\t1\t0\t1\t${s}`);
  return readAudit(`start\tend\tname\ttu\tmethod\tref_insns\tour_insns\tbyte_diffs\tsimilarity\tstatus\n${rows.join('\n')}\n`);
}

/**
 * A fake VC8: the unchanged unit gives `base`; a trial gives `base` overridden by `effect`
 * of every edited member (the address whose kept body the edit replaces).
 */
class FakeCompiler implements TrialCompiler {
  calls: UnitTrial[][] = [];
  constructor(readonly base: Record<string, string>, readonly effect: (edited: Set<string>) => Record<string, string>) {}
  async compile(trials: UnitTrial[]) {
    this.calls.push(trials);
    return trials.map(t => {
      const edited = new Set<string>();
      for (const e of t.edits) {
        if (e.from.includes(OLD_LEVEL)) edited.add('00401000');
        if (e.from.includes(OLD_SCALE)) edited.add('00401050');
      }
      return { statuses: new Map(Object.entries({ ...this.base, ...this.effect(edited) })) };
    });
  }
}

/** A store with Award's record, the measured tree (the kept bodies) and the regen's fresh bodies. */
function setup(fresh: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-members-'));
  const store = new RatchetStore(dir);
  const measured = tree(UNIT);
  const c = capture(measured, '00401100', 'match', 'ev1');
  assert.deepStrictEqual(c.record!.members.map(m => m.address), ['00401100', '00401000', '00401050']);
  store.put(c.record!);
  store.writeReleases([]);
  // The regen: the generator's bodies, with the ratchet keeping the record's members.
  const regen = applyRecords(tree(fresh), store.list());
  const bodies = readFreshBodies(formatFreshBodies(regen.rows));
  return { dir, store, measured, bodies, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const NONMATCH = { '00401000': 'OUR-1', '00401050': 'OUR-2', '00401100': 'MATCH', '00401200': 'OUR-3' };

describe('ratchet: releasing non-MATCH closure members', () => {
  it('releases a member when its record stays MATCH with the generated body, and records why', async () => {
    const s = setup(UNIT.replace(OLD_LEVEL, NEW_LEVEL));
    try {
      assert.deepStrictEqual([...s.bodies.keys()], ['00401000'], 'the regen kept GetLevel and reports its generated body');
      const cc = new FakeCompiler(NONMATCH, () => ({}));
      const rows = await releaseNonMatchMembers(s.measured, s.store, auditOf(NONMATCH), { fresh: s.bodies, compiler: cc, evidence: 'ev1' });
      const r = rows.find(x => x.address === '00401000')!;
      assert.strictEqual(r.status, 'released');
      assert.strictEqual(r.verified, 'compile');
      assert.strictEqual(r.holders, '00401100:MATCH->MATCH');
      assert.strictEqual(rows.find(x => x.address === '00401050')!.status, 'equal');
      const rel = s.store.releases();
      assert.strictEqual(rel.length, 1);
      assert.strictEqual(rel[0].address, '00401000');
      assert.strictEqual(rel[0].body, bodyHash(s.bodies.get('00401000')!));
      assert.match(rel[0].reason, /non-MATCH member \(OUR-1\) of 00401100: it stays MATCH with its generated body \(VC8 trial at evidence ev1\)/u);
      assert.match(fs.readFileSync(path.join(s.dir, 'release.tsv'), 'utf-8'), /^00401000\tnon-MATCH member .*\tbody=[0-9a-f]{16}$/mu);
      // One round: the unchanged unit and the trial with the generated body.
      assert.strictEqual(cc.calls.length, 1);
      assert.deepStrictEqual(cc.calls[0].map(t => t.edits.length), [0, 1]);

      // The next regen lets exactly that body through, and no other.
      const releases = new Set(rel.map(x => x.address));
      const releaseBodies = new Map([[rel[0].address, rel[0].body!]]);
      const through = applyRecords(tree(UNIT.replace(OLD_LEVEL, NEW_LEVEL)), s.store.list(), { releases, releaseBodies });
      assert.strictEqual(through.rows.find(x => x.address === '00401000')!.status, 'released');
      assert.strictEqual(through.changed.size, 0);
      const other = applyRecords(tree(UNIT.replace(OLD_LEVEL, 'return nStat;')), s.store.list(), { releases, releaseBodies });
      const kept = other.rows.find(x => x.address === '00401000')!;
      assert.strictEqual(kept.status, 'kept');
      assert.match(kept.detail, /the release names another body/u);
    } finally {
      s.done();
    }
  });

  it('keeps a member whose generated body would cost its record the MATCH', async () => {
    const s = setup(UNIT.replace(OLD_LEVEL, NEW_LEVEL));
    try {
      const cc = new FakeCompiler(NONMATCH, e => (e.has('00401000') ? { '00401100': 'INSN_MATCH' } : {}));
      const rows = await releaseNonMatchMembers(s.measured, s.store, auditOf(NONMATCH), { fresh: s.bodies, compiler: cc, evidence: 'ev1' });
      const r = rows.find(x => x.address === '00401000')!;
      assert.strictEqual(r.status, 'kept');
      assert.match(r.detail, /loses MATCH: 00401100 MATCH->INSN_MATCH/u);
      assert.strictEqual(r.holders, '00401100:MATCH->INSN_MATCH');
      assert.deepStrictEqual(s.store.releases(), []);
    } finally {
      s.done();
    }
  });

  it('keeps a member when the unchanged unit does not show its record MATCH, or does not compile', async () => {
    const s = setup(UNIT.replace(OLD_LEVEL, NEW_LEVEL));
    try {
      const phase = new FakeCompiler({ ...NONMATCH, '00401100': 'INSN_MATCH' }, () => ({}));
      let rows = await releaseNonMatchMembers(s.measured, s.store, auditOf(NONMATCH), { fresh: s.bodies, compiler: phase, evidence: 'ev1' });
      assert.strictEqual(rows.find(x => x.address === '00401000')!.status, 'kept');
      assert.match(rows.find(x => x.address === '00401000')!.detail, /holder 00401100 is INSN_MATCH in the unchanged compile/u);
      const broken: TrialCompiler = { compile: async ts => ts.map(t => (t.edits.length ? { error: 'C2065' } : { statuses: new Map(Object.entries(NONMATCH)) })) };
      rows = await releaseNonMatchMembers(s.measured, s.store, auditOf(NONMATCH), { fresh: s.bodies, compiler: broken, evidence: 'ev1' });
      assert.match(rows.find(x => x.address === '00401000')!.detail, /the trial did not compile: C2065/u);
      // No compiler: never assumed.
      rows = await releaseNonMatchMembers(s.measured, s.store, auditOf(NONMATCH), { fresh: s.bodies, evidence: 'ev1' });
      assert.strictEqual(rows.find(x => x.address === '00401000')!.status, 'kept');
      assert.deepStrictEqual(s.store.releases(), []);
    } finally {
      s.done();
    }
  });

  it('never releases a member that is MATCH itself', async () => {
    const s = setup(UNIT.replace(OLD_LEVEL, NEW_LEVEL));
    try {
      const st = { ...NONMATCH, '00401000': 'MATCH' };
      const cc = new FakeCompiler(st, () => ({}));
      const rows = await releaseNonMatchMembers(s.measured, s.store, auditOf(st), { fresh: s.bodies, compiler: cc, evidence: 'ev1' });
      assert.strictEqual(rows.find(x => x.address === '00401000')!.status, 'match');
      assert.ok(cc.calls.every(ts => ts.every(t => t.edits.length === 0)), 'its body is never compiled as a release candidate');
      assert.deepStrictEqual(s.store.releases(), []);
    } finally {
      s.done();
    }
  });

  it('changes nothing on disk in a dry run', async () => {
    const s = setup(UNIT.replace(OLD_LEVEL, NEW_LEVEL));
    try {
      const snap = () => fs.readdirSync(s.dir, { recursive: true }).map(String).sort().map(f => {
        const p = path.join(s.dir, f);
        return `${f}:${fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf-8') : ''}`;
      }).join('\n');
      const before = snap();
      const cc = new FakeCompiler(NONMATCH, () => ({}));
      const rows = await releaseNonMatchMembers(s.measured, s.store, auditOf(NONMATCH), { fresh: s.bodies, compiler: cc, evidence: 'ev1', dryRun: true });
      assert.strictEqual(rows.find(x => x.address === '00401000')!.status, 'released');
      assert.strictEqual(snap(), before);
    } finally {
      s.done();
    }
  });

  it('verifies two members of one unit together, and alone when together fails', async () => {
    const s = setup(UNIT.replace(OLD_LEVEL, NEW_LEVEL).replace(OLD_SCALE, NEW_SCALE));
    try {
      assert.deepStrictEqual([...s.bodies.keys()], ['00401000', '00401050']);
      // Each alone keeps the MATCH; Scale's new body loses it.
      const cc = new FakeCompiler(NONMATCH, e => (e.has('00401050') ? { '00401100': 'OUR-1' } : {}));
      const rows = await releaseNonMatchMembers(s.measured, s.store, auditOf(NONMATCH), { fresh: s.bodies, compiler: cc, evidence: 'ev1' });
      assert.strictEqual(rows.find(x => x.address === '00401000')!.status, 'released');
      assert.match(rows.find(x => x.address === '00401000')!.detail, /alone; the other members of its unit stay kept/u);
      assert.strictEqual(rows.find(x => x.address === '00401050')!.status, 'kept');
      assert.match(rows.find(x => x.address === '00401050')!.detail, /\(alone\)/u);
      assert.deepStrictEqual(s.store.releases().map(r => r.address), ['00401000']);
      // Both pass alone but not together: neither is released.
      const s2 = new FakeCompiler(NONMATCH, e => (e.size > 1 ? { '00401100': 'OUR-1' } : {}));
      s.store.writeReleases([]);
      const rows2 = await releaseNonMatchMembers(s.measured, s.store, auditOf(NONMATCH), { fresh: s.bodies, compiler: s2, evidence: 'ev1' });
      assert.deepStrictEqual(rows2.filter(r => r.status === 'kept').map(r => r.address), ['00401000', '00401050']);
      assert.match(rows2.find(x => x.address === '00401000')!.detail, /passes alone, but together/u);
      assert.deepStrictEqual(s.store.releases(), []);
    } finally {
      s.done();
    }
  });

  it('requires every MATCH record holding the member to stay MATCH', async () => {
    const s = setup(UNIT.replace(OLD_LEVEL, NEW_LEVEL));
    try {
      const st = { ...NONMATCH, '00401200': 'MATCH' };
      s.store.put(capture(s.measured, '00401200', 'match', 'ev1').record!);
      const cc = new FakeCompiler(st, e => (e.has('00401000') ? { '00401200': 'OUR+1' } : {}));
      const rows = await releaseNonMatchMembers(s.measured, s.store, auditOf(st), { fresh: s.bodies, compiler: cc, evidence: 'ev1' });
      const r = rows.find(x => x.address === '00401000')!;
      assert.strictEqual(r.status, 'kept');
      assert.strictEqual(r.holders, '00401100:MATCH->MATCH,00401200:MATCH->OUR+1');
    } finally {
      s.done();
    }
  });

  it('consumes a member release once the records holding it are captured again', () => {
    const s = setup(UNIT.replace(OLD_LEVEL, NEW_LEVEL));
    try {
      s.store.writeReleases([{ address: '00401000', reason: 'r', body: bodyHash(s.bodies.get('00401000')!) }]);
      // The tree now carries the released body; the record is still MATCH.
      const now = tree(UNIT.replace(OLD_LEVEL, NEW_LEVEL));
      const rows = advance(now, s.store, auditOf(NONMATCH), 'ev2');
      assert.strictEqual(rows.find(r => r.address === '00401100')!.status, 'refreshed');
      assert.deepStrictEqual(s.store.releases(), []);
      assert.strictEqual(rows.find(r => r.address === '00401000')!.status, 'consumed');
      assert.ok(s.store.get('00401100')!.members[1].text.includes('int n = nStat;'), 'the record holds the released body now');
      // A holder that is not captured keeps the row.
      s.store.writeReleases([{ address: '00401000', reason: 'r' }]);
      advance(now, s.store, auditOf({ ...NONMATCH, '00401100': 'OUR-1' }), 'ev3');
      assert.deepStrictEqual(s.store.releases().map(r => r.address), ['00401000']);
    } finally {
      s.done();
    }
  });

  it('reads release rows with and without a body', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-rel-'));
    try {
      fs.writeFileSync(path.join(dir, 'release.tsv'), '# h\n0057eab0\tfix\twith a tab\n00401000\twhy\tbody=0123456789abcdef\n');
      const store = new RatchetStore(dir);
      assert.deepStrictEqual(store.releases(), [
        { address: '0057eab0', reason: 'fix\twith a tab' },
        { address: '00401000', reason: 'why', body: '0123456789abcdef' },
      ]);
      store.writeReleases(store.releases());
      assert.deepStrictEqual(new RatchetStore(dir).releases().map(r => r.body), [undefined, '0123456789abcdef']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('the generator writes the generated bodies of the kept members beside its report', async () => {
    const { applyRatchetToProject, RATCHET_FRESH_FILE } = await import('./generator.js');
    const s = setup(UNIT);
    try {
      const fresh = UNIT.replace(OLD_LEVEL, NEW_LEVEL);
      const project = {
        name: 'p', dataTypes: [], classes: [], namespaces: [], globals: [],
        files: new Map([
          ['Source/G/Unit.h', { path: 'Source/G/Unit.h', content: HEADER, type: 'header' as const, functions: [], includes: [] }],
          [FILE, { path: FILE, content: fresh, type: 'implementation' as const, functions: [], includes: [] }],
        ]),
        sourceMaps: new Map(),
      };
      const out = path.join(s.dir, 'out');
      const r = applyRatchetToProject(project as never, { outputDir: out, projectDir: out, projectConfig: { ratchet: { store: s.dir } } } as never, '# h\n');
      assert.strictEqual(r.counts?.kept, 1);
      const bodies = readFreshBodies(fs.readFileSync(path.join(out, '.ghidra-mcp', RATCHET_FRESH_FILE), 'utf-8'));
      assert.deepStrictEqual([...bodies.keys()], ['00401000']);
      assert.ok(bodies.get('00401000')!.includes('int n = nStat;'));
      assert.ok(project.files.get(FILE)!.content.includes(OLD_LEVEL), 'the kept body is what the regen carries');
    } finally {
      s.done();
    }
  });
});
