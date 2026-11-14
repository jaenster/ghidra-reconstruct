/**
 * A record is read against the tree at its evidence commit, not the tree the store sits in:
 * once a regen with renames is merged there, the old spellings of a stored body resolve to
 * nothing (deploy 1167, the second daemon rebuild).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { evidenceAnchors, evidencePrevious } from './evidence.js';
import { applyRecords, capture } from './ratchet.js';
import { RatchetStore, type RatchetRecord } from './store.js';
import { GLOBALS_INDEX_FILE, SymbolIndex, memoryTree } from './symbol-index.js';

const HEADER = `#pragma once
namespace Data {
int __stdcall UnloadBin(void * pTxtTable, int nPage); // 1.14d: 006125c0
}
`;
const UNIT = (global: string, extra = '') => `#include "Data.h"
namespace Data {

// 1.14d: 006125c0
int __stdcall UnloadBin(void * pTxtTable, int nPage) {
    ${extra}if (${global} && nPage == 1) {
      return 1;
    }
    return 0;
}

} // namespace Data
`;
const GLOBALS = (name: string) => `# address\tqualified name\ttype\n00744308\t${name}\tint\n`;
const files = (global: string, extra = '', withGlobals = true): Record<string, string> => ({
  'Source/Data/Data.h': HEADER,
  'Source/Data/Data.cpp': UNIT(global, extra),
  ...(withGlobals ? { [GLOBALS_INDEX_FILE]: GLOBALS(global) } : {}),
});
const ALL = () => true;

function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf-8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** A repo whose commits hold `trees` in order; returns their shas. */
function repoWith(dir: string, trees: Array<Record<string, string>>): string[] {
  git(dir, 'init', '-q', '-b', 'main');
  const shas: string[] = [];
  for (const [k, t] of trees.entries()) {
    for (const f of fs.readdirSync(dir)) if (f !== '.git') fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    for (const [p, text] of Object.entries(t)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), text);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--allow-empty', '-m', `c${k}`);
    shas.push(git(dir, 'rev-parse', 'HEAD'));
  }
  return shas;
}

/** A record as the seed captured it: no global bound, evidence `sha`. */
function seeded(evidence: string): RatchetRecord {
  const c = capture(SymbolIndex.build(memoryTree(new Map(Object.entries(files('gpaMiscTxtTables', '', false))))), '006125c0', 'match', evidence);
  assert.ok(c.record, c.error);
  assert.ok(!c.record!.members[0].bindings.some(([, b]) => b.k === 'gl'));
  return c.record!;
}

function withTemp(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-evidence-'));
    try { await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

describe('ratchet: a record against the tree at its evidence', () => {
  it('finds the first commit at or after the evidence that carries the globals index', withTemp(dir => {
    const [c0, c1, c2] = repoWith(dir, [files('gpaMiscTxtTables', '', false), files('gpaMiscTxtTables'), files('gbTxtAllocCountHeader')]);
    assert.strictEqual(evidenceAnchors(dir, c0).names, c1, 'the seed tree had no globals index');
    assert.strictEqual(evidenceAnchors(dir, c1).names, c1);
    assert.strictEqual(evidenceAnchors(dir, c2).names, c2);
    assert.strictEqual(evidenceAnchors(dir, c0).storage, undefined, 'no tree carried storage');
    assert.deepStrictEqual(evidenceAnchors(dir, 'deadbeef'), {});
  }));

  it('follows a renamed global after the rename was merged into the store\'s tree', withTemp(dir => {
    // c1: the tree the record was captured from; c2: the regen with the rename, merged.
    const [c0] = repoWith(dir, [files('gpaMiscTxtTables', '', false), files('gpaMiscTxtTables'), files('gbTxtAllocCountHeader')]);
    const rec = seeded(c0.slice(0, 9));
    const now = SymbolIndex.build(memoryTree(new Map(Object.entries(files('gbTxtAllocCountHeader', 'nPage = nPage;\n    ')))));
    const out = applyRecords(now, [rec], { previousFor: r => evidencePrevious(dir, now, ALL)(r.evidence) });
    assert.strictEqual(out.rows[0].status, 'kept');
    const text = out.changed.get('Source/Data/Data.cpp')!;
    assert.ok(text.includes('if (gbTxtAllocCountHeader && nPage == 1)'), text);
    // The same twice over, the second regen merged too: the evidence still decides.
    fs.writeFileSync(path.join(dir, 'Source/Data/Data.cpp'), UNIT('gbTxtAllocCountHeader', 'nPage = nPage;\n    '));
    git(dir, 'commit', '-q', '-am', 'merged regen output');
    const again = applyRecords(now, [rec], { previousFor: r => evidencePrevious(dir, now, ALL)(r.evidence) });
    assert.strictEqual(again.changed.get('Source/Data/Data.cpp'), text);
  }));

  it('reaches the generator with no override, the store inside the repo', withTemp(async dir => {
    const [c0] = repoWith(dir, [files('gpaMiscTxtTables', '', false), files('gpaMiscTxtTables'), files('gbTxtAllocCountHeader')]);
    new RatchetStore(path.join(dir, 'ratchet')).put(seeded(c0));
    git(dir, 'add', 'ratchet');
    git(dir, 'commit', '-q', '-m', 'store');
    const { applyRatchetToProject } = await import('./generator.js');
    const fresh = files('gbTxtAllocCountHeader', 'nPage = nPage;\n    ');
    const project = {
      name: 'p', dataTypes: [], classes: [], namespaces: [], globals: [{ address: '00744308', name: 'gbTxtAllocCountHeader', dataType: 'int' }],
      files: new Map(Object.entries(fresh).filter(([k]) => k !== GLOBALS_INDEX_FILE).map(([k, v]) => [k, { path: k, content: v, type: 'implementation' as const, functions: [], includes: [] }])),
      sourceMaps: new Map(),
    };
    const out = path.join(dir, 'out');
    const saved = process.env.RECON_RATCHET_PREVIOUS;
    delete process.env.RECON_RATCHET_PREVIOUS;
    try {
      const { globalsIndexText } = await import('./generator.js');
      const r = applyRatchetToProject(project as never, { outputDir: out, projectDir: out, projectConfig: { ratchet: { store: path.join(dir, 'ratchet') } } } as never, globalsIndexText(project as never));
      assert.strictEqual(r.counts?.kept, 1);
      assert.ok(project.files.get('Source/Data/Data.cpp')!.content.includes('if (gbTxtAllocCountHeader && nPage == 1)'));
    } finally {
      if (saved !== undefined) process.env.RECON_RATCHET_PREVIOUS = saved;
    }
  }));

  it('gives nothing for an evidence the repo does not have', withTemp(dir => {
    repoWith(dir, [files('gpaMiscTxtTables')]);
    const now = SymbolIndex.build(memoryTree(new Map(Object.entries(files('gbTxtAllocCountHeader')))));
    assert.strictEqual(evidencePrevious(dir, now, ALL)('0123456789abcdef'), undefined);
  }));
});
