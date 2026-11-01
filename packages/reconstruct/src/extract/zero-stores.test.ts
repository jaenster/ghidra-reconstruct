import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseZeroStoreRow, parseZeroStoreTrace } from './zero-stores.js';

/** A row as the facts script prints it: locals, ebp frame, one instruction per line. */
const row = (locals: string, frame: 0 | 1, insns: string[]) => `${locals}\t${frame}\t${insns.join(';')}`;

// The instructions are the database's (get_disassembly), offsets from the entry; the stack
// references are what Ghidra puts on an [EBP + d] operand: frame offset d - 4.

// D2WINBUTTON_HandleMouseWheel 00500b50: xor eax, eax; seven stores of EAX from
// [ebp-0x1c]; pControl at [ebp-0x20] takes ECX, its zero store dropped by the compiler.
const mouseWheel = row('sMsg,-24,20', 1, [
  '0,-,PUSH,r:EBP,-,ESP,-,-,-,-',
  '1,-,MOV,r:EBP,r:ESP,EBP,-,-,-,-',
  '5d,e,XOR,r:EAX,r:EAX,EAX,-,-,-,-',
  '5f,-,CMP,m,r:EAX,-,-,-,-,-',
  '62,-,MOV,m,r:EAX,-,-20:w,-1c,4:r:EAX,-',
  '65,-,MOV,m,r:EAX,-,-1c:w,-18,4:r:EAX,-',
  '68,-,MOV,m,r:EAX,-,-18:w,-14,4:r:EAX,-',
  '6b,-,MOV,m,r:EAX,-,-14:w,-10,4:r:EAX,-',
  '6e,-,MOV,m,r:EAX,-,-10:w,-c,4:r:EAX,-',
  '71,-,MOV,m,r:EAX,-,-c:w,-8,4:r:EAX,-',
  '74,-,MOV,m,r:EAX,-,-8:w,-4,4:r:EAX,-',
  '77,-,MOV,m,r:ECX,-,-24:w,-20,4:r:ECX,-',
  '7a,-,JZ,i:500be3,-,-,-,-,-,-',
  '86,-,LEA,r:EAX,m,EAX,-24:a,-20,-,-',
]);

// ClearScreen 006b7f70: xor ecx, ecx; left and top take ECX, bottom EAX (a global), the
// lea of the RECT for the call ends the run before right takes EDX.
const clearScreen = row('nViewportLeft,-14,10', 1, [
  '0,-,PUSH,r:EBP,-,ESP,-,-,-,-',
  '1,-,MOV,r:EBP,r:ESP,EBP,-,-,-,-',
  '1c,e,FLDZ,-,-,ST0,-,-,-,-',
  '1e,-,MOV,r:EAX,m,EAX,-,-,-,-',
  '23,-,MOV,r:EDX,m,EDX,-,-,-,-',
  '29,-,XOR,r:ECX,r:ECX,ECX,-,-,-,-',
  '2b,-,PUSH,r:ECX,-,ESP,-,-,-,-',
  '2c,-,PUSH,r:ECX,-,ESP,-,-,-,-',
  '2d,-,FSTP,m,-,ST0,-,-,4:?,-',
  '30,-,PUSH,i:ff000000,-,ESP,-,-,-,-',
  '35,-,MOV,m,r:ECX,-,-14:w,-10,4:r:ECX,-',
  '38,-,MOV,m,r:ECX,-,-10:w,-c,4:r:ECX,-',
  '3b,-,PUSH,i:1,-,ESP,-,-,-,-',
  '3d,-,MOV,m,r:EAX,-,-8:w,-4,4:r:EAX,-',
  '40,-,MOV,r:EAX,m,EAX,-,-,-,-',
  '45,-,LEA,r:ECX,m,ECX,-14:a,-10,-,-',
  '48,-,PUSH,r:ECX,-,ESP,-,-,-,-',
  '49,-,MOV,m,r:EDX,-,-c:w,-8,4:r:EDX,-',
]);

// FILETOOLS_StartApplicationWithCommandLine_UTF8 00404210: memset(&startupInfo.cb + 1, 0,
// 0x40) after cb = 0x44, then xor eax, eax and four stores into processInfo. No stack
// references here: the frame is 0x10858 bytes, so the [EBP + d] operands place them.
const fileTools = row('startupInfo,-1085c,44;processInfo,-10818,10', 1, [
  '0,-,PUSH,r:EBP,-,ESP,-,-,-,-',
  '1,-,MOV,r:EBP,r:ESP,EBP,-,-,-,-',
  '3,-,MOV,r:EAX,i:10858,EAX,-,-,-,-',
  '8,c,CALL,i:6831b0,-,ESP,-,-,-,__alloca_probe',
  '2d,-,LEA,r:EAX,m,EAX,-,-10804,-,-',
  '6c,e,PUSH,i:40,-,ESP,-,-,-,-',
  '6e,-,LEA,r:EDX,m,EDX,-,-10854,-,-',
  '74,-,PUSH,i:0,-,ESP,-,-,-,-',
  '76,-,PUSH,r:EDX,-,ESP,-,-,-,-',
  '77,-,MOV,m,i:44,-,-,-10858,4:c:44,-',
  '81,c,CALL,i:681ef0,-,ESP,-,-,-,memset',
  '86,-,ADD,r:ESP,i:c,ESP,-,-,-,-',
  '89,-,XOR,r:EAX,r:EAX,EAX,-,-,-,-',
  '8b,-,MOV,m,r:EAX,-,-,-10814,4:r:EAX,-',
  '91,-,MOV,m,r:EAX,-,-,-10810,4:r:EAX,-',
  '97,-,MOV,m,r:EAX,-,-,-1080c,4:r:EAX,-',
  '9d,-,MOV,m,r:EAX,-,-,-10808,4:r:EAX,-',
  'a3,-,LEA,r:EAX,m,EAX,-,-10814,-,-',
  'aa,-,LEA,r:ECX,m,ECX,-,-10858,-,-',
]);

describe('zero stores - the opening stores of a struct local, from the instructions', () => {
  it('counts the stores of a register the block zeroed (HandleMouseWheel)', () => {
    assert.deepStrictEqual(parseZeroStoreRow(mouseWheel), [{ name: 'sMsg', offset: -0x24, size: 32, zero: [[4, 32]], other: [[0, 4]] }]);
  });

  it('stops at the lea that hands the local to a call (ClearScreen)', () => {
    assert.deepStrictEqual(parseZeroStoreRow(clearScreen), [{ name: 'nViewportLeft', offset: -0x14, size: 16, zero: [[0, 8]], other: [[12, 16]] }]);
  });

  it('counts a memset of the local and places [EBP + d] without stack references (FILETOOLS)', () => {
    assert.deepStrictEqual(parseZeroStoreRow(fileTools), [
      { name: 'startupInfo', offset: -0x1085c, size: 0x44, zero: [[4, 0x44]], other: [[0, 4]] },
      { name: 'processInfo', offset: -0x10818, size: 16, zero: [[0, 16]], other: [] },
    ]);
  });

  it('counts a rep stos of a known zero over a known count', () => {
    const t = row('s,-24,20', 1, [
      '0,-,PUSH,r:EBP,-,ESP,-,-,-,-',
      '1,-,MOV,r:EBP,r:ESP,EBP,-,-,-,-',
      '10,-,MOV,r:ECX,i:8,ECX,-,-,-,-',
      '15,-,XOR,r:EAX,r:EAX,EAX,-,-,-,-',
      '17,-,LEA,r:EDI,m,EDI,-24:a,-20,-,-',
      '1a,-,STOSD.REP,m,r:EAX,ECX|EDI,-,-,-,-',
      '1c,-,MOV,m,i:5,-,-24:w,-20,4:c:5,-',
    ]);
    assert.deepStrictEqual(parseZeroStoreRow(t), [{ name: 's', offset: -0x24, size: 32, zero: [[0, 32]], other: [] }]);
  });

  it('forgets a zero register written since, or across a block entry', () => {
    const clobbered = mouseWheel.replace('5f,-,CMP,m,r:EAX,-,-,-,-,-', '5f,-,MOV,r:EAX,m,EAX,-,-,-,-');
    assert.deepStrictEqual(parseZeroStoreRow(clobbered)[0].zero, []);
    const entered = mouseWheel.replace('5f,-,CMP', '5f,e,CMP');
    assert.deepStrictEqual(parseZeroStoreRow(entered)[0].zero, []);
    // A sub-register store reads its own bytes of the value: AH of 0x100 is 1.
    const t = row('s,-8,4', 1, [
      '0,-,MOV,r:EAX,i:100,EAX,-,-,-,-',
      '5,-,MOV,m,r:AL,-,-8:w,-4,1:r:AL,-',
      '8,-,MOV,m,r:AH,-,-7:w,-3,1:r:AH,-',
    ]);
    assert.deepStrictEqual(parseZeroStoreRow(t), [{ name: 's', offset: -8, size: 4, zero: [[0, 1]], other: [[1, 2]] }]);
  });

  it('does not count a fill whose count or value is unknown, and its lea ends the run', () => {
    const t = row('s,-24,20', 1, [
      '15,-,XOR,r:EAX,r:EAX,EAX,-,-,-,-',
      '17,-,LEA,r:EDI,m,EDI,-24:a,-20,-,-',
      '1a,-,STOSD.REP,m,r:EAX,ECX|EDI,-,-,-,-',
      '1c,-,MOV,m,r:EAX,-,-24:w,-20,4:r:EAX,-',
    ]);
    assert.deepStrictEqual(parseZeroStoreRow(t), [{ name: 's', offset: -0x24, size: 32, zero: [], other: [] }]);
    const memsetOfOther = fileTools.replace('74,-,PUSH,i:0', '74,-,PUSH,i:1');
    assert.deepStrictEqual(parseZeroStoreRow(memsetOfOther)[0], { name: 'startupInfo', offset: -0x1085c, size: 0x44, zero: [], other: [] });
  });

  it('rejects a malformed row', () => {
    assert.strictEqual(parseZeroStoreTrace('s,-8,4\t1\t0,-,MOV'), null);
    assert.strictEqual(parseZeroStoreTrace('s,-8\t1\t'), null);
    assert.deepStrictEqual(parseZeroStoreRow('garbage'), []);
  });
});
