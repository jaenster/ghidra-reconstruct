/**
 * Aggregate Zero-Initialiser Plugin
 *
 * `T s = {0};` compiles to one zero store per member, and the decompiler prints
 * exactly that, dropping the zero stores a later assignment overwrites:
 *
 *   D2ControlMsg sMsg;                 // D2WINBUTTON_HandleMouseWheel @0x00500b50
 *   ...
 *   sMsg.uMsg = 0;                     // 0x04
 *   sMsg.wParam = 0;                   // 0x08
 *   sMsg.uLParam.nLParam = 0;          // 0x0C
 *   ...                                // up to 0x1C
 *   if (!pButton->sControl.fpOnPress) return 0;
 *   sMsg.pControl = &pButton->sControl; // 0x00 - its zero store was dead
 *   pButton->sControl.fpOnPress(&sMsg);
 *
 * Emitted as separate statements, VC8 materialises the zero in a register early
 * and reuses it across the code before the stores, which the original does not
 * do. The source was the initialiser:
 *
 *   D2ControlMsg sMsg = {0};
 *   ...
 *   sMsg.pControl = &pButton->sControl;
 *
 * The rewrite is made only when the layout PROVES the whole object is written
 * before anything reads it, so no value the program can observe changes:
 *
 *  - the local's first reference is a run of at least two zero stores to its
 *    members, at strictly ascending offsets (the order an initialiser stores in;
 *    hand-written field-by-field clearing is free to take any order);
 *  - from there until the first statement that reads the local or lets its
 *    address escape, the zero run plus plain member assignments cover every
 *    byte of every member, from the type's layout. Padding is not required: no
 *    member store can reach it, and the initialiser only makes it zero;
 *  - every reference to the local lies in that block, from the run on, so the
 *    declaration can move to the run's position;
 *  - no label and no case label of an enclosing switch follows in the block: a
 *    jump past an initialised declaration into its scope is ill-formed (C2362).
 *
 * The decompile alone cannot tell the initialiser from members cleared one by one and then
 * assigned (`RECT r; r.left = 0; r.top = 0; r.right = w; r.bottom = h;` in ClearScreen
 * 006b7f70), since it drops every zero store a later one overwrites. The instructions keep
 * them: the rewrite is only made where the original's opening stores to the local write zero
 * to every member byte (`zeroStores`).
 *
 * The zero run is replaced by the initialised declaration; every later store is
 * kept, so each member holds the same value at its first read as before.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, CompoundStmt, DeclStmt, VariableDecl, Identifier, Expression,
  Statement, ExprStmt, AssignExpr, MemberExpr, SubscriptExpr, ParenExpr, CStyleCastExpr,
  IntegerLiteralExpr, QualifiedId, TypedefType, ElaboratedType, SwitchStmt,
  CallExpr, BinaryExpr, UnaryExpr, SizeofExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Decl, Expr, Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { typeNodeName, bareName, cachedSet } from './call-arg-cast.js';
import { hasOwnKeys } from './input-memo.js';

export interface AggregateZeroInitOptions extends PluginOptions {
  /** Aggregate name -> every field's offset, size and Ghidra type, in offset order. */
  structLayouts?: Record<string, ReadonlyArray<{ name: string; offset: number; size: number; type: string; bitSize?: number }>>;
  /** Aggregate name -> size in bytes. */
  aggregateSizes?: Record<string, number>;
  /** Typedef name -> the spelling it stands for. */
  typedefTargets?: Record<string, string>;
  /** Enum constant -> value, for constant names unique program-wide. */
  enumValues?: Record<string, number>;
  /** Aggregates with a converting constructor: not aggregates to an initialiser list. */
  convertingAggregates?: string[];
  /**
   * Per struct-typed stack local, the bytes the original's opening stores write with zero
   * (reconstruct's extract/zero-stores.ts). The evidence the rewrite needs: absent, or a
   * local without an entry, changes nothing.
   */
  zeroStores?: ReadonlyArray<{ name: string; size: number; zero: ReadonlyArray<readonly [number, number]> }>;
}

const MIN_RUN = 2;

/** The bytes up to which VC8 SP1 /O2 expands a memset inline (array-fill-collapse.ts). */
const MEMSET_INLINE_MAX = 32;

interface Place { offset: number; size: number; type: string }

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** `T[N]` -> element spelling and count. */
function arraySpelling(t: string): { element: string; count: number } | null {
  const m = /^(.*?)\s*\[\s*(\d+)\s*\]$/.exec(t.trim());
  return m ? { element: m[1].trim(), count: Number(m[2]) } : null;
}

function createAggregateZeroInitTransformer(options: AggregateZeroInitOptions = {}): Transformer {
  const layouts = options.structLayouts ?? {};
  const sizes = options.aggregateSizes ?? {};
  const typedefTargets = options.typedefTargets ?? {};
  const enumValues = options.enumValues ?? {};
  const converting = cachedSet(options.convertingAggregates);
  const zeroStores = options.zeroStores;
  if (!hasOwnKeys(layouts) || !zeroStores || zeroStores.length === 0) return createTransformer({});
  /** Whether the original stores zero to every byte of `required` in the local `name` of `size` bytes. */
  const originalZeroes = (name: string, size: number, required: ReadonlyArray<[number, number]>): boolean => {
    const facts = zeroStores.filter(z => z.name === name);
    if (facts.length !== 1 || facts[0].size !== size) return false;
    return required.every(([lo, hi]) => {
      for (let b = lo; b < hi; b++) if (!facts[0].zero.some(([a, e]) => b >= a && b < e)) return false;
      return true;
    });
  };

  /**
   * Whether every byte of `required` is zero after the opening stores: stored zero by the
   * original's opening run (at least one member's worth) or by one of `zeroed`.
   */
  const originalZeroesWith = (name: string, size: number, required: ReadonlyArray<[number, number]>, zeroed: ReadonlyArray<[number, number]>): boolean => {
    const facts = zeroStores.filter(z => z.name === name);
    if (facts.length !== 1 || facts[0].size !== size) return false;
    const fz = facts[0].zero;
    if (fz.reduce((n, [a, e]) => n + (e - a), 0) < 4) return false;
    return required.every(([lo, hi]) => {
      for (let b = lo; b < hi; b++) {
        if (!fz.some(([a, e]) => b >= a && b < e) && !zeroed.some(([a, e]) => b >= a && b < e)) return false;
      }
      return true;
    });
  };

  /** The aggregate a type spelling names, through typedefs; undefined for anything else. */
  const aggregateOf = (spelling: string): string | undefined => {
    let s = spelling.trim().replace(/^(const|volatile)\s+/, '').replace(/^(struct|union|class)\s+/, '').trim();
    for (let depth = 0; depth < 8; depth++) {
      if (layouts[s] && sizes[s] !== undefined) return s;
      const next = typedefTargets[s];
      if (!next || next === s) return undefined;
      s = next.trim().replace(/^(struct|union|class)\s+/, '').trim();
    }
    return undefined;
  };

  const isZero = (e: Expression): boolean => {
    const x = unwrap(e);
    switch (x.kind) {
      case NodeKind.IntegerLiteral: return (x as IntegerLiteralExpr).value === 0n;
      case NodeKind.NullptrLiteral: return true;
      case NodeKind.BoolLiteral: return (x as { value?: boolean }).value === false;
      case NodeKind.FloatingLiteral: {
        const v = (x as { value?: number }).value;
        return v === 0 && 1 / v > 0;
      }
      case NodeKind.CharLiteral: {
        const v = (x as { value?: unknown }).value;
        if (typeof v === 'number') return v === 0;
        return typeof v === 'string' && (v === '\\0' || v === '\\x00' || (v.length === 1 && v.charCodeAt(0) === 0));
      }
      case NodeKind.CStyleCastExpr: return isZero((x as CStyleCastExpr).expression);
      case NodeKind.Identifier: {
        const n = (x as Identifier).name;
        return n === 'NULL' || enumValues[n] === 0;
      }
      case NodeKind.QualifiedId: {
        const tail = (x as QualifiedId).name;
        return tail.kind === NodeKind.Identifier && enumValues[bareName((tail as Identifier).name)] === 0;
      }
      default: return false;
    }
  };

  /**
   * The bytes every member of `agg` occupies, offset by `base`; null when the
   * layout holds something the coverage cannot reason about (a bitfield) or the
   * aggregate is not a plain aggregate to an initialiser list.
   */
  const requiredBytes = (agg: string, base: number, out: Array<[number, number]>, depth = 0): boolean => {
    if (depth > 16 || converting.has(agg)) return false;
    for (const f of layouts[agg] ?? []) {
      if (f.bitSize !== undefined || f.size <= 0) return false;
      const inner = arraySpelling(f.type) ? undefined : aggregateOf(f.type);
      if (inner) {
        if (!requiredBytes(inner, base + f.offset, out, depth + 1)) return false;
      } else {
        const arr = arraySpelling(f.type);
        if (arr) {
          const el = aggregateOf(arr.element);
          if (el && converting.has(el)) return false;
        }
        out.push([base + f.offset, base + f.offset + f.size]);
      }
    }
    return true;
  };

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      let body = node.body;
      const decls = findNodesByKind(body, NodeKind.VariableDecl) as VariableDecl[];
      const nameCount = new Map<string, number>();
      for (const d of decls) nameCount.set(d.name.name, (nameCount.get(d.name.name) ?? 0) + 1);
      for (const p of node.parameters) {
        const n = (p as { name?: Identifier | null }).name?.name;
        if (n) nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
      }

      for (const d of decls) {
        if (d.initializer || d.specifiers.length > 0 || nameCount.get(d.name.name) !== 1) continue;
        const t = d.type;
        if (t.kind !== NodeKind.TypedefType && t.kind !== NodeKind.ElaboratedType) continue;
        const spelled = typeNodeName((t as TypedefType | ElaboratedType).name);
        const agg = spelled !== undefined ? aggregateOf(spelled) : undefined;
        if (!agg) continue;
        const next = rewriteLocal(body, d.name.name, agg);
        if (next) body = next;
      }
      if (body === node.body) return undefined;
      return updateNode(node, { body } as Partial<FunctionDecl>);
    },
  });

  /** Where a member path rooted at `name` lands in the object, or null. */
  function placeOf(e: Expression, name: string, agg: string): Place | null {
    const x = unwrap(e);
    if (x.kind === NodeKind.Identifier) {
      return (x as Identifier).name === name ? { offset: 0, size: sizes[agg], type: agg } : null;
    }
    if (x.kind === NodeKind.MemberExpr) {
      const m = x as MemberExpr;
      if (m.isArrow || m.member.kind !== NodeKind.Identifier) return null;
      const outer = placeOf(m.object, name, agg);
      if (!outer || arraySpelling(outer.type)) return null;
      const inner = aggregateOf(outer.type);
      if (!inner) return null;
      const f = (layouts[inner] ?? []).find(g => g.name === (m.member as Identifier).name);
      if (!f || f.bitSize !== undefined) return null;
      return { offset: outer.offset + f.offset, size: f.size, type: f.type };
    }
    if (x.kind === NodeKind.SubscriptExpr) {
      const s = x as SubscriptExpr;
      const idx = unwrap(s.index);
      if (idx.kind !== NodeKind.IntegerLiteral) return null;
      const outer = placeOf(s.array, name, agg);
      const arr = outer ? arraySpelling(outer.type) : null;
      if (!outer || !arr || arr.count <= 0 || outer.size % arr.count !== 0) return null;
      const k = Number((idx as IntegerLiteralExpr).value);
      if (k < 0 || k >= arr.count) return null;
      const el = outer.size / arr.count;
      return { offset: outer.offset + k * el, size: el, type: arr.element };
    }
    return null;
  }

  /**
   * `memset(m, 0, n * sizeof(m[0]))`, `memset(m + k, 0, n)`, `memset(&m, 0, n)` of a member
   * of the local (the array-fill pass's spelling of a run of zero stores): the bytes it
   * zeroes, or null.
   */
  function zeroFillOf(st: Statement, name: string, agg: string): { from: number; to: number } | null {
    if (st.kind !== NodeKind.ExprStmt) return null;
    const c = unwrap((st as ExprStmt).expression);
    if (c.kind !== NodeKind.CallExpr) return null;
    const call = c as CallExpr;
    const callee = unwrap(call.callee);
    if (callee.kind !== NodeKind.Identifier || (callee as Identifier).name !== 'memset' || call.arguments.length !== 3) return null;
    const [dst, val, len] = call.arguments;
    if (!isZero(val)) return null;
    let d = unwrap(dst);
    let k = 0;
    if (d.kind === NodeKind.BinaryExpr && (d as BinaryExpr).operator === '+') {
      const r = unwrap((d as BinaryExpr).right);
      if (r.kind !== NodeKind.IntegerLiteral) return null;
      k = Number((r as IntegerLiteralExpr).value);
      d = unwrap((d as BinaryExpr).left);
    }
    let p: Place | null;
    let elem = 1;
    if (d.kind === NodeKind.UnaryExpr && (d as UnaryExpr).operator === '&') {
      if (k !== 0) return null;
      p = placeOf((d as UnaryExpr).operand, name, agg);
    } else {
      p = placeOf(d, name, agg);
      const arr = p ? arraySpelling(p.type) : null;
      if (!p || !arr || arr.count <= 0 || p.size % arr.count !== 0) return null;
      elem = p.size / arr.count;
    }
    if (!p) return null;
    const bytes = (e: Expression): number | null => {
      const x = unwrap(e);
      if (x.kind === NodeKind.IntegerLiteral) return Number((x as IntegerLiteralExpr).value);
      if (x.kind === NodeKind.BinaryExpr && (x as BinaryExpr).operator === '*') {
        const l = unwrap((x as BinaryExpr).left), r = unwrap((x as BinaryExpr).right);
        if (l.kind !== NodeKind.IntegerLiteral || r.kind !== NodeKind.SizeofExpr || (r as SizeofExpr).isType) return null;
        const of = unwrap((r as SizeofExpr).operand as Expression);
        const q = placeOf(of, name, agg);
        return q ? Number((l as IntegerLiteralExpr).value) * q.size : null;
      }
      return null;
    };
    const n = bytes(len);
    const from = p.offset + k * elem;
    if (n === null || n <= 0 || from + n > p.offset + p.size) return null;
    return { from, to: from + n };
  }

  function rewriteLocal(body: CompoundStmt, name: string, agg: string): CompoundStmt | null {
    // A member spelled like the local (`s.s`) is not a reference to it.
    const memberNames = new Set<ASTNode>(
      (findNodesByKind(body, NodeKind.MemberExpr) as MemberExpr[]).map(m => m.member));
    const namesOf = (n: ASTNode) =>
      (findNodesByKind(n, NodeKind.Identifier) as Identifier[]).filter(i => i.name === name && !memberNames.has(i));
    const refs = namesOf(body);
    const declStmt = (findNodesByKind(body, NodeKind.DeclStmt) as DeclStmt[]).find(ds =>
      ds.declarations.some(v => v.kind === NodeKind.VariableDecl && (v as VariableDecl).name.name === name));
    if (!declStmt || declStmt.declarations.length !== 1) return null;
    const declName = (declStmt.declarations[0] as VariableDecl).name;
    const uses = refs.filter(i => i !== declName);
    if (uses.length === 0) return null;
    const first = uses[0];

    // The block whose statement opens with the first use as a store's target.
    const assignOf = (st: Statement): AssignExpr | null => {
      if (st.kind !== NodeKind.ExprStmt) return null;
      const e = unwrap((st as ExprStmt).expression);
      return e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=' ? e as AssignExpr : null;
    };
    let block: CompoundStmt | undefined;
    let start = -1;
    for (const c of [body, ...(findNodesByKind(body, NodeKind.CompoundStmt) as CompoundStmt[])]) {
      const i = c.statements.findIndex(st => {
        const a = assignOf(st);
        return !!a && (findNodesByKind(a.left, NodeKind.Identifier) as Identifier[]).includes(first);
      });
      if (i >= 0) { block = c; start = i; break; }
    }
    if (!block) return null;

    const tail = block.statements.slice(start);
    const inTail = new Set<Identifier>();
    for (const st of tail) for (const i of findNodesByKind(st, NodeKind.Identifier)) inTail.add(i as Identifier);
    if (!uses.every(u => inTail.has(u))) return null;
    if (tail.some(st => hasJumpTarget(st))) return null;

    const refersTo = (n: ASTNode) => namesOf(n).length > 0;

    // The zero run, at strictly ascending offsets.
    let k = start;
    let last = -1;
    const covered: Array<[number, number]> = [];
    for (; k < block.statements.length; k++) {
      const a = assignOf(block.statements[k]);
      if (!a || !isZero(a.right)) break;
      const p = placeOf(a.left, name, agg);
      if (!p || p.offset <= last) break;
      last = p.offset;
      covered.push([p.offset, p.offset + p.size]);
    }
    let runEnd = k;

    // Plain member stores up to the first read or escape; the bytes they store zero to.
    const zeroed: Array<[number, number]> = [...covered];
    const stretch: Array<{ index: number; from: number; to: number; zero: boolean }> = [];
    for (; k < block.statements.length; k++) {
      const st = block.statements[k];
      if (!refersTo(st)) continue;
      const fill = zeroFillOf(st, name, agg);
      if (fill) {
        zeroed.push([fill.from, fill.to]);
        stretch.push({ index: k, from: fill.from, to: fill.to, zero: true });
        continue;
      }
      const a = assignOf(st);
      if (!a || refersTo(a.right)) break;
      const p = placeOf(a.left, name, agg);
      if (!p) break;
      covered.push([p.offset, p.offset + p.size]);
      if (isZero(a.right)) zeroed.push([p.offset, p.offset + p.size]);
      stretch.push({ index: k, from: p.offset, to: p.offset + p.size, zero: isZero(a.right) });
    }
    const drop = new Set<number>();

    const required: Array<[number, number]> = [];
    if (!requiredBytes(agg, 0, required) || required.length === 0) return null;
    const bytes = new Set<number>();
    for (const [lo, hi] of covered) for (let b = lo; b < hi; b++) bytes.add(b);
    const coveredAll = required.every(([lo, hi]) => { for (let b = lo; b < hi; b++) if (!bytes.has(b)) return false; return true; });
    if (runEnd - start >= MIN_RUN && coveredAll && originalZeroes(name, sizes[agg], required)) {
      // The decompile kept a run of the initialiser's stores and the rest wrote every member.
    } else {
      // The decompile dropped the initialiser's stores a later store overwrites, or printed
      // them out of order: the original's opening stores zero every member byte that no zero
      // store of the decompile's opening stretch covers. The initialiser stores those zeros.
      // A zero store it makes redundant goes: one ahead of the first other store, and one to
      // bytes the original's opening run zeroes and nothing before it in the stretch wrote
      // (the decompile prints what is left of a wide zero store after the narrow stores
      // into it, Q33_SendQuestStatePacket 00589070).
      if (!originalZeroesWith(name, sizes[agg], required, zeroed)) return null;
      // VC8 stores the first member and clears the rest as memset does, inline up to 32
      // bytes and through a call above: a larger rest is a call the original, which stores
      // every word itself, does not make (PLAYER_SendInventoryFullMessage 00549a60).
      const head = required.length > 0 ? required[0][1] - required[0][0] : 0;
      if (sizes[agg] - head > MEMSET_INLINE_MAX) return null;
      // Those leading stores lie in ascending offset order, as an initialiser stores; a
      // run in any other order was written member by member (MAINMENU_Unused16).
      runEnd = start;
      let prev = -1;
      while (runEnd < block.statements.length) {
        const a = assignOf(block.statements[runEnd]);
        const p = a && isZero(a.right) ? placeOf(a.left, name, agg) : null;
        if (!p) break;
        if (p.offset <= prev) return null;
        prev = p.offset;
        runEnd++;
      }
      const fz = zeroStores.find(z => z.name === name)!.zero;
      const inFacts = (lo: number, hi: number) => { for (let b = lo; b < hi; b++) if (!fz.some(([x, e]) => b >= x && b < e)) return false; return true; };
      const written: Array<[number, number]> = [];
      for (const st of stretch) {
        const earlier = written.some(([x, e]) => st.from < e && x < st.to);
        if (st.zero && st.index >= runEnd && !earlier && inFacts(st.from, st.to)) drop.add(st.index);
        written.push([st.from, st.to]);
      }
    }

    // `{0}` initialises the first member and clears the rest from its end; a later store
    // over the first member makes its zero store dead, and VC8 drops it. A memset of the
    // whole object clears it from its start, in stores wider than a narrow first member.
    // Where the first member is overwritten and the original still zeroes its bytes, the
    // original cleared the whole object: a six-byte packet zeroed by a dword and a word at
    // its start, its byte opcode stored after them (Q33_SendQuestStatePacket 00589070).
    // The same zero bytes either way; `= {}` would say it too, but C++03 wants an element.
    const head = required.find(([lo]) => lo === 0);
    const facts0 = zeroStores.find(z => z.name === name && z.size === sizes[agg]);
    const headZeroed = !!head && !!facts0 && (() => {
      for (let b = head[0]; b < head[1]; b++) if (!facts0.zero.some(([x, e]) => b >= x && b < e)) return false;
      return true;
    })();
    const headOverwritten = !!head && stretch.some(st => st.index >= runEnd && !drop.has(st.index) && st.from <= head[0] && st.to >= head[1]);
    // Only a first member narrower than a dword: from four bytes on, `{0}` and a memset
    // clear alike, and a memset of a large object costs VC8 an instruction more.
    const whole = headZeroed && headOverwritten && head[1] - head[0] < 4;

    // Rebuild: the declaration moves to the run, initialised; the run goes.
    const decl = declStmt.declarations[0] as VariableDecl;
    // `= {0}`, not `{0}`: list-initialisation without the `=` is C++11, and VC8 has none.
    const init: Statement[] = whole
      ? [
        Stmt.declStmt([Decl.variable(decl.name, decl.type, null)]),
        Stmt.expr(Expr.call('memset', [
          Expr.addressOf(Expr.identifier(name)), Expr.intLiteral(0), Expr.sizeof(Expr.identifier(name)),
        ])),
      ]
      : [Stmt.declStmt([{
        ...Decl.variable(decl.name, decl.type, Expr.initList([Expr.intLiteral(0)])),
        copyListInit: true,
      } as VariableDecl])];
    const target = block;
    const rebuild = (n: ASTNode): ASTNode => {
      if (n.kind === NodeKind.CompoundStmt) {
        const c = n as CompoundStmt;
        const isTarget = c === target;
        if (isTarget || c.statements.includes(declStmt)) {
          const out: Statement[] = [];
          c.statements.forEach((st, i) => {
            if (st === declStmt) return;
            if (isTarget && i === start) out.push(...init);
            if (isTarget && ((i >= start && i < runEnd) || drop.has(i))) return;
            out.push(isTarget ? st : rebuild(st) as Statement);
          });
          return updateNode(c, { statements: out } as Partial<CompoundStmt>);
        }
      }
      let changed: Record<string, unknown> | null = null;
      for (const [key, v] of Object.entries(n as unknown as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          const mapped = v.map(x => isNode(x) ? rebuild(x) : x);
          if (mapped.some((x, i) => x !== v[i])) (changed ??= {})[key] = mapped;
        } else if (isNode(v)) {
          const r = rebuild(v);
          if (r !== v) (changed ??= {})[key] = r;
        }
      }
      return changed ? updateNode(n, changed as Partial<ASTNode>) : n;
    };
    const next = rebuild(body) as CompoundStmt;
    return next === body ? null : next;
  }
}

/**
 * True when a jump could land inside `st` from outside it: a label anywhere, or
 * a case label that belongs to a switch enclosing the block (one not nested in
 * `st` itself).
 */
function hasJumpTarget(st: ASTNode): boolean {
  if (findNodesByKind(st, NodeKind.LabelStmt).length > 0) return true;
  const visit = (n: ASTNode): boolean => {
    if (n.kind === NodeKind.CaseStmt || n.kind === NodeKind.DefaultStmt) return true;
    if (n.kind === NodeKind.SwitchStmt) return false;
    for (const child of childrenOf(n)) if (visit(child)) return true;
    return false;
  };
  return visit(st);
}

function isNode(v: unknown): v is ASTNode {
  return !!v && typeof v === 'object' && typeof (v as { kind?: unknown }).kind === 'string';
}

function childrenOf(n: ASTNode): ASTNode[] {
  const out: ASTNode[] = [];
  for (const v of Object.values(n as unknown as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      for (const x of v) if (isNode(x)) out.push(x);
    } else if (isNode(v)) {
      out.push(v);
    }
  }
  return out;
}

export const aggregateZeroInitPlugin: TransformPlugin = {
  id: 'aggregate-zero-init',
  name: 'Aggregate Zero-Initialiser',
  description: 'A run of zero member stores that, with the stores after it, writes a whole local aggregate becomes `T s = {0};`',
  version: '1.0.0',
  defaultEnabled: true,
  // After frame-group-locals (950): a local it folds into a frame struct has no
  // declaration of its own left, so the initialiser can only land on a local that
  // keeps one (`T s = {0};`). Ahead of it, the initialised declaration became the
  // member assignment `__frame0.s = {0};`, which C++03 rejects. Also after
  // decl-scope-sink (62), which would otherwise move the bare declaration this pass
  // removes, and after store-order (59.7), whose order the run's ascending-offset
  // test reads.
  priority: 955,
  tags: ['matching', 'declaration'],
  createTransformer: createAggregateZeroInitTransformer,
};
