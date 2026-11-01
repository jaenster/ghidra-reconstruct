import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseFunctionFacts, selectFacts, functionFactsScript } from './function-facts.js';
import { parseJumpTableRow, printsSwitch } from './jump-tables.js';
import { parseZeroStoreRow, printsMemberZeroStore } from './zero-stores.js';

// Rows as the facts script prints them for three functions, from the instructions the
// public Ghidra database shows (get_switch_table, get_disassembly):
//   GetUnitSizeX 00620510   cmp ecx, 5; ja 00620574; jmp [ecx*4 + 0062057c] at 00620521
//   ClearScreen 006b7f70    xor ecx, ecx; mov [ebp-0x10], ecx; mov [ebp-0xc], ecx;
//                           mov [ebp-0x4], eax; lea ecx, [ebp-0x10] (RECT at stack -0x14)
//   D2WINBUTTON_HandleMouseWheel 00500b50
//                           xor eax, eax; mov [ebp-0x1c..-0x4], eax; mov [ebp-0x20], ecx
const OUTPUT = [
  'P\tGame.exe:1783',
  'F\t00620510\tself\t-\t0\t1',
  'J\t00620510\t11:64:5:l:0=18,1=21,2=35,3=4d,4=44,5=64',
  'D\t',
  'F\t006b7f70\tself\t-\t0\t1',
  'Z\t006b7f70\tnViewportLeft,-14,10\t1\t29,e,XOR,r:ECX,r:ECX,ECX,-,-,-,-;35,-,MOV,m,r:ECX,-,-14:w,-10,4:r:ECX,-;38,-,MOV,m,r:ECX,-,-10:w,-c,4:r:ECX,-;3d,-,MOV,m,r:EAX,-,-8:w,-4,4:r:EAX,-;45,-,LEA,r:ECX,m,ECX,-14:a,-10,-,-',
  'D\t',
  'F\t00500b50\tself\t-\t0\t1',
  'Z\t00500b50\tsMsg,-24,20\t1\t5d,e,XOR,r:EAX,r:EAX,EAX,-,-,-,-;62,-,MOV,m,r:EAX,-,-20:w,-1c,4:r:EAX,-;65,-,MOV,m,i:0,-,-1c:w,-18,4:c:0,-;77,-,MOV,m,r:ECX,-,-24:w,-20,4:r:ECX,-',
  'D\t',
].join('\n');

describe('function facts - jump tables and zero stores', () => {
  const parsed = parseFunctionFacts(OUTPUT);

  it('reads the GetUnitSizeX table with its fallback and bound', () => {
    const row = parsed.rows.get('00620510')!;
    const facts = selectFacts('int f(U *p) {\n  switch(p->t) {\n  }\n  return 0;\n}', '00620510', row, false);
    assert.deepStrictEqual(facts.jumpTables, [{
      at: 0x11, fallback: 0x64, bound: 5, labelled: true,
      entries: [{ value: 0, target: 0x18 }, { value: 1, target: 0x21 }, { value: 2, target: 0x35 },
        { value: 3, target: 0x4d }, { value: 4, target: 0x44 }, { value: 5, target: 0x64 }],
    }]);
    // A decompile that prints no switch keeps no table.
    assert.strictEqual(selectFacts('int f(void) {\n  return 0;\n}', '00620510', row, false).jumpTables, undefined);
  });

  it('reads which bytes the opening stores zero', () => {
    const clear = selectFacts('void f(void) {\n  r.left = 0;\n}', '006b7f70', parsed.rows.get('006b7f70')!, false);
    assert.deepStrictEqual(clear.zeroStores, [{ name: 'nViewportLeft', offset: -0x14, size: 16, zero: [[0, 8]], other: [[12, 16]] }]);
    const wheel = selectFacts('int f(void) {\n  sMsg.uMsg = 0;\n}', '00500b50', parsed.rows.get('00500b50')!, false);
    assert.deepStrictEqual(wheel.zeroStores, [{ name: 'sMsg', offset: -0x24, size: 32, zero: [[4, 12]], other: [[0, 4]] }]);
  });

  it('drops malformed rows', () => {
    assert.deepStrictEqual(parseJumpTableRow('11:64:5:x:0=18'), []);
    assert.deepStrictEqual(parseJumpTableRow('11:-:-:i:0=18,q=1'), []);
    assert.deepStrictEqual(parseJumpTableRow('11:-:-:i:0=18'), [{ at: 0x11, labelled: false, entries: [{ value: 0, target: 0x18 }] }]);
    assert.deepStrictEqual(parseJumpTableRow('11:-:-:l:-1=18'), [{ at: 0x11, labelled: true, entries: [{ value: -1, target: 0x18 }] }]);
    assert.deepStrictEqual(parseZeroStoreRow('s,-8,8,0-x,'), []);
    assert.deepStrictEqual(parseZeroStoreRow('s,8,8\t0\t'), [{ name: 's', offset: 8, size: 8, zero: [], other: [] }]);
  });

  it('reads the functions the decompile shows a switch or a member zero store for', () => {
    assert.ok(printsSwitch('  switch(n) {'));
    assert.ok(!printsSwitch('  nSwitch = 1;'));
    assert.ok(printsMemberZeroStore('  sMsg.uLParam.nLParam = 0;'));
    assert.ok(printsMemberZeroStore('  r.p = (void *)0x0;'));
    assert.ok(!printsMemberZeroStore('  p->n = 0;'));
    assert.ok(!printsMemberZeroStore('  s.n = 1;'));
  });

  it('prints the J and Z rows from the script', () => {
    const script = functionFactsScript(['00620510']);
    assert.ok(script.includes('out.append("J\\t")'), 'J row');
    assert.ok(script.includes('out.append("Z\\t")'), 'Z row');
    assert.ok(script.includes('getJumpTables()'));
  });
});
