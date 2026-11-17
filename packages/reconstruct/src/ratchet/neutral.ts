/**
 * A retype the stored body cannot see.
 *
 * The ratchet refuses a stored body whose function's parameter or return type changed
 * since it was captured: the body was proven against the old declaration, and a value of
 * another type may compile to other code. Some retypes leave every instruction the body
 * compiles to where it was, and refusing them throws a proven body away for nothing
 * (deploy 1177: zlib's deflateTune returning `int` instead of `uint32_t`, a handler's
 * unused `pGame` typed `SGAMEDATA *` instead of `uint32_t`). Those are recognised here,
 * on the stored body's own parse, and nothing else:
 *
 *  - a parameter the body never names, retyped between one-word types (a 4-byte integer
 *    or a pointer): the frame and the argument area keep their layout and no code reads it;
 *  - a parameter retyped between 4-byte integer types (signedness only), whose every
 *    mention is the whole right-hand side of a plain `=` into a 4-byte integer field or
 *    local: a word is copied the same way whatever its sign;
 *  - a return type retyped between 4-byte integer types, where every `return` returns an
 *    integer literal: the constant loaded into EAX has the same bits either way.
 *
 * Anything else (a comparison, a shift, a division, a widening, a pointer becoming an
 * integer the body uses) stays refused.
 */
import { NodeKind, getChildren, type ASTNode } from '@ghidra-mcp/cpp-parser';

import type { Binding, SiteScan } from './refs.js';
import type { TypeRef } from './scan.js';

type AnyNode = ASTNode & Record<string, any>;

/** The 4-byte integer spellings of the tree (Ghidra's and the C ones). */
const WORD_INTEGERS = new Set([
  'int', 'int32_t', 'uint32_t', 'unsigned int', 'unsigned', 'signed int', 'signed', 'long', 'unsigned long',
  'long int', 'unsigned long int', 'uint', 'ulong', 'undefined4', 'dword', 'DWORD', 'UINT', 'ULONG', 'LONG', 'INT', 'BOOL',
]);

const squash = (t: string) => t.trim().replace(/^::/, '').split(/\s+/).join(' ');

export function isWordInteger(t: string | undefined): boolean {
  return t !== undefined && WORD_INTEGERS.has(squash(t));
}

function isPointer(t: string | undefined): boolean {
  return t !== undefined && squash(t).endsWith('*');
}

function isWord(t: string | undefined): boolean {
  return isWordInteger(t) || isPointer(t);
}

function wordIntegerRef(t: TypeRef | undefined): boolean {
  return !!t && t.ptr === 0 && isWordInteger(t.base);
}

/** Every node of the tree with its parent chain, in walk order. */
function walk(root: AnyNode, visit: (n: AnyNode, parents: AnyNode[]) => void): void {
  const go = (n: AnyNode, parents: AnyNode[]) => {
    visit(n, parents);
    const next = [...parents, n];
    for (const c of getChildren(n) as AnyNode[]) if (c) go(c, next);
  };
  go(root, []);
}

const offsetOf = (n: AnyNode): number | undefined => n.location?.start?.offset;

function unparen(n: AnyNode): AnyNode {
  let x = n;
  while (x.kind === NodeKind.ParenExpr) x = x.expression;
  return x;
}

function isIntegerLiteral(n: AnyNode | null | undefined): boolean {
  if (!n) return false;
  const x = unparen(n);
  if (x.kind === NodeKind.IntegerLiteral) return true;
  return x.kind === NodeKind.UnaryExpr && (x.operator === '-' || x.operator === '+') && isIntegerLiteral(x.operand);
}

/**
 * Whether the stored body compiles the same with parameter `k` retyped `was` -> `now`.
 * `bindings` are the stored body's, by site, with parameters at their captured positions.
 */
export function neutralParamRetype(scan: SiteScan, bindings: ReadonlyArray<Binding | undefined>, k: number, was: string, now: string): boolean {
  if (!isWord(was) || !isWord(now)) return false;
  const mentions = new Set<number>();
  scan.sites.forEach((s, i) => {
    const b = bindings[i];
    if (b && b.k === 'param' && b.i === k) mentions.add(s.start);
  });
  if (mentions.size === 0) return true;
  if (!isWordInteger(was) || !isWordInteger(now)) return false;
  // The binding of the site that starts at an offset: a store's target.
  const siteAt = new Map<number, number>();
  scan.sites.forEach((s, i) => siteAt.set(s.start, i));
  const targetIsWordInteger = (left: AnyNode): boolean => {
    const t = unparen(left);
    if (t.kind === NodeKind.MemberExpr) {
      const o = offsetOf(t.member as AnyNode);
      const b = o === undefined ? undefined : bindings[siteAt.get(o) ?? -1];
      return !!b && b.k === 'fd' && isWordInteger(b.t);
    }
    if (t.kind === NodeKind.Identifier) return scan.locals.has(t.name) && wordIntegerRef(scan.locals.get(t.name));
    return false;
  };
  let seen = 0;
  let ok = true;
  walk(scan.root as AnyNode, (n, parents) => {
    if (!ok || n.kind !== NodeKind.Identifier) return;
    const o = offsetOf(n);
    if (o === undefined || !mentions.has(o)) return;
    seen++;
    let i = parents.length - 1;
    let child: AnyNode = n;
    while (i >= 0 && parents[i].kind === NodeKind.ParenExpr) { child = parents[i]; i--; }
    const p = i >= 0 ? parents[i] : undefined;
    if (p && p.kind === NodeKind.AssignExpr && p.operator === '=' && p.right === child && targetIsWordInteger(p.left)) return;
    if (p && p.kind === NodeKind.VariableDecl && p.initializer === child && wordIntegerRef(scan.locals.get(p.name?.name))) return;
    ok = false;
  });
  return ok && seen === mentions.size;
}

/** Whether the stored body compiles the same with its return type `was` -> `now`. */
export function neutralReturnRetype(scan: SiteScan, was: string, now: string): boolean {
  if (!isWordInteger(was) || !isWordInteger(now)) return false;
  let ok = true;
  walk(scan.root as AnyNode, n => {
    if (n.kind === NodeKind.ReturnStmt && !isIntegerLiteral(n.value)) ok = false;
  });
  return ok;
}
