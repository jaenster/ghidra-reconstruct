/** Conservative value types for the opt-in packing and delayed parameter stores. */
import { NodeKind as K } from '../../../ast/kinds.js';
import type { ASTNode, AnyNode, Expression, FunctionDecl, VariableDecl } from '../../../ast/nodes.js';
import { getChildren } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import type { SelectArgumentOptions } from './select-argument.js';
import { canonicalBase } from './call-arg-cast.js';

export const unparen = (e: Expression): Expression => { while (e.kind === K.ParenExpr) e = e.expression; return e; };
export const descendants = (n: ASTNode): ASTNode[] => [n, ...getChildren(n).flatMap(descendants)];
export const spelling = (n: ASTNode): string => emit(n as AnyNode).replace(/\s+/g, '');
const ints = new Set(['bool', 'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int', 'long', 'unsigned long', 'long long', 'unsigned long long', 'wchar_t']);
const opaque = new Set([K.LambdaExpr, K.FunctionDecl, K.ClassDecl, K.StructDecl, K.UnionDecl, K.EnumDecl, K.TypedefDecl, K.TypeAliasDecl,
  K.UsingDecl, K.UsingDirective, K.AsmDecl, K.Error, K.PpConditionalStmt, K.GotoStmt, K.LabelStmt, K.TryStmt, K.SehTryStmt]);
export function privateValueEnv(fn: FunctionDecl, tables: SelectArgumentOptions) {
  if (!fn.body) return undefined;
  const all = descendants(fn.body);
  if (all.some(n => opaque.has(n.kind))) return undefined;
  const vars = all.filter(n => n.kind === K.VariableDecl) as VariableDecl[];
  const bindings = new Map<string, string>(), counts = new Map<string, number>();
  for (const p of fn.parameters) if (p.name) { bindings.set(p.name.name, emit(p.type)); counts.set(p.name.name, (counts.get(p.name.name) ?? 0) + 1); }
  for (const v of vars) { bindings.set(v.name.name, emit(v.type)); counts.set(v.name.name, (counts.get(v.name.name) ?? 0) + 1); }
  if ([...counts.values()].some(n => n !== 1)) return undefined;
  const resolve = (raw: string, allowConst = true, seen = new Set<string>()): string | undefined => {
    let t = raw.replace(/\s+/g, ' ').trim();
    if (/\bvolatile\b|[&()[\]<>]/.test(t) || (!allowConst && /\bconst\b/.test(t)) || seen.has(t)) return undefined;
    t = t.replace(/\bconst\b/g, '').replace(/\s+/g, ' ').trim();
    if (seen.has(t)) return undefined;
    if (tables.typedefTargets?.[t]) { seen.add(t); return resolve(tables.typedefTargets[t], allowConst, seen); }
    // Actual Ghidra primitive targets of stdint typedefs. Other typedef names
    // still need the supplied alias contract; canonicalBase alone would guess them.
    if (t === 'uint' || t === 'ushort') return canonicalBase(t);
    return t.replace(/^signed(?: int)?$/, 'int').replace(/^unsigned$/, 'unsigned int')
      .replace(/^(unsigned )?short int$/, '$1short').replace(/^signed (short|long|long long)(?: int)?$/, '$1')
      .replace(/^(unsigned )?(long|long long) int$/, '$1$2').replace(/\s*\*\s*/g, '*');
  };
  const integer = (raw: string | undefined, allowConst = true): boolean => !!raw && ints.has(resolve(raw, allowConst) ?? '');
  const typeOf = (expression: Expression): string | undefined => {
    const e = unparen(expression);
    if (e.kind === K.Identifier) return bindings.get(e.name);
    if (e.kind === K.MemberExpr) {
      const object = typeOf(e.object), t = object && resolve(object);
      if (!t || (e.isArrow ? !t.endsWith('*') || t.endsWith('**') : t.includes('*'))) return undefined;
      const base = e.isArrow ? t.slice(0, -1) : t;
      return e.member.kind === K.Identifier ? tables.structFields?.[base]?.[e.member.name] : undefined;
    }
    return undefined;
  };
  const numeric = (expression: Expression): boolean => {
    const e = unparen(expression);
    switch (e.kind) {
      case K.IntegerLiteral: case K.CharLiteral: case K.BoolLiteral: return true;
      case K.Identifier: return integer(typeOf(e));
      case K.MemberExpr: return integer(typeOf(e));
      case K.CStyleCastExpr: return integer(emit(e.type)) && numeric(e.expression);
      case K.UnaryExpr: return ['+', '-', '~', '!'].includes(e.operator) && numeric(e.operand);
      case K.BinaryExpr: return ['+', '-', '*', '&', '|', '^', '<<', '>>', '<', '<=', '>', '>=', '==', '!=', '&&', '||'].includes(e.operator)
        && numeric(e.left) && numeric(e.right);
      default: return false;
    }
  };
  return { all, vars, bindings, counts, resolve, integer, typeOf, numeric };
}
