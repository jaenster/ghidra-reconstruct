/**
 * `&stack0xNNNN` is an ADDRESS. Substituting the literal `0` for it produced
 * `*(int*)(0 + x)` — valid C++ that reads the wrong address with no diagnostic —
 * and `(0)[i]`, which at least failed. These pin the three answers the frame can
 * give and the one it cannot.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { stackFrameAddressPlugin, stackNameOffset } from '../builtins/stack-frame-address.js';

const SLOTS = [
  { name: 'szFormat', offset: 4, size: 4, isParameter: true },
  { name: 'szPath', offset: -268, size: 260, isArray: true },
  { name: 'local_20', offset: -32, size: 4 },
  { name: 'undeclared_slot', offset: -64, size: 4 },
];

function run(src: string, slots = SLOTS): string {
  const ast = parse(src);
  const transformed = stackFrameAddressPlugin.createTransformer({ slots })(ast);
  return emit(transformed as AnyNode).replace(/\s+/g, ' ').trim();
}

describe('stackNameOffset', () => {
  it('reads Ghidra\'s unsigned word as a signed frame offset', () => {
    assert.equal(stackNameOffset('stack0xfffffef3'), -269);
    assert.equal(stackNameOffset('stack0xffffffe0'), -32);
    assert.equal(stackNameOffset('stack0x0000000c'), 12);
  });

  it('is not fooled by a name that merely starts the same way', () => {
    assert.equal(stackNameOffset('stack0xzz'), null);
    assert.equal(stackNameOffset('stackPointer'), null);
  });
});

describe('stack-frame-address', () => {
  it('binds an address to the slot that starts there', () => {
    const out = run('void f() { int local_20; p = &stack0xffffffe0; }');
    assert.ok(out.includes('&local_20'), out);
    assert.ok(!out.includes('stack0x'), out);
  });

  it('anchors an address on the slot whose storage covers it', () => {
    // -264 is four bytes into `szPath`, which starts at -268.
    const out = run('void f() { char szPath[260]; p = &stack0xfffffef8; }');
    assert.ok(/\(uint8_t\s*\*\)&szPath \+ 4/.test(out), out);
  });

  it('keeps the anchored address whole when it is then subscripted', () => {
    // `((uint8_t*)&szPath + 4)[i]`, never `(uint8_t*)&szPath + 4[i]`.
    const out = run('void f() { char szPath[260]; p = (&stack0xfffffef8)[i]; }');
    assert.ok(/\(\(uint8_t\s*\*\)&szPath \+ 4\)\[i\]/.test(out), out);
  });

  it('LEAVES an address no slot owns, so it fails loudly', () => {
    // -272 is below every modelled slot and adjacent to none. There is no C++
    // spelling for it, and `0` was a silent read of the wrong address.
    const out = run('void f() { char szPath[260]; p = (&stack0xfffffef0)[i]; }');
    assert.ok(out.includes('stack0xfffffef0'), out);
    assert.ok(!out.includes('(0)['), out);
  });

  it('anchors a whole ELEMENT below an array of wider elements', () => {
    // `D2RoomExStrc *nRoomPtrs[60]` in a 240-byte slot is a 4-byte stride, so
    // -288 against a slot starting at -280 is `&nRoomPtrs[-2]` — the strided
    // walk MSVC pre-advances from one stride under the object.
    const slots = [{ name: 'nRoomPtrs', offset: -280, size: 240, isArray: true }];
    const out = run('void f() { D2RoomExStrc* nRoomPtrs[60]; p = &stack0xfffffee0; }', slots);
    assert.ok(/\(uint8_t\s*\*\)&nRoomPtrs - 8/.test(out), out);
    assert.ok(!out.includes('stack0x'), out);
  });

  it('refuses an offset below an array that is not an element boundary', () => {
    // Not a stride, so not a pre-advanced walk. No anchor, and the loud error stays.
    const slots = [{ name: 'nRoomPtrs', offset: -280, size: 240, isArray: true }];
    const out = run('void f() { D2RoomExStrc* nRoomPtrs[60]; p = &stack0xfffffee2; }', slots);
    assert.ok(out.includes('stack0xfffffee2'), out);
  });

  it('spells the frame pointer as a value when nothing offsets it', () => {
    // `PUSH EBP; POP [EBP-0x2dc]` — the frame pointer IS the datum being stored.
    const out = run('void f() { uint8_t* pContextEbp = &stack0xfffffffc; }');
    assert.ok(out.includes('__builtin_frame_address(0)'), out);
    assert.ok(!out.includes('stack0x'), out);
  });

  it('REFUSES the frame pointer when the body offsets it to reach a local', () => {
    // The Item.cpp shape. A materialised frame pointer here compiles and reads
    // whatever the compiler put at -0xc, which is a silent wrong answer.
    const out = run('void f() { uint8_t* puVar3 = &stack0xfffffffc; p = *(byte**)(puVar3 - 0xc); }');
    assert.ok(out.includes('stack0xfffffffc'), out);
    assert.ok(!out.includes('__builtin_frame_address'), out);
  });

  it('anchors one byte below an array on the array', () => {
    // MSVC's inlined strcat starts the scan at `szPath - 1` and pre-increments,
    // so the first byte it reads is `szPath[0]` and the walk stays in the array.
    const out = run('void f() { char szPath[260]; p = &stack0xfffffef3; }');
    assert.ok(/\(uint8_t\s*\*\)&szPath - 1/.test(out), out);
    assert.ok(!out.includes('stack0x'), out);
  });

  it('does NOT step below a scalar, whose extent cannot hold the walk', () => {
    // -33 is one below `local_20` (-32, size 4). Below an array the walk is
    // bounded by the array; below a scalar it runs into whatever the compiler
    // put next, so the frame is modelled too small and Ghidra owns the fix.
    const out = run('void f() { int local_20; p = &stack0xffffffdf; }');
    assert.ok(out.includes('stack0xffffffdf'), out);
  });

  it('does not step below an array when a slot owns the byte itself', () => {
    // -269 is inside `low`, so it is `low`'s byte, not `szPath - 1`.
    const out = run('void f() { char szPath[260]; int low; p = &stack0xfffffef3; }', [
      { name: 'szPath', offset: -268, size: 260, isArray: true },
      { name: 'low', offset: -272, size: 4 },
    ]);
    assert.ok(/\(uint8_t\s*\*\)&low \+ 3/.test(out), out);
  });

  it('will not bind to a slot the emitted body does not declare', () => {
    // Ghidra lists frame variables the emitter drops with the statement that used
    // them; binding to one trades a wrong address for an undeclared name.
    const out = run('void f() { p = &stack0xffffffc0; }');
    assert.ok(out.includes('stack0xffffffc0'), out);
    assert.ok(!out.includes('undeclared_slot'), out);
  });

  it('reads the address past the last parameter as the varargs list', () => {
    // `&stack0x00000008` in a function whose last named argument sits at +4 is
    // `va_start(ap, szFormat)`. Every positive frame offset in the corpus is
    // this, and the cdecl ABI - not the compiler - fixes the adjacency.
    const out = run('void f(char *szFormat) { p = &stack0x00000008; }');
    assert.ok(/\(uint8_t\s*\*\)&szFormat \+ 4/.test(out), out);
  });

  it('spells the varargs list `va_list`, which is what every caller takes', () => {
    // The address goes straight into a `v`-printf, whose parameter is `va_list` -
    // a `char*` on this ABI. Leaving it a `uint8_t*` is an invalid conversion at
    // every one of those calls, and the conversion is the ABI's, not a guess.
    const out = run('void f(char *szFormat) { vsprintf(buf, szFormat, &stack0x00000008); }');
    assert.ok(/\(va_list\)\s*\(\(uint8_t\s*\*\)&szFormat \+ 4\)/.test(out), out);
  });

  it('does NOT step past a local, whose frame position is the compiler\'s to choose', () => {
    // -28 is immediately past `local_20` (-32, size 4). For a parameter that step
    // is the ABI; for a local it is a guess.
    const out = run('void f() { int local_20; p = &stack0xffffffe4; }');
    assert.ok(out.includes('stack0xffffffe4'), out);
  });

  it('keeps the security-cookie seed a constant', () => {
    // `COOKIE ^ (uintptr_t)&stack0xfffffffc` is a frame IDENTITY: cast straight to
    // an integer, XORed, compared against itself, never dereferenced.
    const out = run('void f() { uint32_t local_8 = COOKIE ^ (uintptr_t)&stack0xfffffffc; }');
    assert.ok(out.includes('(uintptr_t)0'), out);
    assert.ok(!out.includes('stack0x'), out);
  });

  it('settles the cookie even for a function with no modelled frame', () => {
    const out = run('void f() { g((uintptr_t)&stack0xfffffffc); }', []);
    assert.ok(out.includes('(uintptr_t)0'), out);
  });

  it('does not treat an integer cast of frame ARITHMETIC as an identity', () => {
    // The cast is on the sum, not on the address, so the address is still an
    // address and still has to be accounted for.
    const out = run('void f() { g((int32_t)(&stack0xfffffef3 + n)); }');
    assert.ok(out.includes('stack0xfffffef3'), out);
  });
});
