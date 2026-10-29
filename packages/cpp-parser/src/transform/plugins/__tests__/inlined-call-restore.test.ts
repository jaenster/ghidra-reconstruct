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
    // TOKTBLS_GetTokenIndex, 0065c300: nothing but its parameters and a small constant.
    assert.strictEqual(compileInlinedCallee({ callName: 'T', returnType: 'int', params: 'int a, int b', body: 'return a * 0x10 + b;' }), null);
    // A bare member is an lvalue an assignment could write through.
    assert.strictEqual(compileInlinedCallee({ callName: 'M', returnType: 'int', params: 'Grid * p', body: 'return p->nWidth;' }), null);
    // A parameter the body never reads cannot be bound.
    assert.strictEqual(compileInlinedCallee({ callName: 'U', returnType: 'int', params: 'Grid * p, int n', body: 'return p->nWidth + 1;' }), null);
    // Statements beyond the two forms.
    assert.strictEqual(compileInlinedCallee({ callName: 'S', returnType: 'int', params: 'Grid * p', body: 'p->nWidth = 1; return p->nWidth;' }), null);
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
});
