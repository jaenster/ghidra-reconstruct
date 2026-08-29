import { describe, it } from 'node:test';
import assert from 'node:assert';
import { transformGhidraCode } from '../../../index.js';

/**
 * `D2SkillsTxt` offset 4 is bitfields, so the emitted struct declares
 * `decquant`/`lob`/… and no `field_0x4`. Offset 5 of `D2PetTypeTxt` IS an
 * unnamed filler byte the header declares as `field_0x5`.
 */
const OPTS = {
  usePluginRegistry: true as const,
  preset: 'full' as const,
  pluginOptions: {
    pluginOptions: {
      'bitfield-alias-lower': {
        aggregateMembers: {
          D2SkillsTxt: ['skill', 'field_0x2', 'field_0x3', 'decquant', 'lob'],
          D2PetTypeTxt: ['petType', 'warp', 'field_0x5', 'field_0x6'],
          D2DataTablesStrc: ['pTxtSkills'],
        },
        structFields: {
          D2DataTablesStrc: { pTxtSkills: 'D2SkillsTxt *' },
        },
        globalTypes: { sgptDataTable: 'D2DataTablesStrc *' },
      },
    },
  },
};

const run = (src: string) => transformGhidraCode(src, OPTS);

describe('bitfield-alias-lower', () => {
  it('lowers an alias the aggregate does not declare, on a parameter', () => {
    const r = run(`void f(D2SkillsTxt *pSkillsTxt) { int x = (byte)pSkillsTxt->field_0x4 & 8; }`);
    assert.ok(r.success, r.error);
    assert.ok(!r.code.includes('field_0x4'), r.code);
    assert.ok(/\*\(\(uint8_t\*\)pSkillsTxt \+ 0x4\)/.test(r.code), r.code);
  });

  it('leaves an alias the aggregate DOES declare alone', () => {
    const r = run(`void f(D2PetTypeTxt *pPetType) { int x = (byte)pPetType->field_0x5 & 8; }`);
    assert.ok(r.success, r.error);
    assert.ok(r.code.includes('pPetType->field_0x5'), r.code);
  });

  it('leaves an alias alone when the object type is unknown', () => {
    const r = run(`void f(void) { int x = (byte)pUnknownThing->field_0x4 & 8; }`);
    assert.ok(r.success, r.error);
    assert.ok(r.code.includes('field_0x4'), r.code);
  });

  it('leaves an alias alone when the aggregate is not in the model', () => {
    const r = run(`void f(NotModelled *p) { int x = (byte)p->field_0x4 & 8; }`);
    assert.ok(r.success, r.error);
    assert.ok(r.code.includes('field_0x4'), r.code);
  });

  it('keeps the address-of shape, so a wider read stays the same bytes', () => {
    const r = run(`void f(D2SkillsTxt *pSkillsTxt) { uint x = *(uint *)&pSkillsTxt->field_0x4; }`);
    assert.ok(r.success, r.error);
    assert.ok(!r.code.includes('field_0x4'), r.code);
    assert.ok(!r.code.includes('&*'), r.code);
    assert.ok(/\*\(uint32_t\*\)\(\(uint8_t\*\)pSkillsTxt \+ 0x4\)/.test(r.code), r.code);
  });

  it('reaches through a global and a subscript to find the aggregate', () => {
    const r = run(
      `void f(int nSkillId) { int x = (byte)sgptDataTable->pTxtSkills[nSkillId].field_0x4 & 2; }`);
    assert.ok(r.success, r.error);
    assert.ok(!r.code.includes('field_0x4'), r.code);
    assert.ok(r.code.includes('&sgptDataTable->pTxtSkills[nSkillId]'), r.code);
  });

  it('is a no-op with no aggregate model supplied', () => {
    const r = transformGhidraCode(
      `void f(D2SkillsTxt *p) { int x = (byte)p->field_0x4 & 8; }`,
      { usePluginRegistry: true, preset: 'full' as const });
    assert.ok(r.success, r.error);
    assert.ok(r.code.includes('field_0x4'), r.code);
  });
});
