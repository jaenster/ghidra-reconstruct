/**
 * Parameter reach: the bytes a function's body can touch through each pointer parameter,
 * as a byte range relative to the address the caller passed.
 *
 * The question comes from the caller. `frame-group-locals` keeps a run of stack locals
 * together when the address of the first one is handed to a callee that reaches past it
 * by byte offset. Whether the callee does is a fact about the callee's BODY: its declared
 * parameter type cannot be trusted - `RENDERER_WINDOWED_DrawLineBresenham(int *, int *)`
 * reads `pnStartPoint[1]`, eight bytes through an `int *` - and a callee that only
 * stores one word through each of two out-parameters (`f(&x, &y)`) reaches nothing past
 * either local.
 *
 * Every mention of the parameter is followed outward through the expressions that derive
 * an address from it:
 *   - a cast to a pointer type changes the pointee (and with it the scale of `+ k` and
 *     `[k]`); a cast to a 32-bit integer makes later `+ k` count bytes;
 *   - `+ k` / `- k` with a literal `k` moves the offset; any other arithmetic, an
 *     assignment of the address anywhere, a `return` of it, or a store of it is an
 *     ESCAPE - the analysis cannot follow it and the reach is unknown;
 *   - `*e`, `e[k]` with a literal `k`, and `e->field` with a field the model knows are
 *     the object at an offset; reading or writing it touches that range, `&` of it is a
 *     new derived address, and `.field` / `[k]` into it narrow it;
 *   - `e[i]` with a non-literal index is unknown (an array the caller's slot sizes say
 *     nothing about);
 *   - passed as an argument, the callee's own reach at that position applies, shifted by
 *     the offset - asked through the context, which resolves names, recurses and decides
 *     what an unknown or recursive callee answers. A computed callee is unknown;
 *   - compared, tested, or discarded: nothing is touched.
 * A parameter that is reassigned, incremented or has its own address taken is unknown.
 *
 * Unknown is the safe answer everywhere: it means "reaches everything", which keeps the
 * caller's group exactly as it was.
 */

import { NodeKind } from '../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, CallExpr, CommaExpr, ConditionalExpr, Expression, Identifier,
  IntegerLiteralExpr, MemberExpr, SubscriptExpr, UnaryExpr, TypeNode,
} from '../../ast/nodes.js';
import { emit } from '../../emit/index.js';
import { traverseAST, getChildren } from '../../ast/visitor.js';
import { calleeSpelling } from './out-param.js';

/** Bytes `[lo, hi)` relative to the passed address; null = unknown (reaches everything). */
export type Reach = { lo: number; hi: number } | null;

/** A reach that touches nothing. */
export const NO_REACH: Readonly<{ lo: number; hi: number }> = Object.freeze({ lo: 0, hi: 0 });

export interface ReachField {
  offset: number;
  /** The field's type as Ghidra spells it (`int`, `char[16]`, `D2UnitStrc *`). */
  type: string;
}

export interface ParamReachContext {
  /** Bytes a value of the spelled type occupies, or null when unknown. Arrays need not be handled. */
  typeSize: (spelling: string) => number | null;
  /** A field of the spelled aggregate, or null when the model does not know it. */
  field: (aggregate: string, member: string) => ReachField | null;
  /**
   * The reach of `callee`'s parameter `index` for a call with `argCount` arguments, or null
   * when it is not known. Counted sinks (`memset(p, 0, 16)`) are answered before this is asked.
   */
  calleeReach: (callee: string, index: number, argCount: number) => Reach;
}

export interface ReachParam {
  /** The name the body uses; `this` matches the `this` keyword. */
  name: string;
  /** The parameter's declared type as Ghidra spells it. */
  type: string;
}

/**
 * Calls whose reach through a pointer argument is a LITERAL byte count at the call:
 * `memset(p, 0, 16)` touches `[0, 16)` of `p`. `args` are the pointer positions,
 * `count` the count's position, `times` a second count multiplied in (`fread`).
 * Matched on the callee's last name component, with one leading underscore allowed
 * (`_memset` is the CRT's spelling).
 */
const COUNTED_REACH: Readonly<Record<string, { args: number[]; count: number; times?: number }>> = {
  memset: { args: [0], count: 2 },
  memcpy: { args: [0, 1], count: 2 },
  memmove: { args: [0, 1], count: 2 },
  memcmp: { args: [0, 1], count: 2 },
  bzero: { args: [0], count: 1 },
  bcopy: { args: [0, 1], count: 2 },
  ZeroMemory: { args: [0], count: 1 },
  RtlZeroMemory: { args: [0], count: 1 },
  FillMemory: { args: [0], count: 1 },
  RtlFillMemory: { args: [0], count: 1 },
  CopyMemory: { args: [0, 1], count: 2 },
  RtlCopyMemory: { args: [0, 1], count: 2 },
  MoveMemory: { args: [0, 1], count: 2 },
  RtlMoveMemory: { args: [0, 1], count: 2 },
  builtin_memcpy: { args: [0, 1], count: 2 },
  fread: { args: [0], count: 1, times: 2 },
  fwrite: { args: [0], count: 1, times: 2 },
};

const MAX_COUNT = 0x100000;

function literalValue(e: Expression | undefined): number | null {
  if (!e) return null;
  let x: Expression = e;
  for (;;) {
    if (x.kind === NodeKind.ParenExpr) { x = (x as unknown as { expression: Expression }).expression; continue; }
    if (x.kind === NodeKind.CStyleCastExpr) { x = (x as unknown as { expression: Expression }).expression; continue; }
    break;
  }
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
    const v = literalValue((x as UnaryExpr).operand);
    return v === null ? null : -v;
  }
  if (x.kind !== NodeKind.IntegerLiteral) return null;
  const n = Number((x as IntegerLiteralExpr).value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The reach of a counted sink at argument `index`, `undefined` when `name` is not one,
 * null when it is one but the count is not a literal.
 */
export function countedSinkReach(name: string, index: number, args: readonly Expression[]): Reach | undefined {
  const base = name.split('::').pop() ?? name;
  const sink = COUNTED_REACH[base] ?? (base.startsWith('_') ? COUNTED_REACH[base.slice(1)] : undefined);
  if (!sink || !sink.args.includes(index)) return undefined;
  let count = literalValue(args[sink.count]);
  if (count === null || count < 0) return null;
  if (sink.times !== undefined) {
    const times = literalValue(args[sink.times]);
    if (times === null || times < 0) return null;
    count *= times;
  }
  if (!Number.isSafeInteger(count) || count > MAX_COUNT) return null;
  return { lo: 0, hi: count };
}

/** The type spelling a cast or declaration carries, normalised. */
function spell(type: TypeNode): string {
  return emit(type as never).replace(/\s+/g, ' ').trim();
}

/** `X *` -> `X`, else null. */
function pointeeOf(spelling: string): string | null {
  const m = /^(.*\S)\s*\*$/.exec(spelling.trim());
  return m ? m[1].trim() : null;
}

/** `T[4][2]` -> { elem: `T[2]`, count: 4 }, else null. Ghidra prints the outer dimension first. */
function arrayOf(spelling: string): { elem: string; count: number } | null {
  const m = /^([^[]*\S)\s*\[(\d+)\](.*)$/.exec(spelling.trim());
  if (!m) return null;
  return { elem: `${m[1]}${m[3]}`.trim(), count: Number(m[2]) };
}

/** Strip cv-qualifiers, `struct`/`union`, a leading `::` and the namespace path. */
function aggregateName(spelling: string): string {
  const s = spelling.replace(/\b(const|volatile|struct|union|class)\b/g, ' ').replace(/\s+/g, ' ').trim().replace(/^::/, '');
  return s.split('::').pop() ?? s;
}

/** An address derived from the parameter: `off` bytes past it, pointing at `pointee` (null = an integer). */
interface Derived { off: number; pointee: string | null }

/** An object reached through the parameter: `type` at `off`. */
interface Place { off: number; type: string }

const COMPARISON = new Set(['==', '!=', '<', '>', '<=', '>=', '&&', '||']);

class Unknown extends Error {}

/**
 * How `paramReaches` treats the uses of a name. The defaults answer the caller's question
 * about a parameter; the options turn the same machinery on a local POINTER whose value
 * the caller tracks itself (the alias-reach lint: `p = aBuf; ... p += 3; p[2] = x`).
 */
export interface ReachOptions {
  /**
   * Only the uses this accepts are followed; every other mention of the name is ignored,
   * neither touched nor unknown. The caller excludes the assignments and steps it models.
   */
  include?: (use: ASTNode) => boolean;
  /**
   * An unfollowable use is skipped instead of making the whole reach unknown, so the
   * answer is a LOWER bound: what the followed uses are known to touch.
   */
  partial?: boolean;
  /** Each followed use with the range that use alone touches; null when it cannot be followed. */
  onUse?: (use: ASTNode, reach: Reach) => void;
}

/**
 * Per parameter, the byte range the body reaches through it. `body` is the function body
 * (or any node containing it); the parameters are matched by name.
 */
export function paramReaches(
  body: ASTNode, params: readonly ReachParam[], ctx: ParamReachContext, opts: ReachOptions = {},
): Reach[] {
  const parents = new Map<ASTNode, ASTNode>();
  for (const node of traverseAST(body)) for (const ch of getChildren(node)) parents.set(ch, node);

  const sizeOf = (spelling: string): number | null => {
    const arr = arrayOf(spelling);
    if (arr) {
      const e = sizeOf(arr.elem);
      return e === null ? null : e * arr.count;
    }
    const s = spelling.replace(/\b(const|volatile)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (s === 'undefined') return 1;
    return ctx.typeSize(s);
  };
  const scaleOf = (d: Derived): number => {
    if (d.pointee === null) return 1;
    const s = sizeOf(d.pointee);
    if (s === null || s <= 0) throw new Unknown();
    return s;
  };
  const parentOf = (n: ASTNode): ASTNode | undefined => parents.get(n);

  return params.map(param => {
    let lo = Infinity;
    let hi = -Infinity;
    let useLo = Infinity;
    let useHi = -Infinity;
    const touch = (from: number, to: number) => {
      if (to <= from) return;
      lo = Math.min(lo, from);
      hi = Math.max(hi, to);
      useLo = Math.min(useLo, from);
      useHi = Math.max(useHi, to);
    };

    /** An object at `place`, reached through `node`: what its context does with it. */
    const usePlace = (node: ASTNode, place: Place): void => {
      let cur = node;
      let parent = parentOf(cur);
      while (parent && parent.kind === NodeKind.ParenExpr) { cur = parent; parent = parentOf(cur); }
      const size = (): number => {
        const s = sizeOf(place.type);
        if (s === null || s <= 0) throw new Unknown();
        return s;
      };
      if (parent?.kind === NodeKind.UnaryExpr && (parent as UnaryExpr).operator === '&') {
        climb(parent, { off: place.off, pointee: place.type });
        return;
      }
      if (parent?.kind === NodeKind.MemberExpr && (parent as MemberExpr).object === cur && !(parent as MemberExpr).isArrow) {
        const m = parent as MemberExpr;
        if (m.member.kind !== NodeKind.Identifier) throw new Unknown();
        const f = ctx.field(aggregateName(place.type), (m.member as Identifier).name);
        if (!f) throw new Unknown();
        usePlace(parent, { off: place.off + f.offset, type: f.type });
        return;
      }
      const arr = arrayOf(place.type);
      if (arr) {
        if (parent?.kind === NodeKind.SubscriptExpr && (parent as SubscriptExpr).array === cur) {
          const k = literalValue((parent as SubscriptExpr).index);
          const es = sizeOf(arr.elem);
          if (k === null || es === null) { touch(place.off, place.off + size()); return; }
          usePlace(parent, { off: place.off + k * es, type: arr.elem });
          return;
        }
        // An array in any other position decays to the address of its first element.
        climb(cur, { off: place.off, pointee: arr.elem });
        return;
      }
      touch(place.off, place.off + size());
    };

    /** An address `d` produced by `node`: follow it outward to whatever consumes it. */
    const climb = (node: ASTNode, start: Derived): void => {
      let cur = node;
      let d = start;
      for (;;) {
        const p = parentOf(cur);
        if (!p) return;
        switch (p.kind) {
          case NodeKind.ParenExpr:
            cur = p;
            continue;
          case NodeKind.CStyleCastExpr:
          case NodeKind.StaticCastExpr:
          case NodeKind.ReinterpretCastExpr: {
            const t = spell((p as unknown as { type: TypeNode }).type);
            const pointee = pointeeOf(t);
            if (pointee !== null) d = { off: d.off, pointee };
            else if (sizeOf(t) === 4) d = { off: d.off, pointee: null };
            else throw new Unknown();
            cur = p;
            continue;
          }
          case NodeKind.BinaryExpr: {
            const b = p as BinaryExpr;
            if (COMPARISON.has(b.operator)) return;
            const other = b.left === cur ? b.right : b.left;
            if (b.operator === '+' || (b.operator === '-' && b.left === cur)) {
              const k = literalValue(other);
              if (k === null) throw new Unknown();
              d = { off: d.off + (b.operator === '+' ? k : -k) * scaleOf(d), pointee: d.pointee };
              cur = p;
              continue;
            }
            throw new Unknown();
          }
          case NodeKind.UnaryExpr: {
            const u = p as UnaryExpr;
            if (u.operator === '!') return;
            if (u.operator === '+') { cur = p; continue; }
            if (u.operator === '*') {
              if (d.pointee === null) throw new Unknown();
              usePlace(p, { off: d.off, type: d.pointee });
              return;
            }
            throw new Unknown();
          }
          case NodeKind.SubscriptExpr: {
            const s = p as SubscriptExpr;
            if (s.array !== cur || d.pointee === null) throw new Unknown();
            const k = literalValue(s.index);
            if (k === null) throw new Unknown();
            usePlace(p, { off: d.off + k * scaleOf(d), type: d.pointee });
            return;
          }
          case NodeKind.MemberExpr: {
            const m = p as MemberExpr;
            if (m.object !== cur || !m.isArrow || d.pointee === null) throw new Unknown();
            if (m.member.kind !== NodeKind.Identifier) throw new Unknown();
            const f = ctx.field(aggregateName(d.pointee), (m.member as Identifier).name);
            if (!f) throw new Unknown();
            usePlace(p, { off: d.off + f.offset, type: f.type });
            return;
          }
          case NodeKind.CallExpr: {
            const c = p as CallExpr;
            const index = c.arguments.indexOf(cur as Expression);
            if (index < 0) throw new Unknown();            // called through, or a callee expression
            const name = calleeSpelling(c);
            if (!name) throw new Unknown();
            const counted = countedSinkReach(name, index, c.arguments);
            const r = counted !== undefined ? counted : ctx.calleeReach(name, index, c.arguments.length);
            if (r === null) throw new Unknown();
            touch(d.off + r.lo, d.off + r.hi);
            return;
          }
          case NodeKind.ConditionalExpr:
            if ((p as ConditionalExpr).condition === cur) return;
            throw new Unknown();
          case NodeKind.CommaExpr: {
            const list = (p as CommaExpr).expressions;
            if (list[list.length - 1] !== cur) return;
            cur = p;
            continue;
          }
          case NodeKind.ExprStmt:
            return;
          case NodeKind.IfStmt:
          case NodeKind.WhileStmt:
          case NodeKind.DoWhileStmt:
          case NodeKind.ForStmt:
          case NodeKind.SwitchStmt:
            if ((p as unknown as { condition?: unknown }).condition === cur) return;
            throw new Unknown();
          default:
            // Assigned, returned, stored, initialised from: it leaves the analysis.
            throw new Unknown();
        }
      }
    };

    const declared = param.type.trim();
    const pointee = pointeeOf(declared);
    const initial: Derived | null = pointee !== null ? { off: 0, pointee }
      : sizeOf(declared) === 4 ? { off: 0, pointee: null } : null;

    try {
      for (const node of traverseAST(body)) {
        const isUse = param.name === 'this'
          ? node.kind === NodeKind.ThisExpr
          : node.kind === NodeKind.Identifier && (node as Identifier).name === param.name;
        if (!isUse) continue;
        const parent = parentOf(node);
        // A member NAME spelled like the parameter (`q->pUnit`) is not a use.
        if (parent && parent.kind === NodeKind.MemberExpr && (parent as MemberExpr).member === node) continue;
        if (opts.include && !opts.include(node)) continue;
        useLo = Infinity;
        useHi = -Infinity;
        try {
          // Its own declaration (a body that redeclares the name) is not a use.
          if (parent && (parent.kind === NodeKind.VariableDecl || parent.kind === NodeKind.ParameterDecl)
              && (parent as unknown as { name?: unknown }).name === node) throw new Unknown();
          if (parent && parent.kind === NodeKind.AssignExpr && (parent as unknown as { left: ASTNode }).left === node) throw new Unknown();
          if (parent && (parent.kind === NodeKind.PostfixExpr
              || (parent.kind === NodeKind.UnaryExpr && ['++', '--', '&'].includes((parent as UnaryExpr).operator)))) {
            throw new Unknown();
          }
          if (!initial) throw new Unknown();
          climb(node, initial);
        } catch (e) {
          if (!(e instanceof Unknown) || !opts.partial) throw e;
          opts.onUse?.(node, null);
          continue;
        }
        opts.onUse?.(node, useLo === Infinity ? { ...NO_REACH } : { lo: useLo, hi: useHi });
      }
    } catch (e) {
      if (e instanceof Unknown) return null;
      throw e;
    }
    return lo === Infinity ? { ...NO_REACH } : { lo, hi };
  });
}
