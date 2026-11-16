/** Read a callee's bounded, ordinary pointer-field return on its non-null path. */
import { NodeKind, emit, type ASTNode, type FunctionDecl, type Expression, type Statement, type VariableDecl, type IfStmt, type MemberExpr, type ReturnStmt, type CStyleCastExpr } from '@ghidra-mcp/cpp-parser';
import { getChildren } from '@ghidra-mcp/cpp-parser/ast/visitor';
import type { ExtractedDataType, ExtractedFunction, ExtractedStruct } from '../types.js';
import { pipelineFunction } from './inlined-calls.js';

export interface NonNullFieldRead {
  parameterType: string;
  returnType: string;
  fieldType: string;
  member: string;
  offset: number;
  functionAddress: string;
}

export interface NonNullFieldGetterOracle {
  /** Unknown is null. byKey contains only unambiguous emitted call spellings. */
  read(callee: string, argCount: number): NonNullFieldRead | null;
}

const unparen = (input: Expression): Expression => {
  let e = input;
  while (e.kind === NodeKind.ParenExpr) e = e.expression;
  return e;
};
function* walk(n: ASTNode): Generator<ASTNode> {
  yield n;
  for (const c of getChildren(n)) yield* walk(c);
}

/** One raw object pointer; aliases, templates and volatile storage need a separate proof. */
function pointer(type: string | undefined): string | null {
  if (!type) return null;
  if (/\bvolatile\b/.test(type)) return null;
  const s = type.replace(/\*32\b/g, '*').replace(/\b(?:const|struct|class|union)\b/g, '').replace(/\s+/g, '').replace(/^::/, '');
  return /^(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*\*$/.test(s) ? s : null;
}

function scalarOrPointer(type: string, types: ReadonlyMap<string, ExtractedDataType | null>, seen = new Set<string>()): boolean {
  if (/\bvolatile\b/.test(type)) return false;
  if (pointer(type)) return true;
  const s = type.replace(/\bconst\b/g, '').trim().replace(/\s+/g, ' ');
  if (seen.has(s)) return false;
  const dt = types.get(s);
  if (dt === null || dt?.detailUnavailable) return false;
  if (dt?.kind === 'STRUCTURE' || dt?.kind === 'UNION' || dt?.kind === 'FUNCTION_DEFINITION' || dt?.kind === 'ARRAY') return false;
  if (dt?.kind === 'TYPEDEF') {
    const target = (dt as ExtractedDataType & { underlyingType?: string }).underlyingType;
    if (!target) return false;
    seen.add(s);
    return scalarOrPointer(target, types, seen);
  }
  return /^(?:(?:unsigned|signed) )?(?:char|short|int|long(?: long)?|bool|float|double|wchar_t)$/.test(s)
    || /^(?:u?int(?:8|16|32|64)_t|u?intptr_t|size_t|ptrdiff_t)$/.test(s);
}

/** A null literal, possibly cast to a raw pointer, with no converting-class operation. */
function nullLiteral(input: Expression): boolean {
  const e = unparen(input);
  if (e.kind === NodeKind.IntegerLiteral) return e.value === 0n;
  if (e.kind === NodeKind.NullptrLiteral) return true;
  if (e.kind === NodeKind.CStyleCastExpr) {
    const c = e as CStyleCastExpr;
    return pointer(emit(c.type)) !== null && nullLiteral(c.expression);
  }
  return false;
}

function nullWhenTrue(input: Expression, parameter: string): boolean {
  const e = unparen(input);
  const isParameter = (x: Expression): boolean => {
    const p = unparen(x);
    return p.kind === NodeKind.Identifier && p.name === parameter;
  };
  if (e.kind === NodeKind.UnaryExpr && e.operator === '!') return isParameter(e.operand);
  return e.kind === NodeKind.BinaryExpr && e.operator === '=='
    && ((isParameter(e.left) && nullLiteral(e.right)) || (isParameter(e.right) && nullLiteral(e.left)));
}

function prefixDeclaration(st: Statement, types: ReadonlyMap<string, ExtractedDataType | null>): boolean {
  return st.kind === NodeKind.DeclStmt && st.declarations.length > 0 && st.declarations.every(d => {
    if (d.kind !== NodeKind.VariableDecl) return false;
    const v = d as VariableDecl;
    return !v.initializer && !v.directInit && !v.specifiers.length && !v.attributes.length
      && scalarOrPointer(emit(v.type), types);
  });
}

function memberReturn(st: Statement, parameter: string): MemberExpr | null {
  if (st.kind !== NodeKind.ReturnStmt || !(st as ReturnStmt).value) return null;
  const e = unparen((st as ReturnStmt).value!);
  if (e.kind !== NodeKind.MemberExpr) return null;
  const member = e as MemberExpr;
  const object = unparen(member.object);
  return member.isArrow && object.kind === NodeKind.Identifier && object.name === parameter
    && member.member.kind === NodeKind.Identifier ? member : null;
}

/**
 * Accept only `return p->field`, or uninitialised POD declarations followed by
 * `if (p == 0) { ... } return p->field`. The null arm is not executed for this
 * contract. A declaration with an initializer, converting type, volatile field,
 * unknown prototype or extra executed statement prevents the proof.
 */
function analyse(fn: ExtractedFunction, types: ReadonlyMap<string, ExtractedDataType | null>): NonNullFieldRead | null {
  if (!fn.decompiled || fn.isExternal || fn.isThunk || fn.platform || fn.parentClass || fn.hasVarArgs
      || !['__cdecl', '__stdcall', '__fastcall'].includes(fn.callingConvention)
      || !Array.isArray(fn.parameters) || fn.parameters.length !== 1 || fn.parameters[0].ordinal !== 0) return null;
  if ((fn.localVariables ?? []).some(v => /^(?:in_|unaff_|extraout_)/i.test(v.name))) return null;
  const parameterType = pointer(fn.parameters[0].dataType), returnType = pointer(fn.returnType);
  if (!parameterType || !returnType) return null;
  const dt = types.get(parameterType.slice(0, -1));
  if (!dt || dt.kind !== 'STRUCTURE' || dt.detailUnavailable) return null;
  const ast: FunctionDecl | undefined = pipelineFunction(fn);
  if (!ast?.body || ast.isVariadic || ast.parameters.length !== 1 || !ast.parameters[0].name) return null;
  if (pointer(emit(ast.parameters[0].type)) !== parameterType || pointer(emit(ast.returnType)) !== returnType) return null;
  const parameter = ast.parameters[0].name.name;
  const locals = new Set([parameter]);
  for (const n of walk(ast.body)) {
    if (n.kind === NodeKind.Error || n.kind === NodeKind.AsmDecl) return null;
    if (n.kind === NodeKind.VariableDecl) {
      const name = (n as VariableDecl).name.name;
      if (locals.has(name)) return null;
      locals.add(name);
    }
  }
  const statements = ast.body.statements;
  let first = 0;
  while (first < statements.length && prefixDeclaration(statements[first], types)) first++;
  const live = statements.slice(first);
  let member: MemberExpr | null = null;
  if (live.length === 1) member = memberReturn(live[0], parameter);
  else if (live.length === 2 && live[0].kind === NodeKind.IfStmt) {
    const guard = live[0] as IfStmt;
    if (!guard.init && !guard.isConstexpr && !guard.elseBranch && nullWhenTrue(guard.condition, parameter)) {
      member = memberReturn(live[1], parameter);
    }
  }
  if (!member || member.member.kind !== NodeKind.Identifier) return null;
  if (!Array.isArray((dt as ExtractedStruct).fields)) return null;
  const fields = (dt as ExtractedStruct).fields.filter(f => f.name === member.member.name);
  if (fields.length !== 1) return null;
  const field = fields[0];
  if (field.bitSize != null || field.bitOffset != null || !Number.isInteger(field.offset) || field.offset < 0) return null;
  const fieldType = pointer(field.dataType);
  if (!fieldType || fieldType !== returnType) return null;
  return { parameterType, returnType, fieldType, member: member.member.name, offset: field.offset, functionAddress: fn.address };
}

export function createNonNullFieldGetterOracle(
  byKey: ReadonlyMap<string, ExtractedFunction>, dataTypes: readonly ExtractedDataType[],
): NonNullFieldGetterOracle {
  const types = new Map<string, ExtractedDataType | null>();
  for (const dt of dataTypes) types.set(dt.name, types.has(dt.name) ? null : dt);
  const cache = new Map<ExtractedFunction, NonNullFieldRead | null>();
  return {
    read(callee, argCount) {
      if (argCount !== 1) return null;
      const fn = byKey.get(callee);
      if (!fn) return null;
      if (!cache.has(fn)) cache.set(fn, analyse(fn, types));
      return cache.get(fn)!;
    },
  };
}
