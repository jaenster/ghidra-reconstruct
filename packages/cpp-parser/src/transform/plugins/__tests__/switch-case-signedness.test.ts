import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { switchCaseSignednessPlugin } from '../builtins/switch-case-signedness.js';

describe('switchCaseSignednessPlugin', () => {
  const transformer = switchCaseSignednessPlugin.createTransformer({});
  const transform = (code: string) => emit(transformer(parse(code)) as AnyNode).trim();

  it('signs an unsigned deref control that carries a negative label', () => {
    const out = transform(`
void f(int nMouseX, void* pTable) {
  switch (*(uint32_t*)(nMouseX + (int)pTable)) {
    case 1: a(); break;
    case -1:
    case 0: b(); break;
  }
}`);
    assert.ok(out.includes('(int32_t)'), `control not signed:\n${out}`);
    assert.ok(out.includes('case -1:'), `label rewritten:\n${out}`);
  });

  it('signs a direct unsigned cast control too, at the matching width', () => {
    const out = transform('void f(int x) { switch ((uint16_t)x) { case -1: a(); break; } }');
    assert.ok(out.includes('(int16_t)'), `wrong signed sibling:\n${out}`);
  });

  it('leaves a SIGNED control alone — its negative labels are already legal', () => {
    const out = transform('void f(int x) { switch ((int32_t)x) { case -3: a(); break; } }');
    assert.ok(!out.includes('(int32_t)(int32_t)'), `control double-cast:\n${out}`);
  });

  it('leaves an unsigned control with only non-negative labels alone', () => {
    const out = transform('void f(int x) { switch ((uint32_t)x) { case 0: a(); break; case 7: b(); break; } }');
    assert.ok(!out.includes('(int32_t)'), `cast written with no negative label:\n${out}`);
  });

  it('does not let a NESTED switch’s negative label sign the outer control', () => {
    const out = transform(`
void f(int x, int y) {
  switch ((uint32_t)x) {
    case 1:
      switch ((int32_t)y) { case -1: a(); break; }
      break;
  }
}`);
    assert.ok(!out.includes('(int32_t)(uint32_t)'), `outer control signed by an inner label:\n${out}`);
  });

  it('says nothing about a control whose type is not spelled', () => {
    const out = transform('void f(int x) { switch (x) { case -1: a(); break; } }');
    assert.ok(!/switch \(\(int/.test(out), `guessed at an unspelled control type:\n${out}`);
  });
});
