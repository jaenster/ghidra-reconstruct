import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtractedDataType, ExtractedFunction, ExtractedStruct } from '../types.js';
import { createNonNullFieldGetterOracle } from './non-null-field-getters.js';

const node: ExtractedStruct = {
  name: 'Node', category: '/', kind: 'STRUCTURE', size: 16,
  fields: [{ name: 'next', dataType: 'Node *', offset: 4, size: 4 }],
};
function getter(body: string, patch: Partial<ExtractedFunction> = {}): ExtractedFunction {
  return {
    name: 'ReadNext', address: '00401000', signature: 'Node * ReadNext(Node *p)',
    returnType: 'Node *', callingConvention: '__cdecl', namespace: 'Test',
    parameters: [{ name: 'p', dataType: 'Node *', size: 4, ordinal: 0 }],
    localVariables: [], decompiled: `Node * __cdecl Test::ReadNext(Node *p) { ${body} }`,
    size: 32, isThunk: false, isExternal: false, hasVarArgs: false, ...patch,
  };
}
const read = (fn: ExtractedFunction, types: ExtractedDataType[] = [node]) =>
  createNonNullFieldGetterOracle(new Map([['Test::ReadNext', fn], ['ReadNext', fn]]), types).read('ReadNext', 1);
const withFields = (fields: ExtractedStruct['fields']): ExtractedStruct => ({ ...node, fields });

describe('non-null pointer-field getter evidence', () => {
  it('reads the callee body and concrete field type, independent of its name', () => {
    const f = getter('return p->next;', { name: 'DifferentName' });
    assert.deepEqual(read(f), { parameterType: 'Node*', returnType: 'Node*', fieldType: 'Node*', member: 'next', offset: 4, functionAddress: '00401000' });
  });
  it('skips only an exact null arm and uninitialised POD declarations', () => {
    assert.ok(read(getter('void *address; int32_t line; if (p == (Node*)0) { line = 99; address = Location(); Fail(address, line); Exit(-1); } return p->next;')));
    assert.ok(read(getter('if (!p) { Fail(); } return p->next;')));
  });
  it('does not evaluate a converting null cast as though it were a null literal', () => {
    assert.equal(read(getter('if (p == (NullProbe)0) { Fail(); } return p->next;')), null);
  });
  it('refuses initializers and extra operations on the non-null path', () => {
    for (const body of ['int n = Observe(); return p->next;', 'Observe(); return p->next;', 'if (!p) { Fail(); } Observe(); return p->next;']) {
      assert.equal(read(getter(body)), null, body);
    }
  });
  it('refuses a potentially constructed object before the guard', () => {
    assert.equal(read(getter('Watcher object; if (!p) { Fail(); } return p->next;')), null);
    const disguised: ExtractedStruct = { name: 'int32_t', category: '/', kind: 'STRUCTURE', size: 4, fields: [] };
    assert.equal(read(getter('int32_t line; if (!p) { Fail(); } return p->next;'), [node, disguised]), null);
  });
  it('refuses class aliases and cycles in prefix-declaration types', () => {
    const alias = { name: 'int32_t', category: '/', kind: 'TYPEDEF', size: 4, underlyingType: 'Watcher' } as ExtractedDataType;
    assert.equal(read(getter('int32_t line; return p->next;'), [node, alias]), null);
    assert.equal(read(getter('int32_t line; return p->next;'), [node, { ...alias, underlyingType: 'int32_t' } as ExtractedDataType]), null);
  });
  it('refuses a volatile receiver or pointer field', () => {
    assert.equal(read(getter('return p->next;', { parameters: [{ name: 'p', dataType: 'volatile Node *', size: 4, ordinal: 0 }] })), null);
    assert.equal(read(getter('return p->next;'), [withFields([{ ...node.fields[0], dataType: 'Node * volatile' }])]), null);
  });
  it('requires an ordinary pointer field rather than a converting value', () => {
    assert.equal(read(getter('return p->next;'), [withFields([{ ...node.fields[0], dataType: 'PointerProxy' }])]), null);
    assert.equal(read(getter('return p->Next();')), null);
  });
  it('requires the exact receiver and has no else-path guess', () => {
    assert.equal(read(getter('Node *other; if (!other) { Fail(); } return p->next;')), null);
    assert.equal(read(getter('if (!p) { Fail(); } else { Observe(); } return p->next;')), null);
  });
  it('refuses shadowed receiver bindings and unmodelled register inputs', () => {
    assert.equal(read(getter('Node *p; return p->next;')), null);
    assert.equal(read(getter('return p->next;', { localVariables: [{ name: 'in_EAX', dataType: 'int', size: 4, storage: 'EAX:4' }] })), null);
  });
  it('requires complete, unambiguous structure facts and an ordinary member', () => {
    const f = getter('return p->next;');
    assert.equal(read(f, []), null);
    assert.equal(read(f, [{ ...node, detailUnavailable: true }]), null);
    assert.equal(read(f, [node, { ...node, category: '/other' }]), null);
    assert.equal(read(f, [withFields([node.fields[0], node.fields[0]])]), null);
    assert.equal(read(f, [withFields([{ ...node.fields[0], bitOffset: 0, bitSize: 1 }])]), null);
  });
  it('does not infer a contract from imports, thunks, varargs or unknown conventions', () => {
    for (const patch of [{ isExternal: true }, { isThunk: true }, { hasVarArgs: true }, { callingConvention: 'unknown' }, { parentClass: 'Node' }]) {
      assert.equal(read(getter('return p->next;', patch)), null);
    }
  });
  it('normalizes field storage suffixes but still requires a parseable prototype', () => {
    const f = getter('return p->next;', { returnType: 'Node *32', parameters: [{ name: 'p', dataType: 'Node *32', size: 4, ordinal: 0 }] });
    assert.equal(read(f, [node]), null, 'the normal pipeline does not parse this prototype');
    assert.ok(read(getter('return p->next;'), [withFields([{ ...node.fields[0], dataType: 'Node *32' }])]));
    assert.equal(read(getter('return p->next;', { returnType: 'NodeAlias' })), null);
  });
  it('answers unknown for an absent spelling or an argument-count mismatch', () => {
    const oracle = createNonNullFieldGetterOracle(new Map([['Test::ReadNext', getter('return p->next;')]]), [node]);
    assert.equal(oracle.read('ReadNext', 1), null);
    assert.equal(oracle.read('Test::ReadNext', 2), null);
    assert.ok(oracle.read('Test::ReadNext', 1));
  });
});
