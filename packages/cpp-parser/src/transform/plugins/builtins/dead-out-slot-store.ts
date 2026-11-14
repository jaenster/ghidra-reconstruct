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
 *
 * Nor need a call overwrite x at all where a plain store does: the first later statement of
 * the function body's own list that names x is `x = e` with e not reading x, nothing earlier
 * names x and no label lies in between. x's address is first taken after it, so no call in
 * between reaches x, and the push's value is dead (UI_SLIDER_InitContrast 0047d2f0:
 * `nContrastVal = (int32_t)pItem;` then the default `nContrastVal = ... ? 100 : 0;` that
 * SRegLoadValue may keep).
 *
 * A scalar member store can also kill the whole value of a plain generated union
 * (SOUND_ApplyEAXEnvironment 00513c50). Require the next statement to write a member
 * at offset zero whose width equals the union's, and no earlier use/escape of the
 * local. This path accepts only complete arithmetic-member layouts, an automatic
 * uninitialised local and one whole-local assignment, in a function without loops,
 * labels, nested definitions or exceptional control flow. Later address uses are
 * fine: the member store has already replaced every byte they can observe.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CompoundStmt, CStyleCastExpr, DeclStmt, Expression, ExprStmt,
  FunctionDecl, Identifier, IfStmt, MemberExpr, ParameterDecl, ParenExpr, ReturnStmt, Statement, SwitchStmt,
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
  /** Generated aggregate declarations, including every emitted member. All are needed for a union kill. */
  unionNames?: readonly string[];
  aggregateSizes?: Readonly<Record<string, number>>;
  aggregateMembers?: Readonly<Record<string, readonly string[]>>;
  structLayouts?: Readonly<Record<string, ReadonlyArray<{ name: string; offset: number; size: number; type: string; bitSize?: number }>>>;
  convertingAggregates?: readonly string[];
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

/** A label or a case label anywhere in the statement: a place control can enter it. */
function hasLabel(root: ASTNode): boolean {
  for (const x of traverseAST(root)) {
    if (x.kind === NodeKind.LabelStmt || x.kind === NodeKind.CaseStmt || x.kind === NodeKind.DefaultStmt) return true;
  }
  return false;
}

function mentions(root: ASTNode, name: string): number {
  let n = 0;
  for (const x of traverseAST(root)) if (x.kind === NodeKind.Identifier && (x as Identifier).name === name) n++;
  return n;
}

// Deliberately no typedef guesses: an unknown spelling may hide volatile, a
// reference, or a class with an observable assignment/conversion. Width alone is
// not enough. The sound union's actual fields are `float` and `int`.
const ARITHMETIC = new Set([
  'bool', 'char', 'signed char', 'unsigned char', 'short', 'short int', 'signed short',
  'signed short int', 'unsigned short', 'unsigned short int', 'int', 'signed', 'signed int',
  'unsigned', 'unsigned int', 'long', 'long int', 'signed long', 'signed long int',
  'unsigned long', 'unsigned long int', 'long long', 'long long int', 'signed long long',
  'signed long long int', 'unsigned long long', 'unsigned long long int', '__int64',
  'unsigned __int64', 'float', 'double', 'long double',
]);

/** The names of unique PUSH copies immediately killed by a full-width union member store. */
function unionOverwrites(fn: FunctionDecl, options: DeadOutSlotStoreOptions, pushed: ReadonlyMap<string, string>): Set<string> {
  const result = new Set<string>();
  if (!fn.body || !options.typeSize || !options.unionNames?.length) return result;
  const nodes = [...traverseAST(fn.body)];
  // No backedge may bring an address escaped AFTER the kill back to its RHS.
  // Nor reason across nested bindings, opaque asm or alternate/exceptional entries.
  const unsupported = new Set([
    NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt,
    NodeKind.GotoStmt, NodeKind.LabelStmt, NodeKind.CaseStmt, NodeKind.DefaultStmt,
    NodeKind.FunctionDecl, NodeKind.MethodDecl, NodeKind.LambdaExpr, NodeKind.ClassDecl,
    NodeKind.StructDecl, NodeKind.UnionDecl, NodeKind.TypedefDecl, NodeKind.TypeAliasDecl,
    NodeKind.AsmDecl, NodeKind.MacroDecl, NodeKind.TryStmt, NodeKind.SehTryStmt, NodeKind.PpConditionalStmt,
    NodeKind.CoAwaitExpr, NodeKind.CoYieldExpr, NodeKind.CoReturnStmt,
  ]);
  if (nodes.some(n => unsupported.has(n.kind))) return result;
  const declarations = nodes.filter(n => n.kind === NodeKind.VariableDecl) as VariableDecl[];
  for (const d of fn.body.statements.filter(s => s.kind === NodeKind.DeclStmt) as DeclStmt[]) {
    for (const v of d.declarations) {
      if (v.kind !== NodeKind.VariableDecl) continue;
      const local = v as VariableDecl, x = local.name.name, parameter = pushed.get(x);
      if (!parameter || local.initializer || local.directInit || local.specifiers.length || local.attributes.length
        || declarations.filter(v => v.name.name === x).length !== 1
        || declarations.some(v => v.name.name === parameter)
        || fn.parameters.some(p => p.name?.name === x)) continue;
      const spelling = emit(local.type as never).replace(/\s+/g, ' ').trim();
      const union = spelling.replace(/^union /, '');
      if (!options.unionNames.includes(union) || options.convertingAggregates?.includes(union)) continue;
      const w = options.typeSize(spelling), fields = options.structLayouts?.[union], members = options.aggregateMembers?.[union];
      if (!w || options.aggregateSizes?.[union] !== w || !fields?.length || !members?.length
        || new Set(members).size !== members.length || fields.length !== members.length
        || fields.some(f => !members.includes(f.name)) || new Set(fields.map(f => f.name)).size !== fields.length
        || fields.some(f => f.bitSize !== undefined || f.offset !== 0 || f.size <= 0 || f.size > w
          || !ARITHMETIC.has(f.type) || options.typeSize!(f.type) !== f.size)) continue;
      const p = fn.parameters.find(p => p.name?.name === parameter);
      if (!p) continue;
      const pt = emit(p.type as never).replace(/\s+/g, ' ').trim();
      if ((!ARITHMETIC.has(pt) && !/^[\w: ]+\s*\*$/.test(pt)) || /\bvolatile\b/.test(pt)
        || options.typeSize(pt) !== w) continue;
      const assignments = nodes.filter(n => n.kind === NodeKind.AssignExpr
        && unparen((n as AssignExpr).left).kind === NodeKind.Identifier
        && (unparen((n as AssignExpr).left) as Identifier).name === x) as AssignExpr[];
      if (assignments.length !== 1) continue;
      const copy = assignments[0], target = unparen(copy.left);
      const firstUse = nodes.find(n => n.kind === NodeKind.Identifier && (n as Identifier).name === x && n !== local.name);
      if (firstUse !== target || copy.operator !== '=') continue;
      // Only a bare parameter or a single cast to this exact plain union, never
      // a conversion chain or a reference/class conversion with effects.
      let value = unparen(copy.right);
      if (value.kind === NodeKind.CStyleCastExpr) {
        const cast = value as CStyleCastExpr;
        if (emit(cast.type as never).replace(/\s+/g, ' ').trim() !== spelling) continue;
        value = unparen(cast.expression);
      }
      if (value.kind !== NodeKind.Identifier || (value as Identifier).name !== parameter) continue;
      for (const block of nodes.filter(n => n.kind === NodeKind.CompoundStmt) as CompoundStmt[]) {
        const i = block.statements.findIndex(s => s.kind === NodeKind.ExprStmt && unparen((s as ExprStmt).expression) === copy);
        const next = i >= 0 ? block.statements[i + 1] : undefined;
        if (next?.kind !== NodeKind.ExprStmt) continue;
        const a = unparen((next as ExprStmt).expression);
        if (a.kind !== NodeKind.AssignExpr || (a as AssignExpr).operator !== '=') continue;
        const lhs = unparen((a as AssignExpr).left);
        if (lhs.kind !== NodeKind.MemberExpr) continue;
        const member = lhs as MemberExpr, object = unparen(member.object);
        if (member.isArrow || object.kind !== NodeKind.Identifier || (object as Identifier).name !== x
          || member.member.kind !== NodeKind.Identifier || mentions((a as AssignExpr).right, x)) continue;
        if (fields.some(f => f.name === (member.member as Identifier).name && f.size === w)) result.add(x);
      }
    }
  }
  return result;
}

function createDeadOutSlotStoreTransformer(options: DeadOutSlotStoreOptions): Transformer {
  const outParamWidth = options.outParamWidth;
  const typeSize = options.typeSize;
  const pushed = new Map((options.pushSlotInits ?? []).map(p => [p.local, p.value]));
  if (!outParamWidth || !typeSize || pushed.size === 0) return createTransformer({});
  const transform = (unionKills: ReadonlySet<string>) => createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const params = new Set(fn.parameters.map(p => (p as ParameterDecl).name?.name).filter((n): n is string => !!n));
      const localSize = new Map<string, number | null>();
      for (const d of findNodesByKind(fn.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (params.has(v.name.name)) continue;
        const spelled = emit(v.type as never).replace(/\s+/g, ' ').trim();
        // A volatile store is observable even when no later value read uses it.
        localSize.set(v.name.name, localSize.has(v.name.name) || /\bvolatile\b/.test(spelled)
          ? null : typeSize(spelled));
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
      /**
       * 'overwritten' when the first later statement of the body's own list that names x
       * stores a value to all of x that does not read it, and nothing before that names x:
       * x's address is not taken until then, so no call in between can reach it, and no
       * label in between lets control enter past the store.
       */
      const overwrittenLater = (st: Statement[], i: number, x: string): string | null => {
        // A declaration names x without reading it; its initializer would.
        const named = (p: Statement) => p.kind === NodeKind.DeclStmt
          ? (p as DeclStmt).declarations.some(d => d.kind !== NodeKind.VariableDecl || ((d as VariableDecl).initializer ? mentions((d as VariableDecl).initializer!, x) > 0 : false))
          : mentions(p, x) > 0;
        if (st.slice(0, i).some(named)) return null;
        for (let k = i + 1; k < st.length; k++) {
          const s = st[k];
          if (hasLabel(s)) return null;
          if (!named(s)) continue;
          if (s.kind !== NodeKind.ExprStmt) return null;
          const a = unparen((s as ExprStmt).expression);
          if (a.kind !== NodeKind.AssignExpr || (a as AssignExpr).operator !== '=') return null;
          const t = unparen((a as AssignExpr).left);
          if (t.kind !== NodeKind.Identifier || (t as Identifier).name !== x) return null;
          return mentions((a as AssignExpr).right, x) === 0 ? 'overwritten' : null;
        }
        return null;
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
            const callee = (unionKills.has(x) ? 'union-member-overwrite' : null)
              ?? overwrittenByNext(st[i + 1], x, w) ?? (onlyOutArgs.has(x) ? 'out-argument' : null);
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
      let body = rewriteBlock(fn.body) as CompoundStmt;
      // The push's store a later plain store overwrites, in the body's own list.
      const st = body.statements;
      const keep = st.filter((s, i) => {
        if (s.kind !== NodeKind.ExprStmt) return true;
        const a = unparen((s as ExprStmt).expression);
        if (a.kind !== NodeKind.AssignExpr || (a as AssignExpr).operator !== '=') return true;
        const target = unparen((a as AssignExpr).left);
        if (target.kind !== NodeKind.Identifier) return true;
        const x = (target as Identifier).name;
        const w = localSize.get(x);
        if (w === undefined || w === null) return true;
        const value = uncast((a as AssignExpr).right);
        if (value.kind !== NodeKind.Identifier || pushed.get(x) !== (value as Identifier).name) return true;
        if (!overwrittenLater(st, i, x)) return true;
        STATS.dropped++;
        options.onDrop?.(x, 'overwritten');
        return false;
      });
      if (keep.length !== st.length) { body = updateNode(body, { statements: keep }); changed = true; }
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
  return root => {
    // The native slots belong to the single enclosing function. Never reuse
    // them for another definition (including a nested function) in the same AST.
    const functions = findNodesByKind(root, NodeKind.FunctionDecl) as FunctionDecl[];
    const unionKills = functions.length === 1 ? unionOverwrites(functions[0], options, pushed) : new Set<string>();
    return transform(unionKills)(root);
  };
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
