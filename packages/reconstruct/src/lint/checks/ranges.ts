/**
 * Index RANGES, not only constant indices: the largest value an index expression can take,
 * when the code itself proves a bound - a mask, a modulus, a loop bound, an if-guard, the
 * labels of the switch case it sits in.
 *
 * A table sized to the next symbol is truncated by any stray label inside it, and the code
 * that indexes it says how long it really is: `gnHashLowTable[nChar & 0xf]` walks sixteen
 * entries whatever the declaration says. Every read past the declared end lands in whatever
 * the rebuild links next, compiles, and runs wrong.
 */

import { NodeKind } from '@ghidra-mcp/cpp-parser';
import {
  arrayLength, elementType, isArrayType, line, refName, signature, strip, typeText, unparen, walk,
} from '../ast.js';
import type { Check, Finding, LintContext, Resolved } from '../context.js';
import type { FunctionInfo } from '../tree.js';

const WIDTH_MASKS = new Set([0xff, 0xffff, 0xffffffff]);

export interface Bound {
  max: number;
  why: string;
}

/** Is `name` written anywhere below `root` - assigned, stepped, or its address taken? */
function writes(root: any, name: string, except?: any): boolean {
  let hit = false;
  walk(root, (n: any) => {
    if (hit || n === except) return 'skip';
    if (n.kind === NodeKind.AssignExpr && refName(unparen(n.left)) === name) hit = true;
    else if ((n.kind === NodeKind.PostfixExpr || n.kind === NodeKind.UnaryExpr) &&
        ['++', '--', '&'].includes(n.operator) && refName(unparen(n.operand)) === name) hit = true;
    return undefined;
  });
  return hit;
}

const LOOP_KINDS = new Set<string>([NodeKind.ForStmt, NodeKind.WhileStmt, NodeKind.DoWhileStmt]);

/**
 * Can `name` change between entering `branch` and reaching `site`? A write that comes after
 * the site in source order does not reach it - unless a loop inside the branch carries it
 * back round, in which case any write in the branch counts.
 */
function writtenBeforeSite(parents: Map<any, any>, branch: any, site: any, name: string): boolean {
  for (let p = parents.get(site); p && p !== branch; p = parents.get(p)) {
    if (LOOP_KINDS.has(p.kind)) return writes(branch, name);
  }
  let reached = false;
  let hit = false;
  walk(branch, (n: any) => {
    if (reached || hit) return 'skip';
    if (n === site) { reached = true; return 'skip'; }
    if (n.kind === NodeKind.AssignExpr && refName(unparen(n.left)) === name) hit = true;
    else if ((n.kind === NodeKind.PostfixExpr || n.kind === NodeKind.UnaryExpr) &&
        ['++', '--', '&'].includes(n.operator) && refName(unparen(n.operand)) === name) hit = true;
    return undefined;
  });
  return hit;
}

/** Upper bounds `name` gets from one relational conjunct that holds when it is true. */
function boundFromCondition(ctx: LintContext, fn: FunctionInfo, cond: any, name: string): number | null {
  const c = unparen(cond);
  if (!c) return null;
  if (c.kind === NodeKind.BinaryExpr && c.operator === '&&') {
    const a = boundFromCondition(ctx, fn, c.left, name);
    const b = boundFromCondition(ctx, fn, c.right, name);
    return a === null ? b : b === null ? a : Math.min(a, b);
  }
  if (c.kind !== NodeKind.BinaryExpr) return null;
  const l = strip(c.left);
  const r = strip(c.right);
  let op = c.operator as string;
  let k: number | null = null;
  if (refName(l) === name) k = ctx.value(fn, c.right);
  else if (refName(r) === name) {
    k = ctx.value(fn, c.left);
    op = ({ '>': '<', '>=': '<=', '<': '>', '<=': '>=' } as Record<string, string>)[op] ?? op;
  }
  if (k === null) return null;
  if (op === '<') return k - 1;
  if (op === '<=') return k;
  return null;
}

/** The for-loop bound of a loop variable, when the site sits inside that loop. */
function loopBound(ctx: LintContext, fn: FunctionInfo, loop: any, name: string): Bound | null {
  let init: number | null = null;
  const i = loop.init;
  if (i?.kind === NodeKind.ExprStmt && i.expression?.kind === NodeKind.AssignExpr && i.expression.operator === '=' &&
      refName(unparen(i.expression.left)) === name) init = ctx.value(fn, i.expression.right);
  else if (i?.kind === NodeKind.DeclStmt) {
    const d = (i.declarations ?? []).find((x: any) => (typeof x.name === 'string' ? x.name : x.name?.name) === name);
    if (d?.initializer) init = ctx.value(fn, d.initializer);
  }
  if (init === null) return null;
  const inc = unparen(loop.increment);
  let dir = 0;
  if ((inc?.kind === NodeKind.PostfixExpr || inc?.kind === NodeKind.UnaryExpr) && refName(unparen(inc.operand)) === name) {
    dir = inc.operator === '++' ? 1 : inc.operator === '--' ? -1 : 0;
  } else if (inc?.kind === NodeKind.AssignExpr && refName(unparen(inc.left)) === name) {
    const s = ctx.value(fn, inc.right);
    if (s !== null && s > 0) dir = inc.operator === '+=' ? 1 : inc.operator === '-=' ? -1 : 0;
  }
  if (!dir || writes(loop.body, name)) return null;
  if (dir > 0) {
    const b = boundFromCondition(ctx, fn, loop.condition, name);
    return b === null ? null : { max: Math.max(b, init), why: `loop ${name} < ${b + 1}` };
  }
  // Counting down: the largest value is where it starts.
  return { max: init, why: `loop ${name} from ${init} down` };
}

/**
 * The largest value `name` can have at `site`, from the constructs that enclose it:
 * a for-loop over it, an if whose condition bounds it, or the switch case it sits in.
 */
function variableBound(ctx: LintContext, fn: FunctionInfo, parents: Map<any, any>, site: any, name: string): Bound | null {
  let best: Bound | null = null;
  const take = (b: Bound | null) => { if (b && (!best || b.max < best.max)) best = b; };
  let child = site;
  for (let p = parents.get(site); p; child = p, p = parents.get(p)) {
    if (p.kind === NodeKind.ForStmt && child !== p.init) {
      take(loopBound(ctx, fn, p, name));
    } else if (p.kind === NodeKind.IfStmt && child === p.thenBranch) {
      const k = boundFromCondition(ctx, fn, p.condition, name);
      if (k !== null && !writtenBeforeSite(parents, p.thenBranch, site, name)) take({ max: k, why: `guard ${name} <= ${k}` });
    } else if (p.kind === NodeKind.SwitchStmt && child === p.body && refName(strip(p.condition)) === name) {
      take(caseBound(ctx, fn, p, site, name));
    }
  }
  return best;
}

/**
 * Inside a switch on `name`, every label from the top of the body down to the site's region
 * could be the value on entry (fallthrough), so their maximum bounds it - unless a default
 * precedes the site or the body writes the variable.
 */
function caseBound(ctx: LintContext, fn: FunctionInfo, sw: any, site: any, name: string): Bound | null {
  const body = sw.body;
  if (body?.kind !== NodeKind.CompoundStmt || writes(body, name)) return null;
  let max: number | null = null;
  let found = false;
  const labelsOf = (st: any): boolean => {
    for (let s = st; s;) {
      if (s.kind === NodeKind.CaseStmt) {
        const v = ctx.value(fn, s.value);
        if (v === null) return false;
        max = max === null ? v : Math.max(max, v);
        s = s.statement;
      } else if (s.kind === NodeKind.DefaultStmt) return false;
      else break;
    }
    return true;
  };
  for (const st of body.statements) {
    if (!labelsOf(st)) return null;
    let inside = false;
    walk(st, (n) => { if (n === site) inside = true; return inside ? 'skip' : undefined; });
    if (inside) { found = true; break; }
  }
  if (!found || max === null) return null;
  return { max, why: `case ${name} <= ${max}` };
}

/**
 * A bound on a whole EXPRESSION from an enclosing guard that compares the same expression:
 * `if ((nAnimMode & 0xf) < 0xe) return tbl[(nAnimMode & 0xf) * 2];` proves 13, where the
 * mask alone says 15. Matched by location-free signature, never by text.
 */
function guardBound(ctx: LintContext, fn: FunctionInfo, parents: Map<any, any>, e: any, site: any): Bound | null {
  const want = signature(strip(e));
  const names: string[] = [];
  walk(e, (n: any) => { if (n.kind === NodeKind.Identifier) names.push(n.name); });
  let best: Bound | null = null;
  const conjuncts = (c: any, out: any[]) => {
    const u = unparen(c);
    if (u?.kind === NodeKind.BinaryExpr && u.operator === '&&') { conjuncts(u.left, out); conjuncts(u.right, out); }
    else if (u) out.push(u);
    return out;
  };
  let child = site;
  for (let p = parents.get(site); p; child = p, p = parents.get(p)) {
    if (p.kind !== NodeKind.IfStmt || child !== p.thenBranch) continue;
    if (names.some(n => writtenBeforeSite(parents, p.thenBranch, site, n))) continue;
    for (const c of conjuncts(p.condition, [])) {
      if (c.kind !== NodeKind.BinaryExpr) continue;
      let op = c.operator as string;
      let k: number | null = null;
      if (signature(strip(c.left)) === want) k = ctx.value(fn, c.right);
      else if (signature(strip(c.right)) === want) {
        k = ctx.value(fn, c.left);
        op = ({ '>': '<', '>=': '<=' } as Record<string, string>)[op] ?? '';
      }
      if (k === null) continue;
      const max = op === '<' ? k - 1 : op === '<=' ? k : null;
      if (max !== null && (!best || max < best.max)) best = { max, why: `guard <= ${max}` };
    }
  }
  return best;
}

/** The largest value `e` can take at `site`, when the code proves one. Null when unbounded. */
export function indexBound(ctx: LintContext, fn: FunctionInfo, parents: Map<any, any>, e: any, site: any): Bound | null {
  const k = ctx.value(fn, e);
  if (k !== null) return { max: k, why: 'constant' };
  const shape = shapeBound(ctx, fn, parents, e, site);
  const guard = guardBound(ctx, fn, parents, e, site);
  return !guard ? shape : !shape ? guard : guard.max < shape.max ? guard : shape;
}

function shapeBound(ctx: LintContext, fn: FunctionInfo, parents: Map<any, any>, e: any, site: any): Bound | null {
  const s = unparen(e);
  if (!s) return null;
  switch (s.kind) {
    case NodeKind.CStyleCastExpr: case NodeKind.StaticCastExpr: case NodeKind.ReinterpretCastExpr:
      return indexBound(ctx, fn, parents, s.expression, site);
    case NodeKind.Identifier:
    case NodeKind.QualifiedId: {
      const n = refName(s);
      return n ? variableBound(ctx, fn, parents, site, n) : null;
    }
    case NodeKind.ConditionalExpr: {
      const a = indexBound(ctx, fn, parents, s.thenExpr, site);
      const b = indexBound(ctx, fn, parents, s.elseExpr, site);
      return a && b ? (a.max >= b.max ? a : b) : null;
    }
    case NodeKind.BinaryExpr: {
      const rk = ctx.value(fn, s.right);
      const lk = ctx.value(fn, s.left);
      if (s.operator === '&') {
        const m = rk ?? lk;
        // `& 0xff` / `& 0xffff` is how Ghidra spells a MOVZX - a width, not a table size.
        if (m !== null && WIDTH_MASKS.has(m >>> 0)) return indexBound(ctx, fn, parents, rk !== null ? s.left : s.right, site);
        if (m !== null && m >= 0) {
          const other = indexBound(ctx, fn, parents, rk !== null ? s.left : s.right, site);
          return other && other.max >= 0 && other.max < m ? other : { max: m, why: `& 0x${m.toString(16)}` };
        }
        return null;
      }
      if (s.operator === '%' && rk !== null && rk > 0) return { max: rk - 1, why: `% ${rk}` };
      const a = indexBound(ctx, fn, parents, s.left, site);
      if (!a) return null;
      if (s.operator === '>>' && rk !== null) return { max: Math.floor(a.max / 2 ** rk), why: `${a.why} >> ${rk}` };
      if (s.operator === '-' && rk !== null) return { max: a.max - rk, why: `${a.why} - ${rk}` };
      const b = indexBound(ctx, fn, parents, s.right, site);
      if (!b) return null;
      if (s.operator === '+') return { max: a.max + b.max, why: `${a.why} + ${b.why}` };
      if (s.operator === '*' && a.max >= 0 && b.max >= 0) return { max: a.max * b.max, why: `${a.why} * ${b.why}` };
      return null;
    }
    default:
      return null;
  }
}

/** An array object that outlives the frame: a global, a file-scope variable, a static local. */
function staticArray(r: Resolved | null): boolean {
  if (!r || !isArrayType(r.type)) return false;
  if (r.kind === 'global' || r.kind === 'file') return true;
  return r.kind === 'local' && r.entry.isStatic;
}

/**
 * A global, file-scope or static-local ARRAY indexed past its declared length, where the
 * index's range is proven by the code: a constant, a mask (`& 0xf`), a modulus, a for-loop
 * bound, an enclosing `if (i < N)`, or the case labels of a switch on the index.
 *
 * The shape that hid SStrHash's table for a release: `static int gnHashLowTable[5]` read with
 * `gnHashLowTable[nChar & 0xf]`. Ghidra had two stray labels inside the real sixteen-dword
 * table, the emitter sized the array to the first of them, and entries 5..15 read whatever
 * the rebuild linked next - so string hashes drifted at runtime and the COF cache missed.
 *
 * `&a[N]` (one past the end) is a legal address and is not reported; `a[N]` is. Stack
 * arrays are oob-local-access's, except that a CONSTANT index on one is left to it.
 */
export const arrayIndexRange: Check = {
  id: 'array-index-range',
  blurb: 'array indexed past its declared length by a provable index range - a stray label truncated it',
  run(ctx) {
    const out: Finding[] = [];
    for (const fn of ctx.tree.functions) {
      const subs = ctx.of(fn, NodeKind.SubscriptExpr);
      if (!subs.length) continue;
      let parents: Map<any, any> | null = null;
      for (const s of subs) {
        parents ??= (() => { const m = new Map<any, any>(); walk((fn.node as any).body, (n, p) => { m.set(n, p); }); return m; })();
        const p = parents.get(s);
        if (p?.kind === NodeKind.SubscriptExpr && p.array === s) continue;
        let cur: any = s;
        const indices: any[] = [];
        while (cur?.kind === NodeKind.SubscriptExpr) { indices.unshift(cur.index); cur = unparen(cur.array); }
        const base = refName(cur);
        if (!base) continue;
        const r = ctx.resolve(fn, cur);
        if (!r || !isArrayType(r.type)) continue;
        const isStatic = staticArray(r);
        if (!isStatic && r.kind !== 'local') continue;
        let up = parents.get(s);
        while (up?.kind === NodeKind.ParenExpr) up = parents.get(up);
        const addressOnly = up?.kind === NodeKind.UnaryExpr && up.operator === '&';
        // Ghidra flattens a 2-D access: `tbl[0x55][(g & 0x7f) + 2]` on a [128][6] table is
        // element 512 + (g & 0x7f) of the whole object. Past a DIMENSION but inside the
        // object is the dims-transposed shape, not a truncation - judge it by the flat extent.
        if (indices.length > 1) {
          const dims: number[] = [];
          for (let u = r.type; isArrayType(u); u = elementType(u)) dims.push(arrayLength(u) ?? NaN);
          if (dims.length >= indices.length && dims.every(Number.isFinite)) {
            let flat = 0;
            let ok = true;
            for (let i = 0; i < indices.length && ok; i++) {
              const b = indexBound(ctx, fn, parents, indices[i], s);
              if (!b) { ok = false; break; }
              flat = flat * dims[i] + b.max;
            }
            const total = dims.slice(0, indices.length).reduce((a, b) => a * b, 1);
            if (ok && flat < total) continue;
          }
        }
        let t = r.type;
        for (let i = 0; i < indices.length && isArrayType(t); i++) {
          const len = arrayLength(t);
          const b = len === null ? null : indexBound(ctx, fn, parents, indices[i], s);
          const last = i === indices.length - 1;
          // A constant index on a stack array is oob-local-access's finding.
          if (b && len !== null && !(r.kind === 'local' && !isStatic && b.why === 'constant') &&
              (b.max > len || (b.max === len && !(last && addressOnly)))) {
            out.push({
              check: this.id, file: fn.file.path, line: line(s), fn: fn.qualifiedName, subject: base,
              detail: `${base}${'[..]'.repeat(i)}[<= ${b.max}] (${b.why}) but declared ${typeText(r.type)} ` +
                `(${r.kind === 'local' ? (isStatic ? 'static local' : 'local') : r.kind})`,
              sig: signature(s),
            });
            break;
          }
          t = elementType(t);
        }
      }
    }
    return out;
  },
};
