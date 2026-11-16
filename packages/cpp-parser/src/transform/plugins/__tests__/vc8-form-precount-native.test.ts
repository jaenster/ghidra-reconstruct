import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form } from '../builtins/vc8-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

it('preserves counts and getter call order for all eight-bucket short-chain combinations', { skip: !hasNativeGpp() }, () => {
  const input = `int Count(Node **buckets) {
    Node *cursor; int count = 0; int index = 0;
    do {
      if (buckets[index]) {
        for (cursor = ReadNext(buckets[index]); count++, cursor != 0; cursor = ReadNext(cursor)) {}
      }
      index++;
    } while (index < 8);
    return count;
  }`;
  const ast = parse(input) as TranslationUnit;
  let applied = false;
  const candidate = emit(applyVc8Forms(ast, [{ form: parseVc8Form('precount(count,cursor)')! }], s => { applied = s.applied; }, {
    nonNullFieldRead: (name, argc) => name === 'ReadNext' && argc === 1 ? {
      parameterType: 'Node*', returnType: 'Node*', fieldType: 'Node*', member: 'next', offset: 0, functionAddress: '00401000',
    } : null,
  }) as AnyNode);
  assert.ok(applied);
  // The logging wrapper observes calls in this fixture. The production proof is
  // separately tested against an uninstrumented ordinary getter body.
  const prelude = `#include <cstdlib>
    struct Node { Node *next; };
    Node *trace[128]; unsigned used;
    Node *ReadNext(Node *p) { if(!p || used==128)std::abort(); trace[used++]=p; return p->next; }
    namespace Before { ${emit(ast as AnyNode)} }
    namespace After { ${candidate} }
  `;
  const body = `
    Node nodes[16]; for(unsigned i=0;i<16;++i)nodes[i].next=i==15?nullptr:&nodes[i+1];
    Node *buckets[8],*expectedTrace[128]; unsigned checks=0;
    for(unsigned bits=0;bits<65536;++bits){
      int expected=0;
      for(unsigned i=0;i<8;++i){unsigned len=(bits>>(2*i))&3; expected+=len; buckets[i]=len?&nodes[16-len]:nullptr;}
      used=0;int before=Before::Count(buckets);unsigned beforeUsed=used;
      std::memcpy(expectedTrace,trace,used*sizeof(Node*)); used=0;
      int after=After::Count(buckets);
      if(before!=expected || after!=expected || beforeUsed!=used || std::memcmp(expectedTrace,trace,used*sizeof(Node*)))return 1;
      ++checks;
    }
    std::printf("checks=%u\\n",checks);
  `;
  assert.equal(compileAndRun(prelude, body, { optimize: true }), 'checks=65536\n');
});
