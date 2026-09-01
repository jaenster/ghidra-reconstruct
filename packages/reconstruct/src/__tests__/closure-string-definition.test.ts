/**
 * A declaration alone is a promise the tree never keeps: 18 symbols reached the
 * link stage declared in globals.h, referenced by emitted bodies, and defined
 * nowhere. Thirteen of them are Ghidra string labels whose bytes the extraction
 * already had and the snapshot threw away.
 *
 * The rules these tests lock down are the ones that were expensive to learn:
 *
 *  - the LABEL is not the content. `s_Error_1__Diablo_II_is_unable_to_p_0072daa8`
 *    is 69 bytes of string rendered as 34 identifier-legal characters, with the
 *    colon mangled and one of two spaces gone. Content comes from the bytes, and
 *    the join is on the ADDRESS the label carries.
 *  - the definition set is a SUBSET of the declaration set, built in the same
 *    place, so the two can never disagree about what an object is.
 *  - untyped data (`UNK_`, `DAT_`, `DWORD_`) gets no definition at all. The name
 *    carries a width but not an extent, the bodies index off it, and a one-byte
 *    definition would link and then read past the object — a defect that
 *    compiles, which is worse than the link error.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  generateGlobalsHeader,
  generateGlobalsImpl,
  getDeclarationClosureReport,
  resetDeclaredNames,
  setDeclarationClosureDataContent,
  setDeclarationClosureEmitters,
  setDeclarationClosureModel,
  setGlobalInitializerTypes,
  setMultidimArrayGlobals,
} from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, ReconstructOptions } from '../types.js';

import {
  computeDeclarationClosure,
  renderClosureDefinitionBlock,
  cxxStringLiteral,
  stringLabelAddress,
  normalizeDataAddress,
  type ClosureInputs,
  type ClosureStringContent,
} from '../codegen/declaration-closure.js';

function inputs(over: Partial<ClosureInputs> = {}): ClosureInputs {
  return {
    allFunctions: [],
    allGlobals: [],
    referenced: new Map(),
    declared: new Set<string>(),
    emittedFunctionNames: new Set<string>(),
    renderPrototype: () => null,
    renderExtern: () => null,
    sanitize: (n) => n.replace(/[^A-Za-z0-9_]/g, '_'),
    ...over,
  };
}

function content(
  value: string,
  encoding = 'TerminatedCString',
  length = Buffer.byteLength(value, 'utf8'),
): ClosureStringContent {
  return { value, length, encoding };
}

describe('closure string definitions', () => {
  it('takes the content from the bytes, never from the label text', () => {
    // The real string, and the label Ghidra built from it. They disagree about
    // the colon, about the double space, and about 35 of the 69 bytes.
    const real = 'Error 1: Diablo II is unable to proceed.  Unsupported graphics mode.';
    const name = 's_Error_1__Diablo_II_is_unable_to_p_0072daa8';

    const { declarations } = computeDeclarationClosure(inputs({
      referenced: new Map([[name, 2]]),
      stringContentByAddress: new Map([['72daa8', content(real, 'string')]]),
    }));

    assert.strictEqual(declarations.length, 1);
    assert.strictEqual(declarations[0].decl, `extern char ${name}[];`);
    assert.strictEqual(declarations[0].def, `char ${name}[] = "${real}";`);
  });

  it('joins on the address, so a label whose own text is hex still resolves', () => {
    assert.strictEqual(stringLabelAddress('s_Skill1_006ebefc'), '6ebefc');
    assert.strictEqual(stringLabelAddress('s_207_82_87_133_0070f130'), '70f130');
    assert.strictEqual(stringLabelAddress('s_deadbeef_006ebefc'), '6ebefc');
    assert.strictEqual(stringLabelAddress('s__not_xlated_call_ken_w_00730520'), '730520');
    assert.strictEqual(stringLabelAddress('gnPartyRosterItemHeight'), null);
    // Ghidra hands addresses back both bare and qualified, zero-padded or not.
    assert.strictEqual(normalizeDataAddress('ram:0070F130'), '70f130');
    assert.strictEqual(normalizeDataAddress('0x0070f130'), '70f130');
  });

  it('sizes the array from the bytes, so the definition is the string it stands for', () => {
    const { declarations } = computeDeclarationClosure(inputs({
      referenced: new Map([['s_block_006e1730', 3]]),
      stringContentByAddress: new Map([['6e1730', content('block')]]),
    }));
    // `char x[] = "block"` is six bytes — five plus the terminator, which is what
    // Ghidra reports the datum's size as.
    assert.strictEqual(declarations[0].def, 'char s_block_006e1730[] = "block";');
  });

  it('declares but does not define a label whose content extraction did not carry', () => {
    const { declarations, definitionGaps } = computeDeclarationClosure(inputs({
      referenced: new Map([['s_block_006e1730', 3]]),
    }));
    assert.strictEqual(declarations.length, 1);
    assert.strictEqual(declarations[0].def, undefined);
    assert.ok([...definitionGaps.values()].flat().includes('s_block_006e1730'));
  });

  it('refuses a definition when the content does not weigh what Ghidra says it does', () => {
    // Six characters arriving where Ghidra counted twenty means bytes were lost
    // in transit. A char[7] here would be the wrong object at the wrong size.
    const { declarations, definitionGaps } = computeDeclarationClosure(inputs({
      referenced: new Map([['s_truncated_006e1740', 1]]),
      stringContentByAddress: new Map([['6e1740', content('block!', 'string', 20)]]),
    }));
    assert.strictEqual(declarations[0].def, undefined);
    assert.ok([...definitionGaps.keys()].some(r => /lost in transit/.test(r)));
  });

  it('refuses a char[] for an encoding no char[] can hold', () => {
    const { declarations, definitionGaps } = computeDeclarationClosure(inputs({
      referenced: new Map([['s_Wide_006e1750', 1]]),
      stringContentByAddress: new Map([['6e1750', content('Wide', 'unicode')]]),
    }));
    assert.strictEqual(declarations[0].def, undefined);
    assert.ok([...definitionGaps.keys()].some(r => /unicode/.test(r)));
  });

  it('never defines untyped data, because the name gives a width but no extent', () => {
    // `*(uint16_t*)(&UNK_006da48c + i * 8)` and `(&DWORD_006db8d0)[i * 3]` are
    // array accesses. Only Ghidra can say how long the array is, so the fix is a
    // typed array in Ghidra, not a fabricated object here.
    const names = ['UNK_006da48c', 'UNK_006dff20', 'DWORD_006db8d0', '_DAT_00700140'];
    const { declarations, definitionGaps } = computeDeclarationClosure(inputs({
      referenced: new Map(names.map(n => [n, 1])),
    }));
    assert.strictEqual(declarations.length, names.length);
    for (const d of declarations) assert.strictEqual(d.def, undefined, d.name);
    const gapped = new Set([...definitionGaps.values()].flat());
    for (const n of names) assert.ok(gapped.has(n), `${n} must be reported as undefinable`);
  });

  it('escapes so the literal is the bytes, and only the bytes', () => {
    const bytes = Buffer.from([
      0x22, 0x5c, 0x3f, 0x3f, 0x2f, 0x0a, 0x09, 0x01, 0x37, 0xff, 0x80,
    ]);
    // Octal, always three digits: a hex escape is greedy, so "\x0a" before a '7'
    // would silently become one character 0xA7. `?` is escaped so `??/` cannot
    // become a trigraph.
    assert.strictEqual(cxxStringLiteral(bytes), '"\\"\\\\\\?\\?/\\012\\011\\0017\\377\\200"');
    assert.strictEqual(cxxStringLiteral(Buffer.from([])), '""');
  });

  it('renders only what it can define, and nothing when it can define nothing', () => {
    assert.deepStrictEqual(renderClosureDefinitionBlock([]), []);
    assert.deepStrictEqual(
      renderClosureDefinitionBlock([{ name: 'UNK_006da48c', decl: 'extern uint8_t UNK_006da48c;', origin: 'ghidra-untyped-data' }]),
      [],
    );
    const block = renderClosureDefinitionBlock([
      { name: 's_block_006e1730', decl: 'extern char s_block_006e1730[];', def: 'char s_block_006e1730[] = "block";', origin: 'ghidra-untyped-data' },
      { name: 'UNK_006da48c', decl: 'extern uint8_t UNK_006da48c;', origin: 'ghidra-untyped-data' },
    ]);
    assert.deepStrictEqual(
      block.filter(l => !l.startsWith('//') && l.length > 0),
      ['char s_block_006e1730[] = "block";'],
    );
  });

  it('every definition it emits answers a declaration it also emits', () => {
    const labels = [
      ['s_207_82_87_133_0070f130', '70f130', '207.82.87.133'],
      ['s_DIABLO2SRV_007065dc', '7065dc', 'DIABLO2SRV'],
      ['s_Direct3D_Enumeration_0074c058', '74c058', 'Direct3D Enumeration'],
      ['s_Enumeration_Class_0074c044', '74c044', 'Enumeration Class'],
      ['s_Skill1_006ebefc', '6ebefc', 'Skill1'],
      ['s__not_xlated_call_ken_w_00730520', '730520', ' -not xlated call ken w'],
      ['s_blocks_006e1738', '6e1738', 'blocks'],
    ] as const;
    const { declarations } = computeDeclarationClosure(inputs({
      referenced: new Map(labels.map(([n]) => [n, 1] as [string, number])),
      stringContentByAddress: new Map(labels.map(([, a, v]) => [a, content(v)])),
    }));
    assert.strictEqual(declarations.length, labels.length);
    for (const d of declarations) {
      assert.ok(d.def, `${d.name} must be defined`);
      // Declaration and definition must name the same object under the same
      // spelling; that symmetry is the reason both are built here.
      assert.ok(d.decl.includes(d.name) && d.def!.startsWith(`char ${d.name}[] = `), d.name);
    }
  });
});

/**
 * The pair as the tree actually sees it: globals.h declares, one globals unit
 * defines, and no other unit defines it twice.
 */
describe('globals.h declares and exactly one globals unit defines', () => {
  const options = {
    outputDir: '/tmp/test',
    format: 'cpp',
    organization: 'namespace',
    generateCMake: false,
    generateSourceMaps: false,
    transformPreset: 'full',
    includeAddressComments: false,
  } as ReconstructOptions & { projectName?: string; binaryName?: string };

  const GAME_GLOBAL = {
    name: 'gnPartyRosterItemHeight', address: '006db8d8', dataType: 'int',
    suggestedType: 'int', size: 4, isInitialized: true, value: '0',
    xrefCount: 2, scope: 'global',
  } as AnalyzedDataSymbol;

  /** `Game.cpp` passes this to `SStrCopy`; `MonUnique.cpp` indexes off that one. */
  const referenced = new Map<string, number>([
    ['s_207_82_87_133_0070f130', 1],
    ['UNK_006da48c', 1],
  ]);

  beforeEach(() => {
    resetDeclaredNames();
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
    setDeclarationClosureModel([], []);
    setDeclarationClosureEmitters(new Set<string>(), () => null);
  });

  it('emits the extern and the definition for one and the same object', () => {
    setDeclarationClosureDataContent([
      { address: '0070f130', value: '207.82.87.133', length: 13, encoding: 'string' },
    ]);
    const header = generateGlobalsHeader(
      [GAME_GLOBAL], options, [], undefined, undefined, referenced);
    assert.match(header, /^extern char s_207_82_87_133_0070f130\[\];$/m);

    const owner = generateGlobalsImpl([GAME_GLOBAL], options, 'globals.h', undefined, undefined, true);
    assert.match(owner, /^char s_207_82_87_133_0070f130\[\] = "207\.82\.87\.133";$/m);

    // Only the owning unit. Every other globals unit declares the same header
    // and would otherwise carry a duplicate definition of the same symbol.
    const other = generateGlobalsImpl([GAME_GLOBAL], options, 'globals.h', undefined, new Set([GAME_GLOBAL]));
    assert.doesNotMatch(other, /s_207_82_87_133_0070f130\[\] =/);
  });

  it('leaves untyped data declared and undefined, and says so', () => {
    setDeclarationClosureDataContent([]);
    const header = generateGlobalsHeader(
      [GAME_GLOBAL], options, [], undefined, undefined, referenced);
    assert.match(header, /^extern uint8_t UNK_006da48c;$/m);

    const owner = generateGlobalsImpl([GAME_GLOBAL], options, 'globals.h', undefined, undefined, true);
    assert.doesNotMatch(owner, /^uint8_t UNK_006da48c\b.*=/m);

    const report = getDeclarationClosureReport();
    assert.ok(report);
    const gapped = new Set([...report.definitionGaps.values()].flat());
    assert.ok(gapped.has('UNK_006da48c'));
    assert.ok(gapped.has('s_207_82_87_133_0070f130'),
      'with no content carried, the string label is a gap too — never invented from its label');
  });

  it('still defines nothing when the owning unit has no modelled global left', () => {
    // The shared globals unit can end up with an empty partition; the closure
    // definitions belong to it regardless, so they must survive that early exit.
    setDeclarationClosureDataContent([
      { address: '0070f130', value: '207.82.87.133', length: 13, encoding: 'string' },
    ]);
    generateGlobalsHeader([GAME_GLOBAL], options, [], undefined, undefined, referenced);
    const empty = generateGlobalsImpl(
      [GAME_GLOBAL], options, 'globals.h', undefined, new Set<AnalyzedDataSymbol>(), true);
    assert.match(empty, /^char s_207_82_87_133_0070f130\[\] = "207\.82\.87\.133";$/m);
  });
});
