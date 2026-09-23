/**
 * The defect lint, check by check, on small trees: each positive case is the defect shape,
 * each negative is a shape the regex suite (docs/tools/lint.py) reported or missed wrongly -
 * a member write read as a read, a local that shadows a global, a multi-line call, a size in
 * the third argument, a string or comment that merely contains the pattern.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  ALL_CHECKS, buildSnapshot, keyFindings, newFindings, parseSource, runChecks, toBaseline, treeFromFiles,
  type Finding,
} from '../lint/index.js';
import { renderedLength } from '../lint/checks/buffers.js';
import { assertableStructs, simulatedLayout } from '../lint/checks/layout.js';
import type { SnapshotGlobal } from '../lint/snapshot.js';

interface Fixture {
  files: Record<string, string>;
  globals?: Array<Partial<SnapshotGlobal> & { name: string; address: number }>;
  types?: any[];
}

function lint(check: string, fx: Fixture): Finding[] {
  const files = Object.entries(fx.files).map(([p, src]) => parseSource(p, src));
  for (const f of files) assert.deepStrictEqual(f.parseErrors, [], `${f.path} did not parse`);
  const tree = treeFromFiles('/nonexistent', files);
  const globals: SnapshotGlobal[] = (fx.globals ?? []).map(g => ({
    addressText: g.address.toString(16).padStart(8, '0'), size: 1, xrefCount: 1, dataType: 'undefined', ...g,
  }));
  const snap = buildSnapshot('', globals, fx.types ?? []);
  const c = ALL_CHECKS.find(x => x.id === check)!;
  const r = runChecks(tree, snap, [c]);
  assert.deepStrictEqual(r.errors, []);
  return r.findings;
}

const subjects = (fs: Finding[]) => fs.map(f => f.subject).sort();

describe('defect lint: indexed-scalar-global', () => {
  const globalsH = 'extern uint8_t gTbl;\nextern uint8_t* gPtr;\nextern int gOther;\n';
  const snap = [{ name: 'gTbl', address: 0x700000, size: 1 }, { name: 'gOther', address: 0x701000, size: 4 },
    { name: 'gPtr', address: 0x702000, size: 4 }, { name: 'gEnd', address: 0x703000 }];

  it('reports a scalar indexed through its address, including across lines', () => {
    const fs = lint('indexed-scalar-global', { globals: snap, files: {
      'globals.h': globalsH,
      'a.cpp': 'void f(int i) {\n    x = (&gTbl)[i];\n    y = *(&gTbl\n        + 3);\n}',
    } });
    assert.deepStrictEqual(subjects(fs), ['gTbl']);
    assert.match(fs[0].detail, /2 indexed use/);
  });

  it('ignores a zero index, a pointer global indexed through the pointer, and a shadowing local', () => {
    const fs = lint('indexed-scalar-global', { globals: snap, files: {
      'globals.h': globalsH,
      'a.cpp': 'void f() { x = (&gTbl)[0]; y = &gPtr[4]; }\nvoid g(int i) { uint8_t gTbl[8]; z = (&gTbl)[i]; }',
    } });
    assert.deepStrictEqual(fs, []);
  });
});

describe('defect lint: oversized-global-write', () => {
  const types = [{ name: 'D2LRUCacheStrc', kind: 'STRUCTURE', size: 0x34, fields: [] }];
  const globalsH = 'extern uint8_t gPal;\nextern D2LRUCacheStrc gLru;\nextern uint8_t* gBuf;\nextern Unknown gOpaque;\n';

  it('reports a write past a primitive global, through a cast and across lines', () => {
    const fs = lint('oversized-global-write', { types, files: {
      'globals.h': globalsH,
      'a.cpp': 'void f() { memcpy((void*)&gPal, src,\n    0x30000); }',
    } });
    assert.deepStrictEqual(subjects(fs), ['gPal']);
    assert.match(fs[0].detail, /0x30000 into 1-byte/);
  });

  it('sizes a struct global from the snapshot instead of reporting it as underivable', () => {
    assert.deepStrictEqual(lint('oversized-global-write', { types, files: {
      'globals.h': globalsH, 'a.cpp': 'void f() { memset(&gLru, 0, 0x34); }',
    } }), []);
    const over = lint('oversized-global-write', { types, files: {
      'globals.h': globalsH, 'a.cpp': 'void f() { memset(&gLru, 0, sizeof(D2LRUCacheStrc) + 4); }',
    } });
    assert.deepStrictEqual(subjects(over), ['gLru']);
  });

  it('ignores a write THROUGH a pointer global, and flags an unsizable one for a human', () => {
    const fs = lint('oversized-global-write', { types, files: {
      'globals.h': globalsH, 'a.cpp': 'void f() { memset(gBuf, 0, 0x1000); memset(&gOpaque, 0, 8); }',
    } });
    assert.deepStrictEqual(subjects(fs), ['gOpaque']);
    assert.match(fs[0].detail, /size not derivable/);
  });
});

describe('defect lint: undersized-stack-buffer', () => {
  it('measures a format by its specification, and resolves the buffer per function', () => {
    assert.strictEqual(renderedLength('%02d', []).need, 3);
    assert.strictEqual(renderedLength('%s.dat', [{ kind: 'StringLiteral', value: 'palette' }]).need, 12);
    const fs = lint('undersized-stack-buffer', { files: {
      'a.cpp': `void small() { char buf[10]; sprintf(buf, "%d", 1); }
void big() { char buf[256]; sprintf(buf, "%s\\\\%s.dat", "DATA\\\\GLOBAL\\\\palette", "act1"); }
void bad() { char szPath[8]; sprintf(szPath, "%s.dat", "palette"); }
void pad() { char t[3]; sprintf(t, "%02d", n); }`,
    } });
    assert.deepStrictEqual(subjects(fs), ['szPath']);
  });

  it('measures a strided clear-loop by the cursor it stores through', () => {
    const fs = lint('undersized-stack-buffer', { files: {
      'a.cpp': `void f() {
    int i;
    char szMessage[2];
    const char* pSrc = "Player entering/leaving notifications are disabled.";
    char* pDst = szMessage;
    for (i = 0xd; i; i--) {
      *(uint32_t*)pDst = *(uint32_t*)pSrc;
      pSrc += 4;
      pDst += 4;
    }
}
void ok() {
    int i;
    uint16_t w[256];
    uint16_t* p = w;
    for (i = 0x80; i; i--) { p[0] = 0; p[1] = 0; p += 2; }
}`,
    } });
    assert.deepStrictEqual(subjects(fs), ['szMessage']);
    assert.match(fs[0].detail, /52 elements into szMessage\[2\]/);
  });
});

describe('defect lint: truncated-string-global', () => {
  const globalsH = 'extern uint8_t cSlash;\nextern int gnKey;\nextern char* pszName;\n';

  it('reports a primitive global used as a string', () => {
    const fs = lint('truncated-string-global', { files: {
      'globals.h': globalsH, 'a.cpp': 'void f() { Register((char*)&cSlash); }',
    } });
    assert.deepStrictEqual(subjects(fs), ['cSlash']);
  });

  it('ignores a shadowing local, a sized store, a pointer global, and the pattern in text', () => {
    const fs = lint('truncated-string-global', { files: {
      'globals.h': globalsH,
      'a.cpp': `void f(int cSlash) {
    Use((char*)&cSlash);                       // (char*)&cSlash in a comment
    *(uint16_t*)(char*)&gnKey = 5;
    Use((char*)&pszName);
    Log("(char*)&cSlash");
}`,
    } });
    assert.deepStrictEqual(fs, []);
  });
});

describe('defect lint: constant-shaped-address', () => {
  it('reports an image address shaped like a constant, and only a referenced one', () => {
    const fs = lint('constant-shaped-address', {
      globals: [
        { name: 'D2PoolManagerStrc_00800000', address: 0x800000, xrefCount: 3 },
        { name: 'gUnreferenced_00900000', address: 0x900000, xrefCount: 0 },
        { name: 'gOrdinary', address: 0x6fd123, xrefCount: 9 },
      ],
      files: {},
    });
    assert.deepStrictEqual(subjects(fs), ['D2PoolManagerStrc_00800000']);
  });
});

describe('defect lint: address-run-bound', () => {
  const globalsH = 'extern uint8_t gRunStart;\nextern uint8_t gNextSymbol;\nextern void* gpListHead;\n';

  it('reports a loop bounded by another global address, in any loop form and across lines', () => {
    const fs = lint('address-run-bound', { files: {
      'globals.h': globalsH,
      'a.cpp': `void f(uint8_t* p) {
    while (p <
           (uintptr_t)&gNextSymbol) { p++; }
    for (; (uintptr_t)p < (uintptr_t)&gNextSymbol; p++) {}
}`,
    } });
    assert.strictEqual(fs.length, 2);
  });

  it('ignores a fixed distance bound, a list sentinel, and a local of the same name', () => {
    const fs = lint('address-run-bound', { files: {
      'globals.h': globalsH,
      'a.cpp': `void f(uint8_t* p, void** q) {
    while (p < (uintptr_t)&gRunStart + 31) { p++; }
    while (*q != &gpListHead) { q = (void**)*q; }
    uint8_t gNextSymbol;
    while (p < &gNextSymbol) { p++; }
}`,
    } });
    assert.deepStrictEqual(fs, []);
  });
});

describe('defect lint: oversized-frame-write', () => {
  const frame = `
    #pragma pack(push, 1)
    struct __frame0_t {
      char szName;
      uint8_t local_1[259];
      int nMagic;
      uint32_t nCursor;
      uint8_t* pBuf;
    };
    #pragma pack(pop)
    static_assert(sizeof(void*) != 4 || sizeof(__frame0_t) == 272, "frame group");
    __frame0_t __frame0;`;

  it('reports a write off the end of a frame group, measured from the member it starts at', () => {
    const fs = lint('oversized-frame-write', { files: {
      'a.cpp': `void f(HANDLE h) {${frame}
    fread(&__frame0.szName, 1, 0x2000, fp);
    ReadFile(h, &__frame0.nMagic, 0x18, 0, 0);
}`,
    } });
    assert.deepStrictEqual(subjects(fs), ['__frame0.nMagic', '__frame0.szName']);
    assert.ok(fs.some(f => /at \+260/.test(f.detail)));
  });

  it('ignores a fitting write and a pointer member written through', () => {
    const fs = lint('oversized-frame-write', { files: {
      'a.cpp': `void f(HANDLE h) {${frame}
    ReadFile(h, &__frame0.nMagic, 8, 0, 0);
    memset(__frame0.pBuf, 0, 0x1000);
    SStrCopy(&__frame0.szName, src, 0x7fffffff);
}`,
    } });
    assert.deepStrictEqual(fs, []);
  });
});

describe('defect lint: unassigned-local-read', () => {
  it('reports a read of a never-assigned local, wherever it is declared', () => {
    const fs = lint('unassigned-local-read', { files: {
      'a.cpp': `int f(int a) {
    D2Srp* pConstructed;
    SRP_ConstructContext(a);
    if (a) {
          int nNested;
          g = nNested;
    }
    return (int)pConstructed;
}`,
    } });
    assert.deepStrictEqual(subjects(fs), ['nNested', 'pConstructed']);
  });

  it('reports an uninitialised pointer that is written THROUGH - that reads the pointer', () => {
    const fs = lint('unassigned-local-read', { files: {
      'a.cpp': `D2BoundingBoxStrc* f(int n) {
    D2BoundingBoxStrc* pBox;
    int* pOut;
    pBox->nLeft = n;
    pOut[2] = 0x40;
    *(int*)(pOut + 1) = n;
    return pBox;
}`,
    } });
    assert.deepStrictEqual(subjects(fs), ['pBox', 'pOut']);
  });

  it('ignores member and element stores, decay, sizeof, same-named members, comments, statics and va_start', () => {
    const fs = lint('unassigned-local-read', { files: {
      'a.cpp': `int f(D2UnitStrc* pUnit, const char* fmt, ...) {
    D2SHA1 state;
    char buf[8];
    uint16_t w[4];
    int eOwnerType;
    int nSize;
    static int nCalls;
    int nSplit;
    va_list args;
    state.h[0] = 0x67452301;
    sprintf(buf, "%d", 1);
    uint16_t* p = w;
    *p = 0;
    *(int*)&nSplit = 7;
    va_start(args, fmt);
    // eOwnerType is read here in a comment only
    return state.h[0] + buf[0] + w[1] + pUnit->eOwnerType + sizeof(nSize) + nCalls + nSplit + vcount(args);
}`,
    } });
    assert.deepStrictEqual(fs, []);
  });
});

describe('defect lint: argless-indirect-call', () => {
  it('reports both code* spellings, across lines, and names a typed table', () => {
    const fs = lint('argless-indirect-call', { files: {
      'globals.h': 'extern fpServerInitFunctions gaInitTable[52];\n',
      'a.cpp': `void f(int p, int i) {
    (**(code **)(p + 4))();
    (*(code *)p)(
    );
    (**(code **)((int)gaInitTable + i))();
}`,
    } });
    assert.strictEqual(fs.length, 3);
    assert.ok(fs.some(f => /TYPED TABLE gaInitTable/.test(f.detail)));
  });

  it('ignores a call with arguments, a typed pointer and a plain function', () => {
    const fs = lint('argless-indirect-call', { files: {
      'a.cpp': `void f(int p, void (*cb)()) {
    (**(code **)(p + 4))(p);
    cb();
    (*cb)();
    Refresh();
    Log("(**(code **)x)()");
}`,
    } });
    assert.deepStrictEqual(fs, []);
  });
});

describe('defect lint: uninitialised-send-buffer', () => {
  it('reports a buffer sent without ever being filled', () => {
    const fs = lint('uninitialised-send-buffer', { files: {
      'a.cpp': 'void f(D2ClientStrc* c) {\n    uint8_t byOpcode;\n    char szData[16];\n    D2NET_SendPacket(c, &byOpcode, 1);\n    SStrCopy(pOut, szData, 16);\n}',
    } });
    assert.deepStrictEqual(subjects(fs), ['byOpcode', 'szData']);
  });

  it('ignores a filled buffer, one a callee fills, and a copy DESTINATION', () => {
    const fs = lint('uninitialised-send-buffer', { files: {
      'a.cpp': `void f(D2ClientStrc* c, char* src) {
    uint8_t a;
    uint8_t b[4];
    int dst;
    uint8_t d[8];
    a = 0x59;
    D2NET_SendPacket(c, &a, 1);
    b[0] = 1;
    D2NET_SendPacket(c, b, 4);
    SStrCopy((char*)&dst, src, 0x7fffffff);
    FillHeader(d);
    D2NET_SendPacket(c, d, 8);
}`,
    } });
    assert.deepStrictEqual(fs, []);
  });
});

describe('defect lint: oversized-formatted-write', () => {
  it('reads the size from the right argument of each sink', () => {
    const fs = lint('oversized-formatted-write', { files: {
      'a.cpp': `void f(char* src) {
    char szErrorMsg[4];
    char acHex[2];
    char szFmt[4095];
    SStrPrintf(szErrorMsg, 0x200, "Unable to find room for unit %d", 1);
    SStrCopy(acHex, src, 7);
    __vsnprintf(szFmt, 0x1000, "%s", va);
}`,
    } });
    assert.deepStrictEqual(subjects(fs), ['acHex', 'szErrorMsg', 'szFmt']);
  });

  it('ignores the no-limit sentinel and a fitting size', () => {
    const fs = lint('oversized-formatted-write', { files: {
      'a.cpp': 'void f(char* s) {\n    char b[0x200];\n    SStrPrintf(b, 0x200, "%s", s);\n    SStrCopy(b, s, 0x7fffffff);\n}',
    } });
    assert.deepStrictEqual(fs, []);
  });
});

describe('defect lint: oob-local-access', () => {
  it('reports an index past the end, and a copy OUT of a too-small local', () => {
    const fs = lint('oob-local-access', { files: {
      'a.cpp': `void f(int* pDst) {
    int anNode[4];
    byte grid[2][3];
    anNode[4] = 1;
    grid[1][3] = 0;
    memcpy(pDst, anNode, 40);
}`,
    } });
    assert.strictEqual(fs.length, 3);
    assert.ok(fs.some(f => /out of anNode/.test(f.detail)));
  });

  it('ignores one-past-the-end addresses, pointer-element arrays sized right, and pointer params', () => {
    const fs = lint('oob-local-access', { files: {
      'a.cpp': `void f(short** apnStatValues, int* pQuickEntry) {
    byte* aLogFilePaths[21];
    int a[4];
    int* pEnd = &a[4];
    memset(aLogFilePaths, 0, 0x54);
    apnStatValues[4] = 0;
    x = apnStatValues[6];
    pQuickEntry[2] = 1;
    y = pQuickEntry[2];
}`,
    } });
    assert.deepStrictEqual(fs, []);
  });
});

describe('defect lint: struct-packing-mismatch', () => {
  it('skips compiler internals and alignment-8 padding, and simulates natural alignment', () => {
    const structs = [
      { name: 'D2TblHeader', size: 21, fields: [
        { name: 'wCrc', dataType: 'ushort', offset: 0, size: 2 },
        { name: 'nCount', dataType: 'uint', offset: 2, size: 4 }] },
      { name: '_CrtThing', size: 4, fields: [{ name: 'x', dataType: 'int', offset: 0 }] },
      { name: 'Vt', size: 56, alignment: 8, fields: [{ name: 'f', dataType: 'pointer', offset: 48, size: 4 }] },
    ];
    const a = assertableStructs(structs as any);
    assert.deepStrictEqual(a.map(s => [s.name, s.size]), [['D2TblHeader', 21], ['Vt', null]]);
    assert.match(simulatedLayout(structs as any).get('D2TblHeader')!, /nCount.*0x4.*0x2/);
  });
});

describe('defect lint: content-keyed baseline', () => {
  const src = `void f() {
    int x;
    g = x;
    (**(code **)(p + 4))();
    (**(code **)(p + 4))();
}`;
  const run = (text: string) => {
    const tree = treeFromFiles('/nonexistent', [parseSource('a.cpp', text)]);
    const r = runChecks(tree, null, ALL_CHECKS.filter(c => ['unassigned-local-read', 'argless-indirect-call'].includes(c.id)));
    return keyFindings(r.findings);
  };

  it('keeps every key when code above the findings moves them', () => {
    const before = run(src);
    const shifted = run('// a new comment\n\nvoid added() { h = 1; }\n' + src);
    assert.strictEqual(before.length, 3);
    assert.deepStrictEqual(shifted.map(f => f.key).sort(), before.map(f => f.key).sort());
    assert.notDeepStrictEqual(shifted.map(f => f.line), before.map(f => f.line));
    const base = toBaseline(before, ['unassigned-local-read', 'argless-indirect-call']);
    assert.deepStrictEqual(newFindings(shifted, base), []);
  });

  it('separates identical sites by ordinal and reports a genuinely new one', () => {
    const before = run(src);
    const keys = before.filter(f => f.check === 'argless-indirect-call').map(f => f.key);
    assert.strictEqual(new Set(keys).size, 2);
    const base = toBaseline(before, ['unassigned-local-read', 'argless-indirect-call']);
    const grown = run(src.replace('g = x;', 'g = x;\n    int y;\n    h = y;'));
    assert.deepStrictEqual(newFindings(grown, base).map(f => f.subject), ['y']);
  });
});
