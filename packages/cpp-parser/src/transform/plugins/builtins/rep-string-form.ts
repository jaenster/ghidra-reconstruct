/**
 * Rep String Form Plugin
 *
 * VC8 compiles a constant-size fill of an array and a constant-size `memcpy` to one string
 * instruction, and the decompiler prints that instruction as its own pointer loop.
 * GAMEDATA_GetCenteredTextX @0044d390 (`xor eax, eax; mov ecx, 0x32; lea edi, [wszText];
 * rep stosd`):
 *
 *   printed                                         written
 *   pSourceStr = wszText;                           for (iClear = 0; iClear < 0x64; iClear = iClear + 1) {
 *   for (iClear = 0x32; iClear != 0; iClear = iClear + -1) {     wszText[iClear] = L'\0';
 *     pSourceStr[0] = L'\0';                        }
 *     pSourceStr[1] = L'\0';
 *     pSourceStr = pSourceStr + 2;
 *   }
 *
 * VC8 compiles the printed loop as a pointer loop and the written one as the `rep stosd`.
 * A `rep movsd` with a constant ECX is written `memcpy(dst, src, K * 4)`, which VC8 expands
 * to the same instruction.
 *
 * A loop is rewritten only when the instruction says what it is (reconstruct's
 * extract/string-ops.ts): a REP STOS or REP MOVS whose ECX is the loop's count, whose EAX is
 * 0 for a fill, whose unit is the bytes one iteration stores, and whose p-code the decompile
 * prints with the loop's counter and pointer(s). Every rewrite keeps the value:
 *  - a fill writes the same bytes: the pointer starts at the array (`p = a;` right before the
 *    loop), each iteration stores zeros over exactly `unit` bytes and advances by `unit`, and
 *    `K * unit` is a whole number of the array's elements that the array holds;
 *  - a copy moves `K * unit` bytes from the source to the destination as the loop does,
 *    with the store and both advances exactly `unit` bytes wide, and the two pointers start
 *    (right before the loop) in two different named objects, so they cannot overlap - an
 *    overlapping `rep movsd` (NET_SERVER_SentPacketLog_Clear 0040b0c0 copies an array onto
 *    itself one element up, smearing its first element through it) is not a memcpy;
 *  - the counter and the pointers are dead once the loop exits (no path from the exit reads
 *    them before a whole assignment), since the rewrite leaves them at other values. The
 *    fill's `p = a;` goes with the loop for the same reason.
 * Anything else - a nonzero fill, a store through a member, a pointer read after the loop
 * (a `movsw` tail that continues from it) - is left as printed.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CompoundStmt, CStyleCastExpr, CharLiteralExpr, Expression, ExprStmt, ForStmt,
  FunctionDecl, Identifier, IntegerLiteralExpr, PointerType, PostfixExpr, Statement, SubscriptExpr, TypeNode,
  UnaryExpr, VariableDecl, ArrayType, AnyNode,
} from '../../../ast/nodes.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import { buildFunctionFlow, type FunctionFlow } from '../../cfg/dataflow.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { localTypesOf } from './compare-form.js';

/** One REP STOS/MOVS of the function, as extract/string-ops.ts reads it. */
export interface RepStringOp {
  op: 'stos' | 'movs';
  /** Bytes per iteration. */
  unit: 1 | 2 | 4;
  /** The constant ECX the instruction starts from. */
  count: number;
  /** For STOS: the EAX it stores. */
  fill?: number;
  /** The variables the decompile prints on the instruction. */
  names: string[];
  /** The instruction's address, for provenance. */
  address?: string;
}

export interface RepStringFormOptions extends PluginOptions {
  ops?: RepStringOp[];
  /** Global name -> its extent in bytes. */
  globalSizes?: Record<string, number>;
  /** Global name -> the stride of one element, for globals Ghidra typed as arrays. */
  globalElementSizes?: Record<string, number>;
  /** Called once per function with what was rewritten. */
  onCensus?: (c: { fills: number; copies: number; untied: number }) => void;
}

const SIZE_1 = /^(char|signed char|unsigned char|byte|uchar|uint8_t|int8_t|BYTE|CHAR|UCHAR|undefined1|undefined|bool)$/;
const SIZE_2 = /^(WCHAR|wchar_t|short|ushort|unsigned short|uint16_t|int16_t|wchar16|WORD|SHORT|USHORT|undefined2)$/;
const SIZE_4 = /^(int|uint|unsigned|unsigned int|long|ulong|unsigned long|uint32_t|int32_t|DWORD|LONG|ULONG|UINT|INT|BOOL|undefined4|float)$/;

/** The size of a scalar type, from its spelling; null when not known here. */
export function scalarTypeSize(t: TypeNode): number | null {
  return typeSize(t);
}

function typeSize(t: TypeNode): number | null {
  if (t.kind === NodeKind.PointerType) return 4;
  const name = emit(t as unknown as AnyNode).replace(/\s+/g, ' ').trim().replace(/^const /, '');
  if (/\*$/.test(name)) return 4;
  if (SIZE_1.test(name)) return 1;
  if (SIZE_2.test(name)) return 2;
  if (SIZE_4.test(name)) return 4;
  return null;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as unknown as { expression: Expression }).expression;
  return e;
}

function identName(e: Expression | null | undefined): string | null {
  if (!e) return null;
  const x = unwrap(e);
  return x.kind === NodeKind.Identifier ? (x as Identifier).name : null;
}

function intValue(e: Expression | null | undefined): bigint | null {
  if (!e) return null;
  const x = unwrap(e);
  if (x.kind === NodeKind.IntegerLiteral) return (x as IntegerLiteralExpr).value;
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
    const o = unwrap((x as UnaryExpr).operand);
    if (o.kind === NodeKind.IntegerLiteral) return -(o as IntegerLiteralExpr).value;
  }
  return null;
}

/** 0, '\0', L'\0', nullptr, (T *)0x0. */
function isZero(e: Expression): boolean {
  const x = unwrap(e);
  if (x.kind === NodeKind.IntegerLiteral) return (x as IntegerLiteralExpr).value === 0n;
  if (x.kind === NodeKind.CharLiteral) return (x as CharLiteralExpr).value === 0;
  if (x.kind === NodeKind.NullptrLiteral) return true;
  if (x.kind === NodeKind.CStyleCastExpr) return isZero((x as CStyleCastExpr).expression);
  return false;
}

function exprOf(s: Statement): Expression | null {
  return s.kind === NodeKind.ExprStmt ? unwrap((s as ExprStmt).expression) : null;
}

/** `v = rhs` -> rhs. */
function assignTo(e: Expression | null, v: string): Expression | null {
  if (!e || e.kind !== NodeKind.AssignExpr) return null;
  const a = e as AssignExpr;
  return a.operator === '=' && identName(a.left) === v ? a.right : null;
}

/** How far `v` steps in one statement/expression: `v = v + n`, `v += n`, `v++`, `v = v - n`, `v -= n`, `v--`. */
function stepOf(e: Expression | null, v: string): bigint | null {
  if (!e) return null;
  const x = unwrap(e);
  if (x.kind === NodeKind.PostfixExpr || (x.kind === NodeKind.UnaryExpr && ['++', '--'].includes((x as UnaryExpr).operator))) {
    const op = (x as PostfixExpr | UnaryExpr).operator;
    const operand = (x as PostfixExpr | UnaryExpr).operand;
    if (identName(operand) !== v) return null;
    return op === '++' ? 1n : op === '--' ? -1n : null;
  }
  if (x.kind !== NodeKind.AssignExpr) return null;
  const a = x as AssignExpr;
  if (identName(a.left) !== v) return null;
  if (a.operator === '+=' || a.operator === '-=') {
    const n = intValue(a.right);
    return n === null ? null : a.operator === '+=' ? n : -n;
  }
  if (a.operator !== '=') return null;
  const r = unwrap(a.right);
  if (r.kind !== NodeKind.BinaryExpr) return null;
  const b = r as BinaryExpr;
  if (identName(b.left) !== v || (b.operator !== '+' && b.operator !== '-')) return null;
  const n = intValue(b.right);
  return n === null ? null : b.operator === '+' ? n : -n;
}

/** `for (c = K; c != 0; c = c + -1)` -> the counter and K. */
function countedLoop(f: ForStmt): { counter: string; count: bigint; raw: IntegerLiteralExpr } | null {
  if (!f.init) return null;
  const init = exprOf(f.init);
  if (!init || init.kind !== NodeKind.AssignExpr || (init as AssignExpr).operator !== '=') return null;
  const counter = identName((init as AssignExpr).left);
  const k = unwrap((init as AssignExpr).right);
  if (!counter || k.kind !== NodeKind.IntegerLiteral) return null;
  const cond = f.condition ? unwrap(f.condition) : null;
  if (!cond) return null;
  const testsCounter = identName(cond) === counter
    || (cond.kind === NodeKind.BinaryExpr && (cond as BinaryExpr).operator === '!='
      && identName((cond as BinaryExpr).left) === counter && intValue((cond as BinaryExpr).right) === 0n);
  if (!testsCounter || stepOf(f.increment, counter) !== -1n) return null;
  const raw = k as IntegerLiteralExpr;
  if (raw.value <= 0n) return null;
  return { counter, count: raw.value, raw };
}

/** A store's target through pointer `p`: byte offset and width, or null. */
function storeThrough(lhs: Expression, p: string, elem: number, sizeOfType: (t: TypeNode) => number | null): { off: number; width: number } | null {
  const x = unwrap(lhs);
  if (x.kind === NodeKind.SubscriptExpr) {
    const s = x as SubscriptExpr;
    const j = intValue(s.index);
    if (identName(s.array) !== p || j === null || j < 0n) return null;
    return { off: Number(j) * elem, width: elem };
  }
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') {
    const o = unwrap((x as UnaryExpr).operand);
    if (identName(o) === p) return { off: 0, width: elem };
    if (o.kind === NodeKind.CStyleCastExpr && identName((o as CStyleCastExpr).expression) === p) {
      const t = (o as CStyleCastExpr).type;
      if (t.kind !== NodeKind.PointerType) return null;
      const w = sizeOfType((t as PointerType).pointee);
      return w === null ? null : { off: 0, width: w };
    }
  }
  return null;
}

function statementsOf(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s];
}

/** `a` as a literal spelled in the base of `like`. */
function literalLike(like: IntegerLiteralExpr, value: bigint): IntegerLiteralExpr {
  return Expr.intLiteral(value, like.base === 16 ? 16 : 10);
}

/** Can `v` be read on a path out of the loop before it is wholly assigned? */
function liveAfter(flow: FunctionFlow, loop: ForStmt, body: Statement[], v: string): boolean {
  if (flow.isEscaped(v)) return true;
  const cond = flow.nodeOf(loop);
  if (cond === undefined) return true;
  const inside = new Set<number>();
  for (const s of body) { const n = flow.nodeOf(s); if (n !== undefined) inside.add(n); }
  const exits = flow.cfg.nodes[cond].succ.filter(n => !inside.has(n));
  if (exits.length !== 1) return true;
  const seen = new Set<number>();
  const work = [...exits];
  while (work.length) {
    const n = work.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    if (n === cond) return true;
    const node = flow.cfg.nodes[n];
    if (n === flow.cfg.external) return true;
    if (node.role === 'exit') continue;
    if (flow.reads(n).has(v)) return true;
    if (flow.definition(n, v)?.killing) continue;
    work.push(...node.succ);
  }
  return false;
}

interface Rewrite { from: number; to: number; replacement: Statement; kind: 'fill' | 'copy' }

export function createRepStringFormTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as RepStringFormOptions;
  const ops = o.ops ?? [];
  const globalSizes = o.globalSizes ?? {};
  const globalElementSizes = o.globalElementSizes ?? {};

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body || ops.length === 0) return undefined;
      const fnBody = node.body as CompoundStmt;
      const types = localTypesOf(node);
      const locals = new Set(types.keys());
      const pointee = (v: string): number | null => {
        const t = types.get(v);
        return t && t.kind === NodeKind.PointerType ? typeSize((t as PointerType).pointee) : null;
      };
      // Local arrays: element size and count.
      const arrays = new Map<string, { elem: number; count: number }>();
      for (const d of findNodesByKind(fnBody, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (v.type.kind !== NodeKind.ArrayType) continue;
        const at = v.type as ArrayType;
        const n = intValue(at.size);
        const e = at.elementType.kind === NodeKind.ArrayType ? null : typeSize(at.elementType);
        if (n !== null && n > 0n && e !== null) arrays.set(v.name.name, { elem: e, count: Number(n) });
      }
      const arrayOf = (name: string): { elem: number; count: number } | null => {
        const l = arrays.get(name);
        if (l) return l;
        if (types.has(name)) return null;
        const e = globalElementSizes[name], size = globalSizes[name];
        if (!e || !size || size % e !== 0 || ![1, 2, 4].includes(e)) return null;
        return { elem: e, count: size / e };
      };
      const tiedOp = (kind: 'stos' | 'movs', unit: number, count: bigint, vars: string[]) =>
        ops.find(op => op.op === kind && op.unit === unit && BigInt(op.count) === count
          && (kind === 'movs' || op.fill === 0) && vars.every(v => op.names.includes(v)));

      let flow: FunctionFlow | null = null;
      const flowOf = () => (flow ??= buildFunctionFlow(fnBody.statements, locals));
      let fills = 0, copies = 0, untied = 0;

      const rewriteList = (list: Statement[]): Statement[] | null => {
        const rewrites: Rewrite[] = [];
        for (let i = 0; i < list.length; i++) {
          const f = list[i];
          if (f.kind !== NodeKind.ForStmt) continue;
          const loop = countedLoop(f as ForStmt);
          if (!loop) continue;
          const body = statementsOf((f as ForStmt).body);
          const r = matchFill(list, i, f as ForStmt, loop, body) ?? matchCopy(list, f as ForStmt, i, loop, body);
          if (r === 'untied') { untied++; continue; }
          if (r) rewrites.push(r);
        }
        if (rewrites.length === 0) return null;
        const out: Statement[] = [];
        let i = 0;
        for (const r of rewrites) {
          while (i < r.from) out.push(list[i++]);
          out.push(r.replacement);
          if (r.kind === 'fill') fills++; else copies++;
          i = r.to + 1;
        }
        while (i < list.length) out.push(list[i++]);
        return out;
      };

      const matchFill = (
        list: Statement[], i: number, f: ForStmt, loop: NonNullable<ReturnType<typeof countedLoop>>, body: Statement[],
      ): Rewrite | 'untied' | null => {
        if (i === 0 || body.length < 2) return null;
        // The last statement advances the pointer; the others store zeros through it.
        const last = exprOf(body[body.length - 1]);
        let p: string | null = null;
        if (last?.kind === NodeKind.AssignExpr) p = identName((last as AssignExpr).left);
        else if (last?.kind === NodeKind.PostfixExpr) p = identName((last as PostfixExpr).operand);
        if (!p || p === loop.counter) return null;
        const step = stepOf(last, p);
        const elem = pointee(p);
        if (step === null || step <= 0n || elem === null) return null;
        const covered: Array<{ off: number; width: number }> = [];
        let value: Expression | null = null;
        for (const s of body.slice(0, -1)) {
          const e = exprOf(s);
          if (!e || e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
          const a = e as AssignExpr;
          if (!isZero(a.right)) return null;
          const t = storeThrough(a.left, p, elem, typeSize);
          if (!t) return null;
          covered.push(t);
          value ??= a.right;
        }
        const unit = Number(step) * elem;
        covered.sort((x, y) => x.off - y.off);
        let at = 0;
        for (const c of covered) { if (c.off !== at) return null; at += c.width; }
        if (at !== unit || ![1, 2, 4].includes(unit)) return null;
        // The pointer starts at an array right before the loop.
        const base = identName(assignTo(exprOf(list[i - 1]), p));
        if (!base) return null;
        const arr = arrayOf(base);
        if (!arr) return null;
        const bytes = loop.count * BigInt(unit);
        if (bytes % BigInt(arr.elem) !== 0n) return null;
        const n = bytes / BigInt(arr.elem);
        if (n > BigInt(arr.count)) return null;
        const op = tiedOp('stos', unit, loop.count, [loop.counter, p]);
        if (!op) return 'untied';
        const fl = flowOf();
        if (liveAfter(fl, f, body, p) || liveAfter(fl, f, body, loop.counter)) return null;
        const c = () => Expr.identifier(loop.counter);
        const v = value && unwrap(value).kind !== NodeKind.CStyleCastExpr && unwrap(value).kind !== NodeKind.NullptrLiteral
          ? cloneNode(unwrap(value)) : Expr.intLiteral(0);
        const store = Stmt.expr(Expr.assign(Expr.subscript(Expr.identifier(base), c()), v));
        const replacement = Stmt.for_(
          Stmt.expr(Expr.assign(c(), Expr.intLiteral(0))),
          Expr.binary(c(), '<', literalLike(loop.raw, n)),
          Expr.assign(c(), Expr.binary(c(), '+', Expr.intLiteral(1))),
          Stmt.compound([store]),
        );
        const withTrivia = {
          ...replacement, location: list[i - 1].location, leadingTrivia: list[i - 1].leadingTrivia ?? [], trailingTrivia: f.trailingTrivia ?? [],
          ghidraInfo: { ...(f.ghidraInfo ?? {}), sourceLoop: true, ...(op.address ? { originalAddress: `0x${op.address}` } : {}) },
        } as ForStmt;
        return { from: i - 1, to: i, replacement: withTrivia, kind: 'fill' };
      };

      // The object an address starts in: `g` of `(T *)(g + 1)`, `&s.a[2]`, `s.a`; null when it
      // goes through a pointer (`p->a`, `*p`) or is not a plain object.
      const objectRoot = (e: Expression): string | null => {
        let x = unwrap(e);
        for (;;) {
          if (x.kind === NodeKind.CStyleCastExpr) x = unwrap((x as CStyleCastExpr).expression);
          else if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '&') x = unwrap((x as UnaryExpr).operand);
          else if (x.kind === NodeKind.MemberExpr && !(x as unknown as { isArrow: boolean }).isArrow) x = unwrap((x as unknown as { object: Expression }).object);
          else if (x.kind === NodeKind.SubscriptExpr && intValue((x as SubscriptExpr).index) !== null) x = unwrap((x as SubscriptExpr).array);
          else if (x.kind === NodeKind.BinaryExpr && ['+', '-'].includes((x as BinaryExpr).operator) && intValue((x as BinaryExpr).right) !== null) x = unwrap((x as BinaryExpr).left);
          else break;
        }
        const name = identName(x);
        if (!name) return null;
        const t = types.get(name);
        // A local or global object, never a pointer that could point anywhere.
        if (t) return t.kind === NodeKind.PointerType ? null : name;
        return globalSizes[name] !== undefined || arrays.has(name) ? name : null;
      };

      const matchCopy = (
        list: Statement[],
        f: ForStmt, i: number, loop: NonNullable<ReturnType<typeof countedLoop>>, body: Statement[],
      ): Rewrite | 'untied' | null => {
        if (body.length !== 3) return null;
        const e = exprOf(body[0]);
        if (!e || e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
        const a = e as AssignExpr;
        const ptrOf = (x: Expression): string | null => {
          const u = unwrap(x);
          if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '*') {
            const inner = unwrap((u as UnaryExpr).operand);
            return identName(inner) ?? (inner.kind === NodeKind.CStyleCastExpr ? identName((inner as CStyleCastExpr).expression) : null);
          }
          if (u.kind === NodeKind.SubscriptExpr && intValue((u as SubscriptExpr).index) === 0n) return identName((u as SubscriptExpr).array);
          return null;
        };
        const d = ptrOf(a.left), s = ptrOf(a.right);
        if (!d || !s || d === s || d === loop.counter || s === loop.counter) return null;
        const de = pointee(d), se = pointee(s);
        if (de === null || se === null) return null;
        const wd = storeThrough(a.left, d, de, typeSize), ws = storeThrough(a.right, s, se, typeSize);
        if (!wd || !ws || wd.off !== 0 || ws.off !== 0 || wd.width !== ws.width) return null;
        const unit = wd.width;
        if (![1, 2, 4].includes(unit)) return null;
        const steps = new Map<string, bigint | null>();
        for (const st of body.slice(1)) {
          const x = exprOf(st);
          const v = x?.kind === NodeKind.AssignExpr ? identName((x as AssignExpr).left)
            : x?.kind === NodeKind.PostfixExpr ? identName((x as PostfixExpr).operand) : null;
          if (!v || steps.has(v)) return null;
          steps.set(v, stepOf(x, v));
        }
        if (steps.get(d) !== BigInt(unit / de) || steps.get(s) !== BigInt(unit / se) || unit % de !== 0 || unit % se !== 0) return null;
        // memcpy needs two separate objects: an overlapping rep movsd (`dst = a + 1; src = a`)
        // propagates the first element through the array, which memcpy does not promise.
        const inits = new Map<string, Expression>();
        for (const st of list.slice(Math.max(0, i - 2), i)) {
          const x = exprOf(st);
          if (x?.kind === NodeKind.AssignExpr && (x as AssignExpr).operator === '=') {
            const v = identName((x as AssignExpr).left);
            if (v === d || v === s) inits.set(v, (x as AssignExpr).right);
          }
        }
        const dRoot = inits.has(d) ? objectRoot(inits.get(d)!) : null;
        const sRoot = inits.has(s) ? objectRoot(inits.get(s)!) : null;
        // A parameter the function never reassigns outside the loop still holds what the
        // caller passed, which cannot point into this call's own frame.
        const params = new Set(node.parameters.map(pp => (pp as { name?: Identifier }).name?.name).filter(Boolean) as string[]);
        const inLoop = new Set<ASTNode>();
        for (const b of body) for (const k of [NodeKind.AssignExpr, NodeKind.PostfixExpr, NodeKind.UnaryExpr]) for (const x of findNodesByKind(b, k)) inLoop.add(x);
        const writesOutside = (v: string) =>
          findNodesByKind(fnBody, NodeKind.AssignExpr).some(x => !inLoop.has(x) && identName((x as AssignExpr).left) === v)
          || findNodesByKind(fnBody, NodeKind.PostfixExpr).some(x => !inLoop.has(x) && identName((x as PostfixExpr).operand) === v)
          || findNodesByKind(fnBody, NodeKind.UnaryExpr).some(x => !inLoop.has(x) && ['++', '--', '&'].includes((x as UnaryExpr).operator)
            && identName((x as UnaryExpr).operand) === v);
        const untouchedParam = (v: string) => params.has(v) && !inits.has(v) && !writesOutside(v);
        const frameObject = (r: string | null) => r !== null && types.has(r) && !params.has(r);
        const separate = (dRoot !== null && sRoot !== null && dRoot !== sRoot)
          || (frameObject(dRoot) && untouchedParam(s))
          || (frameObject(sRoot) && untouchedParam(d));
        if (!separate) return null;
        const op = tiedOp('movs', unit, loop.count, [loop.counter, d, s]);
        if (!op) return 'untied';
        const fl = flowOf();
        if ([d, s, loop.counter].some(v => liveAfter(fl, f, body, v))) return null;
        const call = Stmt.expr(Expr.call('memcpy', [
          Expr.identifier(d), Expr.identifier(s), literalLike(loop.raw, loop.count * BigInt(unit)),
        ]));
        const withTrivia = { ...call, location: f.location, leadingTrivia: f.leadingTrivia ?? [], trailingTrivia: f.trailingTrivia ?? [] } as ExprStmt;
        return { from: i, to: i, replacement: withTrivia, kind: 'copy' };
      };

      // On the original nodes: the dataflow knows statements by identity, and a transformer
      // walk hands the visitor copies.
      const replaced = new Map<object, Statement[]>();
      for (const c of findNodesByKind(fnBody, NodeKind.CompoundStmt)) {
        const next = rewriteList((c as CompoundStmt).statements);
        if (next) replaced.set(c, next);
      }
      if (replaced.size === 0) { o.onCensus?.({ fills, copies, untied }); return undefined; }
      const rebuild = (x: unknown): unknown => {
        if (Array.isArray(x)) {
          let changed = false;
          const out = x.map(e => { const r = rebuild(e); if (r !== e) changed = true; return r; });
          return changed ? out : x;
        }
        if (!x || typeof x !== 'object') return x;
        const rec = x as Record<string, unknown>;
        let copy: Record<string, unknown> | null = null;
        const list = replaced.get(x);
        if (list) copy = { ...rec, statements: list };
        const src = copy ?? rec;
        for (const [k, v] of Object.entries(src)) {
          if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || !v || typeof v !== 'object') continue;
          const r = rebuild(v);
          if (r !== v) { copy ??= { ...rec }; copy[k] = r; }
        }
        return copy ?? x;
      };
      const body = rebuild(fnBody) as CompoundStmt;
      o.onCensus?.({ fills, copies, untied });
      return updateNode(node, { body } as Partial<FunctionDecl>);
    },
  });
}

export const repStringFormPlugin: TransformPlugin = createPlugin(
  'rep-string-form',
  'Rep String Form',
  'A REP STOSD fill as the index loop VC8 compiles to it, a REP MOVSD copy as memcpy',
  (options?: PluginOptions) => createRepStringFormTransformer(options),
  {
    priority: 4, // with compare-form: on the loops as the decompiler printed them
    defaultEnabled: true,
    tags: ['fidelity'],
    version: '1.0.0',
  },
);
