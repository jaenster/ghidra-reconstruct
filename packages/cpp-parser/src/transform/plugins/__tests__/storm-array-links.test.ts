import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createStormNextLinkTransformer, STORM_LINK_SUPPORT_LINES, type StormNextLinkOptions } from '../builtins/storm-next-link.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const resolve = `intptr_t* resolve(intptr_t** link) {
  intptr_t* prev = *link; intptr_t* next;
  next = link[1];
  if ((intptr_t)next < 0) next = (intptr_t*)~(uintptr_t)next;
  else next = (intptr_t*)((intptr_t)next + ((intptr_t)link - prev[1]));
  return next;
}`;
const captured = resolve.replace('intptr_t** link)', 'intptr_t** link, intptr_t** savedOut)')
  .replace('next = link[1];', 'next = link[1]; intptr_t* saved = next;')
  .replace('return next;', '*savedOut = saved; return next;');
const insert = `void insert(intptr_t** head, intptr_t** slot, intptr_t** node, intptr_t* off) {
  intptr_t* offset; intptr_t* next;
  *slot = (intptr_t*)head; slot[1] = head[1];
  offset = off; next = head[1];
  if ((intptr_t)next < 0) { *(intptr_t***)~(uintptr_t)next = slot; head[1] = (intptr_t*)node; return; }
  if ((intptr_t)offset < 0) offset = (intptr_t*)((intptr_t)head - (*head)[1]);
  *(intptr_t***)((intptr_t)next + (intptr_t)offset) = slot;
  head[1] = (intptr_t*)node; return;
}`;
const run = (src: string, options: StormNextLinkOptions = {}) => emit(createStormNextLinkTransformer(options)(parse(src, { recover: false })) as AnyNode);

describe('Storm links stored in word arrays', () => {
  it('resolves a local reused as both the next word and the backlink address', () => {
    const out = run(resolve);
    assert.match(out, /next = \(intptr_t\*\)D2_StormNextLink\(link, -1\)/);
    assert.match(out, /intptr_t\* next;/, 'the replacement still assigns the local');
    assert.doesNotMatch(out, /next = link\[1\]/, 'the adjacent first assignment is dead');
  });
  it('keeps an old-value capture and its reaching definition', () => {
    const out = run(captured);
    assert.match(out, /next = link\[1\];\s*intptr_t\* saved = next;/);
    assert.match(out, /D2_StormNextLink\(link, -1\)/);
    assert.match(out, /\*savedOut = saved;/);
  });
  it('keeps the definition for an escaped/static local or a possible backedge', () => {
    const direct = resolve.replace('prev[1]', '(*link)[1]');
    for (const src of [
      direct.replace('next = link[1];', 'Capture(&next); next = link[1];'),
      direct.replace('intptr_t* next;', 'static intptr_t* next;'),
      direct.replace('next = link[1];', 'while (again) { next = link[1];').replace('return next;', '} return next;'),
    ]) {
      const out = run(src);
      assert.match(out, /D2_StormNextLink/);
      assert.match(out, /next = link\[1\];/);
    }
  });
  it('requires the complete signed-word proof and unambiguous nonvolatile values', () => {
    for (const src of [
      resolve.replace('(intptr_t)next < 0', '(short)next < 0'),
      resolve.replace('prev[1]', 'prev[2]'),
      resolve.replace('next = link[1];', 'next = link[1]; Effect();'),
      resolve.replace('intptr_t* next;', 'intptr_t* volatile next;'),
      resolve.replace('next = link[1];', '{ intptr_t* next; Use(next); } next = link[1];'),
    ]) assert.doesNotMatch(run(src), /D2_StormNextLink/);
    assert.doesNotMatch(run(resolve.replace(/intptr_t\*/g, 'VWord*'), { typedefTargets: { VWord: 'volatile intptr_t' } }), /D2_StormNextLink/);
    const member = `intptr_t f(Link* p) { intptr_t n; n=p->next;
      if(n<0) n=~n; else n=n+((intptr_t)p-p->prev->next); return n; }`;
    const facts = { structFields: { Link: { prev: 'Link*', next: 'intptr_t' } },
      structFieldOffsets: { Link: { prev: 0, next: 4 } }, aggregateSizes: { Link: 8 } };
    assert.match(run(member, facts), /D2_StormNextLink/);
    assert.doesNotMatch(run(member, { ...facts, typedefTargets: { VWord32: 'volatile intptr_t' },
      structFields: { Link: { prev: 'Link*', next: 'VWord32' } } }), /D2_StormNextLink/);
  });
  it('recognizes only the two word-array reads of an insert', () => {
    assert.match(run(insert), /D2_StormNextLink\(head, \(intptr_t\)off\)/);
    assert.doesNotMatch(run(insert), /if \(\(intptr_t\)next < 0\)/);
    for (const src of [
      insert.replace('next = head[1]', 'next = head[2]'),
      insert.replace('(*head)[1]', '(*head)[2]'),
      insert.replace(/intptr_t\*/g, 'short*'),
      insert.replace('next = head[1]', 'next = ReadHead()[1]'),
    ]) assert.doesNotMatch(run(src), /D2_StormNextLink/);
  });
  it('preserves optimized pointer bits, captured values and array writes', { skip: !hasNativeGpp() }, () => {
    const prelude = `${STORM_LINK_SUPPORT_LINES.join('\n')}
      union Arena { intptr_t align; unsigned char bytes[2048]; };
      namespace Before { ${resolve} ${insert} }
      namespace After { ${run(resolve)} ${run(insert)} }
      namespace BeforeSaved { ${captured} }
      namespace AfterSaved { ${run(captured)} }
    `;
    const main = `unsigned checks=0;
      for(unsigned seed=0;seed<4096;++seed) for(int sign=0;sign<2;++sign) for(int alias=0;alias<2;++alias) {
        Arena arena; intptr_t prev[2]={0,0}; intptr_t* link[2];
        intptr_t delta=(seed>>6)*sizeof(intptr_t);
        intptr_t target=(intptr_t)&arena.bytes[512+(seed&63)*sizeof(intptr_t)], next=target-delta;
        link[0]=alias?(intptr_t*)link:prev; link[1]=(intptr_t*)(sign?~target:next); prev[1]=(intptr_t)link-delta;
        intptr_t* expected=(intptr_t*)((alias&&!sign)?(intptr_t)link:target);
        if(Before::resolve(link)!=expected || After::resolve(link)!=expected) return 1;
        ++checks;
        intptr_t* oldA=0; intptr_t* oldB=0;
        if(BeforeSaved::resolve(link,&oldA)!=expected || AfterSaved::resolve(link,&oldB)!=expected || oldA!=link[1] || oldB!=oldA) return 2;
        ++checks;
        for(int fallback=0;fallback<2;++fallback) {
          intptr_t* head[2]; intptr_t* slot[2]; intptr_t previous[2];
          intptr_t** output=alias?head:slot; intptr_t** value=(seed&1)?0:output;
          unsigned char memory[sizeof(arena.bytes)], oldHead[sizeof(head)], oldSlot[sizeof(slot)];
          for(int pass=0;pass<2;++pass) {
            std::memset(&arena,0x5a,sizeof(arena)); std::memset(head,0,sizeof(head)); std::memset(slot,0,sizeof(slot));
            std::memset(previous,0,sizeof(previous));
            previous[1]=(intptr_t)head-delta; head[0]=previous; head[1]=(intptr_t*)(sign?~target:next);
            intptr_t* off=(intptr_t*)(fallback?-1:delta);
            if(pass==0) Before::insert(head,output,value,off); else After::insert(head,output,value,off);
            if(!alias && (head[1]!=(intptr_t*)value || slot[0]!=(intptr_t*)head || slot[1]!=(intptr_t*)(sign?~target:next))) return 3;
            if(!alias && *(intptr_t***)target!=output) return 4;
            if(pass==0) { std::memcpy(memory,arena.bytes,sizeof(memory)); std::memcpy(oldHead,head,sizeof(head)); std::memcpy(oldSlot,slot,sizeof(slot)); }
            else if(std::memcmp(memory,arena.bytes,sizeof(memory)) || std::memcmp(oldHead,head,sizeof(head)) || std::memcmp(oldSlot,slot,sizeof(slot))) return 5;
          }
          ++checks;
        }
      }
      std::printf("checks=%u\\n",checks);
    `;
    assert.equal(compileAndRun(prelude, main, { optimize: true, flags: ['-fno-strict-aliasing'] }), 'checks=65536\n');
  });
});
