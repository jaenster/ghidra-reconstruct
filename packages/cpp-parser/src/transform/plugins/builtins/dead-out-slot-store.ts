/**
 * A store into a local that the next call overwrites through its address before anything
 * reads it - the `PUSH ECX` slot idiom.
 *
 * MSVC reserves a 4-byte local with `PUSH ECX` instead of `SUB ESP,4`; the push also
 * stores ECX (or whatever register) into the new slot, and the decompiler prints that
 * store as an assignment of a parameter to the local:
 *
 *     pNewBigInt = pData;                 // SHA1_FromBigIntBytes 0052a270: PUSH ECX
 *     SBigNew(&pNewBigInt);               // writes *ppBigData on every path
 *
 * The original source had no such assignment. It costs a cast between unrelated types
 * (`BigData* pNewBigInt = (BigData*)pData`) and reads as data flow that is not there.
 *
 * The pseudo-C cannot tell that store from an assignment the source made (a real
 * `int n = 0; f(&n);` compiles to a store too, and MSVC keeps it: f is in another unit).
 * The instructions can: the store is the push's when x lives in a slot the prologue
 * reserved with `PUSH reg` while reg held the parameter e (`pushSlotInits`, read by
 * reconstruct/extract/prologue-slots.ts). Only then is it a candidate, and it is dropped
 * when, in the same block,
 *   - x is a local of the function (not a parameter, not a global) of a known width w,
 *   - e is that parameter (under casts),
 *   - the next statement makes a call `f(..., &x, ...)` (casts around `&x` allowed) as the
 *     first thing it evaluates - the whole expression statement, the right side of a plain
 *     assignment or initializer, a return value, or an if/switch condition - with no other
 *     mention of x anywhere in that statement,
 *   - f's parameter at that position is an out-parameter of width >= w, proven from f's
 *     own body (cfg/out-param.ts): every returning path of f writes through it before
 *     reading through it.
 * Then the value e put in x is never read: the call overwrites all of x first. Nothing
 * else changes.
 *
 * The call need not be the next statement when nothing but such calls ever reads x: every
 * mention of x in the function other than the store is `&x` passed at an out-parameter
 * position of width >= w (the other arguments pure). The slot then only ever reaches
 * callees that write it before they read it, wherever and however often they run:
 *
 *     pOperationArg = pOperation;          // OBJOP_A3Q2_KhalimsRelicPortalDrop1 005b8860
 *     ...                                  // PUSH ECX
 *     do { ITEM_RewardItemToDrop(..., (int32_t*)&pOperationArg, ...); } while (...);
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CompoundStmt, CStyleCastExpr, DeclStmt, Expression, ExprStmt,
  FunctionDecl, Identifier, IfStmt, ParameterDecl, ParenExpr, ReturnStmt, Statement, SwitchStmt,
  UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { findNodesByKind, traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { calleeSpelling } from '../../cfg/out-param.js';
import { isPure } from './pseudo-op-lower.js';

export interface DeadOutSlotStoreOptions extends PluginOptions {
  /** A callee's out-parameter width at an argument position (from its body), or null. */
  outParamWidth?: (callee: string, index: number) => number | null;
  /** Bytes a value of the spelled type occupies, or null. */
  typeSize?: (spelling: string) => number | null;
  /**
   * Locals the prologue reserved with `PUSH reg` while the register held a parameter
   * (reconstruct/extract/prologue-slots.ts): only `local = value` for one of these is the
   * push's store. Absent or empty: nothing is dropped.
   */
  pushSlotInits?: ReadonlyArray<{ local: string; value: string }>;
  /** Called once per store dropped (for the run log). */
  onDrop?: (local: string, callee: string) => void;
}

const STATS_KEY = Symbol.for('ghidra-mcp:dead-out-slot-store-stats');
const STATS: { dropped: number } = ((globalThis as Record<symbol, unknown>)[STATS_KEY] ??= { dropped: 0 }) as { dropped: number };
export function getDeadOutSlotStoresDropped(): number { return STATS.dropped; }
export function resetDeadOutSlotStoresDropped(): void { STATS.dropped = 0; }

const unparen = (e: Expression): Expression => {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as ParenExpr).expression;
  return x;
};
const uncast = (e: Expression): Expression => {
  let x = unparen(e);
  while (x.kind === NodeKind.CStyleCastExpr) x = unparen((x as CStyleCastExpr).expression);
  return x;
};
/** `&x` under casts: x, else null. */
const addressOf = (e: Expression): string | null => {
  const x = uncast(e);
  if (x.kind !== NodeKind.UnaryExpr || (x as UnaryExpr).operator !== '&') return null;
  const o = unparen((x as UnaryExpr).operand);
  return o.kind === NodeKind.Identifier ? (o as Identifier).name : null;
};

/** The expression a statement evaluates first, when it is one call (or a call assigned). */
function leadingCall(s: Statement): CallExpr | null {
  let e: Expression | null = null;
  switch (s.kind) {
    case NodeKind.ExprStmt: e = (s as ExprStmt).expression; break;
    case NodeKind.ReturnStmt: e = (s as ReturnStmt).value; break;
    case NodeKind.IfStmt: e = (s as IfStmt).condition; break;
    case NodeKind.SwitchStmt: e = (s as SwitchStmt).condition; break;
    case NodeKind.DeclStmt: {
      const ds = (s as DeclStmt).declarations;
      const v = ds.length === 1 && ds[0].kind === NodeKind.VariableDecl ? ds[0] as VariableDecl : null;
      e = v?.initializer && v.initializer.kind !== NodeKind.InitListExpr ? v.initializer as Expression : null;
      break;
    }
    default: return null;
  }
  if (!e) return null;
  let x = uncast(e);
  if (x.kind === NodeKind.AssignExpr && (x as AssignExpr).operator === '=') x = uncast((x as AssignExpr).right);
  // `if (f(&x) == 0)`: the comparison's left operand is evaluated first.
  if (x.kind === NodeKind.BinaryExpr && ['==', '!=', '<', '>', '<=', '>='].includes((x as { operator: string }).operator)) {
    x = uncast((x as unknown as { left: Expression }).left);
  }
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '!') x = uncast((x as UnaryExpr).operand);
  return x.kind === NodeKind.CallExpr ? x as CallExpr : null;
}

function mentions(root: ASTNode, name: string): number {
  let n = 0;
  for (const x of traverseAST(root)) if (x.kind === NodeKind.Identifier && (x as Identifier).name === name) n++;
  return n;
}

function createDeadOutSlotStoreTransformer(options: DeadOutSlotStoreOptions): Transformer {
  const outParamWidth = options.outParamWidth;
  const typeSize = options.typeSize;
  const pushed = new Map((options.pushSlotInits ?? []).map(p => [p.local, p.value]));
  if (!outParamWidth || !typeSize || pushed.size === 0) return createTransformer({});
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const params = new Set(fn.parameters.map(p => (p as ParameterDecl).name?.name).filter((n): n is string => !!n));
      const localSize = new Map<string, number | null>();
      for (const d of findNodesByKind(fn.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (params.has(v.name.name)) continue;
        const spelled = emit(v.type as never).replace(/\s+/g, ' ').trim();
        localSize.set(v.name.name, localSize.has(v.name.name) ? null : typeSize(spelled));
      }
      const addressTaken = new Map<string, number>();
      for (const u of findNodesByKind(fn.body, NodeKind.UnaryExpr)) {
        const ux = u as UnaryExpr;
        if (ux.operator !== '&') continue;
        const o = unparen(ux.operand);
        if (o.kind === NodeKind.Identifier) addressTaken.set((o as Identifier).name, (addressTaken.get((o as Identifier).name) ?? 0) + 1);
      }
      // Locals nothing reads but the callees they are passed to: every mention other than
      // the push's store is `&x` as an argument at an out-parameter position of width >= w,
      // with the other arguments of that call pure. Whatever the order of the calls and
      // whichever runs, each one writes all of x before it reads it, and nothing else
      // reads x, so the value the push put there is never observed.
      const onlyOutArgs = new Set<string>();
      {
        const outArgs = new Map<string, number>();
        const refused = new Set<string>();
        for (const c of findNodesByKind(fn.body, NodeKind.CallExpr)) {
          const call = c as CallExpr;
          call.arguments.forEach((arg, at) => {
            const x = addressOf(arg);
            if (!x || !pushed.has(x)) return;
            const w = localSize.get(x);
            const callee = calleeSpelling(call);
            const width = callee ? outParamWidth(callee, at) : null;
            if (w === undefined || w === null || width === null || width < w
              || call.arguments.some((other, k) => k !== at && !isPure(other))) {
              refused.add(x);
              return;
            }
            outArgs.set(x, (outArgs.get(x) ?? 0) + 1);
          });
        }
        for (const [x, n] of outArgs) {
          // The store's own target is the one mention that is not an argument or a
          // declaration of x.
          const declared = findNodesByKind(fn.body, NodeKind.VariableDecl).filter(d => (d as VariableDecl).name.name === x).length;
          if (!refused.has(x) && addressTaken.get(x) === n && mentions(fn.body, x) === n + 1 + declared) onlyOutArgs.add(x);
        }
      }
      /** The callee when `next` is a call that overwrites all of x first, else null. */
      const overwrittenByNext = (next: Statement | undefined, x: string, w: number): string | null => {
        const call = next ? leadingCall(next) : null;
        const callee = call && calleeSpelling(call);
        if (!call || !callee) return null;
        const at = call.arguments.findIndex(arg => addressOf(arg) === x);
        if (at < 0 || mentions(next!, x) !== 1) return null;
        // Nothing can hold x's address but this argument (so neither the other
        // arguments nor the callee reach x another way), and the other arguments
        // call nothing.
        if (addressTaken.get(x) !== 1) return null;
        if (call.arguments.some((arg, k) => k !== at && !isPure(arg))) return null;
        const width = outParamWidth(callee, at);
        return width === null || width < w ? null : callee;
      };
      let changed = false;
      const rewriteBlock = createTransformer({
        visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
          const st = block.statements;
          let out: Statement[] | null = null;
          for (let i = 0; i < st.length; i++) {
            const s = st[i];
            if (s.kind !== NodeKind.ExprStmt) continue;
            const a = unparen((s as ExprStmt).expression);
            if (a.kind !== NodeKind.AssignExpr || (a as AssignExpr).operator !== '=') continue;
            const target = unparen((a as AssignExpr).left);
            if (target.kind !== NodeKind.Identifier) continue;
            const x = (target as Identifier).name;
            const w = localSize.get(x);
            if (w === undefined || w === null) continue;
            // Only the push's own store: the register's parameter into the pushed slot.
            const value = uncast((a as AssignExpr).right);
            if (value.kind !== NodeKind.Identifier || pushed.get(x) !== (value as Identifier).name) continue;
            const callee = overwrittenByNext(st[i + 1], x, w) ?? (onlyOutArgs.has(x) ? 'out-argument' : null);
            if (!callee) continue;
            out ??= [...st];
            out[i] = null as unknown as Statement;
            STATS.dropped++;
            options.onDrop?.(x, callee);
          }
          if (!out) return undefined;
          changed = true;
          return updateNode(block, { statements: out.filter(Boolean) });
        },
      });
      const body = rewriteBlock(fn.body) as FunctionDecl['body'];
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const deadOutSlotStorePlugin: TransformPlugin = {
  id: 'dead-out-slot-store',
  name: 'Dead Out-Slot Store',
  description: "Drop a local's store that the next call overwrites through its address before any read (PUSH reg slot idiom)",
  version: '1.0.0',
  defaultEnabled: true,
  priority: 12.5,
  tags: ['correctness', 'ghidra'],
  createTransformer: (o?: DeadOutSlotStoreOptions) => createDeadOutSlotStoreTransformer(o ?? {}),
};
