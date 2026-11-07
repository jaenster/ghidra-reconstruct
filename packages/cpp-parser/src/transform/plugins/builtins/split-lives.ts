/**
 * Split Lives Plugin
 *
 * VC8 keeps several values in one place when their lifetimes do not overlap: one stack
 * slot (often a parameter's, once the parameter is dead) or one register holds an
 * integer, later a string pointer, later a unit pointer. The decompiler merges what
 * shares a slot into ONE variable - a stack parameter or an address-tied frame slot
 * cannot be split at all, its first-use offset is ignored on stack storage - and prints
 * that variable with the first value's type and a cast at every touch of the others:
 *
 *   nStatValue = (int32_t)D2Lang::...::GetLocaleString(0xf9b);
 *   ...
 *   AppendToBuffer(wszOutputBuffer, (uint16_t *)nStatValue);
 *
 * (ItemStatCost_DescFunc_DGrpFunc @004e4d80). The source had separate variables the
 * compiler happened to place in one slot. This pass gives each later value back a
 * variable of its own, typed from its own uses:
 *
 *   wszStatValue = D2Lang::...::GetLocaleString(0xf9b);
 *   ...
 *   AppendToBuffer(wszOutputBuffer, wszStatValue);
 *
 * The lives are the variable's webs: by reaching definitions over the CFG, every read
 * joins the definitions that reach it into one web, so two values a read can see from
 * either side (a JOIN: a loop around a store, a merge after an if) are one web and stay
 * one variable. Nothing is guessed: a web is moved to a new local only when
 *  - the variable is a parameter or a top-level local of a 4-byte word type (integer or
 *    pointer), declared once, whose address is never taken, and - when it lives in a
 *    frame slot - in a function where no frame slot's address is taken (a callee reaching
 *    past a neighbour's address would write it behind the split's back);
 *  - every write of it is a whole statement `v = e;`, `v op= e;`, `v++;` or `v--;`;
 *  - the web does not hold the entry value (a parameter's own value, or a local read
 *    before any store) and is read at least once;
 *  - its type is evident: every read that casts it to a pointer casts it to one type T, or
 *    (reads disagreeing or not casting) every store that is not a constant stores a
 *    value evidently of one type T;
 *  - T is of the other class than the declared type (a pointer life in an integer, an
 *    integer life in a pointer) or a pointer to another type, and the move removes more
 *    pointer/integer casts than it needs.
 *
 * The rewrite keeps every bit, since both types are one 4-byte word on the target: a
 * read `(T)v` becomes the local, a read cast to another type `(C)local` (through the
 * declared type where C is an integer of another width), a bare read `(DT)local`; a
 * store `v = (DT)x` stores x (cast to T where x is evidently another pointer), any
 * other store `(T)(e)`; `v op= e` becomes `local = (T)((DT)local op e)`.
 */

import { appendFileSync } from 'node:fs';
import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, CStyleCastExpr, DeclStmt, ExprStmt, Expression,
  FunctionDecl, Identifier, ParameterDecl, PostfixExpr, Statement, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { Expr, Decl, Stmt } from '../../../ast/factory.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { buildFunctionFlow, calleeSpelling, ENTRY_DEF, type FunctionFlow, type Reach } from '../../cfg/index.js';
import { callNeedsFrame, frameAliasOffset, knownCountWrites, movableLocals } from './frame-group-locals.js';
import { stackNameOffset, type StackSlot } from './stack-frame-address.js';
import { unwrapParens } from './call-arg-cast.js';
import {
  evidentType, isConstantStore, sameType, spellingOf, valueLocalName, wordClass,
  type ReusedParamSlotOptions,
} from './reused-param-slot.js';

export interface SplitLivesOptions extends PluginOptions {
  /** Callable name (bare AND qualified) -> declared return type, for a store's value type. */
  functionReturnTypes?: Record<string, string>;
  /** Aggregate -> field -> declared spelling. */
  structFields?: Record<string, Record<string, string>>;
  /** Field name -> spelling, where every aggregate declaring it agrees. */
  fieldTypes?: Record<string, string>;
  /** Global name -> declared spelling. */
  globalTypes?: Record<string, string>;
  /** Every enum constant name: a store of one is a constant. */
  enumConstants?: readonly string[];
  /**
   * The enclosing function's frame, from Ghidra's own variable list. A local is split
   * only where frame-group-locals cannot make it a member of a frame object - no
   * address of a slot below it leaves the frame - since a callee reaching past that
   * address writes the member behind the split's back. Absent: the pass does not run.
   */
  slots?: readonly StackSlot[];
  /** Each callee's reach through a pointer parameter, as frame-group-locals is given it. */
  argReach?: (callee: string, index: number, argCount: number) => Reach;
  /** The same for a computed callee. */
  computedArgReach?: (callee: Expression, index: number, argCount: number) => Reach;
  /** A callee's out-parameter width at an argument position (from its body), or null. */
  outParamWidth?: (callee: string, index: number) => number | null;
  /** The function as the run's report names it (address and name); the body's own name otherwise. */
  reportName?: string;
  /** One line per variable the pass split or refused, for the run's report. */
  onReport?: (fn: string, line: string) => void;
}

type WordClass = 'ptr' | 'int';

interface Write {
  node: number;
  /** The assignment or increment the node evaluates. */
  expr: Expression;
  /**
   * 'touch': a call handed `&v`, whose callee is known to reach only the word itself and
   * keep no copy of the address. The call reads and may write the variable while it runs.
   */
  kind: 'assign' | 'compound' | 'touch' | 'out';
  /**
   * 'out': a touch whose callee stores a whole word through the address before it reads
   * one (an out-parameter, from the callee's body) and the node reads v nowhere else: it
   * replaces the value, so a new value starts there. The placeholder standing for `&v`
   * and the type the call casts the address to.
   */
  placeholder?: Expression;
  castType?: TypeNode;
}

interface Occurrence {
  id: Identifier;
  /** The cast whose operand (through parentheses) is this read, if any. */
  cast: CStyleCastExpr | null;
  /**
   * A bare read displaced by a literal inside an integer cast to a pointer, `(T *)(v + 4)`:
   * the cast that reads v as an address, which a pointer life reads as `(T *)((DT)p + 4)`
   * and pointer-word-cast spells with a pointer-sized integer.
   */
  offset: CStyleCastExpr | null;
}

class UnionFind {
  private parent = new Map<number, number>();
  find(x: number): number {
    let p = this.parent.get(x);
    if (p === undefined) { this.parent.set(x, x); return x; }
    while (p !== x) {
      const g = this.parent.get(p)!;
      this.parent.set(x, g);
      x = p; p = g;
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const COMPOUND_OPS: Readonly<Record<string, string>> = {
  '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%', '&=': '&', '|=': '|', '^=': '^', '<<=': '<<', '>>=': '>>',
};

function isIdent(e: Expression | null | undefined, name: string): boolean {
  if (!e) return false;
  const u = unwrapParens(e);
  return u.kind === NodeKind.Identifier && (u as Identifier).name === name;
}

/** The write a node's own expression makes of `v`, when it is one of the accepted whole-statement forms. */
function wholeWrite(flow: FunctionFlow, node: number, v: string): Write | null {
  const n = flow.cfg.nodes[node];
  const own = flow.ownExprs(node);
  if (own.length !== 1) return null;
  if (n.stmt && n.stmt.kind !== NodeKind.ExprStmt) return null;
  const e = unwrapParens(own[0]);
  if (e.kind === NodeKind.AssignExpr) {
    const a = e as AssignExpr;
    if (!isIdent(a.left, v)) return null;
    if (a.operator === '=') return { node, expr: e, kind: 'assign' };
    // An update reading the variable on its right as well is not rewritten.
    if (COMPOUND_OPS[a.operator] && !findNodesByKind(a.right as unknown as ASTNode, NodeKind.Identifier).some(id => (id as Identifier).name === v)) {
      return { node, expr: e, kind: 'compound' };
    }
    return null;
  }
  if (e.kind === NodeKind.UnaryExpr || e.kind === NodeKind.PostfixExpr) {
    const op = (e as UnaryExpr).operator;
    const operand = (e as UnaryExpr | PostfixExpr).operand;
    if ((op === '++' || op === '--') && isIdent(operand, v)) return { node, expr: e, kind: 'compound' };
  }
  return null;
}

/** The cast class a spelling has for this pass: a pointer, a 4-byte integer, or neither. */
function classOf(spelling: string): WordClass | null {
  const c = wordClass(spelling);
  return c === 'ptr' || c === 'int' ? c : null;
}

const INT_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);

/**
 * The cast class of a stored value: its evident type's, or an integer for arithmetic on
 * integers (`a - b`, `-(int)p`), which no declared type names but which is a number all
 * the same. A store cast through the declared pointer type, `p = (T *)(a - b)`, then
 * moves into an integer life without the cast instead of through two.
 */
function valueClass(e: Expression, o: ReusedParamSlotOptions, localTypes: ReadonlyMap<string, TypeNode>, enumConstants: ReadonlySet<string>): WordClass | 'enum' | null {
  const t = evidentType(e, o, localTypes);
  if (t) return wordClass(spellingOf(t));
  const x = unwrapParens(e);
  if (x.kind === NodeKind.IntegerLiteral) return 'int';
  if (x.kind === NodeKind.Identifier && enumConstants.has((x as Identifier).name)) return 'int';
  if (x.kind === NodeKind.UnaryExpr && ['-', '~'].includes((x as UnaryExpr).operator)) {
    return isNumber(valueClass((x as UnaryExpr).operand, o, localTypes, enumConstants)) ? 'int' : null;
  }
  if (x.kind === NodeKind.BinaryExpr && INT_OPS.has((x as BinaryExpr).operator)) {
    const b = x as BinaryExpr;
    return isNumber(valueClass(b.left, o, localTypes, enumConstants)) && isNumber(valueClass(b.right, o, localTypes, enumConstants)) ? 'int' : null;
  }
  return null;
}
const isNumber = (c: WordClass | 'enum' | null) => c === 'int' || c === 'enum';

/** Every identifier in the body, declarations and references alike: names a new local must not take. */
function namesIn(body: ASTNode): Set<string> {
  const out = new Set<string>();
  for (const id of findNodesByKind(body, NodeKind.Identifier)) out.add((id as Identifier).name);
  for (const d of findNodesByKind(body, NodeKind.VariableDecl)) out.add((d as VariableDecl).name.name);
  return out;
}

/**
 * The frame locals frame-group-locals may make members of a frame object. A run starts
 * where it starts one, as it decides that:
 * a local whose address leaves the frame (handed to a call that reaches past it or
 * whose reach is unknown, stored, used as an initialiser - anything but a dereference),
 * a local a counted copy or fill (`memset(buf, 0, 0x40)`) writes, and - when the body
 * names a frame base no slot carries - the lowest local. A run extends from its start
 * through every local that follows it with a hole of at most one word (frame-group-locals'
 * MAX_GAP) - the widest a run can reach, as it may stop sooner.
 */
function frameMembers(body: CompoundStmt, slots: readonly StackSlot[], o: SplitLivesOptions): Set<string> {
  const offsetOf = new Map<string, StackSlot>();
  for (const s of slots) if (!s.isParameter) offsetOf.set(s.name, s);
  const seeds = new Map<string, number>();
  let baseFold = false;
  const seed = (name: string, bytes = 0) => { if (offsetOf.has(name)) seeds.set(name, Math.max(seeds.get(name) ?? 0, bytes)); };
  for (const [name, bytes] of knownCountWrites(body, movableLocals(body))) seed(name, bytes);
  const walk = (x: unknown, chain: ASTNode[]): void => {
    if (Array.isArray(x)) { for (const i of x) walk(i, chain); return; }
    if (!x || typeof x !== 'object') return;
    const node = x as ASTNode;
    if (node.kind === NodeKind.Identifier && /stack0x/.test((node as Identifier).name)) {
      // A frame position the decompiler names by offset: in the argument area it is no
      // local's; on a local's slot it is that local's address or its word by another name,
      // a seed and a member; anywhere else it is a frame base, which frame-group-locals
      // seeds at the lowest local so the run reaches every object the fold might touch.
      const at = stackNameOffset((node as Identifier).name);
      if (at !== null && at >= 0) return;
      const slot = at === null ? undefined : slots.find(x => !x.isParameter && x.offset === at);
      if (!slot) { baseFold = true; return; }
      seed(slot.name);
      return;
    }
    if (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '&') {
      const target = unwrapParens((node as UnaryExpr).operand);
      if (target.kind === NodeKind.Identifier) {
        const name = (target as Identifier).name;
        let i = chain.length - 1;
        let child: ASTNode = node;
        while (i >= 0 && (chain[i].kind === NodeKind.ParenExpr || chain[i].kind === NodeKind.CStyleCastExpr)) { child = chain[i]; i--; }
        const parent = i >= 0 ? chain[i] : null;
        let harmless = false;
        if (parent?.kind === NodeKind.UnaryExpr && (parent as UnaryExpr).operator === '*') harmless = true;
        else if (parent?.kind === NodeKind.CallExpr) {
          const call = parent as CallExpr;
          const index = call.arguments.indexOf(child as Expression);
          const size = offsetOf.get(name)?.size;
          harmless = index >= 0 && o.argReach !== undefined
            && !callNeedsFrame(call, index, name, o.argReach, () => size, undefined, o.computedArgReach);
        }
        if (!harmless) seed(name);
      }
    }
    const next = [...chain, node];
    for (const [k, val] of Object.entries(node)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (val && typeof val === 'object') walk(val, next);
    }
  };
  walk(body.statements, []);
  const locals = slots.filter(s => !s.isParameter && s.offset < 0 && s.size > 0).sort((a, b) => a.offset - b.offset);
  if (baseFold && locals.length > 0) seed(locals[0].name);
  const members = new Set<string>();
  for (const [name, bytes] of seeds) {
    const i = locals.findIndex(s => s.name === name);
    if (i < 0) continue;
    members.add(name);
    let end = locals[i].offset + Math.max(locals[i].size, bytes);
    for (let j = i + 1; j < locals.length && locals[j].offset <= end + 4; j++) {
      members.add(locals[j].name);
      end = Math.max(end, locals[j].offset + locals[j].size);
    }
  }
  return members;
}

/**
 * The body with every `&v` replaced by a placeholder the dataflow reads as a read and a
 * write of v at that call (`v += 0`), when each one is handed straight to a call whose
 * callee is known to reach only bytes [0, 4) of it - the reach analysis calls an address
 * that is stored, returned or computed with unknown, so a known reach also says the
 * callee keeps no copy of it. Null when some `&v` is anything else.
 */
function callScopedAddresses(statements: Statement[], v: string, o: SplitLivesOptions):
  { statements: Statement[]; placeholders: Map<object, Expression>; outs: Map<object, TypeNode | null> } | null {
  const placeholders = new Map<object, Expression>();
  /** Placeholders handed to an out-parameter, with the pointer type the address is cast to. */
  const outs = new Map<object, TypeNode | null>();
  let bad = false;
  const visit = (x: unknown, chain: ASTNode[]): unknown => {
    if (bad) return x;
    if (Array.isArray(x)) {
      let ch = false;
      const out = x.map(i => { const r = visit(i, chain); if (r !== i) ch = true; return r; });
      return ch ? out : x;
    }
    if (!x || typeof x !== 'object') return x;
    const node = x as ASTNode;
    if (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '&' && isIdent((node as UnaryExpr).operand, v)) {
      let i = chain.length - 1;
      let child: ASTNode = node;
      while (i >= 0 && (chain[i].kind === NodeKind.ParenExpr || chain[i].kind === NodeKind.CStyleCastExpr)) { child = chain[i]; i--; }
      const parent = i >= 0 ? chain[i] : null;
      const call = parent?.kind === NodeKind.CallExpr ? parent as CallExpr : null;
      const index = call ? call.arguments.indexOf(child as Expression) : -1;
      if (!call || index < 0 || !o.argReach || callNeedsFrame(call, index, v, o.argReach, () => 4, undefined, o.computedArgReach)) {
        bad = true;
        return x;
      }
      const ph = Expr.assign(Expr.identifier(v) as unknown as Expression, Expr.intLiteral(0) as unknown as Expression, '+=') as unknown as Expression;
      placeholders.set(ph, node as unknown as Expression);
      const callee = calleeSpelling(call);
      const width = callee && o.outParamWidth ? o.outParamWidth(callee, index) : null;
      if (width !== null && width >= 4) {
        let cast: TypeNode | null = null;
        for (let j = chain.length - 1; j > i; j--) {
          if (chain[j].kind === NodeKind.CStyleCastExpr) { cast = (chain[j] as CStyleCastExpr).type; break; }
        }
        outs.set(ph, cast);
      }
      return ph;
    }
    const next = [...chain, node];
    let copy: Record<string, unknown> | null = null;
    for (const [k, val] of Object.entries(node)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type' || !val || typeof val !== 'object') continue;
      const r = visit(val, next);
      if (r !== val) { copy = copy ?? { ...(node as object) } as Record<string, unknown>; copy[k] = r; }
    }
    return copy ?? x;
  };
  const out = visit(statements, []) as Statement[];
  return bad ? null : { statements: out, placeholders, outs };
}

/** Put each `&v` back where its placeholder stands. */
function restoreAddresses(statements: Statement[], placeholders: ReadonlyMap<object, Expression>): Statement[] {
  if (placeholders.size === 0) return statements;
  const visit = (x: unknown): unknown => {
    if (Array.isArray(x)) {
      let ch = false;
      const out = x.map(i => { const r = visit(i); if (r !== i) ch = true; return r; });
      return ch ? out : x;
    }
    if (!x || typeof x !== 'object') return x;
    const back = placeholders.get(x);
    if (back) return back;
    let copy: Record<string, unknown> | null = null;
    for (const [k, val] of Object.entries(x as object)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type' || !val || typeof val !== 'object') continue;
      const r = visit(val);
      if (r !== val) { copy = copy ?? { ...(x as object) } as Record<string, unknown>; copy[k] = r; }
    }
    return copy ?? x;
  };
  return visit(statements) as Statement[];
}

/** `5`, `-1`, `0xffffffff`: an integer literal, possibly negated; null otherwise. */
function literalOf(e: Expression): Expression | null {
  const u = unwrapParens(e);
  if (u.kind === NodeKind.IntegerLiteral) return u;
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-' && unwrapParens((u as UnaryExpr).operand).kind === NodeKind.IntegerLiteral) return u;
  return null;
}

interface Web {
  defs: number[];
  reads: number[];
}

export function splitLives(fn: FunctionDecl, o: SplitLivesOptions): Statement[] | null {
  const body = fn.body as CompoundStmt | undefined;
  if (!body) return null;
  const fnName = o.reportName ?? (fn.name as { name?: string })?.name ?? '?';
  const report = (line: string) => o.onReport?.(fnName, line);
  const params = fn.parameters.map(p => p as ParameterDecl).filter(p => p.name);
  let statements = body.statements as Statement[];

  // Candidates: parameters and top-level locals of a word type, each name declared once.
  const declCount = new Map<string, number>();
  const types = new Map<string, TypeNode>();
  for (const p of params) { declCount.set(p.name!.name, (declCount.get(p.name!.name) ?? 0) + 1); types.set(p.name!.name, p.type); }
  for (const d of findNodesByKind(body, NodeKind.VariableDecl)) {
    const v = d as VariableDecl;
    declCount.set(v.name.name, (declCount.get(v.name.name) ?? 0) + 1);
    types.set(v.name.name, v.type);
  }
  const topLocals = new Map<string, VariableDecl>();
  for (const st of statements) {
    if (st.kind !== NodeKind.DeclStmt) break;
    for (const d of (st as DeclStmt).declarations) {
      if (d.kind === NodeKind.VariableDecl && !(d as VariableDecl).initializer) topLocals.set((d as VariableDecl).name.name, d as VariableDecl);
    }
  }
  const candidates: string[] = [];
  for (const name of [...params.map(p => p.name!.name), ...topLocals.keys()]) {
    if (declCount.get(name) !== 1) { report(`${name}: other: declared ${declCount.get(name)} times`); continue; }
    const t = spellingOf(types.get(name)!);
    if (!classOf(t) || /\bcode\b/.test(t)) { report(`${name}: other: type ${t}`); continue; }
    candidates.push(name);
  }
  if (candidates.length === 0) return null;

  const declared = new Set<string>(declCount.keys());
  const localTypes = new Map<string, TypeNode>(types);
  const members = frameMembers(body, o.slots ?? [], o);
  const argAreaNamed = findNodesByKind(body as unknown as ASTNode, NodeKind.Identifier)
    .some(id => { const at = stackNameOffset((id as Identifier).name); return at !== null && at >= 0; });
  const taken = namesIn(body as unknown as ASTNode);
  for (const p of params) taken.add(p.name!.name);
  const enumConstants = new Set(o.enumConstants ?? []);
  const evidentOptions = o as ReusedParamSlotOptions;
  let changed = false;

  for (const v of candidates) {
    const proxied = callScopedAddresses(statements, v, o);
    if (!proxied) { report(`${v}: refused: its address leaves the frame`); continue; }
    const work = proxied.statements;
    const placeholders = proxied.placeholders;
    const outs = proxied.outs;
    const flow = buildFunctionFlow(work, declared);
    if (flow.isEscaped(v)) { report(`${v}: other: escaped`); continue; }
    if (!topLocals.has(v) && argAreaNamed) {
      // The argument area read by offset (`stack0x00000008`) may be this parameter's word.
      report(`${v}: refused: the argument area is named by offset`);
      continue;
    }
    if (topLocals.has(v)) {
      const slot = (o.slots ?? []).find(x => x.name === v && !x.isParameter);
      // A name the frame does not carry but whose auto-name encodes a frame position is a
      // piece of another slot, which frame-group-locals lays out with it.
      if (!slot && frameAliasOffset(v) !== null) { report(`${v}: refused: a piece of a frame slot`); continue; }
      if (members.has(v)) {
        report(`${v}: refused: a frame object may hold its slot`);
        continue;
      }
    }
    const declaredType = types.get(v)!;
    const dt = spellingOf(declaredType);
    const dtClass = classOf(dt)!;

    // The writes, each a whole statement.
    const writes = new Map<number, Write>();
    // A declaration without an initializer holds the same indeterminate value as entry.
    const bareDecls: number[] = [];
    let odd = false;
    for (const n of flow.cfg.nodes) {
      if (!flow.writes(n.id).has(v)) continue;
      if (n.stmt?.kind === NodeKind.DeclStmt && (n.stmt as DeclStmt).declarations.some(d =>
        d.kind === NodeKind.VariableDecl && (d as VariableDecl).name.name === v && !(d as VariableDecl).initializer)) {
        bareDecls.push(n.id);
        continue;
      }
      if (placeholders.size > 0) {
        // A call handed `&v`: every write of v the node makes must be such a call's.
        const own = flow.ownExprs(n.id);
        const kinds = (k: NodeKind) => own.flatMap(e => findNodesByKind(e as unknown as ASTNode, k));
        const touches = kinds(NodeKind.AssignExpr).filter(a => placeholders.has(a)).length;
        if (touches > 0) {
          const all = kinds(NodeKind.AssignExpr).filter(a => isIdent((a as AssignExpr).left, v)).length
            + [...kinds(NodeKind.UnaryExpr), ...kinds(NodeKind.PostfixExpr)]
              .filter(u => ((u as UnaryExpr).operator === '++' || (u as UnaryExpr).operator === '--') && isIdent((u as UnaryExpr).operand, v)).length;
          if (all !== touches) { odd = true; break; }
          const handed = kinds(NodeKind.AssignExpr).filter(a => placeholders.has(a));
          const mentions = kinds(NodeKind.Identifier).filter(id => (id as Identifier).name === v).length;
          // One out-parameter call, and v named nowhere else in the node: a fresh value.
          if (touches === 1 && outs.has(handed[0]) && mentions === 1) {
            const castType = outs.get(handed[0]) ?? undefined;
            writes.set(n.id, { node: n.id, expr: own[0], kind: 'out', placeholder: handed[0] as unknown as Expression, castType });
            continue;
          }
          writes.set(n.id, { node: n.id, expr: own[0], kind: 'touch' });
          continue;
        }
      }
      const w = wholeWrite(flow, n.id, v);
      if (!w) { odd = true; break; }
      writes.set(n.id, w);
    }
    if (odd) { report(`${v}: refused: written inside an expression`); continue; }
    if (writes.size === 0) { report(`${v}: single: never stored`); continue; }

    // The webs: a read joins every definition that reaches it; an update joins its own
    // definition to the ones it reads.
    const uf = new UnionFind();
    uf.find(ENTRY_DEF);
    for (const id of bareDecls) uf.union(id, ENTRY_DEF);
    for (const id of writes.keys()) uf.find(id);
    const readNodes: number[] = [];
    let unreached = false;
    for (const n of flow.cfg.nodes) {
      if (!flow.reads(n.id).has(v)) continue;
      // The placeholder reads v for the dataflow; an out-parameter call does not.
      if (writes.get(n.id)?.kind === 'out') continue;
      const reach = [...flow.reaching(n.id, v)];
      if (reach.length === 0) { unreached = true; break; }
      for (let i = 1; i < reach.length; i++) uf.union(reach[0], reach[i]);
      const w = writes.get(n.id);
      if (w && (w.kind === 'compound' || w.kind === 'touch')) uf.union(reach[0], n.id);
      readNodes.push(n.id);
    }
    if (unreached) { report(`${v}: refused: a read no definition reaches`); continue; }
    const webs = new Map<number, Web>();
    const webOf = (d: number): Web => {
      const r = uf.find(d);
      let w = webs.get(r);
      if (!w) { w = { defs: [], reads: [] }; webs.set(r, w); }
      return w;
    };
    webOf(ENTRY_DEF).defs.push(ENTRY_DEF);
    for (const id of bareDecls) webOf(id).defs.push(id);
    for (const id of writes.keys()) webOf(id).defs.push(id);
    for (const n of readNodes) webOf([...flow.reaching(n, v)][0]).reads.push(n);
    const entryRoot = uf.find(ENTRY_DEF);

    // Every read occurrence in a node, with the cast directly around it. The left side of
    // the node's own assignment is a write, not a read.
    const occurrencesIn = (node: number): Occurrence[] => {
      const w = writes.get(node);
      const lhs = w && w.kind === 'assign' ? unwrapParens((w.expr as AssignExpr).left) : null;
      const out: Occurrence[] = [];
      const walk = (x: unknown, cast: CStyleCastExpr | null, offset: CStyleCastExpr | null): void => {
        if (Array.isArray(x)) { for (const i of x) walk(i, null, null); return; }
        if (!x || typeof x !== 'object') return;
        const node = x as ASTNode;
        if (node.kind === NodeKind.Identifier) {
          if ((node as Identifier).name === v && node !== lhs) out.push({ id: node as Identifier, cast, offset: cast ? null : offset });
          return;
        }
        if (node.kind === NodeKind.CStyleCastExpr) {
          const c = node as CStyleCastExpr;
          walk(unwrapParens(c.expression), c, classOf(spellingOf(c.type)) === 'ptr' ? c : null);
          return;
        }
        if (node.kind === NodeKind.ParenExpr) { walk((node as unknown as { expression: Expression }).expression, cast, offset); return; }
        if (offset && node.kind === NodeKind.BinaryExpr) {
          const b = node as unknown as { operator: string; left: Expression; right: Expression };
          if (b.operator === '+' || b.operator === '-') {
            // Only a literal displacement: `(T *)(&G + v)` indexes G with v, it does not
            // make v the address.
            const lit = (e: Expression) => unwrapParens(e).kind === NodeKind.IntegerLiteral;
            walk(b.left, null, lit(b.right) ? offset : null);
            walk(b.right, null, b.operator === '+' && lit(b.left) ? offset : null);
            return;
          }
        }
        for (const [k, val] of Object.entries(node)) {
          if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
          if (val && typeof val === 'object') walk(val, null, null);
        }
      };
      walk(flow.ownExprs(node), null, null);
      return out;
    };

    // Plan every web that moves before rewriting any.
    interface Move { web: Web; type: TypeNode; spelling: string; cls: WordClass; local: string }
    const moves: Move[] = [];
    for (const [root, web] of webs) {
      if (root === entryRoot || web.reads.length === 0) continue;
      // A value whose address a call is handed stays where the address points.
      if (web.defs.some(d => writes.get(d)?.kind === 'touch')) continue;
      const occ = web.reads.flatMap(n => occurrencesIn(n));
      // Stores: the value each one stores, its cast to the declared type off.
      const storeTypes: (string | null)[] = [];
      const storeNodes: TypeNode[] = [];
      for (const d of web.defs) {
        const w = writes.get(d)!;
        if (w.kind === 'compound') continue;
        if (w.kind === 'out') {
          // `(T **)&v` handed to an out-parameter: the call stores a T *.
          const ct = w.castType ? spellingOf(w.castType) : '';
          const t = /\*\s*\*$/.test(ct) && !/^void\s*\*\s*\*$/.test(ct) ? (w.castType as unknown as { pointee?: TypeNode }).pointee ?? null : null;
          storeTypes.push(t ? spellingOf(t) : null);
          if (t) storeNodes.push(t);
          continue;
        }
        let x = unwrapParens((w.expr as AssignExpr).right);
        if (x.kind === NodeKind.CStyleCastExpr && sameType(spellingOf((x as CStyleCastExpr).type), dt)) x = unwrapParens((x as CStyleCastExpr).expression);
        if (isConstantStore(x, enumConstants, localTypes)) continue;
        // `v = v + 0x120`: the life stepping itself says nothing about its type.
        if (findNodesByKind(x as unknown as ASTNode, NodeKind.Identifier).some(id => (id as Identifier).name === v)) continue;
        const t = evidentType(x, evidentOptions, localTypes);
        storeTypes.push(t ? spellingOf(t) : null);
        if (t) storeNodes.push(t);
      }
      // Stores of two different types meeting at one read: a join of two values. It stays
      // one variable, as the decompiler printed it.
      const storedKinds = new Set(storeTypes.filter((t): t is string => t !== null && classOf(t) !== null && !sameType(t, dt)));
      if (storedKinds.size > 1) {
        report(`${v}: join: ${web.defs.length} stores of ${[...storedKinds].join(' | ')} reach ${web.reads.length} read nodes`);
        continue;
      }
      const ptrCasts = occ.filter(c => c.cast && classOf(spellingOf(c.cast.type)) === 'ptr').map(c => c.cast!);
      const intCasts = occ.filter(c => c.cast && classOf(spellingOf(c.cast.type)) === 'int').map(c => c.cast!);
      let target: TypeNode | null = null;
      let why = '';
      if (dtClass === 'int') {
        // A pointer life in an integer variable.
        const read = new Set(ptrCasts.map(c => spellingOf(c.type)));
        const stored = new Set(storeTypes);
        // A read that is a byte offset onto the value, `(T *)(v + 4)`, says the value is an
        // address, and of a T where nothing else says otherwise.
        const offsets = occ.filter(c => c.offset).map(c => c.offset!);
        const offsetTypes = new Set(offsets.map(c => spellingOf(c.type)));
        if (read.size === 1) target = ptrCasts[0].type;
        else if (storeTypes.length > 0 && stored.size === 1 && storeTypes[0] !== null && classOf(storeTypes[0]) === 'ptr') target = storeNodes[0];
        else if (read.size === 0 && storeTypes.every(t => t === null) && offsetTypes.size === 1) target = offsets[0].type;
        else why = read.size === 0 ? 'no read casts it to a pointer' : `read as ${read.size} pointer types, stores ${[...stored].join('|') || 'none'}`;
      } else {
        // An integer life (or a pointer to another type) in a pointer variable.
        const readInts = new Set(intCasts.map(c => spellingOf(c.type)));
        const readPtrs = new Set(ptrCasts.map(c => spellingOf(c.type)).filter(s => !sameType(s, dt)));
        const stored = new Set(storeTypes);
        if (readInts.size === 1 && readPtrs.size === 0 && ptrCasts.length === 0) target = intCasts[0].type;
        else if (readPtrs.size === 1 && intCasts.length === 0) target = ptrCasts.find(c => !sameType(spellingOf(c.type), dt))!.type;
        else if (storeTypes.length > 0 && stored.size === 1 && storeTypes[0] !== null && classOf(storeTypes[0]) && !sameType(storeTypes[0], dt)) target = storeNodes[0];
        else why = `reads ${[...readInts, ...readPtrs].join('|') || 'uncast'}, stores ${[...stored].join('|') || 'none'}`;
      }
      if (!target) {
        const stored = new Set(storeTypes.filter(s => s !== null));
        const join = web.defs.length > 1 && stored.size > 1;
        report(`${v}: ${join ? 'join' : 'untyped'}: ${web.defs.length} stores, ${occ.length} reads: ${why}`);
        continue;
      }
      const spelling = spellingOf(target);
      const cls = classOf(spelling);
      if (!cls || /\bcode\b/.test(spelling) || /\bundefined\b/.test(spelling) || sameType(spelling, dt)) continue;
      if (cls === 'int' && dtClass === 'int') continue;
      // A life that stores a pointer is a pointer life, whatever its reads cast it to: an
      // integer local would hold an address in an int, which truncates it where a pointer
      // is wider than an int.
      if (cls === 'int' && storeTypes.some(t => t !== null && classOf(t) === 'ptr')) {
        report(`${v}: pointer: a store into it is a pointer, so it stays ${spellingOf(declaredType)}`);
        continue;
      }

      // Width casts the move removes and the ones it needs.
      let gain = 0, cost = 0;
      for (const c of occ) {
        const cc = c.cast ? classOf(spellingOf(c.cast.type)) : null;
        if (c.offset && cls === 'ptr' && dtClass === 'int') { gain++; continue; }
        if (!c.cast || !cc) { if (cls !== dtClass) cost++; continue; }
        if (cc !== dtClass && cc === cls) gain++;
        else if (cc === dtClass && cc !== cls) cost++;
      }
      for (const d of web.defs) {
        const w = writes.get(d)!;
        if (w.kind === 'compound') { if (cls !== dtClass) cost += 2; continue; }
        if (w.kind === 'out') continue;
        const rhs = unwrapParens((w.expr as AssignExpr).right);
        if (rhs.kind === NodeKind.CStyleCastExpr && sameType(spellingOf((rhs as CStyleCastExpr).type), dt)) {
          const t = evidentType(unwrapParens((rhs as CStyleCastExpr).expression), evidentOptions, localTypes);
          const tc = t ? classOf(spellingOf(t)) : null;
          if (tc && tc !== dtClass && tc === cls) { gain++; continue; }
        }
        if (cls !== dtClass && !isConstantStore(rhs, enumConstants, localTypes)) cost++;
      }
      if (gain <= cost) {
        report(`${v}: kept: a ${spelling} life would remove ${gain} casts and need ${cost}`);
        continue;
      }
      const local = valueLocalName(spelling, v, taken);
      taken.add(local);
      moves.push({ web, type: target, spelling, cls, local });
    }
    if (moves.length === 0) continue;
    // A local with one value that is read is one variable of the wrong type, not several
    // sharing a slot: its type is Ghidra's to fix. A parameter's slot holding one other
    // value is the reuse itself.
    if (topLocals.has(v)) {
      const readLives = [...webs.values()].filter(w => w.reads.length > 0).length;
      if (readLives < 2) {
        report(`${v}: single: one value is read, its type is the variable's`);
        continue;
      }
    }

    // The rewrite: node identity -> its replacement, built from the rebuilt children.
    const replace = new Map<object, (rebuilt: ASTNode) => Expression>();
    const castTo = (t: TypeNode, e: Expression) => Expr.paren(Expr.cast(t, e)) as unknown as Expression;
    for (const m of moves) {
      const ident = () => Expr.identifier(m.local) as unknown as Expression;
      for (const n of m.web.reads) {
        const w = writes.get(n);
        if (w && w.kind === 'compound') continue; // rewritten whole below
        for (const c of occurrencesIn(n)) {
          if (!c.cast) { replace.set(c.id, () => castTo(declaredType, ident())); continue; }
          const ct = spellingOf(c.cast.type);
          const cc = classOf(ct);
          const castType = c.cast.type;
          if (sameType(ct, m.spelling)) replace.set(c.cast, () => ident());
          else if (cc === 'ptr' && m.cls === 'ptr') replace.set(c.cast, () => Expr.cast(castType, ident()) as unknown as Expression);
          else if (cc === 'int' && m.cls === 'int') replace.set(c.cast, () => Expr.cast(castType, ident()) as unknown as Expression);
          else if (sameType(ct, dt)) replace.set(c.cast, () => Expr.cast(castType, ident()) as unknown as Expression);
          else replace.set(c.cast, () => Expr.cast(castType, castTo(declaredType, ident())) as unknown as Expression);
        }
      }
      for (const d of m.web.defs) {
        const w = writes.get(d)!;
        if (w.kind === 'out') {
          // The call is handed the new local's address instead.
          replace.set(w.placeholder!, () => Expr.addressOf(ident()) as unknown as Expression);
          continue;
        }
        if (w.kind === 'compound') {
          const e = w.expr;
          let op: string, operand: Expression;
          if (e.kind === NodeKind.AssignExpr) { op = COMPOUND_OPS[(e as AssignExpr).operator]; operand = (e as AssignExpr).right; }
          else { op = (e as UnaryExpr).operator === '++' ? '+' : '-'; operand = Expr.intLiteral(1) as unknown as Expression; }
          const isAssign = e.kind === NodeKind.AssignExpr;
          replace.set(e, (rebuilt) => {
            const right = isAssign ? (rebuilt as AssignExpr).right : operand;
            const value = Expr.binary(castTo(declaredType, ident()), op as never, Expr.paren(right) as unknown as Expression) as unknown as Expression;
            return Expr.assign(ident(), m.cls === dtClass ? value : Expr.cast(m.type, Expr.paren(value)) as unknown as Expression) as unknown as Expression;
          });
          continue;
        }
        const a = w.expr as AssignExpr;
        const rhs = unwrapParens(a.right);
        let inner: Expression | null = null;
        let innerType: string | null = null;
        if (rhs.kind === NodeKind.CStyleCastExpr && sameType(spellingOf((rhs as CStyleCastExpr).type), dt)) {
          inner = unwrapParens((rhs as CStyleCastExpr).expression);
          const t = evidentType(inner, evidentOptions, localTypes);
          innerType = t ? spellingOf(t)
            : m.cls === 'int' && isNumber(valueClass(inner, evidentOptions, localTypes, enumConstants)) ? m.spelling : null;
        }
        replace.set(a, (rebuilt) => {
          const ra = rebuilt as AssignExpr;
          let value: Expression;
          // A literal, through the declared type's cast or bare: the same number, in the new
          // type (both are one 32-bit word).
          const lit = literalOf(inner ?? rhs);
          if (lit) {
            value = m.cls === 'int' ? lit : Expr.cast(m.type, lit) as unknown as Expression;
          } else if (inner && innerType && classOf(innerType) === m.cls) {
            // The value the store converted to the declared type: store it as it is.
            const rc = unwrapParens(ra.right);
            if (rc.kind !== NodeKind.CStyleCastExpr) return Expr.assign(ident(), Expr.cast(m.type, Expr.paren(ra.right) as unknown as Expression) as unknown as Expression) as unknown as Expression;
            const ri = unwrapParens((rc as CStyleCastExpr).expression);
            value = sameType(innerType, m.spelling) ? ri : Expr.cast(m.type, Expr.paren(ri) as unknown as Expression) as unknown as Expression;
          } else {
            value = Expr.cast(m.type, Expr.paren(ra.right) as unknown as Expression) as unknown as Expression;
          }
          return Expr.assign(ident(), value) as unknown as Expression;
        });
      }
      report(`${v}: split: ${m.local} ${m.spelling} (${m.web.defs.length} stores, ${m.web.reads.length} read nodes)`);
    }

    const rebuild = (x: unknown): unknown => {
      if (Array.isArray(x)) {
        let ch = false;
        const out = x.map(i => { const r = rebuild(i); if (r !== i) ch = true; return r; });
        return ch ? out : x;
      }
      if (!x || typeof x !== 'object') return x;
      const node = x as ASTNode;
      let copy: Record<string, unknown> | null = null;
      for (const [k, val] of Object.entries(node)) {
        if (k === 'location' || k === 'type' || !val || typeof val !== 'object') continue;
        const r = rebuild(val);
        if (r !== val) { copy = copy ?? { ...(node as object) } as Record<string, unknown>; copy[k] = r; }
      }
      const out = (copy ?? node) as ASTNode;
      const f = replace.get(node);
      return f ? f(out) : out;
    };
    let rewritten = restoreAddresses(rebuild(work) as Statement[], placeholders);

    // A local none of whose occurrences are left: its declaration goes.
    if (topLocals.has(v)) {
      const all = { kind: NodeKind.CompoundStmt, statements: rewritten } as unknown as ASTNode;
      let left = 0;
      for (const id of findNodesByKind(all, NodeKind.Identifier)) if ((id as Identifier).name === v) left++;
      for (const d of findNodesByKind(all, NodeKind.VariableDecl)) if ((d as VariableDecl).name.name === v) left--;
      if (left === 0) {
        rewritten = rewritten.flatMap((st): Statement[] => {
          if (st.kind !== NodeKind.DeclStmt) return [st];
          const ds = st as DeclStmt;
          const rest = ds.declarations.filter(d => !(d.kind === NodeKind.VariableDecl && (d as VariableDecl).name.name === v));
          if (rest.length === ds.declarations.length) return [st];
          return rest.length === 0 ? [] : [{ ...ds, declarations: rest } as unknown as Statement];
        });
        declared.delete(v);
      }
    }
    const decls = moves.map(m => Stmt.declStmt([Decl.variable(m.local, m.type)]) as unknown as Statement);
    let at = 0;
    while (at < rewritten.length && rewritten[at].kind === NodeKind.DeclStmt) at++;
    statements = [...rewritten.slice(0, at), ...decls, ...rewritten.slice(at)];
    for (const m of moves) { declared.add(m.local); localTypes.set(m.local, m.type); }
    changed = true;
  }
  return changed ? statements : null;
}

function createSplitLivesTransformer(options?: PluginOptions): Transformer {
  const given = (options ?? {}) as SplitLivesOptions;
  const trace = typeof process !== 'undefined' ? process.env?.SPLIT_LIVES_TRACE : undefined;
  const o: SplitLivesOptions = trace && !given.onReport
    ? { ...given, onReport: (fn, line) => appendFileSync(trace, `${fn}\t${line}\n`) }
    : given;
  if (!o.slots) return (n: ASTNode) => n;
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const statements = splitLives(fn, o);
      if (!statements) return undefined;
      return updateNode(fn, { body: { ...(fn.body as CompoundStmt), statements } } as Partial<FunctionDecl>);
    },
  });
}

export const splitLivesPlugin: TransformPlugin = {
  id: 'split-lives',
  name: 'Split Lives',
  description:
    'Values VC8 kept in one slot or register, merged by the decompiler into one variable -> a local per later value, typed from its own uses, proven by reaching definitions',
  version: '1.0.0',
  defaultEnabled: true,
  // On Ghidra's own spelling, right after reused-param-slot (14) has taken the slots it
  // knows: the new locals are declared as Ghidra would have declared them, and every
  // later pass treats them like one it printed.
  priority: 14.2,
  tags: ['correctness', 'type'],
  createTransformer: createSplitLivesTransformer,
};
