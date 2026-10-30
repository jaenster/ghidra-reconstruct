import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import {
  inlinedCallRestorePlugin, compileInlinedCallee,
  type InlinedCallee, type InlinedCallRestoreOptions,
} from '../builtins/inlined-call-restore.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const GRID = 'struct Grid { int *pCellsFlags; int *pCellsRowOffsets; int nWidth; };';

// DRLGGRID_GetCellAddress, 0067c4d0.
const GET_CELL: InlinedCallee = {
  callName: 'D2Common::Drlg::DrlgGrid::DRLGGRID_GetCellAddress',
  returnType: 'int *',
  params: 'Grid * pDrlgGrid, int nY, int nX',
  body: '\n  return pDrlgGrid->pCellsFlags + pDrlgGrid->pCellsRowOffsets[nY] + nX;\n',
};

// UNITS_GetAnimTableEntry, 00621420.
const ANIM_ENTRY: InlinedCallee = {
  callName: 'GetAnimTableEntry',
  returnType: 'unsigned char *',
  params: 'int nClassId, int nAnimMode',
  body: [
    '  if (nClassId < 0x19a) {',
    '    return (unsigned char *)(gaAnimTableClassic + nAnimMode * 5);',
    '  }',
    '  return (unsigned char *)(gaAnimTableExpansion + nAnimMode * 5);',
  ].join('\n'),
};

const TABLES: Partial<InlinedCallRestoreOptions> = {
  structFields: { Grid: { pCellsFlags: 'int *', pCellsRowOffsets: 'int *', nWidth: 'int' } },
  globalTypes: { gaAnimTableClassic: 'int [80]', gaAnimTableExpansion: 'int [80]' },
};

function run(lines: string[], callees: InlinedCallee[], opts: Partial<InlinedCallRestoreOptions> = {}): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = inlinedCallRestorePlugin.createTransformer({
    callees, onSite: e => sites.push(`${e.callee.split('::').pop()}:${e.form}`), ...TABLES, ...opts,
  } as InlinedCallRestoreOptions);
  return { out: flat(emit(t(parse(lines.join('\n'))) as AnyNode)), sites };
}

describe('inlined-call-restore', () => {
  // AlterGridFlag, 0067c4f0.
  it('writes the call where an argument expression is the inlined body', () => {
    const r = run([
      'void f(Grid *pDrlgGrid, int nX, int nY, int nFlag) {',
      '  Use((int *)(pDrlgGrid->pCellsFlags + pDrlgGrid->pCellsRowOffsets[nY] + nX), nFlag);',
      '}',
    ], [GET_CELL]);
    assert.deepStrictEqual(r.sites, ['DRLGGRID_GetCellAddress:expression']);
    assert.ok(r.out.includes('Use((int*)D2Common::Drlg::DrlgGrid::DRLGGRID_GetCellAddress(pDrlgGrid, nY, nX), nFlag);'), r.out);
  });

  it('binds an argument read through a member whose type the declarations give', () => {
    const r = run([
      'struct V { int nPosX; int nPosY; };',
      'void f(Grid *pDrlgGrid, V *pEdge) {',
      '  Use(pDrlgGrid->pCellsFlags + pDrlgGrid->pCellsRowOffsets[pEdge->nPosY] + pEdge->nPosX);',
      '}',
    ], [GET_CELL], { structFields: { ...TABLES.structFields, V: { nPosX: 'int', nPosY: 'int' } } });
    assert.deepStrictEqual(r.sites, ['DRLGGRID_GetCellAddress:expression']);
  });

  it('reads B[I] as *(B + I)', () => {
    const r = run([
      'int f(Grid *pDrlgGrid, int nX, int nY) {',
      '  return (pDrlgGrid->pCellsFlags + pDrlgGrid->pCellsRowOffsets[nY])[nX];',
      '}',
    ], [GET_CELL]);
    assert.deepStrictEqual(r.sites, ['DRLGGRID_GetCellAddress:subscript']);
    assert.ok(r.out.includes('return *D2Common::Drlg::DrlgGrid::DRLGGRID_GetCellAddress(pDrlgGrid, nY, nX);'), r.out);
  });

  it('follows the grouping the decompiler printed', () => {
    // ((flags + rows[y]) + w) - 1: the call is the inner sum, not flags + rows[y] + (w - 1).
    const r = run([
      'void f(Grid *pDrlgGrid, int nIndex) {',
      '  Use(pDrlgGrid->pCellsFlags + pDrlgGrid->pCellsRowOffsets[nIndex] + pDrlgGrid->nWidth - 1);',
      '  Use(pDrlgGrid->pCellsFlags + (pDrlgGrid->pCellsRowOffsets[nIndex] + nIndex));',
      '}',
    ], [GET_CELL]);
    assert.deepStrictEqual(r.sites, ['DRLGGRID_GetCellAddress:expression']);
    assert.ok(r.out.includes('Use(D2Common::Drlg::DrlgGrid::DRLGGRID_GetCellAddress(pDrlgGrid, nIndex, pDrlgGrid->nWidth) - 1);'), r.out);
  });

  it('refuses an argument of another type', () => {
    // GetOffset, 0067c550: nOffsetx is unsigned; passed as the int parameter it would convert.
    const r = run([
      'int f(Grid *pGrid1, unsigned int nOffsetx, int nOffset) {',
      '  return (int)(pGrid1->pCellsFlags + pGrid1->pCellsRowOffsets[nOffset] + nOffsetx);',
      '}',
    ], [GET_CELL]);
    assert.deepStrictEqual(r.sites, []);
  });

  it('refuses an argument that calls or writes', () => {
    const r = run([
      'void f(Grid *pDrlgGrid, int nX, int nY) {',
      '  Use(pDrlgGrid->pCellsFlags + pDrlgGrid->pCellsRowOffsets[nY++] + nX);',
      '  Use(pDrlgGrid->pCellsFlags + pDrlgGrid->pCellsRowOffsets[Peek()] + nX);',
      '}',
    ], [GET_CELL], { globalTypes: {} });
    assert.deepStrictEqual(r.sites, []);
  });

  it('needs the same argument everywhere a parameter appears', () => {
    const twice: InlinedCallee = { callName: 'Twice', returnType: 'int', params: 'Grid * p, int n', body: 'return p->nWidth * n + n;' };
    const ok = run(['int f(Grid *g, int a) { return g->nWidth * a + a; }'], [twice]);
    assert.deepStrictEqual(ok.sites, ['Twice:expression']);
    const bad = run(['int f(Grid *g, int a, int b) { return g->nWidth * a + b; }'], [twice]);
    assert.deepStrictEqual(bad.sites, []);
  });

  // CanPlayAnimMode, 006214a0.
  it('turns the two-armed assignment back into the call', () => {
    const r = run([
      'int f(int nClassId, int nAnimMode) {',
      '  int *pAnimModeEntry;',
      '  if (nClassId < 0x19a) {',
      '    pAnimModeEntry = gaAnimTableClassic + nAnimMode * 5;',
      '  }',
      '  else {',
      '    pAnimModeEntry = gaAnimTableExpansion + nAnimMode * 5;',
      '  }',
      '  return pAnimModeEntry[3];',
      '}',
    ], [ANIM_ENTRY]);
    assert.deepStrictEqual(r.sites, ['GetAnimTableEntry:select']);
    assert.ok(r.out.includes('pAnimModeEntry = (int*)GetAnimTableEntry(nClassId, nAnimMode);'), r.out);
    assert.ok(!r.out.includes('gaAnimTableExpansion'), r.out);
  });

  it('wants one target in both arms', () => {
    const r = run([
      'int f(int nClassId, int nAnimMode) {',
      '  int *a; int *b;',
      '  if (nClassId < 0x19a) { a = gaAnimTableClassic + nAnimMode * 5; }',
      '  else { b = gaAnimTableExpansion + nAnimMode * 5; }',
      '  return a[3] + b[3];',
      '}',
    ], [ANIM_ENTRY]);
    assert.deepStrictEqual(r.sites, []);
  });

  it('does not rewrite a written position', () => {
    const member: InlinedCallee = { callName: 'Sum', returnType: 'int', params: 'Grid * p, int n', body: 'return p->nWidth + n;' };
    const r = run(['void f(Grid *g, int a) { int *q = &g->nWidth; g->nWidth = g->nWidth + a; }'], [member]);
    assert.deepStrictEqual(r.sites, ['Sum:expression']);
    assert.ok(r.out.includes('g->nWidth = Sum(g, a);'), r.out);
  });

  it('declines bodies with no form or no anchor', () => {
    // TOKTBLS_GetTokenIndex, 0065c300: nothing but its parameters and a small constant,
    // taken only where the caller vouches for the site; one operator never.
    assert.strictEqual(compileInlinedCallee({ callName: 'T', returnType: 'int', params: 'int a, int b', body: 'return a * 0x10 + b;' })?.anchored, false);
    assert.strictEqual(compileInlinedCallee({ callName: 'T1', returnType: 'int', params: 'int a, int b', body: 'return a + b;' }), null);
    // A bare member is an lvalue an assignment could write through.
    assert.strictEqual(compileInlinedCallee({ callName: 'M', returnType: 'int', params: 'Grid * p', body: 'return p->nWidth;' }), null);
    // A parameter the body never reads cannot be bound.
    assert.strictEqual(compileInlinedCallee({ callName: 'U', returnType: 'int', params: 'Grid * p, int n', body: 'return p->nWidth + 1;' }), null);
    // Statements a run cannot hold.
    assert.strictEqual(compileInlinedCallee({ callName: 'S', returnType: 'int', params: 'Grid * p', body: 'while (p->nWidth) p->nWidth--; return p->nWidth;' }), null);
    assert.ok(compileInlinedCallee(GET_CELL));
    assert.ok(compileInlinedCallee(ANIM_ENTRY)?.select?.castArms);
  });

  it('computes the same values with the call as with the inlined body', { skip: !hasNativeGpp() }, () => {
    const body = [
      'int f(Grid *pDrlgGrid, int nX, int nY, int nClassId) {',
      '  int *pAnimModeEntry;',
      '  if (nClassId < 0x19a) {',
      '    pAnimModeEntry = gaAnimTableClassic + nX * 5;',
      '  }',
      '  else {',
      '    pAnimModeEntry = gaAnimTableExpansion + nX * 5;',
      '  }',
      '  return *(pDrlgGrid->pCellsFlags + pDrlgGrid->pCellsRowOffsets[nY] + nX) + pAnimModeEntry[1]',
      '    + (pDrlgGrid->pCellsFlags + pDrlgGrid->pCellsRowOffsets[nY])[nX];',
      '}',
    ];
    const r = run(body, [{ ...GET_CELL, callName: 'DRLGGRID_GetCellAddress' }, ANIM_ENTRY]);
    assert.deepStrictEqual(r.sites.sort(), ['DRLGGRID_GetCellAddress:expression', 'DRLGGRID_GetCellAddress:subscript', 'GetAnimTableEntry:select']);
    const prelude = (fn: string) => [
      '#include <cstdio>',
      GRID,
      'int gaAnimTableClassic[80]; int gaAnimTableExpansion[80];',
      `static inline int * DRLGGRID_GetCellAddress(${GET_CELL.params}) {${GET_CELL.body}}`,
      `static inline unsigned char * GetAnimTableEntry(${ANIM_ENTRY.params}) {${ANIM_ENTRY.body}}`,
      fn,
    ].join('\n');
    const main = [
      'int cells[64]; int rows[8];',
      'for (int i = 0; i < 64; i++) cells[i] = i * 7 - 3;',
      'for (int i = 0; i < 8; i++) rows[i] = i * 8;',
      'for (int i = 0; i < 80; i++) { gaAnimTableClassic[i] = i; gaAnimTableExpansion[i] = 1000 - i; }',
      'Grid g = { cells, rows, 8 };',
      'for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) printf("%d %d ", f(&g, x, y, 0x100 + y * 20), f(&g, x, y, 0x199));',
    ].join('\n');
    const before = compileAndRun(prelude(body.join('\n')), main);
    const after = compileAndRun(prelude(r.out), main);
    assert.ok(before.length > 0);
    assert.strictEqual(after, before);
  });

  // PLAYERMSG_GetMessageType, 00548eb0, inlined in SCMD_0x0B_Keepalive, 00549fa0.
  const MSG_TYPE: InlinedCallee = {
    callName: 'PLAYERMSG_GetMessageType', returnType: 'uint8_t', params: 'int32_t nParam1, int32_t nParam2',
    body: 'return -(nParam2 != nParam1) & 3;',
  };
  const KEEPALIVE = [
    'typedef int eStatus;',
    'int f(unsigned int nSize) {',
    '  return -(nSize != 1) & SERVERSTATUS_BAD_PARAMS;',
    '}',
  ];
  const ENUMS = { enumValues: { SERVERSTATUS_BAD_PARAMS: 3, BIG: 0x80 } };

  it('matches an enum constant to the integer it names', () => {
    const r = run(KEEPALIVE, [MSG_TYPE], { ...ENUMS, unanchored: true });
    assert.deepStrictEqual(r.sites, ['PLAYERMSG_GetMessageType:expression']);
    // nSize is unsigned, the parameter int: an `!=` against a 32-bit value cannot tell.
    assert.ok(r.out.includes('return PLAYERMSG_GetMessageType(1, nSize);'), r.out);
  });

  it('takes a body of parameters alone only where the caller vouches for the site', () => {
    assert.deepStrictEqual(run(KEEPALIVE, [MSG_TYPE], ENUMS).sites, []);
  });

  it('matches an enum constant only while it means the same in any enum width', () => {
    const r = run(['int f(int n) { return -(n != 1) & BIG; }'],
      [{ ...MSG_TYPE, body: 'return -(nParam2 != nParam1) & 0x80;' }], { ...ENUMS, unanchored: true });
    assert.deepStrictEqual(r.sites, []);
  });

  it('refuses an argument of the other sign where the parameter is read as a number', () => {
    const r = run(['int f(unsigned int n) { return -(n < 1) & 3; }'],
      [{ ...MSG_TYPE, body: 'return -(nParam2 < nParam1) & 3;' }], { unanchored: true });
    assert.deepStrictEqual(r.sites, []);
  });

  // DRLGROOMTILE_AllocTileLink, 0066e5e0, in DRLGROOMTILE_AddTileData, 0066e620.
  const LINK_DECLS = [
    'struct Link { int nKind; int *pTileData; Link *pNext; };',
    'struct Tiles { Link *pMapLinks; };',
    'struct Room { Tiles *pRoomTiles; };',
  ];
  const ALLOC_LINK: InlinedCallee = {
    callName: 'AllocTileLink', returnType: 'Link *', params: 'Room * pRoomEx, int nTileId',
    body: [
      '  Link *pTileLink;',
      '  pTileLink = (Link *)NewLink(0xc);',
      '  *(int *)pTileLink = nTileId;',
      '  pTileLink->pTileData = (int *)0x0;',
      '  pTileLink->pNext = pRoomEx->pRoomTiles->pMapLinks;',
      '  pRoomEx->pRoomTiles->pMapLinks = pTileLink;',
      '  return pTileLink;',
    ].join('\n'),
  };
  const LINK_TABLES: Partial<InlinedCallRestoreOptions> = {
    structFields: { Link: { nKind: 'int', pTileData: 'int *', pNext: 'Link *' }, Tiles: { pMapLinks: 'Link *' }, Room: { pRoomTiles: 'Tiles *' } },
  };
  const ADD_TILE = [
    'int f(Room *pRoomEx, int nTileType) {',
    '  unsigned int nIsFloorLink;',
    '  Link *pTileLink;',
    '  nIsFloorLink = (unsigned int)(nTileType == 0);',
    '  for (pTileLink = pRoomEx->pRoomTiles->pMapLinks; pTileLink != (Link *)0x0; pTileLink = pTileLink->pNext) {',
    '    if (*(int *)pTileLink == (int)nIsFloorLink) goto found;',
    '  }',
    '  pTileLink = (Link *)NewLink(0xc);',
    '  *(unsigned int *)pTileLink = nIsFloorLink;',
    '  pTileLink->pTileData = (int *)0x0;',
    '  pTileLink->pNext = pRoomEx->pRoomTiles->pMapLinks;',
    '  pRoomEx->pRoomTiles->pMapLinks = pTileLink;',
    'found:',
    '  return pTileLink->nKind * 10 + (pTileLink->pNext != (Link *)0x0);',
    '}',
  ];

  it('writes the call where a run of statements is the body, its local the site\'s', () => {
    const r = run(ADD_TILE, [ALLOC_LINK], LINK_TABLES);
    assert.deepStrictEqual(r.sites, ['AllocTileLink:run']);
    assert.ok(r.out.includes('pTileLink = AllocTileLink(pRoomEx, nIsFloorLink); found:'), r.out);
    assert.ok(!r.out.includes('pRoomEx->pRoomTiles->pMapLinks = pTileLink;'), r.out);
  });

  it('refuses a run whose argument may change between the uses the copy reads', () => {
    const r = run([
      'void f(Room *pRoomEx, Room *pOther, int n) {',
      '  Link *pTileLink;',
      '  pTileLink = (Link *)NewLink(0xc);',
      '  *(int *)pTileLink = n;',
      '  pTileLink->pTileData = (int *)0x0;',
      '  pTileLink->pNext = pRoomEx->pRoomTiles->pMapLinks;',
      '  pRoomEx->pRoomTiles->pMapLinks = pTileLink;',
      '  pRoomEx = pOther;',
      '}',
    ], [ALLOC_LINK], LINK_TABLES);
    // A write after the run is the function's own business.
    assert.deepStrictEqual(r.sites, ['AllocTileLink:run']);
    const written = run([
      'void f(Room *pRoomEx, int n) {',
      '  Link *pTileLink;',
      '  int *p = &n;',
      '  pTileLink = (Link *)NewLink(0xc);',
      '  *(int *)pTileLink = n;',
      '  pTileLink->pTileData = (int *)0x0;',
      '  pTileLink->pNext = pRoomEx->pRoomTiles->pMapLinks;',
      '  pRoomEx->pRoomTiles->pMapLinks = pTileLink;',
      '}',
    ], [ALLOC_LINK], LINK_TABLES);
    // n's address is taken: a store through it could change n between its uses.
    assert.deepStrictEqual(written.sites, []);
  });

  it('refuses a run whose local the function reads elsewhere', () => {
    const halt: InlinedCallee = {
      callName: 'Check', returnType: 'int', params: 'Room * p',
      body: '  int nLine;\n  if (p->pRoomTiles == (Tiles *)0x0) { nLine = 0x27; Halt(nLine); }\n  return 1;',
    };
    const ok = run(['int f(Room *p) { int nLine; if (p->pRoomTiles == (Tiles *)0x0) { nLine = 0x27; Halt(nLine); } return 1; }'], [halt], LINK_TABLES);
    assert.deepStrictEqual(ok.sites, ['Check:run']);
    assert.ok(ok.out.includes('int f(Room* p) { return Check(p); }'), ok.out);
    const bad = run(['int f(Room *p) { int nLine; nLine = 5; Use(nLine); if (p->pRoomTiles == (Tiles *)0x0) { nLine = 0x27; Halt(nLine); } return 1; }'], [halt], LINK_TABLES);
    assert.deepStrictEqual(bad.sites, []);
  });

  // ARENA_TestFlag, 0053f470, folded into ARENA_IsFlag0x200Set, 0053fed0.
  const ARENA_DECLS = ['typedef int eFlags;', 'struct Ctrl { int nPad[2]; eFlags eArenaFlags; };', 'struct Game { Ctrl *pArenaCtrl; };'];
  const TEST_FLAG: InlinedCallee = {
    callName: 'ARENA_TestFlag', returnType: 'bool', params: 'Game * pGame, uint32_t nParam',
    body: [
      '  void *nAddress;',
      '  int32_t nLine;',
      '  if (pGame->pArenaCtrl == (Ctrl *)0x0) {',
      '    nLine = 0x27;',
      '    nAddress = GetInstructionPointer();',
      '    Halt("",nAddress,nLine);',
      '    exit(-1);',
      '  }',
      '  return (pGame->pArenaCtrl->eArenaFlags & nParam) != 0;',
    ].join('\n'),
  };
  const ARENA_TABLES: Partial<InlinedCallRestoreOptions> = {
    structFields: { Ctrl: { nPad: 'int [2]', eArenaFlags: 'eFlags' }, Game: { pArenaCtrl: 'Ctrl *' } },
    typedefTargets: { eFlags: 'int', uint32_t: 'unsigned int', int32_t: 'int' },
  };
  const flagSite = (ret: string, value: string) => [
    `${ret} f(Game *pGame) {`,
    '  void *nAddress;',
    '  int32_t nLine;',
    '  if (pGame->pArenaCtrl == (Ctrl *)0x0) {',
    '    nLine = 0x27;',
    '    nAddress = GetInstructionPointer();',
    '    Halt("",nAddress,nLine);',
    '    exit(-1);',
    '  }',
    `  return ${value};`,
    '}',
  ];

  it('restores a call whose constant argument VC8 folded into the body', () => {
    const r = run(flagSite('uint32_t', 'pGame->pArenaCtrl->eArenaFlags >> 9 & 1'), [TEST_FLAG], ARENA_TABLES);
    assert.deepStrictEqual(r.sites, ['ARENA_TestFlag:fold']);
    assert.ok(r.out.includes('uint32_t f(Game* pGame) { return ARENA_TestFlag(pGame, 0x200); }'), r.out);
  });

  it('folds only what VC8 makes of the call', () => {
    // Another value: bit 9 of the complement.
    assert.deepStrictEqual(run(flagSite('uint32_t', '~pGame->pArenaCtrl->eArenaFlags >> 9 & 1'), [TEST_FLAG], ARENA_TABLES).sites, []);
    // The same value, but read through a byte: not the call (ARENA_GetClientUpdateFlag, 0053fca0).
    assert.deepStrictEqual(run(flagSite('uint32_t', '(uint8_t)(char)pGame->pArenaCtrl->eArenaFlags >> 2 & 1'), [TEST_FLAG], ARENA_TABLES).sites, []);
    // A shift of 16 or more VC8 makes a read of the upper half (ARENA_IsNoCubeRecipes, 0053fd10).
    assert.deepStrictEqual(run(flagSite('uint32_t', 'pGame->pArenaCtrl->eArenaFlags >> 0x10 & 1'), [TEST_FLAG], ARENA_TABLES).sites, []);
    // Two bits are not one constant.
    assert.deepStrictEqual(run(flagSite('uint32_t', 'pGame->pArenaCtrl->eArenaFlags >> 9 & 3'), [TEST_FLAG], ARENA_TABLES).sites, []);
  });

  it('computes the same values with the restored calls', { skip: !hasNativeGpp() }, () => {
    const add = run(ADD_TILE, [ALLOC_LINK], LINK_TABLES);
    const keep = run(KEEPALIVE.map(l => l.replace('int f(', 'int g(')), [MSG_TYPE], { ...ENUMS, unanchored: true });
    const flag = run(flagSite('uint32_t', 'pGame->pArenaCtrl->eArenaFlags >> 9 & 1').map(l => l.replace(' f(', ' h(')), [TEST_FLAG], ARENA_TABLES);
    for (const r of [add, keep, flag]) assert.strictEqual(r.sites.length, 1);
    const prelude = (fns: string[]) => [
      '#include <cstdio>', '#include <cstdlib>', '#include <cstdint>',
      ...LINK_DECLS, ...ARENA_DECLS,
      'Link pool[16]; int used;',
      'void *NewLink(int) { Link *l = &pool[used++]; l->nKind = 77; l->pTileData = (int *)l; l->pNext = l; return l; }',
      'constexpr int SERVERSTATUS_BAD_PARAMS = 3;',
      'void *GetInstructionPointer() { return 0; }',
      'void Halt(const char *, void *, int) { puts("halt"); }',
      `static inline Link * AllocTileLink(${ALLOC_LINK.params}) {${ALLOC_LINK.body}}`,
      `static inline uint8_t PLAYERMSG_GetMessageType(${MSG_TYPE.params}) {${MSG_TYPE.body}}`,
      `static inline bool ARENA_TestFlag(${TEST_FLAG.params}) {${TEST_FLAG.body}}`,
      ...fns,
    ].join('\n');
    const original = [
      ADD_TILE.join('\n'),
      KEEPALIVE.slice(1).join('\n').replace('int f(', 'int g('),
      flagSite('uint32_t', 'pGame->pArenaCtrl->eArenaFlags >> 9 & 1').join('\n').replace(' f(', ' h('),
    ];
    const restored = [add.out, keep.out.replace('typedef int eStatus;', ''), flag.out];
    const main = [
      'Tiles t = { 0 }; Room room = { &t };',
      'for (int i = 0; i < 4; i++) printf("%d ", f(&room, i & 1));',
      'printf("%d %d %d ", g(0), g(1), g(0xffffffffu));',
      'Ctrl c = { {0, 0}, 0 }; Game game = { &c };',
      'for (int b = 0; b < 32; b++) { c.eArenaFlags = (int)(1u << b) ^ 0x5a5a; printf("%u ", h(&game)); }',
    ].join('\n');
    const before = compileAndRun(prelude(original), main);
    const after = compileAndRun(prelude(restored), main);
    assert.ok(before.length > 0);
    assert.strictEqual(after, before);
  });
});

