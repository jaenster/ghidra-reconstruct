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
 * The zero run is replaced by the initialised declaration; every later store is
 * kept, so each member holds the same value at its first read as before.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, CompoundStmt, DeclStmt, VariableDecl, Identifier, Expression,
  Statement, ExprStmt, AssignExpr, MemberExpr, SubscriptExpr, ParenExpr, CStyleCastExpr,
  IntegerLiteralExpr, QualifiedId, TypedefType, ElaboratedType, SwitchStmt,
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
}

const MIN_RUN = 2;

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
  if (!hasOwnKeys(layouts)) return createTransformer({});

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
    const runEnd = k;
    if (runEnd - start < MIN_RUN) return null;

    // Plain member stores up to the first read or escape.
    for (; k < block.statements.length; k++) {
      const st = block.statements[k];
      if (!refersTo(st)) continue;
      const a = assignOf(st);
      if (!a || refersTo(a.right)) break;
      const p = placeOf(a.left, name, agg);
      if (!p) break;
      covered.push([p.offset, p.offset + p.size]);
    }

    const required: Array<[number, number]> = [];
    if (!requiredBytes(agg, 0, required) || required.length === 0) return null;
    const bytes = new Set<number>();
    for (const [lo, hi] of covered) for (let b = lo; b < hi; b++) bytes.add(b);
    for (const [lo, hi] of required) for (let b = lo; b < hi; b++) if (!bytes.has(b)) return null;

    // Rebuild: the declaration moves to the run, initialised; the run goes.
    const decl = declStmt.declarations[0] as VariableDecl;
    // `= {0}`, not `{0}`: list-initialisation without the `=` is C++11, and VC8 has none.
    const init = Stmt.declStmt([{
      ...Decl.variable(decl.name, decl.type, Expr.initList([Expr.intLiteral(0)])),
      copyListInit: true,
    } as VariableDecl]);
    const target = block;
    const rebuild = (n: ASTNode): ASTNode => {
      if (n.kind === NodeKind.CompoundStmt) {
        const c = n as CompoundStmt;
        const isTarget = c === target;
        if (isTarget || c.statements.includes(declStmt)) {
          const out: Statement[] = [];
          c.statements.forEach((st, i) => {
            if (st === declStmt) return;
            if (isTarget && i === start) out.push(init);
            if (isTarget && i >= start && i < runEnd) return;
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
  // After decl-scope-sink (62), which would otherwise move the bare declaration
  // this pass removes, and after store-order (59.7), whose order the run's
  // ascending-offset test reads.
  priority: 62.5,
  tags: ['matching', 'declaration'],
  createTransformer: createAggregateZeroInitTransformer,
};
