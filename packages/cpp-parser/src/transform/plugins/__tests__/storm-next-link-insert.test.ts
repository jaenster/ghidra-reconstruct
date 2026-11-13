import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createStormNextLinkTransformer } from '../builtins/storm-next-link.js';

const xf = createStormNextLinkTransformer({
  structFields: {
    StormLinkStrc: { pPrevLink: 'StormLinkStrc*', pNext: 'intptr_t' },
    'TSLink<T>': { m_prevlink: 'TSLink<T>*', m_next: 'intptr_t' },
  },
  structFieldOffsets: {
    StormLinkStrc: { pPrevLink: 0, pNext: 4 },
    'TSLink<T>': { m_prevlink: 0, m_next: 4 },
  },
  aggregateSizes: { StormLinkStrc: 8, 'TSLink<T>': 8 },
});
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const run = (s: string) => norm(emit(xf(parse(s)) as AnyNode));
const plain = (s: string) => norm(emit(parse(s) as AnyNode));

const storm = `void LinkNode(StormLinkStrc* head, StormLinkStrc* slot, int** pOffset, int* node) {
  int* offset; intptr_t next;
  slot->pPrevLink = head;
  slot->pNext = head->pNext;
  offset = *pOffset;
  next = head->pNext;
  if (next < 0) {
    *(StormLinkStrc**)~next = slot;
    head->pNext = (intptr_t)node;
    return;
  }
  if ((intptr_t)offset < 0) {
    offset = (int*)((char*)head - head->pPrevLink->pNext);
  }
  *(StormLinkStrc**)(next + (char*)offset) = slot;
  head->pNext = (intptr_t)node;
  return;
}`;

const templated = `void LinkNode(TSLink<T>* head, TSLink<T>* slot, intptr_t node, int off) {
  intptr_t offset; intptr_t next;
  slot->m_prevlink = head;
  slot->m_next = head->m_next;
  offset = off;
  next = head->m_next;
  if (next < 0) {
    *(TSLink<T>**)~next = slot;
    head->m_next = node;
    return;
  }
  if (offset < 0) offset = (intptr_t)head - head->m_prevlink->m_next;
  *(TSLink<T>**)(next + offset) = slot;
  head->m_next = node;
  return;
}`;

describe('storm-next-link insert side', () => {
  it('reverses the SFile pointer-offset insert pattern', () => {
    const out = run(storm);
    assert.match(out, /\*\(StormLinkStrc\*\*\)D2_StormNextLink\(head, \(intptr_t\)\*pOffset\) = slot;/);
    assert.doesNotMatch(out, /if \(next < 0\)/);
    assert.doesNotMatch(out, /next \+ \(char\*\)offset/);
  });
  it('reverses the template member-offset insert pattern', () => {
    const out = run(templated);
    assert.match(out, /\*\(TSLink<T>\*\*\)D2_StormNextLink\(head, off\) = slot;/);
    assert.doesNotMatch(out, /if \(next < 0\)/);
  });
  it('uses a template method offset even when its member type is not in this fixture', () => {
    const method = templated
      .replace('void LinkNode(', 'void TSExplicitList<T>::LinkNode(')
      .replace('offset = off;', 'offset = this->m_linkoffset;');
    assert.match(run(method), /D2_StormNextLink\(head, this->m_linkoffset\)/);
  });
  it('accepts a 32-bit unsigned offset before its signed local assignment', () => {
    const unsigned = templated.replace('int off)', 'uint32_t off)');
    assert.match(run(unsigned), /D2_StormNextLink\(head, off\)/);
  });
  it('does not confuse a member name with a removed local', () => {
    const member = templated.replace('offset = off;', 'offset = config->offset;')
      .replace('int off)', 'Config* config)');
    assert.match(run(member), /D2_StormNextLink\(head, config->offset\)/);
  });
  it('refuses a different back-link offset and different branch store value', () => {
    const wrongOffset = templated.replace('head->m_prevlink->m_next', 'head->m_prevlink->m_prevlink');
    assert.equal(run(wrongOffset), plain(wrongOffset));
    const wrongValue = templated.replace('*(TSLink<T>**)~next = slot;', '*(TSLink<T>**)~next = head;');
    assert.equal(run(wrongValue), plain(wrongValue));
    const narrowHead = templated.replace('(intptr_t)head - head->m_prevlink->m_next', '(short)head - head->m_prevlink->m_next');
    assert.equal(run(narrowHead), plain(narrowHead));
  });
  it('refuses an extra effect or a changed update', () => {
    const call = templated.replace('if (next < 0)', 'log(); if (next < 0)');
    assert.equal(run(call), plain(call));
    const update = templated.replace('head->m_next = node;\n    return;', 'head->m_next = node + 1;\n    return;');
    assert.equal(run(update), plain(update));
  });
  it('refuses reads of local definitions that the rewrite would remove', () => {
    const oldNext = templated.replace('offset = off;', 'offset = next;');
    assert.equal(run(oldNext), plain(oldNext));
    const value = templated.replace(/= slot;/g, '= (TSLink<T>*)offset;');
    assert.equal(run(value), plain(value));
    const update = templated.replace(/head->m_next = node;/g, 'head->m_next = next;');
    assert.equal(run(update), plain(update));
  });
  it('refuses a sum through a non-byte pointer, which scales the offset', () => {
    // (T**)next + offset adds offset * 4: not NextLink's byte sum.
    const scaled = templated.replace('*(TSLink<T>**)(next + offset) = slot;', '*(TSLink<T>**)((TSLink<T>**)next + offset) = slot;');
    assert.equal(run(scaled), plain(scaled));
    const wordPtr = storm.replace('(next + (char*)offset)', '(next + offset)');
    assert.equal(run(wordPtr), plain(wordPtr));
    const intPtr = storm.replace('(next + (char*)offset)', '(next + (int*)offset)');
    assert.equal(run(intPtr), plain(intPtr));
    const fallback = storm.replace('(char*)head - head->pPrevLink->pNext', '(int*)head - head->pPrevLink->pNext');
    assert.equal(run(fallback), plain(fallback));
  });
  it('accepts the next word as Ghidra types it, unsigned, when its sign test reads it signed', () => {
    const unsigned = storm.replace('intptr_t next;', 'uint32_t next;').replace('if (next < 0)', 'if ((int)next < 0)')
      .replace('(next + (char*)offset)', '(next + (int)offset)').replace('(char*)head - head', '(int)head - head');
    const out = run(unsigned);
    assert.match(out, /\*\(StormLinkStrc\*\*\)D2_StormNextLink\(head, \(intptr_t\)\*pOffset\) = slot;/);
    // Read unsigned, the test is never true: not the shape.
    const unsignedTest = storm.replace('intptr_t next;', 'uint32_t next;');
    assert.equal(run(unsignedTest), plain(unsignedTest));
  });
  it('drops the declarations of the locals it removes, and retypes nothing', () => {
    const out = run(templated);
    assert.doesNotMatch(out, /intptr_t offset;|intptr_t next;|\bint offset;/);
    // Still read elsewhere: the declaration stays.
    const kept = run(templated.replace('slot->m_prevlink = head;', 'g(offset);\n  slot->m_prevlink = head;'));
    assert.match(kept, /D2_StormNextLink\(head, off\)/);
    assert.match(kept, /intptr_t offset;/);
    assert.doesNotMatch(kept, /intptr_t next;/);
  });
  it('refuses narrowing casts in a sign test or negative slot address', () => {
    const sign = templated.replace('if (next < 0)', 'if ((intptr_t)(short)next < 0)');
    assert.equal(run(sign), plain(sign));
    const slot = templated.replace('*(TSLink<T>**)~next = slot;', '*(TSLink<T>**)(short)~next = slot;');
    assert.equal(run(slot), plain(slot));
  });
});
