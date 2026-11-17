/**
 * Copyback Drop Plugin
 *
 * Where the decompiler saves a value in a second variable and the register still holds it,
 * it prints the move both ways (COMPOSIT_GetWeaponClassWithTransform 0064f380):
 *
 *     int32_t nAnimMode = nMode;
 *     nMode = nAnimMode;
 *
 * The second statement stores into nMode the value nMode already holds; no instruction of
 * the original made that store. It goes.
 *
 * `B = A;` is dropped when it directly follows `A = B;` or `T A = B;` in the same block,
 * nothing in between, and:
 *  - A and B are distinct names, each a local or parameter of the function declared once,
 *    so two distinct objects (no reference, no global, no shadowing);
 *  - neither is volatile or static, and both have one emitted type, so `B = A` converts
 *    nothing and B gets back exactly the bits it had;
 *  - both statements are plain `=` stores of a bare name, and the dropped one carries no
 *    comment.
 *
 * Value-preserving: `A = B` writes only A, an object distinct from B, so after it B still
 * holds the value A was given; `B = A` then stores that same value into B. Nothing runs
 * between the two statements, so nothing can observe the store, whether or not B's address
 * is taken: a non-volatile object changed by no one in between needs no second store.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl, Identifier, ParameterDecl, ParenExpr,
  Statement, TypeNode, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { cloneNode, createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface CopybackDropOptions extends PluginOptions {
  onSite?: (e: { from: string; to: string }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

const bare = (e: Expression | null | undefined): string | undefined => {
  if (!e) return undefined;
  const u = unwrap(e);
  return u.kind === NodeKind.Identifier ? (u as Identifier).name : undefined;
};

/** `A = B;` as [A, B], both bare names, or undefined. */
function copyOf(s: Statement): [string, string] | undefined {
  if (s.kind !== NodeKind.ExprStmt) return undefined;
  const a = unwrap((s as ExprStmt).expression);
  if (a.kind !== NodeKind.AssignExpr || (a as AssignExpr).operator !== '=') return undefined;
  const l = bare((a as AssignExpr).left), r = bare((a as AssignExpr).right);
  return l && r ? [l, r] : undefined;
}

/** `A = B;` or `T A = B;` as [A, B]. */
function copyOrInitOf(s: Statement): [string, string] | undefined {
  const c = copyOf(s);
  if (c) return c;
  if (s.kind !== NodeKind.DeclStmt) return undefined;
  const d = (s as DeclStmt).declarations;
  if (d.length !== 1 || d[0].kind !== NodeKind.VariableDecl) return undefined;
  const v = d[0] as VariableDecl;
  if (v.directInit || v.copyListInit || !v.initializer || v.initializer.kind === NodeKind.InitListExpr) return undefined;
  const r = bare(v.initializer as Expression);
  return r ? [v.name.name, r] : undefined;
}

const hasComment = (n: ASTNode) => [...(n.leadingTrivia ?? []), ...(n.trailingTrivia ?? [])]
  .some(t => /comment/i.test(String((t as unknown as { kind?: string }).kind ?? '')) || /\/[/*]/.test(String((t as unknown as { text?: string }).text ?? '')));

function typeText(t: TypeNode): string {
  return emit(t as never).replace(/\s+/g, ' ').trim();
}

/** Each name declared once in the function, with its declared type; names declared twice map to null. */
function declarations(fn: FunctionDecl): Map<string, { type: TypeNode; decl?: VariableDecl } | null> {
  const out = new Map<string, { type: TypeNode; decl?: VariableDecl } | null>();
  const add = (n: string, v: { type: TypeNode; decl?: VariableDecl }) => out.set(n, out.has(n) ? null : v);
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) add(p.name.name, { type: p.type });
  for (const n of traverseAST(fn.body!)) if (n.kind === NodeKind.VariableDecl) add((n as VariableDecl).name.name, { type: (n as VariableDecl).type, decl: n as VariableDecl });
  return out;
}

function plainType(t: string): boolean {
  return !/\bvolatile\b|&|\[/.test(t);
}

function rewrite(fn: FunctionDecl, options: CopybackDropOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const body = cloneNode(fn.body) as CompoundStmt;
  const decls = declarations({ ...fn, body } as FunctionDecl);
  const plain = (n: string) => {
    const d = decls.get(n);
    if (!d) return false;
    if (d.decl && d.decl.specifiers.some(s => s === 'static' || s === 'extern' || s === 'thread_local')) return false;
    return plainType(typeText(d.type));
  };
  let changed = false;
  for (const n of [...traverseAST(body)]) {
    if (n.kind !== NodeKind.CompoundStmt) continue;
    const list = (n as CompoundStmt).statements;
    for (let i = 0; i + 1 < list.length; i++) {
      const first = copyOrInitOf(list[i]);
      const back = copyOf(list[i + 1]);
      if (!first || !back) continue;
      const [a, b] = first;
      if (a === b || back[0] !== b || back[1] !== a) continue;
      if (!plain(a) || !plain(b)) continue;
      if (typeText(decls.get(a)!.type) !== typeText(decls.get(b)!.type)) continue;
      if (hasComment(list[i + 1])) continue;
      list.splice(i + 1, 1);
      options.onSite?.({ from: a, to: b });
      changed = true;
    }
  }
  return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
}

function createCopybackDropTransformer(options: CopybackDropOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      return rewrite(fn, options);
    },
  });
}

export const copybackDropPlugin: TransformPlugin = {
  id: 'copyback-drop',
  name: 'Copyback Drop',
  description: '`B = A;` right after `A = B;` stores the value B holds already, and goes',
  version: '1.0.0',
  defaultEnabled: true,
  // After the late comma expansion and store-order (59.7), with the statement lists final;
  // before early-return and decl-init-merge (60), which read the copies as they are left.
  priority: 59.95,
  tags: ['matching'],
  createTransformer: (options?: PluginOptions) => createCopybackDropTransformer(options as CopybackDropOptions),
};

export { createCopybackDropTransformer };
