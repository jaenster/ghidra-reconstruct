/**
 * RENDERER_DIRECT3D_UploadTextureToCache (006b5d40) indexes the 1-based texture cache
 * set through 0x970eac = gD3DGenericTextureCache - 0x1c and reads each cache's node
 * buffer through 0x970ec4 = gD3DGenericTextureCache - 4. Neither address has an object.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import type { PluginOptions } from '../types.js';
import { createIndexBaseBeforeObjectTransformer } from '../builtins/index-base-before-object.js';

const TABLES = {
  globalAddresses: {
    gnD3DAdapterIndex: 0x970ebc, DAT_00970eac: 0x970eac, INT_00970ec4: 0x970ec4,
    gD3DGenericTextureCache: 0x970ec8, gpD3DTextureSpritePoolMemory0: 0x970f34,
  },
  globalSizes: {
    gnD3DAdapterIndex: 4, DAT_00970eac: 1, INT_00970ec4: 4,
    gD3DGenericTextureCache: 108, gpD3DTextureSpritePoolMemory0: 4,
  },
  globalNamespaces: { gD3DGenericTextureCache: [], gpD3DTextureSpritePoolMemory0: [], gnD3DAdapterIndex: [] },
  globalTypes: {
    DAT_00970eac: 'uint8_t', INT_00970ec4: 'int', gnD3DAdapterIndex: 'uint',
    gD3DGenericTextureCache: 'D3DTextureCacheSetStrc', gpD3DTextureSpritePoolMemory0: 'void*',
  },
};

function transform(code: string, tables: PluginOptions = TABLES): string {
  return emit(createIndexBaseBeforeObjectTransformer(tables)(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();
}

describe('index-base-before-object', () => {
  it('respells the 1-based cache-set base against the cache set (the v1743 body)', () => {
    const out = transform(`void f(int iMipLevel, int *piVar2) {
      pCache = (D3DTextureCacheStrc *)(&DAT_00970eac + iMipLevel * 0x1c);
      x = *(int *)(*piVar2 * 0x20 + -0x14 + (&INT_00970ec4)[iMipLevel * 7]);
      y = (&INT_00970ec4)[iMipLevel * 7] + -0xc; }`);
    assert.ok(out.includes('(D3DTextureCacheStrc*)((uint8_t*)&gD3DGenericTextureCache - 0x1c + iMipLevel * 0x1c)'), out);
    assert.ok(out.includes('((int*)((uint8_t*)&gD3DGenericTextureCache - 0x4))[iMipLevel * 7]'), out);
    assert.ok(!out.includes('DAT_00970eac') && !out.includes('INT_00970ec4'), out);
  });

  it('lands on the same bytes as the machine for every mip level', () => {
    const G = 0x970ec8;
    for (let lvl = 1; lvl <= 3; lvl++) {
      assert.strictEqual((G - 0x1c) + lvl * 0x1c, G + (lvl - 1) * 0x1c);          // aCaches[lvl - 1]
      assert.strictEqual((G - 4) + lvl * 7 * 4, G + (lvl - 1) * 0x1c + 0x18);     // .pNodeBuffer
    }
  });

  it('leaves a label that is also read as a scalar', () => {
    const out = transform('void f(int i) { a = (&INT_00970ec4)[i * 7]; b = INT_00970ec4; }');
    assert.ok(out.includes('(&INT_00970ec4)[i * 7]'), out);
  });

  it('leaves a constant offset, which says nothing about a 1-based index', () => {
    const out = transform('void f() { a = *(&DAT_00970eac + 0x1c); }');
    assert.ok(out.includes('&DAT_00970eac + 0x1c'), out);
  });

  it('leaves a named symbol: someone decided it is an object', () => {
    const out = transform('void f(int i) { a = (&gnD3DAdapterIndex)[i * 7]; }');
    assert.ok(out.includes('(&gnD3DAdapterIndex)[i * 7]'), out);
  });

  it('leaves a label whose first stride stays short of the next object', () => {
    // 0x970eac + 4 is undefined bytes, not the cache set.
    const out = transform('void f(int i) { a = &DAT_00970eac + i * 4; }');
    assert.ok(out.includes('&DAT_00970eac + i * 4'), out);
  });

  it('leaves a label further below the object than the window', () => {
    const far = {
      ...TABLES,
      globalAddresses: { ...TABLES.globalAddresses, DAT_00970e00: 0x970e00 },
      globalSizes: { ...TABLES.globalSizes, DAT_00970e00: 1 },
      globalTypes: { ...TABLES.globalTypes, DAT_00970e00: 'uint8_t' },
    };
    const out = transform('void f(int i) { a = &DAT_00970e00 + i * 0xc8; }', far);
    assert.ok(out.includes('&DAT_00970e00 + i * 0xc8'), out);
  });

  it('leaves the label when the object is not a namespace-scope global', () => {
    const hidden = { ...TABLES, globalNamespaces: {} };
    const out = transform('void f(int i) { a = &DAT_00970eac + i * 0x1c; }', hidden);
    assert.ok(out.includes('&DAT_00970eac + i * 0x1c'), out);
  });

  it('spells the object with its namespace', () => {
    const ns = { ...TABLES, globalNamespaces: { gD3DGenericTextureCache: ['D2Direct3D', 'Renderer'] } };
    const out = transform('void f(int i) { a = &DAT_00970eac + i * 0x1c; }', ns);
    assert.ok(out.includes('(uint8_t*)&D2Direct3D::Renderer::gD3DGenericTextureCache - 0x1c'), out);
  });
});
