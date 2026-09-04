import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { frameGroupLocalsPlugin } from '../builtins/frame-group-locals.js';
import type { StackSlot } from '../builtins/stack-frame-address.js';

describe('frameGroupLocalsPlugin', () => {
  function run(code: string, slots: StackSlot[]): string {
    const transformer = frameGroupLocalsPlugin.createTransformer({ slots });
    return emit(transformer(parse(code)) as AnyNode);
  }

  /**
   * `Storm::WindowHandle::WND_DispatchWindowMessage` @0x00420b00 as Ghidra first
   * decompiled it: seven `undefined4` slots from -36 with a four-byte hole at
   * -16, the first slot's address handed to `SEvtDispatch`, and the callee
   * reading +0/+4/+8/+12 and writing +24/+28.
   */
  const dispatchSlots: StackSlot[] = [
    { name: 'hMsgWnd', offset: -36, size: 4 },
    { name: 'uMsgL', offset: -32, size: 4 },
    { name: 'nMsgWParam', offset: -28, size: 4 },
    { name: 'dwMsgLParam', offset: -24, size: 4 },
    { name: 'nCmdCode', offset: -20, size: 4 },
    { name: 'dwResult1', offset: -12, size: 4 },
    { name: 'dwResult2', offset: -8, size: 4 },
  ];

  const dispatchBody = `uint32_t f(HWND hCur, uint32_t uMsg) {
    uint32_t hMsgWnd;
    uint32_t uMsgL;
    uint32_t nMsgWParam;
    uint32_t dwMsgLParam;
    uint32_t nCmdCode;
    uint32_t dwResult1;
    uint32_t dwResult2;
    hMsgWnd = (uint32_t)hCur;
    uMsgL = uMsg;
    SEvtDispatch(1, hCur, uMsg, (uintptr_t)&hMsgWnd);
    return dwResult1 + dwResult2 + nCmdCode;
  }`;

  it('groups a contiguous run and reserves the hole inside it', () => {
    const out = run(dispatchBody, dispatchSlots);

    // One struct, members in FRAME order, not declaration order.
    const struct = /struct\s+__frame0_t\s*\{([\s\S]*?)\}\s*;/.exec(out);
    assert.ok(struct, `expected a group struct in:\n${out}`);
    const fields = [...struct[1].matchAll(/(\w+)\s+(\w+)(\[\d+\])?\s*;/g)].map(m => m[2]);
    assert.deepStrictEqual(fields, [
      'hMsgWnd', 'uMsgL', 'nMsgWParam', 'dwMsgLParam', 'nCmdCode',
      '__pad20', 'dwResult1', 'dwResult2',
    ], out);

    // The four bytes nothing owns at -16 are reserved, so +24 still reaches
    // dwResult1.
    assert.ok(/uint8_t\s+__pad20\[4\]\s*;/.test(out), `expected the -16 hole reserved in:\n${out}`);

    // The address that escapes is the address of the group's first member,
    // which is the address of the group.
    assert.ok(/&__frame0\.hMsgWnd/.test(out), `expected &__frame0.hMsgWnd in:\n${out}`);

    // Every use is respelled, and no bare local survives.
    assert.ok(/__frame0\.dwResult1\s*\+\s*__frame0\.dwResult2/.test(out), out);
    const afterStruct = out.slice(out.indexOf('};') + 2);
    assert.ok(
      !/\buint32_t\s+(hMsgWnd|uMsgL|nMsgWParam|dwMsgLParam|nCmdCode|dwResult1|dwResult2)\s*;/.test(afterStruct),
      `no grouped slot may stay a free local:\n${out}`,
    );
  });

  it('asserts the group size, so a wrong member width fails at compile time', () => {
    const out = run(dispatchBody, dispatchSlots);
    assert.ok(
      /static_assert\(sizeof\(void\s*\*\)\s*!=\s*4\s*\|\|\s*sizeof\(__frame0_t\)\s*==\s*32\s*,/.test(out),
      `expected a 32-byte size assert in:\n${out}`,
    );
  });

  it('rounds the asserted size up to the widest member, as the ABI does', () => {
    // 4 + 2 + 1 = 7 bytes of members; `sizeof` is 8.
    const out = run(
      `void f() { uint32_t a; uint16_t b; uint8_t c; g(&a); h(a, b, c); }`,
      [
        { name: 'a', offset: -12, size: 4 },
        { name: 'b', offset: -8, size: 2 },
        { name: 'c', offset: -6, size: 1 },
      ],
    );
    assert.ok(/sizeof\(__frame0_t\)\s*==\s*8\s*,/.test(out), `expected sizeof == 8 in:\n${out}`);
    assert.ok(/uint16_t\s+b\s*;/.test(out) && /uint8_t\s+c\s*;/.test(out), out);
  });

  it('leaves a genuine single-word out-param alone', () => {
    // `SRegLoadValue(&nValue)` is correct as it stands: nothing sits contiguously
    // after nValue, so nothing can be reached by offset from it.
    const out = run(
      `void f() { uint32_t nValue; uint32_t hFile; SRegLoadValue(&nValue); SFILE_OpenFileEx(&hFile); }`,
      [
        { name: 'hFile', offset: -24, size: 4 },
        { name: 'nValue', offset: -8, size: 4 },
      ],
    );
    assert.ok(!/__frame\d/.test(out), `must not group a lone out-param:\n${out}`);
    assert.ok(/&nValue/.test(out) && /&hFile/.test(out), out);
  });

  it('leaves an address that never escapes alone', () => {
    const out = run(
      `void f() { uint32_t a; uint32_t b; a = *&a + b; }`,
      [
        { name: 'a', offset: -8, size: 4 },
        { name: 'b', offset: -4, size: 4 },
      ],
    );
    assert.ok(!/__frame\d/.test(out), `*&a keeps the address inside the expression:\n${out}`);
  });

  it('skips rather than mis-lays-out a frame whose alignment cannot be reproduced', () => {
    // Ghidra puts a 4-byte slot two bytes after a 2-byte one. A struct member
    // cannot sit at offset 2 with its natural 4-byte alignment, so the run stops
    // at the first member and the group is dropped.
    const out = run(
      `void f() { uint16_t w; uint32_t d; g(&w); h(w, d); }`,
      [
        { name: 'w', offset: -10, size: 2 },
        { name: 'd', offset: -8, size: 4 },
      ],
    );
    assert.ok(!/__frame\d/.test(out), `an unreproducible offset must be skipped:\n${out}`);
    assert.ok(/uint16_t\s+w\s*;/.test(out) && /uint32_t\s+d\s*;/.test(out), out);
  });

  it('skips a run whose member type has no size this pass can name', () => {
    const out = run(
      `void f() { uint32_t a; D2UnitStrc opaque; uint32_t c; g(&a); h(a, c); }`,
      [
        { name: 'a', offset: -12, size: 4 },
        { name: 'opaque', offset: -8, size: 4 },
        { name: 'c', offset: -4, size: 4 },
      ],
    );
    assert.ok(!/__frame\d/.test(out), `an opaque member ends the run, leaving one member:\n${out}`);
  });

  it('skips a member whose emitted width disagrees with the frame slot', () => {
    // Ghidra committed 4 bytes to `b`; the body declares it as 2. One of the two
    // is wrong, and guessing which moves every later member.
    const out = run(
      `void f() { uint32_t a; uint16_t b; uint32_t c; g(&a); h(a, b, c); }`,
      [
        { name: 'a', offset: -12, size: 4 },
        { name: 'b', offset: -8, size: 4 },
        { name: 'c', offset: -4, size: 4 },
      ],
    );
    assert.ok(!/__frame\d/.test(out), `a width disagreement must stop the run:\n${out}`);
  });

  it('stops the run at a hole wider than one stack slot', () => {
    const out = run(
      `void f() { uint32_t a; uint32_t b; uint32_t far; g(&a); h(a, b, far); }`,
      [
        { name: 'a', offset: -40, size: 4 },
        { name: 'b', offset: -36, size: 4 },
        { name: 'far', offset: -8, size: 4 },
      ],
    );
    assert.ok(/struct\s+__frame0_t/.test(out), out);
    assert.ok(/__frame0\.b\b/.test(out), out);
    assert.ok(!/__frame0\.far\b/.test(out), `a 24-byte hole is a break, not padding:\n${out}`);
    assert.ok(/uint32_t\s+far\s*;/.test(out), `far stays a free local:\n${out}`);
  });

  it('reserves the bytes of a slot the body never declares', () => {
    const out = run(
      `void f() { uint32_t a; uint32_t c; g(&a); h(a, c); }`,
      [
        { name: 'a', offset: -12, size: 4 },
        { name: 'dropped', offset: -8, size: 4 },
        { name: 'c', offset: -4, size: 4 },
      ],
    );
    assert.ok(/uint8_t\s+__pad4\[4\]\s*;/.test(out), `the dropped slot's bytes must be held:\n${out}`);
    assert.ok(/sizeof\(__frame0_t\)\s*==\s*12\s*,/.test(out), out);
  });

  it('turns a grouped local\'s initializer into an assignment where it stood', () => {
    const out = run(
      `void f(int x) { uint32_t a; if (x) { uint32_t b = x + 1; b = x; } g(&a); h(a); }`,
      [
        { name: 'a', offset: -8, size: 4 },
        { name: 'b', offset: -4, size: 4 },
      ],
    );
    assert.ok(/if\s*\(x\)\s*\{\s*__frame0\.b\s*=\s*x\s*\+\s*1;\s*__frame0\.b\s*=\s*x;/.test(out.replace(/\n\s*/g, ' ')), out);
    assert.ok(!/uint32_t\s+b\s*=/.test(out), `the sunk declaration must be gone:\n${out}`);
  });

  it('does not rewrite a struct field that shares a local\'s name', () => {
    const out = run(
      `void f(RECT *pRect) { uint32_t nLeft; uint32_t nTop; pRect->nLeft = nLeft; g(&nLeft); h(nTop); }`,
      [
        { name: 'nLeft', offset: -8, size: 4 },
        { name: 'nTop', offset: -4, size: 4 },
      ],
    );
    assert.ok(/pRect->nLeft\s*=\s*__frame0\.nLeft/.test(out), `only the value use is respelled:\n${out}`);
  });

  it('does not rewrite a goto label that shares a local\'s name', () => {
    const out = run(
      `void f() { uint32_t a; uint32_t b; goto a_done; a_done: g(&a); h(b); }`,
      [
        { name: 'a', offset: -8, size: 4 },
        { name: 'b', offset: -4, size: 4 },
      ],
    );
    assert.ok(/goto\s+a_done\s*;/.test(out), `the label must survive:\n${out}`);
    assert.ok(/a_done\s*:/.test(out), out);
  });

  it('never groups parameters, whose frame position the ABI fixes', () => {
    const out = run(
      `void f(uint32_t p1, uint32_t p2) { g(&p1); h(p2); }`,
      [
        { name: 'p1', offset: 4, size: 4, isParameter: true },
        { name: 'p2', offset: 8, size: 4, isParameter: true },
      ],
    );
    assert.ok(!/__frame\d/.test(out), `parameters are not this pass's business:\n${out}`);
  });

  /**
   * `D2WINEDITBOX_HandleKeyPress` @0x004feae0. `get_stack_frame` reports ONE
   * variable at -1444, `undefined1[1024]`; the decompiler printed it as three
   * locals, and gcc laid the first two in reverse.
   */
  const editBoxSlots: StackSlot[] = [
    { name: 'local_5a4', offset: -1444, size: 1024 },
    { name: 'local_1a4', offset: -420, size: 144 },
  ];

  const editBoxBody = `void f(uint32_t n) {
    uint16_t local_5a4;
    uint8_t auStack_5a2[2];
    uint8_t auStack_5a0[1020];
    uint8_t local_1a4[144];
    uint16_t *pwszCursor;
    CONTAINER_InitializeBuffer(&local_5a4, 2, 0x200);
    pwszCursor = &local_5a4 + n;
    g((int)auStack_5a2, (int)auStack_5a0, local_1a4);
    h((int)pwszCursor - (uintptr_t)&local_5a4 >> 1);
  }`;

  it('emits an interior alias as a member of the variable that contains it', () => {
    const out = run(editBoxBody, editBoxSlots);

    const struct = /struct\s+__frame0_t\s*\{([\s\S]*?)\}\s*;/.exec(out);
    assert.ok(struct, `expected the split variable as one struct in:\n${out}`);
    const fields = [...struct[1].matchAll(/(\w+)\s+(\w+)(\[\d+\])?\s*;/g)].map(m => m[2]);
    assert.deepStrictEqual(fields, ['local_5a4', 'auStack_5a2', 'auStack_5a0'], out);

    // The struct is the WHOLE Ghidra variable, not just the pieces' sum by luck.
    assert.ok(
      /static_assert\(sizeof\(void\s*\*\)\s*!=\s*4\s*\|\|\s*sizeof\(__frame0_t\)\s*==\s*1024\s*,/.test(out),
      `the group must be the variable's full 1024 bytes in:\n${out}`,
    );

    // Every alias is respelled, and none survives as its own object.
    assert.ok(/&__frame0\.local_5a4/.test(out), out);
    assert.ok(/\(int\)__frame0\.auStack_5a2/.test(out), out);
    assert.ok(/\(int\)__frame0\.auStack_5a0/.test(out), out);
    const afterStruct = out.slice(out.indexOf('};') + 2);
    assert.ok(
      !/\buint8_t\s+auStack_5a[02]\s*\[/.test(afterStruct),
      `no alias may stay a free local:\n${out}`,
    );

    // A slot with no alias of its own is nobody's member: a split group covers
    // one variable and stops.
    assert.ok(/uint8_t\s+local_1a4\[144\]\s*;/.test(afterStruct), out);
    assert.ok(!/__frame\d\.local_1a4/.test(out), out);
  });

  it('needs no escaping address: the frame alone says the pieces are one object', () => {
    const out = run(
      `void f() { uint16_t local_5a4; uint8_t auStack_5a2[1022]; g(local_5a4, (int)auStack_5a2); }`,
      [{ name: 'local_5a4', offset: -1444, size: 1024 }],
    );
    assert.ok(/struct\s+__frame0_t/.test(out), `Ghidra's frame is the evidence:\n${out}`);
    assert.ok(/__frame0\.auStack_5a2/.test(out), out);
  });

  it('leaves an alias whose offset matches no frame variable alone', () => {
    // -0x5a2 sits outside the only variable's extent (-8 .. -4). Without an
    // extent there is nothing to be accurate about.
    const out = run(
      `void f() { uint32_t local_8; uint8_t auStack_5a2[2]; g(&local_8, (int)auStack_5a2); }`,
      [{ name: 'local_8', offset: -8, size: 4 }],
    );
    assert.ok(!/__frame\d/.test(out), `an unowned alias must be left alone:\n${out}`);
    assert.ok(/uint8_t\s+auStack_5a2\[2\]\s*;/.test(out), out);
  });

  it('does not fire on two genuinely separate Ghidra variables', () => {
    // Both names decode to an offset, but each is a frame variable in its own
    // right, so neither is interior to the other.
    const out = run(
      `void f() { uint32_t local_8; uint32_t local_c; g(local_8, local_c); }`,
      [
        { name: 'local_c', offset: -12, size: 4 },
        { name: 'local_8', offset: -8, size: 4 },
      ],
    );
    assert.ok(!/__frame\d/.test(out), `separate variables are not a split:\n${out}`);
  });

  it('places an alias by BYTES, not by the base type\'s stride', () => {
    // The variable is 16 bytes of `uint32_t`; the alias at -0x1c is 4 BYTES in,
    // which is element ONE, not element four. Reading the offset as a stride
    // would put it at byte 16 and off the end.
    const out = run(
      `void f() { uint32_t local_20; uint32_t auStack_1c[3]; g(&local_20, (int)auStack_1c); }`,
      [{ name: 'local_20', offset: -32, size: 16 }],
    );
    const struct = /struct\s+__frame0_t\s*\{([\s\S]*?)\}\s*;/.exec(out);
    assert.ok(struct, out);
    assert.deepStrictEqual(
      [...struct[1].matchAll(/(\w+)\s+(\w+)(\[\d+\])?\s*;/g)].map(m => m[2]),
      ['local_20', 'auStack_1c'],
      out,
    );
    // 4 + 12 = 16: the alias sits at byte 4, so no padding is needed and the
    // struct is exactly the variable.
    assert.ok(!/__pad/.test(out), `a byte-exact tiling needs no padding:\n${out}`);
    assert.ok(/sizeof\(__frame0_t\)\s*==\s*16\s*,/.test(out), out);
  });

  it('reserves the bytes an alias tiling leaves at either end', () => {
    // Nothing is printed for the first 4 bytes or the last 8 of a 32-byte
    // variable; both have to be held or the callee's offsets shift.
    const out = run(
      `void f() { uint32_t auStack_1c[2]; uint32_t auStack_14[3]; g(&auStack_1c, (int)auStack_14); }`,
      [{ name: 'local_20', offset: -32, size: 32 }],
    );
    const struct = /struct\s+__frame0_t\s*\{([\s\S]*?)\}\s*;/.exec(out);
    assert.ok(struct, out);
    assert.deepStrictEqual(
      [...struct[1].matchAll(/(\w+)\s+(\w+)(\[\d+\])?\s*;/g)].map(m => m[2]),
      ['__pad0', 'auStack_1c', 'auStack_14', '__pad24'],
      out,
    );
    assert.ok(/uint8_t\s+__pad0\[4\]\s*;/.test(out) && /uint8_t\s+__pad24\[8\]\s*;/.test(out), out);
    assert.ok(/sizeof\(__frame0_t\)\s*==\s*32\s*,/.test(out), out);
  });

  it('skips the whole split when one piece overruns the variable', () => {
    // Ghidra says 8 bytes; the pieces claim 4 + 8. One of the two is wrong, and a
    // half-conversion would be worse than the split.
    const out = run(
      `void f() { uint32_t local_10; uint32_t auStack_c[2]; g(&local_10, (int)auStack_c); }`,
      [{ name: 'local_10', offset: -16, size: 8 }],
    );
    assert.ok(!/__frame\d/.test(out), `an overrun must skip the group:\n${out}`);
  });

  it('skips the whole split when a piece cannot be moved', () => {
    // `auStack_c` is declared twice, so this pass cannot own its declaration.
    const out = run(
      `void f(int x) { uint32_t local_10; uint32_t auStack_c; if (x) { uint32_t auStack_c; g(auStack_c); } g(&local_10, auStack_c); }`,
      [{ name: 'local_10', offset: -16, size: 8 }],
    );
    assert.ok(!/__frame\d/.test(out), `an unmovable piece must skip the group:\n${out}`);
  });

  it('stops an escaping run at a split variable, as it stopped before', () => {
    const out = run(
      `void f() { uint32_t a; uint32_t b; uint16_t local_8; uint8_t auStack_6[2]; g(&a); h(a, b, local_8, (int)auStack_6); }`,
      [
        { name: 'a', offset: -16, size: 4 },
        { name: 'b', offset: -12, size: 4 },
        { name: 'local_8', offset: -8, size: 4 },
      ],
    );
    // The escaping run keeps a and b; the split variable is its own group.
    assert.ok(/__frame\d\.a\b/.test(out) && /__frame\d\.b\b/.test(out), out);
    assert.ok(/__frame\d\.auStack_6\b/.test(out), out);
    const groups = [...out.matchAll(/struct\s+(__frame\d+)_t/g)].map(m => m[1]);
    assert.strictEqual(groups.length, 2, `two rules, two groups:\n${out}`);
    assert.ok(!/sizeof\(__frame\d_t\)\s*==\s*16\s*,/.test(out), `the run must not swallow the split:\n${out}`);
  });

  /**
   * `LAUNCHER_LoadCharacterAppearanceFromD2s` @0x0043c8a0, verbatim from
   * `get_stack_frame`: ONE 8 KB save-file image at -9736 that Ghidra models as
   * thirteen named positions, then the next REAL variable at -1544. The delta is
   * 0x2000 exactly, and the body reads `fread(&local_2608, 1, 0x2000, ...)`.
   *
   * `local_25ca` and `local_2580` are frame positions the emitter does NOT
   * declare — `abVisualSlotOld` and `abEquipSlotNew` were widened to cover them —
   * so their bytes come through the wider member, not through a member of their
   * own.
   */
  const saveSlots: StackSlot[] = [
    { name: 'local_2608', offset: -9736, size: 4 },
    { name: 'dwSaveVersion', offset: -9732, size: 4 },
    { name: 'wLevel', offset: -9712, size: 2 },
    { name: 'cClassOld', offset: -9702, size: 1 },
    { name: 'wLevelOld', offset: -9700, size: 2 },
    { name: 'abEquipSlotOld', offset: -9698, size: 4 },
    { name: 'byPlayerClass', offset: -9693, size: 1 },
    { name: 'abVisualSlotOld', offset: -9682, size: 8 },
    { name: 'local_25ca', offset: -9674, size: 2 },
    { name: 'abEquipSlotNew', offset: -9672, size: 72 },
    { name: 'local_2580', offset: -9600, size: 16 },
    { name: 'loadBuffer', offset: -9584, size: 8040 },
    { name: 'szSavePathBuffer', offset: -1544, size: 1024, isArray: true },
    { name: 'szFilePath', offset: -520, size: 500, isArray: true },
    { name: 'pFile', offset: -20, size: 4 },
    { name: 'nLevel', offset: -16, size: 4 },
    { name: 'pEquipmentData', offset: -12, size: 4 },
    { name: 'dwUnused', offset: -8, size: 4 },
  ];

  const saveBody = `uint32_t f(char * szCharacterName) {
    uint32_t local_2608;
    uint32_t dwSaveVersion;
    uint16_t wLevel;
    char cClassOld;
    uint16_t wLevelOld;
    byte abEquipSlotOld[2];
    char cStack_25e0;
    byte byPlayerClass;
    byte abVisualSlotOld[10];
    byte abEquipSlotNew[88];
    byte loadBuffer[8040];
    char szSavePathBuffer[1024];
    char szFilePath[500];
    uint32_t nLevel;
    size_t nBytesRead = fread((D2CharSelCompStrc*)&local_2608, 1, 0x2000, pSaveFile);
    return local_2608 + dwSaveVersion + wLevel + cClassOld + wLevelOld
      + abEquipSlotOld[0] + cStack_25e0 + byPlayerClass + abVisualSlotOld[0]
      + abEquipSlotNew[0] + loadBuffer[0] + nLevel;
  }`;

  it('extends the group to the byte count the call writes', () => {
    const out = run(saveBody, saveSlots);

    // 0x2000 from -9736 ends at -1544, exactly where szSavePathBuffer starts.
    assert.ok(
      /static_assert\(sizeof\(void\s*\*\)\s*!=\s*4\s*\|\|\s*sizeof\(__frame0_t\)\s*==\s*8192\s*,/.test(out),
      `the group must span the whole 0x2000 write:\n${out}`,
    );
    assert.ok(/&__frame0\.local_2608/.test(out), out);

    // The variable the span ENDS at stays outside it.
    assert.ok(/char\s+szSavePathBuffer\[1024\]\s*;/.test(out), `the next real variable is not swallowed:\n${out}`);
  });

  it('makes every named position inside the span a member at its own byte offset', () => {
    const out = run(saveBody, saveSlots);
    const struct = /struct\s+__frame0_t\s*\{([\s\S]*?)\}\s*;/.exec(out);
    assert.ok(struct, `expected a group struct in:\n${out}`);
    const fields = [...struct[1].matchAll(/(\w+)\s+(\w+)(\[\d+\])?\s*;/g)].map(m => m[2]);
    assert.deepStrictEqual(fields, [
      'local_2608', 'dwSaveVersion', '__pad8', 'wLevel', '__pad26', 'cClassOld',
      '__pad35', 'wLevelOld', 'abEquipSlotOld', 'cStack_25e0', '__pad41',
      'byPlayerClass', '__pad44', 'abVisualSlotOld', 'abEquipSlotNew', 'loadBuffer',
    ], out);

    // The interior alias is placed by BYTES inside the enclosing variable, the
    // same way the split rule places one.
    assert.ok(/__frame0\.cStack_25e0/.test(out), out);
    // And every one of them is respelled: none may stay a free local.
    const afterStruct = out.slice(out.indexOf('};') + 2);
    assert.ok(
      !/\b(uint32_t|uint16_t|char|byte)\s+(local_2608|dwSaveVersion|wLevel|cClassOld|wLevelOld|byPlayerClass)\s*;/.test(afterStruct),
      `no member may stay a free local:\n${out}`,
    );
  });

  it('refuses a count that would end inside the next real variable', () => {
    // 24 bytes from -32 ends at -8, which is the MIDDLE of `buf` at -12..-4.
    // The frame and the call contradict each other; guessing moves a field.
    const out = run(
      `void f() { uint32_t a; char buf[8]; memset(&a, 0, 24); g(buf); }`,
      [
        { name: 'a', offset: -32, size: 4 },
        { name: 'buf', offset: -12, size: 8, isArray: true },
      ],
    );
    assert.ok(!/__frame\d/.test(out), `a straddling count must be refused:\n${out}`);
  });

  it('refuses a count that runs past the saved frame pointer', () => {
    const out = run(
      `void f() { uint32_t a; uint32_t b; memset(&a, 0, 0x100); g(b); }`,
      [{ name: 'a', offset: -32, size: 4 }, { name: 'b', offset: -16, size: 4 }],
    );
    assert.ok(!/sizeof\(__frame\d_t\)\s*==\s*256/.test(out), `an over-long count must be refused:\n${out}`);
  });

  it('reaches frame bytes Ghidra never named', () => {
    // `MISSILE_CreateDebrisWithCollision` @0x004d2520: 0x5c from -96 ends at -4,
    // and nothing is named past -44. The bound is the saved frame pointer, not
    // the end of the last name Ghidra happened to give.
    const out = run(
      `void f() { int nSkillArgFlags; void* pSkillArgOwner; memset(&nSkillArgFlags, 0, 0x5c); g(pSkillArgOwner); }`,
      [
        { name: 'nSkillArgFlags', offset: -96, size: 4 },
        { name: 'pSkillArgOwner', offset: -92, size: 4 },
        { name: 'local_30', offset: -48, size: 4 },
      ],
    );
    assert.ok(
      /static_assert\(sizeof\(void\s*\*\)\s*!=\s*4\s*\|\|\s*sizeof\(__frame0_t\)\s*==\s*92\s*,/.test(out),
      `expected a 92-byte group in:\n${out}`,
    );
    assert.ok(/uint8_t\s+__pad8\[84\]\s*;/.test(out), `the unnamed tail is reserved:\n${out}`);
  });

  it('extends across a hole wider than an inferred run may cross', () => {
    // The 12-byte hole between a and b is wider than MAX_GAP, so the escape rule
    // stops at a. The literal count says the object is 20 bytes.
    const out = run(
      `void f() { uint32_t a; uint32_t b; memset(&a, 0, 0x14); g(b); }`,
      [{ name: 'a', offset: -32, size: 4 }, { name: 'b', offset: -16, size: 4 }],
    );
    assert.ok(
      /static_assert\(sizeof\(void\s*\*\)\s*!=\s*4\s*\|\|\s*sizeof\(__frame0_t\)\s*==\s*20\s*,/.test(out),
      `expected a 20-byte group in:\n${out}`,
    );
    assert.ok(/uint8_t\s+__pad4\[12\]\s*;/.test(out), `the hole is padding inside the object:\n${out}`);
  });

  it('does not group on a count that is not literal at the call site', () => {
    const out = run(
      `void f(int n) { uint32_t a; uint32_t b; memset(&a, 0, n); g(b); }`,
      [{ name: 'a', offset: -32, size: 4 }, { name: 'b', offset: -16, size: 4 }],
    );
    assert.ok(!/__frame\d/.test(out), `a variable count proves nothing about the extent:\n${out}`);
  });

  it('does not group a count the destination already spans', () => {
    const out = run(
      `void f() { uint32_t a; uint32_t b; memset(&a, 0, 4); g(b); }`,
      [{ name: 'a', offset: -32, size: 4 }, { name: 'b', offset: -16, size: 4 }],
    );
    assert.ok(!/__frame\d/.test(out), `a write that fits is not this defect:\n${out}`);
  });

  it('ignores the SStrCopy no-limit sentinel', () => {
    const out = run(
      `void f() { char a[4]; uint32_t b; SStrCopy(a, s, 0x7fffffff); g(b); }`,
      [{ name: 'a', offset: -32, size: 4, isArray: true }, { name: 'b', offset: -16, size: 4 }],
    );
    assert.ok(!/__frame\d/.test(out), `0x7fffffff is "no limit", not a size:\n${out}`);
  });

  it('reads a bare array argument as the frame destination it decays to', () => {
    const out = run(
      `void f() { byte moduleInfo[8]; uint32_t tail; memset(moduleInfo, 0, 12); g(tail); }`,
      [{ name: 'moduleInfo', offset: -16, size: 8, isArray: true }, { name: 'tail', offset: -8, size: 4 }],
    );
    assert.ok(
      /static_assert\(sizeof\(void\s*\*\)\s*!=\s*4\s*\|\|\s*sizeof\(__frame0_t\)\s*==\s*12\s*,/.test(out),
      `expected a 12-byte group in:\n${out}`,
    );
  });

  it('does not read a heap pointer as a frame destination', () => {
    // `PALSHIFT_LoadPalShift` @0x00477170: `memset(pPalShiftEntry, 0, 0x1008)`
    // where `pPalShiftEntry` is an `int *` from `AllocClientMemory`. The bytes go
    // to the HEAP; reading 0x1008 as a frame extent invents a stack object.
    const out = run(
      `void f() { int* pPalShiftEntry; uint32_t b; pPalShiftEntry = (int*)alloc(0x1008); memset(pPalShiftEntry, 0, 0x1008); g(b); }`,
      [{ name: 'pPalShiftEntry', offset: -32, size: 4 }, { name: 'b', offset: -16, size: 4 }],
    );
    assert.ok(!/__frame\d/.test(out), `a heap destination is not a frame group:\n${out}`);
  });

  it('stops an inferred run at a group the count already claimed', () => {
    // `&a` escapes, so the run rule would take a and b. The 16-byte write from b
    // states b's extent, so b is not the run's to take and the run — down to one
    // declared member — does not form at all.
    const out = run(
      `void f() { uint32_t a; uint32_t b; uint32_t c; g(&a); memset(&b, 0, 0x10); h(c); }`,
      [
        { name: 'a', offset: -32, size: 4 },
        { name: 'b', offset: -28, size: 4 },
        { name: 'c', offset: -16, size: 4 },
      ],
    );
    const groups = [...out.matchAll(/struct\s+(__frame\d+)_t/g)].map(m => m[1]);
    assert.strictEqual(groups.length, 1, `the stated extent wins outright:\n${out}`);
    assert.ok(
      /static_assert\(sizeof\(void\s*\*\)\s*!=\s*4\s*\|\|\s*sizeof\(__frame0_t\)\s*==\s*16\s*,/.test(out),
      `expected the 16-byte written span in:\n${out}`,
    );
    assert.ok(/__frame0\.b\b/.test(out) && /__frame0\.c\b/.test(out), out);
    assert.ok(/uint32_t\s+a\s*;/.test(out), `a stays a free local:\n${out}`);
  });

  it('does nothing without a frame', () => {
    const code = 'void f() { uint32_t a; uint32_t b; g(&a); h(b); }';
    assert.strictEqual(run(code, []), emit(parse(code) as AnyNode));
  });
});
