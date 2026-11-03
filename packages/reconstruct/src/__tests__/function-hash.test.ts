/**
 * The function hash covers everything codegen reads from a function record.
 *
 * The hash decides which units an incremental run re-emits. It used to cover the
 * name, signature, parameters and body only, so a check-in that moved nothing but a
 * function's operand references, PUSH slots, SEH frame or call-site overrides left
 * the tree stale. These pin the rule: the whole record, minus a named exclusion list,
 * and every field of the record type classified on purpose.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { FUNCTION_HASH_FIELDS, hashFunction } from '../modules/buildinfo.js';
import type { ExtractedFunction } from '../types.js';

function fn(over: Partial<ExtractedFunction> = {}): ExtractedFunction {
  return {
    name: 'GAME_Start', address: '00401000', namespace: 'Game', returnType: 'int',
    signature: 'int GAME_Start(void)', parameters: [], localVariables: [],
    callingConvention: '__cdecl', size: 16, isThunk: false, isExternal: false, hasVarArgs: false,
    decompiled: 'int GAME_Start(void)\n{\n  return 1;\n}\n',
    ...over,
  } as ExtractedFunction;
}

/** The members of `interface ExtractedFunction` in types.ts, read with the compiler. */
function interfaceFields(): string[] {
  const path = join(import.meta.dirname, '..', 'types.ts');
  const src = ts.createSourceFile(path, readFileSync(path, 'utf-8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  src.forEachChild(node => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'ExtractedFunction') {
      assert.equal(node.heritageClauses, undefined, 'ExtractedFunction extends another type: classify its fields too');
      for (const m of node.members) if (m.name && ts.isIdentifier(m.name)) out.push(m.name.text);
    }
  });
  return out.sort();
}

describe('hashFunction', () => {
  it('classifies every field of ExtractedFunction as hashed or excluded', () => {
    assert.deepStrictEqual(Object.keys(FUNCTION_HASH_FIELDS).sort(), interfaceFields());
  });

  it('moves when only the operand references move', () => {
    const before = fn({ operandRefs: { refs: [{ ins: '00401004', op: 1, to: '00749de0', type: 'READ', encoded: true }], derived: [], scalars: [], functions: [] } });
    const after = fn({ operandRefs: { refs: [{ ins: '00401004', op: 1, to: '00749de4', type: 'READ', encoded: true }], derived: [], scalars: [], functions: [] } });
    assert.notEqual(hashFunction(before), hashFunction(after));
    assert.notEqual(hashFunction(fn()), hashFunction(before), 'gaining references is a change');
  });

  for (const [field, value] of [
    ['pushSlots', [{ offset: -8, reg: 'ECX' }]],
    ['sehFrame', { scopes: [] }],
    ['callSiteOverrides', [{ callAddress: '00401008', funcdef: 'fp_t', arity: 2 }]],
    ['zextSites', { sites: [] }],
    ['comment', 'plate'],
    ['localVariables', [{ name: 'nCount', dataType: 'int', size: 4, storage: 'Stack[-0x8]' }]],
  ] as const) {
    it(`moves when only ${field} moves`, () => {
      assert.notEqual(hashFunction(fn()), hashFunction(fn({ [field]: value } as Partial<ExtractedFunction>)));
    });
  }

  it('does not move for an excluded field', () => {
    assert.equal(hashFunction(fn()), hashFunction(fn({ sourceFile: 'D2Client.cpp', sourceLine: 12 })));
  });

  it('does not depend on key order or on undefined fields', () => {
    const a = fn({ tags: ['x'] as never });
    const b = Object.fromEntries(Object.entries(a).reverse()) as ExtractedFunction;
    assert.equal(hashFunction(a), hashFunction(b));
    assert.equal(hashFunction(fn()), hashFunction(fn({ thunkTarget: undefined })));
  });

  it('hashes a field the classification does not name', () => {
    const extra = { ...fn(), futureFacts: { n: 1 } } as unknown as ExtractedFunction;
    assert.notEqual(hashFunction(fn()), hashFunction(extra));
  });
});
