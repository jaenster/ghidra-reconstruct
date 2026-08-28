/**
 * Two DIFFERENT Ghidra types can share a bare name across categories, and the
 * bare-name dedup dropped every one but the first — 141 of them in the v711
 * extraction. The dropped signature is not merely absent: the struct field that
 * named it silently takes the survivor's signature, which compiles and is wrong
 * at every call.
 *
 * The shapes below are the real ones from the Mac extraction cache
 * (`.ghidra-mcp/source-cache/mac/dataTypes.ndjson`), where both `fpDrawGroundTile`
 * entries still exist side by side.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { disambiguateCategoryDuplicates } from '../modules/category-duplicate-types.js';
import type { ExtractedDataType, ExtractedStruct } from '../types.js';

function funcdef(
  name: string,
  category: string,
  returnType: string,
  paramTypes: string[]
): ExtractedDataType {
  return {
    name,
    kind: 'FUNCTION_DEFINITION',
    category,
    returnType,
    parameters: paramTypes.map((dataType, ordinal) => ({ name: `a${ordinal}`, dataType, ordinal })),
  } as unknown as ExtractedDataType;
}

function struct(name: string, category: string, fields: Array<[string, string]>): ExtractedStruct {
  return {
    name,
    kind: 'STRUCTURE',
    category,
    size: fields.length * 4,
    fields: fields.map(([fname, dataType], i) => ({
      name: fname,
      dataType,
      offset: i * 4,
      size: 4,
    })),
  } as unknown as ExtractedStruct;
}

/** The GFX collision, exactly as Ghidra holds it. */
function gfxTypes(): ExtractedDataType[] {
  return [
    funcdef('fpFillYBufferTable', '/Diablo2/GFX/D2GfxHelperStrc', 'void', ['int']),
    funcdef('fpDrawGroundTile', '/Diablo2/GFX/D2GfxHelperStrc', 'void', [
      'int',
      'int',
      'int',
      'int',
    ]),
    funcdef('fpInitialize', '/Diablo2/GFX/D2RenderCallbackStrc', 'BOOL', ['int']),
    funcdef('fpSetGamma', '/Diablo2/GFX/D2RenderCallbackStrc', 'void', ['int']),
    funcdef('fpDrawImage', '/Diablo2/GFX/D2RenderCallbackStrc', 'BOOL', ['void *']),
    // The one the dedup dropped: the renderer's real ground-tile entry point.
    funcdef('fpDrawGroundTile', '/Diablo2/GFX/D2RenderCallbackStrc', 'BOOL', [
      'D2TileLibraryEntryStrc *',
      'D2GfxLightExStrc *',
      'int',
      'int',
      'int',
      'int',
      'BYTE',
      'int',
      'void *',
    ]),
    struct('D2GfxHelperStrc', '/Diablo2/GFX', [
      ['nfpFillYBufferTable', 'fpFillYBufferTable *'],
      ['nfpDrawGroundTile', 'fpDrawGroundTile *'],
    ]),
    // The category kept the pre-rename spelling, so this struct's NAME does not
    // match `/Diablo2/GFX/D2RenderCallbackStrc`. Its fields still say it owns it.
    struct('D2RendererFunctionsStrc', '/Diablo2/GFX', [
      ['nfpInitialize', 'fpInitialize *'],
      ['nfpSetGamma', 'fpSetGamma *'],
      ['nfpDrawImage', 'fpDrawImage *'],
      ['nfpDrawGroundTile', 'fpDrawGroundTile *'],
    ]),
  ];
}

describe('disambiguateCategoryDuplicates', () => {
  it('keeps the shadowed funcdef and repoints the struct that owns its category', () => {
    const types = gfxTypes();
    const result = disambiguateCategoryDuplicates(types);

    assert.equal(result.renamed, 1);
    assert.equal(result.fieldsRepointed, 1);

    // The first entry keeps the bare name — nothing that resolves today moves.
    const survivors = types.filter(t => t.name === 'fpDrawGroundTile');
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].category, '/Diablo2/GFX/D2GfxHelperStrc');

    // The shadowed one is now in the model under a distinct name...
    const renamed = types.find(t => t.name === 'D2RendererFunctionsStrc_fpDrawGroundTile');
    assert.ok(renamed, 'the shadowed funcdef must survive under a distinct name');
    assert.equal((renamed as any).returnType, 'BOOL');
    assert.equal((renamed as any).parameters.length, 9);

    // ...and the field that meant it points at it, with the pointer preserved.
    const renderer = types.find(t => t.name === 'D2RendererFunctionsStrc') as ExtractedStruct;
    const field = renderer.fields!.find(f => f.name === 'nfpDrawGroundTile')!;
    assert.equal(field.dataType, 'D2RendererFunctionsStrc_fpDrawGroundTile *');

    // The helper struct's own field is untouched.
    const helper = types.find(t => t.name === 'D2GfxHelperStrc') as ExtractedStruct;
    assert.equal(
      helper.fields!.find(f => f.name === 'nfpDrawGroundTile')!.dataType,
      'fpDrawGroundTile *'
    );
  });

  it('carries the sibling `X *` POINTER entry along with the rename', () => {
    const types = gfxTypes();
    types.push({
      name: 'fpDrawGroundTile *',
      kind: 'POINTER',
      category: '/Diablo2/GFX/D2RenderCallbackStrc',
    } as unknown as ExtractedDataType);

    disambiguateCategoryDuplicates(types);

    assert.ok(
      types.some(t => t.name === 'D2RendererFunctionsStrc_fpDrawGroundTile *'),
      'the pointer entry collides on the bare name too and must follow'
    );
  });

  it('leaves a type filed twice with identical contents to the dedup', () => {
    // 34 of the Mac extraction's 47 duplicates are this: one type, two
    // categories. Dropping the copy is correct and must stay that way.
    const types: ExtractedDataType[] = [
      struct('D2PoolStrc', '/', [['pNext', 'D2PoolStrc *']]),
      struct('D2PoolStrc', '/Diablo2/MEMORY', [['pNext', 'D2PoolStrc *']]),
    ];
    const result = disambiguateCategoryDuplicates(types);
    assert.equal(result.renamed, 0);
    assert.deepEqual(types.map(t => t.name), ['D2PoolStrc', 'D2PoolStrc']);
  });

  it('leaves same-named ENUMs alone, because they are merged downstream', () => {
    const types: ExtractedDataType[] = [
      {
        name: 'eCollisionFlags',
        kind: 'ENUM',
        category: '/Diablo2/COLLISION',
        values: [{ name: 'COLLIDE_NONE', value: 0 }],
      } as unknown as ExtractedDataType,
      {
        name: 'eCollisionFlags',
        kind: 'ENUM',
        category: '/_Source/Collision',
        values: [{ name: 'COLLISION_LOS', value: 0x805 }],
      } as unknown as ExtractedDataType,
    ];
    const result = disambiguateCategoryDuplicates(types);
    assert.equal(result.renamed, 0);
    assert.deepEqual(types.map(t => t.name), ['eCollisionFlags', 'eCollisionFlags']);
  });

  it('does nothing when no struct can be shown to own the category', () => {
    // One shared reference is not evidence, so the entry is reported, not renamed.
    const types: ExtractedDataType[] = [
      funcdef('Release', '/Direct3DFunctions', 'ULONG', ['void *']),
      funcdef('Release', '/SomewhereElse', 'HRESULT', ['void *', 'int']),
      struct('Unrelated', '/', [['pRelease', 'Release *']]),
    ];
    const result = disambiguateCategoryDuplicates(types);
    assert.equal(result.renamed, 0);
    assert.deepEqual(result.unresolved, ['/SomewhereElse/Release']);
  });

  it('resolves by direct name match when the struct is named after the category', () => {
    const types: ExtractedDataType[] = [
      funcdef('Draw', '/First', 'void', ['int']),
      funcdef('Draw', '/Second', 'BOOL', ['int', 'int']),
      struct('Second', '/', [['fpDraw', 'Draw *']]),
    ];
    const result = disambiguateCategoryDuplicates(types);
    assert.equal(result.renamed, 1);
    assert.equal(result.fieldsRepointed, 1);
    const s = types.find(t => t.name === 'Second') as ExtractedStruct;
    assert.equal(s.fields![0].dataType, 'Second_Draw *');
  });
});
