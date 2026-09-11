/**
 * Local-variable dataflow facts, computed on the AST rather than scraped from text.
 *
 * Every defect check about locals needs the same four questions answered, and getting any
 * of them wrong by pattern-matching source text is how the Python suite this replaces
 * produced both false positives and false negatives:
 *
 *   - which names are DECLARED as locals
 *   - which are READ
 *   - which are WRITTEN
 *   - which have their ADDRESS TAKEN
 *
 * The last one is what makes the difference between a real finding and noise, and it has
 * THREE forms, not one. Missing any of them reports arrays and structs as "never assigned"
 * and buries the real findings:
 *
 *   - `&x` - the callee writes through the pointer.
 *   - `x[i] = v`, `x.f = v`, `*x = v` - the assignment target is a Subscript/Member/deref
 *     whose ROOT is x. A check that only looks at a bare Identifier LHS sees no write here.
 *   - `sprintf(x, ...)` where x is an ARRAY. An array name decays to a pointer with no `&`
 *     anywhere, so the callee writes it and nothing in the syntax says so. Only the
 *     declared type reveals it, which is exactly what a text-matching tool cannot see.
 *
 * A scalar or struct passed BY VALUE is not escaped - the callee cannot write the caller's
 * copy - so the decay rule is deliberately restricted to ArrayType.
 *
 * TWO AST SHAPES, NOT ONE
 *
 * `VariableDecl.name` is a plain STRING on a freshly parsed AST and an `Identifier` NODE
 * after the pipeline has run - some pass normalises it. Code that assumes either shape
 * silently reports nothing on the other, so both are handled here in one place and nowhere
 * else. The same normalisation is why declarator names must be excluded from an Identifier
 * walk: without that, every declaration counts as a read of itself.
 */

import { NodeKind } from '../../packages/cpp-parser/src/ast/kinds.js';
import type {
  ASTNode, FunctionDecl, VariableDecl, Identifier, AssignExpr, UnaryExpr,
} from '../../packages/cpp-parser/src/ast/nodes.js';
import { findNodesByKind } from '../../packages/cpp-parser/src/ast/visitor.js';

export interface LocalFacts {
  decls: Map<string, VariableDecl>;
  /** Address-taken, or an array handed to a callee that can write through it. */
  escaped: Set<string>;
  /** Declared with an initializer - `T x = expr;` counts as a write. */
  initialized: Set<string>;
  reads: Set<string>;
  writes: Set<string>;
  addressTaken: Set<string>;
  params: Set<string>;
}

/** A declarator's name, whichever of the two shapes it currently has. */
export function declName(d: any): string | null {
  const n = d?.name;
  if (typeof n === 'string') return n || null;
  if (n && typeof n === 'object' && typeof n.name === 'string') return n.name || null;
  return null;
}

function idName(n: any): string | null {
  return n && n.kind === NodeKind.Identifier && typeof n.name === 'string' ? n.name : null;
}

/**
 * The variable an lvalue ultimately refers to: `a[i].f` and `*(p + 1)` both root at their
 * base identifier. Without this, an assignment to a member or an element looks like no
 * assignment at all.
 *
 * Pointer ARITHMETIC has to be followed too. Ghidra emits a great deal of
 * `*(int *)(buf + 0x10) = v`, where the target roots through a BinaryExpr - and a buffer
 * written only that way looks completely unwritten if the walk stops at the operator.
 * Only the pointer side of the arithmetic is followed: in `buf + i` the base is `buf`, and
 * descending into `i` as well would credit the index variable with the write.
 */
function rootIdent(n: any): string | null {
  let cur = n;
  for (let guard = 0; cur && guard < 64; guard++) {
    const direct = idName(cur);
    if (direct) return direct;

    if (cur.kind === NodeKind.BinaryExpr) {
      const op = cur.operator;
      if (op !== '+' && op !== '-') return null;
      // Prefer whichever side is not a bare literal; that is the pointer.
      const l = cur.left, r = cur.right;
      const lLit = l && String(l.kind).includes('Literal');
      cur = lLit ? r : l;
      continue;
    }

    cur = cur.object ?? cur.base ?? cur.array ?? cur.operand ?? cur.expression ?? cur.expr ?? null;
  }
  return null;
}

/**
 * The called function's simple name, across the shapes a callee wears.
 *
 * `CompileTxt(...)` parses to a bare Identifier, but `DataTbls::CompileTxt(...)` parses to a
 * QualifiedId whose `.name` is itself an Identifier NODE - the same string-or-node trap as
 * `VariableDecl.name`. A check that reads `callee.name` as a string silently matches nothing
 * on every namespaced call, which in this codebase is almost all of them.
 */
export function calleeName(callee: any): string | null {
  if (!callee) return null;
  if (typeof callee.name === 'string') return callee.name;
  if (callee.name && typeof callee.name === 'object' && typeof callee.name.name === 'string') {
    return callee.name.name;
  }
  const prop = callee.property ?? callee.member;
  if (prop && typeof prop.name === 'string') return prop.name;
  return null;
}

function isArrayType(d: any): boolean {
  const t = d?.type;
  return !!t && t.kind === 'ArrayType';
}

export function localFacts(fn: FunctionDecl): LocalFacts {
  const body = (fn as any).body ?? fn;

  const decls = new Map<string, VariableDecl>();
  const initialized = new Set<string>();
  const declNameNodes = new Set<ASTNode>();
  for (const d of findNodesByKind(body, NodeKind.VariableDecl) as VariableDecl[]) {
    const name = declName(d);
    if (!name) continue;
    decls.set(name, d);
    if ((d as any).initializer) initialized.add(name);
    const raw = (d as any).name;
    if (raw && typeof raw === 'object' && raw.kind === NodeKind.Identifier) {
      declNameNodes.add(raw);
    }
  }

  const params = new Set<string>();
  for (const p of ((fn as any).parameters ?? []) as any[]) {
    const n = declName(p);
    if (n) params.add(n);
  }

  // Plain `x = ...` writes x and does not read it. A compound assignment (`x += 1`) does
  // both, so only `=` excludes the target from the read set.
  const writes = new Set<string>();
  const writeTargetNodes = new Set<ASTNode>();
  for (const a of findNodesByKind(body, NodeKind.AssignExpr) as AssignExpr[]) {
    const lhs = (a as any).left;
    const op = (a as any).operator;
    // Root through member/subscript/deref: `x[i] = v` and `x.f = v` both write x.
    const n = rootIdent(lhs);
    if (!n) continue;
    writes.add(n);
    // Only a BARE identifier target is a pure write. `x[i] = v` reads x to find the
    // element, so it must stay in the read set.
    if (idName(lhs) && (op === '=' || op === undefined)) writeTargetNodes.add(lhs);
  }

  const addressTaken = new Set<string>();
  for (const u of findNodesByKind(body, NodeKind.UnaryExpr) as UnaryExpr[]) {
    if ((u as any).operator !== '&') continue;
    const n = rootIdent((u as any).operand);
    if (n) addressTaken.add(n);
  }

  // Array decay: `sprintf(szPath, ...)` writes szPath with no `&` in sight.
  const escaped = new Set<string>(addressTaken);
  for (const c of findNodesByKind(body, NodeKind.CallExpr) as any[]) {
    for (const arg of (c.arguments ?? c.args ?? [])) {
      const n = rootIdent(arg);
      if (!n) continue;
      const d = decls.get(n);
      if (d && isArrayType(d)) escaped.add(n);
    }
  }

  const reads = new Set<string>();
  for (const id of findNodesByKind(body, NodeKind.Identifier) as Identifier[]) {
    if (declNameNodes.has(id) || writeTargetNodes.has(id)) continue;
    const n = (id as any).name;
    if (typeof n === 'string' && n) reads.add(n);
  }

  return { decls, initialized, reads, writes, addressTaken, escaped, params };
}
