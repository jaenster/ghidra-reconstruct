/**
 * The include feedback's name index: a name is referenced only as a whole identifier token.
 * DataTbls.cpp once gained a needless #include because the old name ARCHIVE_OpenD2File
 * matched inside every call to ARCHIVE_OpenD2FileWrap.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NeedleIndex, scanReferences } from '../codegen/needle-index.js';

describe('NeedleIndex', () => {
  it('does not match a name inside a longer identifier', () => {
    const idx = new NeedleIndex(['ARCHIVE_OpenD2File', 'ARCHIVE_OpenD2FileWrap']);
    const text = 'void* p = ARCHIVE::ARCHIVE_OpenD2FileWrap(pMemPool, szPath, &nSize);';
    assert.deepStrictEqual([...idx.matchesIn(text)], ['ARCHIVE_OpenD2FileWrap']);
  });

  it('ignores names that only appear in comments, string literals and preprocessor lines', () => {
    const idx = new NeedleIndex(['DATATBLS_LoadTxt', 'D2ItemsTxt', 'FOG_Alloc']);
    const text = [
      '#include "DATATBLS_LoadTxt.h"',
      '// DATATBLS_LoadTxt used to be called here',
      'const char* s = "D2ItemsTxt";',
      '/* FOG_Alloc */ int x = 0;',
    ].join('\n');
    assert.deepStrictEqual([...idx.matchesIn(text)], []);
  });

  it('matches whole identifiers anywhere in code, and keeps substring semantics for non-identifier needles', () => {
    const idx = new NeedleIndex(['D2UnitStrc', 'FOG_Alloc', 'operator new']);
    const text = 'D2UnitStrc* p = (D2UnitStrc*)Fog::FOG_Alloc(4); void* q = operator new(8);';
    assert.deepStrictEqual([...idx.matchesIn(text)].sort(), ['D2UnitStrc', 'FOG_Alloc', 'operator new']);
  });
});

describe('scanReferences', () => {
  it('records each qualified spelling of a name, whole names only', () => {
    const r = scanReferences('A::B::Open(); C :: Open(); xA::Open2(); // D::Open();\n::Open();');
    assert.deepStrictEqual([...(r.qualified.get('Open') ?? [])].sort(), ['A::B::Open', 'C::Open']);
    assert.deepStrictEqual([...(r.qualified.get('Open2') ?? [])], ['xA::Open2']);
  });
});
