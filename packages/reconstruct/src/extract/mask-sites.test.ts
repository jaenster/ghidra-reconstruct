import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseFunctionFacts, selectFacts } from './function-facts.js';
import { javaStringHash } from './compare-sites.js';
import { parseMaskSiteRow, printsByteWordMask } from './mask-sites.js';

// DRLGPATH_GetDirectionLookupFromPacked 0067bbc0: the two masks are `movzx ecx, cx` and
// `movzx edx, dx` (get_pcode: INT_AND at 0067bbd9 and 0067bbdc).
const TEXT = 'uint32_t f(uint32_t nSrcPacked, uint32_t nDstPacked)\n{\n  return t[((nDstPacked >> 0x10) - (nSrcPacked >> 0x10)) * 3 - (nSrcPacked & 0xffff) + (nDstPacked & 0xffff)];\n}\n';
const row = (text: string) => [
  'P\tGame.exe:1783',
  `F\t0067bbc0\tself\t${javaStringHash(text).toString(16)}\t${text.length}\t1`,
  'M\t0067bbc0\t2;0:ffff:MOVZX:2;1:ffff:MOVZX:2',
  'D\t',
].join('\n');

describe('mask sites', () => {
  it('parses a row', () => {
    assert.deepStrictEqual(parseMaskSiteRow('3;0:ff:AND:0;2:ffff:MOVZX:2'), {
      count: 3, sites: [{ ord: 0, k: 0xff, mnemonic: 'AND', width: 0 }, { ord: 2, k: 0xffff, mnemonic: 'MOVZX', width: 2 }],
    });
  });

  it('rejects a malformed row or a position past the count', () => {
    assert.strictEqual(parseMaskSiteRow('x;0:ff:AND:0'), null);
    assert.strictEqual(parseMaskSiteRow('1;1:ff:AND:0'), null);
    assert.strictEqual(parseMaskSiteRow('1;0:fff:AND:0'), null);
    assert.strictEqual(parseMaskSiteRow('2'), null);
  });

  it('is attached only to the text it was read from', () => {
    assert.ok(printsByteWordMask(TEXT));
    const r = parseFunctionFacts(row(TEXT)).rows.get('0067bbc0')!;
    assert.strictEqual(r.maskRow, '2;0:ffff:MOVZX:2;1:ffff:MOVZX:2');
    assert.deepStrictEqual(selectFacts(TEXT, '0067bbc0', r, true).maskSites?.sites.map(s => s.mnemonic), ['MOVZX', 'MOVZX']);
    assert.strictEqual(selectFacts(TEXT.replace('0x10', '0x11'), '0067bbc0', r, true).maskSites, undefined);
  });
});
