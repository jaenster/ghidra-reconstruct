/**
 * Copy Coalesce Plugin
 *
 * The decompiler gives a value a second variable wherever it copies it: a phi copy at a
 * join, a register move it could not fold, a saved value it reloads. Where both variables
 * stay live VC8 needs one more register than the original did and homes one of them on
 * the stack, so the frame is a word larger. LIGHTMAP_InitFromPlayerAndRooms (00474610)
 * as Ghidra prints it:
 *
 *   if (!pUnit || (pRoom = UNITS_GetRoom(pUnit), pPlayerRoom = pRoom, !pRoom) || ...) {
 *   ...
 *       pRoom = pPlayerRoom;
 *
 * pPlayerRoom only ever holds pRoom's value. Its reads read pRoom, its copies go:
 *
 *   if (!pUnit || (pRoom = UNITS_GetRoom(pUnit), !pRoom) || ...) {
 *
 * The fold of `a` into `b` must not change one value the function computes, so it is
 * made only on a proof, and refused on anything the proof does not cover:
 *
 *  - a is a local, b a local or parameter; both declared once, not static, not volatile,
 *    not a reference, of one emitted type. Neither has its address taken (`&v`, an array),
 *    so no call and no store through a pointer can write either: no call can see them.
 *  - Neither is a slot frame-group-locals may make a member of a frame object - one that
 *    follows, within its widest run, a local whose address leaves the frame. A callee
 *    reaches such a slot by offset; a copy into it is a store the AST cannot see read
 *    (NET_BNFTP_CLIENT_ProcessFile 0051fab0). The function names no frame position by
 *    offset (`stack0x...`), and without the frame, no local may escape at all.
 *  - Every write of a is a copy `a = b` the fold can drop: a statement, a declaration
 *    `T a = b;` (or a bare `T a;`), or a comma operand a lowered condition evaluates for
 *    its effect.
 *  - "a == b" holds on entry to every node that reads a, on every path: a must-dataflow
 *    over the function's graph (gotos, switch entries and loop back edges are edges)
 *    where `a = b` and `b = a` establish it and any other write of a or b ends it, and
 *    nothing establishes it at the function's entry. A read node writes neither, but for
 *    `b = e;` / `b op= e;` with no write inside e, whose right side is read before the
 *    store. `b = a;` turns into `b = b;` and goes, so it is a read too: b must already
 *    equal a there (Drop.cpp 0055a6d0 is the shape that needs it: `nParentDepth =
 *    nTCStackDepth` before a loop, `nTCStackDepth = nParentDepth + 1` inside it).
 *  - Every mention of a or b is one the graph evaluates; one it does not hold refuses.
 *  - b is declared in a scope enclosing every use of a, before it.
 *  - No SEH or C++ try, no setjmp, no inline asm: control the graph does not have.
 *
 * Every read of a then reads b's value at that point, which is the value a held.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AnyNode, AssignExpr, BinaryExpr, CommaExpr, CompoundStmt, DeclStmt, ExprStmt, Expression, ForStmt, FunctionDecl,
  Identifier, ParameterDecl, Statement, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { buildFunctionFlow, ENTRY_DEF, type FunctionFlow } from '../../cfg/index.js';
import type { StackSlot } from './stack-frame-address.js';
import { frameReach, type SplitLivesOptions } from './split-lives.js';
import type { Reach } from '../../cfg/index.js';

export interface CopyCoalesceOptions extends PluginOptions {
  /**
   * The enclosing function's frame, from Ghidra's own local-variable list. Absent: the
   * frame is unknown, and a function where any local's address is taken is left alone.
   */
  slots?: readonly StackSlot[];
  /** Each callee's reach through a pointer parameter, as frame-group-locals is given it. */
  argReach?: (callee: string, index: number, argCount: number) => Reach;
  computedArgReach?: (callee: Expression, index: number, argCount: number) => Reach;
  bodyReach?: (body: ASTNode, name: string, type: string, opts: { include: (use: ASTNode) => boolean }) => Reach;
}

/** frame-group-locals' widest hole inside one frame object. */
const MAX_GAP = 4;

function unwrap(e: Expression): Expression {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as unknown as { expression: Expression }).expression;
  return x;
}

const SKIP_KEYS = new Set(['leadingTrivia', 'trailingTrivia', 'location', 'loc', 'range']);

function childNodes(n: ASTNode): Array<[string, ASTNode]> {
  const out: Array<[string, ASTNode]> = [];
  for (const [k, v] of Object.entries(n)) {
    if (SKIP_KEYS.has(k)) continue;
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && 'kind' in x) out.push([k, x as ASTNode]); }
    else if (v && typeof v === 'object' && 'kind' in v) out.push([k, v as ASTNode]);
  }
  return out;
}

/**
 * Every Identifier node that names a variable: not a member name, a label, or a
 * declaration's own name.
 */
function mentions(root: ASTNode, names: ReadonlySet<string>, out: Set<ASTNode>): void {
  const walk = (n: ASTNode): void => {
    if (n.kind === NodeKind.Identifier) {
      if (names.has((n as Identifier).name)) out.add(n);
      return;
    }
    for (const [k, c] of childNodes(n)) {
      if (n.kind === NodeKind.MemberExpr && k === 'member') continue;
      if ((n.kind === NodeKind.LabelStmt || n.kind === NodeKind.GotoStmt) && k === 'label') continue;
      if (n.kind === NodeKind.VariableDecl && k === 'name') continue;
      walk(c);
    }
  };
  walk(root);
}

interface Var {
  type: TypeNode;
  param: boolean;
  decl: VariableDecl | null;
}

/** Parameters and locals declared exactly once, not static, by name; and every declared name. */
function variables(fn: FunctionDecl): { vars: Map<string, Var>; all: Set<string> } {
  const out = new Map<string, Var>();
  const bad = new Set<string>();
  const all = new Set<string>();
  const add = (name: string, v: Var) => {
    all.add(name);
    if (out.has(name)) bad.add(name);
    out.set(name, v);
  };
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) add(p.name.name, { type: p.type, param: true, decl: null });
  for (const x of traverseAST(fn.body!)) {
    if (x.kind !== NodeKind.VariableDecl) continue;
    const v = x as VariableDecl;
    if (v.specifiers.length > 0 || v.bitWidth || v.directInit || v.copyListInit) bad.add(v.name.name);
    add(v.name.name, { type: v.type, param: false, decl: v });
  }
  for (const [n, v] of out) {
    const t = v.type as unknown as { kind: NodeKind };
    if (t.kind === NodeKind.ReferenceType || t.kind === NodeKind.RValueReferenceType || t.kind === NodeKind.ArrayType) bad.add(n);
    if (/\bvolatile\b/.test(emit(v.type as unknown as AnyNode))) bad.add(n);
  }
  for (const n of bad) out.delete(n);
  return { vars: out, all };
}

/** `a = b` with both sides bare identifiers, or null. */
function plainCopy(e: Expression | null | undefined): { a: string; b: string } | null {
  if (!e) return null;
  const x = unwrap(e);
  if (x.kind !== NodeKind.AssignExpr || (x as AssignExpr).operator !== '=') return null;
  const l = unwrap((x as AssignExpr).left), r = unwrap((x as AssignExpr).right);
  if (l.kind !== NodeKind.Identifier || r.kind !== NodeKind.Identifier) return null;
  const a = (l as Identifier).name, b = (r as Identifier).name;
  return a === b ? null : { a, b };
}

/** Does `e` write `names` anywhere: an assignment, `++`/`--`, through `.`/`[]` of the name? */
function writesAny(e: ASTNode, names: ReadonlySet<string>): boolean {
  const root = (t: Expression): string | null => {
    let x = unwrap(t);
    for (;;) {
      if (x.kind === NodeKind.Identifier) return (x as Identifier).name;
      if (x.kind === NodeKind.MemberExpr && !(x as unknown as { isArrow: boolean }).isArrow) { x = unwrap((x as unknown as { object: Expression }).object); continue; }
      if (x.kind === NodeKind.SubscriptExpr) { x = unwrap((x as unknown as { array: Expression }).array); continue; }
      return null;
    }
  };
  for (const x of traverseAST(e)) {
    let target: Expression | null = null;
    if (x.kind === NodeKind.AssignExpr) target = (x as AssignExpr).left;
    else if (x.kind === NodeKind.PostfixExpr) target = (x as unknown as { operand: Expression }).operand;
    else if (x.kind === NodeKind.UnaryExpr && ((x as UnaryExpr).operator === '++' || (x as UnaryExpr).operator === '--')) target = (x as UnaryExpr).operand;
    if (!target) continue;
    const r = root(target);
    if (r !== null && names.has(r)) return true;
  }
  return false;
}

/**
 * The frame locals a callee may reach through an address that leaves the frame - which
 * frame-group-locals may make members of a frame object: split-lives' `frameReach` (from
 * each escaping address, the bytes a known callee reach covers, else every following
 * local with a hole of at most MAX_GAP bytes), and from every array local, which a
 * callee is handed without `&`, the widest run. Null when the frame cannot be judged: a
 * frame position named by offset, or no frame and an escape.
 */
function frameMembers(fn: FunctionDecl, options: CopyCoalesceOptions): Set<string> | null {
  const slots = options.slots;
  const seeds = new Set<string>();
  const escapes = new Set<string>();
  let named = false;
  const walk = (n: ASTNode, parent: ASTNode | null): void => {
    if (n.kind === NodeKind.Identifier && /stack0x/i.test((n as Identifier).name)) named = true;
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      let t = unwrap((n as UnaryExpr).operand);
      while (t.kind === NodeKind.MemberExpr && !(t as unknown as { isArrow: boolean }).isArrow) t = unwrap((t as unknown as { object: Expression }).object);
      while (t.kind === NodeKind.SubscriptExpr) t = unwrap((t as unknown as { array: Expression }).array);
      const deref = parent?.kind === NodeKind.UnaryExpr && (parent as UnaryExpr).operator === '*';
      if (t.kind === NodeKind.Identifier && !deref) escapes.add((t as Identifier).name);
    }
    if (n.kind === NodeKind.VariableDecl) {
      const t = (n as VariableDecl).type as unknown as { kind: NodeKind };
      if (t && t.kind === NodeKind.ArrayType) seeds.add((n as VariableDecl).name.name);
    }
    for (const [, c] of childNodes(n)) walk(c, n.kind === NodeKind.ParenExpr ? parent : n);
  };
  walk(fn.body!, null);
  if (named) return null;
  if (!slots) {
    const locals = new Set<string>();
    for (const x of traverseAST(fn.body!)) if (x.kind === NodeKind.VariableDecl) locals.add((x as VariableDecl).name.name);
    for (const s of [...seeds, ...escapes]) if (locals.has(s)) return null;
    return new Set();
  }
  const frame = slots.filter(s => !s.isParameter && s.offset < 0 && s.size > 0).sort((x, y) => x.offset - y.offset);
  const reach = frameReach(fn.body!, slots, {
    slots, argReach: options.argReach, computedArgReach: options.computedArgReach, bodyReach: options.bodyReach,
  } as SplitLivesOptions);
  const out = new Set<string>(reach.members.keys());
  // A local whose address escapes is never folded, whether or not it has a slot.
  for (const name of escapes) out.add(name);
  for (const name of seeds) {
    const i = frame.findIndex(s => s.name === name);
    if (i < 0) continue;
    out.add(name);
    let end = frame[i].offset + frame[i].size;
    for (let j = i + 1; j < frame.length && frame[j].offset <= end + MAX_GAP; j++) {
      out.add(frame[j].name);
      end = Math.max(end, frame[j].offset + frame[j].size);
    }
  }
  return out;
}

/** Is every use of `a` inside the scope of b's declaration, after it? */
function inScope(fn: FunctionDecl, a: string, b: string, bVar: Var): boolean {
  if (bVar.param) return true;
  let ok = true;
  const walk = (n: ASTNode, scopes: Set<string>[]): void => {
    if (!ok) return;
    if (n.kind === NodeKind.Identifier) {
      if ((n as Identifier).name === a && !scopes.some(s => s.has(b))) ok = false;
      return;
    }
    if (n.kind === NodeKind.CompoundStmt) {
      const inner = [...scopes, new Set<string>()];
      for (const s of (n as CompoundStmt).statements) walk(s, inner);
      return;
    }
    if (n.kind === NodeKind.ForStmt) {
      const f = n as ForStmt;
      const inner = [...scopes, new Set<string>()];
      if (f.init) walk(f.init, inner);
      if (f.condition) walk(f.condition, inner);
      if (f.increment) walk(f.increment, inner);
      walk(f.body, inner);
      return;
    }
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      if (v.initializer) walk(v.initializer as ASTNode, scopes);
      scopes[scopes.length - 1].add(v.name.name);
      return;
    }
    for (const [k, c] of childNodes(n)) {
      if (n.kind === NodeKind.MemberExpr && k === 'member') continue;
      if ((n.kind === NodeKind.LabelStmt || n.kind === NodeKind.GotoStmt) && k === 'label') continue;
      walk(c, scopes);
    }
  };
  walk(fn.body!, [new Set<string>()]);
  return ok;
}

/** A comma expression's operands, left to right (`a, b` may parse as a binary `,`), or null. */
function commaOperands(e: ASTNode): Expression[] | null {
  if (e.kind === NodeKind.CommaExpr) return (e as CommaExpr).expressions;
  if (e.kind !== NodeKind.BinaryExpr || (e as BinaryExpr).operator as string !== ',') return null;
  const out: Expression[] = [];
  const walk = (x: Expression) => {
    if (x.kind === NodeKind.BinaryExpr && (x as BinaryExpr).operator as string === ',') {
      walk((x as BinaryExpr).left);
      walk((x as BinaryExpr).right);
    } else {
      out.push(x);
    }
  };
  walk(e as Expression);
  return out;
}

/** What a node of the graph is, for the fold. */
type Shape =
  | { kind: 'copy'; drop: ASTNode }      // a = b, droppable
  | { kind: 'back'; drop: ASTNode }      // b = a, droppable; a read of a
  | { kind: 'decl' }                     // a's own declaration, `T a = b;` or `T a;`
  | { kind: 'storeB' }                   // b = e / b op= e, e free of writes of a and b
  | { kind: 'other' };

/** The droppable thing a node stands for: a whole expression statement, or a comma operand. */
function nodeShape(flow: FunctionFlow, id: number, a: string, b: string, aDecl: VariableDecl): Shape {
  const n = flow.cfg.nodes[id];
  let e: Expression | null = null;
  let drop: ASTNode | null = null;
  if (n.stmt) {
    if (n.lowered) return { kind: 'other' };
    if (n.stmt.kind === NodeKind.DeclStmt) {
      const ds = (n.stmt as DeclStmt).declarations;
      if (ds.some(d => d === aDecl)) {
        if (ds.length !== 1) return { kind: 'other' };
        const init = aDecl.initializer;
        if (!init) return { kind: 'decl' };
        if (init.kind === NodeKind.InitListExpr) return { kind: 'other' };
        const r = unwrap(init as Expression);
        return r.kind === NodeKind.Identifier && (r as Identifier).name === b ? { kind: 'decl' } : { kind: 'other' };
      }
      return { kind: 'other' };
    }
    if (n.stmt.kind !== NodeKind.ExprStmt) return { kind: 'other' };
    e = (n.stmt as ExprStmt).expression;
    drop = n.stmt;
  } else if (n.expr && n.condPart === 'effect') {
    e = n.expr;
    drop = unwrap(n.expr) as ASTNode;
  } else {
    return { kind: 'other' };
  }
  if (!e) return { kind: 'other' };
  const c = plainCopy(e);
  if (c && c.a === a && c.b === b) return { kind: 'copy', drop: drop! };
  if (c && c.a === b && c.b === a) return { kind: 'back', drop: drop! };
  const x = unwrap(e);
  if (x.kind === NodeKind.AssignExpr) {
    const l = unwrap((x as AssignExpr).left);
    if (l.kind === NodeKind.Identifier && (l as Identifier).name === b
        && !writesAny((x as AssignExpr).right as ASTNode, new Set([a, b]))) return { kind: 'storeB' };
  }
  return { kind: 'other' };
}

interface Proof {
  /** The statements and comma operands that go. */
  drops: Set<ASTNode>;
}

/** Can a be folded into b? The statements and operands the fold drops, or null. */
function provable(fn: FunctionDecl, vars: Map<string, Var>, members: ReadonlySet<string>, flow: FunctionFlow,
                  a: string, b: string): Proof | null {
  const va = vars.get(a), vb = vars.get(b);
  if (!va || !vb || va.param || !va.decl) return null;
  if (members.has(a) || members.has(b)) return null;
  if (emit(va.type as unknown as AnyNode) !== emit(vb.type as unknown as AnyNode)) return null;
  if (flow.isEscaped(a) || flow.isEscaped(b)) return null;

  // Every mention of a or b is one some node evaluates.
  const names = new Set([a, b]);
  const all = new Set<ASTNode>();
  mentions(fn.body!, names, all);
  const covered = new Set<ASTNode>();
  for (const n of flow.cfg.nodes) for (const e of flow.ownExprs(n.id)) mentions(e as ASTNode, names, covered);
  for (const m of all) if (!covered.has(m)) return null;

  const N = flow.cfg.nodes.length;
  const shapes: Shape[] = [];
  const drops = new Set<ASTNode>();
  let copies = 0;
  for (let id = 0; id < N; id++) {
    const s = nodeShape(flow, id, a, b, va.decl);
    shapes.push(s);
    const wa = flow.writes(id).has(a);
    if (wa) {
      // Every write of a is a copy the fold drops, or a's own declaration.
      if (s.kind === 'copy') { drops.add(s.drop); copies++; }
      else if (s.kind !== 'decl') return null;
    }
    if (s.kind === 'back') drops.add(s.drop);
  }
  if (copies === 0 && ![...shapes].some(s => s.kind === 'decl' && va.decl!.initializer)) return null;

  // "a == b" on entry to each node: AND over predecessors, false at the entry.
  const preds: number[][] = flow.cfg.nodes.map(() => []);
  for (const n of flow.cfg.nodes) for (const s of n.succ) preds[s].push(n.id);
  const entries = new Set<number>([flow.cfg.entry, ...flow.cfg.extraEntries]);
  const IN = new Array<boolean>(N).fill(true);
  const OUT = new Array<boolean>(N).fill(true);
  const transfer = (id: number): boolean => {
    const s = shapes[id];
    if (s.kind === 'copy' || s.kind === 'back') return true;
    if (s.kind === 'decl') return va.decl!.initializer ? true : false;
    if (flow.writes(id).has(a) || flow.writes(id).has(b)) return false;
    return IN[id];
  };
  const work: number[] = flow.cfg.nodes.map(n => n.id);
  const queued = new Set(work);
  while (work.length) {
    const id = work.shift()!;
    queued.delete(id);
    let inn = !entries.has(id);
    if (inn) for (const p of preds[id]) if (!OUT[p]) { inn = false; break; }
    IN[id] = inn;
    const out = transfer(id);
    if (out !== OUT[id]) {
      OUT[id] = out;
      for (const s of flow.cfg.nodes[id].succ) if (!queued.has(s)) { queued.add(s); work.push(s); }
    }
  }

  for (let id = 0; id < N; id++) {
    const s = shapes[id];
    const readsA = flow.reads(id).has(a);
    if (!readsA) continue;
    if (s.kind === 'copy' || s.kind === 'decl') return null;
    if (!IN[id]) return null;
    if (s.kind === 'back' || s.kind === 'storeB') continue;
    if (flow.writes(id).has(a) || flow.writes(id).has(b)) return null;
  }
  // Belt and braces: the reaching definitions agree that no read of a sees its entry value.
  for (let id = 0; id < N; id++) {
    if (!flow.reads(id).has(a)) continue;
    if (flow.reaching(id, a).has(ENTRY_DEF)) return null;
  }
  if (!inScope(fn, a, b, vb)) return null;
  return { drops };
}

const EMPTY_BLOCK = (at: ASTNode): Statement => ({ kind: NodeKind.CompoundStmt, statements: [], location: (at as { location?: unknown }).location } as unknown as Statement);

/**
 * The body with a's declaration and the dropped copies removed and a renamed to b. Null
 * when a drop could not be placed.
 */
function fold(fn: FunctionDecl, a: string, b: string, decl: VariableDecl, drops: ReadonlySet<ASTNode>): FunctionDecl | null {
  let dropped = 0;
  let declGone = false;
  const isDeclStmt = (s: ASTNode) => s.kind === NodeKind.DeclStmt && (s as DeclStmt).declarations.length === 1 && (s as DeclStmt).declarations[0] === decl;
  const goes = (s: ASTNode) => drops.has(s) || isDeclStmt(s);
  const count = (s: ASTNode) => { if (isDeclStmt(s)) declGone = true; else dropped++; };
  const strip = (n: ASTNode): ASTNode => {
    if (n.kind === NodeKind.Identifier) return (n as Identifier).name === a ? { ...n, name: b } as ASTNode : n;
    if (n.kind === NodeKind.CompoundStmt) {
      const out: Statement[] = [];
      let carry: unknown[] | null = null;
      for (const s of (n as CompoundStmt).statements) {
        if (goes(s)) {
          count(s);
          const lt = (s as { leadingTrivia?: unknown[] }).leadingTrivia;
          if (lt && lt.length) carry = [...(carry ?? []), ...lt];
          continue;
        }
        let x = strip(s) as Statement;
        if (carry) {
          x = { ...x, leadingTrivia: [...carry, ...(((x as { leadingTrivia?: unknown[] }).leadingTrivia) ?? [])] } as Statement;
          carry = null;
        }
        out.push(x);
      }
      return { ...n, statements: out } as ASTNode;
    }
    const operands = commaOperands(n);
    if (operands) {
      const kept = operands.filter((e, k) => k === operands.length - 1 || !drops.has(unwrap(e) as ASTNode));
      dropped += operands.length - kept.length;
      const parts = kept.map(e => strip(e as ASTNode) as Expression);
      if (parts.length === 1) return parts[0] as ASTNode;
      if (n.kind === NodeKind.CommaExpr) return { ...n, expressions: parts } as ASTNode;
      const loc = (n as { location?: unknown }).location;
      return parts.reduce((l, r) => ({ kind: NodeKind.BinaryExpr, operator: ',', left: l, right: r, location: loc }) as unknown as Expression) as ASTNode;
    }
    let changed = false;
    const copy: Record<string, unknown> = { ...n };
    for (const [k, v] of Object.entries(n)) {
      if (SKIP_KEYS.has(k)) continue;
      if (n.kind === NodeKind.MemberExpr && k === 'member') continue;
      if ((n.kind === NodeKind.LabelStmt || n.kind === NodeKind.GotoStmt) && k === 'label') continue;
      if (n.kind === NodeKind.VariableDecl && k === 'name') continue;
      if (Array.isArray(v)) {
        const arr = v.map(x => (x && typeof x === 'object' && 'kind' in x) ? strip(x as ASTNode) : x);
        if (arr.some((x, i) => x !== v[i])) { copy[k] = arr; changed = true; }
      } else if (v && typeof v === 'object' && 'kind' in v) {
        // A dropped statement in a single-statement slot (a label's, a case's, an
        // unbraced body) leaves an empty block.
        // A loop's or condition's own init statement is left out.
        if (goes(v as ASTNode)) {
          count(v as ASTNode);
          copy[k] = k === 'init' ? null : EMPTY_BLOCK(v as ASTNode);
          changed = true;
          continue;
        }
        const y = strip(v as ASTNode);
        if (y !== v) { copy[k] = y; changed = true; }
      }
    }
    return changed ? copy as unknown as ASTNode : n;
  };
  const body = strip(fn.body!) as CompoundStmt;
  if (dropped !== drops.size || !declGone) return null;
  return updateNode(fn, { body } as Partial<FunctionDecl>);
}

/** Control the statement graph does not model. */
function unmodelled(fn: FunctionDecl): boolean {
  for (const x of traverseAST(fn.body!)) {
    if (x.kind === NodeKind.TryStmt || x.kind === NodeKind.SehTryStmt || x.kind === NodeKind.AsmDecl) return true;
    if (x.kind === NodeKind.Identifier) {
      const n = (x as Identifier).name;
      // An SEH frame installed by hand: a handler resumes with what memory holds.
      if (n === 'ExceptionList' || /^_?setjmp|^__asm|^_asm$/.test(n)) return true;
    }
  }
  return false;
}

/** Every `a = b` comma operand, statement or declaration initializer, as (a, b) pairs, in order. */
function copyPairs(fn: FunctionDecl): Array<{ a: string; b: string }> {
  const out: Array<{ a: string; b: string }> = [];
  const seen = new Set<string>();
  const push = (a: string, b: string) => {
    const k = `${a}\u0000${b}`;
    if (!seen.has(k)) { seen.add(k); out.push({ a, b }); }
  };
  for (const x of traverseAST(fn.body!)) {
    if (x.kind === NodeKind.AssignExpr) {
      const c = plainCopy(x as Expression);
      if (c) push(c.a, c.b);
    } else if (x.kind === NodeKind.VariableDecl) {
      const v = x as VariableDecl;
      const init = v.initializer;
      if (init && init.kind !== NodeKind.InitListExpr) {
        const r = unwrap(init as Expression);
        if (r.kind === NodeKind.Identifier && (r as Identifier).name !== v.name.name) push(v.name.name, (r as Identifier).name);
      }
    }
  }
  return out;
}

function rewriteFunction(fn: FunctionDecl, options: CopyCoalesceOptions): FunctionDecl | undefined {
  if (!fn.body || unmodelled(fn)) return undefined;
  let cur = fn;
  let changed = false;
  const refused = new Set<string>();
  // One fold per round: each changes the graph the next proof reads.
  for (let round = 0; round < 32; round++) {
    const { vars, all } = variables(cur);
    if (vars.size < 2) break;
    const members = frameMembers(cur, options);
    if (!members) break;
    const pairs = copyPairs(cur).filter(p => vars.has(p.a) && vars.has(p.b) && !refused.has(`${p.a}\u0000${p.b}`));
    if (pairs.length === 0) break;
    const pointers = new Set<string>();
    for (const [n, v] of vars) if ((v.type as unknown as { kind: NodeKind }).kind === NodeKind.PointerType) pointers.add(n);
    const flow = buildFunctionFlow(cur.body!.statements, all, { shortCircuitConditions: true, pointers });
    let next: FunctionDecl | null = null;
    for (const p of pairs) {
      const proof = provable(cur, vars, members, flow, p.a, p.b);
      if (proof) next = fold(cur, p.a, p.b, vars.get(p.a)!.decl!, proof.drops);
      if (next) break;
      refused.add(`${p.a}\u0000${p.b}`);
    }
    if (!next) break;
    cur = next;
    changed = true;
  }
  return changed ? cur : undefined;
}

/**
 * Fold local `a` into `b` (or into the one variable it copies) on the same proof, for the
 * vc8form `coalesce` form: the function with the fold made, or why it is refused. The
 * form runs after frame-group-locals, so a local a callee reaches by offset is a group
 * member by then and no identifier; one whose own address escapes is still refused.
 */
export function coalesceLocal(fn: FunctionDecl, a: string, b?: string): FunctionDecl | string {
  if (!fn.body) return 'no body';
  if (unmodelled(fn)) return 'control the graph does not model (SEH, try, setjmp, asm)';
  const { vars, all } = variables(fn);
  if (!vars.has(a)) return `${a} is not a local declared once, plain, of a foldable type`;
  const members = frameMembers(fn, { slots: [] });
  if (!members) return 'a frame position named by offset';
  const pairs = copyPairs(fn).filter(p => p.a === a && (b === undefined || p.b === b) && vars.has(p.b));
  if (pairs.length === 0) return `no copy into ${a}${b ? ` from ${b}` : ''}`;
  if (pairs.length > 1) return `${a} copies more than one variable`;
  const pointers = new Set<string>();
  for (const [n, v] of vars) if ((v.type as unknown as { kind: NodeKind }).kind === NodeKind.PointerType) pointers.add(n);
  const flow = buildFunctionFlow(fn.body.statements, all, { shortCircuitConditions: true, pointers });
  const proof = provable(fn, vars, members, flow, a, pairs[0].b);
  if (!proof) return `${a} == ${pairs[0].b} is not proven at every read`;
  return fold(fn, a, pairs[0].b, vars.get(a)!.decl!, proof.drops) ?? 'a copy could not be dropped in place';
}

function createCopyCoalesceTransformer(options: CopyCoalesceOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  });
}

export const copyCoalescePlugin: TransformPlugin = {
  id: 'copy-coalesce',
  name: 'Copy Coalesce',
  description: 'A local that only ever holds a copy of another variable\'s current value is folded into it, on a dataflow proof',
  version: '2.0.0',
  // Tree-wide the fold also costs MATCHes VC8 made from the second register; the vc8form
  // `coalesce` form applies it per function, where a compile has shown it pays.
  defaultEnabled: false,
  // After loop-copy-sink (62.7), which moves a loop-carried copy rather than folding it.
  priority: 62.75,
  tags: ['matching'],
  createTransformer: (options?: PluginOptions) => createCopyCoalesceTransformer(options as CopyCoalesceOptions),
};

export { createCopyCoalesceTransformer };
