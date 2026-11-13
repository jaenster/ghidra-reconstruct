/**
 * Seed Roll Step Plugin
 *
 * One step of the D2 seed that stores back into the seed it read,
 *
 *     sNextSeed = D2_SEED_NEXT(*pSeed);                nNextSeed = D2_SeedRoll(pSeed);
 *     pSeed->nSeedHigh = sNextSeed.nSeedHigh;    ->    nSlot = nNextSeed % 5;
 *     pSeed->nSeedLow = sNextSeed.nSeedLow;
 *     nSlot = sNextSeed.nSeedLow % 5;
 *
 * is the inline roll the original calls: a function that computes the 64-bit step, stores the
 * high word, then the low word, and returns the low word. Its out-of-line copy is
 * RollRandomSeed 0045c370 (`ADC EDX,EDI; MOV [ECX+4],EDX; MOV [ECX],EAX`). Ghidra prints the
 * inlined copies as a 64-bit temporary written back one word at a time, or as a struct copy
 * (`*pSeed = sNextSeed;`) where the scheduler put the low store first. Compiled as printed,
 * VC8 keeps the temporary in a register pair and copies it after the step, late; the call form
 * lets it place the two stores where the original has them (OBJECT_ClientFn_PeriodicOperate
 * 004bd730 and SKILLS_CreateMissileRing 004c7000 match only in the call form).
 *
 * A step is rewritten when, in one statement list,
 *   - `X = D2_SEED_NEXT(E);` or `D2SeedStrc X = D2_SEED_NEXT(E);` is followed by the write of
 *     X back into E (`E = X;`, or `.nSeedHigh` and `.nSeedLow` one statement each), with only
 *     local declarations and plain local arithmetic between them (`n = (int)((uint64_t)
 *     X.nSeedLow * K >> 0x20);`): no call, no memory access, nothing E names. The step may
 *     carry labels (`roll_evade:`, `case 1:`); they stay on the call;
 *   - or the temporary is already gone: `E = D2_SEED_NEXT(E);`;
 *   - E is a plain lvalue (names, members, `*p`, constant or name subscripts) evaluated
 *     without side effects, so evaluating it once instead of three times changes nothing.
 * X is a local `D2SeedStrc` whose every other use reads `X.nSeedLow`: then X becomes a
 * `uint32_t` holding that word, or disappears when nothing reads it. A temporary that a later
 * `D2_SEED_NEXT_VAL(X)` continues from keeps its form: that chain is the original carrying the
 * seed in registers from one step to the next (CLIENT_SendMonsterMoveToRandomNearbyPosMessage
 * 0046c960 matches its two steps as printed, and loses them as two calls, which reload it).
 *
 * Value-preserving: the step computes the same 64-bit value from the same two words and
 * stores both halves into the same seed; the plain statements moved after the store neither
 * read nor write the seed, and read the low word from X either way.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl,
  Identifier, MemberExpr, ParameterDecl, ParenExpr, Statement, SubscriptExpr, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { Expr, Stmt, Type } from '../../../ast/factory.js';
import { getChildren, transformAST } from '../../../ast/visitor.js';
import { TriviaKind } from '../../../lexer/trivia.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import { sameExpr } from './rotated-for-loop.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

const NEXT = 'D2_SEED_NEXT';
const ROLL = 'D2_SeedRoll';
const SEED_TYPE = 'D2SeedStrc';
/** The longest run of plain statements a write-back may sit behind. */
const MAX_BETWEEN = 4;

export interface SeedRollStepOptions extends PluginOptions {
  onSite?: (e: { seed: string; temporary: string | null; line: number }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function isName(e: Expression, name?: string): e is Identifier {
  const u = unwrap(e);
  return u.kind === NodeKind.Identifier && (name === undefined || (u as Identifier).name === name);
}

function memberName(m: MemberExpr): string | null {
  return m.member.kind === NodeKind.Identifier ? (m.member as Identifier).name : null;
}

/** The argument of `D2_SEED_NEXT(E)`, or null. */
function nextArg(e: Expression | null | undefined): Expression | null {
  if (!e) return null;
  const u = unwrap(e);
  if (u.kind !== NodeKind.CallExpr) return null;
  const c = u as CallExpr;
  if (!isName(c.callee, NEXT) || c.arguments.length !== 1) return null;
  return c.arguments[0];
}

/** Names, `this`, members, `*p` and subscripts by a name or a constant: no side effect. */
function isPlainLvalue(e: Expression): boolean {
  const u = unwrap(e);
  switch (u.kind) {
    case NodeKind.Identifier:
    case NodeKind.ThisExpr:
      return true;
    case NodeKind.MemberExpr:
      return memberName(u as MemberExpr) !== null && isPlainLvalue((u as MemberExpr).object);
    case NodeKind.UnaryExpr:
      return (u as UnaryExpr).operator === '*' && isPlainLvalue((u as UnaryExpr).operand);
    case NodeKind.SubscriptExpr: {
      const idx = unwrap((u as SubscriptExpr).index);
      return isPlainLvalue((u as SubscriptExpr).array) &&
        (idx.kind === NodeKind.IntegerLiteral || idx.kind === NodeKind.Identifier);
    }
    default:
      return false;
  }
}

/** The address of seed E: `p` for `*p`, `&E` otherwise. */
function addressOf(e: Expression): Expression {
  const u = unwrap(e);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '*') return (u as UnaryExpr).operand;
  return Expr.addressOf(u);
}

function sameSeed(a: Expression, b: Expression): boolean {
  return sameExpr(addressOf(a), addressOf(b));
}

/** The seed a `S.field` / `p->field` store writes, when it writes `field`. */
function seedOfField(lhs: Expression, field: string): Expression | null {
  const u = unwrap(lhs);
  if (u.kind !== NodeKind.MemberExpr || memberName(u as MemberExpr) !== field) return null;
  const m = u as MemberExpr;
  return m.isArrow ? Expr.unary('*', m.object) : m.object;
}

function assignOf(s: Statement): AssignExpr | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  return e.kind === NodeKind.AssignExpr ? (e as AssignExpr) : null;
}

/** `X.field` with X a name: the name, else null. */
function fieldOfName(e: Expression, field: string): string | null {
  const u = unwrap(e);
  if (u.kind !== NodeKind.MemberExpr) return null;
  const m = u as MemberExpr;
  if (m.isArrow || memberName(m) !== field || !isName(m.object)) return null;
  return (unwrap(m.object) as Identifier).name;
}

function hasComment(s: Statement): boolean {
  return [...(s.leadingTrivia ?? []), ...(s.trailingTrivia ?? [])]
    .some(t => t.kind === TriviaKind.LineComment || t.kind === TriviaKind.BlockComment);
}

/** Every name an expression reads or writes, member names excluded. */
function namesIn(n: ASTNode, out = new Set<string>()): Set<string> {
  if (n.kind === NodeKind.Identifier) out.add((n as Identifier).name);
  if (n.kind === NodeKind.MemberExpr) {
    namesIn((n as MemberExpr).object, out);
    return out;
  }
  for (const k of getChildren(n)) namesIn(k, out);
  return out;
}

const PURE_UNARY = new Set(['-', '~', '!', '+']);

/** Arithmetic on names, constants and `X.nSeedLow`: no call, no memory access. */
function isPureRead(e: ASTNode, x: string | null): boolean {
  switch (e.kind) {
    case NodeKind.Identifier:
    case NodeKind.IntegerLiteral:
    case NodeKind.CharLiteral:
    case NodeKind.BoolLiteral:
      return true;
    case NodeKind.ParenExpr:
      return isPureRead((e as ParenExpr).expression, x);
    case NodeKind.CStyleCastExpr:
      return isPureRead((e as unknown as { expression: Expression }).expression, x);
    case NodeKind.BinaryExpr: {
      const b = e as unknown as { operator: string; left: Expression; right: Expression };
      if (b.operator === ',' || b.operator === '&&' || b.operator === '||') return false;
      return isPureRead(b.left, x) && isPureRead(b.right, x);
    }
    case NodeKind.UnaryExpr:
      return PURE_UNARY.has((e as UnaryExpr).operator) && isPureRead((e as UnaryExpr).operand, x);
    case NodeKind.MemberExpr:
      return x !== null && fieldOfName(e as Expression, 'nSeedLow') === x;
    default:
      return false;
  }
}

const WRAPPERS = new Set<string>([NodeKind.LabelStmt, NodeKind.CaseStmt, NodeKind.DefaultStmt]);

/** The statement under its labels: `lbl: case 1: S` is S. */
function innermost(s: Statement): Statement {
  while (WRAPPERS.has(s.kind)) s = (s as unknown as { statement: Statement }).statement;
  return s;
}

/** `s` with the statement under its labels replaced. */
function rewrap(s: Statement, inner: Statement): Statement {
  if (!WRAPPERS.has(s.kind)) return inner;
  const w = s as unknown as { statement: Statement };
  return { ...s, statement: rewrap(w.statement, inner) } as Statement;
}

/** A plain statement a write-back may sit behind: a local's declaration or arithmetic into a local. */
function isPlainBetween(st: Statement, x: string, seedNames: ReadonlySet<string>, locals: ReadonlySet<string>,
  addressed: ReadonlySet<string>): boolean {
  if (hasComment(st)) return false;
  if (st.kind === NodeKind.DeclStmt) {
    const ds = (st as DeclStmt).declarations;
    if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return false;
    const v = ds[0] as VariableDecl;
    if (v.name.name === x || seedNames.has(v.name.name) || v.directInit || v.copyListInit) return false;
    if (v.specifiers.includes('static') || v.specifiers.includes('extern')) return false;
    if (!v.initializer) return true;
    return v.initializer.kind !== NodeKind.InitListExpr && isPureRead(v.initializer, x) &&
      ![...namesIn(v.initializer)].some(n => seedNames.has(n));
  }
  const p = assignOf(st);
  if (!p || !isName(p.left)) return false;
  const target = (unwrap(p.left) as Identifier).name;
  if (target === x || !locals.has(target) || addressed.has(target) || seedNames.has(target)) return false;
  return isPureRead(p.right, x) && ![...namesIn(p.right)].some(n => seedNames.has(n));
}

interface Site {
  list: Statement[];
  head: number;
  /** Indices of the write-back statement(s), removed. */
  writeback: number[];
  seed: Expression;
  x: string | null;
  /** The head declares X with the step as its initializer. */
  declares: boolean;
}

/** The write-back of X into seed E at `list[j]`: the indices it spans, or null. */
function writebackAt(list: Statement[], j: number, x: string, seed: Expression): number[] | null {
  const a = list[j] && assignOf(list[j]);
  if (!a || a.operator !== '=') return null;
  if (isName(a.right, x)) return sameSeed(a.left, seed) ? [j] : null;
  const b = list[j + 1] && assignOf(list[j + 1]);
  if (!b || b.operator !== '=') return null;
  const halves = [a, b];
  const high = halves.find(h => seedOfField(h.left, 'nSeedHigh'));
  const low = halves.find(h => seedOfField(h.left, 'nSeedLow'));
  if (!high || !low || high === low) return null;
  if (fieldOfName(high.right, 'nSeedHigh') !== x || fieldOfName(low.right, 'nSeedLow') !== x) return null;
  if (!sameSeed(seedOfField(high.left, 'nSeedHigh')!, seed) || !sameSeed(seedOfField(low.left, 'nSeedLow')!, seed)) return null;
  return [j, j + 1];
}

function findSites(list: Statement[], locals: ReadonlySet<string>, addressed: ReadonlySet<string>): Site[] {
  const sites: Site[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = innermost(list[i]);
    let x: string | null = null;
    let seed: Expression | null = null;
    let declares = false;
    const a = assignOf(s);
    if (a && a.operator === '=') {
      seed = nextArg(a.right);
      if (!seed) continue;
      if (!isPlainLvalue(seed)) continue;
      if (isName(a.left) && !sameSeed(a.left, seed)) {
        x = (unwrap(a.left) as Identifier).name;
      } else if (sameSeed(a.left, seed)) {
        sites.push({ list, head: i, writeback: [], seed, x: null, declares: false });
        continue;
      } else {
        continue;
      }
    } else if (s.kind === NodeKind.DeclStmt) {
      const ds = (s as DeclStmt).declarations;
      if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) continue;
      const v = ds[0] as VariableDecl;
      seed = nextArg(v.initializer as Expression | null);
      if (!seed || !isPlainLvalue(seed) || v.directInit || v.copyListInit) continue;
      x = v.name.name;
      declares = true;
    } else {
      continue;
    }
    const seedNames = namesIn(seed);
    if (seedNames.has(x)) continue;
    let j = i + 1;
    let wb: number[] | null = null;
    for (let between = 0; between <= MAX_BETWEEN && j < list.length; between++, j++) {
      wb = writebackAt(list, j, x, seed);
      if (wb) break;
      if (!isPlainBetween(list[j], x, seedNames, locals, addressed)) break;
    }
    if (!wb || wb.some(k => hasComment(list[k]))) continue;
    sites.push({ list, head: i, writeback: wb, seed, x, declares });
    i = wb[wb.length - 1];
  }
  return sites;
}

interface Use { node: Identifier; parent: ASTNode | null; grand: ASTNode | null }

/** Every use of a name as a name (member names are not uses). */
function usesOf(root: ASTNode, name: string): Use[] {
  const out: Use[] = [];
  const walk = (n: ASTNode, parent: ASTNode | null, grand: ASTNode | null): void => {
    if (n.kind === NodeKind.Identifier) {
      if ((n as Identifier).name === name) out.push({ node: n as Identifier, parent, grand });
      return;
    }
    if (n.kind === NodeKind.MemberExpr) {
      walk((n as MemberExpr).object, n, parent);
      return;
    }
    for (const k of getChildren(n)) walk(k, n, parent);
  };
  walk(root, null, null);
  return out;
}

function isSeedType(v: VariableDecl): boolean {
  return emit(v.type as AnyNode).trim() === SEED_TYPE;
}

function createSeedRollStepTransformer(options: SeedRollStepOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const body = cloneNode(fn.body) as CompoundStmt;
      const lists: Statement[][] = [];
      const decls = new Map<string, VariableDecl[]>();
      const declStmts = new Map<VariableDecl, { list: Statement[]; stmt: Statement } | null>();
      const addressed = new Set<string>();
      let anyStep = false;
      const scan = (n: ASTNode, list: Statement[] | null): void => {
        if (n.kind === NodeKind.CompoundStmt) {
          const l = (n as CompoundStmt).statements;
          lists.push(l);
          for (const s of l) scan(s, l);
          return;
        }
        if (n.kind === NodeKind.DeclStmt) {
          const ds = (n as DeclStmt).declarations;
          for (const d of ds) if (d.kind === NodeKind.VariableDecl) {
            const v = d as VariableDecl;
            decls.set(v.name.name, [...(decls.get(v.name.name) ?? []), v]);
            declStmts.set(v, ds.length === 1 && list ? { list, stmt: n as Statement } : null);
          }
        }
        if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
          for (const name of namesIn((n as UnaryExpr).operand)) addressed.add(name);
        }
        if (n.kind === NodeKind.CallExpr && isName((n as CallExpr).callee, NEXT)) anyStep = true;
        for (const k of getChildren(n)) scan(k, null);
      };
      scan(body, null);
      if (!anyStep) return undefined;

      const params = new Set((fn.parameters as ParameterDecl[]).map(p => p.name?.name).filter((n): n is string => !!n));
      const locals = new Set([...decls.keys()].filter(n => !params.has(n)));

      const sites = lists.flatMap(l => findSites(l, locals, addressed));
      if (sites.length === 0) return undefined;

      // A temporary qualifies when it is one plain local D2SeedStrc and every use of it is a
      // site's own, or a read of its low word.
      const byTemp = new Map<string, Site[]>();
      for (const s of sites) if (s.x) byTemp.set(s.x, [...(byTemp.get(s.x) ?? []), s]);
      const reads = new Map<string, MemberExpr[]>();
      const accepted = new Set<string>();
      for (const [x, own] of byTemp) {
        const ds = decls.get(x) ?? [];
        if (ds.length !== 1 || params.has(x) || addressed.has(x)) continue;
        const v = ds[0];
        if (!isSeedType(v) || v.specifiers.includes('static') || v.specifiers.includes('extern')) continue;
        if (v.initializer && !own.some(s => s.declares && (innermost(s.list[s.head]) as DeclStmt).declarations[0] === v)) continue;
        let expected = 0;
        for (const s of own) expected += (s.declares ? 0 : 1) + (s.writeback.length === 1 ? 1 : 2);
        const lowReads: MemberExpr[] = [];
        const siteNodes = new Set<ASTNode>();
        for (const s of own) for (const k of [s.head, ...s.writeback]) siteNodes.add(s.list[k]);
        let ok = true;
        let inSites = 0;
        for (const u of usesOf(body, x)) {
          if (u.parent?.kind === NodeKind.VariableDecl && (u.parent as VariableDecl).name === u.node) continue;
          const inSite = [...siteNodes].some(st => contains(st, u.node));
          if (inSite && !(u.parent?.kind === NodeKind.MemberExpr && memberName(u.parent as MemberExpr) === 'nSeedLow' &&
              !isWritebackRead(own, u.parent as MemberExpr))) {
            inSites++;
            continue;
          }
          if (u.parent?.kind === NodeKind.MemberExpr && !(u.parent as MemberExpr).isArrow &&
              memberName(u.parent as MemberExpr) === 'nSeedLow' && !isWritten(u.parent as MemberExpr, u.grand)) {
            lowReads.push(u.parent as MemberExpr);
            continue;
          }
          ok = false;
          break;
        }
        if (!ok || inSites !== expected) continue;
        accepted.add(x);
        reads.set(x, lowReads);
      }

      // Rewrite each list from its last site up, so the indices stay valid.
      const done = sites.filter(s => s.x === null || accepted.has(s.x));
      if (done.length === 0) return undefined;
      const byList = new Map<Statement[], Site[]>();
      for (const s of done) byList.set(s.list, [...(byList.get(s.list) ?? []), s]);
      for (const [list, ss] of byList) {
        ss.sort((a, b) => b.head - a.head);
        for (const s of ss) {
          const head = innermost(list[s.head]);
          const used = s.x !== null && (reads.get(s.x)?.length ?? 0) > 0;
          const call = Expr.call(ROLL, [cloneNode(addressOf(s.seed))]);
          let replacement: Statement;
          if (s.declares && used) {
            const v = (head as DeclStmt).declarations[0] as VariableDecl;
            replacement = updateNode(head as DeclStmt, {
              declarations: [updateNode(v, { type: Type.typedef('uint32_t'), initializer: call } as Partial<VariableDecl>)],
            } as Partial<DeclStmt>);
          } else if (used) {
            replacement = updateNode(head as ExprStmt, { expression: Expr.assign(Expr.identifier(s.x!), call) } as Partial<ExprStmt>);
          } else {
            replacement = { ...Stmt.expr(call), leadingTrivia: head.leadingTrivia, trailingTrivia: head.trailingTrivia, location: head.location } as Statement;
          }
          for (const k of [...s.writeback].sort((a, b) => b - a)) list.splice(k, 1);
          list[s.head] = rewrap(list[s.head], replacement);
          options.onSite?.({ seed: emit(s.seed as AnyNode).trim(), temporary: s.x, line: head.location?.start.line ?? 0 });
        }
      }

      // The temporaries: a uint32_t holding the low word, or gone when nothing reads it.
      for (const x of accepted) {
        const v = decls.get(x)![0];
        const own = byTemp.get(x)!;
        if (own.some(s => s.declares)) continue;
        const where = declStmts.get(v);
        if ((reads.get(x)?.length ?? 0) === 0 && where) {
          const k = where.list.indexOf(where.stmt);
          if (k >= 0 && !hasComment(where.stmt)) {
            where.list.splice(k, 1);
            continue;
          }
        }
        v.type = Type.typedef('uint32_t');
      }
      const lowered = transformAST(body, {
        visitMemberExpr(m: MemberExpr): ASTNode | undefined {
          const x = fieldOfName(m, 'nSeedLow');
          if (!x || !accepted.has(x)) return undefined;
          return { ...Expr.identifier(x), leadingTrivia: m.leadingTrivia, trailingTrivia: m.trailingTrivia, location: m.location } as Identifier;
        },
      }) as CompoundStmt;
      return updateNode(fn, { body: lowered } as Partial<FunctionDecl>);
    },
  });
}

function contains(root: ASTNode, target: ASTNode): boolean {
  if (root === target) return true;
  for (const k of getChildren(root)) if (contains(k, target)) return true;
  return false;
}

/** `X.nSeedLow` on the right of a site's own write-back. */
function isWritebackRead(own: Site[], m: MemberExpr): boolean {
  for (const s of own) for (const k of s.writeback) {
    const a = assignOf(s.list[k]);
    if (a && unwrap(a.right) === m) return true;
  }
  return false;
}

/** `X.nSeedLow` stored to, incremented or taken the address of. */
function isWritten(m: MemberExpr, parent: ASTNode | null): boolean {
  if (!parent) return false;
  if (parent.kind === NodeKind.AssignExpr && unwrap((parent as AssignExpr).left) === m) return true;
  if (parent.kind === NodeKind.UnaryExpr && ['&', '++', '--'].includes((parent as UnaryExpr).operator)) return true;
  if (parent.kind === NodeKind.PostfixExpr) return true;
  return false;
}

export const seedRollStepPlugin: TransformPlugin = {
  id: 'seed-roll-step',
  name: 'Seed Roll Step',
  description: 'A D2 seed step written back into the seed it read becomes the inline roll call',
  version: '1.0.0',
  defaultEnabled: true,
  // After arith-idioms (619), which spells the low word Ghidra prints as `(uint64_t)X &
  // 0xffffffff` as `X.nSeedLow`, and after prng-temp-collapse (85), which leaves
  // `E = D2_SEED_NEXT(E);` for a step whose value nothing reads.
  priority: 619.5,
  tags: ['game', 'diablo', 'matching'],
  createTransformer: (options: SeedRollStepOptions = {}) => createSeedRollStepTransformer(options),
};
