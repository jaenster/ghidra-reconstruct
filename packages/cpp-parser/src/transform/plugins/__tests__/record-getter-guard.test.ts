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
  // GetSkilParam1 004efc20 after Game.exe v1969: Ghidra prints the table global with
  // its module namespace, and the record pointer is the same one.
  it('takes a table global spelled with its namespace', () => {
    const Q = 'D2Common::Items::sgptDataTable';
    const r = run([
      'int f(int n) {',
      `  if (n >= 0 && n < ${Q}->nTxtItemTypesSize && ${Q}->pTxtItemTypes + n) {`,
      `    return ${Q}->pTxtItemTypes[n].throwable;`,
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1']);
    assert.ok(r.out.includes(`ItemTypesTxt* pItemTypesTxt = n >= 0 && n < ${Q}->nTxtItemTypesSize ? ${Q}->pTxtItemTypes + n : nullptr;`), r.out);
  });

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

  // Skills_CltDoFunc_Sor_SimpleMakeMissile 004e3a30: the record is only null-tested.
  it('takes a guard whose record nothing reads', () => {
    const r = run([
      'int f(int n) {',
      `  if (!(${GUARD})) {`,
      '    return 0;',
      '  }',
      '  return Use(n);',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:0!']);
    assert.ok(r.out.includes('ItemTypesTxt* pItemTypesTxt = n >= 0 && n < sgptDataTable->nTxtItemTypesSize ? sgptDataTable->pTxtItemTypes + n : nullptr; if (!pItemTypesTxt) { return 0; }'), r.out);
  });

  // Skills_CltDoFunc_Ass_AuraLevel_CastAttackTarget 004f2720: a condition before the
  // getter is tested on its own first.
  it('tests a condition before an unread getter on its own', () => {
    const r = run([
      'int f(int *p, int n) {',
      `  if (!(p && ${GUARD})) {`,
      '    return 0;',
      '  }',
      '  return Use(n);',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:0!']);
    assert.ok(r.out.includes('if (!p) { return 0; } ItemTypesTxt* pItemTypesTxt = n >= 0 && n < sgptDataTable->nTxtItemTypesSize ? sgptDataTable->pTxtItemTypes + n : nullptr; if (!pItemTypesTxt) { return 0; }'), r.out);
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

  it('sets the record inside a chain with a condition before it', () => {
    const r = run([
      'int f(int *p, int n) {',
      `  if (p && ${GUARD}) {`,
      '    return sgptDataTable->pTxtItemTypes[n].throwable;',
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1']);
    assert.ok(r.out.includes('ItemTypesTxt* pItemTypesTxt; if (p && (pItemTypesTxt = n >= 0 && n < sgptDataTable->nTxtItemTypesSize ? sgptDataTable->pTxtItemTypes + n : nullptr)) { return pItemTypesTxt->throwable; }'), r.out);
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

  // SKILLS_GetUnitWalkVelocity, 0056e5b0: the monster arm is an else-if whose index the
  // chain loads itself; the original tests the record after the add.
  it('sets the record in an else-if arm that loads its own index', () => {
    const r = run([
      'int f(U *u) {',
      '  int n;',
      '  if (u->a == 0) {',
      '    return 1;',
      `  } else if (u->a == 1 && (n = u->b , n >= 0) && n < sgptDataTable->nTxtItemTypesSize && sgptDataTable->pTxtItemTypes + n) {`,
      '    return (int)sgptDataTable->pTxtItemTypes[n].throwable << 8;',
      '  }',
      '  return 0x600;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1']);
    assert.ok(r.out.includes('int n; ItemTypesTxt* pItemTypesTxt; if (u->a == 0) { return 1; } else if (u->a == 1 && (n = u->b , pItemTypesTxt = n >= 0 && n < sgptDataTable->nTxtItemTypesSize ? sgptDataTable->pTxtItemTypes + n : nullptr)) { return (int)pItemTypesTxt->throwable << 8; }'), r.out);
  });

  // AI_Monster_TryCastRateLimitedSkill, 005e5b70: conditions after the getter read the
  // record, and so does the body.
  it('routes the reads of the conditions after the getter and of the body', () => {
    const r = run([
      'int f(U *u, int k) {',
      '  int n;',
      `  if (u && (n = u->b , n >= 0) && n < sgptDataTable->nTxtItemTypesSize && sgptDataTable->pTxtItemTypes + n && (k = sgptDataTable->pTxtItemTypes[n].beltable , k >= 0) && k < 9) {`,
      '    return sgptDataTable->pTxtItemTypes[n].throwable + k;',
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:2']);
    assert.ok(r.out.includes('(k = pItemTypesTxt->beltable , k >= 0) && k < 9) { return pItemTypesTxt->throwable + k; }'), r.out);
  });

  // SKILLS_SetSkillDataByEType, 0056c840: `&& true` ends the chain and the read is a switch.
  it('drops a trailing `&& true` and routes into a switch after the guard', () => {
    const r = run([
      'void f(int n, int *q) {',
      `  if (!(${GUARD} && true)) {`,
      '    return;',
      '  }',
      '  switch (sgptDataTable->pTxtItemTypes[n].beltable) {',
      '    case 1:',
      '      *q = 2;',
      '      return;',
      '    case 2:',
      '      *q = 3;',
      '  }',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1!']);
    assert.ok(r.out.includes('ItemTypesTxt* pItemTypesTxt = n >= 0 && n < sgptDataTable->nTxtItemTypesSize ? sgptDataTable->pTxtItemTypes + n : nullptr; if (!pItemTypesTxt) { return; } switch (pItemTypesTxt->beltable)'), r.out);
  });

  it('routes neither the body nor later conditions past a condition that calls', () => {
    const r = run([
      'int f(int n) {',
      `  if (${GUARD} && Use(1) && sgptDataTable->pTxtItemTypes[n].beltable) {`,
      '    return sgptDataTable->pTxtItemTypes[n].throwable;',
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, []);
  });

  it('routes the conditions before a call but not the body after it', () => {
    const r = run([
      'int f(int n) {',
      `  if (${GUARD} && sgptDataTable->pTxtItemTypes[n].beltable && Use(1)) {`,
      '    return sgptDataTable->pTxtItemTypes[n].throwable;',
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1']);
    assert.ok(r.out.includes('&& pItemTypesTxt->beltable && Use(1)) { return sgptDataTable->pTxtItemTypes[n].throwable; }'), r.out);
  });

  it('stops at a later condition that writes the index', () => {
    const r = run([
      'int f(int n) {',
      `  if (${GUARD} && (n = n + 1 , n > 2) && sgptDataTable->pTxtItemTypes[n].beltable) {`,
      '    return sgptDataTable->pTxtItemTypes[n].throwable;',
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, []);
  });

  it('leaves the else branch of a chain as printed', () => {
    const r = run([
      'int f(int *p, int n) {',
      `  if (p && ${GUARD}) {`,
      '    return sgptDataTable->pTxtItemTypes[n].throwable;',
      '  } else {',
      '    return sgptDataTable->pTxtItemTypes[n].beltable;',
      '  }',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1']);
    assert.ok(r.out.includes('} else { return sgptDataTable->pTxtItemTypes[n].beltable; }'), r.out);
  });

  it('leaves a `!` guard in an else-if arm', () => {
    const r = run([
      'int f(int *p, int n) {',
      '  if (p) {',
      '    return 1;',
      `  } else if (!(${GUARD})) {`,
      '    return 0;',
      '  }',
      '  return sgptDataTable->pTxtItemTypes[n].throwable;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, []);
  });

  // The state-list loop of SUNITMSG (SUnitMsg.cpp): the failure, then an else-if arm
  // that reads the record.
  it('routes the reads of the else branch of a failure-stated guard', () => {
    const r = run([
      'int f(int n) {',
      `  if (${FAIL}) {`,
      '    return -1;',
      '  } else if (sgptDataTable->pTxtItemTypes[n].beltable & 1) {',
      '    return 0;',
      '  } else {',
      '    return sgptDataTable->pTxtItemTypes[n].throwable;',
      '  }',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:2!']);
    assert.ok(r.out.includes('if (!pItemTypesTxt) { return -1; } else if (pItemTypesTxt->beltable & 1) { return 0; } else { return pItemTypesTxt->throwable; }'), r.out);
  });

  it('routes the else branch of a `!` guard in an else-if arm, not what follows', () => {
    const r = run([
      'int f(int *p, int n) {',
      '  if (p) {',
      '    return 1;',
      `  } else if (!(${GUARD})) {`,
      '    return 0;',
      '  } else {',
      '    Use(sgptDataTable->pTxtItemTypes[n].throwable);',
      '  }',
      '  return sgptDataTable->pTxtItemTypes[n].beltable;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1!']);
    assert.ok(r.out.includes('Use(pItemTypesTxt->throwable);'), r.out);
    assert.ok(r.out.includes('return sgptDataTable->pTxtItemTypes[n].beltable;'), r.out);
  });

  it('leaves the else branch of a `!` guard that holds a label', () => {
    const r = run([
      'int f(int n) {',
      '  if (n > 7) goto L;',
      `  if (!(${GUARD})) {`,
      '    return 0;',
      '  } else {',
      '  L:',
      '    return sgptDataTable->pTxtItemTypes[n].throwable;',
      '  }',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, []);
  });

  it('computes what a failure-stated guard with an else computed', { skip: !hasNativeGpp() }, () => {
    const body = [
      'int f(int *p, int n) {',
      `  if (!p || ${FAIL}) {`,
      '    return -1;',
      '  } else if (sgptDataTable->pTxtItemTypes[n].beltable == 0) {',
      '    return Use(n);',
      '  } else {',
      '    return sgptDataTable->pTxtItemTypes[n].throwable * 10 + n;',
      '  }',
      '}',
    ];
    const r = run(body);
    // The else-if's own branches call: only its condition routes.
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1!']);
    const prelude = (fn: string) => [PRELUDE, 'DataTable *sgptDataTable;', 'int Use(int v) { return v; }', fn].join('\n');
    const main = [
      'static ItemTypesTxt rows[3] = {{{0},1,0},{{0},2,1},{{0},3,1}};',
      'static DataTable t = {0, rows, 3};',
      'sgptDataTable = &t;',
      'int x = 1;',
      'printf("%d ", f(0, 1));',
      'for (int n = -2; n <= 4; n++) printf("%d ", f(&x, n));',
    ].join('\n');
    const before = compileAndRun(prelude(body.join('\n')), main);
    const after = compileAndRun(prelude(r.out), main);
    assert.ok(before.length > 0);
    assert.strictEqual(after, before);
  });

  it('leaves a chain whose body holds a label', () => {
    const r = run([
      'int f(int *p, int n) {',
      '  if (n > 7) goto L;',
      `  if (p && ${GUARD}) {`,
      '    L:',
      '    return sgptDataTable->pTxtItemTypes[n].throwable;',
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, []);
  });

  it('leaves a seed whose value calls as a condition before the getter', () => {
    const r = run([
      'int f(int n) {',
      `  if ((n = Peek(0) , n >= 0) && n < sgptDataTable->nTxtItemTypesSize && sgptDataTable->pTxtItemTypes + n) {`,
      '    return sgptDataTable->pTxtItemTypes[n].throwable;',
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1']);
    assert.ok(r.out.includes('if ((n = Peek(0) , n >= 0) && (pItemTypesTxt = n < sgptDataTable->nTxtItemTypesSize ? sgptDataTable->pTxtItemTypes + n : nullptr))'), r.out);
  });

  it('computes what a chain with an else-if arm computed', { skip: !hasNativeGpp() }, () => {
    const body = [
      'int f(U *u) {',
      '  int n;',
      '  if (!u) {',
      '    return -2;',
      '  } else if (u->a == 1 && (n = u->b , n >= 0) && n < sgptDataTable->nTxtItemTypesSize && sgptDataTable->pTxtItemTypes + n && sgptDataTable->pTxtItemTypes[n].beltable) {',
      '    return sgptDataTable->pTxtItemTypes[n].throwable * 10 + n;',
      '  } else {',
      '    return -1;',
      '  }',
      '}',
    ];
    const r = run(body);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:2']);
    const prelude = (fn: string) => [PRELUDE, 'struct U { int a; int b; };', 'DataTable *sgptDataTable;', fn].join('\n');
    const main = [
      'static ItemTypesTxt rows[3] = {{{0},1,0},{{0},2,1},{{0},3,1}};',
      'static DataTable t = {0, rows, 3};',
      'sgptDataTable = &t;',
      'printf("%d ", f(0));',
      'for (int a = 0; a <= 1; a++) for (int b = -1; b <= 3; b++) { U u = {a, b}; printf("%d ", f(&u)); }',
    ].join('\n');
    const before = compileAndRun(prelude(body.join('\n')), main);
    const after = compileAndRun(prelude(r.out), main);
    assert.ok(before.length > 0);
    assert.strictEqual(after, before);
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
  // SKILLS_CltProcessActiveSkill 004c7890: the only read is a switch's discriminant, and the
  // switch's cases call. The discriminant is evaluated before any case runs.
  it('routes the read in a switch head whose cases call', () => {
    const r = run([
      'int f(int n) {',
      `  if (!(${GUARD})) {`,
      '    return 0;',
      '  }',
      '  switch (sgptDataTable->pTxtItemTypes[n].throwable) {',
      '    case 1: return Use(n);',
      '  }',
      '  return 1;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1!']);
    assert.ok(r.out.includes('switch (pItemTypesTxt->throwable) { case 1: return Use(n); }'), r.out);
  });

  it('leaves a switch head that calls', () => {
    const r = run([
      'int f(int n) {',
      `  if (!(${GUARD})) {`,
      '    return 0;',
      '  }',
      '  switch (Use(sgptDataTable->pTxtItemTypes[n].throwable)) {',
      '    case 1: return Use(n);',
      '  }',
      '  return 1;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, []);
  });

  // UNITMODE_CanInterruptSkill 00480ba0: a byte flag read as `(uint8_t*)&T->pTxt[n] + 7`.
  // `&base[n]` takes the address of the record, not of the index.
  it('takes an index whose record has its address taken', () => {
    const r = run([
      'typedef unsigned char uint8_t;',
      'int f(int n) {',
      `  if (${GUARD} && *((uint8_t*)&sgptDataTable->pTxtItemTypes[n] + 0x11) & 4) {`,
      '    return 1;',
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1']);
    assert.ok(r.out.includes('&& *((uint8_t*)pItemTypesTxt + 0x11) & 4)'), r.out);
  });

  it('leaves an index whose own address is taken', () => {
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

  // Skills_SrvDoFunc_106_FireMissileRingOnTarget 005cd870: the decompiler prints the
  // `!`-guard as the getter's failure, each range test inverted.
  const FAIL = '(int)n < 0 || (int)n >= sgptDataTable->nTxtItemTypesSize || !(sgptDataTable->pTxtItemTypes + n)';
  it('takes the getter stated as its failure', () => {
    const r = run([
      'int f(int n) {',
      `  if (${FAIL}) {`,
      '    return -1;',
      '  }',
      '  return sgptDataTable->pTxtItemTypes[n].throwable;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1!']);
    assert.ok(r.out.includes('ItemTypesTxt* pItemTypesTxt = (int)n >= 0 && (int)n < sgptDataTable->nTxtItemTypesSize ? sgptDataTable->pTxtItemTypes + n : nullptr; if (!pItemTypesTxt) { return -1; } return pItemTypesTxt->throwable;'), r.out);
  });

  // MONSTER_MissileSplitOnHit-style: a test before the getter and a read after it.
  it('takes a failure with disjuncts before and after it', () => {
    const r = run([
      'int f(int *p, int n) {',
      `  if (!p || ${FAIL} || sgptDataTable->pTxtItemTypes[n].beltable <= 1) {`,
      '    return -1;',
      '  }',
      '  return sgptDataTable->pTxtItemTypes[n].throwable;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:2!']);
    assert.ok(r.out.includes('ItemTypesTxt* pItemTypesTxt; if (!p || !(pItemTypesTxt = (int)n >= 0 && (int)n < sgptDataTable->nTxtItemTypesSize ? sgptDataTable->pTxtItemTypes + n : nullptr) || pItemTypesTxt->beltable <= 1) { return -1; } return pItemTypesTxt->throwable;'), r.out);
  });

  it('leaves a failure whose branch falls through', () => {
    const r = run([
      'int f(int n) {',
      '  int a = 0;',
      `  if (${FAIL}) {`,
      '    a = 1;',
      '  }',
      '  return a + sgptDataTable->pTxtItemTypes[n].throwable;',
      '}',
    ]);
    assert.deepStrictEqual(r.sites, []);
  });

  it('flips only a comparison of the index', () => {
    const r = run([
      'int f(int n, int m) {',
      `  if (m * n < 0 || n >= sgptDataTable->nTxtItemTypesSize || !(sgptDataTable->pTxtItemTypes + n)) {`,
      '    return -1;',
      '  }',
      '  return sgptDataTable->pTxtItemTypes[n].throwable;',
      '}',
    ]);
    // `m * n < 0` is a test of its own: it stays a disjunct before the getter's run.
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:1!']);
    assert.ok(r.out.includes('if (m * n < 0 || !(pItemTypesTxt = n < sgptDataTable->nTxtItemTypesSize ? sgptDataTable->pTxtItemTypes + n : nullptr))'), r.out);
  });

  it('computes what a failure-stated guard computed', { skip: !hasNativeGpp() }, () => {
    const body = [
      'int f(int *p, int n) {',
      `  if (!p || ${FAIL} || sgptDataTable->pTxtItemTypes[n].beltable == 0) {`,
      '    return -1;',
      '  }',
      '  switch (sgptDataTable->pTxtItemTypes[n].throwable) {',
      '    case 2: return Use(20 + n);',
      '  }',
      '  return sgptDataTable->pTxtItemTypes[n].throwable * 10 + n;',
      '}',
    ];
    const r = run(body);
    assert.deepStrictEqual(r.sites, ['pItemTypesTxt:2!']);
    const prelude = (fn: string) => [PRELUDE, 'DataTable *sgptDataTable;', 'int Use(int v) { return v; }', fn].join('\n');
    const main = [
      'static ItemTypesTxt rows[3] = {{{0},1,0},{{0},2,1},{{0},3,1}};',
      'static DataTable t = {0, rows, 3};',
      'sgptDataTable = &t;',
      'int x = 1;',
      'printf("%d ", f(0, 1));',
      'for (int n = -2; n <= 4; n++) printf("%d ", f(&x, n));',
    ].join('\n');
    const before = compileAndRun(prelude(body.join('\n')), main);
    const after = compileAndRun(prelude(r.out), main);
    assert.ok(before.length > 0);
    assert.strictEqual(after, before);
  });
});
