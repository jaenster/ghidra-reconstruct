import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ACCESS_ORDER_TOKEN_JAVA, parseAccessOrderRow } from './access-order.js';

describe('parseAccessOrderRow: store widths', () => {
  // SUNITNPC_ApplyScrollSkill 00576e40: lines 43 and 47 print `eUnitType._0_1_ = ...` for
  // `LEA EBX,[EDI+0x6]` (+0x51) and `MOV EBX,dword ptr [EDI]` (+0x59). The decompiler's op
  // writes one byte; the instruction writes four.
  it('reads the instruction width as the fifth field', () => {
    const r = parseAccessOrderRow('00576e40\t55\t\t42:0,?,4,-,4;43:0,?,1,-,4;47:0,?,1,-,4');
    assert.ok(r);
    assert.deepStrictEqual(r.facts.stores.map(([l, s]) => [l, s[0].size, s[0].width]), [[42, 4, 4], [43, 1, 4], [47, 1, 4]]);
  });

  // MONSTER_SpawnRoomMonsters 0054ec90: `MOV byte ptr [EBP-0x20],1`.
  it('a byte store at a known slot', () => {
    const r = parseAccessOrderRow('0054ec90\t300\t\t120:0,1b4,1,-,1');
    assert.deepStrictEqual(r?.facts.stores[0][1][0], { ord: 0, at: 0x1b4, size: 1, half: null, width: 1 });
  });

  it('an older four-field row has width 0 (unknown)', () => {
    const r = parseAccessOrderRow('00576e40\t55\t\t43:0,?,1,-');
    assert.strictEqual(r?.facts.stores[0][1][0].width, 0);
  });

  it('rejects any other field count', () => {
    assert.strictEqual(parseAccessOrderRow('00576e40\t55\t\t43:0,?,1'), null);
    assert.strictEqual(parseAccessOrderRow('00576e40\t55\t\t43:0,?,1,-,4,9'), null);
  });

  it('the script prints the width after the half', () => {
    assert.match(ACCESS_ORDER_TOKEN_JAVA, /append\(shalf\)\.append\(','\)\.append\(swid\)/);
    // A call's STORE is its return address, not a width of the value.
    assert.match(ACCESS_ORDER_TOKEN_JAVA, /!swi\.getFlowType\(\)\.isCall\(\)/);
  });
});
