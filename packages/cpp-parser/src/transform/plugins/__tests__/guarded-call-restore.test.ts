import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import type { AnyNode, FunctionDecl } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import {
  guardedCallRestorePlugin, compileGuardedCallee,
  type GuardedCallee, type GuardedCallRestoreOptions,
} from '../builtins/guarded-call-restore.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const HALT = (line: string) => `{ ERROR_UnrecoverableInternalError_Halt("", GetInstructionPointer(), ${line}); exit(-1); }`;

function callee(callName: string, text: string): GuardedCallee {
  const fn = parse(text).declarations.find(d => d.kind === NodeKind.FunctionDecl) as FunctionDecl;
  return { callName, fn };
}

// ARENA_GetArenaTxtRecord, 0053f600: pGame in EAX, unreferenced.
const GET_RECORD = callee('ARENA_GetArenaTxtRecord', [
  'int dummy(SGAMEDATA * pGame) {',
  `  if (!pGame->pArenaCtrl) ${HALT('0x6c')}`,
  '  return pGame->pArenaCtrl->nArenaTxtRecord;',
  '  return pGame->pArenaCtrl->nArenaTxtRecord;',
  '}',
].join('\n'));

// UNITSND_GetUnitSfxFlag, 004caa70: a byte widened to the int it returns.
const GET_FLAG = callee('UNITSND_GetUnitSfxFlag', [
  'int dummy(D2UnitStrc * pUnit) {',
  `  if (!pUnit) ${HALT('0xc8f')}`,
  '  return (uint32_t)pUnit->uSideData.pClientSide.bUnitSfx;',
  '}',
].join('\n'));

// UNITSND_GetSfxDataListHead, 004ca870: the field's address as offset arithmetic.
const LIST_HEAD = callee('UNITSND_GetSfxDataListHead', [
  'void * * dummy(D2UnitStrc * pUnit) {',
  `  if (!pUnit) ${HALT('0xc2c')}`,
  '  return (void**)((uintptr_t)&pUnit->uSideData + 0x14);',
  '}',
].join('\n'));

const TABLES: Partial<GuardedCallRestoreOptions> = {
  structFields: {
    SGAMEDATA: { pArenaCtrl: 'D2ArenaControlStrc *' },
    D2ArenaControlStrc: { nArenaTxtRecord: 'int' },
    D2UnitStrc: { uSideData: 'D2UnitSideData' },
    D2UnitSideData: { pClientSide: 'D2ClientSide' },
    D2ClientSide: { bUnitSfx: 'uint8_t', pUnitSfxData: 'int32_t *', nSfxMode: 'int' },
  },
  fieldOffsets: {
    D2UnitStrc: { uSideData: 0x64 },
    D2UnitSideData: { pClientSide: 0 },
    D2ClientSide: { nSfxMode: 0x10, pUnitSfxData: 0x14, bUnitSfx: 0xc },
  },
  typedefTargets: { uint32_t: 'unsigned int', int32_t: 'int', uint8_t: 'unsigned char' },
};

function run(lines: string[], callees: GuardedCallee[], opts: Partial<GuardedCallRestoreOptions> = {}): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = guardedCallRestorePlugin.createTransformer({
    callees, onSite: e => sites.push(`${e.callee}:${e.form}`), ...TABLES, ...opts,
  } as GuardedCallRestoreOptions);
  return { out: flat(emit(t(parse(lines.join('\n'))) as AnyNode)), sites };
}

const KILL = (use: string, line = '0x6c', between = '') => [
  'void f(SGAMEDATA * pGame, int nScore) {',
  '  D2ArenaTxt * pArenaTxt;',
  `  if (!pGame->pArenaCtrl) ${HALT(line)}`,
  between,
  use,
  '  nScore += pArenaTxt->dwSuicide;',
  '}',
];

describe('guarded-call-restore', () => {
  it('compiles a guarded getter into its guards and value', () => {
    const p = compileGuardedCallee(GET_RECORD);
    assert.ok(p);
    assert.deepStrictEqual(p!.lines, [0x6c]);
  });

  it('refuses a callee whose body is not guards and a return', () => {
    assert.strictEqual(compileGuardedCallee(callee('F', 'int dummy(int *p) { if (!p) return 0; return *p; }')), null);
    assert.strictEqual(compileGuardedCallee(callee('F', `int dummy(int *p) { if (!p) ${HALT('1')} Touch(p); return *p; }`)), null);
    assert.strictEqual(compileGuardedCallee(callee('F', `int dummy(int *p) { if (!p) ${HALT('1')} return Read(p); }`)), null);
  });

  it('writes the call where the guards precede an argument of the first call (SERVER_ARENA_KillHandler)', () => {
    const r = run(KILL('  pArenaTxt = GetArenaTxtRecord(pGame->pArenaCtrl->nArenaTxtRecord);'), [GET_RECORD]);
    assert.deepStrictEqual(r.sites, ['ARENA_GetArenaTxtRecord:value']);
    assert.ok(r.out.includes('pArenaTxt = GetArenaTxtRecord(ARENA_GetArenaTxtRecord(pGame));'), r.out);
    assert.ok(!r.out.includes('Halt'), r.out);
  });

  it('takes a declaration initialiser and a return', () => {
    const decl = run(KILL('  int n = pGame->pArenaCtrl->nArenaTxtRecord;'), [GET_RECORD]);
    assert.ok(decl.out.includes('int n = ARENA_GetArenaTxtRecord(pGame);'), decl.out);
    const ret = run(['int f(SGAMEDATA * pGame) {', `  if (!pGame->pArenaCtrl) ${HALT('0x6c')}`, '  return pGame->pArenaCtrl->nArenaTxtRecord + 1;', '}'], [GET_RECORD]);
    assert.ok(ret.out.includes('return ARENA_GetArenaTxtRecord(pGame) + 1;'), ret.out);
  });

  it('refuses another halt line', () => {
    assert.deepStrictEqual(run(KILL('  pArenaTxt = GetArenaTxtRecord(pGame->pArenaCtrl->nArenaTxtRecord);', '0x6d'), [GET_RECORD]).sites, []);
  });

  it('refuses a statement between the guards and the use', () => {
    assert.deepStrictEqual(run(KILL('  pArenaTxt = GetArenaTxtRecord(pGame->pArenaCtrl->nArenaTxtRecord);', '0x6c', '  nScore = 1;'), [GET_RECORD]).sites, []);
  });

  it('refuses a use that something else is evaluated before', () => {
    // The other argument calls, so it may run before the value is read.
    assert.deepStrictEqual(run(KILL('  pArenaTxt = Pick(Next(), pGame->pArenaCtrl->nArenaTxtRecord);'), [GET_RECORD]).sites, []);
    // The read is not the first thing the statement evaluates.
    assert.deepStrictEqual(run(KILL('  pArenaTxt = Lookup(pGame->pArena->nId + pGame->pArenaCtrl->nArenaTxtRecord);'), [GET_RECORD]).sites, []);
    // Stored through a pointer, not into a local.
    assert.deepStrictEqual(run(KILL('  pGame->nLast = pGame->pArenaCtrl->nArenaTxtRecord;'), [GET_RECORD]).sites, []);
  });

  it('refuses a loop condition and a labelled statement', () => {
    assert.deepStrictEqual(run(KILL('  while (pGame->pArenaCtrl->nArenaTxtRecord) { nScore++; }'), [GET_RECORD]).sites, []);
    assert.deepStrictEqual(run(KILL('  LAB_1: pArenaTxt = GetArenaTxtRecord(pGame->pArenaCtrl->nArenaTxtRecord);'), [GET_RECORD]).sites, []);
  });

  it('refuses an argument of another type', () => {
    const lines = ['void f(OTHERDATA * pGame) {', `  if (!pGame->pArenaCtrl) ${HALT('0x6c')}`, '  Use(pGame->pArenaCtrl->nArenaTxtRecord);', '}'];
    assert.deepStrictEqual(run(lines, [GET_RECORD]).sites, []);
  });

  const MODE = (cond: string) => [
    'void f(D2UnitStrc * pUnit, int nUnitMode) {',
    `  if (!pUnit) ${HALT('0xc8f')}`,
    `  if (${cond}) { return; }`,
    '  Play(pUnit);',
    '}',
  ];

  it('drops the widening cast where only the truth is read (UpdateUnitSfxOnModeChange)', () => {
    const r = run(MODE('pUnit->uSideData.pClientSide.bUnitSfx && nUnitMode == pUnit->uSideData.pClientSide.nSfxMode'), [GET_FLAG]);
    assert.deepStrictEqual(r.sites, ['UNITSND_GetUnitSfxFlag:truth']);
    assert.ok(r.out.includes('if (UNITSND_GetUnitSfxFlag(pUnit) && nUnitMode == pUnit->uSideData.pClientSide.nSfxMode)'), r.out);
  });

  it('keeps the cast where the value is read', () => {
    const r = run(MODE('pUnit->uSideData.pClientSide.bUnitSfx == nUnitMode'), [GET_FLAG]);
    assert.deepStrictEqual(r.sites, []);
  });

  const SFX = (use: string) => [
    'void f(D2UnitStrc * pUnit, int32_t nParam) {',
    `  if (!pUnit) ${HALT('0xc2c')}`,
    use,
    '}',
  ];

  it('casts the pointer back where the site spells another pointer cast (AllocUnitSfxData)', () => {
    const r = run(SFX('  Alloc((void*)((uintptr_t)&pUnit->uSideData + 0x14), (void*)nParam);'), [LIST_HEAD]);
    assert.deepStrictEqual(r.sites, ['UNITSND_GetSfxDataListHead:pointer-cast']);
    assert.ok(r.out.includes('Alloc((void*)UNITSND_GetSfxDataListHead(pUnit), (void*)nParam);'), r.out);
  });

  it('takes the field at the offset the arithmetic names (FreeSfxData, IterateUnitSfxData)', () => {
    const addr = run(SFX('  Free((int**)&pUnit->uSideData.pClientSide.pUnitSfxData, nParam);'), [LIST_HEAD]);
    assert.deepStrictEqual(addr.sites, ['UNITSND_GetSfxDataListHead:field-address']);
    assert.ok(addr.out.includes('Free((int**)UNITSND_GetSfxDataListHead(pUnit), nParam);'), addr.out);
    const read = run(SFX('  int32_t* pSfxNode = (int32_t*)pUnit->uSideData.pClientSide.pUnitSfxData;'), [LIST_HEAD]);
    assert.deepStrictEqual(read.sites, ['UNITSND_GetSfxDataListHead:field-read']);
    assert.ok(read.out.includes('int32_t* pSfxNode = (int32_t*)*UNITSND_GetSfxDataListHead(pUnit);'), read.out);
  });

  it('takes the field uncast where its own type is the return type\'s', () => {
    const voidList = { structFields: { ...TABLES.structFields, D2ClientSide: { pUnitSfxData: 'void *', nSfxMode: 'int' } } };
    const addr = run(SFX('  Free(&pUnit->uSideData.pClientSide.pUnitSfxData, nParam);'), [LIST_HEAD], voidList);
    assert.deepStrictEqual(addr.sites, ['UNITSND_GetSfxDataListHead:field-address']);
    assert.ok(addr.out.includes('Free(UNITSND_GetSfxDataListHead(pUnit), nParam);'), addr.out);
    const read = run(SFX('  void* pSfxNode = pUnit->uSideData.pClientSide.pUnitSfxData;'), [LIST_HEAD], voidList);
    assert.deepStrictEqual(read.sites, ['UNITSND_GetSfxDataListHead:field-read']);
    assert.ok(read.out.includes('void* pSfxNode = *UNITSND_GetSfxDataListHead(pUnit);'), read.out);
    // An `int32_t *` field: its address is an `int32_t **`, which the call does not return.
    assert.deepStrictEqual(run(SFX('  Free(&pUnit->uSideData.pClientSide.pUnitSfxData, nParam);'), [LIST_HEAD]).sites, []);
    assert.deepStrictEqual(run(SFX('  int32_t* pSfxNode = pUnit->uSideData.pClientSide.pUnitSfxData;'), [LIST_HEAD]).sites, []);
  });

  it('refuses a field at another offset, or with no known offset', () => {
    assert.deepStrictEqual(run(SFX('  Free((int**)&pUnit->uSideData.pClientSide.nSfxMode, nParam);'), [LIST_HEAD]).sites, []);
    const unknown = { ...TABLES.fieldOffsets, D2ClientSide: { nSfxMode: 0x10 } };
    assert.deepStrictEqual(run(SFX('  Free((int**)&pUnit->uSideData.pClientSide.pUnitSfxData, nParam);'), [LIST_HEAD], { fieldOffsets: unknown }).sites, []);
  });

  it('refuses a read of a field that is not a pointer', () => {
    const offsets = { ...TABLES.fieldOffsets, D2ClientSide: { nSfxMode: 0x14 } };
    assert.deepStrictEqual(run(SFX('  int32_t* p = (int32_t*)pUnit->uSideData.pClientSide.nSfxMode;'), [LIST_HEAD], { fieldOffsets: offsets }).sites, []);
  });

  it('hands the function to capture as it stands', () => {
    let seen: FunctionDecl | undefined;
    const t = guardedCallRestorePlugin.createTransformer({ capture: (fn: FunctionDecl) => { seen = fn; } } as GuardedCallRestoreOptions);
    t(parse('int f(int a) { return a; }'));
    assert.ok(seen && seen.kind === NodeKind.FunctionDecl);
  });

  it('computes the same values and halts the same way with the restored calls', { skip: !hasNativeGpp() }, () => {
    const site = run([
      'int f(SGAMEDATA * pGame, int nScore) {',
      `  if (!pGame->pArenaCtrl) ${HALT('0x6c')}`,
      '  int n = Lookup(pGame->pArenaCtrl->nArenaTxtRecord, nScore);',
      '  return n;',
      '}',
    ], [GET_RECORD]);
    assert.strictEqual(site.sites.length, 1);
    const prelude = (body: string) => [
      '#include <cstdlib>',
      'struct D2ArenaControlStrc { int nPad; int nArenaTxtRecord; };',
      'struct SGAMEDATA { int nPad; D2ArenaControlStrc *pArenaCtrl; };',
      'static void *GetInstructionPointer() { return 0; }',
      'static void ERROR_UnrecoverableInternalError_Halt(const char *, void *, int nLine) { printf("halt %d\\n", nLine); fflush(stdout); std::exit(0); }',
      'static int Lookup(int a, int b) { return a * 7 + b; }',
      'static inline int ARENA_GetArenaTxtRecord(SGAMEDATA *pGame) {',
      `  if (!pGame->pArenaCtrl) ${HALT('0x6c')}`,
      '  return pGame->pArenaCtrl->nArenaTxtRecord;',
      '}',
      body,
    ].join('\n');
    const main = [
      'D2ArenaControlStrc c = { 0, 5 }; SGAMEDATA g = { 0, &c };',
      'printf("%d\\n", f(&g, 3));',
      'SGAMEDATA none = { 0, 0 };',
      'f(&none, 3);',
    ].join('\n');
    const original = [
      'int f(SGAMEDATA * pGame, int nScore) {',
      `  if (!pGame->pArenaCtrl) ${HALT('0x6c')}`,
      '  int n = Lookup(pGame->pArenaCtrl->nArenaTxtRecord, nScore);',
      '  return n;',
      '}',
    ].join('\n');
    const before = compileAndRun(prelude(original), main);
    const after = compileAndRun(prelude(site.out), main);
    assert.ok(before.includes('halt 108'), before);
    assert.strictEqual(after, before);
  });
});
