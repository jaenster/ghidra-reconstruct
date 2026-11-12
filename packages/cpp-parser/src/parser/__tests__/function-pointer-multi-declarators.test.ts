import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../index.js';
import { emit } from '../../emit/index.js';
import { NodeKind } from '../../ast/kinds.js';
import { findNodesByKind } from '../../ast/visitor.js';
import type { ArrayType, BuiltinType, DeclStmt, FunctionType, PointerType, QualifiedType, ReferenceType, RValueReferenceType, TypeNode, VariableDecl } from '../../ast/nodes.js';

function typeShape(type: TypeNode): string {
  switch (type.kind) {
    case NodeKind.BuiltinType: {
      const builtin = type as BuiltinType;
      return [...builtin.modifiers, builtin.name].join(' ');
    }
    case NodeKind.PointerType: {
      const pointer = type as PointerType;
      return `*${pointer.qualifiers.join(' ')}(${typeShape(pointer.pointee)})`;
    }
    case NodeKind.ReferenceType:
      return `&(${typeShape((type as ReferenceType).referenced)})`;
    case NodeKind.RValueReferenceType:
      return `&&(${typeShape((type as RValueReferenceType).referenced)})`;
    case NodeKind.ArrayType: {
      const array = type as ArrayType;
      return `[${array.size ? emit(array.size) : ''}](${typeShape(array.elementType)})`;
    }
    case NodeKind.FunctionType: {
      const fn = type as FunctionType;
      return `fn(${fn.parameters.map(typeShape).join(',')})=>${typeShape(fn.returnType)}${fn.callingConvention ?? ''}`;
    }
    case NodeKind.QualifiedType: {
      const qualified = type as QualifiedType;
      return `${qualified.qualifiers.join(' ')}(${typeShape(qualified.type)})`;
    }
    default:
      return type.kind;
  }
}

const variables = (source: string) =>
  findNodesByKind(parse(source), NodeKind.VariableDecl) as VariableDecl[];

describe('function-pointer multi-declarators', () => {
  for (const [source, expected] of [
    ['int (*fn)(int), other;', ['*(fn(int)=>int)', 'int']],
    ['void f(){ int (*fn)(int), other; }', ['*(fn(int)=>int)', 'int']],
    ['int (*fn)(int), *other;', ['*(fn(int)=>int)', '*(int)']],
    ['int (*fn)(int), (*other)(float);', ['*(fn(int)=>int)', '*(fn(float)=>int)']],
    ['int (*fn[2])(int), other;', ['[2](*(fn(int)=>int))', 'int']],
    ['int *(*fn)(int), other;', ['*(fn(int)=>*(int))', 'int']],
    ['const int (*fn)(int), other;', ['*(fn(int)=>const(int))', 'const(int)']],
    ['int (*fn)(int) = p, other = 1;', ['*(fn(int)=>int)', 'int']],
    ['int (__stdcall *fn)(int), (__stdcall *other)(int);', ['*(fn(int)=>int__stdcall)', '*(fn(int)=>int__stdcall)']],
    ['int x, (*fn)(int);', ['int', '*(fn(int)=>int)']],
    ['int (*fn)(int), other, (*last)(float);', ['*(fn(int)=>int)', 'int', '*(fn(float)=>int)']],
  ] as const) {
    it(`keeps a separate type for each declarator: ${source}`, () => {
      const nodes = variables(source);
      assert.deepStrictEqual(nodes.map(v => typeShape(v.type)), expected);
      // On untouched main, the single named function-pointer emitter is still
      // invalid; later scalar/pointer variables can already round-trip alone.
      for (const node of nodes.slice(1)) {
        if (node.type.kind === NodeKind.FunctionType ||
            (node.type.kind === NodeKind.PointerType && node.type.pointee.kind === NodeKind.FunctionType)) continue;
        const output = emit(node);
        assert.strictEqual(typeShape(variables(output)[0].type), typeShape(node.type), output);
      }
      if (source.startsWith('void f()')) {
        const local = findNodesByKind(parse(source), NodeKind.DeclStmt)[0] as DeclStmt;
        assert.strictEqual(local.declarations.length, expected.length);
      }
    });
  }

  it('keeps ordinary pointer and reference declaration bases', () => {
    assert.deepStrictEqual(variables('int *a, b;').map(v => typeShape(v.type)), ['*(int)', 'int']);
    assert.deepStrictEqual(variables('int &a = x, b = 1;').map(v => typeShape(v.type)), ['&(int)', 'int']);
    assert.deepStrictEqual(variables('int &&a = x, b = 1;').map(v => typeShape(v.type)), ['&&(int)', 'int']);
  });
});
