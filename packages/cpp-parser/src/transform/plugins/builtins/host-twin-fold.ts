/**
 * Host Twin Fold Plugin
 *
 * A header inline whose surviving copy the rebuild defines `noinline` (inline-hosts.ts) was
 * expanded in place by most of its callers. GetXPosFromDynamicPathUnit (0045adf0) is one:
 *
 *     eUnitType = pUnit->eUnitType;
 *     if (eUnitType != UNIT_OBJECT && ((int)eUnitType < 4 || 5 < (int)eUnitType)) {
 *       if (pUnit->pPath.pDynamicPath) { nXPos = GetXPos(pUnit->pPath.pDynamicPath); return nXPos; }
 *       return 0;
 *     }
 *     return pUnit->pPath.pStaticPath->nPosX;
 *
 * About four hundred sites hold that body, and the decompiler prints each one its own way:
 * the arms swapped, the call result copied through a temporary of its own, the store going
 * through a cast, the result never stored but tail-duplicated into the one call that reads
 * it (SUNITNPC_UpdateHirelingPosition 005773d0 calls PETS_ManagePetsByType three times, the
 * original once). The codegen gives such a host a forced-inline twin, `<name>Inline`
 * (codegen/host-twins.ts); this pass writes the twin's call where a site computes exactly what
 * the host returns and the decompiler did not print it as one store on every path - the
 * tail-duplicated call, or the call result copied through a temporary of its own:
 *
 *     eUnitType = pPlayer->eUnitType;
 *     if (eUnitType != UNIT_OBJECT && ((int)eUnitType <= 3 || (int)eUnitType > 5)) {
 *       if (pPlayer->pPath.pDynamicPath) {
 *         nPosX = GetXPos(pPlayer->pPath.pDynamicPath);
 *         PETS_ManagePetsByType(pGame, pPlayer, (uint16_t)nPosX, (uint16_t)wPosY);   ->   nPosX = GetXPosFromDynamicPathUnitInline(pPlayer);
 *         return;                                                                        PETS_ManagePetsByType(pGame, pPlayer, (uint16_t)nPosX, (uint16_t)wPosY);
 *       }
 *       PETS_ManagePetsByType(pGame, pPlayer, 0, (uint16_t)wPosY);
 *       return;
 *     }
 *     PETS_ManagePetsByType(pGame, pPlayer, (uint16_t)pPlayer->pPath.pStaticPath->nPosX, (uint16_t)wPosY);
 *
 * A site already printed as one store is the expansion VC8 compiled and stays written out
 * (storeForm says what that cost when it was folded too).
 *
 * Nothing is matched by shape. The host's body and the site are both run symbolically over
 * every valuation of the fields they test (each tested field of the argument is an atom; its
 * values are every constant either side compares it with, the constants' neighbours, zero
 * and the ends of both the signed and the unsigned 32-bit range, which visits every cell the
 * comparisons can tell apart), and the rewrite is made only when, on every valuation:
 *
 *   - the site's conditions read nothing but those fields of one argument expression (a
 *     local or parameter, or a member chain of one, with no call), either directly or through
 *     a temporary loaded from one right before the site, and make only signed comparisons
 *     where both operands' signedness is spelled, unsigned ones where one operand is unsigned;
 *   - the site then performs exactly one store `L = V`, or `t = V; L = t` through a local t,
 *     and nothing else (no call, store, return or jump) - and V is the host's return value
 *     on that valuation with the argument substituted: the same field read, the same call of
 *     the same function with the same arguments, or the same constant;
 *   - the conversions on the way (the casts on V, the temporary's type, L's type) give the
 *     value the twin's result converted to L's type gives, bit for bit.
 *
 * The site becomes `L = Twin(arg);`. Every read of the argument happens before the one call
 * either form makes, so the twin evaluating its argument once reads the same value. L is a
 * local or a member path through at most one pointer held in a local, which the call cannot
 * change. A temporary loaded before the site, and t, go when nothing else reads them.
 *
 * A tail-duplicated site is the same run over the statements up to the end of the block:
 * every valuation must execute the same statement list, ending in the same `return`, that
 * differs only in one expression, which is the host's value under that valuation (or t, with
 * t = the call right before). The duplicated statements are written once, the differing
 * expression replaced by t (or a new local's) value from `t = Twin(arg);`.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, CStyleCastExpr, DeclStmt, Expression, ExprStmt,
  FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, LabelStmt, MemberExpr, ParameterDecl, ParenExpr,
  QualifiedId, ReturnStmt, Statement, TypeNode, UnaryExpr, VariableDecl, BoolLiteralExpr,
} from '../../../ast/nodes.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import { getChildren, traverseAST } from '../../../ast/visitor.js';
import { TriviaKind } from '../../../lexer/trivia.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import { sameExpr } from './rotated-for-loop.js';
import { shapeOfNode, type TypedefResolver } from './call-arg-cast.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

/** A header inline with a forced-inline twin, as the codegen hands it over. */
export interface HostTwin {
  /** The twin's name as a call spells it, qualified (`D2Common::Units::GetXPosFromDynamicPathUnitInline`). */
  call: string;
  /** The host's one parameter. */
  param: string;
  /** The host's return type, spelled. */
  returnType: string;
  /** The host's body, as decompiled. */
  body: CompoundStmt;
  /** The host's locals and their types, spelled (its temporaries' signedness). */
  locals: Record<string, string>;
}

export interface HostTwinFoldOptions extends PluginOptions {
  twins?: HostTwin[];
  enumValues?: Record<string, number>;
  typedefTargets?: Record<string, string>;
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  onSite?: (e: { call: string; arg: string; form: 'store' | 'tail' }) => void;
  onReject?: (e: { call: string; why: string }) => void;
}

type N = ASTNode & Record<string, any>;

class Reject extends Error {}
const no = (why: string): never => { throw new Reject(why); };

// ---------------------------------------------------------------------------
// Integer types

type IntKind = { w: 8 | 16 | 32 | 64; s: boolean };

const INT_TYPES: Record<string, IntKind> = {
  'int': { w: 32, s: true }, 'int32_t': { w: 32, s: true }, 'long': { w: 32, s: true }, 'signed': { w: 32, s: true },
  'signed int': { w: 32, s: true }, 'INT': { w: 32, s: true }, 'LONG': { w: 32, s: true }, 'BOOL': { w: 32, s: true },
  'uint32_t': { w: 32, s: false }, 'uint': { w: 32, s: false }, 'unsigned int': { w: 32, s: false },
  'unsigned': { w: 32, s: false }, 'DWORD': { w: 32, s: false }, 'UINT': { w: 32, s: false },
  'ULONG': { w: 32, s: false }, 'unsigned long': { w: 32, s: false },
  'uint64_t': { w: 64, s: false }, 'unsigned long long': { w: 64, s: false }, 'ULONGLONG': { w: 64, s: false },
  'int64_t': { w: 64, s: true }, 'long long': { w: 64, s: true }, '__int64': { w: 64, s: true }, 'LONGLONG': { w: 64, s: true },
  'uint8_t': { w: 8, s: false }, 'BYTE': { w: 8, s: false }, 'uchar': { w: 8, s: false }, 'unsigned char': { w: 8, s: false },
  'uint16_t': { w: 16, s: false }, 'WORD': { w: 16, s: false }, 'ushort': { w: 16, s: false }, 'unsigned short': { w: 16, s: false },
  'int8_t': { w: 8, s: true }, 'signed char': { w: 8, s: true }, 'char': { w: 8, s: true },
  'int16_t': { w: 16, s: true }, 'short': { w: 16, s: true }, 'short int': { w: 16, s: true },
};

function intKindOfBase(base: string, resolve?: TypedefResolver): IntKind | null {
  let b = base.replace(/^(?:const|volatile)\s+/, '').trim();
  for (let i = 0; i < 8; i++) {
    if (INT_TYPES[b]) return INT_TYPES[b];
    const r = resolve?.(b);
    if (!r || r === b) return null;
    b = r.trim();
  }
  return null;
}

function intKindOfType(t: TypeNode, resolve: TypedefResolver): IntKind | null {
  const s = shapeOfNode(t, 0, resolve);
  if (!s || s.stars !== 0) return null;
  return intKindOfBase(s.base, resolve);
}

/**
 * What a chain of integer conversions does to a value: the low `m` bits of the input,
 * extended by `e` (true: sign) and viewed at width `w` with signedness `s`.
 */
interface Conv { m: number; e: boolean; w: number; s: boolean }

function convStart(k: IntKind): Conv { return { m: k.w, e: k.s, w: k.w, s: k.s }; }

function convTo(c: Conv | null, k: IntKind): Conv | null {
  if (!c) return null;
  if (k.w <= c.m) return { m: k.w, e: k.s, w: k.w, s: k.s };
  if (k.w <= c.w) return { m: c.m, e: c.e, w: k.w, s: k.s };
  // Widening past the current width extends by the current type's signedness.
  if (c.w === c.m) return { m: c.m, e: c.s, w: k.w, s: k.s };
  if (c.e === c.s) return { m: c.m, e: c.e, w: k.w, s: k.s };
  return null;
}

function sameConv(a: Conv | null, b: Conv | null): boolean {
  if (!a || !b) return false;
  const na = a.m === a.w ? { ...a, e: a.s } : a;
  const nb = b.m === b.w ? { ...b, e: b.s } : b;
  return na.m === nb.m && na.e === nb.e && na.w === nb.w && na.s === nb.s;
}

/** A constant converted to an integer type, as the integer it then stands for. */
function convertConst(v: bigint, k: IntKind): bigint {
  const mod = 1n << BigInt(k.w);
  let x = ((v % mod) + mod) % mod;
  if (k.s && x >= mod >> 1n) x -= mod;
  return x;
}

// ---------------------------------------------------------------------------
// Expressions

function unparen(e: Expression): Expression {
  let x = e as N;
  while (x && x.kind === NodeKind.ParenExpr) x = (x as ParenExpr).expression as N;
  return x as Expression;
}

function hasComment(s: ASTNode): boolean {
  return [...(s.leadingTrivia ?? []), ...(s.trailingTrivia ?? [])]
    .some(t => t.kind === TriviaKind.LineComment || t.kind === TriviaKind.BlockComment);
}

function idName(e: Expression | null | undefined): string | null {
  if (!e) return null;
  const x = unparen(e);
  return x.kind === NodeKind.Identifier ? (x as Identifier).name : null;
}

/** The casts around an expression, innermost first, and what they wrap. */
function stripCasts(e: Expression): { base: Expression; casts: TypeNode[] } {
  const casts: TypeNode[] = [];
  let x = unparen(e);
  while (x.kind === NodeKind.CStyleCastExpr) {
    casts.unshift((x as CStyleCastExpr).type);
    x = unparen((x as CStyleCastExpr).expression);
  }
  return { base: x, casts };
}

/** `root->a.b`: the member path, outermost last, as a key, and the root it hangs from. */
function memberPath(e: Expression): { root: Expression; key: string } | null {
  const parts: string[] = [];
  let x = unparen(e);
  if (x.kind !== NodeKind.MemberExpr) return null;
  while (x.kind === NodeKind.MemberExpr) {
    const m = x as MemberExpr;
    if (m.member.kind !== NodeKind.Identifier) return null;
    parts.unshift(`${m.isArrow ? '->' : '.'}${(m.member as Identifier).name}`);
    x = unparen(m.object);
  }
  return { root: x, key: parts.join('') };
}

/** A local or parameter, or a member chain of one: read twice, it reads the same storage. */
function isPlainRoot(e: Expression): boolean {
  const x = unparen(e);
  if (x.kind === NodeKind.Identifier) return true;
  if (x.kind === NodeKind.MemberExpr) {
    const m = x as MemberExpr;
    return m.member.kind === NodeKind.Identifier && isPlainRoot(m.object);
  }
  return false;
}

/** The qualified name a call spells, without a leading `::`. */
function calleeParts(e: Expression): string[] | null {
  const x = unparen(e);
  if (x.kind === NodeKind.Identifier) return [(x as Identifier).name];
  if (x.kind === NodeKind.QualifiedId) {
    const q = x as QualifiedId;
    if (q.name.kind !== NodeKind.Identifier || !q.qualifier.every(p => p.kind === NodeKind.Identifier)) return null;
    return [...q.qualifier.map(p => (p as Identifier).name), (q.name as Identifier).name];
  }
  return null;
}

function sameCallee(a: Expression, b: Expression): boolean {
  const pa = calleeParts(a), pb = calleeParts(b);
  if (!pa || !pb) return false;
  const [short, long] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  return short.every((p, i) => long[long.length - short.length + i] === p);
}

function constValue(e: Expression, enums: Record<string, number>): bigint | null {
  const x = unparen(e);
  if (x.kind === NodeKind.IntegerLiteral) return (x as IntegerLiteralExpr).value;
  if (x.kind === NodeKind.NullptrLiteral) return 0n;
  if (x.kind === NodeKind.BoolLiteral) return (x as BoolLiteralExpr).value ? 1n : 0n;
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
    const v = constValue((x as UnaryExpr).operand, enums);
    return v === null ? null : -v;
  }
  if (x.kind === NodeKind.Identifier) {
    const n = (x as Identifier).name;
    if (n === 'NULL') return 0n;
    if (enums[n] !== undefined) return BigInt(enums[n]);
  }
  return null;
}

/** Whether a site expression is the host expression with the host's parameter standing for `arg`. */
function sameUnder(site: Expression, host: Expression, param: string, arg: Expression): boolean {
  const s = unparen(site), h = unparen(host);
  if (h.kind === NodeKind.Identifier && (h as Identifier).name === param) return sameExpr(s, arg);
  if (s.kind !== h.kind) return false;
  switch (h.kind) {
    case NodeKind.MemberExpr: {
      const a = s as MemberExpr, b = h as MemberExpr;
      return a.isArrow === b.isArrow && a.member.kind === NodeKind.Identifier && b.member.kind === NodeKind.Identifier
        && (a.member as Identifier).name === (b.member as Identifier).name && sameUnder(a.object, b.object, param, arg);
    }
    case NodeKind.CallExpr: {
      const a = s as CallExpr, b = h as CallExpr;
      return sameCallee(a.callee, b.callee) && a.arguments.length === b.arguments.length
        && a.arguments.every((x, i) => sameUnder(x, b.arguments[i], param, arg));
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Symbolic evaluation of the conditions

/** A 32-bit value as its bit pattern, and its type's signedness (null: not spelled). */
interface Val { v: bigint; s: boolean | null }

const M32 = (1n << 32n) - 1n;
const toS = (v: bigint): bigint => (v >= 1n << 31n ? v - (1n << 32n) : v);

interface Atoms {
  /** Root expression the atoms hang from (the site's argument, or the host's parameter). */
  isRoot: (e: Expression) => boolean;
  /** Temporaries loaded from an atom: name -> atom key, and their declared kinds. */
  alias: Map<string, string>;
  kinds: (name: string) => IntKind | null;
  enums: Record<string, number>;
  shape: ExprShape | null;
  resolve: TypedefResolver;
}

/** Every atom an expression reads, and the constants each is compared with. */
function collectAtoms(e: Expression, a: Atoms, out: Map<string, Set<bigint>>): void {
  const x = unparen(e);
  const atomOf = (y: Expression): string | null => {
    const b = stripCasts(y).base;
    const n = idName(b);
    if (n !== null && a.alias.has(n)) return a.alias.get(n)!;
    const p = memberPath(b);
    return p && a.isRoot(p.root) ? p.key : null;
  };
  const self = atomOf(x);
  if (self !== null) { if (!out.has(self)) out.set(self, new Set()); return; }
  if (x.kind === NodeKind.BinaryExpr) {
    const b = x as BinaryExpr;
    if (['==', '!=', '<', '<=', '>', '>='].includes(b.operator)) {
      const l = atomOf(b.left), r = atomOf(b.right);
      const lc = constValue(stripCasts(b.left).base, a.enums), rc = constValue(stripCasts(b.right).base, a.enums);
      if (l !== null && rc !== null) { if (!out.has(l)) out.set(l, new Set()); out.get(l)!.add(rc & M32); }
      if (r !== null && lc !== null) { if (!out.has(r)) out.set(r, new Set()); out.get(r)!.add(lc & M32); }
    }
  }
  for (const k of getChildren(x)) collectAtoms(k as Expression, a, out);
}

/** The values to try for an atom: the cells of the signed and unsigned orders its comparisons cut. */
function testValues(consts: Set<bigint>): bigint[] {
  const vs = new Set<bigint>([0n, 1n, M32, 0x7fffffffn, 0x80000000n]);
  for (const c of consts) for (const d of [c - 1n, c, c + 1n]) vs.add(d & M32);
  return [...vs].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

function evalExpr(e: Expression, a: Atoms, val: Map<string, bigint>): Val {
  const x = unparen(e);
  const n = idName(x);
  if (n !== null && a.alias.has(n)) {
    const k = a.kinds(n);
    if (!k || k.w !== 32) no(`temporary ${n} is not a 32-bit integer`);
    return { v: val.get(a.alias.get(n)!)!, s: k!.s };
  }
  const p = memberPath(x);
  if (p && a.isRoot(p.root)) {
    if (!val.has(p.key)) no(`unknown atom ${p.key}`);
    const sh = a.shape?.(x);
    const k = sh && sh.stars === 0 ? intKindOfBase(sh.base, a.resolve) : null;
    return { v: val.get(p.key)!, s: k && k.w === 32 ? k.s : null };
  }
  switch (x.kind) {
    case NodeKind.IntegerLiteral: {
      const lit = x as IntegerLiteralExpr;
      if (lit.value > M32) no('literal wider than 32 bits');
      const uns = /u/i.test(lit.suffix ?? '') || lit.value > 0x7fffffffn;
      return { v: lit.value & M32, s: !uns };
    }
    case NodeKind.NullptrLiteral:
      return { v: 0n, s: null };
    case NodeKind.BoolLiteral:
      return { v: (x as BoolLiteralExpr).value ? 1n : 0n, s: true };
    case NodeKind.Identifier: {
      const c = constValue(x, a.enums);
      if (c === null) no(`name ${(x as Identifier).name} is neither an atom nor a constant`);
      return { v: c! & M32, s: null };
    }
    case NodeKind.CStyleCastExpr: {
      const c = x as CStyleCastExpr;
      const inner = evalExpr(c.expression, a, val);
      const sh = shapeOfNode(c.type, 0, a.resolve);
      if (sh && sh.stars > 0) return { v: inner.v, s: null };
      const k = intKindOfType(c.type, a.resolve);
      if (!k || k.w === 64) no('cast to a type other than a 32-bit-or-narrower integer or a pointer');
      if (k!.w === 32) return { v: inner.v, s: k!.s };
      if (inner.s === null && k!.s) no('narrowing an operand of unspelled signedness');
      const t = convertConst(inner.v, k!);
      return { v: t & M32, s: true };
    }
    case NodeKind.UnaryExpr: {
      const u = x as UnaryExpr;
      if (u.operator === '!') return { v: evalExpr(u.operand, a, val).v === 0n ? 1n : 0n, s: true };
      if (u.operator === '-') { const v = evalExpr(u.operand, a, val); return { v: (-v.v) & M32, s: v.s }; }
      return no(`unary ${u.operator}`);
    }
    case NodeKind.BinaryExpr: {
      const b = x as BinaryExpr;
      if (b.operator === '&&') return { v: evalExpr(b.left, a, val).v !== 0n && evalExpr(b.right, a, val).v !== 0n ? 1n : 0n, s: true };
      if (b.operator === '||') return { v: evalExpr(b.left, a, val).v !== 0n || evalExpr(b.right, a, val).v !== 0n ? 1n : 0n, s: true };
      const l = evalExpr(b.left, a, val), r = evalExpr(b.right, a, val);
      if (b.operator === '==') return { v: l.v === r.v ? 1n : 0n, s: true };
      if (b.operator === '!=') return { v: l.v !== r.v ? 1n : 0n, s: true };
      if (['<', '<=', '>', '>='].includes(b.operator)) {
        let signed: boolean;
        if (l.s === false || r.s === false) signed = false;
        else if (l.s === true && r.s === true) signed = true;
        else return no('relational comparison of an operand of unspelled signedness');
        const lv = signed ? toS(l.v) : l.v, rv = signed ? toS(r.v) : r.v;
        const t = b.operator === '<' ? lv < rv : b.operator === '<=' ? lv <= rv : b.operator === '>' ? lv > rv : lv >= rv;
        return { v: t ? 1n : 0n, s: true };
      }
      return no(`binary ${b.operator}`);
    }
    default:
      return no(`expression ${x.kind}`);
  }
}

const truth = (e: Expression, a: Atoms, val: Map<string, bigint>): boolean => evalExpr(e, a, val).v !== 0n;

// ---------------------------------------------------------------------------
// The host

/** What the host returns on one valuation: the expression, and the conversions it goes through. */
interface Leaf { expr: Expression }

function runHost(t: HostTwin, a: Atoms, val: Map<string, bigint>): Leaf {
  const held = new Map<string, Expression>();
  const walk = (stmts: Statement[]): Leaf | null => {
    for (const s0 of stmts) {
      const s = s0 as N;
      switch (s.kind) {
        case NodeKind.DeclStmt:
          for (const d of (s as DeclStmt).declarations as N[]) {
            if (d.kind !== NodeKind.VariableDecl) no('host declares something other than a variable');
            if ((d as VariableDecl).initializer) no('host initialises a declaration');
          }
          break;
        case NodeKind.ExprStmt: {
          const e = unparen((s as ExprStmt).expression);
          if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') no('host statement is not a store');
          const name = idName((e as AssignExpr).left);
          if (name === null) no('host stores to memory');
          const right = unparen((e as AssignExpr).right);
          if (a.alias.has(name!)) break; // the type temporary, read as its atom
          if (right.kind !== NodeKind.CallExpr) no('host stores something other than a call result');
          held.set(name!, right);
          break;
        }
        case NodeKind.IfStmt: {
          const i = s as IfStmt;
          const r = truth(i.condition, a, val) ? walk(listOf(i.thenBranch)) : i.elseBranch ? walk(listOf(i.elseBranch)) : null;
          if (r) return r;
          break;
        }
        case NodeKind.CompoundStmt: {
          const r = walk((s as CompoundStmt).statements);
          if (r) return r;
          break;
        }
        case NodeKind.ReturnStmt: {
          const v = (s as ReturnStmt).value;
          if (!v) no('host returns nothing');
          const n = idName(v);
          if (n !== null && held.has(n)) return { expr: held.get(n)! };
          return { expr: v! };
        }
        default:
          no(`host statement ${s.kind}`);
      }
    }
    return null;
  };
  return walk(t.body.statements) ?? no('host falls off its end');
}

function listOf(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s];
}

/** The host's temporaries loaded from a field of its parameter. */
function hostAliases(t: HostTwin): Map<string, string> {
  const m = new Map<string, string>();
  for (const k of traverseAST(t.body)) {
    if (k.kind !== NodeKind.ExprStmt) continue;
    const e = unparen((k as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr) continue;
    const n = idName((e as AssignExpr).left);
    const p = memberPath((e as AssignExpr).right);
    if (n !== null && p && idName(p.root) === t.param) m.set(n, p.key);
  }
  return m;
}

// ---------------------------------------------------------------------------
// The site

interface Ctx {
  resolve: TypedefResolver;
  enums: Record<string, number>;
  shape: ExprShape;
  /** Locals of the function: name -> type, for names declared once. */
  locals: Map<string, TypeNode>;
  /** Names whose address is taken. */
  addressed: Set<string>;
}

/** The kind of an expression's type, when it is an integer of known width. */
function kindOf(e: Expression, ctx: Ctx): IntKind | null {
  const x = unparen(e);
  const n = idName(x);
  if (n !== null && ctx.locals.has(n)) return intKindOfType(ctx.locals.get(n)!, ctx.resolve);
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') {
    const o = stripCasts((x as UnaryExpr).operand);
    if (o.casts.length > 0) {
      const sh = shapeOfNode(o.casts[o.casts.length - 1], 0, ctx.resolve);
      if (sh && sh.stars === 1) return intKindOfBase(sh.base, ctx.resolve);
    }
  }
  const sh = ctx.shape(x);
  return sh && sh.stars === 0 ? intKindOfBase(sh.base, ctx.resolve) : null;
}

/**
 * Where the stored value lands: a local, or a member path from one through at most one
 * pointer held in a local (`sPacket.wY`, `pOut->nX`, `*(uint16_t*)((char*)&aPacket + 7)`).
 * The call the site makes cannot change any of it.
 */
function safeTarget(e: Expression, ctx: Ctx): boolean {
  let x = unparen(e);
  let derefs = 0;
  for (;;) {
    if (x.kind === NodeKind.Identifier) return ctx.locals.has((x as Identifier).name);
    if (x.kind === NodeKind.MemberExpr) {
      const m = x as MemberExpr;
      if (m.member.kind !== NodeKind.Identifier) return false;
      if (m.isArrow && ++derefs > 1) return false;
      x = unparen(m.object);
      continue;
    }
    if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') {
      if (++derefs > 1) return false;
      // *(T*)((char*)&local + K) or *(T*)&local
      let o = stripCasts((x as UnaryExpr).operand).base;
      if (o.kind === NodeKind.BinaryExpr && (o as BinaryExpr).operator === '+') {
        if (constValue((o as BinaryExpr).right, ctx.enums) === null) return false;
        o = stripCasts((o as BinaryExpr).left).base;
      }
      if (o.kind === NodeKind.UnaryExpr && (o as UnaryExpr).operator === '&') {
        const r = idName((o as UnaryExpr).operand);
        return r !== null && ctx.locals.has(r);
      }
      const r = idName(o);
      return r !== null && ctx.locals.has(r);
    }
    return false;
  }
}

/** The statements one valuation runs through a site, to the end of the list or a return. */
interface Run { effects: Statement[]; returned: ReturnStmt | null }

function runSite(stmts: Statement[], a: Atoms, val: Map<string, bigint>): Run {
  const effects: Statement[] = [];
  let returned: ReturnStmt | null = null;
  const walk = (list: Statement[]): boolean => {
    for (const s0 of list) {
      const s = s0 as N;
      if (hasComment(s)) no('a comment in the site');
      switch (s.kind) {
        case NodeKind.IfStmt: {
          if (effects.length > 0) no('a test after a store');
          const i = s as IfStmt;
          if (i.init) no('if with an initialiser');
          const done = truth(i.condition, a, val) ? walk(listOf(i.thenBranch)) : i.elseBranch ? walk(listOf(i.elseBranch)) : false;
          if (done) return true;
          break;
        }
        case NodeKind.CompoundStmt:
          if (walk((s as CompoundStmt).statements)) return true;
          break;
        case NodeKind.ReturnStmt:
          returned = s as ReturnStmt;
          return true;
        case NodeKind.ExprStmt:
          effects.push(s as Statement);
          break;
        default:
          no(`site statement ${s.kind}`);
      }
    }
    return false;
  };
  walk(stmts);
  return { effects, returned };
}

/** What a stored value is: the base expression and the conversions on the way to the store. */
interface Stored { base: Expression; conv: Conv | null; constant: bigint | null }

function storedValue(e: Expression, extra: IntKind[], ctx: Ctx): Stored {
  const { base, casts } = stripCasts(e);
  const kinds: IntKind[] = [];
  for (const c of casts) {
    const k = intKindOfType(c, ctx.resolve);
    if (!k) no('a cast to a non-integer type on the stored value');
    kinds.push(k!);
  }
  kinds.push(...extra);
  const c = constValue(base, ctx.enums);
  if (c !== null) {
    let v = c;
    for (const k of kinds) v = convertConst(v, k);
    return { base, conv: null, constant: v };
  }
  const bk = kindOf(base, ctx);
  if (!bk) return { base, conv: kinds.length === 0 ? convStart({ w: 32, s: true }) : null, constant: null };
  let conv: Conv | null = convStart(bk);
  for (const k of kinds) conv = convTo(conv, k);
  return { base, conv, constant: null };
}

// ---------------------------------------------------------------------------
// The pass

interface Found {
  block: CompoundStmt;
  start: number;   // first statement of the site (the temporary's load, or the if)
  end: number;     // last statement replaced (inclusive)
  replacement: Statement[];
  /** The load of the type temporary, kept when something else reads it. */
  aliasStmt: Statement | null;
  aliasName: string | null;
  /** The call result's temporary, and the number of its reads the site accounts for. */
  temp: string | null;
  tempReads: number;
  aliasReads: number;
  call: string;
  arg: string;
  form: 'store' | 'tail';
}

function readsOf(root: ASTNode, name: string): number {
  let n = 0;
  for (const k of traverseAST(root)) {
    if (k.kind === NodeKind.Identifier && (k as Identifier).name === name) n++;
    if (k.kind === NodeKind.VariableDecl && (k as VariableDecl).name.name === name) n--; // the declarator's own name
  }
  return n;
}

function storesTo(root: ASTNode, name: string): number {
  let n = 0;
  for (const k of traverseAST(root)) {
    if (k.kind === NodeKind.AssignExpr && idName((k as AssignExpr).left) === name) n++;
    if (k.kind === NodeKind.VariableDecl && (k as VariableDecl).name.name === name && (k as VariableDecl).initializer) n++;
  }
  return n;
}

/** The atom-reading temporary a statement loads: `t = arg->F;` or `T t = arg->F;`. */
function aliasLoad(s: Statement): { name: string; root: Expression; key: string } | null {
  let x = s as N;
  if (x.kind === NodeKind.LabelStmt) return null;
  if (x.kind === NodeKind.ExprStmt) {
    const e = unparen(x.expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    const n = idName((e as AssignExpr).left);
    const p = memberPath((e as AssignExpr).right);
    return n !== null && p && isPlainRoot(p.root) ? { name: n, root: p.root, key: p.key } : null;
  }
  if (x.kind === NodeKind.DeclStmt && x.declarations.length === 1 && x.declarations[0].kind === NodeKind.VariableDecl) {
    const d = x.declarations[0] as VariableDecl;
    if (!d.initializer || d.initializer.kind === NodeKind.InitListExpr) return null;
    const p = memberPath(d.initializer as Expression);
    return p && isPlainRoot(p.root) ? { name: d.name.name, root: p.root, key: p.key } : null;
  }
  return null;
}

/** The root a site's first condition reads its atoms from. */
function conditionRoot(cond: Expression, alias: Map<string, string>, aliasRoot: Expression | null): Expression | null {
  let found: Expression | null = null;
  for (const k of traverseAST(cond)) {
    if (k.kind === NodeKind.Identifier && alias.has((k as Identifier).name)) return aliasRoot;
    if (k.kind === NodeKind.MemberExpr && !found) {
      const p = memberPath(k as Expression);
      if (p && isPlainRoot(p.root) && unparen(p.root).kind === NodeKind.Identifier) found = p.root;
    }
  }
  return found;
}

function tryTwin(t: HostTwin, block: CompoundStmt, j: number, ctx: Ctx, fnBody: CompoundStmt, isFnBody: boolean): Found | null {
  const st = block.statements;
  const ifs = st[j] as IfStmt;
  const prev = j > 0 ? aliasLoad(st[j - 1]) : null;
  const siteAlias = new Map<string, string>();
  if (prev) siteAlias.set(prev.name, prev.key);
  const arg = conditionRoot(ifs.condition, siteAlias, prev ? prev.root : null);
  if (!arg || !isPlainRoot(arg)) return null;
  if (prev && !sameExpr(prev.root, arg)) siteAlias.clear();
  const argRootName = (() => { let x = unparen(arg); while (x.kind === NodeKind.MemberExpr) x = unparen((x as MemberExpr).object); return idName(x); })();

  const hostA: Atoms = {
    isRoot: e => idName(e) === t.param, alias: hostAliases(t),
    kinds: n => (t.locals[n] ? intKindOfBase(t.locals[n], ctx.resolve) : null),
    enums: ctx.enums, shape: null, resolve: ctx.resolve,
  };
  const siteA: Atoms = {
    isRoot: e => sameExpr(e, arg), alias: siteAlias,
    kinds: n => (ctx.locals.has(n) ? intKindOfType(ctx.locals.get(n)!, ctx.resolve) : null),
    enums: ctx.enums, shape: ctx.shape, resolve: ctx.resolve,
  };
  const retKind = intKindOfBase(t.returnType, ctx.resolve);
  if (!retKind || retKind.w > 32) return null;

  // The atoms and their test values.
  const consts = new Map<string, Set<bigint>>();
  for (const k of traverseAST(t.body)) if (k.kind === NodeKind.IfStmt) collectAtoms((k as IfStmt).condition, hostA, consts);
  const hostKeys = new Set(consts.keys());
  for (const k of traverseAST(ifs)) if (k.kind === NodeKind.IfStmt) collectAtoms((k as IfStmt).condition, siteA, consts);
  if (![...consts.keys()].some(k => hostKeys.has(k))) return null;
  if (prev && siteAlias.size > 0 && !hostKeys.has(prev.key)) return null;
  const keys = [...consts.keys()];
  const domains = keys.map(k => testValues(consts.get(k)!));
  const vals: Map<string, bigint>[] = [];
  const rec = (i: number, cur: Map<string, bigint>): void => {
    if (vals.length > 20000) no('too many valuations');
    if (i === keys.length) { vals.push(new Map(cur)); return; }
    for (const v of domains[i]) { cur.set(keys[i], v); rec(i + 1, cur); }
  };
  rec(0, new Map());

  // The site is the if alone, or the if and every statement after it to the end of the block.
  const aliasName = prev && siteAlias.size > 0 ? prev.name : null;
  const attempts: { end: number; form: 'store' | 'tail' }[] = [{ end: j, form: 'store' }, { end: j, form: 'tail' }];
  if (st.length - 1 > j) attempts.push({ end: st.length - 1, form: 'tail' });
  let last: Reject | null = null;
  for (const at of attempts) {
    try {
      const stmts = st.slice(j, at.end + 1);
      if (aliasName && stmts.some(s => storesTo(s, aliasName) > 0)) no('the site writes the type temporary');
      const runs = vals.map(v => ({ v, host: runHost(t, hostA, v), site: runSite(stmts, siteA, v) }));
      const f = at.form === 'store' ? storeForm(t, runs, ctx, arg) : tailForm(t, runs, ctx, arg, block, at.end, isFnBody);
      if (!f) continue;
      if (aliasName && aliasName === f.temp) no('the call result reuses the type temporary');
      if (argRootName && f.lvalueRoots.has(argRootName)) no('the store writes the argument');
      if (aliasName && f.lvalueRoots.has(aliasName)) no('the store writes the type temporary');
      const start = aliasName ? j - 1 : j;
      const span = st.slice(start, at.end + 1);
      return {
        block, start, end: at.end, replacement: f.replacement,
        aliasStmt: aliasName ? st[j - 1] : null, aliasName,
        temp: f.temp, tempReads: f.temp ? span.reduce((n, s) => n + readsOf(s, f.temp!), 0) : 0,
        aliasReads: aliasName ? span.reduce((n, s) => n + readsOf(s, aliasName), 0) : 0,
        call: t.call, arg: argRootName ?? '', form: at.form,
      };
    } catch (e) {
      if (!(e instanceof Reject)) throw e;
      last = e;
    }
  }
  if (last) throw last;
  return null;
}

interface FormResult { replacement: Statement[]; temp: string | null; lvalueRoots: Set<string> }

function rootsOf(e: Expression): Set<string> {
  const out = new Set<string>();
  for (const k of traverseAST(e)) if (k.kind === NodeKind.Identifier) out.add((k as Identifier).name);
  return out;
}

function twinCall(t: HostTwin, arg: Expression): Expression {
  return Expr.call(Expr.qualifiedId(t.call.split('::')), [cloneNode(arg)]);
}

/** The value conversion a host leaf goes through into L: the return type, then L. */
function leafMatches(siteVal: Stored, host: Leaf, t: HostTwin, ret: IntKind, toL: IntKind | null, ctx: Ctx, arg: Expression): boolean {
  const h = stripCasts(host.expr);
  const hc = constValue(h.base, ctx.enums);
  if (hc !== null || siteVal.constant !== null) {
    if (hc === null || siteVal.constant === null) return false;
    let hv = hc;
    for (const c of h.casts) { const k = intKindOfType(c, ctx.resolve); if (!k) return false; hv = convertConst(hv, k); }
    hv = convertConst(hv, ret);
    let sv = siteVal.constant;
    if (toL) { hv = convertConst(hv, toL); sv = convertConst(sv, toL); }
    return hv === sv;
  }
  if (h.casts.length > 0) return false;
  if (!sameUnder(siteVal.base, h.base, t.param, arg)) return false;
  // The twin: the leaf's own type, the return type, then L. The site: as computed (L appended by the caller).
  const bk = kindOf(siteVal.base, ctx);
  if (!bk) return false;
  let tw: Conv | null = convTo(convStart(bk), ret);
  if (toL) tw = convTo(tw, toL);
  return sameConv(siteVal.conv, tw);
}

function storeForm(t: HostTwin, runs: { v: Map<string, bigint>; host: Leaf; site: Run }[], ctx: Ctx, arg: Expression): FormResult | null {
  const ret = intKindOfBase(t.returnType, ctx.resolve)!;
  let L: Expression | null = null;
  let temp: string | null = null;
  for (const r of runs) {
    if (r.site.returned) no('the if returns');
    const ef = r.site.effects;
    if (ef.length < 1 || ef.length > 2) no(`${ef.length} statements on a path`);
    const asg = ef.map(s => {
      const e = unparen((s as ExprStmt).expression);
      if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') no('a statement other than a store');
      return e as AssignExpr;
    });
    const last = asg[asg.length - 1];
    if (L === null) L = last.left;
    else if (!sameExpr(L, last.left)) no('the arms store to different places');
    const toL = kindOf(last.left, ctx);
    let stored: Stored;
    if (asg.length === 2) {
      const tn = idName(asg[0].left);
      if (tn === null || !ctx.locals.has(tn) || ctx.addressed.has(tn)) no('the copied temporary is not a plain local');
      if (temp !== null && temp !== tn) no('two temporaries');
      temp = tn;
      const inner = stripCasts(last.right);
      if (idName(inner.base) !== tn) no('the store does not copy the temporary');
      const tk = kindOf(asg[0].left, ctx);
      if (!tk) no('the temporary is not an integer');
      const extra: IntKind[] = [tk!];
      for (const c of inner.casts) { const k = intKindOfType(c, ctx.resolve); if (!k) no('cast on the copy'); extra.push(k!); }
      if (toL) extra.push(toL);
      stored = storedValue(asg[0].right, extra, ctx);
    } else {
      stored = storedValue(last.right, toL ? [toL] : [], ctx);
    }
    // Without L's type the conversions must agree before it.
    if (!leafMatches(stored, r.host, t, ret, toL, ctx, arg)) no('a path stores another value than the host returns');
  }
  if (!L) return null;
  // Printed as one store on every path, the site is the expansion VC8 compiled, and the
  // twin's own temporaries colour it otherwise: on the v2124 snapshot, 250 such sites gave
  // one MATCH (00463ee0) and lost three (0046c7d0, 004adbc0, 005dbe50 - an argument push
  // scheduled elsewhere, a frame four bytes larger). Only a site the decompiler split
  // through a temporary is written as the call.
  if (!temp) no('the site is one store already');
  if (!safeTarget(L, ctx)) no('the store target is not a local or a path through one local pointer');
  if (temp && rootsOf(L).has(temp)) no('the store target names the temporary');
  return { replacement: [Stmt.expr(Expr.assign(cloneNode(L), twinCall(t, arg)))], temp, lvalueRoots: rootsOf(L) };
}

/**
 * The positions where two statements differ: exactly one subexpression, at the same place.
 * Returns that pair, or null when they are equal, or throws when they differ elsewhere.
 */
function oneDifference(a: ASTNode, b: ASTNode, out: { a: Expression; b: Expression }[]): void {
  if (sameExpr(a, b)) return;
  const ca = getChildren(a), cb = getChildren(b);
  const shallowSame = a.kind === b.kind && ca.length === cb.length && (() => {
    const ra = a as unknown as Record<string, unknown>, rb = b as unknown as Record<string, unknown>;
    for (const k of ['operator', 'isArrow', 'name', 'value']) {
      const va = ra[k], vb = rb[k];
      if ((typeof va !== 'object' || va === null) && va !== vb) return false;
    }
    return true;
  })();
  if (!shallowSame || ca.length === 0 || a.kind === NodeKind.CStyleCastExpr) { out.push({ a: a as Expression, b: b as Expression }); return; }
  for (let i = 0; i < ca.length; i++) oneDifference(ca[i], cb[i], out);
}

function tailForm(t: HostTwin, runs: { v: Map<string, bigint>; host: Leaf; site: Run }[], ctx: Ctx, arg: Expression,
  block: CompoundStmt, end: number, isFnBody: boolean): FormResult | null {
  const ret = intKindOfBase(t.returnType, ctx.resolve)!;
  // The reference path: the one that copies the call into a temporary first.
  let ref: { run: Run; temp: string; tempKind: IntKind } | null = null;
  for (const r of runs) {
    const ef = r.site.effects;
    if (ef.length === 0) continue;
    const e = unparen((ef[0] as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') continue;
    const tn = idName((e as AssignExpr).left);
    const right = unparen((e as AssignExpr).right);
    if (tn !== null && right.kind === NodeKind.CallExpr && sameUnder(right, stripCasts(r.host.expr).base, t.param, arg)) {
      if (!ctx.locals.has(tn) || ctx.addressed.has(tn)) no('the call result is not held in a plain local');
      const tk = kindOf((e as AssignExpr).left, ctx);
      if (!tk) no('the call result temporary is not an integer');
      ref = { run: r.site, temp: tn, tempKind: tk! };
      break;
    }
  }
  if (!ref) no('no path holds the call in a temporary');
  const tail = ref!.run.effects.slice(1);
  const refRet = ref!.run.returned;
  if (tail.length === 0) no('nothing reads the value');
  // The tail must not write the temporary or the argument, nor call before the value is read.
  for (const s of tail) if (storesTo(s, ref!.temp) > 0) no('the tail writes the temporary');
  for (const r of runs) {
    const ef = r.site.effects;
    const ret0 = r.site.returned;
    // Every path ends the same way: the same return, or running off the end of the function.
    if (!!ret0 !== !!refRet) {
      // The fall-through path ends at the end of the function body; the others `return;` there.
      const voidEnd = (x: ReturnStmt | null) => x === null ? isFnBody && end === block.statements.length - 1 : x.value === null;
      if (!(voidEnd(ret0) && voidEnd(refRet))) no('the paths end differently');
    } else if (ret0 && refRet && !(ret0.value === null && refRet.value === null) && !(ret0.value && refRet.value && sameExpr(ret0.value, refRet.value))) {
      no('the paths return different values');
    }
    let mine: Statement[];
    let leafExpr: Expression | null = null;
    if (r.site === ref!.run || (ef.length === tail.length + 1 && sameExpr(ef[0], ref!.run.effects[0]))) {
      mine = ef.slice(1);
      // The same statements as the reference.
      if (mine.length !== tail.length || !mine.every((s, i) => sameExpr(s, tail[i]))) no('paths through the call differ');
      // The temporary holds the host's value there.
      const e0 = unparen((ef[0] as ExprStmt).expression) as AssignExpr;
      if (!sameUnder(unparen(e0.right), stripCasts(r.host.expr).base, t.param, arg) || stripCasts(r.host.expr).casts.length) no('a path calls where the host does not');
      continue;
    }
    mine = ef;
    if (mine.length !== tail.length) no('the paths run different statements');
    const diffs: { a: Expression; b: Expression }[] = [];
    for (let i = 0; i < tail.length; i++) oneDifference(tail[i], mine[i], diffs);
    if (diffs.length !== 1) no(`${diffs.length} differences between the paths`);
    const d = diffs[0];
    // The reference holds conv(temp), this path conv'(leaf).
    const refSide = stripCasts(d.a);
    if (idName(refSide.base) !== ref!.temp) no('the reference path differs elsewhere than the temporary');
    leafExpr = d.b;
    const extraRef: IntKind[] = [];
    for (const c of refSide.casts) { const k = intKindOfType(c, ctx.resolve); if (!k) no('cast'); extraRef.push(k!); }
    const stored = storedValue(leafExpr, [], ctx);
    const h = stripCasts(r.host.expr);
    const hc = constValue(h.base, ctx.enums);
    if (hc !== null || stored.constant !== null) {
      if (hc === null || stored.constant === null) no('a constant against a read');
      // After the rewrite this path holds the reference expression with the temporary set
      // to the host's value: the same integer, whatever the context converts it to.
      let hv = hc!;
      for (const c of h.casts) { const k = intKindOfType(c, ctx.resolve); if (!k) no('cast on the host constant'); hv = convertConst(hv, k!); }
      hv = convertConst(convertConst(hv, ret), ref!.tempKind);
      for (const k of extraRef) hv = convertConst(hv, k);
      if (hv !== stored.constant) no('a constant arm holds another value');
      continue;
    }
    if (h.casts.length) no('host leaf with a cast');
    if (!sameUnder(stored.base, h.base, t.param, arg)) no('a path reads something else than the host returns');
    const bk = kindOf(stored.base, ctx);
    if (!bk) no('the read has no integer type');
    let tw: Conv | null = convTo(convTo(convStart(bk!), ret), ref!.tempKind);
    for (const k of extraRef) tw = convTo(tw, k);
    if (!sameConv(stored.conv, tw)) no('the conversions differ');
  }
  const replacement: Statement[] = [Stmt.expr(Expr.assign(Expr.identifier(ref!.temp), twinCall(t, arg))), ...tail.map(s => cloneNode(s))];
  // A `return;` the function's own end makes anyway is left off.
  const atFnEnd = isFnBody && end === block.statements.length - 1;
  if (refRet && !(atFnEnd && (refRet as ReturnStmt).value === null)) replacement.push(cloneNode(refRet));
  return { replacement, temp: ref!.temp, lvalueRoots: new Set() };
}

function rewriteFunction(fn: FunctionDecl, options: HostTwinFoldOptions): FunctionDecl | undefined {
  const twins = options.twins ?? [];
  if (!fn.body || twins.length === 0) return undefined;
  const resolve: TypedefResolver = n => options.typedefTargets?.[n];
  const work = cloneNode(fn.body) as CompoundStmt;
  const locals = new Map<string, TypeNode>();
  const declCount = new Map<string, number>();
  const addressed = new Set<string>();
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) { locals.set(p.name.name, p.type); declCount.set(p.name.name, 1); }
  for (const k of traverseAST(work)) {
    if (k.kind === NodeKind.VariableDecl) {
      const v = k as VariableDecl;
      declCount.set(v.name.name, (declCount.get(v.name.name) ?? 0) + 1);
      locals.set(v.name.name, v.type);
      if (v.type.kind === NodeKind.ArrayType) addressed.add(v.name.name);
    }
    if (k.kind === NodeKind.UnaryExpr && (k as UnaryExpr).operator === '&') {
      for (const n of traverseAST((k as UnaryExpr).operand)) if (n.kind === NodeKind.Identifier) addressed.add((n as Identifier).name);
    }
  }
  for (const [n, c] of declCount) if (c !== 1) locals.delete(n);
  // Quick reject: no callee of any host's call leaf is named in the function.
  const named = new Set<string>();
  for (const k of traverseAST(work)) if (k.kind === NodeKind.Identifier) named.add((k as Identifier).name);
  const shape = createExprShape(locals, {
    globalTypes: options.globalTypes ?? {}, enclosingVarTypes: options.enclosingVarTypes ?? {},
    structFields: options.structFields ?? {}, fieldTypes: options.fieldTypes ?? {},
    returnTypes: options.functionReturnTypes ?? {}, resolve,
  });
  const ctx: Ctx = { resolve, enums: options.enumValues ?? {}, shape, locals, addressed };
  const found: Found[] = [];
  const jumps = [...traverseAST(work)].some(k => k.kind === NodeKind.GotoStmt);
  for (const k of traverseAST(work)) {
    if (k.kind !== NodeKind.CompoundStmt) continue;
    const block = k as CompoundStmt;
    for (let j = 0; j < block.statements.length; j++) {
      if (block.statements[j].kind !== NodeKind.IfStmt) continue;
      if (found.some(f => f.block === block && j >= f.start && j <= f.end)) continue;
      for (const t of twins) {
        const leafNames = [...traverseAST(t.body)].filter(n => n.kind === NodeKind.CallExpr).map(c => calleeParts((c as CallExpr).callee)?.pop());
        if (!leafNames.some(n => n && named.has(n))) continue;
        try {
          const f = tryTwin(t, block, j, ctx, work, block === work && !jumps);
          if (f) { found.push(f); break; }
        } catch (e) {
          if (!(e instanceof Reject)) throw e;
          options.onReject?.({ call: t.call, why: e.message });
        }
      }
    }
  }
  if (found.length === 0) return undefined;
  // A temporary may go only where every read of it is one a found site accounts for.
  const accepted = found.filter(f => {
    if (f.temp) {
      const all = readsOf(work, f.temp);
      const mine = found.filter(g => g.temp === f.temp).reduce((n, g) => n + g.tempReads, 0);
      if (all !== mine) { options.onReject?.({ call: f.call, why: `temporary ${f.temp} is read elsewhere` }); return false; }
    }
    return true;
  });
  let changed = 0;
  // Apply from the back of each block so indices stay valid.
  const order = [...accepted].sort((a, b) => (a.block === b.block ? b.start - a.start : 0));
  const keepAlias = new Set<string>();
  for (const f of accepted) {
    if (!f.aliasName) continue;
    const all = readsOf(work, f.aliasName);
    const mine = accepted.filter(g => g.aliasName === f.aliasName).reduce((n, g) => n + g.aliasReads, 0);
    if (all !== mine) keepAlias.add(f.aliasName);
  }
  for (const f of order) {
    const st = f.block.statements;
    const repl = f.replacement;
    if (f.aliasStmt && f.aliasName && keepAlias.has(f.aliasName)) repl.unshift(f.aliasStmt);
    st.splice(f.start, f.end - f.start + 1, ...repl);
    changed++;
    options.onSite?.({ call: f.call, arg: f.arg, form: f.form });
  }
  // Declarations nothing names any more go.
  const gone = new Set<string>();
  for (const f of accepted) { if (f.temp) gone.add(f.temp); if (f.aliasName && !keepAlias.has(f.aliasName)) gone.add(f.aliasName); }
  for (const name of gone) {
    if (readsOf(work, name) !== 0 || storesTo(work, name) !== 0) continue;
    for (const k of traverseAST(work)) {
      if (k.kind !== NodeKind.CompoundStmt) continue;
      const s = (k as CompoundStmt).statements;
      for (let i = s.length - 1; i >= 0; i--) {
        const d = s[i];
        if (d.kind !== NodeKind.DeclStmt) continue;
        const ds = (d as DeclStmt).declarations;
        const keep = ds.filter(v => !(v.kind === NodeKind.VariableDecl && (v as VariableDecl).name.name === name && !(v as VariableDecl).initializer));
        if (keep.length === ds.length) continue;
        if (keep.length === 0) s.splice(i, 1); else (d as DeclStmt).declarations = keep;
      }
    }
  }
  if (!changed) return undefined;
  return updateNode(fn, { body: work } as Partial<FunctionDecl>);
}

function createHostTwinFoldTransformer(options: HostTwinFoldOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  });
}

export const hostTwinFoldPlugin: TransformPlugin = {
  id: 'host-twin-fold',
  name: 'Host Twin Fold',
  description: 'Writes a header inline the callers expanded in place as a call to its forced-inline twin, proven per valuation',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 989.95,
  tags: ['matching'],
  createTransformer: createHostTwinFoldTransformer,
};
