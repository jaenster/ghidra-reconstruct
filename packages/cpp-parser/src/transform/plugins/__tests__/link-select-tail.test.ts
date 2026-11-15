import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { linkSelectTailPlugin } from '../builtins/link-select-tail.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const SEL = ['XOR/ECX', 'TEST/EAX', 'SETLE/CL', 'SUB/ECX', 'AND/EAX', 'POP/EBP', 'RET'];

function run(lines: string[], returns: unknown[]): string {
  const t = linkSelectTailPlugin.createTransformer({
    branchLayout: { lines: new Map(), ifs: new Map(), returns } as never,
  } as never);
  return flat(emit(t(parse(lines.join('\n'))) as AnyNode));
}

const DUP = [
  { start: 10, ret: 30, insns: ['MOV/EAX', 'ADD/EAX', 'MOV/EAX', ...SEL], fallsIn: true, jumpsIn: [] },
  { start: 33, ret: 52, insns: ['LEA/EAX', 'MOV/EAX', ...SEL], fallsIn: false, jumpsIn: [8] },
];

// TSExplicitList<SGAMEDATA>::Next 0052e530.
const SRC = [
  'struct G { char szGameName[16]; };',
  'struct L { int m_linkoffset; TSLink<G> m_terminator; G * Next(G * pNode); };',
  'G * L::Next(G * pNode) {',
  '  if (pNode) {',
  '    return (G*)((int)*(uint32_t*)(pNode->szGameName + this->m_linkoffset - 0x26) <= 0 ? 0 : *(uint32_t*)(pNode->szGameName + this->m_linkoffset - 0x26));',
  '  }',
  '  intptr_t dwNext = this->m_terminator.m_next;',
  '  return (G*)(dwNext <= 0 ? 0 : dwNext);',
  '}',
];

// TSExplicitList<CELLIST>::Next 00602310, the two ways already joined.
const JOIN = [
  'struct C { int a; TSLink<C> m_linktoslot; };',
  'struct L { int m_linkoffset; TSLink<C> m_terminator; C * Next(C * pNode); };',
  'C * L::Next(C * pNode) {',
  '  uint32_t nOffsetOrRef;',
  '  if (pNode) {',
  '    nOffsetOrRef = *(uint32_t*)((intptr_t)&pNode->m_linktoslot.m_prevlink + this->m_linkoffset);',
  '  } else {',
  '    nOffsetOrRef = this->m_terminator.m_next;',
  '  }',
  '  return (C*)(nOffsetOrRef <= 0 ? 0 : nOffsetOrRef);',
  '}',
];

describe('link-select-tail', () => {
  it('writes the joined ways as one link pick', () => {
    const out = run(JOIN, DUP);
    assert.ok(out.includes('{ TSLink<C>* pLink = pNode ? (TSLink<C>*)((char*)((intptr_t)&pNode->m_linktoslot.m_prevlink + this->m_linkoffset) - 4) : &this->m_terminator; intptr_t nOffsetOrRef = pLink->m_next;'), out);
  });

  it('writes the two tail-duplicated returns as one link pick', () => {
    const out = run(SRC, DUP);
    assert.ok(out.includes('TSLink<G>* pLink = pNode ? (TSLink<G>*)((char*)(pNode->szGameName + this->m_linkoffset - 0x26) - 4) : &this->m_terminator;'), out);
    assert.ok(out.includes('intptr_t dwNext = pLink->m_next; return (G*)(dwNext <= 0 ? 0 : dwNext);'), out);
  });

  it('leaves returns whose copies share no select', () => {
    const out = run(SRC, [DUP[0], { ...DUP[1], insns: ['LEA/EAX', 'MOV/EAX', 'POP/EBP', 'RET'] }]);
    assert.ok(out.includes('if (pNode)'), out);
  });
});
