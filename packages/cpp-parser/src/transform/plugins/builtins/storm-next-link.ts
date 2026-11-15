/**
 * Storm Next Link Plugin
 *
 * Storm's intrusive list link is two words, `{ prev link, next item }`, and the slot that points
 * back at a node is found by `TSLink<T>::NextLink(int nLinkOffset)`:
 *
 *     if (m_next < 0) return ~m_next;                       // the list's terminator
 *     if (nLinkOffset < 0) nLinkOffset = (int)this - m_prevlink->m_next;
 *     return m_next + nLinkOffset;
 *
 * VC8 inlined it with -1 into every unlink, and Ghidra prints the inlined copy flattened
 * (SFILE_CloseAllOpenFiles1, 00418be0):
 *
 *     nPrevLink = pArchive->pNext;
 *     if ((int)nPrevLink < 0) {
 *       ppPrevSlot = (int*)~(uint32_t)nPrevLink;
 *     } else {
 *       ppPrevSlot = (int*)((int)nPrevLink + ((int)pArchive - (int)pNextNode->pNext));
 *     }
 *
 * Written flat, VC8 reassociates the sum and keeps the prev link in a scratch register; through
 * the inline helper it computes `this - prev->next` first and holds prev in ESI, as the original
 * does. This pass writes the if/else as `ppPrevSlot = (int*)D2_StormNextLink(pArchive, -1);`.
 *
 * Value-preserving, proved per site on a linear model of 32-bit values (atoms are locals, globals
 * and 4-byte memory reads; sums are taken modulo 2^32):
 *   - the condition is `N < 0` on a signed 32-bit N, and N is the word at some address L + 4;
 *   - one arm stores `~N`, the other stores a sum equal to N + L - mem[mem[L] + 4], into the same
 *     local, each arm that single statement;
 *   - a local N, L or prev is replaced by its defining expression only when every statement between
 *     that definition and the site is another plain local assignment or a guard that only leaves
 *     (`if (!p) return;`), with no call, no store and no reassignment of anything the definition
 *     reads; so the helper's reads at L and L + 4 see what the flattened code read;
 *   - L is spelled by the term of the sum that equals it.
 * A local that only carried N to the site is dropped with its definition, which is pure.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CStyleCastExpr, CompoundStmt, DeclStmt, ExprStmt, Expression,
  FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, MemberExpr, ReturnStmt, Statement,
  SubscriptExpr, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { getChildren, traverseAST } from '../../../ast/visitor.js';
import { Expr, Type } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape, thisClassOf, type ExprShape } from './expr-shape.js';
import { localTypesOf } from './compare-form.js';
import {
  bareName, shapeOfNode, shapeOfSpelling, unwrapParens, type TypeShape, type TypedefResolver,
} from './call-arg-cast.js';
import { createStormNextLinkInsertTransformer } from './storm-next-link-insert.js';

export const STORM_NEXT_LINK_HELPER = 'D2_StormNextLink';

/** The helper's text; the platform header includes it verbatim. C++03, so VC8 compiles it too. */
export const STORM_LINK_SUPPORT_LINES: readonly string[] = [
  '// TSLink<T>::NextLink, which VC8 inlined into every Storm unlink (see storm-next-link.ts).',
  '// The link is { prev link, next item }; a negative next is ~&terminator.',
  '// The words are intptr_t, which is int on the 32-bit target: an address or its complement.',
  'struct D2StormLinkWords { D2StormLinkWords* m_prevlink; intptr_t m_next; };',
  `static inline intptr_t ${STORM_NEXT_LINK_HELPER}(const void* pLink, intptr_t nLinkOffset) {`,
  '  const D2StormLinkWords* pThis = (const D2StormLinkWords*)pLink;',
  '  if (pThis->m_next < 0) return ~pThis->m_next;',
  '  if (nLinkOffset < 0) nLinkOffset = (intptr_t)pThis - pThis->m_prevlink->m_next;',
  '  return pThis->m_next + nLinkOffset;',
  '}',
];

export interface StormNextLinkOptions extends PluginOptions {
  structFields?: Record<string, Record<string, string>>;
  structFieldOffsets?: Record<string, Record<string, number>>;
  aggregateSizes?: Record<string, number>;
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  /** Called once per rewritten site. */
  onSite?: (site: { line: number; target: string; droppedLocal?: string }) => void;
}

// ---------------------------------------------------------------- linear 32-bit values

const M32 = (1n << 32n) - 1n;
const wrap = (v: bigint) => v & M32;

/** sum(coeff * atom) + c, modulo 2^32. */
interface Lin { terms: Map<string, bigint>; c: bigint }

const linConst = (c: bigint): Lin => ({ terms: new Map(), c: wrap(c) });
const linAtom = (key: string): Lin => ({ terms: new Map([[key, 1n]]), c: 0n });
function linAdd(a: Lin, b: Lin, k = 1n): Lin {
  const terms = new Map(a.terms);
  for (const [key, v] of b.terms) {
    const n = wrap((terms.get(key) ?? 0n) + k * v);
    if (n === 0n) terms.delete(key); else terms.set(key, n);
  }
  return { terms, c: wrap(a.c + k * b.c) };
}
function linScale(a: Lin, k: bigint): Lin {
  const terms = new Map<string, bigint>();
  for (const [key, v] of a.terms) { const n = wrap(v * k); if (n !== 0n) terms.set(key, n); }
  return { terms, c: wrap(a.c * k) };
}
function canon(a: Lin): string {
  const parts = [...a.terms.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => `${v}*${k}`);
  return `${parts.join('+')}#${a.c}`;
}
const linEq = (a: Lin, b: Lin) => canon(a) === canon(b);
const memKey = (addr: Lin) => `m[${canon(addr)}]`;

// ---------------------------------------------------------------- types

const WORD_INTS = new Set([
  'int', 'unsigned int', 'long', 'unsigned long', 'uintptr_t', 'intptr_t', 'size_t', 'ssize_t', 'pointer32',
]);
const SIGNED_WORD_INTS = new Set(['int', 'long', 'intptr_t', 'ssize_t']);
const SCALAR_SIZES: Record<string, number> = {
  'char': 1, 'signed char': 1, 'unsigned char': 1, 'bool': 1,
  'short': 2, 'unsigned short': 2, 'wchar_t': 2,
  'float': 4, 'double': 8, 'long long': 8, 'unsigned long long': 8,
};
for (const w of WORD_INTS) SCALAR_SIZES[w] = 4;

const isWord = (s: TypeShape | null): boolean => !!s && (s.stars > 0 || WORD_INTS.has(s.base));
const isWordInt = (s: TypeShape | null): boolean => !!s && s.stars === 0 && WORD_INTS.has(s.base);

const PURE_FORBIDDEN = new Set<string>([
  NodeKind.CallExpr, NodeKind.AssignExpr, NodeKind.PostfixExpr, NodeKind.NewExpr, NodeKind.ThrowExpr,
  NodeKind.LambdaExpr, 'DeleteExpr',
]);

function isPure(e: ASTNode): boolean {
  for (const n of traverseAST(e)) {
    if (PURE_FORBIDDEN.has(n.kind)) return false;
    if (n.kind === NodeKind.UnaryExpr) {
      const op = (n as UnaryExpr).operator;
      if (op === '++' || op === '--') return false;
    }
  }
  return true;
}

function stripParens(e: Expression): Expression { return unwrapParens(e); }

/** `S = e` as a statement, optionally inside a one-statement block. */
function singleStore(s: Statement | null): AssignExpr | null {
  if (!s) return null;
  let st: Statement = s;
  if (st.kind === NodeKind.CompoundStmt) {
    const c = st as CompoundStmt;
    if (c.statements.length !== 1) return null;
    st = c.statements[0];
  }
  if (st.kind !== NodeKind.ExprStmt) return null;
  const e = stripParens((st as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  return e as AssignExpr;
}

/** A statement that only leaves: a jump, or a block of jumps. */
function onlyLeaves(s: Statement | null): boolean {
  if (!s) return true;
  switch (s.kind) {
    case NodeKind.ReturnStmt: {
      const v = (s as ReturnStmt).value;
      return !v || isPure(v);
    }
    case NodeKind.BreakStmt: case NodeKind.ContinueStmt: case NodeKind.GotoStmt:
      return true;
    case NodeKind.CompoundStmt: {
      const c = s as CompoundStmt;
      return c.statements.length > 0 && c.statements.every(onlyLeaves);
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------- type tables

/**
 * One spelling of an aggregate's name, whoever spelled it. The tables are keyed by Ghidra's
 * names (`TSExplicitList<SGAMEDATA,-572662307>`), a type read from a body by the parser's
 * (`TSExplicitList<SGAMEDATA, -572662307>`), and Ghidra's pseudo-C writes a negative template
 * argument with an underscore (`TSExplicitList<SGAMEDATA,_572662307> *this`).
 */
function typeKey(name: string): string {
  return name.replace(/\s+/g, '').replace(/(^|[<,])::/g, '$1').replace(/([<,])_(?=\d)/g, '$1-');
}

const keyCache = new WeakMap<object, Map<string, string>>();
function offsetKeys(table: Record<string, unknown>): Map<string, string> {
  let m = keyCache.get(table);
  if (!m) {
    m = new Map();
    for (const k of Object.keys(table)) if (k.includes('<') && !m.has(typeKey(k))) m.set(typeKey(k), k);
    keyCache.set(table, m);
  }
  return m;
}

/** A view of a table keyed by aggregate name that also answers to the other spellings of a template name. */
const tolerantCache = new WeakMap<object, object>();
function tolerant<T>(table: Record<string, T>): Record<string, T> {
  let view = tolerantCache.get(table) as Record<string, T> | undefined;
  if (!view) {
    view = new Proxy(table, {
      get(target, key) {
        if (typeof key !== 'string' || key in target || !key.includes('<')) return (target as Record<string | symbol, unknown>)[key];
        const k = offsetKeys(target).get(typeKey(key));
        return k === undefined ? undefined : target[k];
      },
    });
    tolerantCache.set(table, view);
  }
  return view;
}

// ---------------------------------------------------------------- the pass

interface Def { stmt: Statement; rhs: Expression; poisoned: boolean }

function createStormNextLinkTransformer(options: StormNextLinkOptions = {}): Transformer {
  const structFields = tolerant(options.structFields ?? {});
  const offsets = options.structFieldOffsets ?? {};
  const sizes = options.aggregateSizes ?? {};
  const typedefTargets = options.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];

  const structKey = (base: string): string | undefined => {
    const cands = [base, base.replace(/^::/, ''), base.replace(/^::/, '').replace(/([<,]\s*)::/g, '$1'), bareName(base)];
    return cands.find(k => offsets[k]) ?? offsetKeys(offsets).get(typeKey(base));
  };
  const elemSize = (s: TypeShape | null): number | undefined => {
    if (!s || s.stars < 1) return undefined;
    if (s.stars >= 2) return 4;
    const known = SCALAR_SIZES[s.base];
    if (known) return known;
    const k = structKey(s.base);
    return k ? sizes[k] ?? sizes[bareName(k)] : undefined;
  };

  const unlink = createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      let any = false;
      for (const n of traverseAST(fn.body)) {
        if (n.kind === NodeKind.IfStmt && isCandidate(n as IfStmt)) { any = true; break; }
      }
      if (!any) return undefined;

      const localTypes = localTypesOf(fn);
      const shapeOf: ExprShape = createExprShape(localTypes, {
        globalTypes: options.globalTypes ?? {},
        enclosingVarTypes: options.enclosingVarTypes ?? {},
        structFields,
        fieldTypes: options.fieldTypes ?? {},
        returnTypes: options.functionReturnTypes ?? {},
        resolve,
       thisClass: thisClassOf(fn, resolve),
      });
      const isArrayLocal = (name: string) => localTypes.get(name)?.kind === NodeKind.ArrayType;

      // Parents, for the walk back from a site.
      const parent = new Map<ASTNode, ASTNode>();
      const stack: ASTNode[] = [fn.body];
      while (stack.length) {
        const n = stack.pop()!;
        for (const ch of getChildren(n)) { if (ch) { parent.set(ch, n); stack.push(ch); } }
      }

      /** Reaching definitions of locals at `site`, over the straight-line path that leads to it. */
      const defsAt = (site: Statement): Map<string, Def> => {
        const defs = new Map<string, Def>();
        const assigned = new Set<string>(); // assigned between a definition and the site
        const record = (name: string, rhs: Expression | null, stmt: Statement): boolean => {
          if (!localTypes.has(name)) return false;
          if (defs.has(name) || assigned.has(name)) { assigned.add(name); return true; }
          if (!rhs || !isPure(rhs)) return false;
          // A definition that reads its own old value, or a local assigned later, is not the
          // value the site sees.
          let poisoned = false;
          for (const r of traverseAST(rhs)) {
            if (r.kind !== NodeKind.Identifier) continue;
            const used = (r as Identifier).name;
            if (used === name || assigned.has(used)) poisoned = true;
          }
          defs.set(name, { stmt, rhs, poisoned });
          assigned.add(name);
          return true;
        };
        let node: ASTNode = site;
        for (;;) {
          const p = parent.get(node);
          if (!p) break;
          if (p.kind === NodeKind.CompoundStmt) {
            const list = (p as CompoundStmt).statements;
            let ok = true;
            for (let i = list.indexOf(node as Statement) - 1; i >= 0 && ok; i--) {
              const s = list[i];
              if (s.kind === NodeKind.NullStmt) continue;
              if (s.kind === NodeKind.ExprStmt) {
                const e = stripParens((s as ExprStmt).expression);
                const a = e.kind === NodeKind.AssignExpr ? e as AssignExpr : null;
                const l = a && a.operator === '=' ? stripParens(a.left) : null;
                ok = !!l && l.kind === NodeKind.Identifier && record((l as Identifier).name, a!.right, s);
                continue;
              }
              if (s.kind === NodeKind.DeclStmt) {
                for (const d of (s as DeclStmt).declarations) {
                  if (d.kind !== NodeKind.VariableDecl) { ok = false; break; }
                  const v = d as VariableDecl;
                  if (!v.initializer) continue;
                  if (v.initializer.kind === NodeKind.InitListExpr) { ok = false; break; }
                  if (!record(v.name.name, v.initializer as Expression, s)) { ok = false; break; }
                }
                continue;
              }
              if (s.kind === NodeKind.IfStmt) {
                const i2 = s as IfStmt;
                ok = !i2.init && isPure(i2.condition) && onlyLeaves(i2.thenBranch) && onlyLeaves(i2.elseBranch);
                continue;
              }
              ok = false;
            }
            if (!ok) break;
            node = p;
            continue;
          }
          if (p.kind === NodeKind.IfStmt) {
            const i2 = p as IfStmt;
            if (i2.init || !isPure(i2.condition) || (i2.thenBranch !== node && i2.elseBranch !== node)) break;
            node = p;
            continue;
          }
          break;
        }
        return defs;
      };

      const declNames = new Set<ASTNode>();
      for (const n of traverseAST(fn.body)) if (n.kind === NodeKind.VariableDecl) declNames.add((n as VariableDecl).name);

      const rewrites = new Map<ASTNode, ASTNode>();
      const drops = new Set<ASTNode>();
      const atomAddr = new Map<string, Lin>();

      /**
       * After the site, the link's next word read through the object that contains the link
       * (`this->m_terminator.m_next` with `pTVar1 = &this->m_terminator`) reads it through the
       * link local instead, as the helper's own reads do: the same lvalue spelled the other
       * way. Only while nothing assigns a local or calls (the local and the defining
       * expressions keep their values) and only for an address that no memory read enters
       * (no store can move it).
       */
      const respellNextReads = (
        ifs: IfStmt, linkExpr: Expression, link: Lin,
        val: (e: Expression) => Lin | null, addr: (e: Expression) => Lin | null,
      ): void => {
        if (linkExpr.kind !== NodeKind.Identifier || !localTypes.has((linkExpr as Identifier).name)) return;
        const linkName = (linkExpr as Identifier).name;
        const lv = val(linkExpr);
        if (!lv || !linEq(lv, link) || [...lv.terms.keys()].some(k => k.startsWith('m['))) return;
        const ls = shapeOf(linkExpr);
        const k = ls && ls.stars === 1 ? structKey(ls.base) : undefined;
        const field = k ? Object.entries(offsets[k] ?? {}).find(([, off]) => off === 4)?.[0] : undefined;
        if (!field || !isWord(shapeOfSpelling(structFields[k!]?.[field] ?? '', resolve))) return;
        const block = parent.get(ifs);
        if (!block || block.kind !== NodeKind.CompoundStmt) return;
        const list = (block as CompoundStmt).statements;
        const next = linAdd(link, linConst(4n));
        for (let i = list.indexOf(ifs) + 1; i < list.length; i++) {
          const st = list[i];
          let stop = false;
          for (const n of traverseAST(st)) {
            if (n.kind === NodeKind.CallExpr || n.kind === NodeKind.PostfixExpr) { stop = true; break; }
            if (n.kind === NodeKind.UnaryExpr && ['++', '--'].includes((n as UnaryExpr).operator)) { stop = true; break; }
            if (n.kind === NodeKind.AssignExpr && stripParens((n as AssignExpr).left).kind === NodeKind.Identifier) { stop = true; break; }
          }
          if (stop || st.kind !== NodeKind.ExprStmt) return;
          const e = stripParens((st as ExprStmt).expression);
          if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') continue;
          const rhs = stripParens((e as AssignExpr).right);
          if (rhs.kind !== NodeKind.MemberExpr) continue;
          const m = rhs as MemberExpr;
          const obj = stripParens(m.object);
          if (m.isArrow && obj.kind === NodeKind.Identifier && (obj as Identifier).name === linkName) continue;
          const a = addr(rhs);
          if (!a || !linEq(a, next) || [...a.terms.keys()].some(t => t.startsWith('m['))) continue;
          if (!isWord(shapeOf(rhs))) continue;
          rewrites.set((e as AssignExpr).right, Expr.member(Expr.identifier(linkName), field, true));
        }
      };

      const site = (ifs: IfStmt): void => {
        if (ifs.init) return;
        const cond = stripParens(ifs.condition);
        if (cond.kind !== NodeKind.BinaryExpr) return;
        const b = cond as BinaryExpr;
        const lit = (e: Expression): bigint | undefined => {
          const u = stripParens(e);
          if (u.kind === NodeKind.IntegerLiteral) return (u as IntegerLiteralExpr).value;
          if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-') {
            const v = stripParens((u as UnaryExpr).operand);
            if (v.kind === NodeKind.IntegerLiteral) return -(v as IntegerLiteralExpr).value;
          }
          return undefined;
        };
        // `N < 0` (the ~ arm first) or `N >= 0` / `-1 < N` / `N > -1` / `0 <= N` (the sum first).
        let n0: Expression | undefined;
        let negFirst = true;
        if (b.operator === '<' && lit(b.right) === 0n) n0 = b.left;
        else if (b.operator === '>=' && lit(b.right) === 0n) { n0 = b.left; negFirst = false; }
        else if (b.operator === '>' && lit(b.right) === -1n) { n0 = b.left; negFirst = false; }
        else if (b.operator === '<' && lit(b.left) === -1n) { n0 = b.right; negFirst = false; }
        else if (b.operator === '<=' && lit(b.left) === 0n) { n0 = b.right; negFirst = false; }
        if (!n0) return;
        const nShape = shapeOf(n0);
        if (!nShape || nShape.stars !== 0 || !SIGNED_WORD_INTS.has(nShape.base)) return;

        const negArm = singleStore(negFirst ? ifs.thenBranch : ifs.elseBranch);
        const sumArm = singleStore(negFirst ? ifs.elseBranch : ifs.thenBranch);
        if (!negArm || !sumArm) return;
        const target = stripParens(negArm.left);
        if (target.kind !== NodeKind.Identifier || stripParens(sumArm.left).kind !== NodeKind.Identifier) return;
        const sName = (target as Identifier).name;
        if ((stripParens(sumArm.left) as Identifier).name !== sName || !localTypes.has(sName)) return;
        const sShape = shapeOfNode(localTypes.get(sName)!, 0, resolve);
        if (!isWord(sShape)) return;
        let conditionLocal = stripParens(n0);
        while (conditionLocal.kind === NodeKind.CStyleCastExpr) conditionLocal = stripParens((conditionLocal as CStyleCastExpr).expression);
        const selfTarget = conditionLocal.kind === NodeKind.Identifier && (conditionLocal as Identifier).name === sName;
        for (const part of [ifs.condition, negArm.right, sumArm.right]) {
          if (!isPure(part)) return;
          if (!selfTarget) for (const r of traverseAST(part)) if (r.kind === NodeKind.Identifier && (r as Identifier).name === sName) return;
        }

        const defs = defsAt(ifs);
        const expanding = new Set<string>();

        // A 32-bit integer operand. The shape model has no type for `a - b`, so a sum of word
        // integers is one by construction here.
        const wordInt = (expr: Expression): boolean => {
          const e = stripParens(expr);
          if (e.kind === NodeKind.IntegerLiteral) return true;
          if (e.kind === NodeKind.BinaryExpr) {
            const x = e as BinaryExpr;
            return (x.operator === '+' || x.operator === '-') && wordInt(x.left) && wordInt(x.right);
          }
          return isWordInt(shapeOf(e));
        };

        // ---- value and address of an expression, as linear forms
        const val = (expr: Expression): Lin | null => {
          const e = stripParens(expr);
          switch (e.kind) {
            case NodeKind.IntegerLiteral:
              return linConst((e as IntegerLiteralExpr).value);
            case NodeKind.Identifier: {
              const name = (e as Identifier).name;
              if (localTypes.has(name)) {
                if (isArrayLocal(name)) return linAtom(`&${name}`);
                const d = defs.get(name);
                if (d && !d.poisoned && !expanding.has(name)) {
                  expanding.add(name);
                  const v = val(d.rhs);
                  expanding.delete(name);
                  if (v) return v;
                }
                return isWord(shapeOf(e)) ? linAtom(`v:${name}`) : null;
              }
              return isWord(shapeOf(e)) ? linAtom(`g:${name}`) : null;
            }
            case NodeKind.CStyleCastExpr: {
              const c = e as CStyleCastExpr;
              if (!isWord(shapeOfNode(c.type, 0, resolve))) return null;
              if (!isWord(shapeOf(c.expression)) && !wordInt(c.expression)) return null;
              return val(c.expression);
            }
            case NodeKind.BinaryExpr: {
              const x = e as BinaryExpr;
              if (x.operator !== '+' && x.operator !== '-') return null;
              const ls = shapeOf(x.left), rs = shapeOf(x.right);
              const lv = val(x.left), rv = val(x.right);
              if (!lv || !rv) return null;
              const lInt = wordInt(x.left);
              const rInt = wordInt(x.right);
              const k = x.operator === '+' ? 1n : -1n;
              if (lInt && rInt) return linAdd(lv, rv, k);
              if (ls && ls.stars > 0 && rInt) {
                const sz = elemSize(ls);
                return sz ? linAdd(lv, linScale(rv, BigInt(sz)), k) : null;
              }
              if (x.operator === '+' && rs && rs.stars > 0 && lInt) {
                const sz = elemSize(rs);
                return sz ? linAdd(rv, linScale(lv, BigInt(sz))) : null;
              }
              return null;
            }
            case NodeKind.ThisExpr:
              return isWord(shapeOf(e)) ? linAtom('this') : null;
            case NodeKind.UnaryExpr: {
              const u = e as UnaryExpr;
              if (u.operator === '&') return addr(u.operand);
              if (u.operator !== '*') return null;
              return read(e);
            }
            case NodeKind.MemberExpr: {
              const spelling = memberSpelling(e as MemberExpr);
              if (spelling?.includes('[')) return addr(e);
              return read(e);
            }
            case NodeKind.SubscriptExpr:
              return read(e);
            default:
              return null;
          }
        };
        const read = (e: Expression): Lin | null => {
          if (!isWord(shapeOf(e))) return null;
          const a = addr(e);
          if (!a) return null;
          const key = memKey(a);
          atomAddr.set(key, a);
          return linAtom(key);
        };
        const memberSpelling = (m: MemberExpr): string | undefined => {
          const obj = shapeOf(m.object);
          const name = (m.member as Identifier).name;
          if (!obj || typeof name !== 'string' || obj.stars !== (m.isArrow ? 1 : 0)) return undefined;
          const k = structKey(obj.base);
          return k ? structFields[k]?.[name] : undefined;
        };
        const addr = (expr: Expression): Lin | null => {
          const e = stripParens(expr);
          switch (e.kind) {
            case NodeKind.UnaryExpr: {
              const u = e as UnaryExpr;
              return u.operator === '*' ? val(u.operand) : null;
            }
            case NodeKind.MemberExpr: {
              const m = e as MemberExpr;
              const name = (m.member as Identifier).name;
              const obj = shapeOf(m.object);
              if (!obj || typeof name !== 'string' || obj.stars !== (m.isArrow ? 1 : 0)) return null;
              const k = structKey(obj.base);
              const off = k ? offsets[k]?.[name] : undefined;
              if (off === undefined) return null;
              const base = m.isArrow ? val(m.object) : addr(m.object);
              return base ? linAdd(base, linConst(BigInt(off))) : null;
            }
            case NodeKind.SubscriptExpr: {
              const s = e as SubscriptExpr;
              const sz = elemSize(shapeOf(s.array));
              const base = val(s.array), idx = val(s.index);
              if (!sz || !base || !idx || !wordInt(s.index)) return null;
              return linAdd(base, linScale(idx, BigInt(sz)));
            }
            case NodeKind.Identifier: {
              const name = (e as Identifier).name;
              return linAtom(localTypes.has(name) ? `&${name}` : `&g:${name}`);
            }
            default:
              return null;
          }
        };

        // ---- the proof
        if (selfTarget) {
          // A decompiler local may hold first the next word and then the slot
          // address. The same linear proof uses its reaching value BEFORE this
          // assignment; the helper reads that word again, so no volatile or
          // ambiguous binding may be involved.
          const def = defs.get(sName);
          if (!def || def.poisoned) return;
          const names = [...fn.parameters.map(p => p.name?.name).filter(Boolean),
            ...[...traverseAST(fn.body!)].filter(n => n.kind === NodeKind.VariableDecl).map(n => (n as VariableDecl).name.name)];
          if (new Set(names).size !== names.length) return;
          const volatileType = (spelling: string, seen = new Set<string>()): boolean => {
            if (/\bvolatile\b/.test(spelling)) return true;
            const base = spelling.replace(/\[[^\]]*\]/g, '').replace(/\bconst\b|\*/g, '').replace(/\s+/g, ' ').trim();
            const target = typedefTargets[base];
            if (!target) return false;
            if (seen.has(base)) return true;
            seen.add(base);
            return volatileType(target, seen);
          };
          if ([...localTypes.values()].some(t => volatileType(emit(t)))) return;
          for (const part of [def.rhs, ifs.condition, negArm.right, sumArm.right]) {
            for (const n of traverseAST(part)) {
              if (n.kind === NodeKind.Identifier && volatileType(options.globalTypes?.[(n as Identifier).name] ?? options.enclosingVarTypes?.[(n as Identifier).name] ?? '')) return;
              if (n.kind === NodeKind.MemberExpr && volatileType(memberSpelling(n as MemberExpr) ?? '')) return;
            }
          }
        }
        const nVal = val(n0);
        if (!nVal || nVal.c !== 0n || nVal.terms.size !== 1) return;
        const [[nKey, nCoeff]] = [...nVal.terms.entries()];
        const nAddr = atomAddr.get(nKey);
        if (nCoeff !== 1n || !nAddr) return;
        const link = linAdd(nAddr, linConst(-4n));
        const prevNext = linAtom(memKey(linAdd(linAtom(memKey(link)), linConst(4n))));

        // The ~ arm: casts to word types around `~X`, X equal to N.
        let negInner = stripParens(negArm.right);
        while (negInner.kind === NodeKind.CStyleCastExpr && isWord(shapeOfNode((negInner as CStyleCastExpr).type, 0, resolve))) {
          negInner = stripParens((negInner as CStyleCastExpr).expression);
        }
        if (negInner.kind !== NodeKind.UnaryExpr || (negInner as UnaryExpr).operator !== '~') return;
        const negOf = val((negInner as UnaryExpr).operand);
        if (!negOf || !linEq(negOf, nVal)) return;

        // The sum arm: an optional outer cast, then N + L - prev->next in any association.
        let sum = stripParens(sumArm.right);
        let outerCast: TypeNode | null = null;
        if (sum.kind === NodeKind.CStyleCastExpr) {
          const c = sum as CStyleCastExpr;
          if (!isWord(shapeOfNode(c.type, 0, resolve))) return;
          outerCast = c.type;
          sum = stripParens(c.expression);
        }
        // A word integer, or a byte pointer plus or minus one (`(char*)pLink + (n - prev->m_next)`):
        // char arithmetic adds the integer unscaled, so the sum is the same 32-bit value.
        const bytePtr = (x: Expression): boolean => {
          const sh = shapeOf(x);
          return !!sh && sh.stars > 0 && elemSize(sh) === 1;
        };
        const byteSum = (x: Expression): boolean => {
          const u = stripParens(x);
          if (u.kind !== NodeKind.BinaryExpr) return false;
          const bx = u as BinaryExpr;
          if (bx.operator !== '+' && bx.operator !== '-') return false;
          return (bytePtr(bx.left) && wordInt(bx.right)) || (bx.operator === '+' && wordInt(bx.left) && bytePtr(bx.right));
        };
        if (!wordInt(sum) && !(outerCast && byteSum(sum))) return;
        const sumVal = val(sum);
        if (!sumVal || !linEq(sumVal, linAdd(linAdd(nVal, link), prevNext, -1n))) return;
        if (!outerCast && !(sShape && sShape.stars === 0)) return;

        // L is spelled by the positive term of the sum that equals it.
        const terms: Array<{ sign: number; e: Expression }> = [];
        const flatten = (x: Expression, sign: number): boolean => {
          const u = stripParens(x);
          if (u.kind === NodeKind.BinaryExpr) {
            const bx = u as BinaryExpr;
            if ((bx.operator === '+' || bx.operator === '-') && ((wordInt(bx.left) && wordInt(bx.right)) || byteSum(bx))) {
              return flatten(bx.left, sign) && flatten(bx.right, bx.operator === '+' ? sign : -sign);
            }
          }
          terms.push({ sign, e: u });
          return true;
        };
        flatten(sum, 1);
        const lTerm = terms.find(t => t.sign > 0 && (() => { const v = val(t.e); return !!v && linEq(v, link); })());
        if (!lTerm) return;
        let linkExpr = lTerm.e;
        if (linkExpr.kind === NodeKind.CStyleCastExpr && (shapeOf((linkExpr as CStyleCastExpr).expression)?.stars ?? 0) > 0) {
          linkExpr = stripParens((linkExpr as CStyleCastExpr).expression);
        }
        const linkShape = shapeOf(linkExpr);
        const arg: Expression = linkShape && linkShape.stars > 0
          ? cloneNode(linkExpr)
          : Expr.cast(Type.pointer(Type.void()), Expr.paren(cloneNode(linkExpr)));
        const call: Expression = Expr.call(STORM_NEXT_LINK_HELPER, [arg, Expr.unary('-', Expr.intLiteral(1))]);
        const right = outerCast ? Expr.cast(cloneNode(outerCast), call) : call;
        const stmt: Statement = {
          ...({ kind: NodeKind.ExprStmt, expression: Expr.assign(Expr.identifier(sName), right) } as ExprStmt),
          leadingTrivia: ifs.leadingTrivia,
          trailingTrivia: ifs.trailingTrivia,
          location: ifs.location,
        } as Statement;
        rewrites.set(ifs, stmt);
        respellNextReads(ifs, linkExpr, link, val, addr);

        // In a straight-line, unescaped automatic local, an adjacent first
        // assignment of N is dead once the helper rereads N itself. Retain it
        // if an earlier use, a backedge, a captured value or the helper argument
        // could still depend on that local's old value. Never drop its declaration.
        if (selfTarget) {
          const d = defs.get(sName)!, block = parent.get(ifs);
          const nodes = [...traverseAST(fn.body!)];
          const declaration = nodes.find(n => n.kind === NodeKind.VariableDecl && (n as VariableDecl).name.name === sName) as VariableDecl | undefined;
          const first = nodes.find(n => n.kind === NodeKind.Identifier && (n as Identifier).name === sName && !declNames.has(n));
          const a = d.stmt.kind === NodeKind.ExprStmt ? stripParens((d.stmt as ExprStmt).expression) : null;
          const lhs = a?.kind === NodeKind.AssignExpr ? stripParens((a as AssignExpr).left) : null;
          const backedgeOrScope = nodes.some(n => [NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt,
            NodeKind.GotoStmt, NodeKind.LabelStmt, NodeKind.FunctionDecl, NodeKind.LambdaExpr, NodeKind.ClassDecl, NodeKind.StructDecl].includes(n.kind));
          const argumentReadsTarget = [...traverseAST(arg)].some(n => n.kind === NodeKind.Identifier && (n as Identifier).name === sName);
          if (declaration && !declaration.specifiers.length && !declaration.attributes.length && first === lhs && !backedgeOrScope && !argumentReadsTarget
            && block?.kind === NodeKind.CompoundStmt && (block as CompoundStmt).statements[(block as CompoundStmt).statements.indexOf(ifs)-1] === d.stmt) drops.add(d.stmt);
        }

        // A local that only carried N here goes with its definition.
        let dropped: string | undefined;
        let nIdent = stripParens(n0);
        while (nIdent.kind === NodeKind.CStyleCastExpr) nIdent = stripParens((nIdent as CStyleCastExpr).expression);
        // Only the guarded adjacent case above may drop a self-target's reaching
        // definition. Its declaration remains needed by the replacement store.
        if (nIdent.kind === NodeKind.Identifier && (nIdent as Identifier).name !== sName) {
          const name = (nIdent as Identifier).name;
          const d = defs.get(name);
          if (d && !d.poisoned && !drops.has(d.stmt)) {
            const refs = (root: ASTNode): number => {
              let k = 0;
              for (const r of traverseAST(root)) {
                if (r.kind === NodeKind.Identifier && (r as Identifier).name === name && !declNames.has(r)) k++;
              }
              return k;
            };
            const uses = refs(fn.body!);
            const inSite = refs(ifs);
            const inDef = d.stmt.kind === NodeKind.ExprStmt ? 1 : 0;
            const singleDecl = d.stmt.kind !== NodeKind.DeclStmt || (d.stmt as DeclStmt).declarations.length === 1;
            if (singleDecl && uses - inSite - inDef === 0) {
              drops.add(d.stmt);
              dropped = name;
              if (d.stmt.kind === NodeKind.ExprStmt) {
                // A bare declaration of it, now unused.
                for (const r of traverseAST(fn.body!)) {
                  if (r.kind !== NodeKind.DeclStmt) continue;
                  const ds = r as DeclStmt;
                  if (ds.declarations.length === 1 && ds.declarations[0].kind === NodeKind.VariableDecl
                      && (ds.declarations[0] as VariableDecl).name.name === name && !(ds.declarations[0] as VariableDecl).initializer) {
                    drops.add(ds);
                  }
                }
              }
            }
          }
        }
        options.onSite?.({ line: ifs.location?.start?.line ?? 0, target: sName, ...(dropped ? { droppedLocal: dropped } : {}) });
      };

      for (const n of [...traverseAST(fn.body)]) {
        if (n.kind === NodeKind.IfStmt && isCandidate(n as IfStmt)) site(n as IfStmt);
      }
      if (rewrites.size === 0) return undefined;

      const rebuild = (n: unknown): unknown => {
        if (Array.isArray(n)) {
          let changed = false;
          const out: unknown[] = [];
          for (const x of n) {
            if (x && typeof x === 'object' && drops.has(x as ASTNode)) { changed = true; continue; }
            const y = rebuild(x);
            if (y !== x) changed = true;
            out.push(y);
          }
          return changed ? out : n;
        }
        if (!n || typeof n !== 'object' || !('kind' in (n as object))) return n;
        const r = rewrites.get(n as ASTNode);
        if (r) return r;
        let next: Record<string, unknown> | null = null;
        for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
          if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'ghidraInfo') continue;
          if (!v || typeof v !== 'object') continue;
          const y = rebuild(v);
          if (y !== v) { next ??= { ...(n as Record<string, unknown>) }; next[k] = y; }
        }
        return next ?? n;
      };
      const body = rebuild(fn.body) as CompoundStmt;
      return updateNode(fn, { body } as Partial<FunctionDecl>);
    },
  });
  const insert = createStormNextLinkInsertTransformer(options);
  return node => unlink(insert(node));
}

/** Cheap pre-filter: an if/else whose arms each store one value and one arm stores a `~`. */
function isCandidate(ifs: IfStmt): boolean {
  if (!ifs.elseBranch) return false;
  const a = singleStore(ifs.thenBranch), b = singleStore(ifs.elseBranch);
  if (!a || !b) return false;
  const hasNot = (e: Expression) => {
    let x = stripParens(e);
    while (x.kind === NodeKind.CStyleCastExpr) x = stripParens((x as CStyleCastExpr).expression);
    return x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '~';
  };
  return hasNot(a.right) || hasNot(b.right);
}

export { createStormNextLinkTransformer };

export const stormNextLinkPlugin: TransformPlugin = {
  id: 'storm-next-link',
  name: 'Storm Next Link',
  description: 'The flattened inline TSLink::NextLink(-1) of a Storm unlink, written as a call to the inline helper',
  version: '1.0.0',
  defaultEnabled: true,
  // After the types and the arms are final (join-store-temp 970), before branch-layout (988)
  // reads the arms.
  priority: 975,
  tags: ['matching'],
  createTransformer: createStormNextLinkTransformer,
};
