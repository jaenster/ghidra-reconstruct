import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { recordNullFoldPlugin } from '../builtins/record-null-fold.js';
import type { BranchLayoutEvidence, ReturnCopy } from '../builtins/branch-layout/evidence.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Every line prints one offset, 0x10 apart; `ifs` held an `if` keyword in the decompile. */
function layout(lines: string[], ifs: number[], returns: ReturnCopy[] = []): BranchLayoutEvidence {
  const m = new Map<number, number[]>();
  lines.forEach((_, i) => m.set(i + 1, [(i + 1) * 0x10]));
  return { lines: m, ifs: new Map(ifs.map(l => [l, l * 0x10])), returns };
}

function run(lines: string[], ev: BranchLayoutEvidence | null): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = recordNullFoldPlugin.createTransformer({ branchLayout: ev, onSite: e => sites.push(`${e.pointer}:${e.record}`) });
  return { out: flat(emit(t(parse(lines.join('\n'))) as AnyNode)), sites };
}

// Missiles_SrvHitFunc_AreaElementalDamageExplosion 005a9a70: the null test of pUnit and the
// range tests all jump to 005a9be2, from one decompiled `if`.
const SITE = [
  'int f(Unit *pUnit) {',
  '  if (!pUnit) {',
  '    return 1;',
  '  }',
  '  int nId = pUnit->nClassId;',
  '  Rec* pTxt = nId >= 0 && nId < gT->nSize ? gT->pTxt + nId : nullptr;',
  '  if (!pTxt) {',
  '    return 1;',
  '  }',
  '  return pTxt->a + nId;',
  '}',
];

describe('record-null-fold', () => {
  it('puts the null test into the lookup where the original leaves both through one exit', () => {
    const r = run(SITE, layout(SITE, [2, 9]));
    assert.deepStrictEqual(r.sites, ['pUnit:pTxt']);
    assert.ok(r.out.includes('int nId; Rec* pTxt = pUnit && ((nId = pUnit->nClassId) >= 0 && nId < gT->nSize) ? gT->pTxt + nId : nullptr; if (!pTxt) { return 1; } return pTxt->a + nId;'), r.out);
  });

  it('leaves the guard when the tests come from two decompiled ifs and no shared exit', () => {
    const r = run(SITE, layout(SITE, [2, 6, 7]));
    assert.deepStrictEqual(r.sites, []);
    assert.ok(r.out.includes('if (!pUnit) { return 1; }'), r.out);
  });

  it('leaves the guard when the two returns differ', () => {
    const lines = SITE.map(l => l === '    return 1;' ? '    return 2;' : l);
    lines[7] = '    return 1;';
    assert.deepStrictEqual(run(lines, layout(lines, [2])).sites, []);
  });

  // MISSILE_CltHitFn54_VinesTrail 004d0ff0: record-getter-guard writes the record's test
  // new, with no line; it is the getter's last test, placed by the store's line.
  it('places a record test written with no line by the getter\'s store', () => {
    const tu = parse(SITE.join('\n')) as unknown as { declarations: Array<{ body: { statements: Array<{ kind: string; condition?: { location?: unknown } }> } }> };
    const ifs = tu.declarations[0].body.statements.filter(x => x.condition);
    delete ifs[1].condition!.location;
    const sites: string[] = [];
    const t = recordNullFoldPlugin.createTransformer({ branchLayout: layout(SITE, [2, 9]), onSite: e => sites.push(`${e.pointer}:${e.record}`) });
    const out = flat(emit(t(tu as never) as AnyNode));
    assert.deepStrictEqual(sites, ['pUnit:pTxt']);
    assert.ok(out.includes('Rec* pTxt = pUnit && ((nId = pUnit->nClassId) >= 0'), out);
  });

  // Missiles_SrvHitFunc_SpawnSubMissileAtWallHit 005abf70: the record's guard tests a field
  // after the record; with pUnit null the record is null and `!pTxt` decides it alone.
  const MORE = SITE.map(l => l === '  if (!pTxt) {' ? '  if (!pTxt || pTxt->nSub < 0) {' : l);
  it('folds when the record guard tests more after the record, as `!X || ...`', () => {
    const r = run(MORE, layout(MORE, [2, 9]));
    assert.deepStrictEqual(r.sites, ['pUnit:pTxt']);
    assert.ok(r.out.includes('int nId; Rec* pTxt = pUnit && ((nId = pUnit->nClassId) >= 0 && nId < gT->nSize) ? gT->pTxt + nId : nullptr; if (!pTxt || pTxt->nSub < 0) { return 1; }'), r.out);
  });

  it('folds when the record guard is `!(X && ...)`', () => {
    const lines = SITE.map(l => l === '  if (!pTxt) {' ? '  if (!(pTxt && pTxt->nSub >= 0)) {' : l);
    const r = run(lines, layout(lines, [2, 9]));
    assert.deepStrictEqual(r.sites, ['pUnit:pTxt']);
    assert.ok(r.out.includes('if (!(pTxt && pTxt->nSub >= 0)) { return 1; }'), r.out);
  });

  it('leaves the guard when the record is not its first test', () => {
    for (const g of ['  if (gFlag || !pTxt) {', '  if (!(gFlag && pTxt)) {', '  if (!pTxt && gFlag) {']) {
      const lines = SITE.map(l => l === '  if (!pTxt) {' ? g : l);
      assert.deepStrictEqual(run(lines, layout(lines, [2, 9])).sites, [], g);
    }
  });

  it('changes nothing without the facts', () => {
    assert.deepStrictEqual(run(SITE, null).sites, []);
  });
});
