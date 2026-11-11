/**
 * Golden loop tests: 1.14d Ghidra output of loops whose condition Ghidra prints as a comma
 * (`while (t = c, t != 0)`, `while (n = n + -1, -1 < n)`), through the whole pipeline. comma-expand
 * keeps such a condition as one (`while (t = c)`), so the passes after it see that form.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { transformGhidraCode } from '../ghidra.js';

const run = (input: string) =>
  transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false }).code;
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('Golden loops: the copied test of x & x - 1', () => {
  // 1.14d 0051d2f0. Original: while (dwSize & dwSize - 1) dwSize &= dwSize - 1;
  const input = `uint __fastcall BNNEWS_RoundToPowerOfTwo(D2BnNewsTableStrc *pNewsTable,uint dwSize)
{
  uint uHighBit;
  uint uStripped;
  
  if (dwSize < 8) {
    uStripped = dwSize - 1 & dwSize;
    while (uHighBit = uStripped, uHighBit != 0) {
      dwSize = uHighBit;
      uStripped = uHighBit - 1 & uHighBit;
    }
    if (dwSize == 0) {
      return 1;
    }
  }
  else {
    pNewsTable->nGrowStep = 8;
    dwSize = 8;
  }
  return dwSize;
}`;

  it('tests and clears the low bit on the value itself', () => {
    const out = flat(run(input));
    assert.ok(out.includes('if (dwSize < 8) { while (dwSize & dwSize - 1) { dwSize &= dwSize - 1; }'), out);
    assert.ok(!/uHighBit|uStripped/.test(out), out);
  });
});

describe('Golden loops: the walk to the chain tail', () => {
  // 1.14d 00479a00. Original: while (pChainTail->pNext) pChainTail = pChainTail->pNext;
  const input = `void ROSTER_FlattenPartyListsIntoSingleRosterChain(void)
{
  D2RosterStrc *pChainTail;
  D2RosterPartyListStrc *pPartyList;
  D2RosterStrc *pWalkCurrent;
  D2RosterStrc *pWalkNext;
  
  pChainTail = (D2RosterStrc *)0x0;
  for (pPartyList = pRosterPartyList;
      pPartyList != (D2RosterPartyListStrc *)0x0; pPartyList = pPartyList->pNext) {
    if (pChainTail == (D2RosterStrc *)0x0) {
      pChainTail = pPartyList->pOwner;
      gpRosterPlayers = pChainTail;
    }
    else {
      pChainTail->pNext = pPartyList->pOwner;
    }
    pPartyList->pOwner = (D2RosterStrc *)0x0;
    if (pChainTail != (D2RosterStrc *)0x0) {
      pWalkNext = pChainTail->pNext;
      while (pWalkCurrent = pWalkNext, pWalkCurrent != (D2RosterStrc *)0x0) {
        pChainTail = pWalkCurrent;
        pWalkNext = pWalkCurrent->pNext;
      }
    }
  }
  return;
}`;

  it('tests the link in memory, not two copies of it', () => {
    const out = flat(run(input));
    assert.ok(out.includes('if (pChainTail) { while (pChainTail->pNext) { pChainTail = pChainTail->pNext; } }'), out);
    assert.ok(!/pWalkCurrent|pWalkNext/.test(out), out);
  });
});

describe('Golden loops: a count-down step in the condition', () => {
  // 1.14d 00403040. The condition tests the count after the step: -1 < --nBufferSize.
  const input = `void CONTAINER_InitializeBuffer(void *pBuffer,int32_t nTypeSize,int32_t nBufferSize, CONTAINER_TypeInitialValue *fpInitValueCallback)
{
  while (nBufferSize = nBufferSize + -1, -1 < nBufferSize) {
    (*fpInitValueCallback)(pBuffer);
    pBuffer = (void *)((int)pBuffer + nTypeSize);
  }
  return;
}`;

  it('tests the new value (prefix), never the old one', () => {
    const out = flat(run(input));
    assert.ok(out.includes('while (-1 < --nBufferSize) {'), out);
    assert.ok(!out.includes('nBufferSize--'), out);
  });
});
