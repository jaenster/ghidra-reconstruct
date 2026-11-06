/**
 * Include what you use: a file keeps the headers it names something from or needs a type
 * complete from, forward-declares what it only points at, and never sees a header it did
 * not reach before.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { pruneIncludes, type PrunableFile } from '../codegen/include-pruning.js';
import { quotedIncludePath } from '../codegen/path-case.js';

const GPP = 'i686-w64-mingw32-g++';
function haveGpp(): boolean {
  try { execFileSync(GPP, ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
}

function tree(files: Record<string, string>): Map<string, PrunableFile> {
  return new Map(Object.entries(files).map(([path, content]) => [path, { path, content }]));
}

function includesOf(files: Map<string, PrunableFile>, path: string): string[] {
  return files.get(path)!.content.split('\n').map(l => quotedIncludePath(l)?.path).filter((p): p is string => !!p);
}

const UNIT = {
  'Lib/Unit.h': `#pragma once
struct D2UnitStrc {
    int nUnitType;
    struct D2PathStrc * pPath;
};
int __stdcall UNITS_GetType(D2UnitStrc * pUnit);
`,
  'Lib/Path.h': `#pragma once
struct D2PathStrc {
    int nX;
};
`,
  'Lib/Room.h': `#pragma once
#include "Lib/Unit.h"
union D2RoomDataUnion {
    int nValue;
    D2UnitStrc * pUnit;
};
struct D2RoomStrc {
    D2UnitStrc sUnit;
    union D2RoomDataUnion * pData;
};
`,
};

describe('include pruning', () => {
  it('drops a header whose type the file only points at, and forward-declares it', () => {
    const files = tree({
      ...UNIT,
      'Game/Use.cpp': `#include "Game/Use.h"
#include "Lib/Unit.h"
#include "Lib/Room.h"

namespace Game {
int __fastcall Keep(D2UnitStrc * pUnit, D2RoomStrc * pRoom) {
    return pRoom != 0 && pUnit != 0;
}
}
`,
      'Game/Use.h': `#pragma once
struct D2UnitStrc;
struct D2RoomStrc;
namespace Game { int __fastcall Keep(D2UnitStrc * pUnit, D2RoomStrc * pRoom); }
`,
    });
    pruneIncludes(files);
    assert.deepStrictEqual(includesOf(files, 'Game/Use.cpp'), ['Game/Use.h']);
  });

  it('keeps the header of a type the file reaches into, and of a function it calls', () => {
    const files = tree({
      ...UNIT,
      'Game/Use.cpp': `#include "Lib/Room.h"
#include "Lib/Path.h"

int __fastcall Size(D2RoomStrc * pRoom) {
    return pRoom->sUnit.nUnitType + UNITS_GetType(&pRoom->sUnit);
}
`,
    });
    pruneIncludes(files);
    assert.deepStrictEqual(includesOf(files, 'Game/Use.cpp'), ['Lib/Room.h']);
  });

  it('makes the home of a type reached through a field chain direct, where it was reached before', () => {
    const files = tree({
      ...UNIT,
      'Lib/All.h': `#pragma once
#include "Lib/Unit.h"
#include "Lib/Path.h"
#include "Lib/Room.h"
`,
      'Game/Use.cpp': `#include "Lib/All.h"

int __fastcall X(D2UnitStrc * pUnit) {
    return pUnit->pPath->nX;
}
`,
    });
    pruneIncludes(files);
    assert.deepStrictEqual(includesOf(files, 'Game/Use.cpp'), ['Lib/Path.h', 'Lib/Unit.h']);
  });

  it('counts a by-value object, an array element, pointer arithmetic and sizeof as complete uses', () => {
    for (const body of [
      'D2PathStrc sPath; return sPath.nX;',
      'return (int)sizeof(D2PathStrc);',
      'return (int)((pPath + 1) - pPath);',
      'return pPath[2].nX;',
    ]) {
      const files = tree({
        ...UNIT,
        'Game/Use.cpp': `#include "Lib/Path.h"\n\nint __fastcall F(D2PathStrc * pPath) {\n    ${body}\n}\n`,
      });
      pruneIncludes(files);
      assert.deepStrictEqual(includesOf(files, 'Game/Use.cpp'), ['Lib/Path.h'], body);
    }
  });

  it('prunes a header too: a pointer field needs a declaration, a by-value field the definition', () => {
    const files = tree({
      ...UNIT,
      'Lib/Holder.h': `#pragma once
#include "Lib/Path.h"
#include "Lib/Room.h"
struct D2HolderStrc {
    D2PathStrc sPath;
    D2RoomStrc * pRoom;
};
`,
    });
    pruneIncludes(files);
    const holder = files.get('Lib/Holder.h')!.content;
    assert.deepStrictEqual(includesOf(files, 'Lib/Holder.h'), ['Lib/Path.h']);
    assert.match(holder, /^struct D2RoomStrc;$/m);
  });

  it('forward-declares a union with its own class-key', () => {
    const files = tree({
      ...UNIT,
      'Game/Use.cpp': `#include "Lib/Room.h"\n\nint __fastcall F(D2RoomDataUnion * pData) {\n    return pData != 0;\n}\n`,
    });
    pruneIncludes(files);
    assert.match(files.get('Game/Use.cpp')!.content, /^union D2RoomDataUnion;$/m);
  });

  it('reads a qualifier as a namespace or a type, never as a function of that name', () => {
    const files = tree({
      'Net/Debug.h': `#pragma once\nnamespace Debug { void __cdecl DEBUG_Trace(const char * sz); }\n`,
      'Game/Objects.h': `#pragma once\nvoid __fastcall Debug(int n);\n`,
      'Net/Use.cpp': `#include "Net/Debug.h"
#include "Game/Objects.h"

void __fastcall F() {
    Debug::DEBUG_Trace("x");
}
`,
    });
    pruneIncludes(files);
    assert.deepStrictEqual(includesOf(files, 'Net/Use.cpp'), ['Net/Debug.h']);
  });

  it('keeps every namespace an unqualified name is visible from, so lookup cannot rebind', () => {
    const files = tree({
      'A/Global.h': `#pragma once\nint __cdecl Draw(int n);\n`,
      'A/Inner.h': `#pragma once\nnamespace A { int __cdecl Draw(int n); }\n`,
      'B/Other.h': `#pragma once\nnamespace B { int __cdecl Draw(int n); }\n`,
      'A/Use.cpp': `#include "A/Global.h"
#include "A/Inner.h"
#include "B/Other.h"

namespace A {
int __cdecl Use() { return Draw(1); }
}
`,
    });
    pruneIncludes(files);
    assert.deepStrictEqual(includesOf(files, 'A/Use.cpp'), ['A/Global.h', 'A/Inner.h']);
  });

  it('keeps the header declaring what the file defines, so declaration and definition meet', () => {
    const files = tree({
      'globals/globals.h': `#pragma once\nnamespace D2Client { extern int gnCounter; }\n`,
      'globals/D2Client.cpp': `#include "globals/globals.h"\n\nnamespace D2Client { int gnCounter = 0; }\n`,
    });
    pruneIncludes(files);
    assert.deepStrictEqual(includesOf(files, 'globals/D2Client.cpp'), ['globals/globals.h']);
  });

  it('keeps an inline body beside its declaration for every caller', () => {
    const files = tree({
      'Alpha/Alpha.h': `#pragma once\nnamespace Alpha { int * __fastcall GetLine(int n); }\n`,
      'Alpha/Alpha.inline.h': `#pragma once\n#include "Alpha/Alpha.h"\nnamespace Alpha { inline int * __fastcall GetLine(int n) { return 0; } }\n`,
      'Beta/Beta.cpp': `#include "Alpha/Alpha.h"
#include "Alpha/Alpha.inline.h"

namespace Beta { int __fastcall Remote(int n) { return *Alpha::GetLine(n) + 1; } }
`,
    });
    pruneIncludes(files);
    assert.deepStrictEqual(includesOf(files, 'Beta/Beta.cpp'), ['Alpha/Alpha.h', 'Alpha/Alpha.inline.h']);
  });

  it('keeps a name a macro body spells', () => {
    const files = tree({
      'Fog/Memory.h': `#pragma once\nnamespace Fog::Memory { void __fastcall FreeClientMemory(void * p, const char * f, int l, int n); }\n`,
      'Game/Use.cpp': `#include "Fog/Memory.h"

#ifndef D2_FREE_AT
#define D2_FREE_AT(p, szFile, nLine) Fog::Memory::FreeClientMemory((p), (szFile), (nLine), 0)
#endif

void __fastcall F(void * p) { D2_FREE_AT(p, __FILE__, __LINE__); }
`,
    });
    pruneIncludes(files);
    assert.deepStrictEqual(includesOf(files, 'Game/Use.cpp'), ['Fog/Memory.h']);
  });

  it('never forward-declares a class template, and completes the arguments a member specialization instantiates', () => {
    const files = tree({
      'Lib/SYNC.h': `#pragma once\nclass SYNC {\npublic:\n    int m_lock;\n};\n`,
      'Storm/stpl.h': `#pragma once
#include "Lib/SYNC.h"
template<class T, class TSync> class TSSync {
public:
    int m_count;
    TSync m_sync;
    void Lock();
};
struct ELEM;
template<> void TSSync<ELEM, SYNC>::Lock();
`,
      'Game/Use.cpp': `#include "Storm/stpl.h"\n\nint __fastcall F(TSSync<ELEM, SYNC> * p) { return p != 0; }\n`,
    });
    pruneIncludes(files);
    assert.deepStrictEqual(includesOf(files, 'Storm/stpl.h'), ['Lib/SYNC.h']);
    assert.deepStrictEqual(includesOf(files, 'Game/Use.cpp'), ['Storm/stpl.h']);
    assert.doesNotMatch(files.get('Game/Use.cpp')!.content, /class TSSync;/);
  });

  it('leaves conditional includes and a file the parser cannot read as written', () => {
    const files = tree({
      ...UNIT,
      'Game/Cond.cpp': `#include "Lib/Path.h"\n#ifdef _WIN32\n#include "Lib/Room.h"\n#endif\n\nint F() { return 0; }\n`,
      'Game/Broken.cpp': `#include "Lib/Path.h"\n\nint F( { return 0; }\n`,
    });
    const result = pruneIncludes(files);
    assert.deepStrictEqual(includesOf(files, 'Game/Cond.cpp'), ['Lib/Room.h']);
    assert.deepStrictEqual(includesOf(files, 'Game/Broken.cpp'), ['Lib/Path.h']);
    assert.deepStrictEqual(result.unparsed, ['Game/Broken.cpp']);
  });

  it('keeps a re-export header (a module public header) as written: its includes are its content', () => {
    const umbrella = `#pragma once
#include "Lib/Unit.h"
#include "Lib/Path.h"
#include "Lib/Room.h"
`;
    const files = tree({ ...UNIT, 'Lib/Lib.public.h': umbrella, 'Lib/Plain.h': umbrella });
    files.get('Lib/Lib.public.h')!.reexport = true;
    pruneIncludes(files);
    assert.deepStrictEqual(includesOf(files, 'Lib/Lib.public.h'), ['Lib/Unit.h', 'Lib/Path.h', 'Lib/Room.h']);
    assert.strictEqual(files.get('Lib/Lib.public.h')!.content, umbrella);
    assert.deepStrictEqual(includesOf(files, 'Lib/Plain.h'), [], 'the same text without the role is pruned');
  });

  it('is idempotent', () => {
    const files = tree({
      ...UNIT,
      'Game/Use.cpp': `#include "Lib/Room.h"\n#include "Lib/Path.h"\n\nint __fastcall F(D2RoomStrc * pRoom, D2PathStrc * pPath) { return pRoom->sUnit.nUnitType; }\n`,
    });
    pruneIncludes(files);
    const once = [...files].map(([k, v]) => [k, v.content]);
    const again = pruneIncludes(files);
    assert.deepStrictEqual([...files].map(([k, v]) => [k, v.content]), once);
    assert.strictEqual(again.dropped + again.added + again.forwardDeclared, 0);
  });

  it('leaves a tree that compiles', { skip: !haveGpp() && `${GPP} not found` }, () => {
    const files = tree({
      ...UNIT,
      'Lib/All.h': `#pragma once\n#include "Lib/Unit.h"\n#include "Lib/Path.h"\n#include "Lib/Room.h"\n`,
      'Lib/Holder.h': `#pragma once\n#include "Lib/All.h"\nstruct D2HolderStrc {\n    D2PathStrc sPath;\n    D2RoomStrc * pRoom;\n    D2RoomDataUnion * pData;\n};\n`,
      'Game/Use.cpp': `#include "Lib/Holder.h"

int __fastcall F(D2HolderStrc * pHolder, D2UnitStrc * pUnit) {
    return pHolder->sPath.nX + pUnit->pPath->nX + UNITS_GetType(pUnit);
}
`,
    });
    pruneIncludes(files);
    assert.deepStrictEqual(includesOf(files, 'Lib/Holder.h'), ['Lib/Path.h']);
    const dir = mkdtempSync(join(tmpdir(), 'include-pruning-'));
    try {
      for (const [p, f] of files) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), f.content);
      }
      execFileSync(GPP, ['-std=c++17', '-fsyntax-only', '-w', '-I.', 'Game/Use.cpp'], { cwd: dir, stdio: 'pipe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
