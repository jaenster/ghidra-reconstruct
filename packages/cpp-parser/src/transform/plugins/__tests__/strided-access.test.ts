/**
 * strided-access: a strength-reduced byte-offset induction, a pointer stepped by sizeof(T),
 * and an n*sizeof(T) interior-constant address, each put back as the access path.
 *
 * Every positive shape is compiled twice - as Ghidra printed it and as rewritten - and both
 * run over the same data; the memory and the results must be identical. The fixtures'
 * structs hold only fixed-width integers, so the host (64-bit) lays them out as the target
 * does, and Ghidra's `(int)` pointer casts are compiled as `(intptr_t)` in the reference.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { stridedAccessPlugin, type StridedAccessOptions, type StructLayoutField } from '../builtins/strided-access.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const native = { skip: !hasNativeGpp() };

const f = (name: string, offset: number, size: number, type: string): StructLayoutField => ({ name, offset, size, type });

/** DRAW_EscMenu's item, cut down: 0x150 bytes, the fields the loop reads at their offsets. */
const ITEM: StructLayoutField[] = [
  f('nMenuItemType', 0, 4, 'int'),
  f('nExpansionOnly', 4, 4, 'int'),
  f('nYPosition', 8, 4, 'int'),
  f('szLocalizedImagePath', 0xc, 0x104, 'char[260]'),
  f('nImageIndex', 0x110, 4, 'int'),
  f('nSubImageCount', 0x114, 4, 'int'),
  f('fpDrawCallback', 0x118, 4, 'uint'),
  f('pDC6SubImages', 0x11c, 0x10, 'uint[4]'),
  f('nTail', 0x12c, 0x24, 'char[36]'),
];
const ITEM_SIZE = 0x150;

/** NPCMENU's D2NpcMenuOptions row, packed, 39 bytes. */
const ROW: StructLayoutField[] = [
  f('nNpcId', 0, 4, 'int'),
  f('nOptionsCount', 4, 4, 'int'),
  f('nOptionStringId', 8, 10, 'short[5]'),
  f('nOptionCallback', 0x12, 20, 'uint[5]'),
  f('bEnabled', 0x26, 1, 'byte'),
];

const OPTIONS: StridedAccessOptions = {
  structLayouts: { Item: ITEM, Row: ROW },
  aggregateSizes: { Item: ITEM_SIZE, Row: 39 },
  aggregateMembers: { Item: ITEM.map(x => x.name), Row: ROW.map(x => x.name) },
  structFields: {
    Item: Object.fromEntries(ITEM.map(x => [x.name, x.type])),
    Row: Object.fromEntries(ROW.map(x => [x.name, x.type])),
  },
  globalTypes: { gaTable: 'uint[52]', gpItems: 'Item *', gaRows: 'Row[48]' },
  typedefTargets: {},
  funcdefNames: [],
};

function rewrite(code: string, options: StridedAccessOptions = OPTIONS): string {
  return emit(stridedAccessPlugin.createTransformer(options)(parse(code)) as AnyNode).trim();
}

const PRELUDE = [
  'typedef unsigned int uint; typedef unsigned short ushort; typedef unsigned char byte; typedef uint32_t undefined4;',
  'struct Item { int nMenuItemType; int nExpansionOnly; int nYPosition; char szLocalizedImagePath[260];',
  '  int nImageIndex; int nSubImageCount; uint fpDrawCallback; uint pDC6SubImages[4]; char nTail[36]; };',
  'static_assert(sizeof(Item) == 0x150, "Item layout");',
  'struct __attribute__((packed)) Row { int nNpcId; int nOptionsCount; short nOptionStringId[5]; uint nOptionCallback[5]; byte bEnabled; };',
  'static_assert(sizeof(Row) == 39, "Row layout");',
].join('\n');

/** The Ghidra text compiled as the machine ran it: `(int)` is pointer-wide on the target. */
const asRef = (code: string) => code.replace(/\(int\)/g, '(intptr_t)').replace(/\(uint\)/g, '(uintptr_t)');

/** LoadDataForGame 0044d9f0: a byte offset stepping 4 over a 52-entry table, no counter. */
const G8 = `uint f(void) {
  uint initIndex;
  uint sum;
  sum = 0;
  initIndex = 0;
  do {
    if (*(uint *)((int)gaTable + initIndex) != 0) {
      sum = sum * 31 + *(uint *)((int)gaTable + initIndex);
    }
    initIndex = initIndex + 4;
  } while (initIndex < 0xd0);
  return sum;
}`;

/** DRAW_EscMenu 0047e3d0: a byte offset beside a counter, the base re-read from a global. */
const G5 = `int f(void) {
  int nOff; int nItemIndex; int nTableOffset; Item *pCurrentTable; int acc; int nCount;
  nCount = 7;
  acc = 0;
  nOff = 0;
  nItemIndex = 0;
  nTableOffset = 0;
  pCurrentTable = gpItems;
  do {
    acc = acc * 3 + *(int *)(pCurrentTable->szLocalizedImagePath + nOff + -8);
    *(int *)(pCurrentTable->szLocalizedImagePath + nOff + -4) = acc & 0xff;
    if (*(uint *)(pCurrentTable->szLocalizedImagePath + nOff + 0x10c) != 0) {
      acc = acc + (int)*(uint *)((int)pCurrentTable->pDC6SubImages + nOff);
      pCurrentTable = gpItems;
    }
    acc = acc + (int)gpItems->pDC6SubImages[*(int *)(gpItems->szLocalizedImagePath + nOff + 0x104) + nTableOffset];
    switch(*(undefined4 *)(pCurrentTable->szLocalizedImagePath + nOff + -0xc)) {
    case 1: acc = acc + 11; break;
    default: acc = acc - 1;
    }
    nTableOffset = nTableOffset + 0x54;
    nItemIndex = nItemIndex + 1;
    nOff = nOff + 0x150;
  } while (nItemIndex < nCount);
  return acc;
}`;

/** ESCMENU_LoadLocalizedImages 0047dbb0: an int* stepped by sizeof(Item)/4, biased into the item. */
const G5_POINTER = `int f(Item *pMenuTable) {
  int *pMenuItemData; int nItemIndex; int acc;
  acc = 0;
  nItemIndex = 0;
  pMenuItemData = &pMenuTable->nSubImageCount;
  do {
    if (pMenuItemData[-0x44] == 0) {
      acc = acc + *pMenuItemData;
      pMenuItemData[2] = acc;
    }
    acc = acc + (int)*(char *)(pMenuItemData + -0x42);
    nItemIndex = nItemIndex + 1;
    pMenuItemData = pMenuItemData + 0x54;
  } while (nItemIndex < 6);
  return acc;
}`;

/** NPCMENU_ConfigureMenuOption 004b6440: n*39 + &Row + 0x12 + i*4, and the walkers. */
const G10 = `void f(int nNpcMenuOptionId, int nOptionIdx, uint v) {
  int nMenuEntryByteOffset; uint *pnCallbackSlot; ushort *pnOptionStringIdSlot;
  nMenuEntryByteOffset = nNpcMenuOptionId * 0x27;
  *(uint *)(nMenuEntryByteOffset + (int)((char *)&gaRows + 0x12) + nOptionIdx * 4) = v;
  *(ushort *)(nMenuEntryByteOffset + (int)((char *)&gaRows + 8) + nOptionIdx * 2) = 0x1507;
  pnCallbackSlot = (uint *)(nMenuEntryByteOffset + (int)((char *)&gaRows + 0x16) + nOptionIdx * 4);
  pnOptionStringIdSlot = (ushort *)(nMenuEntryByteOffset + (int)((char *)&gaRows + 10) + nOptionIdx * 2);
  *pnCallbackSlot = *pnCallbackSlot + 1;
  *pnOptionStringIdSlot = *pnOptionStringIdSlot + 1;
}`;

describe('strided-access: the rewrites', () => {
  it('G8: a byte offset with no counter is rescaled to the index (LoadDataForGame)', () => {
    const out = rewrite(G8);
    assert.match(out, /if \(gaTable\[initIndex\] != 0\)/, out);
    assert.match(out, /sum = sum \* 31 \+ gaTable\[initIndex\];/, out);
    assert.match(out, /initIndex\+\+;/, out);
    assert.match(out, /while \(initIndex < 52\)/, out);
    assert.doesNotMatch(out, /\(int\)gaTable|0xd0|\+ 4;/, out);
  });

  it('G5: a byte offset beside the counter is the counter (DRAW_EscMenu)', () => {
    const out = rewrite(G5);
    assert.match(out, /acc = acc \* 3 \+ pCurrentTable\[nItemIndex\]\.nExpansionOnly;/, out);
    assert.match(out, /pCurrentTable\[nItemIndex\]\.nYPosition = acc & 0xff;/, out);
    assert.match(out, /if \(pCurrentTable\[nItemIndex\]\.fpDrawCallback != 0\)/, out);
    assert.match(out, /pCurrentTable\[nItemIndex\]\.pDC6SubImages\[0\]/, out);
    assert.match(out, /gpItems\[nItemIndex\]\.pDC6SubImages\[gpItems\[nItemIndex\]\.nImageIndex\]/, out);
    // A uint read of an int field keeps its type as a conversion.
    assert.match(out, /switch \(\(undefined4\)pCurrentTable\[nItemIndex\]\.nMenuItemType\)/, out);
    // The offset and the scaled offset have no reader left.
    assert.doesNotMatch(out, /nOff|nTableOffset/, out);
  });

  it('G5 (a2): a pointer stepped by sizeof(T) with an interior bias is the element', () => {
    const out = rewrite(G5_POINTER);
    assert.match(out, /if \(pMenuTable\[nItemIndex\]\.nExpansionOnly == 0\)/, out);
    assert.match(out, /acc = acc \+ pMenuTable\[nItemIndex\]\.nSubImageCount;/, out);
    assert.match(out, /pMenuTable\[nItemIndex\]\.pDC6SubImages\[0\] = acc;/, out);
    assert.match(out, /\(int\)pMenuTable\[nItemIndex\]\.szLocalizedImagePath\[0\]/, out);
    assert.doesNotMatch(out, /pMenuItemData/, out);
  });

  it('G10: the row product and the interior constant are the nested index', () => {
    const out = rewrite(G10);
    assert.match(out, /gaRows\[nNpcMenuOptionId\]\.nOptionCallback\[nOptionIdx\] = v;/, out);
    // A ushort store into a short field: same width, the store converts.
    assert.match(out, /gaRows\[nNpcMenuOptionId\]\.nOptionStringId\[nOptionIdx\] = 0x1507;/, out);
    assert.match(out, /pnCallbackSlot = &gaRows\[nNpcMenuOptionId\]\.nOptionCallback\[nOptionIdx \+ 1\];/, out);
    assert.match(out, /pnOptionStringIdSlot = \(ushort\*\)&gaRows\[nNpcMenuOptionId\]\.nOptionStringId\[nOptionIdx \+ 1\];/, out);
    assert.doesNotMatch(out, /nMenuEntryByteOffset|0x27|\(char\*\)&gaRows/, out);
  });
});

describe('strided-access: function-pointer slots', () => {
  // NPCMENU_ConfigureMenuOption with its real field type: D2NpcMenuOptionFunc *[5].
  const FN_ROW: StructLayoutField[] = ROW.map(x => x.name === 'nOptionCallback' ? { ...x, type: 'D2NpcMenuOptionFunc *[5]' } : x);
  const O: StridedAccessOptions = {
    ...OPTIONS,
    structLayouts: { ...OPTIONS.structLayouts, Row: FN_ROW },
    structFields: { ...OPTIONS.structFields, Row: Object.fromEntries(FN_ROW.map(x => [x.name, x.type])) },
    funcdefNames: ['D2NpcMenuOptionFunc'],
  };
  it('a code* store into a funcdef slot is the slot, and the (code *) on the function goes', () => {
    const code = `void f(int nNpcMenuOptionId, int nOptionIdx) {
      int nMenuEntryByteOffset;
      nMenuEntryByteOffset = nNpcMenuOptionId * 0x27;
      *(code **)(nMenuEntryByteOffset + (int)((char *)&gaRows + 0x12) + nOptionIdx * 4) = (code *)NPCMENU_OpenTradeWithNpc;
    }`;
    const out = rewrite(code, O);
    assert.match(out, /gaRows\[nNpcMenuOptionId\]\.nOptionCallback\[nOptionIdx\] = NPCMENU_OpenTradeWithNpc;/, out);
    assert.doesNotMatch(out, /code/, out);
  });
});

describe('strided-access: compiled, the same memory and the same results', () => {
  const tables = [
    'uint gaTable[52]; Item gItems[8]; Item *gpItems = gItems; Row gaRows[48];',
    'static void fill(uint seed) {',
    '  uint x = seed;',
    '  auto next = [&]() { x = x * 1103515245u + 12345u; return x >> 8; };',
    '  for (int i = 0; i < 52; i++) gaTable[i] = (i % 5 == 0) ? 0 : next();',
    '  byte *p = (byte *)gItems; for (size_t i = 0; i < sizeof gItems; i++) p[i] = (byte)next();',
    '  for (int i = 0; i < 8; i++) { gItems[i].nImageIndex = next() & 3; gItems[i].nMenuItemType = next() & 1; }',
    '  byte *r = (byte *)gaRows; for (size_t i = 0; i < sizeof gaRows; i++) r[i] = (byte)next();',
    '}',
  ].join('\n');
  const run = (code: string, call: string, extraBody = '') => {
    const lowered = rewrite(code);
    const prelude = [PRELUDE, tables, `namespace ref { ${asRef(code)} }`, `namespace low { ${lowered} }`].join('\n');
    const body = [
      'int bad = 0;',
      'for (uint seed = 1; seed < 40; seed++) {',
      '  fill(seed); long long a = (long long)(ref::' + call + ');',
      '  static byte m1[sizeof gItems + sizeof gaRows]; memcpy(m1, gItems, sizeof gItems); memcpy(m1 + sizeof gItems, gaRows, sizeof gaRows);',
      '  fill(seed); long long b = (long long)(low::' + call + ');',
      '  static byte m2[sizeof gItems + sizeof gaRows]; memcpy(m2, gItems, sizeof gItems); memcpy(m2 + sizeof gItems, gaRows, sizeof gaRows);',
      '  if (a != b || memcmp(m1, m2, sizeof m1) != 0) bad++;',
      extraBody,
      '}',
      'printf("%d\\n", bad);',
    ].join('\n');
    return { out: compileAndRun(prelude, body).trim(), lowered };
  };

  it('G8', native, () => {
    const { out, lowered } = run(G8, 'f()');
    assert.strictEqual(out, '0', lowered);
  });
  it('G5', native, () => {
    const { out, lowered } = run(G5, 'f()');
    assert.strictEqual(out, '0', lowered);
  });
  it('G5 (a2)', native, () => {
    const { out, lowered } = run(G5_POINTER, 'f(gItems + (seed % 2))');
    assert.strictEqual(out, '0', lowered);
  });
  it('G10 over every row and option slot', native, () => {
    const lowered = rewrite(G10);
    const prelude = [PRELUDE, 'Row gaRows[48];', `namespace ref { ${asRef(G10)} }`, `namespace low { ${lowered} }`].join('\n');
    const body = [
      'static Row a[48], b[48]; int bad = 0;',
      'for (int n = 0; n < 48; n++) for (int i = 0; i < 4; i++) {',
      '  memset(gaRows, n + i, sizeof gaRows); ref::f(n, i, 0x1234 + n * 7 + i); memcpy(a, gaRows, sizeof a);',
      '  memset(gaRows, n + i, sizeof gaRows); low::f(n, i, 0x1234 + n * 7 + i); memcpy(b, gaRows, sizeof b);',
      '  if (memcmp(a, b, sizeof a) != 0) bad++;',
      '}',
      'printf("%d\\n", bad);',
    ].join('\n');
    assert.strictEqual(compileAndRun(prelude, body).trim(), '0', lowered);
  });
});

describe('strided-access: what is left alone', () => {
  it('an offset that is also returned is not rescaled', () => {
    const out = rewrite(G8.replace('  return sum;', '  return sum + initIndex;'));
    assert.match(out, /\(int\)gaTable \+ initIndex/, out);
  });

  it('a counter that does not step with the offset proves nothing', () => {
    const code = G5.replace('    nItemIndex = nItemIndex + 1;', '    if (acc > 0) { nItemIndex = nItemIndex + 1; }');
    const out = rewrite(code);
    assert.doesNotMatch(out, /pCurrentTable\[nItemIndex\]/, out);
  });

  it('an unknown write to the offset breaks the relation on every path through it', () => {
    const code = G5.replace('    switch(', '    nOff = nOff | 0;\n    switch(');
    const out = rewrite(code);
    assert.doesNotMatch(out, /pCurrentTable\[nItemIndex\]/, out);
    assert.match(out, /nOff/, out);
  });

  it('an element size that is not the stride is left as it is', () => {
    const out = rewrite(G8.replace(/initIndex \+ 4/, 'initIndex + 8').replace('0xd0', '0x1a0'),
      { ...OPTIONS, globalTypes: { ...OPTIONS.globalTypes, gaTable: 'Item[4]' } });
    assert.doesNotMatch(out, /gaTable\[/, out);
  });

  it('a union element is never resolved', () => {
    const out = rewrite(G10, { ...OPTIONS, unionNames: ['Row'] });
    assert.match(out, /nMenuEntryByteOffset/, out);
  });

  it('a plain row access with no derived term is not touched', () => {
    const code = `int f(int i) { return *(int *)((char *)&gaRows + 4); }`;
    assert.match(rewrite(code), /\*\(int\*\)\(\(char\*\)&gaRows \+ 4\)/);
  });

  // net_sid's SHA-1: `nRound += 5` over a uint W[80], unrolled by five. Rescaling would
  // only write `W[nRound * 5]`; the source's loop already IS the index.
  it('an index stepping by more than one element is not rescaled', () => {
    const code = `uint f(uint *W) { int nRound; uint acc; acc = 0; nRound = 0x14;
      do { acc = acc + W[nRound] + W[nRound + 1]; nRound = nRound + 5; } while (nRound < 0x28); return acc; }`;
    const out = rewrite(code);
    assert.match(out, /W\[nRound\]/, out);
    assert.match(out, /nRound < 0x28/, out);
  });

  it('a byte table is never the base of a fold', () => {
    const code = `int f(int n) { int off; int acc; acc = 0; off = 0;
      do { acc = acc + *(int *)(gaBytes + off + 0xc); off = off + 0x10; } while (off < 0x100); return acc; }`;
    const out = rewrite(code, { ...OPTIONS, globalTypes: { ...OPTIONS.globalTypes, gaBytes: 'byte[256]' } });
    assert.match(out, /gaBytes \+ off/, out);
  });

  it('a walker inside a field array keeps its pointer', () => {
    const code = `int f(Item *p) { char *pc; int n; int acc; acc = 0; n = 0x104; pc = p->szLocalizedImagePath;
      do { acc = acc + *pc; pc = pc + 1; n = n + -1; } while (n != 0); return acc; }`;
    assert.match(rewrite(code), /acc \+ \*pc/);
  });
});
