import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { AnalyzedDataSymbol, ExtractedString } from '../types.js';
import { classifyCompilerData, parseMacDataPairs, type CompilerDataInput } from './compiler-data.js';

const RDATA: [number, number] = [0x6cc000, 0x705000];
const DATA: [number, number] = [0x705000, 0x74d000];

function g(name: string, address: string, dataType: string, size: number, extra: Partial<AnalyzedDataSymbol> = {}): AnalyzedDataSymbol {
  return { name, address, dataType, size, isInitialized: true, xrefCount: 1, scope: 'global', ...extra } as AnalyzedDataSymbol;
}
const chars = (text: string, size: number) => ({
  kind: 'array' as const,
  elements: [...Buffer.from(text), ...new Array(size - text.length).fill(0)].map(b => ({ kind: 'scalar' as const, value: String.fromCharCode(b) })),
});
const str = (address: string, value: string): ExtractedString => ({ address, value, length: value.length, encoding: 'string' } as ExtractedString);

function run(globals: AnalyzedDataSymbol[], strings: ExtractedString[] = [], over: Partial<CompilerDataInput> = {}) {
  return classifyCompilerData({
    globals, strings, readOnlySections: [RDATA], writableSections: [DATA],
    namedIdentifiers: new Set(), foreign: new Set(), imageBase: 0x400000, ...over,
  });
}

describe('classifyCompilerData', () => {
  it('a read-only string padded to 4 is a literal, and its label is spelled as one', () => {
    const s = g('s_Unknown_006cc780', '006cc780', 'char[8]', 8, { initializedData: chars('Unknown', 8) });
    const r = run([s]);
    assert.strictEqual(s.compilerOutput, 'string-literal');
    assert.strictEqual(r.literalsByName.get('s_Unknown_006cc780'), '(char*)"Unknown"');
    assert.strictEqual(r.literalsByAddress.get(0x6cc780), '(char*)"Unknown"');
  });

  it('a string in a writable section is a char array of the source, not a literal', () => {
    const s = g('s_Enumeration_Class_0074c044', '0074c044', 'char[24]', 24, { initializedData: chars('Enumeration Class', 24) });
    run([s]);
    assert.strictEqual(s.compilerOutput, undefined);
  });

  it('an object larger than the padded literal is a fixed-size array', () => {
    const s = g('gszKey', '006cc800', 'char[32]', 32, { initializedData: chars('BLIZZ', 32) });
    run([s]);
    assert.strictEqual(s.compilerOutput, undefined);
  });

  it('a string another label points into is reached at an offset, and stays data', () => {
    const s = g('s_ACT1_006cc900', '006cc900', 'char[8]', 8, { initializedData: chars('ACT1.mp', 8) });
    const tail = g('s_mp_006cc905', '006cc905', 'char[3]', 3, { initializedData: chars('mp', 3) });
    const r = run([s, tail]);
    assert.strictEqual(s.compilerOutput, undefined);
    assert.ok(r.rows.some(x => x.name === 's_ACT1_006cc900' && x.cls === 'kept' && /label inside/.test(x.evidence)));
  });

  it('a string inside another datum is a slot of it', () => {
    const table = g('g_SMemUppercaseTable', '006ceb98', 'D2SMemTablesStrc', 0x500, { initializedData: undefined });
    const r = run([table], [str('006ced2c', 'SMemFree()')]);
    assert.strictEqual(r.literalsByName.size, 0);
  });

  it('a string a compiled text names stays data', () => {
    const s = g('s_block_006e1730', '006e1730', 'char[8]', 8, { initializedData: chars('block', 8) });
    run([s], [], { namedIdentifiers: new Set(['s_block_006e1730']) });
    assert.strictEqual(s.compilerOutput, undefined);
  });

  it('the Mac pair overrules: a string Clang kept out of __cstring was a named array', () => {
    const s = g('gszDot', '006cc8a0', 'char[2]', 2, { initializedData: chars('.', 2) });
    run([s], [], { macSections: new Map([[0x6cc8a0, '__data']]) });
    assert.strictEqual(s.compilerOutput, undefined);
  });

  it('an untyped Ghidra string becomes a literal under the label the bodies spell', () => {
    const r = run([], [str('006dc978', 'Font8')]);
    assert.strictEqual(r.literalsByName.get('s_Font8_006dc978'), '(char*)"Font8"');
  });

  it('a read-only double nothing names is a pooled constant; a named one stays', () => {
    const pooled = g('gdConst255', '006d9100', 'double', 8, { value: '255.0' });
    const named = g('gdConst1', '006d9108', 'double', 8, { value: '1.0' });
    run([pooled, named], [], { namedIdentifiers: new Set(['gdConst1']) });
    assert.strictEqual(pooled.compilerOutput, 'float-literal');
    assert.strictEqual(named.compilerOutput, undefined);
  });

  it('the /GS cookie is the CRT\'s, even where the lowered prologues name it', () => {
    const cookie = g('DEFAULT_SECURITY_COOKIE', '00749de0', 'DWORD', 4, { value: '0xbb40e64e' });
    run([cookie], [], { namedIdentifiers: new Set(['DEFAULT_SECURITY_COOKIE']) });
    assert.strictEqual(cookie.compilerOutput, 'gs-cookie');
  });

  it('a variable that only shares the cookie\'s name but not its value is left', () => {
    const notCookie = g('DEFAULT_SECURITY_COOKIE', '00749de0', 'DWORD', 4, { value: '0x12345678' });
    run([notCookie]);
    assert.strictEqual(notCookie.compilerOutput, undefined);
  });

  it('the DOS header at the image base is the linker\'s __ImageBase', () => {
    const header = g('IMAGE_DOS_HEADER__00400000', '00400000', 'IMAGE_DOS_HEADER', 128);
    const r = run([header], [], { namedIdentifiers: new Set(['IMAGE_DOS_HEADER__00400000']) });
    assert.strictEqual(header.compilerOutput, 'image-base');
    assert.strictEqual(r.renames.get('IMAGE_DOS_HEADER__00400000'), '__ImageBase');
  });

  it('a complete-object-locator pointer is RTTI only in the word before a vftable', () => {
    const meta = g('vftable_meta_ptr', '007000f8', 'pointer', 4);
    const vft = g('vftable', '007000fc', 'pointer[4]', 16);
    const lone = g('vftable_meta_ptr', '00700200', 'pointer', 4);
    run([meta, vft, lone]);
    assert.strictEqual(meta.compilerOutput, 'rtti');
    assert.strictEqual(lone.compilerOutput, undefined);
  });
});

describe('parseMacDataPairs', () => {
  it('reads the section by Windows address and drops contradicted pairs', () => {
    const tsv = ['win_addr\tmac_addr\tx\ty\twin_section\tmac_section\tverdict',
      '006cc780\t0\t\t\t.rdata\t__cstring\tcertain',
      '006e7d38\t0\t\t\t.rdata\tTEXT.__const\tCONTRADICTED by bytes'].join('\n');
    const m = parseMacDataPairs(tsv);
    assert.strictEqual(m.get(0x6cc780), '__cstring');
    assert.strictEqual(m.has(0x6e7d38), false);
  });
});
