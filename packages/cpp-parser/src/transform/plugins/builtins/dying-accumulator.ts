/**
 * Dying Accumulator Plugin
 *
 * A value a function adds into a local it never reads again comes out of the decompiler as a
 * second local holding the addend and the sum spelled where it is used
 * (RewardExperienceFromAncients 0058c5c0, CLIENT_UpdatePortalFlags 00537b00):
 *
 *     nCurrentExp = SERVER_GetUnitStat(pUnit, UNITSTAT_experience, 0);
 *     STATLIST_SetUnitStat(pUnit, UNITSTAT_experience, nExpRemaining + nCurrentExp, 0);
 *     nExpRemaining = 0;
 *
 * The original computes the sum in the accumulator's own register (`add ebx, eax; push ebx`):
 * the source updated the accumulator and passed it, `nExpRemaining += GetUnitStat(..);
 * SetUnitStat(.., nExpRemaining, 0);`. Compiled as printed, VC8 adds into the call result's
 * register instead (`add eax, ebx; push eax`). This pass writes the update:
 *
 *     T = E;                          A op= E;
 *     S( .. A op T .. );        ->    S( .. A .. );
 *
 * Made only on a proof that every value the function computes stays the same:
 *  - the two statements are adjacent in one block; `T = E` (or `T t = E`) is the only
 *    definition of T that reaches S, and S is its only use, reading T once;
 *  - A is a local (a parameter is in-place-operand's shape) and T a local or parameter, whose address is never taken, A is not T, and A is
 *    named neither in E nor anywhere in S but as the operand of that one `A op T`;
 *  - S is an expression statement, a return or a declaration with a value: it evaluates
 *    `A op T` at most once;
 *  - A is dead after S: no definition of A that reaches S reaches a read anywhere but S, so
 *    the value the update leaves in A is read by S alone;
 *  - A is the left operand: the decompiler prints a two-operand instruction's inputs
 *    destination first, so `A op T` is the instruction `op A, T` - the sum made in A's
 *    register, which is what the update compiles to - and `T op A` was made in T's;
 *  - op is `+`, `|`, `&`, `^` or `-`; A and T
 *    are 32-bit integers, and A is unsigned or both are signed, so `A op T` has A's type and
 *    `A op= E` stores exactly the value `A op T` had (E is converted to T's type first: T's
 *    type must be 32 bits, and E a call, a name or a member read, never a float);
 *  - no label, goto, SEH or C++ try in the function.
 *
 * Runs after accumulate-sum and in-place-operand, which own their narrower shapes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl, Identifier,
  MemberExpr, ParameterDecl, ParenExpr, ReturnStmt, Statement, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import { buildFunctionFlow, type FunctionFlow } from '../../cfg/dataflow.js';
import { shapeOfNode } from './call-arg-cast.js';
import { intTypeOf } from './inlined-call-fold.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface DyingAccumulatorOptions extends PluginOptions {
  onSite?: (e: { accumulator: string; addend: string; op: string }) => void;
}

const OPS = new Set(['+', '|', '&', '^', '-']);

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function identName(e: Expression | null | undefined): string | null {
  if (!e) return null;
  const u = unwrap(e);
  return u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
}

/** `T = E;` or `T t = E;` (one declarator): T and E. */
function definitionOf(s: Statement): { t: string; e: Expression; decl: VariableDecl | null } | null {
  if (s.kind === NodeKind.ExprStmt) {
    const e = unwrap((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    const t = identName((e as AssignExpr).left);
    return t ? { t, e: (e as AssignExpr).right, decl: null } : null;
  }
  if (s.kind === NodeKind.DeclStmt) {
    const ds = (s as DeclStmt).declarations;
    if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return null;
    const v = ds[0] as VariableDecl;
    if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr || v.directInit) return null;
    if (v.specifiers.some(x => x === 'static' || x === 'extern')) return null;
    return { t: v.name.name, e: v.initializer as Expression, decl: v };
  }
  return null;
}

/** E is a call, a name or a member read: a value whose conversion to T the update repeats. */
function plainValue(e: Expression): boolean {
  const u = unwrap(e);
  return u.kind === NodeKind.CallExpr || u.kind === NodeKind.Identifier || u.kind === NodeKind.MemberExpr;
}

/** Identifier nodes naming x in n, member names (`p->x`) not counted. */
function namesOf(n: ASTNode, x: string): Identifier[] {
  const members = new Set<ASTNode>();
  const out: Identifier[] = [];
  for (const m of traverseAST(n)) {
    if (m.kind === NodeKind.MemberExpr) members.add((m as MemberExpr).member);
    else if (m.kind === NodeKind.Identifier && (m as Identifier).name === x && !members.has(m)) out.push(m as Identifier);
  }
  return out;
}

function int32(t: TypeNode | undefined): { signed: boolean } | null {
  if (!t) return null;
  const it = intTypeOf(shapeOfNode(t));
  return it && it.bits === 32 ? { signed: it.signed } : null;
}

/** Replace `target` by `by` inside `root` (in place); true when found. */
function replaceIn(root: ASTNode, target: ASTNode, by: ASTNode): boolean {
  for (const n of traverseAST(root)) {
    const rec = n as unknown as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      const v = rec[k];
      if (v === target) { rec[k] = by; return true; }
      if (Array.isArray(v)) {
        const i = v.indexOf(target);
        if (i >= 0) { v[i] = by; return true; }
      }
    }
  }
  return false;
}

/**
 * No read of `v` is reachable from the exit of node `from` without a killing definition of
 * `v` first: the value `v` holds after `from` is never read. Reaching the function's exit,
 * the region's outside or an extra entry's graph edge counts as dead only for the exit.
 */
function deadAfter(flow: FunctionFlow, from: number, v: string): boolean {
  const cfg = flow.cfg;
  const seen = new Set<number>();
  const work = [...cfg.nodes[from].succ];
  while (work.length) {
    const n = work.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    if (n === cfg.exit) continue;
    if (n === cfg.external) return false;
    if (flow.reads(n).has(v)) return false;
    const d = flow.definition(n, v);
    if (d && d.killing) continue;
    work.push(...cfg.nodes[n].succ);
  }
  return true;
}

interface Site { list: Statement[]; i: number; a: string; t: string; op: string; bin: BinaryExpr }

function createDyingAccumulatorTransformer(options: DyingAccumulatorOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      let body = cloneNode(fn.body) as CompoundStmt;
      let changed = false;
      for (let round = 0; round < 16; round++) {
        const all = [...traverseAST(body)];
        if (all.some(n => n.kind === NodeKind.TryStmt || n.kind === NodeKind.ForRangeStmt || n.kind === NodeKind.LabelStmt ||
          n.kind === NodeKind.GotoStmt || n.kind === NodeKind.SehTryStmt || n.kind === NodeKind.AsmDecl)) break;
        const types = new Map<string, TypeNode>();
        const params = new Set((fn.parameters as ParameterDecl[]).map(p => p.name?.name).filter((x): x is string => !!x));
        const dup = new Set<string>();
        for (const p of fn.parameters as ParameterDecl[]) if (p.name) types.set(p.name.name, p.type);
        for (const n of all) if (n.kind === NodeKind.VariableDecl) {
          const v = n as VariableDecl;
          if (types.has(v.name.name)) dup.add(v.name.name);
          types.set(v.name.name, v.type);
          if (v.specifiers.some(x => x === 'static' || x === 'extern')) dup.add(v.name.name);
        }
        const addressed = new Set<string>();
        for (const n of all) if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
          const o = identName((n as UnaryExpr).operand);
          if (o) addressed.add(o);
        }
        const ok = (x: string) => types.has(x) && !dup.has(x) && !addressed.has(x);
        const flow = buildFunctionFlow(body.statements, new Set(types.keys()));

        let site: Site | null = null;
        const visit = (n: ASTNode): void => {
          if (site) return;
          for (const k of getChildren(n)) visit(k);
          if (site || n.kind !== NodeKind.CompoundStmt) return;
          const list = (n as CompoundStmt).statements;
          for (let i = 0; i + 1 < list.length && !site; i++) {
            const d = definitionOf(list[i]);
            if (!d || !ok(d.t) || !plainValue(d.e)) continue;
            const s = list[i + 1];
            if (s.kind !== NodeKind.ExprStmt && s.kind !== NodeKind.ReturnStmt && s.kind !== NodeKind.DeclStmt) continue;
            const reads = namesOf(s, d.t);
            if (reads.length !== 1) continue;
            // The read is an operand of `A op T` / `T op A`.
            let bin: BinaryExpr | null = null;
            for (const m of traverseAST(s)) {
              if (m.kind !== NodeKind.BinaryExpr) continue;
              const b = m as BinaryExpr;
              if (!OPS.has(b.operator)) continue;
              if (unwrap(b.left) === reads[0] || unwrap(b.right) === reads[0]) { bin = b; break; }
            }
            if (!bin) continue;
            // The accumulator is the left operand as printed: the decompiler prints a two-operand
            // instruction's inputs in order, destination first, so `A op T` is `op A_reg, T_reg`
            // and `T op A` worked in T's register (Skills_CltStFunc_SetTimedDurationAndInfernoState
            // 004f0ab0, `nGameTick + nDuration`, matches as printed).
            if (unwrap(bin.left) === reads[0]) continue;
            const a = identName(bin.left);
            // A local, never a parameter: `x = A; S(x op p)` with p a parameter is in-place-operand's
            // shape, where the original works in the call result's register.
            if (!a || a === d.t || !ok(a) || params.has(a)) continue;
            if (namesOf(s, a).length !== 1 || namesOf(d.e, a).length !== 0 || namesOf(d.e, d.t).length !== 0) continue;
            if (s.kind === NodeKind.DeclStmt && (s as DeclStmt).declarations.some(v => v.kind === NodeKind.VariableDecl &&
              ((v as VariableDecl).name.name === a || (v as VariableDecl).name.name === d.t))) continue;
            const ta = int32(types.get(a)), tt = int32(types.get(d.t));
            if (!ta || !tt || (ta.signed && !tt.signed)) continue;
            // Dataflow: T's definition reaches S alone; A is dead after S.
            const di = flow.nodeOf(list[i]), si = flow.nodeOf(s);
            if (di === undefined || si === undefined) continue;
            const rt = flow.reaching(si, d.t);
            if (rt.size !== 1 || !rt.has(di)) continue;
            if (flow.usesOf(di, d.t).some(u => u !== si)) continue;
            if (!deadAfter(flow, si, a)) continue;
            if (flow.writes(si).has(a)) continue;
            site = { list, i, a, t: d.t, op: bin.operator, bin };
          }
        };
        visit(body);
        if (!site) break;
        const st = site as Site;
        const d = definitionOf(st.list[st.i])!;
        const update: ExprStmt = {
          kind: NodeKind.ExprStmt,
          leadingTrivia: (st.list[st.i] as { leadingTrivia?: unknown }).leadingTrivia,
          expression: {
            kind: NodeKind.AssignExpr,
            operator: `${st.op}=`,
            left: { kind: NodeKind.Identifier, name: st.a } as Identifier,
            right: cloneNode(d.e) as Expression,
          } as AssignExpr,
        } as unknown as ExprStmt;
        const s = st.list[st.i + 1];
        const byA = { kind: NodeKind.Identifier, name: st.a } as Identifier;
        if (!replaceIn(s, st.bin, byA)) break;
        if (d.decl) {
          // Keep T declared for any other definition of it the function makes.
          const others = namesOf(body, st.t).length - 2;
          st.list.splice(st.i, 1, ...(others > 0
            ? [{ ...(st.list[st.i] as DeclStmt), declarations: [{ ...d.decl, initializer: null }] } as unknown as Statement, update as unknown as Statement]
            : [update as unknown as Statement]));
        } else {
          st.list[st.i] = update as unknown as Statement;
        }
        changed = true;
        options.onSite?.({ accumulator: st.a, addend: st.t, op: st.op });
      }
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const dyingAccumulatorPlugin: TransformPlugin = {
  id: 'dying-accumulator',
  name: 'Dying Accumulator',
  description: 'A sum into a local that dies with its use is written as an update of the local',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 989.955,
  tags: ['matching'],
  createTransformer: (options: DyingAccumulatorOptions = {}) => createDyingAccumulatorTransformer(options),
};
