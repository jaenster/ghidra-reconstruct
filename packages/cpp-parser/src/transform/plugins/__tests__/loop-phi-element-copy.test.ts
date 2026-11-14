import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { loopPhiElementCopyPlugin } from '../builtins/loop-phi-element-copy.js';
import type { AccessOrderEvidence, StoreFact } from '../builtins/access-order-evidence.js';

/**
 * One statement per line. `[phantom]` tags the line's `=` with the fact the extraction records
 * for a copy no instruction makes ({at: null, width: 0}); `[store@N:W]` with a real store at
 * offset N writing W bytes; `[nowidth]` with an older snapshot's row that has no width.
 */
function run(lines: string[], withFacts = true): string {
  const stores = new Map<number, StoreFact[]>();
  const text = lines.map((l, i) => {
    const m = l.match(/^\s*\[(phantom|nowidth|store@(\d+|null):(\d+))\]\s?(.*)$/);
    if (!m) return l;
    let fact: StoreFact;
    if (m[1] === 'phantom') fact = { ord: 0, at: null, size: 1, half: null, width: 0 };
    else if (m[1] === 'nowidth') fact = { ord: 0, at: null, size: 1, half: null };
    else fact = { ord: 0, at: m[2] === 'null' ? null : Number(m[2]), size: 1, half: null, width: Number(m[3]) };
    stores.set(i + 1, [fact]);
    return m[4];
  });
  // An unrelated fact keeps the evidence non-empty for the no-fact cases.
  if (!withFacts) stores.clear();
  stores.set(10_000, [{ ord: 0, at: 0, size: 4, half: null, width: 4 }]);
  const ev: AccessOrderEvidence = { args: new Map(), stores };
  const ast = parse(text.join('\n'));
  return emit(loopPhiElementCopyPlugin.createTransformer({ accessOrder: ev })(ast as AnyNode) as AnyNode).replace(/\s+/g, ' ');
}

// COMCALLBACK_DetectCDKeyInMessage 00449920 (Game.exe v2094), lines 34-43 of the decompile.
const CDKEY = (copy: string, opts: { arrayDecl?: string; params?: string; extra?: string } = {}) => [
  `int f(${opts.params ?? 'char *szChatText'}) {`,
  'byte byChar;',
  'byte *pbScan;',
  'uint nChecksum;',
  opts.arrayDecl ?? 'byte abKeyBuf [20];',
  'pbScan = abKeyBuf;',
  'while (abKeyBuf[0] != 0) {',
  'byChar = *pbScan;',
  'pbScan = pbScan + 1;',
  'if (0x17 < gaBnetCdKeyCharDecodeTable[byChar]) {',
  'return 0;',
  '}',
  ...(opts.extra ? [opts.extra] : []),
  copy,
  '}',
  'COMCALLBACK_RemoveUserFromList((char *)abKeyBuf,&nChecksum);',
  'return 1;',
  '}',
];

describe('loopPhiElementCopyPlugin', () => {
  it('moves the merged copy of the cd-key scan into a local loaded from the element', () => {
    const out = run(CDKEY('[phantom] abKeyBuf[0] = *pbScan;'));
    assert.match(out, /byte byNext;/);
    assert.match(out, /byNext = abKeyBuf\[0\]; while \(byNext != 0\) \{/);
    assert.match(out, /byNext = \*pbScan; \}/);
    assert.doesNotMatch(out, /abKeyBuf\[0\] =/);
    // The array is left as the original left it for the call after the loop.
    assert.match(out, /COMCALLBACK_RemoveUserFromList\(\(char\*\)abKeyBuf, &nChecksum\)/);
  });

  // INI_ParseCommandLineArg 00405710 (Game.exe v2094), lines 92-97: the copy is printed first.
  it('handles the copy printed first in the body, with computed-index reads of the array', () => {
    const out = run([
      'int f(byte *pbArgName, char *pOutValue, byte *pbScan) {',
      'int nCmdLen;',
      'char szArgNameBuf [256];',
      'nCmdLen = 0;',
      "while (szArgNameBuf[0] != '\\0') {",
      '[phantom] szArgNameBuf[0] = szArgNameBuf[nCmdLen + 1];',
      'pOutValue[nCmdLen] = pbArgName[(int)(szArgNameBuf + (nCmdLen - (int)pbScan))];',
      'nCmdLen = nCmdLen + 1;',
      '}',
      "pOutValue[nCmdLen] = '\\0';",
      'return 0;',
      '}',
    ]);
    assert.match(out, /char cNext;/);
    assert.match(out, /cNext = szArgNameBuf\[0\]; while \(cNext != '\\0'\) \{ cNext = szArgNameBuf\[nCmdLen \+ 1\];/);
    assert.doesNotMatch(out, /szArgNameBuf\[0\] =/);
  });

  it('handles the bare condition and picks a name no other symbol uses', () => {
    const out = run([
      'int f(void) {',
      'byte byNext;',
      'byte *p;',
      'byte ab [8];',
      'p = ab;',
      'while (ab[0]) {',
      'p = p + 1;',
      '[phantom] ab[0] = *p;',
      '}',
      'byNext = 0;',
      'return g(ab, byNext);',
      '}',
    ]);
    assert.match(out, /byte byNext2;/);
    assert.match(out, /byNext2 = ab\[0\]; while \(byNext2\) \{ p = p \+ 1; byNext2 = \*p; \}/);
  });

  it('keeps a store an instruction makes', () => {
    const out = run(CDKEY('[store@81:1] abKeyBuf[0] = *pbScan;'));
    assert.match(out, /abKeyBuf\[0\] = \*pbScan;/);
    assert.doesNotMatch(out, /byNext/);
  });

  it('keeps a value an instruction writes to a register (width > 0)', () => {
    const out = run(CDKEY('[store@null:1] abKeyBuf[0] = *pbScan;'));
    assert.match(out, /abKeyBuf\[0\] = \*pbScan;/);
  });

  it('keeps the copy when the row predates the width', () => {
    const out = run(CDKEY('[nowidth] abKeyBuf[0] = *pbScan;'));
    assert.match(out, /abKeyBuf\[0\] = \*pbScan;/);
  });

  it('changes nothing without facts', () => {
    const out = run(CDKEY('abKeyBuf[0] = *pbScan;'), false);
    assert.match(out, /while \(abKeyBuf\[0\] != 0\)/);
    assert.match(out, /abKeyBuf\[0\] = \*pbScan;/);
  });

  it('leaves a global array alone', () => {
    const out = run(CDKEY('[phantom] abKeyBuf[0] = *pbScan;', { arrayDecl: 'uint nUnused;' }));
    assert.match(out, /abKeyBuf\[0\] = \*pbScan;/);
    assert.doesNotMatch(out, /byNext/);
  });

  it('leaves a parameter alone', () => {
    const out = run(CDKEY('[phantom] abKeyBuf[0] = *pbScan;', { arrayDecl: 'uint nUnused;', params: 'byte *abKeyBuf' }));
    assert.match(out, /abKeyBuf\[0\] = \*pbScan;/);
    assert.doesNotMatch(out, /byNext/);
  });

  it('leaves a static local array alone', () => {
    const out = run(CDKEY('[phantom] abKeyBuf[0] = *pbScan;', { arrayDecl: 'static byte abKeyBuf [20];' }));
    assert.match(out, /abKeyBuf\[0\] = \*pbScan;/);
  });

  it('leaves the loop when the body reads the element', () => {
    const out = run(CDKEY('[phantom] abKeyBuf[0] = *pbScan;', { extra: 'g(abKeyBuf[0]);' }));
    assert.match(out, /abKeyBuf\[0\] = \*pbScan;/);
    assert.doesNotMatch(out, /byNext/);
  });

  it('leaves the loop when the body reads the element as *A', () => {
    const out = run(CDKEY('[phantom] abKeyBuf[0] = *pbScan;', { extra: 'g(*abKeyBuf);' }));
    assert.match(out, /abKeyBuf\[0\] = \*pbScan;/);
  });

  it('leaves the loop when the copy value reads the element', () => {
    const out = run(CDKEY('[phantom] abKeyBuf[0] = abKeyBuf[0] + *pbScan;'));
    assert.match(out, /abKeyBuf\[0\] = abKeyBuf\[0\] \+ \*pbScan;/);
  });

  it('leaves the loop when the element is written twice', () => {
    const out = run(CDKEY('[phantom] abKeyBuf[0] = *pbScan;', { extra: 'abKeyBuf[0] = 1;' }));
    assert.match(out, /abKeyBuf\[0\] = \*pbScan;/);
  });

  it('leaves a copy whose value is a call', () => {
    const out = run(CDKEY('[phantom] abKeyBuf[0] = next(pbScan);'));
    assert.match(out, /abKeyBuf\[0\] = next\(pbScan\);/);
  });

  it('leaves a copy of another element than the condition tests', () => {
    const out = run(CDKEY('[phantom] abKeyBuf[1] = *pbScan;'));
    assert.match(out, /abKeyBuf\[1\] = \*pbScan;/);
    assert.match(out, /while \(abKeyBuf\[0\] != 0\)/);
  });
});
