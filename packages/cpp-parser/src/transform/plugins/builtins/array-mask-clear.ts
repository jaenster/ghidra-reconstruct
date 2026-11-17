/** Recover a word-array element clear from Ghidra's masked dword subpiece. */
import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, ArrayType, AssignExpr, BinaryExpr, CompoundStmt, CStyleCastExpr, Expression, ExprStmt, FunctionDecl, Identifier, IntegerLiteralExpr, ParenExpr, Statement, UnaryExpr, VariableDecl } from '../../../ast/nodes.js';
import { Expr } from '../../../ast/factory.js';
import { getChildren } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { cloneNode, createKindTransformer, nodesEqual, type Transformer } from '../../transformer.js';

export interface ArrayMaskClearOptions {
  /** Explicit target fact; unknown/big-endian targets retain the dword operation. */
  littleEndian?: boolean;
  onArrayMaskClear?: (site: { function: string; name: string; index: number }) => void;
}
const unparen = (input: Expression): Expression => {
  let e = input; while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression; return e;
};
function* walk(n: ASTNode): Generator<ASTNode> { yield n; for (const c of getChildren(n)) yield* walk(c); }
const typeText = (n: ASTNode) => emit(n as never).replace(/\s+/g, '');
const integer = (e: Expression): bigint | undefined => unparen(e).kind === NodeKind.IntegerLiteral ? (unparen(e) as IntegerLiteralExpr).value : undefined;

/** Only the lowered, nonvolatile `*(uint32_t*)((char*)&local + N)` lvalue. */
function slice(e: Expression): { name: string; offset: bigint } | undefined {
  const d = unparen(e); if (d.kind !== NodeKind.UnaryExpr || (d as UnaryExpr).operator !== '*') return undefined;
  const cast = unparen((d as UnaryExpr).operand);
  if (cast.kind !== NodeKind.CStyleCastExpr || typeText((cast as CStyleCastExpr).type) !== 'uint32_t*') return undefined;
  let address = unparen((cast as CStyleCastExpr).expression), offset = 0n;
  if (address.kind === NodeKind.BinaryExpr) {
    const b = address as BinaryExpr; if (b.operator !== '+') return undefined;
    const k = integer(b.right); if (k === undefined || k < 0n) return undefined;
    offset = k; address = unparen(b.left);
  }
  if (address.kind !== NodeKind.CStyleCastExpr || typeText((address as CStyleCastExpr).type) !== 'char*') return undefined;
  const ref = unparen((address as CStyleCastExpr).expression);
  if (ref.kind !== NodeKind.UnaryExpr || (ref as UnaryExpr).operator !== '&') return undefined;
  const base = unparen((ref as UnaryExpr).operand);
  return base.kind === NodeKind.Identifier ? { name: (base as Identifier).name, offset } : undefined;
}

/**
 * On a known little-endian target, a standalone `dword &= 0xffff` preserves
 * the lower word and zeros the upper word. For an in-bounds canonical uint16_t
 * local array, write that element directly. No declarations or effects move.
 * Only expression statements qualify: an assignment used as a value still
 * returns the old lower word, so replacing it with a zero-valued store is wrong.
 */
export function createArrayMaskClearTransformer(options: ArrayMaskClearOptions = {}): Transformer {
  if (!options.littleEndian) return n => n;
  return createKindTransformer(NodeKind.FunctionDecl, node => {
    const fn = node as FunctionDecl; if (!fn.body) return undefined;
    const body = cloneNode(fn.body), nodes = [...walk(body)], names = new Map<string, number>();
    const ambiguous = new Set([NodeKind.FunctionDecl, NodeKind.LambdaExpr, NodeKind.ClassDecl,
      NodeKind.StructDecl, NodeKind.UnionDecl, NodeKind.EnumDecl, NodeKind.TypedefDecl, NodeKind.TypeAliasDecl,
      NodeKind.UsingDecl, NodeKind.UsingDirective, NodeKind.Error]);
    if (nodes.some(n => ambiguous.has(n.kind))) return undefined;
    for (const p of fn.parameters) if (p.name) names.set(p.name.name, (names.get(p.name.name) ?? 0) + 1);
    for (const n of nodes) if (n.kind === NodeKind.VariableDecl) {
      const name = (n as VariableDecl).name.name; names.set(name, (names.get(name) ?? 0) + 1);
    }
    const parents = new Map<ASTNode, ASTNode>();
    for (const n of nodes) for (const child of getChildren(n)) parents.set(child,n);
    const arrays = new Map<string, {size:bigint;block:CompoundStmt;index:number}>();
    for (const d of nodes) {
      if (d.kind !== NodeKind.VariableDecl) continue;
      const declaration = parents.get(d), block = declaration && parents.get(declaration);
      if (declaration?.kind !== NodeKind.DeclStmt || block?.kind !== NodeKind.CompoundStmt) continue;
      const v = d as VariableDecl; if (v.specifiers.length || names.get(v.name.name) !== 1 || v.type.kind !== NodeKind.ArrayType) continue;
      const t = v.type as ArrayType; if (typeText(t.elementType) !== 'uint16_t' || !t.size) continue;
      const size = integer(t.size), scope = block as CompoundStmt;
      if (size !== undefined && size > 0n) arrays.set(v.name.name,{size,block:scope,index:scope.statements.indexOf(declaration as Statement)});
    }
    if (!arrays.size) return undefined;
    const clear = (st:ASTNode):ExprStmt|undefined => {
      const s = st as ExprStmt, e = unparen(s.expression); if (e.kind !== NodeKind.AssignExpr) return undefined;
      const a = e as AssignExpr; let mask = a.right;
      if (a.operator === '=') {
        const r = unparen(a.right); if (r.kind !== NodeKind.BinaryExpr || (r as BinaryExpr).operator !== '&' || !nodesEqual(unparen(a.left), unparen((r as BinaryExpr).left))) return undefined;
        mask = (r as BinaryExpr).right;
      } else if (a.operator !== '&=') return undefined;
      if (integer(mask) !== 0xffffn) return undefined;
      const piece = slice(a.left), array = piece && arrays.get(piece.name);
      if (!piece || !array || piece.offset % 2n !== 0n || piece.offset + 4n > array.size * 2n) return undefined;
      // A same-named global can still be visible before this local declaration,
      // or outside its child block. Prove the binding at the actual store.
      let child:ASTNode = st, parent = parents.get(child);
      while (parent && parent !== array.block) { child = parent; parent = parents.get(child); }
      if (parent !== array.block || array.block.statements.indexOf(child as Statement) <= array.index) return undefined;
      const index = piece.offset / 2n + 1n;
      options.onArrayMaskClear?.({ function: emit(fn.name as never), name: piece.name, index: Number(index) });
      return { ...s, expression: { ...a, operator: '=', left: Expr.subscript(Expr.identifier(piece.name), Expr.intLiteral(index)), right: Expr.intLiteral(0) } as AssignExpr };
    };
    for (const st of nodes) if (st.kind === NodeKind.ExprStmt) {
      const result = clear(st); if (result) (st as ExprStmt).expression = result.expression;
    }
    return { ...fn, body } as FunctionDecl;
  });
}
