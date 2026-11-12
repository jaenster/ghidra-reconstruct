/**
 * Golden: the 1.14d decompile (Game.exe v2056) and its compare-site facts in, each comparison
 * in the form its CMP/TEST and Jcc show out. The sites are ones the VC8 oracle's line-level
 * compare fix listed against the tree generated without these rules; the fixture holds the
 * decompile and the `compareSites` rows exactly as the extraction recorded them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { transformGhidraCode } from '@ghidra-mcp/cpp-parser';
import { compareFormSpec } from './compare-form-spec.js';

interface Golden { name: string; decompiled: string; compareSites: string }
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/compare-form-golden.json', import.meta.url), 'utf8')) as Record<string, Golden>;

/** The function as the pass sees it: the plate comment dropped and the name unqualified. */
function source(g: Golden): string {
  const body = g.decompiled.slice(g.decompiled.lastIndexOf('*/', g.decompiled.indexOf(g.name)) + 2).trim();
  return body.replace(/(?:\w+::)+(\w+)\s*\(/, '$1(');
}

function run(addr: string, withFacts = true): string {
  const g = fixtures[addr];
  const spec = compareFormSpec(g);
  assert.ok(spec, `no spec for ${addr}`);
  return transformGhidraCode(source(g), {
    preset: 'full', usePluginRegistry: true, tolerateErrors: false,
    pluginOptions: withFacts
      ? { pluginOptions: { 'compare-form': { sites: spec.sites, decisions: spec.decisions } as never } }
      : undefined,
  }).code.replace(/\s+/g, ' ');
}

describe('Golden: comparisons in their instruction form', () => {
  // `CMP ESI,0x104; JG` for the unsigned `nKeyCode < 0x105` Ghidra prints over a zero-extended
  // word: the step holds in both domains, and the compare stays signed as the JG has it.
  it('CMD_IsBindableKey 00469ae0: nKeyCode < 0x105 under JG is <= 0x104, 0xff < under JGE >= 0x100', () => {
    const out = run('00469ae0');
    assert.match(out, /nKeyCode <= 0x104\)/, out);
    assert.match(out, /nKeyCode >= 0x100\)/, out);
    assert.doesNotMatch(out, /0x105|0xff </, out);
  });

  // `CMP ESI,0xc0000005; JA`: an unsigned step past INT_MAX on a DWORD operand.
  it('CRASH_GetExceptionName 00403ac0: dwExceptionCode < 0xc0000006 under JA is <= 0xc0000005', () => {
    const out = run('00403ac0');
    assert.match(out, /dwExceptionCode <= 0xc0000005\)/, out);
  });

  // `TEST EAX,EAX; JBE` on a pointer: the unsigned zero test, at pointer width.
  it('FILETOOLS_ExtractFilename 00404010: pSep != 0 under JBE is (uintptr_t)pSep > 0', () => {
    const out = run('00404010');
    assert.match(out, /\(uintptr_t\)pSep > 0/, out);
    // The JZ ones stay truth tests.
    assert.match(out, /if \(pLastSep\)|pLastSep != /, out);
  });

  // `CMP ...; JL` on two 3-bit fields Ghidra compares unsigned: each is below the sign bit by
  // its form, so the signed compare the JL makes is the same compare.
  it('WALL2_AddLowerWallTile 004dd350: the two masked fields compare as int32_t', () => {
    const out = run('004dd350');
    assert.match(out, /\(int32_t\)\(\*\(uint(?:32_t)?\s*\*\)\(\(int\)pDVar1->pData \+ 0x14\) >> 0xe & 7\) < \(int32_t\)/, out);
  });

  // `CMP EAX,0x7fffffff; JA` for `uCodepoint < 0x80000000`; the JC/JNC ones keep their form.
  it('UTF16_CalculateUTF8Length 006c7030: uCodepoint < 0x80000000 under JA is <= 0x7fffffff', () => {
    const out = run('006c7030');
    assert.match(out, /uCodepoint <= 0x7fffffff/, out);
    assert.match(out, /uCodepoint < 0x10000/, out);
  });

  it('without the facts every comparison stays as printed', () => {
    assert.match(run('00469ae0', false), /nKeyCode < 0x105/);
    assert.match(run('00403ac0', false), /dwExceptionCode < 0xc0000006/);
    assert.doesNotMatch(run('00404010', false), /uintptr_t\)pSep/);
    assert.doesNotMatch(run('004dd350', false), /int32_t\)\(\*/);
  });
});
