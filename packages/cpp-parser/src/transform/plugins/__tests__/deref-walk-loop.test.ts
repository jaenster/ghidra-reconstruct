import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { derefWalkLoopPlugin } from '../builtins/deref-walk-loop.js';

const apply = (code: string) => emit(derefWalkLoopPlugin.createTransformer({})(parse(code)) as AnyNode);
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const run = (code: string) => flat(apply(code));

const PRELUDE = `struct Node { int id; Node *pNext; };
Node *gpList;
Node pool[8];
int used;
Node *Alloc() { return &pool[used++]; }`;

// SERR_AddStormFacility, 0041c0f0: CMP dword ptr [gpErrorModuleList], 0 ... CMP dword ptr [ESI], 0.
const facility = (after: string, init = 'gpList') => `void add(int id) {
  Node **ppTail = &gpList;
  Node *pNode = ${init};
  while (pNode) {
    ppTail = &(*ppTail)->pNext;
    pNode = *ppTail;
  }
  ${after}
}`;
const ADD = 'pNode = Alloc(); pNode->id = id; pNode->pNext = 0; *ppTail = pNode;';

describe('derefWalkLoopPlugin', () => {
  it('walks the link itself when the copy is overwritten after the loop', () => {
    const out = run(facility(ADD));
    assert.ok(out.includes('Node* pNode; while (*ppTail) { ppTail = &(*ppTail)->pNext; } pNode = Alloc();'), out);
  });

  it('walks the link when the copy starts as *pp', () => {
    const out = run(`void f(Node **ppHead, Node *pNew) {
  Node **pp = ppHead;
  Node *p;
  p = *pp;
  while (p) {
    pp = &(*pp)->pNext;
    p = *pp;
  }
  *pp = pNew;
}`);
    assert.ok(out.includes('Node* p; while (*pp) { pp = &(*pp)->pNext; } *pp = pNew;'), out);
  });

  it('leaves it when the copy is read after the loop', () => {
    assert.ok(run(facility('*ppTail = pNode;')).includes('while (pNode)'));
  });

  it('leaves it when the copy did not start as the link', () => {
    assert.ok(run(facility(ADD, 'gpList->pNext')).includes('while (pNode)'));
  });

  it('appends at the same place (compiled)', { skip: !hasNativeGpp() }, () => {
    const body = 'for (int i = 0; i < 5; i++) add(i); int s = 0, k = 0; for (Node *n = gpList; n; n = n->pNext) { s = s * 10 + n->id; k++; } std::printf("%d %d\\n", s, k);';
    const before = compileAndRun(`${PRELUDE}\n${facility(ADD)}`, body);
    const rewritten = apply(facility(ADD));
    assert.ok(rewritten.includes('while (*ppTail)'), rewritten);
    assert.strictEqual(compileAndRun(`${PRELUDE}\n${rewritten}`, body), before);
  });
});
