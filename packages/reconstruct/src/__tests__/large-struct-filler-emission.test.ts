/**
 * `D2GameViewStrc` is the largest struct in the 1.14d database: nine named
 * members, then 59,999 unnamed one-byte `undefined` components, then a named
 * tail — 60,023 components over 60,092 bytes. Two separate things have to hold
 * for it, and this file pins both.
 *
 * 1. The emitter collapses a filler run past `MAX_NAMED_FILLER_BYTES` into one
 *    `uint8_t _pad_0x..[N]` array instead of naming every byte. Sixty thousand
 *    one-byte members in a header that hundreds of translation units include is
 *    not a header anyone can compile.
 *
 * 2. A struct whose Ghidra detail never arrived must NOT be emitted as an empty
 *    body. `get_data_type` for this struct returns ~5 MB, and when the daemon is
 *    loaded it can exceed the RPC timeout; the extractor then kept the shallow
 *    listing entry, which carries no fields at all. That emitted
 *    `struct D2GameViewStrc {};` — a struct that compiles, and then costs 123
 *    errors at every member access. An unknown layout is not an empty layout,
 *    and the pipeline has to say so instead of guessing.
 *
 * The layout assertions read the emitted text through the C++ parser, never
 * through a pattern match over the text.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parse, NodeKind } from '@ghidra-mcp/cpp-parser';
import type { StructDecl, TranslationUnit } from '@ghidra-mcp/cpp-parser';

import { generateStructDeclaration } from '../codegen/header.js';
import { generateProject } from '../codegen/index.js';
import type {
  ExtractedDataType,
  ExtractedStruct,
  StructField,
  AnalyzedDataSymbol,
  DetectedClass,
  ExtractedNamespace,
  ExtractedFunction,
  ProgramInfo,
  ReconstructOptions,
} from '../types.js';

/** A member as the parser sees it: its name, and its array extent if it has one. */
interface ParsedMember {
  name: string;
  extent: number | null;
}

/**
 * Parse an emitted `struct X { ... };` and return its members from the AST.
 * The declaration is read as a real translation unit — the offset comments are
 * trivia and play no part.
 */
function parsedMembers(declaration: string): ParsedMember[] {
  const tu = parse(declaration) as TranslationUnit;
  const struct = tu.declarations.find(d => d.kind === NodeKind.StructDecl) as StructDecl | undefined;
  assert.ok(struct, 'the emitted declaration must parse as a struct');

  const members: ParsedMember[] = [];
  for (const member of struct.members) {
    // Field members emit as plain declarations inside the record body.
    const m = member as unknown as {
      kind: string;
      name?: { name: string };
      type?: { kind: string; size?: { value: bigint | number } };
    };
    if (m.kind !== NodeKind.VariableDecl && m.kind !== NodeKind.FieldDecl) continue;
    if (!m.name) continue;
    const type = m.type;
    const extent =
      type && type.kind === NodeKind.ArrayType && type.size !== undefined
        ? Number(type.size.value)
        : null;
    members.push({ name: m.name.name, extent });
  }
  return members;
}

/** N consecutive unnamed 1-byte `undefined` components starting at `start`. */
function filler(start: number, count: number): StructField[] {
  return Array.from({ length: count }, (_, k) => ({
    name: '', dataType: 'undefined1', offset: start + k, size: 1,
  }));
}

/** The real 1.14d `D2GameViewStrc`, as Ghidra reports it. */
function gameViewStrc(): ExtractedStruct {
  return {
    kind: 'STRUCTURE',
    name: 'D2GameViewStrc',
    category: '/Diablo2',
    size: 60092,
    fields: [
      { name: 'nFlags', dataType: 'undefined4', offset: 0x00, size: 4 },
      { name: 'pView', dataType: 'tagRECT', offset: 0x04, size: 16 },
      { name: 'rcExtendedView', dataType: 'tagRECT', offset: 0x14, size: 16 },
      { name: 'nCenterX', dataType: 'int', offset: 0x24, size: 4 },
      { name: 'nCenterY', dataType: 'int', offset: 0x28, size: 4 },
      { name: 'pPalPointerTable32x8', dataType: 'undefined4', offset: 0x2c, size: 4 },
      { name: 'pPalByteTable32x16', dataType: 'undefined4', offset: 0x30, size: 4 },
      { name: 'pPalByteTable16x32', dataType: 'undefined4', offset: 0x34, size: 4 },
      { name: 'nWall2AllocCount', dataType: 'undefined4', offset: 0x38, size: 4 },
      ...filler(0x3c, 60000),
      { name: 'nWall2EntryCount', dataType: 'undefined4', offset: 0xea9c, size: 4 },
      { name: 'nWall2GridOriginX', dataType: 'int', offset: 0xeaa0, size: 4 },
      { name: 'nWall2GridOriginY', dataType: 'int', offset: 0xeaa4, size: 4 },
      { name: 'pWall2', dataType: 'void *', offset: 0xeaa8, size: 4 },
    ],
  };
}

describe('a 60,000-byte filler run collapses instead of emptying the struct', () => {
  const out = generateStructDeclaration(gameViewStrc());
  const members = parsedMembers(out);

  it('emits a body — the struct is never empty', () => {
    assert.ok(members.length > 0, `expected members, got:\n${out}`);
  });

  it('keeps every named member Ghidra reports', () => {
    const names = new Set(members.map(m => m.name));
    for (const expected of [
      'nFlags', 'pView', 'rcExtendedView', 'nCenterX', 'nCenterY',
      'pPalPointerTable32x8', 'pPalByteTable32x16', 'pPalByteTable16x32',
      'nWall2AllocCount', 'nWall2EntryCount', 'nWall2GridOriginX',
      'nWall2GridOriginY', 'pWall2',
    ]) {
      assert.ok(names.has(expected), `missing member ${expected}`);
    }
  });

  it('collapses the run into one padding array, not 60,000 members', () => {
    const arrays = members.filter(m => m.extent !== null);
    assert.equal(arrays.length, 1, 'expected exactly one array member');
    // The run's first byte keeps Ghidra's own `field_0x<off>` name, because a
    // body that reads the run reads it at that offset; the rest is the array.
    assert.equal(arrays[0].extent, 59999);
    assert.ok(members.some(m => m.name === 'field_0x3c'), 'run head keeps its Ghidra name');
    assert.ok(
      members.length < 40,
      `expected a collapsed body, got ${members.length} members`
    );
  });

  it('covers all 60,092 bytes exactly once', () => {
    // 13 named members + the run head + the pad array.
    assert.equal(members.length, 15);
  });
});

const options: ReconstructOptions = {
  outputDir: './out',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'quick',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

const programInfo: ProgramInfo = {
  name: 'Smoke.exe',
  path: '/tmp/Smoke.exe',
  format: 'PE',
  architecture: 'x86',
  compiler: 'msvc',
  imageBase: '0x400000',
  languageId: 'x86:LE:32:default',
  endianness: 'little',
  pointerSize: 4,
};

function runCodegen(dataTypes: ExtractedDataType[]): ReturnType<typeof generateProject> {
  const functions: ExtractedFunction[] = [];
  const classes: DetectedClass[] = [];
  const globals: AnalyzedDataSymbol[] = [];
  const namespaces: ExtractedNamespace[] = [
    { name: 'D2Client', fullPath: 'D2Client', functionCount: 0, isClass: false },
  ];
  return generateProject(
    'hole', functions, classes, dataTypes, globals, namespaces, options, programInfo
  );
}

describe('a type whose Ghidra detail never arrived is refused, not emitted empty', () => {
  it('refuses a struct marked detailUnavailable, and names it', () => {
    const shallow: ExtractedStruct = {
      kind: 'STRUCTURE',
      name: 'D2GameViewStrc',
      category: '/Diablo2',
      size: 0,
      fields: [],
      detailUnavailable: true,
    };
    assert.throws(
      () => runCodegen([shallow]),
      (err: Error) => {
        assert.match(err.message, /D2GameViewStrc/);
        assert.match(err.message, /detail/i);
        return true;
      },
      'codegen must refuse a struct whose members are unknown'
    );
  });

  it('still emits a struct that Ghidra really reports as empty', () => {
    const empty: ExtractedStruct = {
      kind: 'STRUCTURE',
      name: 'D2OpaqueStrc',
      category: '/Diablo2',
      size: 0,
      fields: [],
    };
    const project = runCodegen([empty]);
    assert.ok(project.files.size > 0);
  });
});
