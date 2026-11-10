/**
 * Arm Constant Call Plugin
 *
 * A call after an if/else that takes a constant chosen by the arm. The decompiler prints
 * one local per such argument, set in each arm and read once by the call after the join
 * (OOGUTIL_UpdateLevelRestrictionControls, 004451c0):
 *
 *     if (bChecked) { ..; nTextAlign = 4; } else { ..; nTextAlign = 5; }
 *     pwsz = GetLocaleString(0x148c);
 *     SetText(gLevelsLabel, pwsz, nTextAlign, 0, 0);
 *
 * The original pushes the constant in each arm and jumps to the code the arms share
 * (`push 4; jmp 0x120` / `push 5` falling into 0x120): VC8 merged the identical tails of
 * a call written in each arm. Read as one call, VC8 keeps the local and pushes it after
 * the join. This pass writes the call back into each arm:
 *
 *     if (bChecked) { ..; pwsz = GetLocaleString(0x148c); SetText(gLevelsLabel, pwsz, 4, 0, 0); }
 *     else          { ..; pwsz = GetLocaleString(0x148c); SetText(gLevelsLabel, pwsz, 5, 0, 0); }
 *
 * Value-preserving: `if (c) A else B; J` runs J after whichever arm ran, as
 * `if (c) { A; J } else { B; J }` does when J holds no label and no arm jumps into it; an
 * arm that cannot fall through (return, goto, break, continue, a halt) keeps no copy.
 * In a copy each local is replaced by the constant its arm last stored in it, which is
 * what it holds there: J writes none of them before the call. A local read nowhere else
 * loses its stores and its declaration; one read elsewhere keeps them. A lost store's
 * line goes with its arm's copy of the call (`foldedLines`): it printed the arm's PUSH, and
 * without it an arm holding only the store would leave branch-layout no evidence of where
 * it lies. Made only when:
 *   - every arm that falls through ends its writes of each local with `v = K`, K a
 *     literal, an enumerator, or the address of a global or a function;
 *   - J runs from the statement after the if up to the first call statement taking such a
 *     local as a whole argument; it holds no label, `case` or `default`, and what it
 *     declares is named nowhere after it; the call is no assertion halt (halt-site-fold
 *     copies a shared halt tail to each way in itself);
 *   - each local is declared once, its address never taken, and J names it only in the call;
 *   - the original (`branchLayout.pushes`): on each such store's line a PUSH of the
 *     constant (any value for an address), in a straight run of the arm's code that jumps
 *     to one offset T or falls into it, at most one arm falling, and T printed on a line
 *     of J, or T starting J's code: the tail's first PUSHes carry no token (`push esi`
 *     before the call), so J's first printed offset follows T with nothing printed between
 *     (OBJECT_ClientFn_TimedSpecial1Or2_23to33s 004bd900);
 *   - J's call statement names the locals only in its arguments (`v = Call(.., v)` keeps v).
 * Without the facts nothing changes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, CStyleCastExpr, DeclStmt, Expression, ExprStmt,
  FunctionDecl, Identifier, IfStmt, ParameterDecl, ParenExpr, QualifiedId, Statement, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { calleeName } from './call-arg-cast.js';
import { isHaltStmt, isExitStmt } from './assert-order.js';
import type { BranchLayoutEvidence, PushImmediate } from './branch-layout/evidence.js';

/** The original's direct calls per parsed-text line (nest-call's evidence). */
export interface CallOrderLines {
  lines: ReadonlyMap<number, readonly CallSite[]>;
}

export interface ArmConstantCallOptions extends PluginOptions {
  branchLayout?: BranchLayoutEvidence | null;
  /** The call-order facts, handed to the copies of J's calls for nest-call. */
  callOrder?: CallOrderLines | null;
  /** Enumerator name -> value, to check the pushed constant. */
  enumValues?: Record<string, number>;
  /** Names that are globals or functions: their address is a constant. */
  globalNames?: string[];
  /** Early switch-chain use: only arms whose test is a subtraction in the original. */
  testedArmsOnly?: boolean;
  /** The exact if node rewritten, for a caller that admits only selected early rewrites. */
  onRewrittenArm?: (node: IfStmt) => void;
  onSite?: (e: { line: number; locals: string[]; arms: number; statements: number }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function uncast(e: Expression): Expression {
  e = unwrap(e);
  while (e.kind === NodeKind.CStyleCastExpr) e = unwrap((e as CStyleCastExpr).expression);
  return e;
}

function mentions(n: ASTNode, name: string): boolean {
  for (const m of traverseAST(n)) if (m.kind === NodeKind.Identifier && (m as Identifier).name === name) return true;
  return false;
}

/** A name, or the last part of a qualified one. */
function nameOf(e: Expression): string | null {
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name;
  if (e.kind !== NodeKind.QualifiedId) return null;
  const n = (e as QualifiedId).name;
  return n.kind === NodeKind.Identifier ? (n as Identifier).name : null;
}

/** The value a constant pushes, or `'address'` for one whose value is an address; null for no constant. */
function constantOf(e: Expression, enums: Record<string, number>, globals: Set<string>): number | 'address' | null {
  const u = uncast(e);
  switch (u.kind) {
    case NodeKind.IntegerLiteral: {
      const v = BigInt((u as unknown as { value: bigint | number }).value);
      return Number(BigInt.asUintN(32, v));
    }
    case NodeKind.BoolLiteral: return (u as unknown as { value: boolean }).value ? 1 : 0;
    case NodeKind.NullptrLiteral: return 0;
    case NodeKind.StringLiteral: return 'address';
    case NodeKind.UnaryExpr: {
      const x = u as UnaryExpr;
      if (x.operator === '-') {
        const v = constantOf(x.operand, enums, globals);
        return typeof v === 'number' ? Number(BigInt.asUintN(32, -BigInt(v))) : null;
      }
      if (x.operator === '&') {
        const n = nameOf(uncast(x.operand));
        return n !== null && globals.has(n) ? 'address' : null;
      }
      return null;
    }
    case NodeKind.Identifier: {
      const n = (u as Identifier).name;
      if (Object.prototype.hasOwnProperty.call(enums, n)) return Number(BigInt.asUintN(32, BigInt(enums[n])));
      return globals.has(n) ? 'address' : null;
    }
    case NodeKind.QualifiedId: {
      const n = nameOf(u);
      if (n === null) return null;
      if (Object.prototype.hasOwnProperty.call(enums, n)) return Number(BigInt.asUintN(32, BigInt(enums[n])));
      return globals.has(n) ? 'address' : null;
    }
    default: return null;
  }
}

/** Whether a statement cannot fall off its end: its last statement returns, jumps or halts. */
function leaves(s: Statement): boolean {
  let last: Statement | undefined = s;
  while (last && last.kind === NodeKind.CompoundStmt) {
    const st = (last as CompoundStmt).statements;
    last = st[st.length - 1];
  }
  if (!last) return false;
  if (last.kind === NodeKind.ReturnStmt || last.kind === NodeKind.GotoStmt
    || last.kind === NodeKind.BreakStmt || last.kind === NodeKind.ContinueStmt) return true;
  if (last.kind === NodeKind.IfStmt) {
    const i = last as IfStmt;
    return !!i.elseBranch && leaves(i.thenBranch) && leaves(i.elseBranch);
  }
  if (last.kind !== NodeKind.ExprStmt) return false;
  const e = unwrap((last as ExprStmt).expression);
  if (e.kind !== NodeKind.CallExpr) return false;
  const bare = (calleeName((e as CallExpr).callee) ?? '').split('::').pop() ?? '';
  return bare === 'exit' || bare === 'ExitProcess' || bare === 'abort' || /_Halt$/.test(bare);
}

function hasJumpTarget(n: ASTNode): boolean {
  for (const m of traverseAST(n)) {
    if (m.kind === NodeKind.LabelStmt || m.kind === NodeKind.CaseStmt || m.kind === NodeKind.DefaultStmt) return true;
  }
  return false;
}

/** `v = K;` at the top of a statement: the local and the value. */
function storeOf(s: Statement): { name: string; value: Expression } | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const l = unwrap((e as AssignExpr).left);
  return l.kind === NodeKind.Identifier ? { name: (l as Identifier).name, value: (e as AssignExpr).right } : null;
}

/** The call a statement makes as its whole value: `f(..);`, `x = f(..);`, `T x = f(..);`. */
function topCall(s: Statement): CallExpr | null {
  let e: Expression | null = null;
  if (s.kind === NodeKind.ExprStmt) {
    e = unwrap((s as ExprStmt).expression);
    if (e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=') e = (e as AssignExpr).right;
  } else if (s.kind === NodeKind.DeclStmt) {
    const d = (s as DeclStmt).declarations;
    if (d.length === 1 && d[0].kind === NodeKind.VariableDecl) e = ((d[0] as VariableDecl).initializer as Expression) ?? null;
  }
  if (!e) return null;
  e = uncast(e);
  return e.kind === NodeKind.CallExpr ? e as CallExpr : null;
}

/** The arms of an if/else-if chain with a final else; null without one. */
function armsOf(s: IfStmt): Statement[] | null {
  const out: Statement[] = [];
  let cur: IfStmt = s;
  for (;;) {
    if (cur.init) return null;
    out.push(cur.thenBranch);
    const e = cur.elseBranch;
    if (!e) return null;
    if (e.kind === NodeKind.IfStmt) { cur = e as IfStmt; continue; }
    out.push(e);
    return out;
  }
}

function placedLine(n: ASTNode): number | null {
  const l = n.location;
  if (!l || l.file === '<generated>' || l.start.line <= 0) return null;
  return l.start.line;
}

function linesOf(n: ASTNode): number[] {
  const l = n.location;
  if (!l || l.file === '<generated>' || l.start.line <= 0) return [];
  const out: number[] = [];
  for (let i = l.start.line; i <= Math.max(l.start.line, l.end.line); i++) out.push(i);
  return out;
}

/** Replace every read of `name` in `n` (mutating) with a copy of `value`. */
function substitute(n: ASTNode, name: string, value: Expression): void {
  const rec = n as unknown as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia' || key === 'ghidraInfo') continue;
    if ((n.kind === NodeKind.MemberExpr && key === 'member') || (n.kind === NodeKind.VariableDecl && key === 'name')) continue;
    const v = rec[key];
    const one = (c: ASTNode): ASTNode | null =>
      c.kind === NodeKind.Identifier && (c as Identifier).name === name ? cloneNode(value) : null;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const c = v[i];
        if (!c || typeof c !== 'object' || typeof (c as ASTNode).kind !== 'string') continue;
        const r = one(c as ASTNode);
        if (r) v[i] = r; else substitute(c as ASTNode, name, value);
      }
    } else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') {
      const r = one(v as ASTNode);
      if (r) rec[key] = r; else substitute(v as ASTNode, name, value);
    }
  }
}

type CallSite = NonNullable<NonNullable<ASTNode['ghidraInfo']>['callSite']>;

/**
 * The call-order fact of each call J makes, by node of J, from the lines of its statement
 * (exactly one fact of that callee there); the first call after the join is marked.
 */
function joinSites(join: Statement[], ev: CallOrderLines): { facts: Map<string, CallSite>; first: number | null } | null {
  const facts = new Map<string, CallSite>();
  let first: number | null = null;
  for (const st of join) {
    const own: CallSite[] = [];
    for (const l of linesOf(st)) own.push(...(ev.lines.get(l) ?? []));
    for (const n of traverseAST(st)) {
      if (n.kind !== NodeKind.CallExpr) continue;
      const bare = (calleeName((n as CallExpr).callee) ?? '').split('::').pop() ?? '';
      const hit = own.filter(f => (f.name.split('::').pop() ?? '') === bare);
      if (hit.length !== 1) continue;
      facts.set(siteKey(st, n), hit[0]);
      if (first === null || hit[0].at < first) first = hit[0].at;
    }
  }
  return { facts, first };
}

/** A call's key within its statement: the statement's line and the call's place in a walk of it. */
function siteKey(st: Statement, call: ASTNode): string {
  let i = 0;
  for (const n of traverseAST(st)) {
    if (n.kind !== NodeKind.CallExpr) continue;
    if (n === call) break;
    i++;
  }
  return `${st.location?.start.line ?? 0}:${i}`;
}

/** Give each call of a copy its fact; the first after the join counts the arm's pushes. */
function markCalls(copy: Statement, sites: { facts: Map<string, CallSite>; first: number | null }, pushes: number): void {
  for (const n of traverseAST(copy)) {
    if (n.kind !== NodeKind.CallExpr) continue;
    const f = sites.facts.get(siteKey(copy, n));
    if (!f) continue;
    const site = f.at === sites.first && f.prev === null ? { ...f, pushes: f.pushes + pushes } : { ...f };
    n.ghidraInfo = { ...(n.ghidraInfo ?? {}), callSite: site };
  }
}

const globalSets = new WeakMap<readonly string[], Set<string>>();

/**
 * Whether T starts the code J prints though no line prints T itself: the shared tail's
 * first instructions are argument PUSHes no token carries (`push esi` before the call).
 * J's first printed offset follows T, and no line of the function prints an offset between.
 */
function tailStart(target: number, joinOffsets: number[], lines: ReadonlyMap<number, readonly number[]>): boolean {
  if (joinOffsets.length === 0) return false;
  const first = Math.min(...joinOffsets);
  if (first <= target) return false;
  for (const offs of lines.values()) for (const o of offs) if (o >= target && o < first) return false;
  return true;
}

function rewriteFunction(fn: FunctionDecl, opts: ArmConstantCallOptions): FunctionDecl | undefined {
  const ev = opts.branchLayout;
  if (!fn.body || !ev?.pushes || ev.pushes.length === 0) return undefined;
  const pushAt = new Map<number, PushImmediate>(ev.pushes.map(p => [p.at, p]));
  const enums = opts.enumValues ?? {};
  let globals = opts.globalNames ? globalSets.get(opts.globalNames) : undefined;
  if (!globals) {
    globals = new Set(opts.globalNames ?? []);
    if (opts.globalNames) globalSets.set(opts.globalNames, globals);
  }
  const body = cloneNode(fn.body);

  const counts = new Map<string, number>();
  for (const p of fn.parameters as ParameterDecl[]) {
    const n = (p as unknown as { name?: Identifier | null }).name;
    if (n && n.kind === NodeKind.Identifier) counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
  }
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.VariableDecl) counts.set((n as VariableDecl).name.name, (counts.get((n as VariableDecl).name.name) ?? 0) + 1);
  }
  const addressed = new Set<string>();
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      for (const m of traverseAST((n as UnaryExpr).operand)) if (m.kind === NodeKind.Identifier) addressed.add((m as Identifier).name);
    }
  }
  // Local names only: a global or a function shares no declaration with the body.
  const local = (name: string) => counts.get(name) === 1 && !addressed.has(name) && !globals.has(name);
  /** Identifier nodes naming `name` as a value: declarations' and members' names excepted. */
  const references = (root: ASTNode, name: string): Set<ASTNode> => {
    const skip = new Set<ASTNode>();
    for (const n of traverseAST(root)) {
      if (n.kind === NodeKind.VariableDecl) skip.add((n as VariableDecl).name);
      if (n.kind === NodeKind.MemberExpr) skip.add((n as unknown as { member: ASTNode }).member);
    }
    const out = new Set<ASTNode>();
    for (const n of traverseAST(root)) {
      if (!skip.has(n) && n.kind === NodeKind.Identifier && (n as Identifier).name === name) out.add(n);
    }
    return out;
  };
  const within = (refs: Set<ASTNode>, roots: ASTNode[]): number => {
    let c = 0;
    for (const r of roots) for (const n of traverseAST(r)) if (refs.has(n)) c++;
    return c;
  };

  let changed = 0;
  const visitBlock = (block: CompoundStmt): void => {
    for (let b = 0; b < block.statements.length; b++) {
      const s = block.statements[b];
      for (const k of getChildren(s)) visitAll(k);
      if (s.kind !== NodeKind.IfStmt) continue;
      if (opts.testedArmsOnly && !(ev.tests?.get(placedLine(s) ?? -1) ?? [])
        .some(t => ['SUB', 'ADD', 'DEC', 'INC'].includes(t.mnemonic))) continue;
      const arms = armsOf(s as IfStmt);
      if (!arms || arms.some(a => a.kind !== NodeKind.CompoundStmt)) continue;
      const falling = arms.filter(a => !leaves(a)) as CompoundStmt[];
      if (falling.length < 2) continue;

      // Per falling arm, the constant each local holds at its end: its last top-level mention is `v = K`.
      const lastStore = (arm: CompoundStmt, name: string): { index: number; value: Expression } | null => {
        for (let i = arm.statements.length - 1; i >= 0; i--) {
          const st = arm.statements[i];
          if (!mentions(st, name)) continue;
          const w = storeOf(st);
          if (!w || w.name !== name || mentions(w.value, name)) return null;
          return constantOf(w.value, enums, globals) === null ? null : { index: i, value: w.value };
        }
        return null;
      };

      // J: up to the first call statement taking such a local as a whole argument.
      let end = -1;
      let taken: string[] = [];
      for (let k = b + 1; k < block.statements.length; k++) {
        const st = block.statements[k];
        if (hasJumpTarget(st)) break;
        const call = topCall(st);
        if (call) {
          const names = call.arguments.map(a => uncast(a)).filter(a => a.kind === NodeKind.Identifier)
            .map(a => (a as Identifier).name).filter(n => local(n) && falling.every(arm => lastStore(arm, n)))
            // Named outside the arguments too (`v = Call(.., v)`), the local is no constant there.
            .filter(n => references(st, n).size === within(references(st, n), call.arguments));
          if (names.length > 0) { end = k; taken = [...new Set(names)]; break; }
        }
      }
      if (end < 0) continue;
      const join = block.statements.slice(b + 1, end + 1);
      // A shared halt is halt-site-fold's: it copies the tail to each way in itself.
      if (isHaltStmt(join[join.length - 1]) || block.statements.slice(end + 1).some(isExitStmt)) continue;
      // The locals hold their arm's constant up to the call: J writes none of them before it.
      if (taken.some(n => join.slice(0, -1).some(st => mentions(st, n)))) continue;
      const callStmt = join[join.length - 1];
      // A local named nowhere but in the call and those stores loses the stores with the read;
      // one named elsewhere keeps them, so every other read sees what it saw.
      const dropped = new Set<string>();
      for (const n of taken) {
        const refs = references(body, n);
        let stores = 0;
        for (const arm of falling) {
          const w = lastStore(arm, n)!;
          for (const m of traverseAST((arm.statements[w.index] as ExprStmt).expression)) if (refs.has(m)) { stores++; break; }
        }
        if (within(refs, [callStmt]) + stores === refs.size) dropped.add(n);
      }
      // What J declares is named nowhere after it.
      const declared = join.flatMap(st => st.kind === NodeKind.DeclStmt
        ? (st as DeclStmt).declarations.filter(d => d.kind === NodeKind.VariableDecl).map(d => (d as VariableDecl).name.name) : []);
      if (declared.some(n => block.statements.slice(end + 1).some(st => mentions(st, n)))) continue;

      // The original: a push per store, each arm's last jumping to (or falling into) one offset T.
      let target: number | null = null;
      let falls = 0;
      let ok = true;
      const armPushes = new Map<CompoundStmt, number>();
      for (const arm of falling) {
        let last: PushImmediate | null = null;
        for (const n of taken) {
          const w = lastStore(arm, n)!;
          const want = constantOf(w.value, enums, globals);
          let hit: PushImmediate | null = null;
          for (const l of linesOf(arm.statements[w.index])) {
            for (const off of ev.lines.get(l) ?? []) {
              const p = pushAt.get(off);
              if (!p) continue;
              if (want !== 'address' && Number(BigInt.asUintN(32, BigInt(p.value))) !== want) continue;
              if (!hit || p.at > hit.at) hit = p;
            }
          }
          if (!hit) { ok = false; break; }
          if (!last || hit.at > last.at) last = hit;
        }
        if (!ok || !last) { ok = false; break; }
        const t = last.reach;
        if (t === undefined || (target !== null && t !== target)) { ok = false; break; }
        if (!last.jumps) falls++;
        target = t;
        // The PUSHes of the arm's straight run into T: the copies' first call finds them on the stack.
        const run = last.run ?? 0;
        armPushes.set(arm, run);
      }
      if (!ok || target === null || falls > 1) continue;
      const joinOffsets = join.flatMap(st => linesOf(st)).flatMap(l => [...(ev.lines.get(l) ?? [])]);
      const printed = joinOffsets.includes(target!) || tailStart(target, joinOffsets, ev.lines);
      if (!printed) continue;
      const sites = opts.callOrder ? joinSites(join, opts.callOrder) : null;

      for (const arm of falling) {
        const values = new Map(taken.map(n => [n, lastStore(arm, n)!]));
        const drop = new Set([...values].filter(([n]) => dropped.has(n)).map(([, v]) => v.index));
        const kept = arm.statements.filter((_, i) => !drop.has(i));
        // A dropped store's comment goes with the copy that reads its constant.
        const trivia = arm.statements.filter((_, i) => drop.has(i)).flatMap(st => st.leadingTrivia ?? []);
        const at = kept.length;
        // The dropped stores' lines print the arm's PUSHes: they go with the call that takes the constants.
        const folded = arm.statements.filter((_, i) => drop.has(i)).flatMap(linesOf);
        for (const st of join) {
          const c = cloneNode(st);
          for (const [n, w] of values) substitute(c, n, w.value);
          if (sites) markCalls(c, sites, armPushes.get(arm)!);
          if (st === callStmt && folded.length) c.ghidraInfo = { ...c.ghidraInfo, foldedLines: folded };
          kept.push(c);
        }
        if (trivia.length && kept[at]) kept[at].leadingTrivia = [...trivia, ...(kept[at].leadingTrivia ?? [])];
        (arm as { statements: Statement[] }).statements = kept;
      }
      const after = block.statements[end + 1];
      if (after && join[0].leadingTrivia?.length && !after.leadingTrivia?.length) after.leadingTrivia = join[0].leadingTrivia;
      block.statements.splice(b + 1, join.length);
      // A declaration left naming nothing goes.
      for (const n of dropped) {
        if (references(body, n).size > 0) continue;
        for (const d of traverseAST(body)) {
          if (d.kind !== NodeKind.CompoundStmt) continue;
          const list = (d as CompoundStmt).statements;
          const i = list.findIndex(x => x.kind === NodeKind.DeclStmt && (x as DeclStmt).declarations.length === 1
            && (x as DeclStmt).declarations[0].kind === NodeKind.VariableDecl
            && ((x as DeclStmt).declarations[0] as VariableDecl).name.name === n
            && !((x as DeclStmt).declarations[0] as VariableDecl).initializer);
          if (i >= 0) { list.splice(i, 1); if (list === block.statements && i <= b) b--; break; }
        }
      }
      changed++;
      opts.onRewrittenArm?.(s as IfStmt);
      opts.onSite?.({ line: placedLine(s) ?? 0, locals: taken, arms: falling.length, statements: join.length });
    }
  };
  const visitAll = (n: ASTNode): void => {
    if (n.kind === NodeKind.CompoundStmt) { visitBlock(n as CompoundStmt); return; }
    for (const k of getChildren(n)) visitAll(k);
  };
  visitAll(body);
  if (!opts.testedArmsOnly) changed += splitTruthArguments(body, ev, opts);
  if (!changed) return undefined;
  return updateNode(fn, { body } as Partial<FunctionDecl>);
}

const COMPARE_INVERSE: Record<string, string> = { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };

/** `a OP b` for a comparison OP, or `!x`, under casts and parentheses. */
function truthValue(e: Expression): Expression | null {
  const u = uncast(e);
  if (u.kind === NodeKind.BinaryExpr && COMPARE_INVERSE[(u as BinaryExpr).operator]) return u;
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') return u;
  return null;
}

/** The condition that holds where `t` is false. */
function negated(t: Expression): Expression {
  if (t.kind === NodeKind.UnaryExpr) return (t as UnaryExpr).operand;
  const b = t as BinaryExpr;
  return { ...b, operator: COMPARE_INVERSE[b.operator] } as BinaryExpr;
}

const sideEffectFree = (n: ASTNode): boolean => {
  for (const m of traverseAST(n)) {
    if (m.kind === NodeKind.CallExpr || m.kind === NodeKind.AssignExpr || m.kind === NodeKind.PostfixExpr
      || m.kind === NodeKind.NewExpr || m.kind === NodeKind.DeleteExpr) return false;
    if (m.kind === NodeKind.UnaryExpr && ((m as UnaryExpr).operator === '++' || (m as UnaryExpr).operator === '--')) return false;
  }
  return true;
};

/**
 * A call taking a comparison's truth value, `f(a, (uint32_t)(n != 0xffff))`, which the
 * original pushes as a literal per way and jumps to the one call (`cmp ax, 0xffff; jne;
 * push 0; jmp T; push 1` and T the call): VC8 merged the tails of a call written in each
 * arm of an if (SendPlayerPartyInfo 005a5cb0, PlayCutScene 00509b60). Written back as
 *
 *     if (n == 0xffff) { f(a, 0); } else { f(a, 1); }
 *
 * the arm laid out first (the push that jumps) as the then-arm. Made when the statement is
 * `f(..)` or `x = f(..)` (x a plain name), exactly one argument is a comparison or `!x`
 * (casts aside) and the other arguments and the comparison call and write nothing; and on
 * the statement's lines the original PUSHes 0 and 1, one jumping and one falling into the
 * same offset. Value-preserving: the comparison is 0 or 1, and any integer conversion of the
 * argument keeps it; nothing the arguments read is written by evaluating them, so the
 * comparison may be made before the other arguments are.
 */
function splitTruthArguments(body: CompoundStmt, ev: BranchLayoutEvidence, opts: ArmConstantCallOptions): number {
  let n = 0;
  const visit = (node: ASTNode): void => {
    if (node.kind !== NodeKind.CompoundStmt) { for (const k of getChildren(node)) visit(k); return; }
    const block = node as CompoundStmt;
    for (let i = 0; i < block.statements.length; i++) {
      const s = block.statements[i];
      for (const k of getChildren(s)) visit(k);
      if (s.kind !== NodeKind.ExprStmt) continue;
      const e = unwrap((s as ExprStmt).expression);
      let call: Expression = e;
      if (e.kind === NodeKind.AssignExpr) {
        if ((e as AssignExpr).operator !== '=' || unwrap((e as AssignExpr).left).kind !== NodeKind.Identifier) continue;
        call = (e as AssignExpr).right;
      }
      call = uncast(call);
      if (call.kind !== NodeKind.CallExpr) continue;
      const c = call as CallExpr;
      const at = c.arguments.map(truthValue);
      const which = at.flatMap((t, k) => t ? [k] : []);
      if (which.length !== 1) continue;
      const k = which[0];
      if (!c.arguments.every(sideEffectFree) || !sideEffectFree(c.callee)) continue;
      // The PUSHes lie inside the statement's code: between the first and last offsets its
      // lines print, with no other line printing code there (no token carries them).
      const own = new Set(linesOf(s));
      const offs = [...own].flatMap(l => [...(ev.lines.get(l) ?? [])]);
      if (offs.length < 2) continue;
      const lo = Math.min(...offs), hi = Math.max(...offs);
      let foreign = false;
      for (const [l, os] of ev.lines) if (!own.has(l) && os.some(o => o > lo && o < hi)) foreign = true;
      if (foreign) continue;
      const pushes = (ev.pushes ?? []).filter(p => p.at > lo && p.at < hi && (p.value === 0 || p.value === 1));
      if (pushes.length !== 2 || pushes[0].value === pushes[1].value) continue;
      const [first, second] = pushes[0].at < pushes[1].at ? [pushes[0], pushes[1]] : [pushes[1], pushes[0]];
      if (!first.jumps || second.jumps || first.reach === undefined || first.reach !== second.reach || !offs.includes(first.reach)) continue;
      const truth = at[k]!;
      const copy = (v: number): Statement => {
        const st = cloneNode(s) as ExprStmt;
        const ce = unwrap(st.expression);
        const cc = uncast(ce.kind === NodeKind.AssignExpr ? (ce as AssignExpr).right : ce) as CallExpr;
        cc.arguments[k] = Expr.intLiteral(v);
        st.leadingTrivia = [];
        return st;
      };
      const cond = cloneNode(first.value === 1 ? truth : negated(truth)) as Expression;
      const iff = Stmt.if_(cond, Stmt.compound([copy(first.value)]), Stmt.compound([copy(second.value)]));
      iff.location = s.location;
      iff.leadingTrivia = s.leadingTrivia;
      block.statements[i] = iff;
      n++;
      opts.onSite?.({ line: placedLine(s) ?? 0, locals: [], arms: 2, statements: 1 });
    }
  };
  visit(body);
  return n;
}

function createArmConstantCallTransformer(options: ArmConstantCallOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  });
}

export const armConstantCallPlugin: TransformPlugin = {
  id: 'arm-constant-call',
  name: 'Arm Constant Call',
  description:
    'Writes a call that takes a constant chosen per if/else arm back into each arm, where the original pushes it per arm and jumps to the shared call',
  version: '1.0.0',
  defaultEnabled: true,
  // Before nest-call (59.5), so a temporary of the copies can go back into its call; after
  // the structuring passes have settled the arms.
  priority: 59.4,
  tags: ['matching'],
  createTransformer: createArmConstantCallTransformer,
};
