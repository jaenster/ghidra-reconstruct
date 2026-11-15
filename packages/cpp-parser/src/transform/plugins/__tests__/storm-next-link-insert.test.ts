import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createStormNextLinkTransformer, STORM_LINK_SUPPORT_LINES, type StormNextLinkOptions } from '../builtins/storm-next-link.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

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

const typedFacts: StormNextLinkOptions = {
  structFields: {
    Entry: { link: 'Link' }, Link: { prev: 'Link*', next: 'intptr_t' },
    Node: { prev: 'Node*', next: 'Node*', szName: 'char[16]' },
  },
  structFieldOffsets: { Entry: { link: 0 }, Link: { prev: 0, next: 4 }, Node: { prev: 0, next: 4, szName: 16 } },
  aggregateSizes: { Entry: 12, Link: 8, Node: 64 },
};
const nested = `void f(Entry* head, Entry* slot, intptr_t node, intptr_t off) {
  intptr_t offset; intptr_t next;
  slot->link.prev = &head->link; slot->link.next = head->link.next;
  offset = off; next = head->link.next;
  if (next < 0) { *(Link**)~next = &slot->link; head->link.next = node; return; }
  if (offset < 0) offset = (intptr_t)head - head->link.prev->next;
  *(Link**)(next + offset) = &slot->link;
  head->link.next = node; return;
}`;
const pointer = `void f(Node* head, Node* slot, Node* node, intptr_t off) {
  intptr_t offset; Node* next;
  slot->prev = head; slot->next = head->next;
  offset = off; next = head->next;
  if ((intptr_t)next < 0) { *(Node**)~(uintptr_t)next = slot; head->next = node; return; }
  if (offset < 0) offset = (intptr_t)head - (intptr_t)head->prev->next;
  *(Node**)(next->szName + offset - 16) = slot;
  head->next = node; return;
}`;
const typed = (s: string, facts = typedFacts) => emit(createStormNextLinkTransformer(facts)(parse(s, { recover: false })) as AnyNode);
describe('typed Storm insert addresses', () => {
  it('uses the address of an embedded link and only equates a containing pointer at offset zero', () => {
    assert.match(typed(nested), /D2_StormNextLink\(&head->link, off\)/);
    const shifted = { ...typedFacts, structFieldOffsets: { ...typedFacts.structFieldOffsets, Entry: { link: 4 } } };
    assert.doesNotMatch(typed(nested, shifted), /D2_StormNextLink/);
    assert.match(typed(nested.replace('(intptr_t)head -', '(intptr_t)&head->link -'), shifted), /D2_StormNextLink\(&head->link, off\)/);
  });
  it('accepts a signed pointer-word test and cancels a proven inline byte-array offset', () => {
    assert.match(typed(pointer), /\*\(Node\*\*\)D2_StormNextLink\(head, off\) = slot;/);
    assert.doesNotMatch(typed(pointer), /intptr_t offset;|Node\* next;/);
    assert.match(typed(pointer.replace('offset - 16', 'offset + -16')), /D2_StormNextLink/);
  });
  it('requires byte-array storage, known bounds, exact cancellation and unscaled arithmetic', () => {
    for (const fields of [
      { ...typedFacts.structFields!.Node, szName: 'char*' },
      { ...typedFacts.structFields!.Node, szName: 'int[16]' },
    ]) assert.doesNotMatch(typed(pointer, { ...typedFacts, structFields: { ...typedFacts.structFields, Node: fields } }), /D2_StormNextLink/);
    for (const facts of [
      { ...typedFacts, aggregateSizes: {} },
      { ...typedFacts, aggregateSizes: { ...typedFacts.aggregateSizes, Node: 20 } },
      { ...typedFacts, structFieldOffsets: { ...typedFacts.structFieldOffsets, Node: { prev: 0, next: 4, szName: 12 } } },
    ]) assert.doesNotMatch(typed(pointer, facts), /D2_StormNextLink/);
    for (const src of [
      pointer.replace('offset - 16', 'offset - 15'),
      pointer.replace('next->szName + offset - 16', '(int*)next + offset'),
      pointer.replace('(intptr_t)next < 0', '(uintptr_t)next < 0'),
      pointer.replace('~(uintptr_t)next', '~(unsigned short)next'),
      pointer.replace('(intptr_t)head->prev->next', '(short)head->prev->next'),
    ]) assert.doesNotMatch(typed(src), /D2_StormNextLink/);
  });
  it('refuses volatile loads through qualifiers/typedefs and ambiguous local bindings', () => {
    for (const next of ['volatile Node*', 'V32']) {
      const facts = { ...typedFacts, typedefTargets: { V32: 'volatile Node*' },
        structFields: { ...typedFacts.structFields, Node: { ...typedFacts.structFields!.Node, next } } };
      assert.doesNotMatch(typed(pointer, facts), /D2_StormNextLink/);
    }
    assert.doesNotMatch(typed(pointer.replace('Node* next;', 'Node* volatile next;')), /D2_StormNextLink/);
    assert.doesNotMatch(typed(pointer.replace('offset = off;', '{ Node* next; Use(next); } offset = off;')), /D2_StormNextLink/);
  });
  it('preserves optimized writes for embedded links, pointer tags and offset signs', { skip: !hasNativeGpp() }, () => {
    const types = `
      struct Link { Link* prev; intptr_t next; };
      struct Entry { Link link; int value; };
      struct Node { Node* prev; Node* next;
      #if INTPTR_MAX == INT32_MAX
        char padding[8];
      #endif
        char szName[16]; char payload[32];
      };
      ${STORM_LINK_SUPPORT_LINES.join('\n')}
      union Arena { intptr_t align; unsigned char bytes[2048]; };
    `;
    const before = `namespace BeforeNested { ${nested} } namespace BeforePointer { ${pointer} }`;
    const after = `namespace AfterNested { ${typed(nested)} } namespace AfterPointer { ${typed(pointer)} }`;
    const main = `unsigned checks=0;
      for(unsigned seed=0;seed<4096;++seed) for(int sign=0;sign<2;++sign) for(int fallback=0;fallback<2;++fallback) for(int alias=0;alias<2;++alias) {
        Arena arena; Entry head, slot; Link prev; Node nh, ns, np;
        unsigned char expected[sizeof(arena.bytes)], oldHead[sizeof(head)], oldSlot[sizeof(slot)], oldNh[sizeof(nh)], oldNs[sizeof(ns)];
        intptr_t delta=(seed>>6)*sizeof(intptr_t), off=fallback?-1:delta;
        intptr_t target=(intptr_t)&arena.bytes[512+(seed&63)*sizeof(intptr_t)], next=target-delta;
        Entry* output=alias?&head:&slot; intptr_t value=(seed&1)?0:(intptr_t)output;
        for(int pass=0;pass<2;++pass) {
          std::memset(&arena,0x5a,sizeof(arena)); std::memset(&head,0,sizeof(head)); std::memset(&slot,0,sizeof(slot));
          std::memset(&prev,0,sizeof(prev));
          prev.next=(intptr_t)&head.link-delta; head.link.prev=&prev; head.link.next=sign?~target:next;
          if(pass==0) BeforeNested::f(&head,output,value,off); else AfterNested::f(&head,output,value,off);
          if(!alias && (head.link.next!=value || slot.link.prev!=&head.link || slot.link.next!=(sign?~target:next))) return 1;
          if(!alias && *(Link**)target!=&slot.link) return 2;
          if(pass==0) std::memcpy(expected,arena.bytes,sizeof(expected)); else if(std::memcmp(expected,arena.bytes,sizeof(expected))) return 3;
          if(pass==0) { std::memcpy(oldHead,&head,sizeof(head)); std::memcpy(oldSlot,&slot,sizeof(slot)); }
          else if(std::memcmp(oldHead,&head,sizeof(head)) || std::memcmp(oldSlot,&slot,sizeof(slot))) return 7;
        }
        ++checks;
        Node* nout=alias?&nh:&ns; Node* nvalue=(seed&1)?0:nout;
        for(int pass=0;pass<2;++pass) {
          std::memset(&arena,0x5a,sizeof(arena)); std::memset(&nh,0,sizeof(nh)); std::memset(&ns,0,sizeof(ns));
          std::memset(&np,0,sizeof(np));
          np.next=(Node*)((intptr_t)&nh-delta); nh.prev=&np; nh.next=(Node*)(sign?~target:next);
          if(pass==0) BeforePointer::f(&nh,nout,nvalue,off); else AfterPointer::f(&nh,nout,nvalue,off);
          if(!alias && (nh.next!=nvalue || ns.prev!=&nh || ns.next!=(Node*)(sign?~target:next))) return 4;
          if(!alias && *(Node**)target!=&ns) return 5;
          if(pass==0) std::memcpy(expected,arena.bytes,sizeof(expected)); else if(std::memcmp(expected,arena.bytes,sizeof(expected))) return 6;
          if(pass==0) { std::memcpy(oldNh,&nh,sizeof(nh)); std::memcpy(oldNs,&ns,sizeof(ns)); }
          else if(std::memcmp(oldNh,&nh,sizeof(nh)) || std::memcmp(oldNs,&ns,sizeof(ns))) return 8;
        }
        ++checks;
      }
      std::printf("checks=%u\\n",checks);
    `;
    // The shared helper reinterprets a recovered two-word link layout, as MSVC
    // does. Disable type-based alias assumptions for that same target contract.
    assert.equal(compileAndRun(types + before + after, main, { optimize: true, flags: ['-fno-strict-aliasing'] }), 'checks=65536\n');
  });
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
