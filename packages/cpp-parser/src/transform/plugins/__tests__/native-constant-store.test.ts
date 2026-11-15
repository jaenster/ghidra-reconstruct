import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { transformGhidraCode } from '../../../index.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';
import { nativeConstantStorePlugin, type NativeConstantStoreOptions } from '../builtins/native-constant-store.js';

const source = `D2DamageStrc f(D2SkillsTxt* pSkillsTxt) {
  D2DamageStrc sDamage;
  memset(&sDamage, 0, sizeof(sDamage));
  sDamage.reserved = 0x1234;
  SetDamageOnEvent(&sDamage);
  sDamage.wResultFlags |= pSkillsTxt->ResultFlags;
  sDamage.dwHitFlags = pSkillsTxt->HitFlags | 1;
  return sDamage;
}`;
const aliased = `D2DamageStrc alias(D2DamageStrc* pOther, int useSelf) {
  D2DamageStrc sDamage;
  memcpy(&sDamage, pOther, sizeof(sDamage));
  D2DamageStrc* pSource = useSelf ? &sDamage : pOther;
  SetDamageOnEvent(&sDamage);
  sDamage.wResultFlags |= pSource->wResultFlags;
  sDamage.dwHitFlags = pSource->dwHitFlags | 1;
  return sDamage;
}`;
const options: NativeConstantStoreOptions = {
  targetPointerSize: 4, targetLanguageId: 'x86:LE:32:default',
  structLayouts: {
    D2DamageStrc: [
      { name: 'dwHitFlags', offset: 0, size: 4, type: 'int32_t' },
      { name: 'wResultFlags', offset: 4, size: 2, type: 'int16_t' },
      { name: 'reserved', offset: 6, size: 2, type: 'uint16_t' },
    ],
    D2SkillsTxt: [
      { name: 'HitFlags', offset: 0, size: 4, type: 'int32_t' },
      { name: 'ResultFlags', offset: 4, size: 2, type: 'int16_t' },
      { name: 'reserved', offset: 6, size: 2, type: 'uint16_t' },
    ],
  },
  aggregateSizes: { D2DamageStrc: 8, D2SkillsTxt: 8 }, unionNames: [],
  constantStores: [{ name: 'sDamage', size: 8, fieldOffset: 0, value: 1, at: 0x109, afterCall: { name: 'SetDamageOnEvent', at: 0x104 }, between: [{ offset: 4, size: 2, at: 0x117 }], finalAt: 0x124 }],
};
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
function run(code = source, config = options): string {
  return emit(nativeConstantStorePlugin.createTransformer(config)(parse(code)) as AnyNode);
}
function refused(code: string, config = options): void {
  assert.equal(flat(run(code, config)), flat(emit(parse(code) as AnyNode)));
}

describe('native-constant-store', () => {
  it('restores the native write before the disjoint field update', () => {
    assert.match(flat(run()), /sDamage\.dwHitFlags = 1; sDamage\.wResultFlags \|= pSkillsTxt->ResultFlags; sDamage\.dwHitFlags = pSkillsTxt->HitFlags \| 1;/);
  });
  it('is idempotent', () => assert.equal(flat(run(run())), flat(run())));
  it('leaves the function unchanged without native evidence', () => refused(source, { ...options, constantStores: [] }));
  it('recognizes the same literal on the left of the OR', () => assert.match(flat(run(source.replace('pSkillsTxt->HitFlags | 1', '1 | pSkillsTxt->HitFlags'))), /dwHitFlags = 1; sDamage.wResultFlags/));
  for (const [name, edit] of [
    ['a different literal', (s: string) => s.replace('HitFlags | 1', 'HitFlags | 2')],
    ['an intervening call', (s: string) => s.replace('sDamage.dwHitFlags = pSkillsTxt', 'Call(); sDamage.dwHitFlags = pSkillsTxt')],
    ['a different preceding callee', (s: string) => s.replace('SetDamageOnEvent', 'OtherCall')],
    ['an unrelated call argument', (s: string) => s.replace('SetDamageOnEvent(&sDamage)', 'SetDamageOnEvent(pSkillsTxt)')],
    ['an initialized aggregate', (s: string) => s.replace('D2DamageStrc sDamage;', 'D2DamageStrc sDamage = {1};')],
    ['an already represented field write', (s: string) => s.replace('SetDamageOnEvent(&sDamage);', 'SetDamageOnEvent(&sDamage); sDamage.dwHitFlags |= 1;')],
    ['a call in the other field update', (s: string) => s.replace('pSkillsTxt->ResultFlags', 'Call()')],
    ['a side effect in the final RHS', (s: string) => s.replace('pSkillsTxt->HitFlags | 1', '(pSkillsTxt->HitFlags++, pSkillsTxt->HitFlags) | 1')],
    ['an unrelated pointer receiver', (s: string) => s.replace('D2SkillsTxt* pSkillsTxt', 'void* pSkillsTxt')],
    ['a volatile receiver', (s: string) => s.replace('D2SkillsTxt* pSkillsTxt', 'volatile D2SkillsTxt* pSkillsTxt')],
    ['a const aggregate', (s: string) => s.replace('D2DamageStrc sDamage', 'const D2DamageStrc sDamage')],
    ['duplicate locals', (s: string) => s.replace('return sDamage;', '{ D2DamageStrc sDamage; } return sDamage;')],
    ['multiple matching runs', (s: string) => s.replace('return sDamage;', 'sDamage.wResultFlags |= pSkillsTxt->ResultFlags; sDamage.dwHitFlags = pSkillsTxt->HitFlags | 1; return sDamage;')],
    ['a labelled entry', (s: string) => s.replace('sDamage.wResultFlags |=', 'label: sDamage.wResultFlags |=')],
  ] as const) it(`refuses ${name}`, () => refused(edit(source)));
  for (const [name, edit] of [
    ['another architecture', (o: NativeConstantStoreOptions) => { o.targetPointerSize = 8; }],
    ['an unknown language', (o: NativeConstantStoreOptions) => { delete o.targetLanguageId; }],
    ['a different aggregate size', (o: NativeConstantStoreOptions) => { o.aggregateSizes!.D2DamageStrc = 12; }],
    ['a union', (o: NativeConstantStoreOptions) => { o.unionNames = ['D2DamageStrc']; }],
    ['a bitfield', (o: NativeConstantStoreOptions) => { o.structLayouts!.D2DamageStrc[0].bitSize = 1; }],
    ['overlapping fields', (o: NativeConstantStoreOptions) => { o.structLayouts!.D2DamageStrc[1].offset = 2; }],
    ['volatile source field', (o: NativeConstantStoreOptions) => { o.structLayouts!.D2SkillsTxt[0].type = 'volatile int32_t'; }],
    ['an unknown source layout', (o: NativeConstantStoreOptions) => { delete o.structLayouts!.D2SkillsTxt; }],
    ['a reordered native window', (o: NativeConstantStoreOptions) => { o.constantStores![0].between[0].at = 0x125; }],
    ['ambiguous native windows', (o: NativeConstantStoreOptions) => { o.constantStores = [o.constantStores![0], o.constantStores![0]]; }],
  ] as const) it(`refuses ${name}`, () => { const o = structuredClone(options); edit(o); refused(source, o); });
  it('is registered in the real full transform pipeline', () => {
    const r = transformGhidraCode(source, { usePluginRegistry: true, preset: 'full', pluginOptions: { pluginOptions: { 'native-constant-store': options } } as never });
    assert.ok(r.success, r.error);
    assert.match(r.code, /dwHitFlags = 1;/);
  });
  it('matches the native-write reference for ordinary and aliased flag reads in an optimized build', { skip: !hasNativeGpp() }, () => {
    const expected = source.replace('  sDamage.wResultFlags |=', '  sDamage.dwHitFlags = 1;\n  sDamage.wResultFlags |=');
    const expectedAlias = aliased.replace('  sDamage.wResultFlags |=', '  sDamage.dwHitFlags = 1;\n  sDamage.wResultFlags |=');
    const code = `struct D2DamageStrc { int32_t dwHitFlags; int16_t wResultFlags; uint16_t reserved; };
      struct D2SkillsTxt { int32_t HitFlags; int16_t ResultFlags; uint16_t reserved; };
      static void SetDamageOnEvent(D2DamageStrc*) {}
      namespace Expected { ${expected} ${expectedAlias} }
      namespace Actual { ${run()} ${run(aliased)} }`;
    const output = compileAndRun(code, `for (uint32_t i = 0; i < 65536; ++i) {
      uint32_t bits = i * 0x9e3779b9U;
      D2SkillsTxt src; memcpy(&src.HitFlags, &bits, 4); memcpy(&src.ResultFlags, &i, 2); src.reserved = 0;
      D2DamageStrc a = Expected::f(&src), b = Actual::f(&src);
      if (a.dwHitFlags != b.dwHitFlags || a.wResultFlags != b.wResultFlags || a.reserved != b.reserved) return 1;
      D2DamageStrc other; other.dwHitFlags = src.HitFlags; other.wResultFlags = src.ResultFlags; other.reserved = 0xabcd;
      for (int self = 0; self < 2; ++self) {
        a = Expected::alias(&other, self); b = Actual::alias(&other, self);
        if (a.dwHitFlags != b.dwHitFlags || a.wResultFlags != b.wResultFlags || a.reserved != b.reserved) return 2;
        if (self && b.dwHitFlags != 1) return 3;
      }
    } puts("196608 flag scenarios ok");`, { optimize: true });
    assert.equal(output.trim(), '196608 flag scenarios ok');
  });
});
