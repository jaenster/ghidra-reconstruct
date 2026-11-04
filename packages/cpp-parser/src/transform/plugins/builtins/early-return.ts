/**
 * Early-Return (Guard Clause) Plugin
 *
 * Flattens deeply nested `if (cond) { ... } return X;` chains into early-exit
 * guard clauses, which is far more readable than the decompiler's nested style.
 *
 * Rule (applied to a block, repeatedly on its tail):
 *   {
 *     ...prefix
 *     if (C) { BODY }   // no else
 *     return X;         // immediately follows the if (the block's terminator)
 *   }
 * becomes
 *   {
 *     ...prefix
 *     if (!C) return X;
 *     BODY
 *     return X;         // only re-added if BODY can fall through
 *   }
 *
 * Applied to the user's quest-sync example this collapses a 4-deep nest into a
 * flat sequence of `if (state) return 0;` guards. Conservative: only no-`else`
 * ifs whose then-branch is a block, immediately before the terminal return, and
 * the same return value is reused — so it is semantics-preserving. Runs late so
 * it operates on already-cleaned conditions.
 *
 * With the original's addresses (`branchLayout`, see branch-layout/evidence.ts) a guard
 * with a value is not made where the binary contradicts it: a simple or `&&` condition
 * outside a loop whose leaving BODY's code lies before the return's. VC8 lays `if (C) BODY`
 * out with BODY as the fall-through of the tests, while the guard puts the return there
 * (checked with the VC8 oracle: TEXT_GetOverheadSpeakerUnit, GetAnimOrSeqMode's `&&`,
 * deflateTune's two tests). An if a pass split off one decompiled `&&` (`if (a && (x = e,
 * x))` -> `if (a) { x = e; if (x) ... }`) takes that line's branch, and its BODY, which
 * runs on only through the split ifs, counts as leaving. A BODY that cannot leave at all is
 * Ghidra's single exit and keeps its nest unless the original fell into the return, the facts
 * cannot place the if before a constant return, BODY only loads the other value of a
 * returned variable already in EAX, or a loop in BODY comes before a constant return; a BODY
 * ending in `if (x) return K;`, x no `||` chain, before a constant return keeps the nest so
 * the two share the return. Where the layout cannot tell (an `||` condition, whose BODY VC8 moves out of line,
 * an if inside a loop, an arm without code of its own, a void function's implicit end) the
 * guard is made as before.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  Statement,
  CompoundStmt,
  IfStmt,
  ReturnStmt,
  ExprStmt,
  AssignExpr,
  Identifier,
  CStyleCastExpr,
  CallExpr,
  BinaryExpr,
  UnaryExpr,
  ParenExpr,
  FunctionDecl,
  MethodDecl,
  BuiltinType,
  TypeNode,
} from '../../../ast/nodes.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { getChildren, traverseAST } from '../../../ast/visitor.js';
import { LayoutReader, isLoop, type BranchLayoutEvidence } from './branch-layout/evidence.js';
import { conditionShape } from './branch-layout/index.js';
import { returnOrder, returnKey, constantValue, loadsEax, hasCall, hasLoop, earlierCopy } from './branch-layout/predict.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import { localTypesOf } from './compare-form.js';
import type { TypedefResolver } from './call-arg-cast.js';

const FLIP: Record<string, BinaryExpr['operator']> = {
  '==': '!=', '!=': '==', '<': '>=', '>': '<=', '<=': '>', '>=': '<',
};

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** Whether an operand of a comparison is an integer or a pointer, as far as the types say. */
type IsIntegral = (e: Expression) => boolean;

const INTEGRAL_BASES = new Set([
  'int', 'long', 'short', 'char', 'signed char', 'long long', 'bool', 'wchar_t',
  'unsigned int', 'unsigned long', 'unsigned short', 'unsigned char', 'unsigned long long',
  'intptr_t', 'uintptr_t', 'size_t', 'ssize_t', 'pointer32',
]);

function integralByTypes(shapeOf: ExprShape | null, enumTypes: ReadonlySet<string>): IsIntegral {
  return (e) => {
    let u = unwrapParens(e);
    if (u.kind === NodeKind.UnaryExpr && ['-', '~', '+'].includes((u as UnaryExpr).operator)) u = unwrapParens((u as UnaryExpr).operand);
    if (u.kind === NodeKind.IntegerLiteral || u.kind === NodeKind.CharLiteral || u.kind === NodeKind.BoolLiteral) return true;
    if (u.kind === NodeKind.NullptrLiteral) return true;
    const s = shapeOf ? shapeOf(u) : null;
    if (!s) return false;
    return s.stars > 0 || INTEGRAL_BASES.has(s.base) || enumTypes.has(s.base);
  };
}

/**
 * Logical negation, simplified: flip `==`/`!=`, drop a leading `!`, else wrap `!(...)`.
 * An ordering (`<`, `<=`, `>`, `>=`) is flipped only between integers or pointers: with a
 * floating-point operand, NaN makes `!(a < b)` true where `a >= b` is false.
 */
function invert(e: Expression, integral: IsIntegral): Expression {
  const u = unwrapParens(e);
  if (u.kind === NodeKind.BinaryExpr) {
    const b = u as BinaryExpr;
    const flipped = FLIP[b.operator];
    const ordering = b.operator !== '==' && b.operator !== '!=';
    if (flipped && (!ordering || (integral(b.left) && integral(b.right)))) {
      return { ...b, operator: flipped, leadingTrivia: [], trailingTrivia: [] };
    }
  }
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    return (u as UnaryExpr).operand;
  }
  // wrap !(...); parenthesize binary/conditional/assignment to preserve precedence
  const needsParen =
    u.kind === NodeKind.BinaryExpr ||
    u.kind === NodeKind.ConditionalExpr ||
    u.kind === NodeKind.AssignExpr;
  const operand: Expression = needsParen
    ? ({ kind: NodeKind.ParenExpr, expression: u, location: e.location, leadingTrivia: [], trailingTrivia: [] } as ParenExpr)
    : u;
  return { kind: NodeKind.UnaryExpr, operator: '!', operand, location: e.location, leadingTrivia: [], trailingTrivia: [] } as UnaryExpr;
}

function isTerminator(s: Statement): boolean {
  return s.kind === NodeKind.ReturnStmt || s.kind === NodeKind.BreakStmt || s.kind === NodeKind.ContinueStmt;
}

/** Match a no-`else` `if (C) { BODY }` with a non-empty block body. */
function matchGuardIf(s: Statement): { ifs: IfStmt; cond: Expression; body: Statement[] } | null {
  if (s.kind !== NodeKind.IfStmt) return null;
  const ifs = s as IfStmt;
  if (ifs.elseBranch !== null || ifs.init) return null;
  if (ifs.thenBranch.kind !== NodeKind.CompoundStmt) return null;
  const body = (ifs.thenBranch as CompoundStmt).statements;
  if (body.length === 0) return null;
  return { ifs, cond: ifs.condition, body };
}

function makeGuard(srcIf: IfStmt, cond: Expression, ret: ReturnStmt, integral: IsIntegral): IfStmt {
  return {
    kind: NodeKind.IfStmt,
    condition: invert(cond, integral),
    thenBranch: cloneNode(ret),
    elseBranch: null,
    isConstexpr: false,
    location: srcIf.location,
    leadingTrivia: srcIf.leadingTrivia || [],
    trailingTrivia: [],
  };
}

/** Whether a guard may replace `if (C) { BODY } ret`: always, unless the layout says otherwise. */
type GuardGate = (ifs: IfStmt, body: Statement[], ret: ReturnStmt) => boolean;

/**
 * Flatten one trailing guard:
 *   A) `... if (C) { BODY } return X;`          → `... if (!C) return X; BODY [return X]`
 *   B) `... if (C) { BODY }`  (voidContext)     → `... if (!C) return; BODY`   (implicit void end)
 */
function flattenOnce(block: CompoundStmt, voidContext: boolean, gate: GuardGate | null, integral: IsIntegral): CompoundStmt | null {
  const s = block.statements;
  const n = s.length;
  if (n < 1) return null;
  const last = s[n - 1];

  // Case A: explicit trailing return after the guard
  if (n >= 2 && last.kind === NodeKind.ReturnStmt) {
    const g = matchGuardIf(s[n - 2]);
    if (g && (!gate || gate(g.ifs, g.body, last as ReturnStmt))) {
      const ret = last as ReturnStmt;
      const guard = makeGuard(g.ifs, g.cond, ret, integral);
      const bodyFallsThrough = !isTerminator(g.body[g.body.length - 1]);
      const tail: Statement[] = bodyFallsThrough ? [cloneNode(ret)] : [];
      return { ...block, statements: [...s.slice(0, n - 2), guard, ...g.body, ...tail] };
    }
  }

  // Case B: void function ends with the guard (implicit `return;`)
  if (voidContext) {
    const g = matchGuardIf(last);
    if (g) {
      const voidRet: ReturnStmt = {
        kind: NodeKind.ReturnStmt, value: null, location: last.location, leadingTrivia: [], trailingTrivia: [],
      };
      const guard = makeGuard(g.ifs, g.cond, voidRet, integral);
      // no terminal return appended — the function falls off its (void) end
      return { ...block, statements: [...s.slice(0, n - 1), guard, ...g.body] };
    }
  }

  return null;
}

function flattenBody(block: CompoundStmt, voidContext: boolean, gate: GuardGate | null, integral: IsIntegral): CompoundStmt | null {
  let cur = block;
  let changed = false;
  for (let i = 0; i < 256; i++) {
    const next = flattenOnce(cur, voidContext, gate, integral);
    if (!next) break;
    cur = next;
    changed = true;
  }
  return changed ? cur : null;
}

function isVoidReturn(t: TypeNode): boolean {
  return t.kind === NodeKind.BuiltinType && (t as BuiltinType).name === 'void';
}

/** Lines of the ifs inside a loop. */
function loopIfLines(root: ASTNode): Set<number> {
  const out = new Set<number>();
  const go = (n: ASTNode, inLoop: boolean): void => {
    if (n.kind === NodeKind.IfStmt && inLoop) out.add(n.location.start.line);
    const loop = inLoop || isLoop(n);
    for (const k of getChildren(n)) go(k, loop);
  };
  go(root, false);
  return out;
}

/**
 * `s` is an if split off the same decompiled condition (on `line`, no else) whose arm
 * leaves, directly or through a further such if.
 */
function chainLeaves(s: Statement, line: number): boolean {
  if (s.kind !== NodeKind.IfStmt) return false;
  const i = s as IfStmt;
  if (i.elseBranch || i.location?.start.line !== line) return false;
  const arm = i.thenBranch.kind === NodeKind.CompoundStmt ? (i.thenBranch as CompoundStmt).statements : [i.thenBranch];
  if (arm.length === 0) return false;
  const last = arm[arm.length - 1];
  return isTerminator(last) || chainLeaves(last, line);
}

/**
 * Whether control can leave `stmts` other than by falling off their end: a return or goto
 * anywhere, or a break/continue not caught by a loop or switch inside them.
 */
function canLeave(stmts: readonly Statement[]): boolean {
  const go = (n: ASTNode, inLoop: boolean, inSwitch: boolean): boolean => {
    switch (n.kind) {
      case NodeKind.ReturnStmt: case NodeKind.GotoStmt: return true;
      case NodeKind.BreakStmt: return !inLoop && !inSwitch;
      case NodeKind.ContinueStmt: return !inLoop;
      case NodeKind.LambdaExpr: return false;
    }
    const loop = inLoop || isLoop(n);
    const sw = inSwitch || n.kind === NodeKind.SwitchStmt;
    return getChildren(n).some(k => go(k, loop, sw));
  };
  return stmts.some(s => go(s, false, false));
}

/**
 * `if (x) { return K; }` with no else, K a constant and x no `||` chain, or a no-else if
 * whose arm falls through only into one: the nest ends in a test that leaves with a constant.
 */
function returnsConstantTail(s: Statement): boolean {
  if (s.kind !== NodeKind.IfStmt) return false;
  const i = s as IfStmt;
  if (i.elseBranch) return false;
  const arm = i.thenBranch.kind === NodeKind.CompoundStmt ? (i.thenBranch as CompoundStmt).statements : [i.thenBranch];
  if (arm.length === 0) return false;
  const last = arm[arm.length - 1];
  if (arm.length === 1 && last.kind === NodeKind.ReturnStmt) {
    // An `||` test jumps to the return from each operand and has no flag to fold
    // (SOUND_Is3DMixerActive 004df980, SKILL_CheckCorpseCanBeConsumed 005d8510).
    const v = (last as ReturnStmt).value;
    return !!v && constantValue(v) && conditionShape(i.condition).kind !== 'or';
  }
  return returnsConstantTail(last);
}

/** The variable a return reads, through casts; null for any other value. */
function returnedVariable(e: Expression): string | null {
  let u = unwrapParens(e);
  while (u.kind === NodeKind.CStyleCastExpr) u = unwrapParens((u as CStyleCastExpr).expression);
  return u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
}

const EAX_WRITE = /^(MOV|MOVZX|MOVSX|XOR|OR|SUB|ADD|AND|LEA)\/(EAX|AX|AL)$/;

function hasIf(stmts: readonly Statement[]): boolean {
  return stmts.some(s => [...traverseAST(s)].some(n => n.kind === NodeKind.IfStmt));
}

/**
 * The if jumps to the start of the return copy its BODY runs into, and another return of the
 * same value has a copy of its own that nothing falls into: an earlier test's, whose epilogue
 * differs (a register saved after it). Written as a guard, VC8 keeps the two copies apart;
 * nested, it merges them into one exit.
 */
function jumpsToBodyCopy(reader: LayoutReader, ifs: IfStmt, ret: ReturnStmt, returns: readonly ReturnStmt[]): boolean {
  const e = reader.edge(ifs);
  const copy = e ? reader.returnCopyStarting(e.target) : null;
  const key = returnKey(ret);
  if (!e || !copy || key === null || !reader.runsInto(e.fall, copy)) return false;
  const line = ret.location?.start.line;
  return returns.some(r => {
    if (r.location?.start.line === line || returnKey(r) !== key) return false;
    const at = reader.returnCopy(r);
    const other = at === null ? undefined : reader.copies().find(c => c.start <= at && at <= c.ret);
    return !!other && other !== copy && other.fallsIn === false;
  });
}

/**
 * BODY is one plain `x = e;` of the returned variable, `e` without a call and not reading
 * `x`, and the return copy the if jumps to writes nothing into EAX: x is there at the test.
 */
function selectsReturn(stmts: readonly Statement[], ret: ReturnStmt, reader: LayoutReader, ifs: IfStmt): boolean {
  if (stmts.length !== 1 || stmts[0].kind !== NodeKind.ExprStmt || !ret.value) return false;
  const x = returnedVariable(ret.value);
  const a = unwrapParens((stmts[0] as ExprStmt).expression);
  if (!x || a.kind !== NodeKind.AssignExpr) return false;
  const as = a as AssignExpr;
  if (as.operator !== '=' || returnedVariable(as.left) !== x) return false;
  for (const n of traverseAST(as.right)) {
    if (n.kind === NodeKind.CallExpr || (n.kind === NodeKind.Identifier && (n as Identifier).name === x)) return false;
  }
  const e = reader.edge(ifs);
  const copy = e ? reader.returnCopyStarting(e.target) : null;
  return !!copy && !copy.insns.some(i => EAX_WRITE.test(i));
}

/** The if's conditional jump tests the sign flag alone (JNS/JS): the value's own arithmetic set it. */
function signTest(reader: LayoutReader, ifs: IfStmt): boolean {
  const cc = reader.edge(ifs)?.cc;
  return cc === 'JNS' || cc === 'JS';
}

/** A call to `exit` or `abort` in `stmts`: a path that halts. */
function callsNoReturn(stmts: readonly Statement[]): boolean {
  return stmts.some(s => [...traverseAST(s)].some(n => {
    if (n.kind !== NodeKind.CallExpr) return false;
    const c = (n as CallExpr).callee;
    return c.kind === NodeKind.Identifier && ['exit', 'abort', '_exit'].includes((c as Identifier).name);
  }));
}

/** The if's conditional jump goes backward to the start of a return copy of the original. */
function backIntoCopy(reader: LayoutReader, ifs: IfStmt): boolean {
  const e = reader.edge(ifs);
  return !!e && e.target < e.jcc && reader.fallInto(ifs) === 'other' && reader.returnCopyAt(e.target);
}

/** The if falls into its arm and jumps onto the first instruction of a return copy that loads EAX. */
function jumpsOntoLoad(reader: LayoutReader, ifs: IfStmt): boolean {
  const e = reader.edge(ifs);
  if (!e || reader.fallInto(ifs) !== 'then') return false;
  const c = reader.returnCopyStarting(e.target);
  return !!c && loadsEax(c);
}

/** The gate for one function, read from its body before any guard is made. */
function layoutGate(ev: BranchLayoutEvidence, body: CompoundStmt): GuardGate {
  const reader = new LayoutReader(ev, body);
  const inLoop = loopIfLines(body);
  const returns = returnOrder(body);
  return (ifs, stmts, ret) => {
    // `if (C) { return K; } return X;` whose jump lands back on an earlier copy of K: the
    // original's guard returns K, merged into the copy written before it. Turned around,
    // X's test would jump and K's copy would move to the end.
    if (stmts.length === 1 && stmts[0].kind === NodeKind.ReturnStmt && backIntoCopy(reader, ifs)) return false;
    // A bare `return;` has no code of its own: no evidence either way, as in case B.
    if (!ret.value) return true;
    // `if (C) { BODY } return K;`, K a constant, whose jump lands on a copy of the return
    // that loads K itself: the source had no guard there. A guard `if (!C) return K;` makes
    // VC8 load K before the test and jump past the load when BODY is straight code that
    // leaves EAX alone (no call, no loop), and merge the guard into an earlier copy of K
    // when there is one (a simple condition, BODY falling into the return); otherwise the
    // two forms compile the same and the guard is made.
    if (!isTerminator(stmts[stmts.length - 1]) && constantValue(ret.value) && conditionShape(ifs.condition).kind === 'simple'
      && jumpsOntoLoad(reader, ifs) && ((!hasCall(stmts) && !hasLoop(stmts)) || earlierCopy(returnOrder(body), ifs, ret))) return false;
    // BODY falling through takes a copy of the return; which copy keeps the code (VC8
    // emits one per path or merges them) is not the layout's to say. Except where BODY
    // runs on only through the ifs a pass split off this one decompiled condition: the
    // decompiler's BODY left.
    if (!isTerminator(stmts[stmts.length - 1]) && !chainLeaves(stmts[stmts.length - 1], ifs.location.start.line)) {
      // A BODY that cannot leave is Ghidra's single exit, `if (n % m) { n += ...; } return n;`
      // (TSGrowableArray_Ui_RoundToChunk 004210e0, Q20_SequenceFilter 005b9610): the guard
      // only clones the return, and VC8 lays the clone out where the original had none.
      // Made only where the original fell into the return and jumped to BODY - the guard's
      // own layout, one return copy per path (SPELLSEL_FindChargedSkill1).
      const fall = reader.fallInto(ifs);
      const constant = constantValue(ret.value);
      if (!canLeave(stmts)) {
        if (fall === 'other') return true;
        // Where the facts cannot place the if (Missiles_SrvHitFunc_DispatchSrvDoFunc 005acfc0,
        // Q22_PlayerCheckKhalimsWillItems 005bb7b0), a constant return is guarded as before:
        // its copy brings no value into EAX and VC8 shares it with BODY's own exits. A
        // variable keeps its single exit (CHAR_AddClassToHitFactor 004a7300).
        if (fall === null) return constant;
        // `x = A; if (C) { x = B; } return x;` with x in EAX at the test: the original
        // returns A at once and loads B on the other path (GAMEDATA_GetLadderOrGameType
        // 0044dca0, StripPathPrefixToRelative 00408000). Nested, VC8 loads B first and
        // moves A over it.
        // Not where the test is the sign of the value just computed, a JNS/JS with no
        // compare of its own: `n = ...; if (n < 0) { n = 0; } return n;` jumps over the
        // store onto the one return (Q32_GetRemainingPrisonersCount 00588c50 `add eax, edx;
        // jns`, SKILLS_CalculateManaCostShifted 006459f0 `sar eax, 8; jns`). The guard
        // makes VC8 clone the return in front of the store.
        if (selectsReturn(stmts, ret, reader, ifs)) return !signTest(reader, ifs);
        // A constant return after a loop: the loop's exits leave at different depths of
        // the epilogue's pops, and VC8 shares one tail between them and the guard
        // (SPELLSEL_FindChargedSkill1 004a9a90, SKILLSEMON_CltSetReviveGfx 004f04f0). Not a
        // loop that can halt, whose cold path VC8 lays out apart (DRLGROOM_ValidateClientList
        // 0061a550).
        if (constant && hasLoop(stmts) && !callsNoReturn(stmts)) return true;
        // `if (C) { BODY } return K;` whose jump lands on the copy BODY ends in, where an
        // earlier test keeps a copy of the same return of its own and BODY branches again
        // (INPUT_HandleRightClickWithPet 00462ca0, CompleteQuestStates 005b74e0,
        // Missiles_SrvHitFunc_SpawnDualRadialSubMissiles 005acf20): the source returned early.
        // A straight BODY keeps the nest (00462ca0's last test; 004f0430, 00624690).
        if (hasIf(stmts) && jumpsToBodyCopy(reader, ifs, ret, returns)) return true;
        return false;
      }
      // `if (C) { ...; if (x) { return 1; } } return 0;`: the tail test jumps to the return
      // the failing C shares (SKILL_ExecuteSelectProc 004642b0, BNCLIENT_IsSocketConnected
      // 0051ca30). Flattened, `if (x) return 1; return 0;` stands alone and VC8 folds it
      // to NEG/SBB/NEG.
      if (constant && returnsConstantTail(stmts[stmts.length - 1])) return false;
      return true;
    }
    // An `||` condition puts a leaving BODY out of line after what follows, so the nest's
    // layout is not BODY first either; a leaving arm in a loop is laid out apart from
    // either form.
    const shape = conditionShape(ifs.condition).kind;
    if ((shape !== 'simple' && shape !== 'and') || inLoop.has(ifs.location.start.line)) return true;
    const cb = reader.chainBranch(ifs);
    if (cb === null) return true;
    const r = reader.entry([ret], cb), b = reader.entry(stmts, cb);
    return r === null || b === null || r < b;
  };
}

function createEarlyReturnTransformer(gate: GuardGate | null, integral: IsIntegral): Transformer {
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      // Any block: flatten explicit-trailing-return guards (Case A).
      if (node.kind === NodeKind.CompoundStmt) {
        return flattenBody(node as CompoundStmt, false, gate, integral) ?? undefined;
      }
      // Function/method bodies: if void-returning, also flatten the implicit-end guard (Case B).
      if (node.kind === NodeKind.FunctionDecl || node.kind === NodeKind.MethodDecl) {
        const fn = node as FunctionDecl | MethodDecl;
        if (fn.body && isVoidReturn(fn.returnType)) {
          const nb = flattenBody(fn.body, true, gate, integral);
          if (nb) return updateNode(fn, { body: nb });
        }
      }
      return undefined;
    },
  });
}

/**
 * Per function: the gate is read from the body as the passes before left it, and the
 * operand types from its parameters and locals plus the tables the caller passes.
 */
function createPerFunctionTransformer(o: EarlyReturnOptions): Transformer {
  const ev = o.branchLayout ?? null;
  const enumTypes = new Set(o.enumTypes ?? []);
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => (enumTypes.has(name) ? undefined : typedefTargets[name]);
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind !== NodeKind.FunctionDecl && node.kind !== NodeKind.MethodDecl) return undefined;
      const fn = node as FunctionDecl | MethodDecl;
      if (!fn.body) return undefined;
      const shapeOf = createExprShape(localTypesOf(fn as FunctionDecl), {
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });
      const integral = integralByTypes(shapeOf, enumTypes);
      return createEarlyReturnTransformer(ev ? layoutGate(ev, fn.body) : null, integral)(fn);
    },
  });
}

export interface EarlyReturnOptions extends PluginOptions {
  /** The original's addresses (branch-layout/evidence.ts); absent: every guard is made. */
  branchLayout?: BranchLayoutEvidence | null;
  /** Type tables for the operands of a negated ordering (see `invert`). */
  enumTypes?: string[];
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
}

/**
 * Early-Return (Guard Clause) Plugin
 *
 * Flattens nested `if (C) { ... } return X;` into `if (!C) return X; ...`.
 */
export const earlyReturnPlugin: TransformPlugin = {
  id: 'early-return',
  name: 'Early Return (Guard Clauses)',
  description:
    'Flatten nested if (C) { ... } return X; chains into early-exit guard clauses (if (!C) return X; ...)',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 60, // late: after structural cleanups (goto-cleanup, loop passes) so conditions are clean
  tags: ['core', 'readability', 'control-flow'],

  createTransformer(options?: EarlyReturnOptions) {
    return createPerFunctionTransformer(options ?? {});
  },
};
