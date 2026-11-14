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

  it('an older four-field row has no width (unknown), and parses as it did before widths', () => {
    const r = parseAccessOrderRow('00576e40\t55\t\t43:0,?,1,-');
    assert.deepStrictEqual(r?.facts.stores[0][1][0], { ord: 0, at: null, size: 1, half: null });
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

describe('ACCESS_ORDER_TOKEN_JAVA: a stack slot carried into a call', () => {
  // CreateMissileOrMonster 00466730: `sCreateData.nUnitGUID = nNextGUID` is a COPY at the
  // CALL (+0x66) feeding the call's INDIRECT on the slot; the frame block writes the slot
  // twice (the zero at +0x36, the value at +0x50), so the block scan finds no single write.
  // NET_D2GS_CLIENT_Incoming0x0C_UNITCHANGE 0045cc70: `msg.nItemId = ...` is the INDIRECT.
  it('takes the slot from the INDIRECT the op is or feeds, at that CALL', () => {
    assert.match(ACCESS_ORDER_TOKEN_JAVA, /swi\.getFlowType\(\)\.isCall\(\) && sout != null/);
    assert.match(ACCESS_ORDER_TOKEN_JAVA, /sop\.getOpcode\(\) == ghidra\.program\.model\.pcode\.PcodeOp\.INDIRECT && sout\.getAddress\(\)\.isStackAddress\(\)/);
    assert.match(ACCESS_ORDER_TOKEN_JAVA, /cd\.getOpcode\(\) != ghidra\.program\.model\.pcode\.PcodeOp\.INDIRECT[\s\S]*!cd\.getSeqnum\(\)\.getTarget\(\)\.equals\(sat\)/);
  });

  it('picks the nearest write to exactly that slot on the one path into the call', () => {
    // Only when nothing else named it, and never across a branch target.
    assert.match(ACCESS_ORDER_TOKEN_JAVA, /soff\.equals\("\?"\) && csize > 0/);
    assert.match(ACCESS_ORDER_TOKEN_JAVA, /cref\.getReferenceType\(\)\.isFlow\(\)\) \{ cent = true/);
    // A write covering the slot only partly leaves it unknown.
    assert.match(ACCESS_ORDER_TOKEN_JAVA, /chit = co == cslot && cw == csize && chit == 0 \? 1 : -1/);
  });
});
