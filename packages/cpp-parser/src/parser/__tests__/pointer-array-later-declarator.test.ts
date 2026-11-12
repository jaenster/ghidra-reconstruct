import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../index.js';
import { emit } from '../../emit/index.js';
import { NodeKind } from '../../ast/kinds.js';
import { findNodesByKind } from '../../ast/visitor.js';
import type { ArrayType, BuiltinType, FunctionType, PointerType, QualifiedType, TypeNode, VariableDecl } from '../../ast/nodes.js';

function typeShape(type: TypeNode): string {
  switch (type.kind) {
    case NodeKind.BuiltinType: {
      const builtin = type as BuiltinType;
      return [...builtin.modifiers, builtin.name].join(' ');
    }
    case NodeKind.PointerType:
      return `*(${typeShape((type as PointerType).pointee)})`;
    case NodeKind.FunctionType: {
      const fn = type as FunctionType;
      return `fn(${fn.parameters.map(typeShape).join(',')})=>${typeShape(fn.returnType)}`;
    }
    case NodeKind.ArrayType: {
      const array = type as ArrayType;
      return `[${array.size ? emit(array.size) : ''}](${typeShape(array.elementType)})`;
    }
    case NodeKind.QualifiedType: {
      const qualified = type as QualifiedType;
      return `${qualified.qualifiers.join(' ')}(${typeShape(qualified.type)})`;
    }
    default:
      return type.kind;
  }
}

function variables(source: string): VariableDecl[] {
  return findNodesByKind(parse(source), NodeKind.VariableDecl) as VariableDecl[];
}

describe('later pointer-to-array declarators', () => {
  for (const [source, expected] of [
    ['int (*fn)(int), (*other)[3];', ['*([3](int))']],
    ['void f(){ int (*fn)(int), (*other)[3]; }', ['*([3](int))']],
    ['int first, (*other)[3];', ['*([3](int))']],
    ['int *first, (*other)[3];', ['*([3](int))']],
    ['int (*fn)(int), (*other)[3] = p, *last;', ['*([3](int))', '*(int)']],
    ['int first, (*other)[3], (*fn)(float);', ['*([3](int))', '*(fn(float)=>int)']],
    ['const int (*fn)(int), (*other)[3];', ['*([3](const(int)))']],
  ] as const) {
    it(`preserves the later array pointer type: ${source}`, () => {
      const parsed = variables(source);
      assert.deepStrictEqual(parsed.slice(1).map(v => typeShape(v.type)), expected);
      assert.strictEqual(parsed[1].name.name, 'other');
    });
  }

  it('keeps existing first pointer-to-array and later function-pointer paths', () => {
    assert.strictEqual(typeShape(variables('int (*first)[3];')[0].type), '*([3](int))');
    assert.strictEqual(variables('int (*fn)(int), (*other)(float);')[1].type.kind, NodeKind.PointerType);
  });
});
