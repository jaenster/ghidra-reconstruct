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
import { assertableStructs, classesWithBases, compilerAvailable, compilerLayout, simulatedLayout } from '../lint/checks/layout.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('defect lint: undersized-global-argument', () => {
  const types = [
    { name: 'D2LRUCacheStrc', kind: 'STRUCTURE', size: 0x34, fields: [] },
    { name: 'D2SmallStrc', kind: 'STRUCTURE', size: 8, fields: [] },
  ];
  const globalsH = [
    'extern uint8_t gcsErrorHandlerList;', 'extern CRITICAL_SECTION gcsGood;', 'extern uint8_t gPad[0x40];',
    'extern uint8_t gCache;', 'extern uint8_t* gpBuf;', 'extern uint8_t gGuid;', 'extern unsigned int grcText;',
    'extern D2SmallStrc gSmall;', 'extern uint8_t gRow[24];',
  ].join('\n') + '\n';

  it('reports a one-byte global handed to InitializeCriticalSection, once per global with every site counted', () => {
    const fs = lint('undersized-global-argument', { types, files: {
      'globals.h': globalsH,
      'a.cpp': `void f() {
    InitializeCriticalSection((LPCRITICAL_SECTION)&gcsErrorHandlerList);
    EnterCriticalSection(
        (LPCRITICAL_SECTION)&gcsErrorHandlerList);
}`,
    } });
    assert.deepStrictEqual(subjects(fs), ['gcsErrorHandlerList']);
    assert.match(fs[0].detail, /_RTL_CRITICAL_SECTION is 24 bytes, gcsErrorHandlerList is 1-byte uint8_t/);
    assert.match(fs[0].detail, /2 sites/);
  });

  it('sizes SDK objects without a snapshot, through raw pointer casts and vtable calls', () => {
    const fs = lint('undersized-global-argument', { files: {
      'globals.h': globalsH,
      'a.cpp': `void f(IUnknown* p, void** out) {
    SetRect((LPRECT)&grcText, 0, 0, 1, 1);
    p->lpVtbl->QueryInterface(p, (GUID*)&gGuid, out);
}`,
    } });
    assert.deepStrictEqual(subjects(fs), ['gGuid', 'grcText']);
  });

  it('takes the pointee from the callee prototype when the argument is not cast', () => {
    const fs = lint('undersized-global-argument', { types, files: {
      'globals.h': globalsH,
      'cache.h': 'void CACHE_Init(D2LRUCacheStrc* pCache);\n',
      'a.cpp': 'void f() { CACHE_Init(&gCache); }',
    } });
    assert.deepStrictEqual(subjects(fs), ['gCache']);
    assert.match(fs[0].detail, /52 bytes, gCache is 1-byte/);
  });

  it('measures &g[k] from the element it starts at', () => {
    const fs = lint('undersized-global-argument', { types, files: {
      'globals.h': globalsH,
      'a.cpp': 'void f() { InitializeCriticalSection((LPCRITICAL_SECTION)&gRow[0]); GetSystemTime((LPSYSTEMTIME)&gRow[16]); }',
    } });
    assert.deepStrictEqual(subjects(fs), ['gRow']);
    assert.match(fs[0].detail, /16 bytes, gRow is 8-byte/);
  });

  it('says to suspect the parameter when the global is a typed struct', () => {
    const fs = lint('undersized-global-argument', { types, files: {
      'globals.h': globalsH,
      'a.cpp': 'void f() { SRP_ClientKeyExchange((D2LRUCacheStrc*)&gSmall); }',
    } });
    assert.deepStrictEqual(subjects(fs), ['gSmall']);
    assert.match(fs[0].detail, /suspect the parameter type/);
  });

  it('ignores a right-sized global, a big enough array, byte and void views, a pointer passed by value, and a shadowing local', () => {
    assert.deepStrictEqual(lint('undersized-global-argument', { types, files: {
      'globals.h': globalsH,
      'a.cpp': `void f() {
    InitializeCriticalSection(&gcsGood);
    InitializeCriticalSection((LPCRITICAL_SECTION)gPad);
    ReadFile(h, (LPVOID)&gCache, 0x10, 0, 0);
    SStrCopy((char*)&gCache, src, 8);
    InitializeCriticalSection((LPCRITICAL_SECTION)gpBuf);
    PCRITICAL_SECTION p = (PCRITICAL_SECTION)&gCache;
}
void g() { CRITICAL_SECTION gcsErrorHandlerList; InitializeCriticalSection((LPCRITICAL_SECTION)&gcsErrorHandlerList); }`,
    } }), []);
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

describe('defect lint: truncated-string-global, address used as a string', () => {
  // The v1026 shape: "DATA\\GLOBAL\\OBJECTS" emitted as one uint8_t, its address stored in a
  // reused local and fed to a %s - COMPOSIT_BuildCofPath, D2Common/COMPOSIT/Composit.cpp.
  const globalsH = 'extern uint8_t gszDirObjects;\nextern uint32_t gdwCloseParen;\nextern uint8_t gbFlag;\n';
  const composit = `void COMPOSIT_BuildCofPath(char* szOutCofPath, int nKind, uint32_t* pszTypeToken, uint32_t* pszModeToken, uint32_t* pszWeaponToken) {
    uint32_t nTypeToken;
    if (nKind == 0) {
        nTypeToken = (uint32_t)"DATA\\\\GLOBAL\\\\CHARS";
        /* LPCSTR param_2 for wsprintfA */ wsprintfA(szOutCofPath, "%s\\\\%s\\\\COF\\\\%s%s%s.COF", nTypeToken, pszTypeToken, pszTypeToken, pszModeToken, pszWeaponToken);
        return;
    }
    if (nKind == 2) {
        nTypeToken = (uintptr_t)&gszDirObjects;
        /* LPCSTR param_2 for wsprintfA */ wsprintfA(szOutCofPath, "%s\\\\%s\\\\COF\\\\%s%s%s.COF", nTypeToken, pszTypeToken, pszTypeToken, pszModeToken, pszWeaponToken);
        return;
    }
}`;

  it('reports the address stored in a local and handed to a %s (the old gszDirObjects)', () => {
    const fs = lint('truncated-string-global', { files: { 'globals.h': globalsH, 'Composit.cpp': composit } });
    assert.deepStrictEqual(subjects(fs), ['gszDirObjects']);
    assert.match(fs[0].detail, /via nTypeToken: wsprintfA %s/);
  });

  it('reports the address passed straight to a string function or a char* parameter', () => {
    const fs = lint('truncated-string-global', { files: {
      'globals.h': globalsH,
      'a.h': 'void BuildPath(int n, const char* szDir);',
      'a.cpp': 'void f(char* d) { SStrCopy(d, (char*)(uintptr_t)&gszDirObjects, 0x104); }\nvoid g() { BuildPath(1, (LPCSTR)(int)&gbFlag); }',
    } });
    assert.deepStrictEqual(subjects(fs), ['gbFlag', 'gszDirObjects']);
  });

  it('ignores a string that ends inside the scalar, a non-string argument, and a local re-stored before use', () => {
    const fs = lint('truncated-string-global', {
      globals: [{ name: 'gdwCloseParen', address: 0x6cf324, size: 4, value: 0x29 }],
      files: {
        'globals.h': globalsH,
        'a.cpp': `void f(char* d, int n) {
    SStrPack(d, (char*)&gdwCloseParen, n);
    memset(&gbFlag, 0, 1);
    uint32_t t = (uintptr_t)&gszDirObjects;
    t = n;
    sprintf(d, "%s", t);
    sprintf(d, "%d", (int)&gszDirObjects);
}`,
      },
    });
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
  it('counts the code* type, not the word: a comment, a string, a field named code (round R)', () => {
    // A plate comment saying "code-page locks" once read as a `code` token to a counter
    // over text; the checks read the AST, where only a TYPE named code is Ghidra's.
    const fs = lint('argless-indirect-call', { files: {
      'a.cpp': `// locale and code-page locks (__freefls); (**(code **)x)() in a comment
/* code */
void f(D2ItemTypesTxt* p, int i) {
    int n = p->code;
    Log("(**(code **)x)()");
    g(n, gsItemsTable.pItems[p[i].code].dwGemOffset);
}`,
    } });
    assert.deepStrictEqual(fs, []);
  });

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

  // Ghidra names one struct per Storm template instantiation; the TU must spell each as C++ does.
  it('asserts template-id structs under their C++ spelling, and nothing that is not one template-id', () => {
    const f = [{ name: 'x', dataType: 'int', offset: 0, size: 4 }];
    const a = assertableStructs([
      { name: 'TSHashTable<CELLIST,HASHKEY_NONE>', size: 40, fields: f },
      { name: 'TSExplicitList<CELLIST,-572662307>', size: 12, fields: f },
      { name: 'TSList<TCELENTRY,TSGetLink<TCELENTRY>>', size: 12, fields: f },
      { name: 'TSExportTableSync<SGAMEDATA,HSGAMEDATA__*,HSGAMEDATALOCK__*,CCritSect,0>', size: 104, fields: f },
      { name: 'A<B>;int y', size: 4, fields: f },
      { name: 'A<B', size: 4, fields: f },
      { name: 'A<B>*', size: 4, fields: f },
      { name: '_Tmpl<int>', size: 4, fields: f },
    ] as any);
    assert.deepStrictEqual(a.map(s => [s.name, s.spelling]), [
      ['TSHashTable<CELLIST,HASHKEY_NONE>', 'TSHashTable<CELLIST, HASHKEY_NONE>'],
      ['TSExplicitList<CELLIST,-572662307>', 'TSExplicitList<CELLIST, -572662307>'],
      ['TSList<TCELENTRY,TSGetLink<TCELENTRY>>', 'TSList<TCELENTRY, TSGetLink<TCELENTRY>>'],
      ['TSExportTableSync<SGAMEDATA,HSGAMEDATA__*,HSGAMEDATALOCK__*,CCritSect,0>',
        'TSExportTableSync<SGAMEDATA, HSGAMEDATA__*, HSGAMEDATALOCK__*, CCritSect, 0>'],
    ]);
  });

  it('the compiler judges a template-id struct: a base, a vptr, offsetof through an alias', { skip: !compilerAvailable() }, () => {
    const root = mkdtempSync(join(tmpdir(), 'layout-tmpl-'));
    try {
      writeFileSync(join(root, 'd2_platform.h'), '#pragma once\n#include <stdint.h>\n');
      writeFileSync(join(root, 'stpl.h'), `#pragma once
struct CELLIST { uint32_t dwFlags; };
class HASHKEY_NONE { };
template<class T> class TSLink { public: TSLink<T>* m_prevlink; int32_t m_next; };
template<class T, int OFFSET> class TSExplicitList { public: int32_t m_linkoffset; TSLink<T> m_terminator; };
template<class T, class TKey> class TSHashTable {
public:
  virtual void InternalDelete(T* p);
  TSExplicitList<T, -572662307> m_fulllist;
  uint32_t m_fullness;
};
template<class T, class TKey, int N> class TSHashTableReuse : public TSHashTable<T, TKey> { public: uint32_t m_chunksize; };
`);
      const r = compilerLayout(root, [
        { name: 'TSHashTable<CELLIST,HASHKEY_NONE>', size: 20, fields: [
          { name: 'm_fulllist', offset: 4, size: 12 }, { name: 'm_fullness', offset: 16, size: 4 }] },
        { name: 'TSExplicitList<CELLIST,-572662307>', size: 12, fields: [
          { name: 'm_linkoffset', offset: 0, size: 4 }, { name: 'm_terminator', offset: 8, size: 8 }] },
        { name: 'TSHashTableReuse<CELLIST,HASHKEY_NONE,0>', size: 28, fields: [
          { name: 'm_fullness', offset: 16, size: 4 }, { name: 'm_chunksize', offset: 20, size: 4 }] },
      ]);
      assert.ok(r);
      assert.deepStrictEqual(r.uncheckable, []);
      assert.deepStrictEqual(r.sizeBad, ['TSHashTableReuse<CELLIST,HASHKEY_NONE,0>']);
      assert.deepStrictEqual(r.offBad, ['TSExplicitList<CELLIST,-572662307>.m_terminator']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('defect lint: base classes', () => {
  const header = `#pragma once
class HASHKEY_NONE { public: uint8_t f; };
template<class T> class TSLink { public: TSLink<T>* m_prevlink; int32_t m_next; };
template<class T, class TKey> class TSHashObject { public: uint32_t m_hashval; TSLink<T> m_linktoslot; TKey m_key; };
template<class T, class TKey> class TSHashTable { public: void* pVtable; uint32_t nSlotMask; };
template<class T, class TKey, int N> class TSHashTableReuse : public TSHashTable<T, TKey> { public: uint32_t nChunkSize; };
struct __attribute__((packed)) CELLIST : public TSHashObject<CELLIST, HASHKEY_NONE> { uint32_t dwFlags; };
struct HOLDER { TSHashTable<CELLIST, HASHKEY_NONE> super_TSHashTable; uint32_t n; };
`;

  it('finds the classes the tree declares with a base, and their bases, a template by its name', () => {
    const files = [parseSource('stpl.h', header)];
    assert.deepStrictEqual(files[0].parseErrors, []);
    assert.deepStrictEqual([...classesWithBases(files)].map(([d, b]) => [d, [...b]]).sort(),
      [['CELLIST', ['TSHashObject']], ['TSHashTableReuse', ['TSHashTable']]]);
  });

  it('asserts a base component\'s members through the derived class, a plain super_ member as a member', { skip: !compilerAvailable() }, () => {
    const root = mkdtempSync(join(tmpdir(), 'layout-base-'));
    try {
      writeFileSync(join(root, 'd2_platform.h'), '#pragma once\n#include <stdint.h>\n');
      writeFileSync(join(root, 'stpl.h'), header);
      const object = { name: 'TSHashObject<CELLIST,HASHKEY_NONE>', size: 0x10, fields: [
        { name: 'm_hashval', offset: 0, size: 4 }, { name: 'm_linktoslot', offset: 4, size: 8 }, { name: 'm_key', offset: 12, size: 1 }] };
      const table = { name: 'TSHashTable<CELLIST,HASHKEY_NONE>', size: 8, fields: [
        { name: 'pVtable', offset: 0, size: 4 }, { name: 'nSlotMask', offset: 4, size: 4 }] };
      const bases = classesWithBases([parseSource('stpl.h', header)]);
      const reuse = (baseAt: number, chunkAt: number) => ({ name: 'TSHashTableReuse<CELLIST,HASHKEY_NONE,0>', size: 12, fields: [
        { name: 'super_TSHashTable', dataType: table.name, offset: baseAt, size: 8 }, { name: 'nChunkSize', offset: chunkAt, size: 4 }] });
      const r = compilerLayout(root, [
        // The element: its base's members are named through it, wherever they sit in the base.
        { ...object, fields: [...object.fields.slice(0, 2), { name: 'm_key', offset: 13, size: 1 }] }, table,
        { name: 'CELLIST', size: 0x14, fields: [
          { name: 'super_TSHashObject', dataType: object.name, offset: 0, size: 0x10 }, { name: 'dwFlags', offset: 0x10, size: 4 }] },
        // Ghidra puts the derived class's own member 4 bytes late.
        reuse(0, 12),
        { name: 'HOLDER', size: 12, fields: [
          { name: 'super_TSHashTable', dataType: table.name, offset: 0, size: 8 }, { name: 'n', offset: 8, size: 4 }] },
      ], bases);
      assert.ok(r);
      assert.deepStrictEqual(r.uncheckable, []);
      assert.deepStrictEqual(r.sizeBad, []);
      assert.deepStrictEqual(r.offBad, [
        'TSHashObject<CELLIST,HASHKEY_NONE>.m_key',
        'CELLIST.super_TSHashObject.m_key',
        'TSHashTableReuse<CELLIST,HASHKEY_NONE,0>.nChunkSize',
      ]);
      // A base Ghidra puts anywhere but offset 0 is no base by the rule: the tree's base and
      // Ghidra's component disagree, and that is the finding - not its members, which the
      // derived class does not have under that name.
      const moved = compilerLayout(root, [table, reuse(4, 8)], bases);
      assert.ok(moved);
      assert.deepStrictEqual(moved.uncheckable, []);
      assert.deepStrictEqual(moved.offBad, ['TSHashTableReuse<CELLIST,HASHKEY_NONE,0>.super_TSHashTable']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('defect lint: base classes in the layout check', () => {
  it('reads which classes have a base from the tree it is run on', { skip: !compilerAvailable() }, () => {
    const root = mkdtempSync(join(tmpdir(), 'layout-base-run-'));
    try {
      const text = `#pragma once
template<class T> class TSHashTable { public: void* pVtable; uint32_t nSlotMask; };
struct CELLIST : public TSHashTable<CELLIST> { uint32_t dwFlags; };
`;
      writeFileSync(join(root, 'd2_platform.h'), '#pragma once\n#include <stdint.h>\n');
      writeFileSync(join(root, 'stpl.h'), text);
      const tree = treeFromFiles(root, [parseSource('stpl.h', text)]);
      const snap = buildSnapshot('', [], [
        { kind: 'STRUCTURE', name: 'TSHashTable<CELLIST>', size: 8, fields: [
          { name: 'pVtable', offset: 0, size: 4 }, { name: 'nSlotMask', offset: 4, size: 4 }] },
        // Ghidra puts the base 4 bytes in: the tree's base is not where Ghidra's component is.
        { kind: 'STRUCTURE', name: 'CELLIST', size: 12, fields: [
          { name: 'super_TSHashTable', dataType: 'TSHashTable<CELLIST>', offset: 4, size: 8 }, { name: 'dwFlags', offset: 8, size: 4 }] },
      ]);
      const r = runChecks(tree, snap, ALL_CHECKS.filter(c => c.id === 'struct-packing-mismatch'));
      assert.deepStrictEqual(r.findings.map(f => `${f.subject}: ${f.detail}`), [
        "CELLIST: field 'super_TSHashTable' is not where Ghidra puts it",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('defect lint: functions inside template declarations', () => {
  it('a member specialization is a checked function, named by its full template-id', () => {
    const files = [parseSource('Storm/H/stpl_CELLIST.cpp', `
template<> CELLIST* TSHashTable<CELLIST, HASHKEY_NONE>::Ptr(TSHashTable<CELLIST, HASHKEY_NONE>* pThis, uint32_t h) { return 0; }
template<> SGAMEDATA* TSHashTable<SGAMEDATA, HASHKEY_NONE>::Ptr(TSHashTable<SGAMEDATA, HASHKEY_NONE>* pThis, uint32_t h) { return 0; }
template<> struct W<true> { int f() { return 1; } };
`)];
    assert.deepStrictEqual(files[0].parseErrors, []);
    const t = treeFromFiles('/nonexistent', files);
    assert.deepStrictEqual(t.functions.map(f => f.qualifiedName), [
      'TSHashTable<CELLIST, HASHKEY_NONE>::Ptr', 'TSHashTable<SGAMEDATA, HASHKEY_NONE>::Ptr', 'W<true>::f',
    ]);
  });
});

describe('defect lint: array-index-range', () => {
  // The v1026 SStrHash, Storm/Source/SSTR.cpp: a sixteen-dword table Ghidra sized to five
  // because two stray labels sat inside it.
  const sstrHash = `uint32_t __stdcall SStrHash(char * pszText, byte bCaseSensitive, uint32_t nSeed) {
    // Static local variables (originally global data)
    static int gnHashLowTable[5] = { 0x486e26ee, -0x2355e94d, -0x1e6e7111, 0x202dafdb, 0x341c7dc7 };

    uint32_t nChar;
    if (pszText) {
      int nAccum;
      if (!nSeed) {
        nSeed = 0x7fed7fed;
      }

      nChar = (uint32_t)(byte)*pszText;
      nAccum = -0x11111112;
      if (!(bCaseSensitive & 1)) {
        while (nChar) {
          pszText++;
          if (nChar - 0x61 < 0x1a) {
            nChar -= 0x20;
          }
          if (nChar == 0x2f) {
            nChar = 0x5c;
          }

          nSeed = nSeed + nAccum ^ gnHashLowTable[nChar >> 4] - gnHashLowTable[nChar & 0xf];
          nAccum = nAccum * 0x21 + nChar + 3 + nSeed;
          nChar = (uint32_t)(byte)*pszText;
        }
      } else {
        while (nChar) {
          nSeed = nSeed + nAccum ^ gnHashLowTable[nChar >> 4] - gnHashLowTable[nChar & 0xf];
          pszText++;
          nAccum = nAccum * 0x21 + nChar + 3 + nSeed;
          nChar = (uint32_t)(byte)*pszText;
        }
      }
      if (nSeed) {
        return nSeed;
      }

      nSeed = 1;
      return nSeed;
    }

    SErr::SErrSetLastError(0x57);
    return 0;
}`;

  it('reports the old SStrHash table read with a mask wider than it', () => {
    const fs = lint('array-index-range', { files: { 'SSTR.cpp': sstrHash } });
    assert.deepStrictEqual(subjects(fs), ['gnHashLowTable', 'gnHashLowTable']);
    assert.match(fs[0].detail, /\[<= 15\] \(& 0xf\) but declared int\[5\] \(static local\)/);
    const fixed = sstrHash.replace('gnHashLowTable[5]', 'gnHashLowTable[16]');
    assert.deepStrictEqual(lint('array-index-range', { files: { 'SSTR.cpp': fixed } }), []);
  });

  it('bounds an index by a loop, a guard on the variable, a switch case and a modulus', () => {
    const fs = lint('array-index-range', { files: {
      'globals.h': 'extern uint gaTaskHeads[28];\nextern int gaLoop[4];\nextern int gaCase[3];\nextern int gaMod[6];\n',
      'a.cpp': `void f(uint n, int k) {
    for (int i = 0; i < 5; i++) { gaLoop[i] = 0; }
    if (n < 0x20) { use(gaTaskHeads[n]); n = 0; }
    switch (k) { case 1: case 3: gaCase[k] = 1; break; }
    use(gaMod[n % 8]);
}`,
    } });
    assert.deepStrictEqual(subjects(fs), ['gaCase', 'gaLoop', 'gaMod', 'gaTaskHeads']);
  });

  it('ignores a MOVZX-width mask, a guard on the masked expression, one-past-the-end, a flat 2-D access and a fitting loop', () => {
    const fs = lint('array-index-range', { files: {
      'globals.h': 'extern int gaSound[28];\nextern byte gaDir[8];\nextern int* gaHash[128][6];\nextern int gaFit[5];\n',
      'a.cpp': `void f(uint32_t nMode, int d, int g) {
    if ((nMode & 0xf) < 0xe) { use(gaSound[(nMode & 0xf) * 2 + 1]); nMode = 0; }
    use(gaDir[d & 0xff]);
    use(&gaFit[5]);
    use(gaHash[0x55][(g & 0x7f) + 2]);
    for (int i = 0; i < 5; i++) { gaFit[i] = 0; }
}`,
    } });
    assert.deepStrictEqual(fs, []);
  });

  it('leaves a constant index on a stack array to oob-local-access, but ranges one', () => {
    const fs = lint('array-index-range', { files: {
      'a.cpp': `void f(int n) {
    char szLine[1022];
    szLine[1030] = 0;
    if (n < 0x3ff) { szLine[n] = 10; szLine[n + 1] = 0; }
}`,
    } });
    assert.deepStrictEqual(fs.map(f => f.detail.split(' (')[0]), ['szLine[<= 1022]', 'szLine[<= 1023]']);
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

describe('defect lint: untyped-virtual-call', () => {
  it('reports the fallback virtual call that drops the receiver, with its slot', () => {
    const fs = lint('untyped-virtual-call', { files: {
      'a.cpp': [
        'void f(void* pThis, int n) {',
        '    (**(code**)(char*)*(void**)(uintptr_t)pThis)(n);',
        '    x = (**(code**)((char*)*(void**)(uintptr_t)pThis + 4))(n, 0, 8);',
        '}',
      ].join('\n'),
    } });
    assert.deepStrictEqual(subjects(fs), ['pThis', 'pThis']);
    assert.deepStrictEqual(fs.map(f => f.detail).sort(), [
      'slot 0 (+0x0) called with 1 argument(s), receiver not passed',
      'slot 1 (+0x4) called with 3 argument(s), receiver not passed',
    ]);
  });

  it('ignores a COM call that passes the object itself, a typed dispatch, and a table call', () => {
    const fs = lint('untyped-virtual-call', { files: {
      'a.cpp': [
        'void f(uint32_t* p, ListBox* pList, void** arr) {',
        '    r = (**(code**)(char*)*(void**)(uintptr_t)*p)((uint32_t*)*p, 1);',
        '    pList->pVtable->Draw(pList);',
        '    (**(code**)((char*)arr + 8))(1);',
        '}',
      ].join('\n'),
    } });
    assert.deepStrictEqual(fs, []);
  });
});

describe('defect lint: raw-address-initializer', () => {
  const snap = [
    { name: 'gsAutoMapSeed', address: 0x96c8c8, size: 8 },
    { name: 'psDataTableSeed', address: 0x96c8d0, size: 4 },
    { name: 'gAncientsCloudSeed', address: 0x7b5680, size: 8 },
    { name: 'gpAncientsCloudSeed', address: 0x7b5688, size: 4 },
    { name: 'gaSeedTable', address: 0x7b5690, size: 8 },
    { name: 'RTTI_Complete_Object_Locator', address: 0x6fffc0, size: 20 },
    { name: 'RTTI_Complete_Object_Locator', address: 0x700008, size: 20 },
    { name: 'vftable_meta_ptr', address: 0x700100, size: 4 },
    { name: 'gnCount', address: 0x700200, size: 4 },
    { name: 'gNotEmitted', address: 0x700300, size: 4 },
  ];
  const globalsH = 'extern D2SeedStrc gsAutoMapSeed;\nextern D2SeedStrc gAncientsCloudSeed;\n';

  it('reports a cast literal in globals*.cpp, a bare literal in a pointer array, and a static local', () => {
    const fs = lint('raw-address-initializer', { globals: snap, files: {
      'globals.h': globalsH,
      'globals.D2Common.cpp': 'D2SeedStrc gsAutoMapSeed;\nD2SeedStrc * psDataTableSeed = (D2SeedStrc *)0x0096c8c8;\n' +
        'D2SeedStrc * gaSeedTable[2] = { 0x007b5680, 0 };\n',
      'globals.cpp': 'D2SeedStrc gAncientsCloudSeed;\n',
      'D2Client/View.cpp': 'void f() {\n    static D2SeedStrc * gpAncientsCloudSeed = (D2SeedStrc *)0x007b5680;\n}\n',
    } });
    assert.deepStrictEqual(subjects(fs), ['gaSeedTable', 'gpAncientsCloudSeed', 'psDataTableSeed']);
    assert.match(fs.find(f => f.subject === 'psDataTableSeed')!.detail, /&gsAutoMapSeed/);
  });

  it('ignores a resolved reference, a shared name, an interior address, an integer slot, a non-symbol owner and a symbol the tree lacks', () => {
    assert.deepStrictEqual(lint('raw-address-initializer', { globals: snap, files: {
      'globals.h': globalsH,
      'globals.cpp': 'D2SeedStrc gsAutoMapSeed;\nD2SeedStrc gAncientsCloudSeed;\n' +
        'D2SeedStrc * psDataTableSeed = (D2SeedStrc *)&gsAutoMapSeed;\n' +
        'namespace A { void* vftable_meta_ptr = (void*)0x006fffc0; }\n' +
        'D2SeedStrc * gpAncientsCloudSeed = (D2SeedStrc *)0x007b5684;\n' +
        'int gnCount = 0x0096c8c8;\n' +
        'void * PTR_DAT_00396304 = (void*)0x0096c8c8;\n',
      'globals.Fog.cpp': 'D2SeedStrc * gaSeedTable[1] = { (D2SeedStrc *)0x00700300 };\n',
    } }), []);
  });

  it('only looks at globals*.cpp and static locals', () => {
    assert.deepStrictEqual(lint('raw-address-initializer', { globals: snap, files: {
      'globals.h': globalsH + 'extern D2SeedStrc * psDataTableSeed;\n',
      'globals.cpp': 'D2SeedStrc gsAutoMapSeed;\nD2SeedStrc gAncientsCloudSeed;\n',
      'D2Client/View.cpp': 'void f() {\n    D2SeedStrc * gpAncientsCloudSeed = (D2SeedStrc *)0x007b5680;\n}\n',
    } }), []);
  });
});

describe('defect lint: raw-address-argument', () => {
  const snap = [
    { name: 'gStormCmdListHeadSlash', address: 0x74c498, size: 12 },
    { name: 'gLogMessageQueueHead', address: 0x75e868, size: 12 },
    { name: 'gMpqArchiveList', address: 0x708354, size: 12 },
    { name: 'RTTI_Complete_Object_Locator', address: 0x6fffc0, size: 20 },
    { name: 'RTTI_Complete_Object_Locator', address: 0x700008, size: 20 },
    { name: 'gNotEmitted', address: 0x700300, size: 4 },
    { name: 'gnCurrentTimestamp', address: 0x989680, size: 4 },
  ];
  const globalsH = 'extern D2StormListHead gStormCmdListHeadSlash;\nextern D2StormListHead gLogMessageQueueHead;\n' +
    'extern D2StormListHead gMpqArchiveList;\n';
  const globalsCpp = 'D2StormListHead gStormCmdListHeadSlash;\nD2StormListHead gLogMessageQueueHead;\nD2StormListHead gMpqArchiveList;\n' +
    'int gnCurrentTimestamp;\n';

  it('reports a literal argument, a cast literal argument once, and a pointer cast outside a call', () => {
    const fs = lint('raw-address-argument', { globals: snap, files: {
      'globals.h': globalsH,
      'globals.cpp': globalsCpp,
      'Global/Global.cpp': 'void StaticFini_gStormCmdListSlash() {\n    SCMD_ClearList(0x74c498);\n}\n' +
        'void StaticFini_gLogMessageQueueHead() {\n    TeardownListFull((D2StormListHead *)(0x75e868));\n}\n' +
        'void f() {\n    D2StormListHead * p = (D2StormListHead *)0x00708354;\n}\n',
    } });
    assert.deepStrictEqual(subjects(fs), ['gLogMessageQueueHead', 'gMpqArchiveList', 'gStormCmdListHeadSlash']);
    assert.match(fs.find(f => f.subject === 'gStormCmdListHeadSlash')!.detail, /passes 0x0074c498.*&gStormCmdListHeadSlash/);
    assert.match(fs.find(f => f.subject === 'gMpqArchiveList')!.detail, /casts 0x00708354/);
  });

  it('ignores &name, an interior address, a shared name, a symbol the tree lacks, a decimal count, a plain integer and a header', () => {
    assert.deepStrictEqual(lint('raw-address-argument', { globals: snap, files: {
      'globals.h': globalsH,
      'globals.cpp': globalsCpp,
      'Global/Global.cpp': 'void f() {\n    SCMD_ClearList(&gStormCmdListHeadSlash);\n    g(0x74c49c);\n' +
        '    h((void *)0x006fffc0);\n    k(0x700300);\n    int n = 0x74c498;\n    m(5, 0x400);\n' +
        '    __aulldiv(t, 0, 10000000, 0);\n}\n',
      'Global/Inline.h': 'inline void g2() { SCMD_ClearList(0x74c498); }\n',
    } }), []);
  });
});

describe('defect lint: raw-address-arithmetic', () => {
  const snap = [
    { name: 'g_szMCPGameName', address: 0x799294, size: 16, dataType: 'char[16]' },
    { name: 'gbLanGameListEntryNamePadding2', address: 0x77bdc8, size: 59000, dataType: 'D2GameListEntryStrc[1000]' },
    { name: 'gnFlag', address: 0x700300, size: 4 },
    { name: 'gNotEmitted', address: 0x700400, size: 64 },
  ];
  const globalsCpp = 'char g_szMCPGameName[16];\nD2GameListEntryStrc gbLanGameListEntryNamePadding2[1000];\nint gnFlag;\n';

  it('reports the folded dst - src shapes: right of -, left of -, an interior addend and +=', () => {
    const fs = lint('raw-address-arithmetic', { globals: snap, files: {
      'globals.cpp': globalsCpp,
      'D2MCPClient/McpConnect.cpp': 'void f(int32_t pGameNameOut) {\n    pSrc[pGameNameOut - 0x799294] = ch;\n' +
        '    n = 0x799294 - (int)pszSrc;\n    nIndex = n * 0x3b + 0x77bdc9 - (int)pszSrc;\n    k += 0x77bdd9;\n}\n',
    } });
    assert.deepStrictEqual(fs.map(f => f.line), [2, 3, 4, 5]);
    assert.match(fs[2]!.detail, /0x0077bdc9, the original address of gbLanGameListEntryNamePadding2 \+ 1/);
  });

  it('reports a negated operand and a biased base one below a symbol', () => {
    const fs = lint('raw-address-arithmetic', { globals: snap, files: {
      'globals.cpp': globalsCpp,
      'D2Lang/StrTable/strtable.cpp': 'void f(char* e) {\n    n = (int)(p + (-0x799294 - (int)q));\n    m = e - 0x799293;\n}\n',
    } });
    assert.deepStrictEqual(fs.map(f => f.line), [2, 3]);
    assert.match(fs[1]!.detail, /g_szMCPGameName - 1/);
  });

  it('ignores the spelled form, a decimal, a non-data address, a word scalar interior, a symbol the tree lacks and other operators', () => {
    assert.deepStrictEqual(lint('raw-address-arithmetic', { globals: snap, files: {
      'globals.cpp': globalsCpp,
      'D2MCPClient/McpConnect.cpp': 'void f(int32_t p) {\n    q[p - (intptr_t)&g_szMCPGameName] = c;\n    n = p - 10064532;\n' +
        '    n = p + 0x400000;\n    n = p + 0x700301;\n    n = p + 0x700404;\n    n = p & 0x799294;\n    n = 0x10 + 0x799294;\n}\n',
    } }), []);
  });
});
