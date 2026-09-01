import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveAnnotatedType, applyResolvedTypes } from '../extract/functions.js';

describe('resolveAnnotatedType', () => {
  it('takes the decompiler resolution over an undefined placeholder', () => {
    assert.strictEqual(resolveAnnotatedType('undefined4 /* resolvedType: int */'), 'int');
    assert.strictEqual(resolveAnnotatedType('undefined4 /* resolvedType: int * */'), 'int *');
    assert.strictEqual(resolveAnnotatedType('undefined /* resolvedType: char[256] */'), 'char[256]');
    assert.strictEqual(resolveAnnotatedType('undefined1[16] /* resolvedType: byte[16] */'), 'byte[16]');
  });

  it('keeps a curated base and drops the annotation', () => {
    assert.strictEqual(resolveAnnotatedType('D2UnitStrc * /* resolvedType: int */'), 'D2UnitStrc *');
  });

  it('leaves an unannotated spelling exactly as it is', () => {
    assert.strictEqual(resolveAnnotatedType('uint32_t *'), 'uint32_t *');
    assert.strictEqual(resolveAnnotatedType(undefined), undefined);
  });

  it('strips a comment that is not a resolvedType annotation', () => {
    assert.strictEqual(resolveAnnotatedType('int /* whatever */'), 'int');
  });

  it('folds parameters, locals and the return type of every function', () => {
    const fns: any[] = [{
      name: 'f', address: '1', returnType: 'undefined4 /* resolvedType: uint */',
      parameters: [{ name: 'a', dataType: 'undefined4 /* resolvedType: int */', size: 4, ordinal: 0 }],
      localVariables: [{ name: 'v', dataType: 'undefined1 /* resolvedType: char */', size: 1 }],
    }];
    assert.strictEqual(applyResolvedTypes(fns), 3);
    assert.strictEqual(fns[0].returnType, 'uint');
    assert.strictEqual(fns[0].parameters[0].dataType, 'int');
    assert.strictEqual(fns[0].localVariables[0].dataType, 'char');
    assert.strictEqual(applyResolvedTypes(fns), 0); // idempotent
  });
});
