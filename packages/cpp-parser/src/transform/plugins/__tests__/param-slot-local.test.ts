/**
 * A local VC8 packed into a loaded parameter's stack slot gets its own variable back, and the
 * parameter's register copy becomes the parameter again (param-slot-local). The reference
 * shapes are Skills_SrvDoFunc_037_ChargeRelease_MultiElementScatter 005d4e70 (whole slot) and
 * INVENTORY_CheckBeltSlotAndGetItem 0063c830 (one byte of the slot), as the generator emitted
 * them before this pass. The refusals are the shapes where the rewrite is unproven.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createParamSlotLocalTransformer } from '../builtins/param-slot-local.js';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const run = (code: string) => norm(emit(createParamSlotLocalTransformer()(parse(code)) as AnyNode));
const same = (code: string) => assert.strictEqual(run(code), norm(emit(parse(code) as AnyNode)));

// 005d4e70, reduced.
const SCATTER = `BOOL __fastcall f(SGAMEDATA * pGame, D2UnitStrc * pUnit, eD2Skills eSkill, int32_t nSkillLvl) {
    int nTargetX;
    eD2Skills eSkillSaved = eSkill;
    if ((int)eSkill < 0) {
      return 0;
    }
    uint32_t nMissile = SKILLASS_GetChargeUpMissile(pUnit, eSkill);
    BOOL bHasPos = SKILLS_GetTargetOrCursorPos(pGame, pUnit, &nTargetX, &eSkill);
    if (!bHasPos) {
      return 0;
    }
    uint32_t nRadius = SKILLASS_GetChargeUpCalcValue(pUnit, eSkillSaved, nSkillLvl);
    SKILLASS_SpawnMissileRing(nMissile, pGame, pUnit, nTargetX, eSkill, eSkillSaved, nSkillLvl, nRadius);
    return 1;
}`;

// 0063c830, reduced.
const BELT = `BOOL __stdcall f(D2InventoryStrc * pInventory, D2UnitStrc * pItemUnit, uint32_t nBeltSlot, D2UnitStrc * * ppOutItem) {
    char byItemHeight;
    D2InventoryStrc* pInventorySaved = pInventory;
    if (!pInventory) {
      return 0;
    }
    if (pInventory->nSignatureMagic != 0x1020304) {
      return 0;
    }
    D2UnitStrc* pCurItem = *ppOutItem;
    ITEM_GetItemsTxt_nWidthAndHeight(pCurItem, (char*)((intptr_t)&pInventory + 3), &byItemHeight, ".\\\\INVENTORY\\\\Inventory.cpp", 0xbc9);
    if (!(*(uint8_t*)((char*)&pInventory + 3) == '\\x01' && byItemHeight == '\\x01')) {
      return 0;
    }
    pCurItem = INVENTORY_GetItemInBeltSlot(pInventorySaved, nBeltSlot);
    return pCurItem != 0;
}`;

describe('param-slot-local', () => {
  it('gives the out argument in a stack parameter\'s slot its own local (005d4e70)', () => {
    const out = run(SCATTER);
    assert.ok(out.includes('eD2Skills eSkillSlot;'), out);
    assert.ok(!out.includes('eSkillSaved'), out);
    assert.ok(out.includes('SKILLASS_GetChargeUpMissile(pUnit, eSkill)'), out);
    assert.ok(out.includes('SKILLS_GetTargetOrCursorPos(pGame, pUnit, &nTargetX, &eSkillSlot)'), out);
    assert.ok(out.includes('SKILLASS_GetChargeUpCalcValue(pUnit, eSkill, nSkillLvl)'), out);
    assert.ok(out.includes('nTargetX, eSkillSlot, eSkill, nSkillLvl'), out);
  });

  it('gives a byte of the slot a char local (0063c830)', () => {
    const out = run(BELT);
    assert.ok(out.includes('char pInventorySlot;'), out);
    assert.ok(!out.includes('pInventorySaved'), out);
    assert.ok(out.includes('(char*)&pInventorySlot, &byItemHeight'), out);
    assert.ok(out.includes('(uint8_t)pInventorySlot == \'\\x01\''), out);
    assert.ok(out.includes('INVENTORY_GetItemInBeltSlot(pInventory, nBeltSlot)'), out);
    assert.ok(out.includes('pInventory->nSignatureMagic'), out);
  });

  it('leaves a parameter the convention passes in a register', () => {
    same(`void __fastcall f(int a, int b) { int aSaved = a; g(&a); h(aSaved, a); }`);
  });

  it('leaves it when the copy is never read after the address goes out', () => {
    same(`void f(int a) { int aSaved = a; h(aSaved); g(&a); h(a); }`);
  });

  it('leaves it when the parameter is written before its address goes out', () => {
    same(`void f(int a) { int aSaved = a; a = 3; g(&a); h(aSaved, a); }`);
  });

  it('leaves it when the address argument is under a branch', () => {
    same(`void f(int a) { int aSaved = a; if (c) { g(&a); } h(aSaved, a); }`);
  });

  it('leaves it when the copy is written again', () => {
    same(`void f(int a) { int aSaved = a; g(&a); aSaved = 2; h(aSaved, a); }`);
  });

  it('leaves it when later mentions mix the whole slot and a byte of it', () => {
    same(`void f(int a) { int aSaved = a; g(&a); h(aSaved, *(uint8_t*)((char*)&a + 3)); }`);
  });

  it('leaves it when the copy has another type', () => {
    same(`void f(int a) { short aSaved = a; g(&a); h(aSaved, a); }`);
  });

  it('leaves it when the call also reads the parameter', () => {
    same(`void f(int a) { int aSaved = a; g(a, &a); h(aSaved, a); }`);
  });
});
