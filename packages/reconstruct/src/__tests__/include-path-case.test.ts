/**
 * Include paths and file paths agree byte for byte, on every filesystem.
 *
 * Measured on recon/diablo-2 (v1695): the generator writes and includes `D2Client/GAME/Draw.h`,
 * but git's index holds `D2Client/Game/Draw.h` - an older run created `Game` on the
 * case-insensitive macOS disk, and core.ignorecase kept that spelling through every later
 * rename. A Linux checkout failed 507 of 512 files on 59 such include paths.
 *
 * The generator side: two namespaces differing only in case (`D2Client::GAME` and
 * `D2Client::Game`) become ONE directory with one deterministic spelling, and every include
 * names the path its file is written to. The lint side: `include-path-case` asks each quoted
 * include the question a case-sensitive compiler asks, against the paths a clone gets.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalDirectoryCase, canonicalizeProjectPathCase, quotedIncludePath, resolveQuotedInclude,
} from '../codegen/path-case.js';
import { ALL_CHECKS, ZERO_TOLERANCE_CHECKS, parseSource, runChecks, treeFromFiles, gitIndexPaths } from '../lint/index.js';
import { sourceIncludes } from '../lint/tree.js';

function lint(files: Record<string, string>, paths?: string[]) {
  const parsed = Object.entries(files).map(([p, src]) => parseSource(p, src));
  const tree = treeFromFiles('/nonexistent', parsed, paths ?? parsed.map(f => f.path), 'git-index');
  const r = runChecks(tree, null, ALL_CHECKS.filter(c => c.id === 'include-path-case'));
  assert.deepStrictEqual(r.errors, []);
  return r.findings;
}

describe('quotedIncludePath', () => {
  it('reads the quoted path of an include directive and nothing else', () => {
    assert.deepStrictEqual(quotedIncludePath('#include "D2Client/GAME/Draw.h"'), { path: 'D2Client/GAME/Draw.h', start: 10, end: 30 });
    assert.strictEqual(quotedIncludePath('  #  include\t"a.h" // x')?.path, 'a.h');
    assert.strictEqual(quotedIncludePath('#include <windows.h>'), null);
    assert.strictEqual(quotedIncludePath('#include ""'), null);
    assert.strictEqual(quotedIncludePath('#define include "a.h"'), null);
    assert.strictEqual(quotedIncludePath('// #include "a.h"'), null);
    assert.strictEqual(quotedIncludePath('#includes "a.h"')?.path ?? null, null);
  });

  it('the lint reads an include after the last declaration (EOF trivia) too', () => {
    const inc = sourceIncludes('x.h', '#pragma once\n#include "A/b.h"\nint f();\n#include "E/end.h"\n');
    assert.deepStrictEqual(inc, [{ line: 2, path: 'A/b.h' }, { line: 4, path: 'E/end.h' }]);
    assert.deepStrictEqual(sourceIncludes('x.cpp', 'const char* s = "#include \\"no.h\\"";\n/* #include "no.h" */\n'), []);
  });
});

describe('canonical directory case', () => {
  it('the spelling holding the most files wins, ties go to the code-unit-smallest', () => {
    const dirs = canonicalDirectoryCase([
      'D2Client/GAME/A.h', 'D2Client/GAME/B.h', 'D2Client/Game/C.h',
      'D2Win/forms/X.h', 'D2Win/Forms/Y.h',
    ]);
    assert.strictEqual(dirs.get('d2client/game'), 'D2Client/GAME');
    assert.strictEqual(dirs.get('d2win/forms'), 'D2Win/Forms');
  });

  it('is independent of emission order', () => {
    const paths = ['a/Dir/x.h', 'a/DIR/y.h', 'a/dir/z.h', 'A/q.h'];
    const one = canonicalDirectoryCase(paths);
    const two = canonicalDirectoryCase([...paths].reverse());
    assert.deepStrictEqual([...one].sort(), [...two].sort());
    assert.strictEqual(one.get('a/dir'), 'a/DIR');
  });

  it('a child directory lives under its parent\'s one spelling', () => {
    const dirs = canonicalDirectoryCase(['D2Game/GAME/Event/a.h', 'D2Game/GAME/b.h', 'D2Game/Game/Event/c.h']);
    assert.strictEqual(dirs.get('d2game/game/event'), 'D2Game/GAME/Event');
  });

  it('moves the files of a case-twin namespace and rewrites every include of them', () => {
    const project = {
      files: new Map([
        ['D2Client/GAME/Game.h', { path: 'D2Client/GAME/Game.h', content: '#pragma once\n#include "D2Client/Game/Record.h"\n' }],
        ['D2Client/GAME/Draw.h', { path: 'D2Client/GAME/Draw.h', content: '#pragma once\n' }],
        ['D2Client/Game/Record.h', { path: 'D2Client/Game/Record.h', content: '#pragma once\n#include "Draw.h"\n' }],
        ['D2Client/Game/Record.cpp', { path: 'D2Client/Game/Record.cpp', content: '#include "Record.h"\n#include "D2Client/GAME/Game.h"\n#include <windows.h>\nint x;\n' }],
        ['globals.h', { path: 'globals.h', content: '#include "D2Client/Game/Record.h"\n#include "D2Client/GAME/Draw.h"\n' }],
      ]),
      sourceMaps: new Map([['D2Client/Game/Record.cpp.map', { file: 'D2Client/Game/Record.cpp' }]]),
    };
    const moves = canonicalizeProjectPathCase(project);
    assert.deepStrictEqual(moves.sort(), [
      'D2Client/Game/Record.cpp -> D2Client/GAME/Record.cpp',
      'D2Client/Game/Record.cpp.map -> D2Client/GAME/Record.cpp.map',
      'D2Client/Game/Record.h -> D2Client/GAME/Record.h',
    ]);
    assert.deepStrictEqual([...project.files.keys()].sort(), [
      'D2Client/GAME/Draw.h', 'D2Client/GAME/Game.h', 'D2Client/GAME/Record.cpp', 'D2Client/GAME/Record.h', 'globals.h',
    ]);
    assert.strictEqual(project.files.get('D2Client/GAME/Record.cpp')!.path, 'D2Client/GAME/Record.cpp');
    assert.strictEqual(project.files.get('D2Client/GAME/Game.h')!.content, '#pragma once\n#include "D2Client/GAME/Record.h"\n');
    // A beside-the-file include stays relative; system includes are untouched.
    assert.strictEqual(project.files.get('D2Client/GAME/Record.cpp')!.content,
      '#include "Record.h"\n#include "D2Client/GAME/Game.h"\n#include <windows.h>\nint x;\n');
    assert.strictEqual(project.files.get('globals.h')!.content, '#include "D2Client/GAME/Record.h"\n#include "D2Client/GAME/Draw.h"\n');
    assert.deepStrictEqual([...project.sourceMaps], [['D2Client/GAME/Record.cpp.map', { file: 'D2Client/GAME/Record.cpp' }]]);

    // Afterwards every include resolves byte for byte, and the lint agrees.
    const keys = new Set(project.files.keys());
    for (const [p, f] of project.files) {
      for (const line of f.content.split('\n')) {
        const inc = quotedIncludePath(line);
        if (inc) assert.ok(resolveQuotedInclude(p, inc.path, k => keys.has(k)), `${p}: ${inc.path}`);
      }
    }
    const files = Object.fromEntries([...project.files].map(([k, v]) => [k, v.content]));
    assert.deepStrictEqual(lint(files), []);
  });

  it('a project spelled one way is left alone', () => {
    const file = { path: 'A/B/c.h', content: '#include "A/B/d.h"\n' };
    const project = { files: new Map([['A/B/c.h', file], ['A/B/d.h', { path: 'A/B/d.h', content: '' }]]), sourceMaps: new Map() };
    assert.deepStrictEqual(canonicalizeProjectPathCase(project), []);
    assert.strictEqual(project.files.get('A/B/c.h'), file);
  });
});

describe('include-path-case lint', () => {
  it('is a registered zero-tolerance check', () => {
    assert.ok(ALL_CHECKS.some(c => c.id === 'include-path-case'));
    assert.ok(ZERO_TOLERANCE_CHECKS.has('include-path-case'));
  });

  it('flags an include the tree has only in another case, once per include path', () => {
    const f = lint({
      'globals.h': '#include "D2Client/GAME/Draw.h"\n#include "D2Win/Forms.h"\n#include "d2_platform.h"\n#include "sdk/missing.h"\n',
      'D2Client/Unit.cpp': '#include "D2Client/GAME/Draw.h"\nint x;\n',
      'D2Client/Game/Draw.h': '#pragma once\n',
      'D2Win/FORMS.h': '#pragma once\n',
      'd2_platform.h': '#pragma once\n',
    });
    assert.deepStrictEqual(f.map(x => [x.subject, x.file, x.line, x.detail]), [
      ['D2Client/GAME/Draw.h', 'globals.h', 1, 'git-index has D2Client/Game/Draw.h; 2 include site(s) spell it D2Client/GAME/Draw.h'],
      ['D2Win/Forms.h', 'globals.h', 2, 'git-index has D2Win/FORMS.h; 1 include site(s) spell it D2Win/Forms.h'],
    ]);
  });

  it('resolves beside the including file first, as the compiler does', () => {
    assert.deepStrictEqual(lint({
      'D2Client/Game/Draw.cpp': '#include "Draw.h"\n',
      'D2Client/Game/Draw.h': '#pragma once\n',
    }), []);
    const f = lint({
      'D2Client/Game/Draw.cpp': '#include "draw.h"\n',
      'D2Client/Game/Draw.h': '#pragma once\n',
    });
    assert.deepStrictEqual(f.map(x => x.subject), ['draw.h']);
  });

  it('flags a directory or file the tree spells two ways', () => {
    const f = lint({ 'a.cpp': 'int x;\n' }, ['a.cpp', 'D2Client/GAME/A.h', 'D2Client/Game/B.h', 'x/Y.h', 'x/y.h']);
    assert.deepStrictEqual(f.map(x => x.detail), [
      'git-index spells one path 2 ways: D2Client/GAME, D2Client/Game',
      'git-index spells one path 2 ways: x/Y.h, x/y.h',
    ]);
  });

  it('reads the paths from git\'s index, which may keep a spelling the disk has lost', () => {
    const dir = mkdtempSync(join(tmpdir(), 'include-case-'));
    try {
      const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
      git('init', '-q');
      mkdirSync(join(dir, 'Game'));
      writeFileSync(join(dir, 'Game', 'Draw.h'), '');
      mkdirSync(join(dir, 'build'));
      writeFileSync(join(dir, 'build', 'out.h'), '');
      git('add', '-A');
      assert.deepStrictEqual(gitIndexPaths(dir), ['Game/Draw.h']);
      assert.strictEqual(gitIndexPaths(join(dir, 'Game')), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
