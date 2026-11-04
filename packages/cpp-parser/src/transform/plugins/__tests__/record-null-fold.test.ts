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
    assert.ok(r.out.includes('int nId; Rec* pTxt = pUnit && (nId = pUnit->nClassId) >= 0 && nId < gT->nSize ? gT->pTxt + nId : nullptr; if (!pTxt) { return 1; } return pTxt->a + nId;'), r.out);
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

  it('changes nothing without the facts', () => {
    assert.deepStrictEqual(run(SITE, null).sites, []);
  });
});
