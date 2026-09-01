/**
 * Two system structs the toolchain and Ghidra spell differently, claimed by
 * d2_platform.h so the two spellings become one type.
 *
 *   FILE   — Ghidra models the MSVC CRT stream (`_ptr`/`_cnt`/`_base`/…) and D2
 *            writes through those members. A UCRT toolchain declares the same
 *            `struct _iobuf` with a single opaque `_Placeholder`, so every one
 *            of those reads fails against a nominally identical type.
 *
 *   in_addr — Ghidra names the anonymous union inside it (`_union_1226`) and the
 *            two anonymous structs inside that (`_struct_1227`, `_struct_1228`);
 *            mingw's inaddr.h leaves all three unnamed. Same four bytes, two
 *            unrelated types.
 *
 * Both vendor headers are guarded (`_FILE_DEFINED`, `s_addr`), so emitting the
 * same layout first and claiming the guard changes no offsets.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generatePlatformHeader } from '../codegen/platform-types.js';
import { buildWinsockInAddrClaim } from '../codegen/index.js';
import type { ExtractedDataType, ExtractedStruct, ExtractedUnion } from '../types.js';

/** Ghidra's model of in_addr, as it comes out of the 1.14d database. */
function ghidraInAddrModel(): ExtractedDataType[] {
  const model: Array<ExtractedStruct | ExtractedUnion> = [
    {
      kind: 'STRUCTURE', name: 'in_addr', category: '/inaddr.h', size: 4,
      fields: [{ name: 'S_un', dataType: '_union_1226', offset: 0, size: 4 }],
    },
    {
      kind: 'UNION', name: '_union_1226', category: '/inaddr.h', size: 4,
      fields: [
        { name: 'S_un_b', dataType: '_struct_1227', offset: 0, size: 4 },
        { name: 'S_un_w', dataType: '_struct_1228', offset: 0, size: 4 },
        { name: 'S_addr', dataType: 'ULONG', offset: 0, size: 4 },
      ],
    },
    {
      kind: 'STRUCTURE', name: '_struct_1227', category: '/inaddr.h', size: 4,
      fields: [
        { name: 's_b1', dataType: 'UCHAR', offset: 0, size: 1 },
        { name: 's_b2', dataType: 'UCHAR', offset: 1, size: 1 },
        { name: 's_b3', dataType: 'UCHAR', offset: 2, size: 1 },
        { name: 's_b4', dataType: 'UCHAR', offset: 3, size: 1 },
      ],
    },
    {
      kind: 'STRUCTURE', name: '_struct_1228', category: '/inaddr.h', size: 4,
      fields: [
        { name: 's_w1', dataType: 'USHORT', offset: 0, size: 2 },
        { name: 's_w2', dataType: 'USHORT', offset: 2, size: 2 },
      ],
    },
  ];
  return model;
}

describe('MSVC FILE layout', () => {
  const header = generatePlatformHeader();

  it('declares _iobuf with the members Ghidra models, before <cstdio>', () => {
    const guard = header.indexOf('#define _FILE_DEFINED');
    const cstdio = header.indexOf('#include <cstdio>');
    assert.ok(guard > 0, '_FILE_DEFINED is claimed');
    assert.ok(cstdio > guard, 'the claim precedes <cstdio>');

    for (const m of ['_ptr', '_cnt', '_base', '_flag', '_file', '_charbuf', '_bufsiz', '_tmpfname']) {
      assert.ok(header.includes(` ${m};`), `declares _iobuf::${m}`);
    }
  });

  it('keeps FILE spelled `struct _iobuf`, so CRT entry points still fit', () => {
    assert.match(header, /typedef struct _iobuf FILE;/);
  });
});

describe('winsock in_addr claim', () => {
  it("gives Ghidra's names to in_addr's nested anonymous aggregates", () => {
    const { lines, claimed } = buildWinsockInAddrClaim(ghidraInAddrModel());
    const text = lines.join('\n');

    assert.ok(lines.length > 0, 'a claim is produced for the winsock shape');
    assert.match(text, /#\s*ifndef s_addr/);
    assert.match(text, /union _union_1226 \{/);
    assert.match(text, /struct _struct_1227 \{ unsigned char s_b1; unsigned char s_b2;/);
    assert.match(text, /struct _struct_1228 \{ unsigned short s_w1; unsigned short s_w2; operator unsigned long\(\)/);
    // The nested structs convert to the word they are, and stay AGGREGATES while
    // doing it: a conversion operator does not disqualify a type from
    // brace-initialisation, a constructor would.
    assert.match(text, /struct _struct_1227 \{[^}]*operator unsigned long\(\) const \{ return \*reinterpret_cast<const unsigned long\*>\(this\); \} \};/);
    assert.ok(!/_struct_1227\(/.test(text), 'the nested byte struct has no constructor');
    assert.ok(!/_struct_1228\(/.test(text), 'the nested word struct has no constructor');
    assert.match(text, /operator unsigned long\(\) const \{ return S_un\.S_addr; \}/);
    assert.match(text, /_struct_1227 S_un_b;/);
    assert.match(text, /unsigned long S_addr;/);
    assert.match(text, /\} IN_ADDR, \*PIN_ADDR, \*LPIN_ADDR;/);
    // The macros inaddr.h would have supplied have to come with the claim.
    assert.match(text, /#\s*define s_addr\s+S_un\.S_addr/);
    assert.match(text, /#\s*define s_host\s+S_un\.S_un_b\.s_b2/);

    assert.deepStrictEqual(
      [...claimed].sort(),
      ['_struct_1227', '_struct_1228', '_union_1226'],
    );
  });

  it('is emitted ahead of <windows.h>, where inaddr.h would arrive', () => {
    const { lines } = buildWinsockInAddrClaim(ghidraInAddrModel());
    const header = generatePlatformHeader({ winsockInAddr: lines });
    const claim = header.indexOf('#  ifndef s_addr');
    const windows = header.indexOf('#  include <windows.h>');
    assert.ok(claim > 0 && windows > claim);
  });

  it('declines any shape that is not winsock\'s, rather than guessing', () => {
    const model = ghidraInAddrModel();
    // A union member renamed — the s_host/s_net macros would then be wrong.
    const un = model.find(d => d.name === '_union_1226') as ExtractedUnion;
    un.fields[0].name = 'S_bytes';

    const { lines, claimed } = buildWinsockInAddrClaim(model);
    assert.deepStrictEqual(lines, []);
    assert.strictEqual(claimed.size, 0);
  });

  it('declines when in_addr is absent from the database', () => {
    const { lines } = buildWinsockInAddrClaim([]);
    assert.deepStrictEqual(lines, []);
  });
});
