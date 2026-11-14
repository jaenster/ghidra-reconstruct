/** Type proof for spelling a truth test differently without selecting C++ overloads. */
import { NodeKind as K } from '../../../ast/kinds.js';
import type { ASTNode, AnyNode, BinaryExpr, Expression, FunctionDecl, TypeNode, VariableDecl } from '../../../ast/nodes.js';
import { findNodesByKind, getChildren } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { calleeName, shapeOfNode, shapeOfSpelling, type TypeShape } from './call-arg-cast.js';
import { collectLocalStructs, createExprShape, thisClassOf } from './expr-shape.js';
import type { SelectArgumentOptions } from './select-argument.js';

const arithmetic = new Set(['bool', 'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int',
  'long', 'unsigned long', 'long long', 'unsigned long long', 'float', 'double', 'long double', 'wchar_t', 'char8_t', 'char16_t', 'char32_t']);
const scalarShape = (s: TypeShape | null): boolean => !!s && (s.stars > 0 || arithmetic.has(s.base));
const valueType = (t: TypeNode): TypeNode => {
  if (t.kind === K.ReferenceType || t.kind === K.RValueReferenceType) return valueType(t.referenced);
  if (t.kind === K.QualifiedType) return { ...t, type: valueType(t.type) };
  return t;
};
const valueSpelling = (s: string): string => s.replace(/\s*&&?\s*$/, '');
const valueTable = (t?: Record<string, string>) => Object.fromEntries(Object.entries(t ?? {}).map(([k, v]) => [k, valueSpelling(v)]));

export function builtinTruthSite(fn: FunctionDecl, parent: ASTNode, expression: Expression, tables: SelectArgumentOptions & { enumValues?: Record<string, number> } = {}): boolean {
  if (!fn.body) return false;
  // The outer function's type environment cannot type a nested function's slots.
  const contains = (n: ASTNode): boolean => n === parent || (n.kind !== K.FunctionDecl && n.kind !== K.LambdaExpr && getChildren(n).some(contains));
  if (!contains(fn.body)) return false;
  const resolve = (name: string) => tables.typedefTargets?.[name];
  const variables: VariableDecl[] = [];
  const scopeVariables = (n: ASTNode) => {
    if ([K.FunctionDecl, K.LambdaExpr, K.StructDecl, K.UnionDecl, K.EnumDecl].includes(n.kind)) return;
    if (n.kind === K.VariableDecl) variables.push(n as VariableDecl);
    for (const child of getChildren(n)) scopeVariables(child);
  };
  scopeVariables(fn.body);
  const locals = new Map<string, TypeNode>();
  const counts = new Map<string, number>();
  for (const p of fn.parameters) if (p.name) { locals.set(p.name.name, valueType(p.type)); counts.set(p.name.name, (counts.get(p.name.name) ?? 0) + 1); }
  for (const v of variables) {
    if (!locals.has(v.name.name)) locals.set(v.name.name, valueType(v.type));
    counts.set(v.name.name, (counts.get(v.name.name) ?? 0) + 1);
  }
  const localTypes = [K.StructDecl, K.UnionDecl, K.EnumDecl, K.TypedefDecl, K.TypeAliasDecl].flatMap(k => findNodesByKind(fn.body!, k));
  // A local class/alias can hide a platform typedef such as BOOL or int32_t.
  for (const d of localTypes) {
    const name = (d as unknown as { name?: ASTNode }).name;
    if (name && scalarShape(shapeOfSpelling(emit(name as AnyNode), resolve))) return false;
  }
  const localStructs = collectLocalStructs(fn.body);
  for (const fields of localStructs.values()) for (const [name, type] of fields) fields.set(name, valueType(type));
  const globalTypes = valueTable(tables.globalTypes), enclosingVarTypes = valueTable(tables.enclosingVarTypes);
  const shapeOf = createExprShape(locals, { ...tables, globalTypes, enclosingVarTypes, fieldTypes: valueTable(tables.fieldTypes),
    structFields: Object.fromEntries(Object.entries(tables.structFields ?? {}).map(([k, v]) => [k, valueTable(v)])),
    returnTypes: valueTable(tables.functionReturnTypes), resolve, localStructs, thisClass: thisClassOf(fn, resolve) });
  const scalarType = (type: TypeNode): boolean => {
    const t = valueType(type);
    // Both object and function pointers are scalar, including a parsed declarator
    // the object-type inference deliberately does not reduce to a TypeShape.
    if (t.kind === K.PointerType || t.kind === K.ArrayType) return true;
    if (t.kind === K.QualifiedType) return scalarType(t.type);
    return scalarShape(shapeOfNode(t, 0, resolve));
  };
  // Keep the deployed guard's enum proof, including qualified constants whose
  // bare name is ambiguous across enums and absent from enumValues.
  const enumConstant = (e: Expression): boolean => {
    const name = calleeName(e);
    if (!name || locals.has(name) || globalTypes[name] || enclosingVarTypes[name]) return false;
    const values = tables.enumValues;
    if (values && (Number.isSafeInteger(values[name]) || Number.isSafeInteger(values[name.replace(/^.*::/, '')]))) return true;
    const ns = /(?:^|::)([A-Za-z_]\w*)_ns::[A-Za-z_]\w*$/.exec(name);
    return !!ns && !!resolve(ns[1]) && scalarShape(shapeOfSpelling(ns[1], resolve));
  };
  const unwrap = (e: Expression): Expression => { while (e.kind === K.ParenExpr) e = e.expression; return e; };
  const ambiguous = (n: ASTNode): boolean => {
    if (n.kind === K.Identifier) return (counts.get((n as Expression & { name: string }).name) ?? 0) > 1;
    if (n.kind === K.QualifiedId) return false;
    if (n.kind === K.MemberExpr) return ambiguous((n as Expression & { object: Expression }).object);
    return getChildren(n).some(ambiguous);
  };
  const scalar = (expression: Expression): boolean => {
    const e = unwrap(expression);
    switch (e.kind) {
      case K.IntegerLiteral: case K.FloatingLiteral: case K.BoolLiteral: case K.CharLiteral:
      case K.StringLiteral: case K.NullptrLiteral: case K.SizeofExpr: case K.AlignofExpr:
        return true;
      case K.Identifier: {
        if (ambiguous(e)) return false;
        const t = locals.get(e.name);
        return t ? scalarType(t) : scalarShape(shapeOf(e)) || enumConstant(e);
      }
      case K.BinaryExpr:
        // Primitive operands prove these builtin operators and their scalar
        // results. Other operators (e.g. C++20 <=>) need a separate result proof.
        return ['+', '-', '*', '/', '%', '<<', '>>', '&', '|', '^', '<', '<=', '>', '>=', '==', '!=', '&&', '||', ','].includes(e.operator)
          && scalar(e.left) && scalar(e.right);
      case K.AssignExpr:
        // Plain assignment to a primitive lhs is builtin. A compound assignment
        // may be a free overload when its rhs is a class.
        return scalar(e.left) && (e.operator === '=' || scalar(e.right));
      case K.ConditionalExpr:
        // The condition may itself convert a class to bool; that existing
        // conversion stays inside E. Primitive arms prove E's resulting type.
        return scalar(e.thenExpr) && scalar(e.elseExpr);
      case K.UnaryExpr:
        if (!scalar(e.operand)) return false;
        if (e.operator === '*') return scalarShape(shapeOf(e));
        return ['!', '~', '+', '-', '++', '--', '&'].includes(e.operator);
      case K.PostfixExpr:
        return scalar(e.operand);
      case K.CStyleCastExpr: case K.StaticCastExpr: case K.ConstCastExpr: case K.ReinterpretCastExpr: case K.DynamicCastExpr: case K.FunctionalCastExpr:
        // Any conversion of a class is already inside this explicit scalar cast.
        return scalarType(e.type);
      case K.CallExpr: {
        if (ambiguous(e.callee)) return false;
        const name = calleeName(e.callee);
        if (!name) return false;
        const local = locals.get(name);
        if (local) {
          let t = valueType(local);
          while (t.kind === K.QualifiedType) t = t.type;
          if (t.kind === K.PointerType) t = t.pointee;
          return t.kind === K.FunctionType && scalarType(t.returnType);
        }
        if (globalTypes[name] || enclosingVarTypes[name]) return false;
        return scalarShape(shapeOf(e));
      }
      case K.SubscriptExpr:
        return !ambiguous(e.array) && scalar(e.array) && !!shapeOf(e.array)?.stars && scalarShape(shapeOf(e));
      case K.QualifiedId:
        return scalarShape(shapeOf(e)) || enumConstant(e);
      case K.MemberExpr: case K.ThisExpr:
        return !ambiguous(e) && scalarShape(shapeOf(e));
      default: return false;
    }
  };
  if (!scalar(expression)) return false;
  // Casting a primitive operand still changes overload selection when its
  // neighbour is a class: operator&&(int, C) vs operator&&(bool, C).
  const binary = parent as BinaryExpr;
  return parent.kind !== K.BinaryExpr || !['&&', '||'].includes(binary.operator)
    || (scalar(binary.left) && scalar(binary.right));
}
