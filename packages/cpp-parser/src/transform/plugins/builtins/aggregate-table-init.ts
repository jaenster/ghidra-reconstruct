/**
 * Aggregate Table Initialiser Plugin
 *
 * A local array of records filled with constants, as every TXT loader builds its
 * field table, was one aggregate initialiser in the source:
 *
 *   D2BinFieldInputStrc chartemplate[] = {      // TXT_LoadCharTemplateTxt @0x00664b80
 *       {"name", FIELDTYPE_ASCII, 0x1e, 0, 0},
 *       {"class", FIELDTYPE_CODE_TO_BYTE, 0, 0x1f, &sgptDataTable->pTxtPlayerClassLink},
 *       ...
 *   };
 *
 * The decompiler prints one store per member, in the order the compiler scheduled
 * them (a store can sit far from its row), and emitted as statements VC8 picks other
 * registers for the repeated constants and stores in another order. The initialiser
 * is what the original compiled.
 *
 * The rewrite is made only where it provably leaves every byte the program can
 * observe unchanged:
 *
 *  - the element is a plain record: its members are scalars that tile the whole
 *    object with no gap, no overlap (a union) and no bitfield, so the initialiser's
 *    positional values land on exactly the members the stores named and no member
 *    is left to the initialiser's zero fill;
 *  - from the local's first reference, a run of stores `a[i].m = v` writes every
 *    member of every element before anything reads the array or lets its address
 *    escape; a member stored twice keeps the last value, as before;
 *  - every value is a constant (a literal, an enum constant, a function, an
 *    address of a global or of a local declared before the run) or an address read
 *    through a pointer (`&gp->f`) with nothing between the run's start and that
 *    store that could change the pointer; a constant integer always fits the member,
 *    since a braced initialiser rejects a narrowing one;
 *  - every reference lies in the run's block from the run on, so the declaration can
 *    move there, and no jump enters that span from outside it (C2362).
 *
 * The declaration moves to the first store, initialised in element and member order;
 * the run's stores go and every other statement keeps its place.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, CompoundStmt, DeclStmt, VariableDecl, Identifier, Expression,
  Statement, ExprStmt, AssignExpr, MemberExpr, SubscriptExpr, ParenExpr, CStyleCastExpr,
  IntegerLiteralExpr, QualifiedId, TypedefType, ElaboratedType, ArrayType, UnaryExpr,
  GotoStmt, LabelStmt, InitListExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Decl, Expr, Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { typeNodeName, bareName, cachedSet } from './call-arg-cast.js';
import { hasOwnKeys } from './input-memo.js';

export interface AggregateTableInitOptions extends PluginOptions {
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
  /** Names of the program's functions: a bare one is a constant address. */
  functionNames?: string[];
}

type Field = { name: string; offset: number; size: number; type: string; bitSize?: number };

/** What a stored value needs to move from its store to the initialiser. */
type ValueClass =
  | { kind: 'constant'; locals: string[] }
  | { kind: 'pointer-read'; reads: string[]; locals: string[] };

const MIN_ELEMENTS = 2;
const MIN_FIELDS = 2;

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function intValue(e: Expression): bigint | null {
  const x = unwrap(e);
  if (x.kind === NodeKind.IntegerLiteral) return BigInt((x as IntegerLiteralExpr).value);
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
    const inner = unwrap((x as UnaryExpr).operand);
    if (inner.kind === NodeKind.IntegerLiteral) return -BigInt((inner as IntegerLiteralExpr).value);
  }
  return null;
}

const UNSIGNED_TYPE = /^(unsigned\b|uint\d*_t$|size_t$|uintptr_t$|DWORD$|WORD$|BYTE$|UINT$|ULONG$|USHORT$|UCHAR$|uchar$|ushort$|uint$|ulong$|dword$|word$|byte$|bool$)/;
const SIGNED_TYPE = /^(signed\b|int$|int\d*_t$|intptr_t$|short$|long$|char$|BOOL$|INT$|LONG$|SHORT$|CHAR$|sdword$|sword$|sbyte$)/;

/** Whether the constant `v` converts to a member of `size` bytes and Ghidra type `type` without narrowing. */
function fitsMember(v: bigint, size: number, type: string): boolean {
  if (size <= 0 || size > 8) return false;
  const t = type.trim();
  if (t.endsWith('*')) return v === 0n;
  const bits = BigInt(size * 8);
  const half = 1n << (bits - 1n);
  if (v >= 0n && v < half) return true;
  if (UNSIGNED_TYPE.test(t)) return v >= 0n && v < (half << 1n);
  if (SIGNED_TYPE.test(t)) return v >= -half && v < half;
  return false;
}

function createAggregateTableInitTransformer(options: AggregateTableInitOptions = {}): Transformer {
  const layouts = options.structLayouts ?? {};
  const sizes = options.aggregateSizes ?? {};
  const typedefTargets = options.typedefTargets ?? {};
  const enumValues = options.enumValues ?? {};
  const converting = cachedSet(options.convertingAggregates);
  const functions = cachedSet(options.functionNames);
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

  /**
   * The members of `agg` when they are scalars that tile the object exactly; null for
   * anything a positional initialiser could not fill member for member.
   */
  const plainFields = (agg: string): Field[] | null => {
    if (converting.has(agg)) return null;
    const fields = [...(layouts[agg] ?? [])].sort((a, b) => a.offset - b.offset);
    if (fields.length < MIN_FIELDS) return null;
    let end = 0;
    for (const f of fields) {
      if (!f.name || f.bitSize !== undefined || f.size <= 0 || f.offset !== end) return null;
      if (/\[/.test(f.type) || aggregateOf(f.type)) return null;
      end = f.offset + f.size;
    }
    return end === sizes[agg] ? fields : null;
  };

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      let body = node.body;
      const decls = findNodesByKind(body, NodeKind.VariableDecl) as VariableDecl[];
      const nameCount = new Map<string, number>();
      for (const d of decls) nameCount.set(d.name.name, (nameCount.get(d.name.name) ?? 0) + 1);
      const params = new Set<string>();
      for (const p of node.parameters) {
        const n = (p as { name?: Identifier | null }).name?.name;
        if (n) { nameCount.set(n, (nameCount.get(n) ?? 0) + 1); params.add(n); }
      }
      const locals = new Set(decls.map(d => d.name.name));

      for (const d of decls) {
        if (d.initializer || d.specifiers.length > 0 || nameCount.get(d.name.name) !== 1) continue;
        if (d.type.kind !== NodeKind.ArrayType) continue;
        const at = d.type as ArrayType;
        const count = at.size ? intValue(at.size) : null;
        if (count === null || count < BigInt(MIN_ELEMENTS) || count > 100000n) continue;
        const el = at.elementType;
        if (el.kind !== NodeKind.TypedefType && el.kind !== NodeKind.ElaboratedType) continue;
        const spelled = typeNodeName((el as TypedefType | ElaboratedType).name);
        const agg = spelled !== undefined ? aggregateOf(spelled) : undefined;
        const fields = agg ? plainFields(agg) : null;
        if (!fields) continue;
        const next = rewriteTable(body, d.name.name, Number(count), fields, locals);
        if (next) body = next;
      }
      if (body === node.body) return undefined;
      return updateNode(node, { body } as Partial<FunctionDecl>);
    },
  });

  /**
   * How a stored value can move to the initialiser; null when it cannot. `locals`
   * gathers the locals the value names, whose declarations must precede the run.
   */
  function classify(e: Expression, field: Field, isLocal: (n: string) => boolean): ValueClass | null {
    const x = unwrap(e);
    const localsOf = (n: ASTNode) =>
      (findNodesByKind(n, NodeKind.Identifier) as Identifier[]).map(i => i.name).filter(isLocal);
    const v = intValue(x);
    if (v !== null) return fitsMember(v, field.size, field.type) ? { kind: 'constant', locals: [] } : null;
    switch (x.kind) {
      case NodeKind.StringLiteral:
      case NodeKind.FloatingLiteral:
        return { kind: 'constant', locals: [] };
      case NodeKind.CharLiteral:
      case NodeKind.BoolLiteral:
        return field.size >= 1 && !field.type.trim().endsWith('*') ? { kind: 'constant', locals: [] } : null;
      case NodeKind.NullptrLiteral:
        return { kind: 'constant', locals: [] };
      case NodeKind.Identifier: {
        const n = (x as Identifier).name;
        if (isLocal(n)) return null;
        if (n === 'NULL') return { kind: 'constant', locals: [] };
        if (enumValues[n] !== undefined) {
          return fitsMember(BigInt(enumValues[n]), field.size, field.type) ? { kind: 'constant', locals: [] } : null;
        }
        return functions.has(n) ? { kind: 'constant', locals: [] } : null;
      }
      case NodeKind.QualifiedId: {
        const tail = (x as QualifiedId).name;
        if (tail.kind !== NodeKind.Identifier) return null;
        const n = bareName((tail as Identifier).name);
        if (enumValues[n] !== undefined) {
          return fitsMember(BigInt(enumValues[n]), field.size, field.type) ? { kind: 'constant', locals: [] } : null;
        }
        return functions.has(n) ? { kind: 'constant', locals: [] } : null;
      }
      case NodeKind.CStyleCastExpr: {
        const c = x as CStyleCastExpr;
        if (c.type.kind !== NodeKind.PointerType) {
          const iv = intValue(c.expression);
          return iv !== null && iv >= 0n && iv < 0x80000000n && fitsMember(iv, field.size, field.type)
            ? { kind: 'constant', locals: [] } : null;
        }
        if (intValue(c.expression) === 0n) return { kind: 'constant', locals: [] };
        return classify(c.expression, { ...field, type: 'void *' }, isLocal);
      }
      case NodeKind.UnaryExpr: {
        const u = x as UnaryExpr;
        if (u.operator !== '&') return null;
        const path = addressPath(u.operand);
        if (path === 'constant') return { kind: 'constant', locals: localsOf(u.operand) };
        if (path) return { kind: 'pointer-read', reads: path.reads, locals: localsOf(u.operand) };
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * The lvalue under `&`: 'constant' when its address is fixed (names, `.member`,
   * constant subscripts), the names it reads when it goes through `->`, null for
   * anything with a side effect or a computed index.
   */
  function addressPath(e: Expression): 'constant' | { reads: string[] } | null {
    const x = unwrap(e);
    if (x.kind === NodeKind.Identifier) return 'constant';
    if (x.kind === NodeKind.QualifiedId) return 'constant';
    if (x.kind === NodeKind.MemberExpr) {
      const m = x as MemberExpr;
      if (!m.isArrow) return addressPath(m.object);
      const base = unwrap(m.object);
      if (base.kind === NodeKind.Identifier) return { reads: [(base as Identifier).name] };
      if (base.kind === NodeKind.QualifiedId) {
        const t = (base as QualifiedId).name;
        return t.kind === NodeKind.Identifier ? { reads: [bareName((t as Identifier).name)] } : null;
      }
      return null;
    }
    if (x.kind === NodeKind.SubscriptExpr) {
      const s = x as SubscriptExpr;
      if (intValue(s.index) === null) return null;
      return addressPath(s.array);
    }
    return null;
  }

  function rewriteTable(body: CompoundStmt, name: string, count: number, fields: Field[], locals: Set<string>): CompoundStmt | null {
    const memberNames = new Set<ASTNode>(
      (findNodesByKind(body, NodeKind.MemberExpr) as MemberExpr[]).map(m => m.member));
    const namesOf = (n: ASTNode) =>
      (findNodesByKind(n, NodeKind.Identifier) as Identifier[]).filter(i => i.name === name && !memberNames.has(i));
    const refs = namesOf(body);
    const declStmt = (findNodesByKind(body, NodeKind.DeclStmt) as DeclStmt[]).find(ds =>
      ds.declarations.some(v => v.kind === NodeKind.VariableDecl && (v as VariableDecl).name.name === name));
    if (!declStmt || declStmt.declarations.length !== 1) return null;
    const decl = declStmt.declarations[0] as VariableDecl;
    const uses = refs.filter(i => i !== decl.name);
    if (uses.length === 0) return null;
    const first = uses[0];

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
    const inTail = new Set<ASTNode>();
    for (const st of tail) for (const i of findNodesByKind(st, NodeKind.Identifier)) inTail.add(i);
    if (!uses.every(u => inTail.has(u))) return null;
    if (jumpsInto(body, tail)) return null;

    // The element and member a store's target names: `name[k].member`.
    const slotOf = (left: Expression): { element: number; field: number } | null => {
      const m = unwrap(left);
      if (m.kind !== NodeKind.MemberExpr) return null;
      const me = m as MemberExpr;
      if (me.isArrow || me.member.kind !== NodeKind.Identifier) return null;
      const s = unwrap(me.object);
      if (s.kind !== NodeKind.SubscriptExpr) return null;
      const arr = unwrap((s as SubscriptExpr).array);
      if (arr.kind !== NodeKind.Identifier || (arr as Identifier).name !== name) return null;
      const k = intValue((s as SubscriptExpr).index);
      if (k === null || k < 0n || k >= BigInt(count)) return null;
      const f = fields.findIndex(g => g.name === (me.member as Identifier).name);
      return f < 0 ? null : { element: Number(k), field: f };
    };

    // Locals declared in the span the declaration moves over are out of its reach.
    const declaredInTail = new Set<string>();
    for (const st of tail) {
      for (const v of findNodesByKind(st, NodeKind.VariableDecl) as VariableDecl[]) declaredInTail.add(v.name.name);
    }
    const isLocal = (n: string) => locals.has(n) && n !== name;

    const values: Array<Array<{ value: Expression; at: number; cls: ValueClass } | undefined>> =
      Array.from({ length: count }, () => new Array(fields.length).fill(undefined));
    const removed = new Set<number>();
    const kept: number[] = [];
    let k = start;
    for (; k < block.statements.length; k++) {
      const st = block.statements[k];
      if (namesOf(st).length === 0) { kept.push(k); continue; }
      const a = assignOf(st);
      if (!a || namesOf(a.right).length > 0) break;
      const slot = slotOf(a.left);
      if (!slot) break;
      const cls = classify(a.right, fields[slot.field], isLocal);
      if (!cls || cls.locals.some(n => declaredInTail.has(n))) return null;
      values[slot.element][slot.field] = { value: a.right, at: k, cls };
      removed.add(k);
    }
    if (values.some(row => row.some(v => v === undefined))) return null;

    // A value read through a pointer keeps its value only if nothing before its store
    // in the run could have changed the pointer.
    for (const row of values) {
      for (const v of row) {
        if (!v || v.cls.kind !== 'pointer-read') continue;
        const reads = new Set(v.cls.reads);
        if (kept.some(i => i < v.at && !inert(block!.statements[i], reads))) return null;
      }
    }

    const rows = values.map(row => Expr.initList(row.map(v => v!.value)));
    const table: InitListExpr = { ...Expr.initList(rows), multiline: true };
    // `= {...}`, not `{...}`: list-initialisation without the `=` is C++11, and VC8 has none.
    const init = Stmt.declStmt([{ ...Decl.variable(decl.name, decl.type, table), copyListInit: true } as VariableDecl]);

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
            if (isTarget && removed.has(i)) return;
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

  /**
   * True when `st` cannot change any of `reads`: a declaration without an
   * initialiser, or a plain store to a local array element (another table's row)
   * whose value calls nothing.
   */
  function inert(st: Statement, reads: Set<string>): boolean {
    if (st.kind === NodeKind.DeclStmt) {
      return (st as DeclStmt).declarations.every(d => d.kind === NodeKind.VariableDecl && !(d as VariableDecl).initializer);
    }
    if (st.kind !== NodeKind.ExprStmt) return false;
    const e = unwrap((st as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return false;
    const a = e as AssignExpr;
    if (findNodesByKind(a.right, NodeKind.CallExpr).length > 0) return false;
    if (findNodesByKind(a.right, NodeKind.AssignExpr).length > 0) return false;
    let root = unwrap(a.left);
    while (root.kind === NodeKind.MemberExpr || root.kind === NodeKind.SubscriptExpr) {
      if (root.kind === NodeKind.MemberExpr) {
        if ((root as MemberExpr).isArrow) return false;
        root = unwrap((root as MemberExpr).object);
      } else {
        root = unwrap((root as SubscriptExpr).array);
      }
    }
    return root.kind === NodeKind.Identifier && !reads.has((root as Identifier).name);
  }
}

/**
 * True when a jump from outside `span` lands inside it: a goto elsewhere in the
 * function to a label in it, or a case label in it that belongs to an enclosing switch.
 */
function jumpsInto(body: CompoundStmt, span: Statement[]): boolean {
  const labels = new Set<string>();
  const gotosInside = new Set<ASTNode>();
  for (const st of span) {
    for (const l of findNodesByKind(st, NodeKind.LabelStmt) as LabelStmt[]) labels.add(l.label.name);
    for (const g of findNodesByKind(st, NodeKind.GotoStmt)) gotosInside.add(g);
    if (hasEnclosingCase(st)) return true;
  }
  if (labels.size === 0) return false;
  return (findNodesByKind(body, NodeKind.GotoStmt) as GotoStmt[])
    .some(g => labels.has(g.label.name) && !gotosInside.has(g));
}

function hasEnclosingCase(st: ASTNode): boolean {
  if (st.kind === NodeKind.CaseStmt || st.kind === NodeKind.DefaultStmt) return true;
  if (st.kind === NodeKind.SwitchStmt) return false;
  return childrenOf(st).some(hasEnclosingCase);
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

export const aggregateTableInitPlugin: TransformPlugin = {
  id: 'aggregate-table-init',
  name: 'Aggregate Table Initialiser',
  description: 'A run of constant member stores that writes every element of a local record array becomes one aggregate initialiser',
  version: '1.0.0',
  defaultEnabled: true,
  // Beside aggregate-zero-init and for the same reasons: after frame-group-locals
  // (950), so only a local that keeps its own declaration is initialised, and after
  // goto-crosses-init (700), which would split the initialised declaration again.
  priority: 956,
  tags: ['matching', 'declaration'],
  createTransformer: createAggregateTableInitTransformer,
};
