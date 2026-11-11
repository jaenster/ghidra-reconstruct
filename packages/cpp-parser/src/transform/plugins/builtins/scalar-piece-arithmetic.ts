/**
 * Byte pieces of a scalar local, written as arithmetic on the local.
 *
 * Ghidra prints a register's partial writes and reads as SUBPIECE members of the variable
 * the register holds: `x._2_2_ = v`, `CONCAT31(x._1_3_, b)`. subpiece-access lowers each to
 * a memory access through `(char *)&x + N`, which is exact, but taking the address forces
 * x into a stack slot where the original kept it in a register:
 *
 *     nPackedStatKey._0_2_ = pStatInfo->pStatInfo[nMid].wSubIndex;   // STATLIST_Binary-
 *     nPackedStatKey._2_2_ = pStatInfo->pStatInfo[nMid].wStatIndex;  // SearchStatInfoArray
 *     if (nPackedStatKey < nParam) ...                               // 00624c10
 *
 * VC8 then builds the value in [ebp-4] and reloads it; the original never touches the
 * stack. For a local x of a builtin integer type this pass writes the pieces on x itself:
 *
 *  - A run of consecutive piece stores that covers every byte of x exactly once, with
 *    values that read nothing x-dependent and have no effect, is one store of the value
 *    the bytes make: `x = (T)((W)(uint16_t)lo | (W)(uint16_t)hi << 16)`. All of x is
 *    written, so this holds whatever x held before. Constant pieces fold to one constant
 *    (`qwTestTarget._0_4_ = 0; qwTestTarget._4_4_ = 0;` is `qwTestTarget = 0`).
 *  - Any other piece store is a read-modify-write of x,
 *    `x = (T)((W)x & keep | ((W)(uintM_t)v << 8N))`, and a piece read is
 *    `(uintM_t)((UX)x >> 8N)` (24-bit pieces masked with 0xffffff, as d2_load24 reads
 *    them). Both read x as a whole, so they are made only where x is certainly
 *    initialised (a whole store to x, or its initialiser, precedes the use in the same
 *    block or an enclosing one with no label between them), and only for an x whose
 *    address is never taken, so nothing reaches its bytes except these expressions.
 *
 * Every rewrite is the little-endian meaning of the piece: the value stored is converted
 * to M bytes as the store through `(uintM_t *)` converts it (`d2_store24` takes uint32_t),
 * the bytes outside the piece keep their value, and the read zero-extends as
 * subpiece-access's `*(uintM_t *)` does. Anything else - a local of another type, a piece
 * that is incremented or has its address taken, a piece past the end of x - is left to
 * subpiece-access.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, DeclStmt, DoWhileStmt, Expression, ExprStmt, ForStmt,
  FunctionDecl, Identifier, IfStmt, LabelStmt, MemberExpr, ParameterDecl, ParenExpr, ReturnStmt,
  Statement, SwitchStmt, TypeNode, UnaryExpr, VariableDecl, WhileStmt, CaseStmt, DefaultStmt,
  CharLiteralExpr, IntegerLiteralExpr, CStyleCastExpr,
} from '../../../ast/nodes.js';
import { Expr, Type } from '../../../ast/factory.js';
import { findNodesByKind, getChildren, traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { isPure } from './pseudo-op-lower.js';
import { subpieceOf, stripThreeByteCast } from './subpiece-access.js';

export type ScalarPieceArithmeticOptions = PluginOptions;

/** Builtin integer spellings (Ghidra's and C's) and their sizes. */
const INTEGER_SIZES: Record<string, number> = {
  char: 1, 'signed char': 1, 'unsigned char': 1, uchar: 1, byte: 1, sbyte: 1, undefined1: 1,
  int8_t: 1, uint8_t: 1, BYTE: 1, CHAR: 1,
  short: 2, 'short int': 2, 'unsigned short': 2, 'unsigned short int': 2, ushort: 2, word: 2,
  undefined2: 2, int16_t: 2, uint16_t: 2, WORD: 2, SHORT: 2, USHORT: 2,
  int: 4, 'unsigned int': 4, unsigned: 4, uint: 4, long: 4, 'unsigned long': 4, ulong: 4,
  dword: 4, undefined4: 4, int32_t: 4, uint32_t: 4, DWORD: 4, BOOL: 4, LONG: 4, ULONG: 4,
  INT: 4, UINT: 4,
  longlong: 8, ulonglong: 8, 'long long': 8, 'unsigned long long': 8, undefined8: 8,
  int64_t: 8, uint64_t: 8, qword: 8, LONGLONG: 8, ULONGLONG: 8, __int64: 8,
};

const UNSIGNED: Record<number, string> = { 1: 'uint8_t', 2: 'uint16_t', 3: 'uint32_t', 4: 'uint32_t', 8: 'uint64_t' };

interface Local { name: string; size: number; type: TypeNode }

const unparen = (e: Expression): Expression => {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as ParenExpr).expression;
  return x;
};

/** The local a piece member is of, with its offset and width, or null. */
function pieceOfLocal(node: ASTNode, locals: Map<string, Local>): { local: Local; offset: number; size: number } | null {
  const p = subpieceOf(node);
  if (!p || p.member.isArrow) return null;
  const obj = unparen(p.member.object);
  if (obj.kind !== NodeKind.Identifier) return null;
  const local = locals.get((obj as Identifier).name);
  return local ? { local, offset: p.offset, size: p.size } : null;
}

const paren = (e: Expression): Expression => Expr.paren(e);
const castTo = (name: string, e: Expression): Expression => Expr.cast(Type.builtin(name), paren(e));
const castType = (t: TypeNode, e: Expression): Expression => Expr.cast(structuredClone(t), paren(e));

/** An unsigned literal of the work type (`u` / `ull`), in hex past 9. */
function literal(value: bigint, wide: boolean): IntegerLiteralExpr {
  const lit = Expr.intLiteral(value, value > 9n ? 16 : 10);
  const suffix = wide ? 'ull' : 'u';
  return { ...lit, suffix, raw: lit.raw + suffix } as IntegerLiteralExpr;
}

const mask = (bytes: number): bigint => (1n << BigInt(8 * bytes)) - 1n;

/** The integer value of a literal piece value (`0`, `-1`, `'\x01'`), or null. */
function literalValue(e: Expression): bigint | null {
  let x = unparen(e);
  let negative = false;
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
    negative = true;
    x = unparen((x as UnaryExpr).operand);
  }
  let v: bigint | null = null;
  if (x.kind === NodeKind.IntegerLiteral) v = (x as IntegerLiteralExpr).value;
  else if (x.kind === NodeKind.CharLiteral) v = BigInt((x as CharLiteralExpr).value);
  if (v === null) return null;
  return negative ? -v : v;
}

/**
 * The piece value as the work type, already truncated to its width: the conversion a
 * store through `(uintM_t *)` makes (`d2_store24` takes it as uint32_t and keeps three bytes).
 */
function pieceValue(value: Expression, size: number, work: string): Expression {
  const v = size === 3 ? stripThreeByteCast(value) : value;
  if (size === 3) {
    const v32 = castTo('uint32_t', v);
    return paren(Expr.binary(work === 'uint32_t' ? v32 : castTo(work, v32), '&', literal(mask(3), work === 'uint64_t')));
  }
  return castTo(work, isCastTo(v, size) ? unparen(v) : castTo(UNSIGNED[size], v));
}

/** Spellings of the unsigned type of each piece width, as Ghidra or C writes it. */
const UNSIGNED_SPELLINGS: Record<number, ReadonlySet<string>> = {
  1: new Set(['uint8_t', 'byte', 'uchar', 'unsigned char', 'BYTE']),
  2: new Set(['uint16_t', 'ushort', 'word', 'unsigned short', 'WORD']),
  4: new Set(['uint32_t', 'uint', 'unsigned int', 'dword', 'DWORD']),
};

/** `(uintM_t)e` already: the conversion the piece store makes is spelled. */
function isCastTo(e: Expression, size: number): boolean {
  const x = unparen(e);
  if (x.kind !== NodeKind.CStyleCastExpr) return false;
  const spelled = emit((x as CStyleCastExpr).type as never).replace(/\s+/g, ' ').trim();
  return UNSIGNED_SPELLINGS[size]?.has(spelled) ?? false;
}

const placed = (e: Expression, offset: number): Expression =>
  offset === 0 ? e : paren(Expr.binary(e, '<<', Expr.intLiteral(8 * offset)));

/** A piece read: the bytes [N, N+M) of x, zero-extended. */
function pieceRead(local: Local, offset: number, size: number): Expression {
  const whole = castTo(UNSIGNED[local.size], Expr.identifier(local.name));
  const shifted = offset === 0 ? whole : paren(Expr.binary(whole, '>>', Expr.intLiteral(8 * offset)));
  if (size === 3) return castTo('uint32_t', Expr.binary(shifted, '&', literal(mask(3), local.size === 8)));
  if (offset === 0 && size === local.size) return whole;
  return castTo(UNSIGNED[size], shifted);
}

/** `x = (T)(...)` storing `value` into the bytes [N, N+M) of x and keeping the others. */
function pieceStore(local: Local, offset: number, size: number, value: Expression): Expression {
  const wide = local.size === 8;
  const work = wide ? 'uint64_t' : 'uint32_t';
  const keep = mask(local.size) & ~(mask(size) << BigInt(8 * offset));
  const kept = paren(Expr.binary(castTo(work, Expr.identifier(local.name)), '&', literal(keep, wide)));
  const lit = literalValue(value);
  const bits = lit !== null ? (lit & mask(size)) << BigInt(8 * offset) : null;
  // Storing zero bytes only clears them.
  if (bits === 0n) return Expr.assign(Expr.identifier(local.name), castType(local.type, kept));
  const put = bits !== null ? literal(bits, wide) : placed(pieceValue(value, size, work), offset);
  return Expr.assign(Expr.identifier(local.name), castType(local.type, Expr.binary(kept, '|', put)));
}

function mentionsName(root: ASTNode, name: string): boolean {
  for (const n of traverseAST(root)) if (n.kind === NodeKind.Identifier && (n as Identifier).name === name) return true;
  return false;
}

/** `x._N_M_ = v;` as a statement: the piece and the value, or null. */
function pieceStoreStmt(s: Statement, locals: Map<string, Local>) {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const a = unparen((s as ExprStmt).expression);
  if (a.kind !== NodeKind.AssignExpr || (a as AssignExpr).operator !== '=') return null;
  const piece = pieceOfLocal(unparen((a as AssignExpr).left), locals);
  return piece ? { ...piece, value: (a as AssignExpr).right } : null;
}

/**
 * Runs of piece stores that cover all of one local, each replaced by one whole store.
 * Applied to every block of the body.
 */
function combineCoveringRuns(body: CompoundStmt, locals: Map<string, Local>): { body: CompoundStmt; changed: boolean } {
  let changed = false;
  const t = createTransformer({
    visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
      const st = block.statements;
      let out: Statement[] | null = null;
      for (let i = 0; i < st.length; i++) {
        const first = pieceStoreStmt(st[i], locals);
        if (!first) continue;
        const local = first.local;
        const covered = new Array<boolean>(local.size).fill(false);
        const run: NonNullable<ReturnType<typeof pieceStoreStmt>>[] = [];
        let j = i;
        let ok = true;
        for (; j < st.length; j++) {
          const p = pieceStoreStmt(st[j], locals);
          if (!p || p.local !== local) break;
          if (p.offset + p.size > local.size) { ok = false; break; }
          for (let b = p.offset; b < p.offset + p.size; b++) {
            if (covered[b]) ok = false;
            covered[b] = true;
          }
          if (!ok) break;
          // Each value is evaluated where the store was: nothing in it may change
          // meaning when the stores before it have not happened yet.
          if (!isPure(p.value) || mentionsName(p.value, local.name)) { ok = false; break; }
          run.push(p);
          if (covered.every(Boolean)) { j++; break; }
        }
        if (!ok || !covered.every(Boolean)) continue;
        const wide = local.size === 8;
        const work = wide ? 'uint64_t' : 'uint32_t';
        const literals = run.map(p => literalValue(p.value));
        let value: Expression;
        if (literals.every(v => v !== null)) {
          const v = run.reduce((acc, p, k) => acc | ((literals[k]! & mask(p.size)) << BigInt(8 * p.offset)), 0n);
          value = v === 0n ? Expr.intLiteral(0) : castType(local.type, literal(v, wide));
        } else {
          const terms = run.map((p, k) => literals[k] !== null
            ? literal((literals[k]! & mask(p.size)) << BigInt(8 * p.offset), wide)
            : placed(pieceValue(p.value, p.size, work), p.offset));
          value = castType(local.type, terms.reduce((acc, term) => Expr.binary(acc, '|', term)));
        }
        out ??= [...st];
        const firstStmt = st[i] as ExprStmt;
        out[i] = { ...firstStmt, expression: Expr.assign(Expr.identifier(local.name), value) } as ExprStmt;
        for (let k = i + 1; k < j; k++) out[k] = null as unknown as Statement;
        i = j - 1;
      }
      if (!out) return undefined;
      changed = true;
      return updateNode(block, { statements: out.filter(Boolean) });
    },
  });
  const next = t(body) as CompoundStmt;
  return { body: next, changed };
}

/** The local a statement stores whole (`x = e;` or `T x = e;`), or null. */
function wholeStoreOf(s: Statement): string[] {
  if (s.kind === NodeKind.ExprStmt) {
    const a = unparen((s as ExprStmt).expression);
    if (a.kind === NodeKind.AssignExpr && (a as AssignExpr).operator === '=') {
      const l = unparen((a as AssignExpr).left);
      if (l.kind === NodeKind.Identifier) return [(l as Identifier).name];
    }
    return [];
  }
  if (s.kind === NodeKind.DeclStmt) {
    return (s as DeclStmt).declarations
      .filter(d => d.kind === NodeKind.VariableDecl && (d as VariableDecl).initializer)
      .map(d => (d as VariableDecl).name.name);
  }
  return [];
}

/**
 * Piece reads and stores of the locals in `rmw`, rewritten on the local wherever it is
 * certainly initialised. `init` is the set initialised on entry to each statement.
 */
function rewriteInitialised(body: CompoundStmt, locals: Map<string, Local>, rmw: Set<string>): { body: CompoundStmt; changed: boolean } {
  let changed = false;

  const rewriteExpr = (e: Expression, init: ReadonlySet<string>): Expression => {
    // Bottom-up: a piece becomes a read first; the store above it maps it back.
    const readOf = new WeakMap<ASTNode, { local: Local; offset: number; size: number }>();
    const t = createTransformer({
      visitNode(node: ASTNode): ASTNode | undefined {
        if (node.kind === NodeKind.AssignExpr) {
          const a = node as AssignExpr;
          const piece = readOf.get(unparen(a.left));
          if (!piece) return undefined;
          let value: Expression = a.right;
          if (a.operator !== '=') {
            value = Expr.binary(pieceRead(piece.local, piece.offset, piece.size), a.operator.slice(0, -1) as never, paren(a.right));
          }
          changed = true;
          return { ...pieceStore(piece.local, piece.offset, piece.size, value), leadingTrivia: a.leadingTrivia, trailingTrivia: a.trailingTrivia } as AssignExpr;
        }
        const piece = pieceOfLocal(node, locals);
        if (!piece || !rmw.has(piece.local.name) || !init.has(piece.local.name)) return undefined;
        const read = { ...pieceRead(piece.local, piece.offset, piece.size), leadingTrivia: node.leadingTrivia, trailingTrivia: node.trailingTrivia } as Expression;
        readOf.set(read, piece);
        changed = true;
        return read;
      },
    });
    return t(e) as Expression;
  };
  const ex = (e: Expression | null | undefined, init: ReadonlySet<string>) => (e ? rewriteExpr(e, init) : e);

  const walk = (s: Statement, initIn: ReadonlySet<string>): { stmt: Statement; init: Set<string> } => {
    let init = new Set(initIn);
    switch (s.kind) {
      case NodeKind.CompoundStmt: {
        const block = s as CompoundStmt;
        const statements = block.statements.map(child => {
          const r = walk(child, init);
          init = r.init;
          return r.stmt;
        });
        return { stmt: { ...block, statements } as CompoundStmt, init };
      }
      case NodeKind.LabelStmt:
      case NodeKind.CaseStmt:
      case NodeKind.DefaultStmt: {
        // Reachable from elsewhere: nothing is known on entry.
        const inner = (s as LabelStmt | CaseStmt | DefaultStmt).statement;
        const r = walk(inner, new Set());
        return { stmt: { ...s, statement: r.stmt } as Statement, init: r.init };
      }
      case NodeKind.ExprStmt: {
        const e = s as ExprStmt;
        const stmt = { ...e, expression: rewriteExpr(e.expression, init) } as ExprStmt;
        for (const n of wholeStoreOf(stmt)) init.add(n);
        return { stmt, init };
      }
      case NodeKind.DeclStmt: {
        const d = s as DeclStmt;
        const declarations = d.declarations.map(v => v.kind === NodeKind.VariableDecl && (v as VariableDecl).initializer
          && (v as VariableDecl).initializer!.kind !== NodeKind.InitListExpr
          ? { ...v, initializer: rewriteExpr((v as VariableDecl).initializer as Expression, init) } as VariableDecl
          : v);
        const stmt = { ...d, declarations } as DeclStmt;
        for (const n of wholeStoreOf(stmt)) init.add(n);
        return { stmt, init };
      }
      case NodeKind.ReturnStmt: {
        const r = s as ReturnStmt;
        return { stmt: { ...r, value: ex(r.value, init) ?? null } as ReturnStmt, init };
      }
      case NodeKind.IfStmt: {
        const f = s as IfStmt;
        if (f.init) return { stmt: s, init };
        const condition = rewriteExpr(f.condition, init);
        const thenBranch = walk(f.thenBranch, init).stmt;
        const elseBranch = f.elseBranch ? walk(f.elseBranch, init).stmt : null;
        return { stmt: { ...f, condition, thenBranch, elseBranch } as IfStmt, init };
      }
      case NodeKind.WhileStmt: {
        const w = s as WhileStmt;
        return { stmt: { ...w, condition: rewriteExpr(w.condition, init), body: walk(w.body, init).stmt } as WhileStmt, init };
      }
      case NodeKind.DoWhileStmt: {
        const w = s as DoWhileStmt;
        return { stmt: { ...w, body: walk(w.body, init).stmt, condition: rewriteExpr(w.condition, init) } as DoWhileStmt, init };
      }
      case NodeKind.ForStmt: {
        const f = s as ForStmt;
        if (f.init && f.init.kind !== NodeKind.ExprStmt && f.init.kind !== NodeKind.DeclStmt) return { stmt: s, init };
        const head = f.init ? walk(f.init, init) : { stmt: null, init };
        const inLoop = head.init;
        return {
          stmt: {
            ...f, init: head.stmt, condition: ex(f.condition, inLoop) ?? null,
            increment: ex(f.increment, inLoop) ?? null, body: walk(f.body, inLoop).stmt,
          } as ForStmt,
          init: inLoop,
        };
      }
      case NodeKind.SwitchStmt: {
        const w = s as SwitchStmt;
        if (w.init) return { stmt: s, init };
        return { stmt: { ...w, condition: rewriteExpr(w.condition, init), body: walk(w.body, init).stmt } as SwitchStmt, init };
      }
      default:
        // A statement this walk does not model: left as it is, and it may jump anywhere.
        return { stmt: s, init };
    }
  };
  const r = walk(body, new Set());
  return { body: r.stmt as CompoundStmt, changed };
}

/** The byte width of an integer cast's type, or undefined for any other cast. */
function castWidth(e: ASTNode): number | undefined {
  if (e.kind !== NodeKind.CStyleCastExpr) return undefined;
  const spelled = emit((e as CStyleCastExpr).type as never).replace(/\s+/g, ' ').trim();
  return spelled === 'bool' ? undefined : INTEGER_SIZES[spelled];
}

/**
 * Locals only the low piece of which anything reads, each with that piece's width M.
 * Ghidra prints a register the code writes through its low part, `MOV AX, ...`, or a
 * 32-bit value it then passes on as its low word, as `x._0_M_ = v` on a wider local:
 * every store is a whole store or the low piece, every read keeps at most the low M
 * bytes (an integer cast to M bytes or fewer, or a low piece). The bytes above M are
 * then never read, so a whole store holds what every read sees.
 */
function lowPieceLocals(body: CompoundStmt, locals: Map<string, Local>, unfit: ReadonlySet<string>): Map<string, number> {
  const width = new Map<string, number>();
  const bad = new Set<string>(unfit);
  const visit = (n: ASTNode, parent: ASTNode | undefined): void => {
    const piece = pieceOfLocal(n, locals);
    if (piece) {
      const name = piece.local.name;
      const stored = parent?.kind === NodeKind.AssignExpr && unparen((parent as AssignExpr).left) === n;
      if (piece.offset !== 0 || piece.size >= piece.local.size || piece.size === 3) bad.add(name);
      else if (stored) {
        if ((parent as AssignExpr).operator !== '=') bad.add(name);
        else if (width.has(name) && width.get(name) !== piece.size) bad.add(name);
        else width.set(name, piece.size);
      }
      return;
    }
    if (n.kind === NodeKind.Identifier && locals.has((n as Identifier).name)) {
      const name = (n as Identifier).name;
      if (parent?.kind === NodeKind.MemberExpr) return; // the piece itself, handled above
      if (parent?.kind === NodeKind.AssignExpr && unparen((parent as AssignExpr).left) === n) {
        if ((parent as AssignExpr).operator !== '=') bad.add(name);
        return;
      }
      if (parent?.kind === NodeKind.VariableDecl) return;
      readers.push({ name, parent });
      return;
    }
    for (const c of getChildren(n)) {
      // A read through parentheses is judged by what holds the parentheses.
      visit(c, n.kind === NodeKind.ParenExpr ? parent : n);
    }
  };
  const readers: Array<{ name: string; parent: ASTNode | undefined }> = [];
  visit(body, undefined);
  const out = new Map<string, number>();
  for (const [name, m] of width) {
    if (bad.has(name)) continue;
    const reads = readers.filter(r => r.name === name);
    if (reads.some(r => { const w = r.parent ? castWidth(r.parent) : undefined; return w === undefined || w > m; })) continue;
    // Low-piece reads of x keep no more than M bytes either.
    let wide = false;
    for (const n of traverseAST(body)) {
      const p = pieceOfLocal(n, locals);
      if (p && p.local.name === name && p.size > m) wide = true;
    }
    if (!wide) out.set(name, m);
  }
  return out;
}

/** The value of `x._0_M_ = v` as a whole store: v without its cast to M bytes. */
function lowValue(v: Expression, m: number): Expression {
  const x = unparen(v);
  if (castWidth(x) === m && isCastTo(x, m)) return (x as CStyleCastExpr).expression;
  return v;
}

/** Whether v reads x's low piece back unchanged: `(uintM)x`, `x._0_M_`. */
function readsBackLow(v: Expression, name: string, m: number, locals: Map<string, Local>): boolean {
  const x = unparen(v);
  const p = pieceOfLocal(x, locals);
  if (p) return p.local.name === name && p.offset === 0 && p.size === m;
  const w = castWidth(x);
  if (w === undefined || w !== m) return false;
  const inner = unparen((x as CStyleCastExpr).expression);
  return inner.kind === NodeKind.Identifier && (inner as Identifier).name === name;
}

/**
 * Each low-piece store of a local `lowPieceLocals` found, as a whole store: `x._0_M_ = v`
 * becomes `x = v`, its cast to M bytes dropped (the low M bytes stored are the same, the
 * bytes above them are never read), and `x._0_M_ = (uintM)x`, which stores what is
 * there, goes. VC8 compiles the whole store as the original's full-register MOV (CheckIf-
 * CoordsAreInRange's coordinates in SCMD_0x3E_QuestItemPickup 0054bf60, `MOV EBX,[ECX+0xc]`
 * and `XOR EBX,EBX`), where the piece store through `&x` keeps x in memory.
 */
function wholeLowStores(body: CompoundStmt, locals: Map<string, Local>, low: Map<string, number>): { body: CompoundStmt; changed: boolean } {
  let changed = false;
  const t = createTransformer({
    visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
      let touched = false;
      const out: Statement[] = [];
      for (const st of block.statements) {
        const p = pieceStoreStmt(st, locals);
        const m = p ? low.get(p.local.name) : undefined;
        if (!p || m === undefined) { out.push(st); continue; }
        touched = true;
        if (readsBackLow(p.value, p.local.name, m, locals)) continue;
        const e = st as ExprStmt;
        out.push({ ...e, expression: Expr.assign(Expr.identifier(p.local.name), lowValue(p.value, m)) } as ExprStmt);
      }
      if (!touched) return undefined;
      changed = true;
      return updateNode(block, { statements: out });
    },
  });
  return { body: t(body) as CompoundStmt, changed };
}

function createScalarPieceArithmeticTransformer(): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const body0 = fn.body as CompoundStmt;
      const params = new Set(fn.parameters.map(p => (p as ParameterDecl).name?.name).filter((n): n is string => !!n));
      const declared = new Map<string, VariableDecl[]>();
      for (const d of findNodesByKind(body0, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        declared.set(v.name.name, [...(declared.get(v.name.name) ?? []), v]);
      }
      const locals = new Map<string, Local>();
      for (const [name, decls] of declared) {
        if (decls.length !== 1 || params.has(name)) continue;
        const v = decls[0];
        if (v.specifiers.length > 0) continue;
        const size = INTEGER_SIZES[emit(v.type as never).replace(/\s+/g, ' ').trim()];
        if (size) locals.set(name, { name, size, type: v.type });
      }
      if (locals.size === 0) return undefined;

      // Which locals have pieces at all, and which are fit for read-modify-write: every
      // piece inside x and only read or stored, and x's address never taken.
      const withPieces = new Set<string>();
      const unfit = new Set<string>();
      for (const n of traverseAST(body0)) {
        const piece = pieceOfLocal(n, locals);
        if (piece) {
          withPieces.add(piece.local.name);
          if (piece.offset + piece.size > piece.local.size || ![1, 2, 3, 4].includes(piece.size)
            || (piece.size === 3 && piece.local.size < 4)) unfit.add(piece.local.name);
          continue;
        }
        if (n.kind === NodeKind.UnaryExpr || n.kind === NodeKind.PostfixExpr) {
          const u = n as UnaryExpr;
          if (n.kind === NodeKind.UnaryExpr && !['&', '++', '--'].includes(u.operator)) continue;
          const o = unparen(u.operand);
          if (o.kind === NodeKind.Identifier && locals.has((o as Identifier).name)) unfit.add((o as Identifier).name);
          const p = pieceOfLocal(o, locals);
          if (p) unfit.add(p.local.name);
        }
      }
      if (withPieces.size === 0) return undefined;
      for (const name of [...locals.keys()]) if (!withPieces.has(name)) locals.delete(name);

      const low = lowPieceLocals(body0, locals, unfit);
      const lowered = low.size > 0 ? wholeLowStores(body0, locals, low) : { body: body0, changed: false };
      for (const name of low.keys()) locals.delete(name);
      const combined = combineCoveringRuns(lowered.body, locals);
      const rmw = new Set([...locals.keys()].filter(n => !unfit.has(n)));
      const rewritten = rmw.size > 0 ? rewriteInitialised(combined.body, locals, rmw) : { body: combined.body, changed: false };
      if (!lowered.changed && !combined.changed && !rewritten.changed) return undefined;
      return updateNode(fn, { body: rewritten.body } as Partial<FunctionDecl>);
    },
  });
}

export const scalarPieceArithmeticPlugin: TransformPlugin = {
  id: 'scalar-piece-arithmetic',
  name: 'Scalar Piece Arithmetic',
  description: "A scalar local's byte pieces (x._N_M_) as shift and mask arithmetic on the local instead of stores through its address",
  version: '1.0.0',
  defaultEnabled: true,
  // On Ghidra's own spelling, before type-normalize (15) renames the local's type,
  // pseudo-op-lower (20) lowers the CONCATs around the pieces, and subpiece-access (46)
  // turns the pieces that are left into memory accesses.
  priority: 14.5,
  tags: ['correctness', 'ghidra'],
  createTransformer: () => createScalarPieceArithmeticTransformer(),
};
