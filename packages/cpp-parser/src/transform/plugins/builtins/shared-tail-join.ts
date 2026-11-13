/**
 * Shared Tail Join Plugin
 *
 * An arm that ends in the same statements as the code after it,
 *
 *     if (c) {                                    if (c) {
 *       A;                                          A;
 *       T;                                        } else {
 *       return R;                       ->          B;
 *     }                                           }
 *     B;                                          T;
 *     T;                                          return R;
 *     return R;
 *
 * was written once, after an if/else. VC8 /O2 tail-duplicates a short exit into each way
 * that reaches it (each arm gets its own `pop esi; ret`, and its own copy of a store or two
 * ahead of it), and the decompiler prints the two copies as two exits. Compiled as printed,
 * VC8 cross-jumps the identical tails back into one copy, so the printed shape compiles to
 * the opposite layout (GFX_FreeGfxInfoEntry 0046e610: `mov eax, 1` materialised per path
 * after the join; SOUNDHDR_FreeSoundBuffer 004823e0: the two member stores in each arm).
 *
 * `if (c) { A; T } B; T`, the if without an else, T the longest common run of statements
 * at the end of the then-arm and of its enclosing block, becomes `if (c) { A } else { B } T`
 * when
 *   - T ends in a `return`, or the block is the function body and T falls off its end (an
 *     arm's trailing bare `return;` then matches the end of the body); a bare `return;`
 *     both end in does not count as T;
 *   - A and B are not empty: `if (c) T; B; T` is a guard (the return-copy rules' shape), and
 *     dropping an arm's copy of the exit with nothing after the if lost every match it
 *     touched (SKILLS_GetTotalSkillLevel 00644aa0, SetupUpdateFlag 00624690);
 *   - B holds no return, goto, break or continue: a chain of exits after the if was written
 *     with early returns (Q02_SequenceFilter 005910f0, WndProc 004f9a80);
 *   - T is not only `return x;` for a local x, a value both ways leave in EAX already
 *     (CheckCollision_Vector 0064d800), and T's return is not one the function writes more
 *     than twice: those are written per exit and cross-jumped (the quest StatusFilters'
 *     `return true`, Q31_StatusFilter 00586ce0);
 *   - nothing in T is declared in A or B, and no label, `case` or `default` sits in A, B
 *     or T; the function has no goto.
 * Runs bottom-up, so an else-if chain of such arms folds from its last arm outwards.
 *
 * Arms left as one statement each that differ only in one value were one statement on a
 * select VC8 tail-duplicated with the rest of the exit, when that value is the
 * GUID-or-minus-one `!P ? -1 : P->f`: `L = -1;` / `L = P->f;` becomes `L = !P ? -1 : P->f;`,
 * and `g(.., -1, ..);` / `g(.., P->f, ..);` becomes `g(.., !P ? -1 : P->f, ..);`
 * (Objects_InitFn63_AncientStatue3 0058d150: `or eax, -1` and the GUID read into one
 * register, one store; ARENA_BroadcastScoreOnJoin 0053fb30). With nothing else in common
 * this needs the arm's bare `return;` at the end of the body. Selects between constants,
 * with a zero arm, or on a value not read through the tested pointer lost matches
 * (ReadByteShortOrDword 0045c300, DrawSellBtn 00494e40, ANIM_GetEventFrame 006634c0): the
 * original made a call or store per arm there. P, L, the callee and the other arguments
 * are pure. `!P ? -1 : u` is unsigned when u is, so it is merged only where the other arm
 * is a signed type of at most 32 bits, or into a destination of at most 32 bits.
 *
 * Value-preserving: when c holds, A runs and then T, as before; otherwise B runs and then
 * T. T names nothing A or B declare, so each copy read the same declarations. A select
 * evaluates c once, then only its arm's value; everything else it reads is pure, so the
 * order it is read in against c changes nothing, and the literal converts exactly.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CompoundStmt, ConditionalExpr, CStyleCastExpr, Expression, ExprStmt, FunctionDecl,
  Identifier, IfStmt, ParenExpr, ReturnStmt, Statement, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import { Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { isPure } from './pseudo-op-lower.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import { localTypesOf } from './compare-form.js';

const SIGNED32 = new Set(['int', 'signed int', 'int32_t', 'long', 'signed long', 'short', 'int16_t', 'char', 'signed char', 'int8_t', 'BOOL', 'INT', 'LONG', 'SHORT', 'CHAR']);
const UNSIGNED32 = new Set(['unsigned int', 'unsigned', 'uint32_t', 'DWORD', 'UINT', 'ULONG', 'unsigned long', 'unsigned short', 'uint16_t', 'WORD', 'USHORT', 'unsigned char', 'uint8_t', 'BYTE', 'UCHAR', 'bool']);


export interface SharedTailJoinOptions extends PluginOptions {
  /** Aggregate name -> member name -> member spelling (the types a negative literal arm needs). */
  structFields?: Record<string, Record<string, string>>;
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  onSite?: (e: { statements: number; line: number; withElse: boolean; select: boolean }) => void;
}

const text = (s: ASTNode) => emit(s as unknown as AnyNode).replace(/\s+/g, ' ').trim();

function bodyOf(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? [...(s as CompoundStmt).statements] : [s];
}

function isBareReturn(s: Statement | undefined): boolean {
  return !!s && s.kind === NodeKind.ReturnStmt && !(s as ReturnStmt).value;
}

function declared(list: Statement[]): Set<string> {
  const out = new Set<string>();
  for (const s of list) for (const n of traverseAST(s)) if (n.kind === NodeKind.VariableDecl) out.add((n as VariableDecl).name.name);
  return out;
}

function named(list: Statement[]): Set<string> {
  const out = new Set<string>();
  for (const s of list) for (const n of traverseAST(s)) if (n.kind === NodeKind.Identifier) out.add((n as Identifier).name);
  return out;
}

function holdsLabel(list: Statement[]): boolean {
  for (const s of list) for (const n of traverseAST(s)) {
    if (n.kind === NodeKind.LabelStmt || n.kind === NodeKind.CaseStmt || n.kind === NodeKind.DefaultStmt) return true;
  }
  return false;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** `c ? x : y` built from an arm's condition. */
function select(c: Expression, x: Expression, y: Expression): Expression {
  return { kind: NodeKind.ConditionalExpr, condition: cloneNode(c), thenExpr: cloneNode(x), elseExpr: cloneNode(y), leadingTrivia: [], trailingTrivia: [] } as unknown as ConditionalExpr;
}

/** An integer literal, `-K`, `nullptr` or `NULL` (under casts): converts to any arm's type exactly. */
function isLiteral(e: Expression): boolean {
  let u = unwrap(e);
  while (u.kind === NodeKind.CStyleCastExpr) u = unwrap((u as CStyleCastExpr).expression);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-') u = unwrap((u as UnaryExpr).operand);
  return u.kind === NodeKind.IntegerLiteral || u.kind === NodeKind.NullptrLiteral || (u.kind === NodeKind.Identifier && (u as Identifier).name === 'NULL');
}

/** The pointer a `!P` / `P == 0` condition tests, or null. */
function nullTested(c: Expression): string | null {
  const u = unwrap(c);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') return text(unwrap((u as UnaryExpr).operand));
  return null;
}

/** Whether e reads a member through P (`P->f`, `P->a.b`). */
function readsThrough(e: Expression, p: string | null): boolean {
  if (!p) return false;
  for (const n of traverseAST(e)) {
    if (n.kind === NodeKind.MemberExpr && (n as unknown as { isArrow: boolean }).isArrow
      && text(unwrap((n as unknown as { object: Expression }).object)) === p) return true;
  }
  return false;
}

function isNegative(e: Expression): boolean {
  let u = unwrap(e);
  while (u.kind === NodeKind.CStyleCastExpr) u = unwrap((u as CStyleCastExpr).expression);
  return u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-';
}

/** A scalar of at most 32 bits whose spelling is known: signed, or any. */
function intShape(shape: ExprShape, e: Expression, signedOnly: boolean): boolean {
  const t = shape(e);
  if (!t || t.stars) return false;
  return SIGNED32.has(t.base) || (!signedOnly && UNSIGNED32.has(t.base));
}

/**
 * `L = x;` / `L = y;` or `f(.., x, ..);` / `f(.., y, ..);`: the one statement with
 * `c ? x : y` in the place they differ, or null.
 */
function mergeArms(c: Expression, sa: Statement, sb: Statement, shape: ExprShape): Statement | null {
  if (sa.kind !== NodeKind.ExprStmt || sb.kind !== NodeKind.ExprStmt) return null;
  const ea = unwrap((sa as ExprStmt).expression);
  const eb = unwrap((sb as ExprStmt).expression);
  // A literal arm converts to the other arm's type exactly, unless it is negative and the
  // other arm unsigned: then `c ? -1 : u` is unsigned, which only a destination of at most
  // 32 bits reads back as -1.
  const pick = (x: Expression, y: Expression, dest: Expression | null): Expression | null => {
    if (text(x) === text(y)) return null;
    const lit = isLiteral(x) ? x : isLiteral(y) ? y : null;
    if (!lit || !isNegative(lit)) return null;
    const other = lit === x ? y : x;
    if (!readsThrough(other, nullTested(c))) return null;
    if (isNegative(lit) && !isLiteral(other) && !intShape(shape, other, true) && !(dest && intShape(shape, dest, false))) return null;
    return select(c, x, y);
  };
  if (ea.kind === NodeKind.AssignExpr && eb.kind === NodeKind.AssignExpr) {
    const a = ea as AssignExpr, b = eb as AssignExpr;
    if (a.operator !== '=' || b.operator !== '=' || text(a.left) !== text(b.left) || !isPure(a.left)) return null;
    const v = pick(a.right, b.right, a.left);
    return v ? { ...sa, expression: { ...a, right: v } } as ExprStmt : null;
  }
  if (ea.kind === NodeKind.CallExpr && eb.kind === NodeKind.CallExpr) {
    const a = ea as CallExpr, b = eb as CallExpr;
    if (text(a.callee) !== text(b.callee) || a.arguments.length !== b.arguments.length || !isPure(a.callee)) return null;
    const diff = a.arguments.map((x, i) => text(x) !== text(b.arguments[i]));
    if (diff.filter(Boolean).length !== 1) return null;
    const i = diff.indexOf(true);
    if (!a.arguments.every((x, j) => j === i || isPure(x))) return null;
    const v = pick(a.arguments[i], b.arguments[i], null);
    if (!v) return null;
    const args = a.arguments.map((x, j) => (j === i ? v : x));
    return { ...sa, expression: { ...a, arguments: args } } as ExprStmt;
  }
  return null;
}

/** `return x;` with x a local or parameter of the function. */
function returnsLocal(s: Statement, locals: ReadonlySet<string>): boolean {
  if (s.kind !== NodeKind.ReturnStmt || !(s as ReturnStmt).value) return false;
  const v = unwrap((s as ReturnStmt).value as Expression);
  return v.kind === NodeKind.Identifier && locals.has((v as Identifier).name);
}

/** Joins in one statement list; `atEnd`: the list is the function body. */
function joinList(list: Statement[], atEnd: boolean, options: SharedTailJoinOptions, shape: ExprShape, fnLocals: ReadonlySet<string>, returnCounts: ReadonlyMap<string, number>): Statement[] | null {
  let changed = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (s.kind !== NodeKind.IfStmt) continue;
    const ifs = s as IfStmt;
    if (ifs.elseBranch || ifs.init) continue;
    let arm = bodyOf(ifs.thenBranch);
    const rest = list.slice(i + 1);
    if (!rest.length) continue;
    const last = rest[rest.length - 1];
    // The way out: a return ending both, or the end of the function body.
    const restReturns = last.kind === NodeKind.ReturnStmt;
    if (!restReturns) {
      if (!atEnd || !isBareReturn(arm[arm.length - 1])) continue;
      arm = arm.slice(0, -1);
    } else if (isBareReturn(last) && !isBareReturn(arm[arm.length - 1])) {
      continue;
    }
    let k = 0;
    while (k < arm.length && k < rest.length && text(arm[arm.length - 1 - k]) === text(rest[rest.length - 1 - k])) k++;
    // With nothing in common the arm must have ended in the bare return stripped above.
    if (!k && restReturns) continue;
    // A bare `return;` both end in is no tail of its own: what precedes it must be shared.
    const shared = restReturns && isBareReturn(last) ? k - 1 : k;
    const a = arm.slice(0, arm.length - k);
    const b = rest.slice(0, rest.length - k);
    const t = rest.slice(rest.length - k);
    if (!a.length || !b.length) continue;
    // B runs straight into T: an exit inside it is a guard chain the source wrote with early
    // returns (Q02_SequenceFilter 005910f0, WndProc 004f9a80 lost their matches joined).
    if (b.some(x => [...traverseAST(x)].some(n => n.kind === NodeKind.ReturnStmt || n.kind === NodeKind.GotoStmt
      || n.kind === NodeKind.BreakStmt || n.kind === NodeKind.ContinueStmt))) continue;
    // A tail that is only `return local;` hands back a register both ways already
    // (CheckCollision_Vector 0064d800 lost its match joined).
    if (shared === 1 && t.length === 1 && returnsLocal(t[0], fnLocals)) continue;
    if (holdsLabel(a) || holdsLabel(b) || holdsLabel(t)) continue;
    const tNames = named(t);
    if ([...declared(a), ...declared(b)].some(n => tNames.has(n))) continue;
    // Arms that are one statement differing only in a value: one statement on `c ? x : y`.
    const merged = a.length === 1 && b.length === 1 && isPure(ifs.condition) ? mergeArms(ifs.condition, a[0], b[0], shape) : null;
    // A return the function writes more than twice was written per exit, the copies VC8
    // cross-jumps (the quest StatusFilters' `return true`, Q31_StatusFilter 00586ce0). Not
    // so the GUID select ahead of a bare `return;`: the call was written once on the select
    // and its copies are VC8's (Q14_Callback11_ScrollMessage 0059cb20, `QUESTGUID_AddPlayerToList(
    // .., !pPlayer ? -1 : pPlayer->nUnitGUID)` matches).
    const selectBeforeReturn = !!merged && !shared && isBareReturn(last);
    if (last.kind === NodeKind.ReturnStmt && (returnCounts.get(text(last)) ?? 0) > 2 && !selectBeforeReturn) continue;
    if (!merged && !shared) continue;
    let joined: Statement;
    if (merged) {
      joined = { ...merged, leadingTrivia: ifs.leadingTrivia } as Statement;
    } else {
      const thenBlock = Stmt.compound(a.map(x => cloneNode(x) as Statement));
      const elseBlock = b.length ? Stmt.compound(b.map(x => cloneNode(x) as Statement)) : null;
      joined = { ...ifs, thenBranch: thenBlock, elseBranch: elseBlock } as IfStmt;
    }
    list.splice(i, list.length - i, joined, ...t);
    changed = true;
    options.onSite?.({ statements: k, line: ifs.location?.start.line ?? 0, withElse: b.length > 0, select: !!merged });
  }
  return changed ? list : null;
}

function createSharedTailJoinTransformer(options: SharedTailJoinOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      for (const n of traverseAST(fn.body)) if (n.kind === NodeKind.GotoStmt) return undefined;
      const shape = createExprShape(localTypesOf(fn), {
        globalTypes: options.globalTypes ?? {},
        enclosingVarTypes: options.enclosingVarTypes ?? {},
        structFields: options.structFields ?? {},
        fieldTypes: options.fieldTypes ?? {},
        returnTypes: options.functionReturnTypes ?? {},
      });
      const fnLocals = new Set<string>(localTypesOf(fn).keys());
      const returnCounts = new Map<string, number>();
      for (const n of traverseAST(fn.body)) {
        if (n.kind === NodeKind.ReturnStmt) returnCounts.set(text(n), (returnCounts.get(text(n)) ?? 0) + 1);
      }
      const body = cloneNode(fn.body) as CompoundStmt;
      let changed = false;
      const visit = (n: ASTNode, atEnd: boolean): void => {
        // Bottom-up: inner blocks first, then this one (an else-if chain folds outwards).
        for (const m of getChildren(n)) visit(m, false);
        if (n.kind === NodeKind.CompoundStmt) {
          const list = (n as CompoundStmt).statements;
          if (joinList(list, atEnd, options, shape, fnLocals, returnCounts)) changed = true;
        }
      };
      visit(body, true);
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const sharedTailJoinPlugin: TransformPlugin = {
  id: 'shared-tail-join',
  name: 'Shared Tail Join',
  description: 'An arm ending in the statements that follow it becomes an if/else with the tail written once after it',
  version: '1.0.0',
  defaultEnabled: true,
  // After return-copy-join (989.98), whose guard shapes it leaves alone.
  priority: 989.981,
  tags: ['matching'],
  createTransformer: (options: SharedTailJoinOptions = {}) => createSharedTailJoinTransformer(options),
};
