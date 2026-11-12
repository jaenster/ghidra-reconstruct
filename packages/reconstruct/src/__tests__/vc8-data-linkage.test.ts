/**
 * A global a VC8 compile proved is defined outside the TU that uses it: never that TU's
 * `static`, never homed in its data run, defined by the globals units; the run around it
 * keeps its statics.
 *
 * Shape from 1.14d: gnNpcMenuScrollCompleteMode 007c0c7b, every user of which is in
 * npcmenu.cpp, sits in npcmenu's run between gnNpcMenuTradeActionGold 007c0c79 and
 * gpNpcCurrentSpeech 007c0c7d. NPCMENU_ScrollCompleteShowNextMessage 004b18c0 loads it
 * `mov cx, word ptr [007c0c7b]`, which VC8 gives only when the TU declares it and does
 * not define it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { computeFileLocalGlobals } from '../codegen/index.js';
import { assignDataHomes, keepDataRunsWhole, dataHomeVeto } from '../codegen/file-local-globals.js';
import { generateGlobalsImpl } from '../codegen/globals-header.js';
import { parseVc8DataLinkageTag, vc8DataLinkage, markMeasuredExternData, VC8_DATA_LINKAGE_TAG } from '../codegen/vc8-data-linkage.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import type { AnalyzedDataSymbol, ReconstructOptions } from '../types.js';

const BODY = 'void NPCMENU_ScrollCompleteShowNextMessage(void)\n{\n  NPCMENU_ShowMessage(gnNpcMenuScrollCompleteMode);\n  return;\n}\n';
const DH = vc8formBodyHash(BODY);
const tagData = (addrs: string, size = 164, dh = DH) => `extern(${addrs});ev=0123456789;bh=${size}-89abcdef;dh=${dh}`;
const func = (data: string, size = 164) => ({
  name: 'NPCMENU_ScrollCompleteShowNextMessage', size, decompiled: BODY,
  tags: [{ type: VC8_DATA_LINKAGE_TAG, data }],
});

function sym(name: string, address: string, size: number, fns: string[]): AnalyzedDataSymbol {
  return {
    name, address, dataType: 'uint16_t', suggestedType: 'uint16_t', size, isInitialized: false,
    xrefCount: fns.length, scope: 'global', referencingFunctions: fns,
  } as AnalyzedDataSymbol;
}

const NPCMENU = 'D2Client/UI/npcmenu.cpp';
const implOf = new Map([
  ['NPCMENU_OnScrollComplete', NPCMENU],
  ['NPCMENU_ScrollCompleteShowNextMessage', NPCMENU],
  ['NPCMENU_TradeDrawCallback', NPCMENU],
]);
const inputs = { foreignSources: [], functionQualifiedNames: new Set<string>(), rootTypeNames: new Set<string>() };

/** The npcmenu run around 007c0c7b, through the scope pipeline's order. */
function scopes(tags: Array<{ name: string; size: number; decompiled: string; tags: { type: string; data: string }[] }>) {
  const gs = [
    sym('gnNpcMenuRepairCostGold', '007c0c77', 2, ['NPCMENU_TradeDrawCallback', 'NPCMENU_OnScrollComplete']),
    sym('gnNpcMenuTradeActionGold', '007c0c79', 2, ['NPCMENU_TradeDrawCallback']),
    sym('gnNpcMenuScrollCompleteMode', '007c0c7b', 2, ['NPCMENU_ScrollCompleteShowNextMessage', 'NPCMENU_OnScrollComplete']),
    sym('gpNpcCurrentSpeech', '007c0c7d', 4, ['NPCMENU_OnScrollComplete']),
  ];
  const unknown = markMeasuredExternData(gs, vc8DataLinkage(tags as never));
  computeFileLocalGlobals(gs, implOf, new Set());
  assignDataHomes(gs, implOf, inputs);
  const demoted = keepDataRunsWhole(gs, implOf);
  return { gs, unknown, demoted };
}

describe('vc8datalinkage tags', () => {
  it('parses one or more addresses and the measured body', () => {
    assert.deepStrictEqual(parseVc8DataLinkageTag(tagData('007c0c7b,0x007C0C77')),
      { addresses: ['007c0c7b', '007c0c77'], size: 164, body: DH });
    for (const bad of ['static(007c0c7b);ev=0123456789;bh=164-89abcdef;dh=' + DH, tagData(''), tagData('7c0c7b'),
      'extern(007c0c7b);bh=164-89abcdef;dh=' + DH]) {
      assert.strictEqual(parseVc8DataLinkageTag(bad), undefined, bad);
    }
  });

  it('a tag measured on another size or decompile is stale', () => {
    const l = vc8DataLinkage([func(tagData('007c0c7b'), 170), func(tagData('007c0c77', 164, '00000000'))]);
    assert.strictEqual(l.external.size, 0);
    assert.deepStrictEqual(l.stale.map(s => s.why), ['size 170, the tag measured 164', `decompile ${DH}, the tag measured 00000000`]);
  });
});

describe('Golden: NPCMENU_ScrollCompleteShowNextMessage 004b18c0', () => {
  it('without a tag every npcmenu-only global is the TU\'s static', () => {
    const { gs } = scopes([]);
    assert.deepStrictEqual(gs.map(g => [g.scope, g.ownerFile]), gs.map(() => ['file-local', NPCMENU]));
  });

  it('the tagged globals stay external with no home; the run keeps its other statics', () => {
    const { gs, unknown, demoted } = scopes([func(tagData('007c0c7b,007c0c77'))]);
    assert.deepStrictEqual(unknown, []);
    assert.strictEqual(demoted, 0);
    const by = new Map(gs.map(g => [g.name, g]));
    for (const n of ['gnNpcMenuScrollCompleteMode', 'gnNpcMenuRepairCostGold']) {
      const g = by.get(n)!;
      assert.strictEqual(g.scope, 'global', n);
      assert.strictEqual(g.ownerFile, undefined, n);
      assert.strictEqual(g.homeFile, undefined, n);
      assert.strictEqual(dataHomeVeto(g), 'vc8datalinkage-extern', n);
    }
    for (const n of ['gnNpcMenuTradeActionGold', 'gpNpcCurrentSpeech']) {
      assert.deepStrictEqual([by.get(n)!.scope, by.get(n)!.ownerFile], ['file-local', NPCMENU], n);
    }
    // Defined by the globals units, where a homeless global is.
    const cpp = generateGlobalsImpl(gs.filter(g => g.scope === 'global'), {
      outputDir: '/tmp/test', format: 'cpp', organization: 'namespace', generateCMake: false,
      generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false, promoteStaticGlobals: true,
    } as ReconstructOptions);
    assert.match(cpp, /uint16_t gnNpcMenuScrollCompleteMode/);
    assert.match(cpp, /uint16_t gnNpcMenuRepairCostGold/);
  });

  it('a stale tag changes nothing; an address no global starts at is reported', () => {
    assert.strictEqual(scopes([func(tagData('007c0c7b'), 170)]).gs[2].scope, 'file-local');
    const { gs, unknown } = scopes([func(tagData('007c0c7c'))]);
    assert.deepStrictEqual(unknown, ['007c0c7c']);
    assert.ok(gs.every(g => g.scope === 'file-local'));
  });
});
