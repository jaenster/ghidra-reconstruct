/**
 * The steering lint, check by check. Each positive case is a steering form; each negative is
 * the nearest shape that is the algorithm (or the original's own code) and must stay quiet.
 * The single-use temporary cases are taken from the four rejected issue bodies (#557, #580,
 * #596, #627), reduced to the statements that carried the steer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseBody } from '../lint/steering/body.js';
import { addressShaped, lintBody, pragmaName, type SteerEnv, type SteerFinding } from '../lint/steering/checks.js';
import { applyHunks, extractDiff, parseUnifiedDiff } from '../lint/steering/patch.js';
import {
  countTree, fileStaticFunctions, keyPinFindings, lintSteeringPatch, lintSteeringTree, loadSteeringBaseline, saveSteeringBaseline, treeEnv,
} from '../lint/steering/run.js';
import { buildVocabulary, globMatcher, type VocabularyFile } from '../lint/steering/vocabulary.js';
import { SymbolIndex, memoryTree } from '../ratchet/symbol-index.js';
import { steeringMain } from '../lint/steering/cli.js';

const VOCAB_FILE: VocabularyFile = {
  vocabularyHeaders: ['inc/platform.h'],
  definitionHeaders: ['inc/platform.h'],
  generatorMacros: ['D2_FREE_AT'],
  volatileFieldFiles: ['storm/**'],
  system: ['memset', 'uint32_t', 'int32_t', 'uint8_t', 'uintptr_t', 'NULL'],
};

const PLATFORM_H = '#pragma once\n#define D2_FORCEINLINE __forceinline\n#define D2_NOINLINE __declspec(noinline)\nstatic inline unsigned D2_SeedRoll(void* p) { return 0; }\n';

function vocabulary() {
  return buildVocabulary(VOCAB_FILE, ['inc/platform.h'], p => (p === 'inc/platform.h' ? PLATFORM_H : undefined));
}

function env(extra: Partial<SteerEnv> = {}): SteerEnv {
  return { vocabulary: vocabulary(), ...extra };
}

function run(text: string, e: SteerEnv = env()): SteerFinding[] {
  return lintBody(parseBody(text), e);
}

const of = (fs: SteerFinding[], check: string) => fs.filter(f => f.check === check);
const subjects = (fs: SteerFinding[], check: string) => of(fs, check).map(f => f.subject).sort();

describe('steering lint: keyword checks', () => {
  it('noinline: the attribute and the declspec, in the signature or a macro', () => {
    const fs = run('__attribute__((noinline)) inline void f(int a) { g(a); }');
    assert.deepStrictEqual(subjects(fs, 'noinline'), ['noinline']);
    const ds = run('__declspec(noinline) void f(int a) { g(a); }');
    assert.deepStrictEqual(subjects(ds, 'noinline'), ['noinline']);
    const macro = run('D2_NOINLINE void f(int a) { g(a); }');
    assert.deepStrictEqual(subjects(macro, 'noinline'), ['D2_NOINLINE']);
  });

  it('noinline: a comment or string that says it is not a finding', () => {
    const fs = run('void f(int a) {\n  // noinline here once\n  g("noinline", a);\n}');
    assert.deepStrictEqual(of(fs, 'noinline'), []);
  });

  it('forceinline: the keyword and a vocabulary macro that expands to it', () => {
    assert.deepStrictEqual(subjects(run('__forceinline int f(int a) { return a; }'), 'forceinline'), ['__forceinline']);
    assert.deepStrictEqual(subjects(run('D2_FORCEINLINE int f(int a) { return a; }'), 'forceinline'), ['D2_FORCEINLINE']);
  });

  it('forceinline: plain inline and a mention in a comment are not', () => {
    assert.deepStrictEqual(of(run('inline int f(int a) { /* __forceinline */ return a; }'), 'forceinline'), []);
  });

  it('volatile: a volatile local and an access forced through a volatile cast', () => {
    const fs = run('int f(int a) { volatile int y = a; int x = a; return *(volatile int*)&x + y; }');
    assert.deepStrictEqual(subjects(fs, 'volatile'), ['cast', 'y']);
  });

  it('volatile: the original deliberate fault through a constant address is faithful', () => {
    const fs = run('void f() { *(volatile uint8_t*)0x0 = 0; }');
    assert.deepStrictEqual(of(fs, 'volatile'), []);
  });

  it('inline-asm: an __asm block (and the parser cannot read the body)', () => {
    const fs = run('void f() { __asm { mov eax, eax } }');
    assert.deepStrictEqual(subjects(fs, 'inline-asm'), ['__asm']);
    assert.strictEqual(of(fs, 'unparsed-body').length, 1);
  });

  it('inline-asm: a name that only contains asm is not', () => {
    assert.deepStrictEqual(of(run('void f(int nAsm) { g(nAsm); }'), 'inline-asm'), []);
  });

  it('optimize-pragma: optimize and inline_depth, read as directives', () => {
    const fs = run('void f() {\n#pragma optimize("", off)\n  g();\n#pragma inline_depth(0)\n}');
    assert.deepStrictEqual(subjects(fs, 'optimize-pragma'), ['inline_depth', 'optimize']);
    assert.strictEqual(pragmaName('#pragma optimize("", on)'), 'optimize');
  });

  it('optimize-pragma: pragmas that do not change code generation are not', () => {
    const fs = run('void f() {\n#pragma warning(disable: 4100)\n  g();\n}');
    assert.deepStrictEqual(of(fs, 'optimize-pragma'), []);
  });

  it('register-keyword: the storage class, not the word', () => {
    assert.deepStrictEqual(subjects(run('int f(int a) { register int x = a; return x; }'), 'register-keyword'), ['register']);
    assert.deepStrictEqual(of(run('int f(int nRegister) { /* register */ return nRegister; }'), 'register-keyword'), []);
  });
});

describe('steering lint: raw addresses and casts', () => {
  it('raw-address: a 1.14d address cast to a pointer, called, or written as a constant', () => {
    const fs = run('void f(int* p) {\n  int* q = (int*)0x6fabc3;\n  ((void(*)())0x4a1b20)();\n  int n;\n  n = 0x503841;\n  g(q, n);\n}');
    assert.deepStrictEqual(subjects(fs, 'raw-address'), ['0x4a1b20', '0x503841', '0x6fabc3']);
  });

  it('raw-address: a flag, a mask, and a decimal count in the range are not addresses', () => {
    const fs = run('int f(int a) { if (a & 0x400000) return a | 0x7fffff; return a + 5000000 + 0x600000; }');
    assert.deepStrictEqual(of(fs, 'raw-address'), []);
    const lit = (raw: string) => ({ kind: 'IntegerLiteral', raw, value: BigInt(raw) });
    assert.strictEqual(addressShaped(lit('0x503841')), true);
    assert.strictEqual(addressShaped(lit('0x7ff000')), false);
  });

  it('pointer-int-cast: tested for null, compared with 0, or cast straight back', () => {
    const fs = run('int f(int* p, char* q) {\n  if ((uint32_t)p) g();\n  if ((int)q == 0) g();\n  return *(int*)(uintptr_t)p;\n}');
    assert.strictEqual(of(fs, 'pointer-int-cast').length, 3);
  });

  it('pointer-int-cast: byte arithmetic on an address and an integer cast of an integer are not', () => {
    const fs = run('int f(int* p, int n) { int* q = (int*)((uintptr_t)p + 4); return (int)n + *q; }');
    assert.deepStrictEqual(of(fs, 'pointer-int-cast'), []);
  });
});

describe('steering lint: dead stores', () => {
  it('a local stored and never read, and a store overwritten before any read', () => {
    const fs = run('int f(int a) {\n  int nUnused;\n  nUnused = a + 1;\n  int b = a * 2;\n  b = a * 3;\n  return b;\n}');
    assert.deepStrictEqual(subjects(fs, 'dead-store'), ['b', 'nUnused']);
  });

  it('a store read on some path, a store in a branch, and an escaped local are not dead', () => {
    const fs = run('int f(int a) {\n  int b = 0;\n  if (a) b = 2;\n  int c = a;\n  g(&c);\n  c = 1;\n  int d = a;\n  h(d);\n  d = 4;\n  return b + d;\n}');
    assert.deepStrictEqual(of(fs, 'dead-store'), []);
  });
});

describe('steering lint: single-use temporaries', () => {
  const globals = new Map<string, any>([
    ['ScreenSizeX', { name: 'ScreenSizeX', type: { kind: 'BuiltinType', name: 'int', modifiers: [] }, line: 1 }],
    ['ScreenSizeY', { name: 'ScreenSizeY', type: { kind: 'BuiltinType', name: 'int', modifiers: [] }, line: 1 }],
    ['bExpansion', { name: 'bExpansion', type: { kind: 'BuiltinType', name: 'int', modifiers: [] }, line: 1 }],
    ['gLink', { name: 'gLink', type: { kind: 'BuiltinType', name: 'int', modifiers: [] }, line: 1 }],
  ]);
  const e = () => env({ globals });

  it('#627: a load pulled out ahead of another argument\'s load', () => {
    const fs = run('void f(uint32_t* pEntry) {\n  uint32_t dwCode = *(pEntry - 2);\n  int n = Lookup(gLink, dwCode, 0);\n  use(n);\n}', e());
    assert.deepStrictEqual(subjects(fs, 'single-use-temp'), ['dwCode']);
  });

  it('#557: the Y coordinate read in a scoped temporary ahead of the X computation', () => {
    const fs = run('void f(int worldX, int worldY, void* pMemory) {\n  g(&worldX, &worldY);\n  {\n    const int nPresetY = worldY;\n    const int nPresetX = worldX + 5;\n    Alloc(pMemory, 0x29, nPresetX, nPresetY);\n  }\n  {\n    const int nPresetY = worldY;\n    const int nPresetX = worldX + 10;\n    Alloc(pMemory, 0x29, nPresetX, nPresetY);\n  }\n}', e());
    assert.deepStrictEqual(subjects(fs, 'single-use-temp'), ['nPresetY', 'nPresetY']);
  });

  it('#580: a global read placed above a loop it does not depend on, and an X computed ahead of the Y branch', () => {
    const fs = run('void f() {\n  int iLoop;\n  uint16_t wszText[100];\n  const int nCenterX = ScreenSizeX / 2;\n  for (iLoop = 0; iLoop < 100; iLoop++) {\n    wszText[iLoop] = 0;\n  }\n  Copy(wszText, Get(1));\n  int nTextWidth = Measure(wszText);\n  const int nTextX = nCenterX - nTextWidth / 2;\n  int nTextY = 0x3e;\n  if (bExpansion) {\n    nTextY = 100;\n  }\n  Draw(Get(1), nTextX, nTextY);\n}', e());
    assert.deepStrictEqual(subjects(fs, 'single-use-temp'), ['nCenterX', 'nTextX']);
    assert.match(of(fs, 'single-use-temp').find(f => f.subject === 'nCenterX')!.detail, /placement/);
  });

  it('#596: half width, Y and X each computed once to order the ScreenSizeY read', () => {
    const fs = run('void f() {\n  uint16_t wszHpText[100];\n  Fill(wszHpText);\n  const int nTextWidth = Measure(wszHpText);\n  const int nHalfWidth = nTextWidth / 2;\n  const int nTextY = ScreenSizeY - 0x5f;\n  const int nTextX = 0x41 - nHalfWidth;\n  Draw(wszHpText, nTextX, nTextY, 0, 0);\n}', e());
    assert.deepStrictEqual(subjects(fs, 'single-use-temp'), ['nHalfWidth', 'nTextX', 'nTextY']);
  });

  it('a call result held in a named local is a value, not a steer (#596 nMaxHp)', () => {
    const fs = run('void f(void* pUnit, uint16_t* buf) {\n  int nStat = GetStat(pUnit) >> 8;\n  const int nMaxHp = GetMaxLife(pUnit) >> 8;\n  void* p = GetPlayer();\n  if (p) nStat = 1;\n  Format(buf, nStat, nMaxHp);\n}', e());
    assert.deepStrictEqual(of(fs, 'single-use-temp'), []);
  });

  it('a temporary read twice, a constant, a temporary whose input changes before its use, and one used in a loop are not', () => {
    const fs = run('int f(int* p, int a) {\n  int twice = p[1];\n  g(twice, twice);\n  const int nLine = 0x10b;\n  h(gLink, nLine);\n  int before = a;\n  a = a + 1;\n  h(a, before);\n  int inLoop = *p;\n  for (int i = 0; i < 4; i++) h(gLink, inLoop);\n  return a;\n}', e());
    assert.deepStrictEqual(of(fs, 'single-use-temp'), []);
  });

  it('a load the next statement stores through, with only register operands beside it, moves nothing', () => {
    const fs = run('void f(int** pp, int* pNext) {\n  int** ppSlot = (int**)Next(pp);\n  *ppSlot = pNext;\n  int nHash = Hash(pp);\n  int nBucket = nHash & 0xff;\n  g(nBucket);\n}', e());
    assert.deepStrictEqual(of(fs, 'single-use-temp'), []);
  });

  it('a load that a call in between could change keeps its place', () => {
    const fs = run('int f(int* p) {\n  int nOld = *p;\n  Touch(p);\n  return nOld + *p;\n}', e());
    assert.deepStrictEqual(of(fs, 'single-use-temp'), []);
  });
});

describe('steering lint: unbound identifiers', () => {
  const header = '#pragma once\nnamespace NS {\nvoid Known(int a); // 1.14d: 00401000\n}\n';
  const index = SymbolIndex.build(memoryTree(new Map([['NS/Known.h', header]])));
  const e = (extra: Partial<SteerEnv> = {}) => env({ index, scope: ['NS'], ...extra });

  it('an invented helper and an invented global are reported', () => {
    const fs = run('void f(int a) { MyInlineHelper(a); Known(gInvented); }', e());
    assert.deepStrictEqual(subjects(fs, 'unbound-identifier'), ['MyInlineHelper', 'gInvented']);
  });

  it('index-bound names, the vocabulary, a body-local enum and a stored binding are not', () => {
    const text = 'void f(int a) {\n  enum { LEFT, TOP };\n  int aBox[2];\n  aBox[LEFT] = a;\n  Known(aBox[TOP]);\n  memset(aBox, 0, 8);\n  D2_SeedRoll(nullptr);\n  Stored(a);\n}';
    // A captured record lists the sites it bound by index; with every site bound nothing is left.
    const fs = run(text, e({ storedBindings: new Set([...Array(40).keys()]) }));
    assert.deepStrictEqual(of(fs, 'unbound-identifier'), []);
    const loose = run(text, e()).filter(f => f.check === 'unbound-identifier').map(f => f.subject);
    assert.deepStrictEqual(loose, ['Stored']);
  });

  it('a name the generator itself emits counts as bound', () => {
    const fs = run('void f(int a) { GetQuestBitBufferInline(a); }', e({ generated: n => n === 'GetQuestBitBufferInline' }));
    assert.deepStrictEqual(of(fs, 'unbound-identifier'), []);
  });

  it('a file-static helper defined in the body\'s own file counts as bound (00600f10 CELCMP_GetCellCountInl)', () => {
    const file = 'namespace D2CMP::SRC {\n// hand header\nstatic __inline int GetCountInl(DC6* p) {\n  return p->a * p->b;\n}\n\n' +
      '// 1.14d: 00600f10\nint f(DC6* p) {\n  static int sLocalInit(int);\n  return GetCountInl(p);\n}\n}\nnamespace Other { struct S { static int Member(int); }; }\n';
    const helpers = fileStaticFunctions(file);
    assert.deepStrictEqual([...helpers], ['GetCountInl']);
    const body = 'int f(DC6* p) { return GetCountInl(p) + Other(p); }';
    assert.deepStrictEqual(subjects(run(body, e({ fileHelpers: helpers })), 'unbound-identifier'), ['Other']);
    assert.deepStrictEqual(subjects(run(body, e()), 'unbound-identifier'), ['GetCountInl', 'Other']);
  });
});

describe('steering lint: steer-ok exemptions', () => {
  it('a reasoned steer-ok on the line or the line above exempts the site and keeps it counted', () => {
    const fs = run('void f(int a) {\n  // steer-ok: the original declares this local volatile (1.14d stack probe)\n  volatile int y = a;\n  g(y);\n}');
    const v = of(fs, 'volatile');
    assert.strictEqual(v.length, 1);
    assert.match(v[0].exempt ?? '', /stack probe/);
  });

  it('a steer-ok without a reason exempts nothing', () => {
    const fs = run('void f(int a) {\n  volatile int y = a; // steer-ok:\n  g(y);\n}');
    assert.strictEqual(of(fs, 'volatile')[0].exempt, undefined);
  });
});

describe('steering lint: vocabulary', () => {
  it('reads macro and declared names from a vocabulary header, and knows which macros force inlining', () => {
    const v = vocabulary();
    assert.ok(v.accepts(['D2_SeedRoll']));
    assert.ok(v.accepts(['D2_FORCEINLINE']));
    assert.deepStrictEqual(v.macroSpellings.get('forceinline'), ['D2_FORCEINLINE']);
    assert.ok(!v.accepts(['SomethingElse']));
  });

  it('globs match path segments', () => {
    const m = globMatcher(['Redivivus/*.h', 'storm/**']);
    assert.ok(m('Redivivus/d2_trace.h'));
    assert.ok(!m('Redivivus/sub/d2_trace.h'));
    assert.ok(m('storm/H/stpl.h'));
  });
});

describe('steering lint: patches', () => {
  const before = 'int g(int);\n\n// 1.14d: 00401000\nint f(int* p, int a) {\n  int n = Lookup(*p, a);\n  return n;\n}\n\n// 1.14d: 00401100\nint h(int a) {\n  return a;\n}\n';

  it('reads the diff out of an issue body and applies it by content, over anchor lines it lacks', () => {
    const body = 'Some text.\n\n```diff\n--- a/src/a.cpp\n+++ b/src/a.cpp\n@@ -1,5 +1,5 @@\n int g(int);\n \n-int f(int* p, int a) {\n+int f(int* p, int a) { // changed\n   int n = Lookup(*p, a);\n```\n';
    const files = parseUnifiedDiff(extractDiff(body));
    assert.strictEqual(files.length, 1);
    const r = applyHunks(before, files[0].hunks);
    assert.ok(!('error' in r));
    if (!('error' in r)) {
      assert.match(r.text, /\/\/ 1\.14d: 00401000\nint f\(int\* p, int a\) \{ \/\/ changed/);
    }
  });

  function tree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'steer-'));
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), t);
    }
    return root;
  }

  it('reports only what the diff introduces, plus anchor, prototype, header and outside-body edits', () => {
    const root = tree({ 'src/a.cpp': before, 'src/a.h': 'int f(int* p, int a); // 1.14d: 00401000\n' });
    try {
      const e = treeEnv(root);
      const steer = '--- a/src/a.cpp\n+++ b/src/a.cpp\n@@ -4,4 +4,5 @@\n int f(int* p, int a) {\n-  int n = Lookup(*p, a);\n+  int v = *p;\n+  int n = Lookup(gTable, v);\n   return n;\n }\n';
      const r = lintSteeringPatch(e, steer, '0x401000');
      assert.ok(!('error' in r));
      if (!('error' in r)) {
        assert.deepStrictEqual(r.introduced.filter(f => f.check === 'single-use-temp').map(f => f.subject), ['v']);
        assert.deepStrictEqual(r.structural, []);
      }
      const structural = '--- a/src/a.cpp\n+++ b/src/a.cpp\n@@ -1,8 +1,8 @@\n-int g(int);\n+int g(int, int);\n \n-// 1.14d: 00401000\n-int f(int* p, int a) {\n+// 1.14d: 00401004\n+int f(int* p, unsigned a) {\n   int n = Lookup(*p, a);\n   return n;\n }\n \n--- a/src/a.h\n+++ b/src/a.h\n@@ -1 +1 @@\n-int f(int* p, int a); // 1.14d: 00401000\n+int f(int* p, unsigned a); // 1.14d: 00401000\n';
      const s = lintSteeringPatch(e, structural, '00401000');
      assert.ok('error' in s, 'the target anchor no longer exists after the patch');
      const proto = '--- a/src/a.cpp\n+++ b/src/a.cpp\n@@ -1,4 +1,4 @@\n-int g(int);\n+int g(int, int);\n \n // 1.14d: 00401000\n-int f(int* p, int a) {\n+int f(int* p, unsigned a) {\n--- a/src/a.h\n+++ b/src/a.h\n@@ -1 +1 @@\n-int f(int* p, int a); // 1.14d: 00401000\n+int f(int* p, unsigned a); // 1.14d: 00401000\n';
      const q = lintSteeringPatch(e, proto, '00401000');
      assert.ok(!('error' in q));
      if (!('error' in q)) {
        const checks = q.structural.map(f => f.check).sort();
        assert.deepStrictEqual(checks, ['anchor-edit', 'anchor-edit', 'outside-body', 'outside-body', 'prototype-edit', 'prototype-edit']);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exit codes: 1 for a steer, 0 for a clean change, 2 for a patch that does not apply', () => {
    const root = tree({ 'src/a.cpp': before });
    try {
      const write = (name: string, text: string) => { const p = join(root, name); writeFileSync(p, text); return p; };
      const steer = write('steer.diff', '--- a/src/a.cpp\n+++ b/src/a.cpp\n@@ -4,4 +4,5 @@\n int f(int* p, int a) {\n-  int n = Lookup(*p, a);\n+  int v = *p;\n+  int n = Lookup(gTable, v);\n   return n;\n }\n');
      const clean = write('clean.diff', '--- a/src/a.cpp\n+++ b/src/a.cpp\n@@ -4,4 +4,4 @@\n int f(int* p, int a) {\n-  int n = Lookup(*p, a);\n+  int n = Lookup(*p, a + 0);\n   return n;\n }\n');
      const stale = write('stale.diff', '--- a/src/a.cpp\n+++ b/src/a.cpp\n@@ -4,2 +4,2 @@\n-  int n = Other(*p, a);\n+  int n = Other(*p, a + 1);\n');
      const log = console.log;
      const err = console.error;
      console.log = () => {};
      console.error = () => {};
      try {
        assert.strictEqual(steeringMain(['--tree', root, '--patch', steer, '--addr', '00401000']), 1);
        assert.strictEqual(steeringMain(['--tree', root, '--patch', clean, '--addr', '00401000']), 0);
        assert.strictEqual(steeringMain(['--tree', root, '--patch', stale, '--addr', '00401000']), 2);
        assert.strictEqual(steeringMain(['--tree', root, '--patch', steer]), 2);
      } finally {
        console.log = log;
        console.error = err;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('steering lint: tree mode', () => {
  const record = (address: string, text: string) => JSON.stringify({
    address, kind: 'pin', evidence: 'abc', captured: '2026-11-20', note: 'test',
    members: [{ address, name: 'NS::f', file: 'src/a.cpp', scope: ['NS'], text, params: ['p'], siteHash: '', bindings: [] }],
  });

  it('counts the spellings tree-wide, skips the definition header and Storm\'s volatile fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'steer-'));
    try {
      const files: Record<string, string> = {
        'inc/platform.h': PLATFORM_H,
        'src/a.cpp': '__attribute__((noinline)) void f() { volatile int x = 0; g(x); }\nD2_FORCEINLINE int h() { return 1; }\n',
        'storm/s.h': 'struct S { volatile long nRef; };\nvoid k() { int y = *(volatile int*)&gY; }\n',
      };
      for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); }
      const c = countTree(root, Object.keys(files), vocabulary());
      assert.strictEqual(c.noinline.total, 1);
      assert.strictEqual(c.forceinline.total, 1);
      assert.strictEqual(c.volatile.total, 2);
      assert.deepStrictEqual(c.volatile.byFile, { 'src/a.cpp': 1, 'storm/s.h': 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lints every pin, keys findings by content, and judges them against the baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'steer-'));
    try {
      const text = 'int f(int* p) {\n    int v = *p;\n    return Lookup(gTable, v);\n}';
      mkdirSync(join(root, 'ratchet/fn'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/a.cpp'), `namespace NS {\n// 1.14d: 00401000\n${text}\n}\n`);
      writeFileSync(join(root, 'ratchet/fn/00401000.json'), record('00401000', text));
      const e = treeEnv(root);
      const r = lintSteeringTree(e);
      assert.strictEqual(r.pinCount, 1);
      const temps = r.pins.filter(p => p.check === 'single-use-temp');
      assert.strictEqual(temps.length, 1);
      assert.ok(!temps[0].key.includes(':'), 'the key carries no line number');
      const bl = join(root, 'baseline.json');
      saveSteeringBaseline(bl, r.counters, r.pins);
      const b = loadSteeringBaseline(bl)!;
      assert.ok(temps[0].key in b.pins);
      // The same finding on another line keeps its key.
      const moved = keyPinFindings(r.pins.map(p => ({ ...p, line: p.line + 7 })));
      assert.deepStrictEqual(moved.map(p => p.key), r.pins.map(p => p.key));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
