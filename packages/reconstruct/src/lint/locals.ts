/**
 * Local-variable dataflow facts, asked of the AST rather than scraped from text.
 *
 * The checks about locals need four answers - declared, read, written, escaped - and each has
 * a form a text match cannot see:
 *
 *   - `arr[i] = v`, `s.f = v`, `*(int *)&x = v` store into the named object; `p[i] = v`,
 *     `p->f = v` and `*(int *)(p + 4) = v` store into what p points at and READ p. The
 *     distinction is the declared type (array or not) - an uninitialised pointer written
 *     through is exactly the defect, and treating it as a write of p hid two of them.
 *   - `sprintf(buf, ...)` writes buf with no `&` anywhere: an ARRAY name decays to a pointer.
 *     Only the declared type says so. The same decay into `p = buf` makes p an alias that
 *     can write buf, so any decayed use of an array counts as an escape.
 *   - `sizeof(x)` mentions x without reading it.
 *   - `x` declared with a name inside a local struct (`struct __frame0_t { int x; }`) is a
 *     member, not a local - see ast.functionScope.
 *
 * Flow-insensitive on purpose: the question is "does ANY path give it a value", and a
 * defect of this class has no write on any path at all.
 */

import { NodeKind, type ASTNode } from '@ghidra-mcp/cpp-parser';
import { calleeName, isArrayType, refName, strip, unparen, walk } from './ast.js';
import type { FunctionInfo } from './tree.js';

export interface LocalFacts {
  /** Assigned: `=`, compound assignment, `++`/`--`, through any lvalue rooted at the name. */
  writes: Set<string>;
  /** Address taken (`&x`, `&x.f`, `&x[i]`), or an array name used where it decays. */
  escaped: Set<string>;
  /** Mentioned as a value anywhere other than a pure `x = ...` target or a sizeof operand. */
  reads: Set<string>;
  /** The nodes that made a name escape, for callers that need to ask which call it went to. */
  escapeSites: Map<string, ASTNode[]>;
}

/**
 * The variable an lvalue ultimately names: `a[i].f`, `*(p + 1)`, `(T *)x` all root at their
 * base identifier. Only the pointer side of arithmetic is followed - in `buf + i` the base is
 * buf, and crediting i with the write would hide a real finding on i.
 */
export function rootName(n: any): string | null {
  let cur = n;
  for (let guard = 0; cur && guard < 64; guard++) {
    const direct = refName(cur);
    if (direct) return direct;
    switch (cur.kind) {
      case NodeKind.BinaryExpr: {
        if (cur.operator !== '+' && cur.operator !== '-') return null;
        const l = strip(cur.left);
        const lLit = l && (l.kind === NodeKind.IntegerLiteral || l.kind === NodeKind.CharLiteral);
        cur = lLit ? cur.right : cur.left;
        continue;
      }
      case NodeKind.SubscriptExpr: cur = cur.array; continue;
      case NodeKind.MemberExpr: cur = cur.object; continue;
      case NodeKind.UnaryExpr:
        if (cur.operator === '*' || cur.operator === '&') { cur = cur.operand; continue; }
        return null;
      case NodeKind.ParenExpr: cur = cur.expression; continue;
      case NodeKind.CStyleCastExpr:
      case NodeKind.StaticCastExpr:
      case NodeKind.ReinterpretCastExpr:
      case NodeKind.ConstCastExpr:
        cur = cur.expression; continue;
      default:
        return null;
    }
  }
  return null;
}

/**
 * The OBJECT an assignment stores into, if it is a named variable. Unlike rootName this
 * stops at a pointer: `*p = v`, `p[i] = v` and `p->f = v` store into what p points at and
 * READ p - an uninitialised pointer written through is the defect, not a write of p.
 * `x[i] = v` on an ARRAY x, `x.f = v`, and `*(T *)&x = v` (or `*(T *)((char *)&x + 4)`)
 * do store into x.
 */
export function storedObject(lhs: any, isArrayName: (name: string) => boolean): string | null {
  let cur = lhs;
  for (let guard = 0; cur && guard < 64; guard++) {
    const direct = refName(cur);
    if (direct) return direct;
    switch (cur.kind) {
      case NodeKind.ParenExpr: cur = cur.expression; continue;
      case NodeKind.CStyleCastExpr:
      case NodeKind.StaticCastExpr:
      case NodeKind.ReinterpretCastExpr:
      case NodeKind.ConstCastExpr:
        cur = cur.expression; continue;
      case NodeKind.MemberExpr:
        if (cur.isArrow) return pointeeObject(cur.object, isArrayName);
        cur = cur.object; continue;
      case NodeKind.SubscriptExpr:
        return pointeeObject(cur.array, isArrayName);
      case NodeKind.UnaryExpr:
        if (cur.operator === '*') return pointeeObject(cur.operand, isArrayName);
        return null;
      default:
        return null;
    }
  }
  return null;
}

/** Which named object does this POINTER expression point into? Only `&x...` or a decayed array. */
function pointeeObject(ptr: any, isArrayName: (name: string) => boolean): string | null {
  let cur = ptr;
  for (let guard = 0; cur && guard < 64; guard++) {
    const direct = refName(cur);
    if (direct) return isArrayName(direct) ? direct : null;
    switch (cur.kind) {
      case NodeKind.ParenExpr: cur = cur.expression; continue;
      case NodeKind.CStyleCastExpr:
      case NodeKind.StaticCastExpr:
      case NodeKind.ReinterpretCastExpr:
      case NodeKind.ConstCastExpr:
        cur = cur.expression; continue;
      case NodeKind.BinaryExpr: {
        if (cur.operator !== '+' && cur.operator !== '-') return null;
        const l = strip(cur.left);
        const lLit = l && (l.kind === NodeKind.IntegerLiteral || l.kind === NodeKind.CharLiteral);
        cur = lLit ? cur.right : cur.left;
        continue;
      }
      case NodeKind.UnaryExpr:
        if (cur.operator === '&') return storedObject(cur.operand, isArrayName);
        return null;
      case NodeKind.MemberExpr:
        // `s.arr` decays like an array when the member is one; its object is s.
        return cur.isArrow ? null : storedObject(cur.object, isArrayName);
      default:
        return null;
    }
  }
  return null;
}

const VA_WRITERS = new Set(['va_start', 'va_copy', '__builtin_va_start', '__builtin_va_copy']);

export function localFacts(fn: FunctionInfo): LocalFacts {
  const body = (fn.node as any).body;
  const scope = fn.scope();
  const isArrayName = (name: string) => {
    const e = scope.get(name);
    return !!e && isArrayType(e.type);
  };
  const writes = new Set<string>();
  const escaped = new Set<string>();
  const reads = new Set<string>();
  const escapeSites = new Map<string, ASTNode[]>();
  const pureWriteTargets = new Set<ASTNode>();
  const declNames = new Set<ASTNode>();
  const sizeofOperands = new Set<ASTNode>();
  const addEscape = (name: string, site: ASTNode) => {
    escaped.add(name);
    let l = escapeSites.get(name);
    if (!l) escapeSites.set(name, (l = []));
    l.push(site);
  };

  const parents = new Map<ASTNode, ASTNode | null>();
  walk(body, (n, p) => {
    parents.set(n, p);
    if (n.kind === NodeKind.VariableDecl && (n as any).name && typeof (n as any).name === 'object') {
      declNames.add((n as any).name);
    }
    if (n.kind === NodeKind.SizeofExpr) sizeofOperands.add(n);
    if (n.kind === NodeKind.StructDecl || n.kind === NodeKind.ClassDecl || n.kind === NodeKind.UnionDecl) {
      return 'skip';
    }
    if (n.kind === NodeKind.AssignExpr) {
      const lhs = (n as any).left;
      const r = storedObject(lhs, isArrayName);
      if (r) writes.add(r);
      if (refName(unparen(lhs)) && (n as any).operator === '=') pureWriteTargets.add(unparen(lhs));
    } else if ((n.kind === NodeKind.UnaryExpr || n.kind === NodeKind.PostfixExpr) &&
               ((n as any).operator === '++' || (n as any).operator === '--')) {
      const r = storedObject((n as any).operand, isArrayName);
      if (r) writes.add(r);
    } else if (n.kind === NodeKind.CallExpr && VA_WRITERS.has(calleeName((n as any).callee) ?? '')) {
      // va_start(ap, last) and va_copy(dst, src) are macros that assign their first argument.
      const r = refName(unparen((n as any).arguments?.[0]));
      if (r) writes.add(r);
    } else if (n.kind === NodeKind.UnaryExpr && (n as any).operator === '&') {
      // `&x`, `&x.f`, `&arr[i]` hand out x; `&p->f` hands out what p points at and reads p.
      const r = storedObject((n as any).operand, isArrayName);
      if (r) addEscape(r, n);
    }
    return undefined;
  });

  const insideSizeof = (n: ASTNode): boolean => {
    for (let p = parents.get(n); p; p = parents.get(p) ?? null) {
      if (sizeofOperands.has(p)) return true;
      if (p.kind === NodeKind.ExprStmt || p.kind === NodeKind.DeclStmt) return false;
    }
    return false;
  };

  walk(body, (n) => {
    if (n.kind === NodeKind.StructDecl || n.kind === NodeKind.ClassDecl || n.kind === NodeKind.UnionDecl) {
      return 'skip';
    }
    const name = n.kind === NodeKind.Identifier ? (n as any).name
      : n.kind === NodeKind.QualifiedId ? null : null;
    if (!name || declNames.has(n)) return undefined;
    // A member name (`p->x`) is not a reference to a local called x.
    const p = parents.get(n);
    if (p && p.kind === NodeKind.MemberExpr && (p as any).member === n) return undefined;
    if (insideSizeof(n)) return undefined;
    if (!pureWriteTargets.has(n)) reads.add(name);
    // Array decay: any use of an array name that is not the base of a subscript.
    const e = scope.get(name);
    if (e && isArrayType(e.type)) {
      let up: ASTNode | null = p ?? null;
      let child: ASTNode = n;
      while (up && (up.kind === NodeKind.ParenExpr)) { child = up; up = parents.get(up) ?? null; }
      const subscriptBase = up && up.kind === NodeKind.SubscriptExpr && (up as any).array === child;
      if (!subscriptBase) addEscape(name, up ?? n);
    }
    return undefined;
  });

  return { writes, escaped, reads, escapeSites };
}

/** Ghidra's own names for a value it could not place - the register-contract class, counted elsewhere. */
export const SYNTHETIC_NAME = /^(extraout_|in_|unaff_|__)/;
