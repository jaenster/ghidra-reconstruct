/**
 * Value ranges of integer expressions inside one function body.
 *
 * A pass that may only rewrite an expression when its value is known to lie in some
 * interval asks `rangeAt(expr)`: the smallest interval this module can PROVE the value
 * of `expr` lies in, every time it is evaluated, or null. It is deliberately
 * conservative - an interval that is too wide only costs a rewrite; one that is too
 * narrow changes what the program computes.
 *
 * The interval of an expression comes from:
 *
 *   - its type: a `uint8_t` is in [0, 255], a `bool` in [0, 1];
 *   - its operators, evaluated on intervals in the C++ type the operator works in
 *     (int or unsigned int after promotion); an unsigned result outside [0, 2^32) is
 *     the whole of unsigned int, a signed one outside int is given up;
 *   - for a local whose address is never taken, every value ever stored into it: the
 *     assigned values, and at most one increment that a loop condition `v < B`
 *     checks before it can run again (a counted loop);
 *   - the conditions that must hold where the expression sits: an enclosing `if`,
 *     `while`/`for` condition, `?:`, `&&`/`||` operand, or an earlier
 *     `if (c) return/break/continue/goto;` in an enclosing block - each only when the
 *     variable cannot be written between the test and the use, and no label lets
 *     control reach the use without passing the test.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CStyleCastExpr, CompoundStmt, ConditionalExpr,
  DoWhileStmt, Expression, ExprStmt, ForStmt, FunctionDecl, Identifier, IfStmt,
  IntegerLiteralExpr, ParameterDecl, PostfixExpr, Statement, TypeNode, UnaryExpr,
  VariableDecl, WhileStmt,
} from '../../../ast/nodes.js';
import { shapeOfNode, unwrapParens, type TypedefResolver } from './call-arg-cast.js';
import { createExprShape, type ExprShapeTables } from './expr-shape.js';

/** A closed interval of mathematical integers, and the C++ type the value has. */
export interface ValueRange {
  lo: number;
  hi: number;
  /** The type after integral promotion: `int`, or `unsigned int`. */
  unsigned: boolean;
}

const INT_MIN = -(2 ** 31);
const INT_MAX = 2 ** 31 - 1;
const UINT_MAX = 2 ** 32 - 1;

/** The values a scalar of each canonical base can hold, and whether it promotes to unsigned. */
const BASE_RANGES: Record<string, ValueRange> = {
  'bool': { lo: 0, hi: 1, unsigned: false },
  'char': { lo: -128, hi: 127, unsigned: false },
  'signed char': { lo: -128, hi: 127, unsigned: false },
  'unsigned char': { lo: 0, hi: 255, unsigned: false },
  'short': { lo: -32768, hi: 32767, unsigned: false },
  'unsigned short': { lo: 0, hi: 65535, unsigned: false },
  'wchar_t': { lo: 0, hi: 65535, unsigned: false },
  'int': { lo: INT_MIN, hi: INT_MAX, unsigned: false },
  'long': { lo: INT_MIN, hi: INT_MAX, unsigned: false },
  'intptr_t': { lo: INT_MIN, hi: INT_MAX, unsigned: false },
  'ssize_t': { lo: INT_MIN, hi: INT_MAX, unsigned: false },
  'unsigned int': { lo: 0, hi: UINT_MAX, unsigned: true },
  'unsigned long': { lo: 0, hi: UINT_MAX, unsigned: true },
  'uintptr_t': { lo: 0, hi: UINT_MAX, unsigned: true },
  'size_t': { lo: 0, hi: UINT_MAX, unsigned: true },
};

export interface ValueRangeTables extends ExprShapeTables {
  /** Enum type names: a value of one is an `int` of any value. */
  enumTypes?: readonly string[];
  /** Enum constant name → value. */
  enumValues?: Record<string, number>;
}

const LOOPS = new Set<string>([NodeKind.ForStmt, NodeKind.WhileStmt, NodeKind.DoWhileStmt]);
const SKIP_KEYS = new Set(['location', 'leadingTrivia', 'trailingTrivia', 'parent']);

/** Every AST child of a node, in source order (property order). */
function children(n: ASTNode): ASTNode[] {
  const out: ASTNode[] = [];
  for (const key of Object.keys(n)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = (n as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      for (const x of v) if (x && typeof x === 'object' && typeof (x as ASTNode).kind === 'string') out.push(x as ASTNode);
    } else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') out.push(v as ASTNode);
  }
  return out;
}

function walk(n: ASTNode, f: (n: ASTNode) => boolean | void): void {
  if (f(n) === false) return;
  for (const c of children(n)) walk(c, f);
}

const nameOf = (e: Expression | null | undefined): string | undefined => {
  if (!e) return undefined;
  const x = unwrapParens(e);
  return x.kind === NodeKind.Identifier ? (x as Identifier).name : undefined;
};

function typeRange(t: { base: string; stars: number } | null, enumTypes: ReadonlySet<string>): ValueRange | null {
  if (!t || t.stars !== 0) return null;
  if (enumTypes.has(t.base)) return BASE_RANGES['int'];
  return BASE_RANGES[t.base] ?? null;
}

/** The interval of `r` converted to a type holding `t`: itself when it fits, else all of `t`. */
function convert(r: ValueRange | null, t: ValueRange): ValueRange {
  if (r && r.lo >= t.lo && r.hi <= t.hi) return { lo: r.lo, hi: r.hi, unsigned: t.unsigned };
  return t;
}

/** An arithmetic result: kept when the type holds it, wrapped to all of unsigned int, or given up. */
function fit(lo: number, hi: number, unsigned: boolean): ValueRange | null {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (unsigned) return lo >= 0 && hi <= UINT_MAX ? { lo, hi, unsigned } : { lo: 0, hi: UINT_MAX, unsigned };
  return lo >= INT_MIN && hi <= INT_MAX ? { lo, hi, unsigned } : null;
}

const bitsFor = (n: number) => (n <= 0 ? 0 : Math.floor(Math.log2(n)) + 1);

interface Constraint { lo?: number; hi?: number; ne?: number }

export interface FunctionRanges {
  /** The proven interval of `expr`, which must be a node of the analysed body. */
  rangeAt(expr: Expression): ValueRange | null;
}

/**
 * The analysis for one function. `fn` is the function as it will be emitted; the
 * expressions asked about must be nodes of its body (identity, not copies).
 */
export function createFunctionRanges(fn: FunctionDecl, tables: ValueRangeTables & { resolve?: TypedefResolver }): FunctionRanges {
  const body = fn.body as ASTNode;
  const enumTypes = new Set(tables.enumTypes ?? []);
  const enumValues = tables.enumValues ?? {};

  const parents = new Map<ASTNode, ASTNode>();
  const order = new Map<ASTNode, number>();
  let seq = 0;
  const index = (n: ASTNode) => {
    order.set(n, seq++);
    for (const c of children(n)) { parents.set(c, n); index(c); }
  };
  index(body);

  // Declarations: a name declared once (parameter or local) is the only thing the
  // flow facts may reason about; a name declared twice is two variables.
  const declCount = new Map<string, number>();
  const declType = new Map<string, TypeNode>();
  const params = new Set<string>();
  const statics = new Set<string>();
  for (const p of fn.parameters) {
    const pd = p as ParameterDecl;
    if (!pd.name) continue;
    params.add(pd.name.name);
    declCount.set(pd.name.name, (declCount.get(pd.name.name) ?? 0) + 1);
    declType.set(pd.name.name, pd.type);
  }
  let hasLabel = false;
  walk(body, n => {
    if (n.kind === NodeKind.LabelStmt) hasLabel = true;
    if (n.kind !== NodeKind.VariableDecl) return;
    const v = n as VariableDecl;
    declCount.set(v.name.name, (declCount.get(v.name.name) ?? 0) + 1);
    declType.set(v.name.name, v.type);
    if (v.specifiers?.includes('static')) statics.add(v.name.name);
  });

  const localTypes = new Map<string, TypeNode>();
  for (const [k, t] of declType) localTypes.set(k, t);
  const shapeOf = createExprShape(localTypes, tables);

  // Every write of each name: assignments, ++/--, declarations with an initializer,
  // and `&v`, which lets anything write it.
  const writesOf = new Map<string, ASTNode[]>();
  const addressTaken = new Set<string>();
  const noteWrite = (name: string | undefined, n: ASTNode) => {
    if (!name) return;
    let l = writesOf.get(name);
    if (!l) writesOf.set(name, (l = []));
    l.push(n);
  };
  walk(body, n => {
    switch (n.kind) {
      case NodeKind.AssignExpr: noteWrite(nameOf((n as AssignExpr).left), n); break;
      case NodeKind.PostfixExpr: noteWrite(nameOf((n as PostfixExpr).operand), n); break;
      case NodeKind.UnaryExpr: {
        const u = n as UnaryExpr;
        if (u.operator === '++' || u.operator === '--') noteWrite(nameOf(u.operand), n);
        else if (u.operator === '&') { const nm = nameOf(u.operand); if (nm) addressTaken.add(nm); }
        break;
      }
      case NodeKind.VariableDecl:
        if ((n as VariableDecl).initializer) noteWrite((n as VariableDecl).name.name, n);
        break;
    }
  });

  /** A name the flow facts may reason about: one declaration, a scalar, never aliased. */
  const tracked = (name: string): boolean =>
    declCount.get(name) === 1 && !addressTaken.has(name) && !statics.has(name);

  const writesWithin = (root: ASTNode, name: string): ASTNode[] => {
    const ws = writesOf.get(name) ?? [];
    return ws.filter(w => { for (let p: ASTNode | undefined = w; p; p = parents.get(p)) if (p === root) return true; return false; });
  };
  const within = (n: ASTNode, root: ASTNode): boolean => {
    for (let p: ASTNode | undefined = n; p; p = parents.get(p)) if (p === root) return true;
    return false;
  };

  /**
   * Can control reach a point inside `roots` other than by entering them from the top?
   * A label can be jumped to; a case label of a switch outside them can be switched to.
   */
  const enterable = (roots: ASTNode[]): boolean => {
    let hit = false;
    for (const r of roots) {
      walk(r, n => {
        if (hit) return false;
        if (n.kind === NodeKind.LabelStmt) { hit = true; return false; }
        if (n.kind === NodeKind.CaseStmt || n.kind === NodeKind.DefaultStmt) {
          let owner: ASTNode | undefined = parents.get(n);
          while (owner && owner.kind !== NodeKind.SwitchStmt) owner = parents.get(owner);
          if (!owner || !roots.some(x => within(owner!, x))) { hit = true; return false; }
        }
        return undefined;
      });
    }
    return hit;
  };

  /**
   * Is `name` written after control enters `roots` and before it reaches `site`?
   * Inside a loop that sits within them a write anywhere in them can come round first.
   */
  const writtenBefore = (roots: ASTNode[], site: ASTNode, name: string): boolean => {
    const ws = roots.flatMap(r => writesWithin(r, name));
    if (!ws.length) return false;
    for (let p = parents.get(site); p && !roots.includes(p); p = parents.get(p)) {
      if (LOOPS.has(p.kind)) return true;
    }
    const at = order.get(site)!;
    return ws.some(w => order.get(w)! < at || within(site, w));
  };

  // ------------------------------------------------------------------
  // Intervals of expressions
  // ------------------------------------------------------------------

  const inProgress = new Set<string>();
  const storedMemo = new Map<string, ValueRange | null>();
  let depth = 0;

  const literal = (e: IntegerLiteralExpr): ValueRange | null => {
    const v = Number(e.value);
    const suffix = (e.suffix ?? '').toLowerCase();
    if (suffix.includes('l') && suffix.replace('u', '').length >= 2) return null; // long long
    if (suffix.includes('u')) return v <= UINT_MAX ? { lo: v, hi: v, unsigned: true } : null;
    if (v <= INT_MAX) return { lo: v, hi: v, unsigned: false };
    // A decimal literal past int is long long; a hex/octal one is unsigned int.
    return e.base !== 10 && v <= UINT_MAX ? { lo: v, hi: v, unsigned: true } : null;
  };

  const ofType = (e: Expression): ValueRange | null => typeRange(shapeOf(e), enumTypes);

  const ev = (expr: Expression): ValueRange | null => {
    if (depth > 24) return ofType(expr);
    depth++;
    try { return evInner(expr); } finally { depth--; }
  };

  const evInner = (expr: Expression): ValueRange | null => {
    const e = unwrapParens(expr);
    switch (e.kind) {
      case NodeKind.IntegerLiteral: return literal(e as IntegerLiteralExpr);
      case NodeKind.BoolLiteral: return { lo: (e as unknown as { value: boolean }).value ? 1 : 0, hi: (e as unknown as { value: boolean }).value ? 1 : 0, unsigned: false };
      case NodeKind.CStyleCastExpr: case NodeKind.StaticCastExpr: {
        const c = e as CStyleCastExpr;
        const t = typeRange(shapeOfNode(c.type, 0, tables.resolve), enumTypes);
        if (!t) return null;
        return convert(ev(c.expression), t);
      }
      case NodeKind.Identifier: {
        const name = (e as Identifier).name;
        if (Object.prototype.hasOwnProperty.call(enumValues, name) && !declCount.has(name)) {
          const v = enumValues[name];
          return { lo: v, hi: v, unsigned: false };
        }
        return variable(name, e);
      }
      case NodeKind.UnaryExpr: {
        const u = e as UnaryExpr;
        if (u.operator === '!') return { lo: 0, hi: 1, unsigned: false };
        if (u.operator === '-') {
          const a = ev(u.operand);
          return a ? fit(-a.hi, -a.lo, a.unsigned) : null;
        }
        if (u.operator === '+') return ev(u.operand);
        return ofType(e);
      }
      case NodeKind.ConditionalExpr: {
        const c = e as ConditionalExpr;
        const a = ev(c.thenExpr);
        const b = ev(c.elseExpr);
        if (!a || !b) return null;
        const unsigned = a.unsigned || b.unsigned;
        const ca = unsigned ? convert(a, BASE_RANGES['unsigned int']) : a;
        const cb = unsigned ? convert(b, BASE_RANGES['unsigned int']) : b;
        return { lo: Math.min(ca.lo, cb.lo), hi: Math.max(ca.hi, cb.hi), unsigned };
      }
      case NodeKind.BinaryExpr: return binary(e as BinaryExpr);
      default:
        return ofType(e);
    }
  };

  const binary = (b: BinaryExpr): ValueRange | null => {
    const op = b.operator;
    if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(op)) return { lo: 0, hi: 1, unsigned: false };
    const a0 = ev(b.left);
    const c0 = ev(b.right);
    if (op === '<<' || op === '>>') {
      if (!a0 || !c0 || c0.lo < 0 || c0.hi > 31 || a0.lo < 0) return null;
      if (op === '>>') return { lo: Math.floor(a0.lo / 2 ** c0.hi), hi: Math.floor(a0.hi / 2 ** c0.lo), unsigned: a0.unsigned };
      return fit(a0.lo * 2 ** c0.lo, a0.hi * 2 ** c0.hi, a0.unsigned);
    }
    // A mask by a non-negative constant bounds the result whatever the other side is.
    if (op === '&') {
      const unsigned = !!(a0?.unsigned || c0?.unsigned);
      const nonneg = (r: ValueRange | null) => !!r && r.lo >= 0;
      if (nonneg(a0) && nonneg(c0)) return { lo: 0, hi: Math.min(a0!.hi, c0!.hi), unsigned };
      if (c0 && c0.lo === c0.hi && c0.lo >= 0) return { lo: 0, hi: c0.lo, unsigned };
      if (a0 && a0.lo === a0.hi && a0.lo >= 0) return { lo: 0, hi: a0.lo, unsigned };
      return null;
    }
    if (!a0 || !c0) return null;
    const unsigned = a0.unsigned || c0.unsigned;
    // Usual arithmetic conversions: a negative int operand of an unsigned operation
    // is a large unsigned value.
    const a = unsigned ? convert(a0, BASE_RANGES['unsigned int']) : a0;
    const c = unsigned ? convert(c0, BASE_RANGES['unsigned int']) : c0;
    switch (op) {
      case '+': return fit(a.lo + c.lo, a.hi + c.hi, unsigned);
      case '-': return fit(a.lo - c.hi, a.hi - c.lo, unsigned);
      case '*': {
        const ps = [a.lo * c.lo, a.lo * c.hi, a.hi * c.lo, a.hi * c.hi];
        return fit(Math.min(...ps), Math.max(...ps), unsigned);
      }
      case '/':
        if (a.lo < 0 || c.lo <= 0) return null;
        return { lo: Math.floor(a.lo / c.hi), hi: Math.floor(a.hi / c.lo), unsigned };
      case '%':
        if (c.lo <= 0) return null;
        if (a.lo >= 0) return { lo: 0, hi: Math.min(a.hi, c.hi - 1), unsigned };
        return { lo: -(c.hi - 1), hi: c.hi - 1, unsigned };
      case '|': case '^':
        if (a.lo < 0 || c.lo < 0) return null;
        return { lo: 0, hi: 2 ** bitsFor(Math.max(a.hi, c.hi)) - 1, unsigned };
      default:
        return null;
    }
  };

  /** What `name` can hold at `site`: its type, what is stored into it, the tests on the way. */
  const variable = (name: string, site: ASTNode): ValueRange | null => {
    const t = declType.get(name);
    const declared = t
      ? typeRange(shapeOfNode(t, 0, tables.resolve), enumTypes)
      : typeRange(shapeOf({ kind: NodeKind.Identifier, name } as unknown as Expression), enumTypes);
    if (!declared) return null;
    if (!declType.has(name) || !tracked(name)) return declared;
    let r: ValueRange = declared;
    const meet = (x: ValueRange | null) => { if (x) r = { lo: Math.max(r.lo, x.lo), hi: Math.min(r.hi, x.hi), unsigned: r.unsigned }; };
    if (!params.has(name)) meet(stored(name));
    meet(reaching(name, site, declared));
    if (r.lo > r.hi) return null;
    return applyConstraints(r, guards(name, site));
  };

  /**
   * The value `name` has at `site` from the writes that reach it in straight-line
   * order: walking out from the site, the nearest earlier statement that writes it -
   * a plain assignment, or a counted loop entered with a known value. Null when a
   * label, a case label, a loop back edge or any other kind of write is in the way.
   */
  const reaching = (name: string, site: ASTNode, declared: ValueRange): ValueRange | null => {
    let child: ASTNode = site;
    for (let p = parents.get(site); p; child = p, p = parents.get(p)) {
      if (enterable([child]) || writtenBefore([child], site, name)) return null;
      if (p.kind === NodeKind.CompoundStmt) {
        const st = (p as CompoundStmt).statements as ASTNode[];
        for (let i = st.indexOf(child) - 1; i >= 0; i--) {
          const s = st[i];
          if (enterable([s])) return null;
          const ws = writesWithin(s, name);
          if (!ws.length) continue;
          return statementValue(name, s, ws, declared);
        }
      } else if (LOOPS.has(p.kind) || p.kind === NodeKind.SwitchStmt) {
        if (writesWithin(p, name).length) return null;
      } else if (p.kind === NodeKind.IfStmt) {
        if (writesWithin((p as IfStmt).condition, name).length) return null;
      }
      if (p === body) break;
    }
    return params.has(name) ? declared : null;
  };

  /** The value `name` holds after statement `s`, which writes it with `ws`. */
  const statementValue = (name: string, s: ASTNode, ws: ASTNode[], declared: ValueRange): ValueRange | null => {
    if (s.kind === NodeKind.ExprStmt && ws.length === 1 && ws[0] === (s as ExprStmt).expression &&
        (ws[0] as AssignExpr).operator === '=') {
      return convert(ev((ws[0] as AssignExpr).right), declared);
    }
    if (s.kind === NodeKind.DeclStmt && ws.length === 1 && ws[0].kind === NodeKind.VariableDecl) {
      const init = (ws[0] as VariableDecl).initializer;
      return init && init.kind !== NodeKind.InitListExpr ? convert(ev(init as Expression), declared) : null;
    }
    if (!LOOPS.has(s.kind) || enterable([s])) return null;
    // A counted loop: entered with a known value, its one write the step its test checks.
    let entry: ValueRange | null;
    let step: ASTNode;
    const init = s.kind === NodeKind.ForStmt ? (s as ForStmt).init : null;
    const initWrite = init?.kind === NodeKind.ExprStmt && ws.includes((init as ExprStmt).expression) &&
      (init as ExprStmt).expression.kind === NodeKind.AssignExpr && ((init as ExprStmt).expression as AssignExpr).operator === '='
      ? (init as ExprStmt).expression as AssignExpr : null;
    if (initWrite && ws.length === 2) {
      entry = convert(ev(initWrite.right), declared);
      step = ws[0] === initWrite ? ws[1] : ws[0];
    } else if (ws.length === 1) {
      entry = reaching(name, s, declared);
      step = ws[0];
    } else return null;
    const shape = stepShape(name, step);
    if (!entry || !shape || shape.loop !== s) return null;
    const hi = Math.max(entry.hi, shape.limit) + shape.k;
    return hi <= declared.hi ? { lo: entry.lo, hi, unsigned: declared.unsigned } : null;
  };

  const applyConstraints = (r: ValueRange, cs: Constraint[]): ValueRange | null => {
    let lo = r.lo;
    let hi = r.hi;
    for (let pass = 0; pass < 2; pass++) {
      for (const c of cs) {
        if (c.lo !== undefined) lo = Math.max(lo, c.lo);
        if (c.hi !== undefined) hi = Math.min(hi, c.hi);
        if (c.ne !== undefined) { if (c.ne === lo) lo++; else if (c.ne === hi) hi--; }
      }
    }
    // An empty interval is code the tests make unreachable; nothing to prove there.
    if (lo > hi) return null;
    return { lo, hi, unsigned: r.unsigned };
  };

  /**
   * Every value a local is ever given: the union of what each assignment stores, or
   * null when one write is of a kind this does not follow.
   */
  const stored = (name: string): ValueRange | null => {
    if (storedMemo.has(name)) return storedMemo.get(name)!;
    if (inProgress.has(name)) return null;
    inProgress.add(name);
    let result: ValueRange | null = null;
    try { result = storedInner(name); } finally { inProgress.delete(name); }
    storedMemo.set(name, result);
    return result;
  };

  const storedInner = (name: string): ValueRange | null => {
    const t = typeRange(shapeOfNode(declType.get(name)!, 0, tables.resolve), enumTypes);
    if (!t) return null;
    const ws = writesOf.get(name) ?? [];
    let lo = Infinity;
    let hi = -Infinity;
    const steps: ASTNode[] = [];
    for (const w of ws) {
      let value: Expression | null = null;
      if (w.kind === NodeKind.VariableDecl) {
        const init = (w as VariableDecl).initializer;
        if (!init || init.kind === NodeKind.InitListExpr) return null;
        value = init as Expression;
      } else if (w.kind === NodeKind.AssignExpr && (w as AssignExpr).operator === '=') {
        value = (w as AssignExpr).right;
      } else {
        steps.push(w);
        continue;
      }
      const r = convert(ev(value), t);
      lo = Math.min(lo, r.lo);
      hi = Math.max(hi, r.hi);
    }
    if (!Number.isFinite(lo)) return null;
    if (steps.length === 0) return { lo, hi, unsigned: t.unsigned };
    if (steps.length !== 1) return null;
    const top = countedStep(name, steps[0]);
    if (top === null) return null;
    // Before the step runs, the value was stored or passed the loop test; one step on.
    hi = Math.max(hi, top.limit) + top.k;
    if (hi > t.hi) return null;
    return { lo, hi, unsigned: t.unsigned };
  };

  /**
   * An increment `v++`/`++v`/`v += k` that is the last thing its loop does before the
   * loop tests `v < B` (or `v <= B`): the loop, the largest value the test lets
   * through, and k.
   */
  const stepShape = (name: string, w: ASTNode): { loop: ASTNode; limit: number; k: number } | null => {
    let k: number | null = null;
    if ((w.kind === NodeKind.PostfixExpr || w.kind === NodeKind.UnaryExpr) && (w as PostfixExpr).operator === '++') k = 1;
    else if (w.kind === NodeKind.AssignExpr && (w as AssignExpr).operator === '+=') {
      const r = ev((w as AssignExpr).right);
      if (r && r.lo === r.hi && r.lo > 0) k = r.lo;
    }
    if (k === null) return null;
    let loop: ASTNode | undefined;
    const p = parents.get(w);
    if (p?.kind === NodeKind.ForStmt && (p as ForStmt).increment === w) loop = p;
    else if (p?.kind === NodeKind.ExprStmt) {
      const q = parents.get(p);
      if (q && LOOPS.has(q.kind) && (q as WhileStmt).body === p) loop = q;
      else if (q?.kind === NodeKind.CompoundStmt) {
        const stmts = (q as CompoundStmt).statements;
        const l = parents.get(q);
        if (stmts[stmts.length - 1] === p && l && LOOPS.has(l.kind) && (l as WhileStmt).body === q) loop = l;
      }
    }
    if (!loop || enterable([loop])) return null;
    if (loop.kind === NodeKind.ForStmt && (loop as ForStmt).increment !== w && (loop as ForStmt).increment) return null;
    const cond = (loop as WhileStmt | DoWhileStmt | ForStmt).condition;
    if (!cond || writesWithin(cond, name).length) return null;
    const c = unwrapParens(cond);
    if (c.kind !== NodeKind.BinaryExpr) return null;
    const be = c as BinaryExpr;
    let op = be.operator as string;
    let bound: Expression;
    if (nameOf(be.left) === name) bound = be.right;
    else if (nameOf(be.right) === name) { bound = be.left; op = ({ '>': '<', '>=': '<=' } as Record<string, string>)[op] ?? ''; }
    else return null;
    if (op !== '<' && op !== '<=') return null;
    const b = ev(bound);
    if (!b) return null;
    return { loop, limit: op === '<' ? b.hi - 1 : b.hi, k };
  };

  /**
   * `stepShape` for the function-wide union, where the value a loop is entered with
   * is any stored one. A do-while runs its body once untested, so it qualifies only
   * when it can run at most once per call - outside every loop, in a function with no
   * labels - and so is entered with a stored value, not one a previous run stepped.
   */
  const countedStep = (name: string, w: ASTNode): { limit: number; k: number } | null => {
    const shape = stepShape(name, w);
    if (!shape) return null;
    if (shape.loop.kind === NodeKind.DoWhileStmt) {
      if (hasLabel) return null;
      for (let a = parents.get(shape.loop); a; a = parents.get(a)) if (LOOPS.has(a.kind)) return null;
    }
    return shape;
  };

  // ------------------------------------------------------------------
  // Tests that hold at a site
  // ------------------------------------------------------------------

  /** Strip casts that keep the value of `name` (to int or unsigned int, or wider). */
  const isVar = (e: Expression, name: string): { unsignedCast: boolean } | null => {
    let x = unwrapParens(e);
    let unsignedCast = false;
    while (x.kind === NodeKind.CStyleCastExpr || x.kind === NodeKind.StaticCastExpr) {
      const t = typeRange(shapeOfNode((x as CStyleCastExpr).type, 0, tables.resolve), enumTypes);
      if (!t || t.hi < INT_MAX) return null;
      if (t.unsigned) unsignedCast = true;
      x = unwrapParens((x as CStyleCastExpr).expression);
    }
    return x.kind === NodeKind.Identifier && (x as Identifier).name === name ? { unsignedCast } : null;
  };

  /** What `cond` evaluating to `truth` says about `name`. */
  const facts = (cond: Expression, truth: boolean, name: string): Constraint[] => {
    const c = unwrapParens(cond);
    if (c.kind === NodeKind.UnaryExpr && (c as UnaryExpr).operator === '!') return facts((c as UnaryExpr).operand, !truth, name);
    if (isVar(c, name)) return truth ? [] : [{ lo: 0, hi: 0 }];
    if (c.kind !== NodeKind.BinaryExpr) return [];
    const be = c as BinaryExpr;
    if (be.operator === '&&') return truth ? [...facts(be.left, true, name), ...facts(be.right, true, name)] : [];
    if (be.operator === '||') return truth ? [] : [...facts(be.left, false, name), ...facts(be.right, false, name)];
    let op = be.operator as string;
    if (!['<', '<=', '>', '>=', '==', '!='].includes(op)) return [];
    let side = isVar(be.left, name);
    let other: Expression = be.right;
    if (!side) {
      side = isVar(be.right, name);
      other = be.left;
      op = ({ '<': '>', '<=': '>=', '>': '<', '>=': '<=' } as Record<string, string>)[op] ?? op;
    }
    if (!side) return [];
    const k = ev(other);
    if (!k) return [];
    if (!truth) op = ({ '<': '>=', '<=': '>', '>': '<=', '>=': '<', '==': '!=', '!=': '==' } as Record<string, string>)[op];
    const declared = typeRange(shapeOfNode(declType.get(name)!, 0, tables.resolve), enumTypes);
    if (!declared) return [];
    const unsignedCompare = side.unsignedCast || k.unsigned || declared.unsigned;
    if (unsignedCompare) {
      // Compared as unsigned int. The bound means the same for the mathematical
      // value only when both sides are non-negative, or for `<`/`<=`/`==` against a
      // bound below 2^31, which no negative value converted to unsigned meets.
      const kU = convert(k, BASE_RANGES['unsigned int']);
      const varNonNeg = declared.lo >= 0;
      if (kU.hi > INT_MAX && !varNonNeg) return [];
      switch (op) {
        case '<': return [{ lo: 0, hi: kU.hi - 1 }];
        case '<=': return [{ lo: 0, hi: kU.hi }];
        case '==': return [{ lo: Math.max(0, kU.lo), hi: kU.hi }];
        case '>': return varNonNeg ? [{ lo: kU.lo + 1 }] : [];
        case '>=': return varNonNeg ? [{ lo: kU.lo }] : [];
        case '!=': return varNonNeg && kU.lo === kU.hi ? [{ ne: kU.lo }] : [];
      }
      return [];
    }
    switch (op) {
      case '<': return [{ hi: k.hi - 1 }];
      case '<=': return [{ hi: k.hi }];
      case '>': return [{ lo: k.lo + 1 }];
      case '>=': return [{ lo: k.lo }];
      case '==': return [{ lo: k.lo, hi: k.hi }];
      case '!=': return k.lo === k.hi ? [{ ne: k.lo }] : [];
    }
    return [];
  };

  /** Does `s` always leave the statement it ends: return, goto, break, continue? */
  const leaves = (s: Statement | null): boolean => {
    if (!s) return false;
    if ([NodeKind.ReturnStmt, NodeKind.GotoStmt, NodeKind.BreakStmt, NodeKind.ContinueStmt].includes(s.kind as NodeKind)) return true;
    if (s.kind === NodeKind.CompoundStmt) {
      const st = (s as CompoundStmt).statements;
      return st.length > 0 && leaves(st[st.length - 1]);
    }
    return false;
  };

  const guards = (name: string, site: ASTNode): Constraint[] => {
    const out: Constraint[] = [];
    const take = (cond: Expression, truth: boolean, region: ASTNode[]) => {
      if (writesWithin(cond, name).length) return;
      if (enterable(region) || writtenBefore(region, site, name)) return;
      out.push(...facts(cond, truth, name));
    };
    let child: ASTNode = site;
    for (let p = parents.get(site); p; child = p, p = parents.get(p)) {
      switch (p.kind) {
        case NodeKind.IfStmt: {
          const s = p as IfStmt;
          if (child === s.thenBranch) take(s.condition, true, [child]);
          else if (child === s.elseBranch) take(s.condition, false, [child]);
          break;
        }
        case NodeKind.WhileStmt: case NodeKind.ForStmt: {
          const s = p as WhileStmt | ForStmt;
          if (child === s.body && s.condition) take(s.condition, true, [child]);
          break;
        }
        case NodeKind.ConditionalExpr: {
          const s = p as ConditionalExpr;
          if (child === s.thenExpr) take(s.condition, true, [child]);
          else if (child === s.elseExpr) take(s.condition, false, [child]);
          break;
        }
        case NodeKind.BinaryExpr: {
          const s = p as BinaryExpr;
          if (child === s.right && s.operator === '&&') take(s.left, true, [child]);
          else if (child === s.right && s.operator === '||') take(s.left, false, [child]);
          break;
        }
        case NodeKind.CompoundStmt: {
          const st = (p as CompoundStmt).statements as ASTNode[];
          const at = st.indexOf(child);
          for (let i = at - 1; i >= 0; i--) {
            const s = st[i];
            if (s.kind === NodeKind.LabelStmt || s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) break;
            if (s.kind === NodeKind.IfStmt && !(s as IfStmt).elseBranch && leaves((s as IfStmt).thenBranch)) {
              take((s as IfStmt).condition, false, st.slice(i + 1, at + 1));
            }
            if (writesWithin(s, name).length) break;
          }
          break;
        }
      }
      if (p.kind === NodeKind.FunctionDecl) break;
    }
    return out;
  };

  return { rangeAt: (expr: Expression) => ev(expr) };
}
