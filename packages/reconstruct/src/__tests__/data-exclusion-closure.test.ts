/**
 * The runtime's data follows its code. v1410: the CRT globals Ghidra files at the
 * root (`gaCrtErrTable: CrtErrEntry[45]`, the `_PVFV`/`_PIFV` initializer tables, the
 * locale category table holding `&___init_dummy`) were emitted with types and
 * function addresses the exclusion had removed - `struct _PVFV;` in globals.h broke
 * every translation unit.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { selectDataExclusions, namespaceOfQualified, type DataClosureCandidate } from '../codegen/data-exclusion-closure.js';
import type { ExtractedFunction } from '../types.js';

const isExcludedNamespace = (ns: string) => /^(compiler|std)(::|$)/.test(ns);

function kept(name: string, ns: string, extra: Partial<ExtractedFunction> = {}): ExtractedFunction {
  return {
    name, address: '00401000', namespace: ns, signature: '', returnType: 'void', parameters: [],
    localVariables: [], callingConvention: '__cdecl', size: 4, isThunk: false, isExternal: false,
    hasVarArgs: false, calledFunctions: [], decompiled: '', ...extra,
  } as ExtractedFunction;
}

const g = (name: string, address: string, extra: Partial<DataClosureCandidate> = {}): DataClosureCandidate =>
  ({ name, address, size: 8, namespace: null, referencingFunctions: [], ...extra });

describe('data exclusion closure', () => {
  it('reads the namespace of a qualified function name, template arguments included', () => {
    assert.strictEqual(namespaceOfQualified('compiler::__lock'), 'compiler');
    assert.strictEqual(namespaceOfQualified('std::exception::`scalar_deleting_destructor\''), 'std::exception');
    assert.strictEqual(namespaceOfQualified('TSHashTable<A,B::C>::Destructor'), 'TSHashTable<A,B::C>');
    assert.strictEqual(namespaceOfQualified('main'), undefined);
  });

  it('excludes a datum only excluded code reads, keeps one kept code reads too', () => {
    const errTable = g('gaCrtErrTable', '0074a070', { referencingFunctions: ['compiler::__get_errno_from_oserr', 'compiler::__mtdeletelocks'] });
    const shared = g('gnShared', '00750000', { referencingFunctions: ['compiler::__lock', 'D2Game::f'] });
    const r = selectDataExclusions({ globals: [errTable, shared], keptFunctions: [kept('f', 'D2Game')], isExcludedNamespace });
    assert.deepStrictEqual(r.excluded.map(x => x.name), ['gaCrtErrTable']);
  });

  it('a reader the function closure KEPT is kept code', () => {
    const t = g('gaCrtLockTable', '00749f50', { referencingFunctions: ['compiler::__lock'] });
    const r = selectDataExclusions({ globals: [t], keptFunctions: [kept('__lock', 'compiler')], isExcludedNamespace });
    assert.deepStrictEqual(r.excluded, []);
  });

  it('a datum no code reads goes with the runtime its initializer points into', () => {
    const locale = g('gaCrtLocaleCategoryTable', '006f3168', { initializedData: { kind: 'array', elements: [
      { kind: 'pointer', value: 's_LC_ALL_006f315c' }, { kind: 'pointer', value: 'compiler::___init_dummy' },
    ] } });
    const gameTable = g('gaHandlers', '00710000', { initializedData: { kind: 'array', elements: [
      { kind: 'pointer', value: 'compiler::_memset' }, { kind: 'pointer', value: 'D2Game::f' },
    ] } });
    const r = selectDataExclusions({ globals: [locale, gameTable], keptFunctions: [kept('f', 'D2Game')], isExcludedNamespace });
    assert.deepStrictEqual(r.excluded.map(x => x.name), ['gaCrtLocaleCategoryTable']);
  });

  it('a datum only a runtime datum points at goes with it (v1489: the __lc_time_data day names)', () => {
    const timeInfo = g('gaCrtLocaleTimeInfoStart', '0074afd0', {
      referencingFunctions: ['compiler::___init_time'], xrefCount: 2,
      initializedData: { kind: 'struct', fields: [
        { name: 'wday_abbr', value: { kind: 'array', elements: [{ kind: 'pointer', value: 'DAT_006f9a80' }] } },
        { name: 'ww_timefmt', value: { kind: 'pointer', value: 'DAT_006f9988' } },
      ] },
    });
    const sun = g('DAT_006f9a80', '006f9a80', { size: 1, xrefCount: 1 });
    const fmt = g('DAT_006f9988', '006f9988', { size: 1, xrefCount: 1 });
    // A second reference the initializers do not show (an instruction outside any
    // function): not decided by this rule.
    const alsoElsewhere = g('DAT_006f9990', '006f9990', { size: 1, xrefCount: 2 });
    const timeInfo2 = g('gaCrtOther', '0074b100', {
      referencingFunctions: ['compiler::___init_time'], xrefCount: 1,
      initializedData: { kind: 'pointer', value: 'DAT_006f9990' },
    });
    // Pointed at by a runtime datum AND by a kept one: kept.
    const shared = g('DAT_006f9a00', '006f9a00', { size: 1, xrefCount: 2 });
    const runtimeToShared = g('gaCrtThird', '0074b200', {
      referencingFunctions: ['compiler::___init_time'], xrefCount: 1,
      initializedData: { kind: 'pointer', value: 'DAT_006f9a00' },
    });
    const gameToShared = g('gaGameTable', '00710000', {
      referencingFunctions: ['D2Game::f'], xrefCount: 1,
      initializedData: { kind: 'pointer', value: 'DAT_006f9a00' },
    });
    // Nothing points at it and no code reads it: not the runtime's by any record.
    const orphan = g('DAT_00731008', '00731008', { size: 4, xrefCount: 1 });
    const r = selectDataExclusions({
      globals: [timeInfo, sun, fmt, alsoElsewhere, timeInfo2, shared, runtimeToShared, gameToShared, orphan],
      keptFunctions: [kept('f', 'D2Game')], isExcludedNamespace,
    });
    assert.deepStrictEqual(r.excluded.map(x => x.name).sort(),
      ['DAT_006f9988', 'DAT_006f9a80', 'gaCrtLocaleTimeInfoStart', 'gaCrtOther', 'gaCrtThird']);
  });

  it('a runtime string table survives when kept code revives the table', () => {
    const table = g('gaCrtNames', '0074b000', {
      referencingFunctions: ['compiler::___init_time'], xrefCount: 2,
      initializedData: { kind: 'pointer', value: 'DAT_006f9a80' },
    });
    const sun = g('DAT_006f9a80', '006f9a80', { size: 1, xrefCount: 1 });
    const r = selectDataExclusions({
      globals: [table, sun],
      keptFunctions: [kept('f', 'D2Game', { decompiled: 'return gaCrtNames;' })], isExcludedNamespace,
    });
    assert.deepStrictEqual(r.excluded, []);
  });

  it('kept operands into the extent, a unique name in a kept body, or a kept initializer revive it', () => {
    const byOperand = g('gaPow10', '0074b358', { size: 348, referencingFunctions: ['compiler::CRT_StrToD_L'] });
    const byName = g('gaCtypeTable', '006f9280', { referencingFunctions: ['compiler::_isspace'] });
    const byData = g('gaBuf', '00993c80', { referencingFunctions: ['compiler::_fread'] });
    const holder = g('gaFiles', '0074a290', { referencingFunctions: ['D2Game::f'], initializedData: { kind: 'array', elements: [{ kind: 'pointer', value: 'gaBuf' }] } });
    const shared1 = g('vftable', '006faffc', { referencingFunctions: ['compiler::x'] });
    const shared2 = g('vftable', '006d5e5c', { referencingFunctions: ['Game::Ctor'] });
    const f = kept('f', 'D2Game', {
      decompiled: 'void f(void) { x = gaCtypeTable[1]; y = &vftable; }',
      operandRefs: { refs: [{ ins: '00401000', op: 0, to: '0074b360', type: 'READ' }], derived: [] } as never,
    });
    const r = selectDataExclusions({ globals: [byOperand, byName, byData, holder, shared1, shared2], keptFunctions: [f], isExcludedNamespace });
    // `vftable` names many tables; a body naming it says nothing about this one.
    assert.deepStrictEqual(r.excluded.map(x => `${x.name}@${x.address}`), ['vftable@006faffc']);
  });

  it('an extent ends at the next datum: an interior label is not revived by its neighbour\'s reader', () => {
    // _pow10neg @0074b4b8 and the label gaCRT_MsvcrtHelperData @0074b500 both carry the
    // run's _LDBL12[29] (348 bytes); a kept read at 0074b600 belongs to gaNext.
    const helper = g('gaCRT_MsvcrtHelperData', '0074b500', { size: 348, referencingFunctions: ['compiler::CRT_FltOut2'] });
    const next = g('gaNext', '0074b5f0', { size: 64, referencingFunctions: ['D2Game::f'] });
    const f = kept('f', 'D2Game', { operandRefs: { refs: [{ ins: '00401000', op: 0, to: '0074b600', type: 'READ' }], derived: [] } as never });
    const r = selectDataExclusions({ globals: [helper, next], keptFunctions: [f], isExcludedNamespace });
    assert.deepStrictEqual(r.excluded.map(x => x.name), ['gaCRT_MsvcrtHelperData']);
  });
});

