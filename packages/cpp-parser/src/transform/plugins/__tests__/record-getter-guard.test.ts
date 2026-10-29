import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { recordGetterGuardPlugin, type RecordGetterGuardOptions } from '../builtins/record-getter-guard.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const PRELUDE = [
  'struct ItemTypesTxt { int nPad[4]; unsigned char throwable; unsigned char beltable; };',
  'struct DataTable { int nPad; ItemTypesTxt *pTxtItemTypes; int nTxtItemTypesSize; };',
].join('\n');

const TABLES: Partial<RecordGetterGuardOptions> = {
  globalTypes: { sgptDataTable: 'DataTable *' },
  functionReturnTypes: { Peek: 'int', Halt: 'void', Use: 'int' },
  structFields: {
    DataTable: { nPad: 'int', pTxtItemTypes: 'ItemTypesTxt *', nTxtItemTypesSize: 'int' },
    ItemTypesTxt: { nPad: 'int [4]', throwable: 'unsigned char', beltable: 'unsigned char' },
  },
};

function run(lines: string[], opts: Partial<RecordGetterGuardOptions> = {}): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = recordGetterGuardPlugin.createTransformer({
    onSite: e => sites.push(`${e.name}:${e.reads}${e.negated ? '!' : ''}`), ...TABLES, ...opts,
  } as RecordGetterGuardOptions);
  return { out: flat(emit(t(parse(lines.join('\n'))) as AnyNode)), sites };
}

const GUARD = 'n >= 0 && n < sgptDataTable->nTxtItemTypesSize && sgptDataTable->pTxtItemTypes + n';

describe('record-getter-guard', () => {
  // ITEM_GetTxtItemTypes_throwable, 0062ba80.
  it('gives a guarded read its record pointer', () => {
    const r = run([
      'int f(int n) {',
      `  if (${GUARD}) {`,
      '    return sgptDataTable->pTxtItemTypes[n].throwable;',
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1']);
    assert.ok(r.out.includes('ItemTypesTxt* pItemTypesTxt = n >= 0 && n < sgptDataTable->nTxtItemTypesSize ? sgptDataTable->pTxtItemTypes + n : nullptr;'), r.out);
    assert.ok(r.out.includes('if (pItemTypesTxt) { return pItemTypesTxt->throwable; }'), r.out);
  });

  it('routes the reads after a `!` guard that returns', () => {
    const r = run([
      'int f(int n) {',
      `  if (!(${GUARD})) {`,
      '    return 0;',
      '  }',
      '  int a = sgptDataTable->pTxtItemTypes[n].throwable;',
      '  return a + Use(sgptDataTable->pTxtItemTypes[n].beltable) + sgptDataTable->pTxtItemTypes[n].beltable;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1!']);
    assert.ok(r.out.includes('if (!pItemTypesTxt) { return 0; } int a = pItemTypesTxt->throwable;'), r.out);
    // The statement with the call is not a lone call: left as printed.
    assert.ok(r.out.includes('Use(sgptDataTable->pTxtItemTypes[n].beltable)'), r.out);
  });

  it('rewrites the arguments of a lone call and stops after it', () => {
    const r = run([
      'int f(int n) {',
      `  if (!(${GUARD})) {`,
      '    return 0;',
      '  }',
      '  Use(sgptDataTable->pTxtItemTypes[n].throwable);',
      '  return sgptDataTable->pTxtItemTypes[n].beltable;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1!']);
    assert.ok(r.out.includes('Use(pItemTypesTxt->throwable); return sgptDataTable->pTxtItemTypes[n].beltable;'), r.out);
  });

  it('leaves a guard with no read it may route', () => {
    const r = run([
      'int f(int n) {',
      `  if (!(${GUARD})) {`,
      '    return 0;',
      '  }',
      '  Use(1);',
      '  return sgptDataTable->pTxtItemTypes[n].beltable;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, []);
  });

  it('leaves a `!` guard that falls through', () => {
    const r = run([
      'int f(int n) {',
      '  int a = 0;',
      `  if (!(${GUARD})) {`,
      '    a = 1;',
      '  }',
      '  return a + sgptDataTable->pTxtItemTypes[n].beltable;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, []);
  });

  it('leaves a chain with a condition that is not about the index', () => {
    const r = run([
      'int f(int *p, int n) {',
      `  if (p && ${GUARD}) {`,
      '    return sgptDataTable->pTxtItemTypes[n].throwable;',
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, []);
  });

  it('stops at a write to the index', () => {
    const r = run([
      'int f(int n) {',
      `  if (${GUARD}) {`,
      '    int a = sgptDataTable->pTxtItemTypes[n].throwable;',
      '    n = n + 1;',
      '    return a + sgptDataTable->pTxtItemTypes[n].beltable;',
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1']);
    assert.ok(r.out.includes('return a + sgptDataTable->pTxtItemTypes[n].beltable;'), r.out);
  });

  // MONSTERS_GetBaseId-style: the index is replaced by a field of its own record.
  it('reads the record before a store to the index', () => {
    const r = run([
      'int f(int n) {',
      `  if (${GUARD}) {`,
      '    n = sgptDataTable->pTxtItemTypes[n].throwable;',
      '  }',
      '  return n;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1']);
    assert.ok(r.out.includes('if (pItemTypesTxt) { n = pItemTypesTxt->throwable; }'), r.out);
  });

  it('leaves an index whose address is taken', () => {
    const r = run([
      'int f(int n) {',
      '  Peek(&n);',
      `  if (${GUARD}) {`,
      '    return sgptDataTable->pTxtItemTypes[n].throwable;',
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, []);
  });

  it('computes what the guard and reads computed', { skip: !hasNativeGpp() }, () => {
    const body = [
      'int f(int n) {',
      `  if (!(${GUARD})) {`,
      '    return -1;',
      '  }',
      '  int a = sgptDataTable->pTxtItemTypes[n].throwable;',
      '  if (n > 1 && sgptDataTable->pTxtItemTypes[n].beltable) {',
      '    a = a + 100;',
      '  }',
      '  return a;',
      '}',
    ];
    const r = run(body);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:2!']);
    const prelude = (fn: string) => [PRELUDE, 'DataTable *sgptDataTable;', 'int Use(int v) { return v; }', fn].join('\n');
    const main = [
      'static ItemTypesTxt rows[3] = {{{0},1,0},{{0},2,1},{{0},3,1}};',
      'static DataTable t = {0, rows, 3};',
      'sgptDataTable = &t;',
      'for (int n = -1; n <= 3; n++) printf("%d ", f(n));',
    ].join('\n');
    const before = compileAndRun(prelude(body.join('\n')), main);
    const after = compileAndRun(prelude(r.out), main);
    assert.ok(before.length > 0);
    assert.strictEqual(after, before);
  });
});
