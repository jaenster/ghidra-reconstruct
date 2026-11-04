/**
 * FreeMemoryPool (00409c80): `SUB ECX, 0x74f104; MUL` divides the distance from
 * pGlobalPoolSystem.pManagers, and the decompiler folds the subtracted address into the
 * pointer as `pMemory[-0x4eb].pOverflow + 0x3e5`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createGlobalDistanceIndexTransformer } from '../builtins/global-distance-index.js';

const TABLES = {
  enclosingVarTypes: { pMemory: 'D2PoolManagerStrc *', nCount: 'int' },
  aggregateSizes: { D2PoolManagerStrc: 0x17cc, D2MemoryManagerStrc: 48804 },
  structLayouts: {
    D2PoolManagerStrc: [
      { name: 'pSync', offset: 4, size: 24, type: 'CRITICAL_SECTION' },
      { name: 'pOverflow', offset: 0x7ac, size: 4092, type: 'BYTE *[1023]' },
    ],
    D2MemoryManagerStrc: [
      { name: 'pSync', offset: 4, size: 24, type: 'CRITICAL_SECTION' },
      { name: 'pManagers', offset: 0x1c, size: 48736, type: 'D2PoolManagerStrc[8]' },
      { name: 'nManagerIndex', offset: 48768, size: 32, type: 'size_t[8]' },
    ],
  },
  globalAddresses: { pGlobalPoolSystem: 0x74f0e8, gScalar: 0x17cc00 },
  globalSizes: { pGlobalPoolSystem: 48804, gScalar: 4 },
  globalTypes: { pGlobalPoolSystem: 'D2MemoryManagerStrc', gScalar: 'int' },
  globalNamespaces: { pGlobalPoolSystem: ['Fog', 'Memory'] },
};

function run(code: string, displacements: number[]) {
  const rewrites: string[] = [];
  const out = emit(createGlobalDistanceIndexTransformer({
    ...TABLES, displacements,
    onRewrite: (r: { from: string; to: string }) => rewrites.push(`${r.from} -> ${r.to}`),
  })(parse(code)) as AnyNode).trim();
  return { out, rewrites };
}

const SITE = `void f() { n = (uint)(pMemory[-0x4eb].pOverflow + 0x3e5) / 0x17cc; }`;

describe('global-distance-index', () => {
  it('respells the folded manager index as the distance from pManagers', () => {
    const { out, rewrites } = run(SITE, [0x74f104]);
    assert.ok(out.includes('(uint)((intptr_t)pMemory - (intptr_t)Fog::Memory::pGlobalPoolSystem.pManagers) / 0x17cc'), out);
    assert.deepStrictEqual(rewrites, ['pMemory - 0x74f104 -> pMemory - Fog::Memory::pGlobalPoolSystem.pManagers']);
  });

  it('is the same integer in the image', () => {
    // -0x4eb * 0x17cc + 0x7ac + 0x3e5 * 4 = -0x74f104, the encoded address.
    assert.strictEqual(-0x4eb * 0x17cc + 0x7ac + 0x3e5 * 4, -0x74f104);
  });

  it('needs the address encoded by an instruction of the function', () => {
    const { out } = run(SITE, [0x74f108]);
    assert.ok(out.includes('pMemory[-0x4eb].pOverflow + 0x3e5'), out);
  });

  it('spells a global start by its address', () => {
    const { out } = run(`void f() { n = (int)(pMemory + -0x100); }`, [0x17cc00]);
    assert.ok(out.includes('(int)((intptr_t)pMemory - (intptr_t)&gScalar)'), out);
  });

  it('leaves a walk it cannot size', () => {
    const { out } = run(`void f() { n = (uint)(pOther[-0x4eb].pOverflow + 0x3e5); }`, [0x74f104]);
    assert.ok(out.includes('pOther[-0x4eb]'), out);
  });

  it('leaves a value that is not an integer cast', () => {
    const { out } = run(`void f() { q = (BYTE **)(pMemory[-0x4eb].pOverflow + 0x3e5); }`, [0x74f104]);
    assert.ok(out.includes('pMemory[-0x4eb]'), out);
  });

  it('leaves a load through a pointer field', () => {
    const { out } = run(`void f() { n = (uint)(pMemory[-0x4eb].pOverflow[0x3e5] + 0); }`, [0x74f104]);
    assert.ok(out.includes('pOverflow[0x3e5]'), out);
  });
});
