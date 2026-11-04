import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { heldAddressMemberPlugin, type StoreBaseFact } from '../builtins/held-address-member.js';
import type { AccessOrderEvidence, StoreFact } from '../builtins/access-order-evidence.js';

/** One statement per line; `[l EDX]` / `[s EDX+4]` tags the line's `=` with its LEA or store. */
function run(lines: string[]): string {
  const bases = new Map<number, StoreBaseFact[]>();
  const stores = new Map<number, StoreFact[]>();
  const text = lines.map((l, i) => {
    const m = l.match(/^\s*\[([ls]) ([A-Z]{3})(?:\+(\d+))?\]\s?(.*)$/);
    if (!m) return l;
    bases.set(i + 1, [{ ord: 0, kind: m[1] as 's' | 'l', reg: m[2], disp: Number(m[3] ?? 0) }]);
    stores.set(i + 1, [{ ord: 0, at: null, size: 4, half: null }]);
    return m[4];
  });
  const accessOrder: AccessOrderEvidence = { args: new Map(), stores };
  const t = heldAddressMemberPlugin.createTransformer({ storeBases: bases, accessOrder });
  return emit(t(parse(text.join('\n'))) as AnyNode).replace(/\s+/g, ' ');
}

const PRE = 'struct L { L *m_prevlink; int m_next; }; struct T { int m_linkoffset; L m_terminator; };';

describe('heldAddressMemberPlugin with store bases', () => {
  // TSExplicitList<SGAMEDATA>::CopyConstructor_Unreferenced 0044fb80:
  // `lea edx, [eax + 4]; mov [edx], 0; mov [edx + 4], 0`.
  it('writes a store the original addresses off the link register through the local', () => {
    const out = run([
      PRE,
      'void f(T *pThis) {',
      'L *pTVar1;',
      '[l EDX] pTVar1 = &pThis->m_terminator;',
      '[s EDX] pTVar1->m_prevlink = 0;',
      '[s EDX+4] pThis->m_terminator.m_next = 0;',
      '}',
    ]);
    assert.match(out, /pTVar1->m_next = 0;/);
  });

  // TSList::SetLinkOffset_Unreferenced 0044ee30: the final m_next is `mov [ecx + 8], eax`.
  it('leaves a store the original addresses off the record', () => {
    const out = run([
      PRE,
      'void f(T *pThis) {',
      'L *pTVar1;',
      '[l EAX] pTVar1 = &pThis->m_terminator;',
      '[s EAX] pTVar1->m_prevlink = pTVar1;',
      '[s ECX+8] pThis->m_terminator.m_next = ~(int)pTVar1;',
      '}',
    ]);
    assert.match(out, /pThis->m_terminator\.m_next = ~\(int\)pTVar1;/);
  });

  // TSExplicitList<CELLIST>::CopyConstructor 006023b0, the link held as `uint32_t *`.
  it('indexes a link held at an integer pointer by the store displacement', () => {
    const out = run([
      PRE,
      'T *f(T *pThis, T *pSource) {',
      '[l EDX] uint32_t *pLink = (uint32_t *)&pThis->m_terminator;',
      '[s EDX] *pLink = 0;',
      '[s EDX+4] pThis->m_terminator.m_next = 0;',
      '[s EAX+8] pThis->m_terminator.m_next = ~(int)pLink;',
      'return pThis; }',
    ]);
    assert.match(out, /pLink\[1\] = 0;/);
    assert.match(out, /pThis->m_terminator\.m_next = ~\(int\)pLink;/);
  });

  it('takes the link off this', () => {
    const out = run([
      'struct L { L *m_prevlink; int m_next; }; struct T { int m_linkoffset; L m_terminator; T *Copy(T *pSource); };',
      'T *T::Copy(T *pSource) {',
      '[l EDX] uint32_t *pLink = (uint32_t *)&this->m_terminator;',
      '[s EDX] *pLink = 0;',
      '[s EDX+4] this->m_terminator.m_next = 0;',
      'return this; }',
    ]);
    assert.match(out, /pLink\[1\] = 0;/);
  });

  it('leaves the stores when the root is written after the definition', () => {
    const out = run([
      PRE,
      'void f(T *pThis, T *pOther) {',
      'L *pTVar1;',
      '[l EDX] pTVar1 = &pThis->m_terminator;',
      'pThis = pOther;',
      '[s EDX+4] pThis->m_terminator.m_next = 0;',
      '}',
    ]);
    assert.match(out, /pThis->m_terminator\.m_next = 0;/);
  });

  it('changes nothing without the facts', () => {
    const t = heldAddressMemberPlugin.createTransformer({});
    const out = emit(t(parse(`${PRE} void f(T *pThis) { L *p; p = &pThis->m_terminator; p->m_prevlink = 0; pThis->m_terminator.m_next = 0; }`)) as AnyNode);
    assert.match(out, /pThis->m_terminator\.m_next = 0;/);
  });
});
