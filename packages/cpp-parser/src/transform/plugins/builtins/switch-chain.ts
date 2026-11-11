/**
 * Switch Chain Plugin
 *
 * VC8 /O2 lowers a switch over a few sparse cases to running subtractions on one register,
 * `sub ecx, 0; je L0; sub ecx, 1; je L1; sub ecx, 1; jne Ldefault`, and an if-chain to
 * comparisons, `cmp ecx, 1; je`. The decompiler prints both as equality tests on the
 * variable, so the source's switch comes back as ifs on the variable: an else-if chain,
 * consecutive ifs whose arms leave, `if (v != K) { leave }` guards with K's code after them,
 * nested `!=` tests whose arms fall into each other, or one `sub ecx, K; je`. Cases sharing
 * code come back as one test of several constants, `v == A || v == B` or `v != A && v != B`.
 *
 * Where the original's instructions (branch-layout evidence, `tests`) show every test as one
 * of those subtractions, the ifs are written back as the switch. The evidence: each test's
 * condition prints one equality token per constant, each instruction is SUB/ADD/DEC/INC, and the
 * tests are one whole countdown run - one register, each subtraction a few bytes after the
 * last, the running total equal to each compared constant. A fragment of a run (a test
 * printed elsewhere, a binary-search split) is left.
 *
 * The decision is the ifs from the first one down to the first statement of each arm that is
 * not a test (a leaf). Each case value and "any other value" is followed through the tests
 * to its leaf, or out of the bottom; values with one leaf share a case. A leaf that does not
 * leave runs into the statement after the innermost if that has one: another leaf (the case
 * falls into the next), the end (the case breaks), or a further test (refused). Values that
 * fall out of the bottom get a case whose code is what follows in the block when every other
 * leaf leaves or runs into it; when "any other value" falls out too, they are the default's
 * and that code stays after the switch.
 *
 * Meaning is kept: the variable is a plain lvalue, read by nothing between two tests;
 * case values are the instructions' constants (a literal label must agree with it; an
 * identifier must be an enumerator); every leaf is reached; no case code holds a `break`
 * that binds outside it or a case label of an enclosing switch; two cases never fall into
 * one. When in doubt the ifs are left as printed.
 *
 * A case whose code opens with a test of its own comes back folded into the case's test,
 * `if (v == K && R) B` with no else (MONSTERAI_GetAliveKillerUnit 005de830: `sub eax, 0; je;
 * sub eax, 1; jne` and then the mode tests). Where the subtraction stands for `v == K` alone,
 * on lines of its own, the if is read as `if (v == K) { if (R) B }`, the same code, and the
 * case is `case K: { if (R) B }`; a decision left as ifs keeps the printed if.
 *
 * Cases are put in source order, read off the original's layout: VC8 lays the bodies of a
 * switch it lowers this way out in reverse source order, the last case right after the tests
 * (NET_D2GS_CLIENT_Send_0x67, 00477ca0, and BuildKurast, 0067f190, both matching byte for
 * byte: the bodies' addresses fall as the cases go down). Cases that fall into each other
 * keep that order. Where an entry is unknown or shared, printed order stays.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, IfStmt, Statement, Expression, BinaryExpr, UnaryExpr, ParenExpr,
  Identifier, IntegerLiteralExpr, CharLiteralExpr, FunctionDecl, SwitchStmt, CaseStmt, DefaultStmt,
  MemberExpr, SubscriptExpr, CStyleCastExpr, VariableDecl, QualifiedId, ExprStmt, AssignExpr,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Stmt } from '../../../ast/factory.js';
import { emit } from '../../../emit/emitter.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { DEFAULT_NORETURN_FUNCTIONS } from './goto-cleanup/types.js';
import { holdsFreeCase, freeJumps } from './goto-cleanup/paths.js';
import { leaves } from './assert-order.js';
import { LayoutReader, type BranchLayoutEvidence, type EqualityTest } from './branch-layout/evidence.js';

export interface SwitchChainOptions extends PluginOptions {
  /** The original's addresses and equality-test instructions; absent: nothing changes. */
  branchLayout?: BranchLayoutEvidence | null;
  /** Enumerator names: the only identifiers a case label may be. */
  enumConstants?: string[];
  /** Declared types of parameters and globals by name (locals are read off the body). */
  varTypes?: Record<string, string>;
  /** Field name -> declared type, where every aggregate declaring it agrees. */
  fieldTypes?: Record<string, string>;
  /** Aggregate name -> field name -> declared type: a field of a known aggregate. */
  structFields?: Record<string, Record<string, string>>;
  /** Typedef name -> the spelling it stands for. */
  typedefTargets?: Record<string, string>;
  /** Every enum type name. */
  enumTypes?: string[];
  /** Further callees that never return, by unqualified name. */
  noreturnFunctions?: string[];
  /** Called once per decision rewritten, and per decision on subtraction tests left. */
  onSite?: (e: { rule: 'switch' | 'left'; line: number; cases: number; why?: string }) => void;
  /** Set by switchChainLatePlugin: only chains of two ifs or more whose cases keep their own code. */
  late?: boolean;
}

const SUBTRACTS = new Set(['SUB', 'ADD', 'DEC', 'INC']);

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** A read with no side effects and no call: a variable, a field, an element, a dereference. */
function pureLvalue(e: Expression): boolean {
  e = unwrap(e);
  switch (e.kind) {
    case NodeKind.Identifier:
    case NodeKind.QualifiedId:
      return true;
    case NodeKind.MemberExpr:
      return pureRead((e as MemberExpr).object);
    case NodeKind.SubscriptExpr:
      return pureRead((e as SubscriptExpr).array) && pureRead((e as SubscriptExpr).index);
    case NodeKind.UnaryExpr:
      return (e as UnaryExpr).operator === '*' && pureRead((e as UnaryExpr).operand);
    default:
      return false;
  }
}

function pureRead(e: Expression): boolean {
  for (const n of traverseAST(e)) {
    switch (n.kind) {
      case NodeKind.CallExpr: case NodeKind.AssignExpr: case NodeKind.PostfixExpr:
      case NodeKind.CommaExpr: case NodeKind.NewExpr: case NodeKind.DeleteExpr: case NodeKind.ThrowExpr:
        return false;
      case NodeKind.UnaryExpr: {
        const op = (n as UnaryExpr).operator;
        if (op === '++' || op === '--') return false;
        break;
      }
    }
  }
  return true;
}

/** A case label's value, when the constant is one: its integer value (null for an enumerator). */
function caseConstant(e: Expression, enums: ReadonlySet<string>): { value: bigint | null } | undefined {
  e = unwrap(e);
  switch (e.kind) {
    case NodeKind.IntegerLiteral:
      return { value: (e as IntegerLiteralExpr).value };
    case NodeKind.CharLiteral: {
      const v = (e as CharLiteralExpr).value as unknown;
      return typeof v === 'number' ? { value: BigInt(v) } : undefined;
    }
    case NodeKind.Identifier:
      return enums.has((e as Identifier).name) ? { value: null } : undefined;
    case NodeKind.UnaryExpr: {
      const u = e as UnaryExpr;
      if (u.operator !== '-') return undefined;
      const inner = caseConstant(u.operand, enums);
      return inner && inner.value !== null ? { value: -inner.value } : undefined;
    }
    default:
      return undefined;
  }
}

interface Operand {
  label: Expression;
  value: bigint | null;
}

interface Test {
  v: Expression;
  /** The constants compared, in text order: one, or the operands of a `||`/`&&` chain. */
  ops: Operand[];
  /** `v != K`: true when the variable is none of the constants. */
  neg: boolean;
}

/** `v == K`, `K == v`, `!v`, or the same with `!=`, on a pure lvalue. */
function equalityOperand(cond: Expression, enums: ReadonlySet<string>): { v: Expression; op: Operand; neg: boolean } | null {
  const c = unwrap(cond);
  if (c.kind === NodeKind.UnaryExpr && (c as UnaryExpr).operator === '!') {
    const v = unwrap((c as UnaryExpr).operand);
    return pureLvalue(v) ? { v, op: { label: zeroAt(c), value: 0n }, neg: false } : null;
  }
  if (c.kind !== NodeKind.BinaryExpr) return null;
  const b = c as BinaryExpr;
  if (b.operator !== '==' && b.operator !== '!=') return null;
  for (const [v, k] of [[b.left, b.right], [b.right, b.left]] as const) {
    const kc = caseConstant(k, enums);
    if (kc && pureLvalue(v) && caseConstant(v, enums) === undefined) {
      return { v: unwrap(v), op: { label: unwrap(k), value: kc.value }, neg: b.operator === '!=' };
    }
  }
  return null;
}

/**
 * One equality test, or a short-circuit chain of them on one variable that asks one
 * question: `v == A || v == B` (v is one of them) or `v != A && v != B` (v is none of
 * them). A switch with shared labels compiles to that: `sub; je L; sub; je L`. The
 * operands read only the variable, so evaluating them all or stopping early gives the
 * same answer. Mixed senses, another variable or a repeated constant are not one test.
 */
function equality(cond: Expression, enums: ReadonlySet<string>): Test | null {
  const c = unwrap(cond);
  const join = c.kind === NodeKind.BinaryExpr ? (c as BinaryExpr).operator : '';
  if (join !== '||' && join !== '&&') {
    const one = equalityOperand(c, enums);
    return one ? { v: one.v, ops: [one.op], neg: one.neg } : null;
  }
  const leaves: Expression[] = [];
  const flatten = (e: Expression): void => {
    const u = unwrap(e);
    if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === join) {
      flatten((u as BinaryExpr).left);
      flatten((u as BinaryExpr).right);
    } else leaves.push(u);
  };
  flatten(c);
  const parts = leaves.map(l => equalityOperand(l, enums));
  if (parts.some(p => !p)) return null;
  const first = parts[0]!;
  // `||` asks "is it one of these" with `==`; `&&` asks "is it none of these" with `!=`.
  const neg = join === '&&';
  if (parts.some(p => p!.neg !== neg || !same(p!.v, first.v))) return null;
  const ops = parts.map(p => p!.op);
  const known = ops.filter(o => o.value !== null).map(o => o.value);
  if (new Set(known).size !== known.length) return null;
  if (new Set(ops.map(o => emit(o.label as never))).size !== ops.length) return null;
  return { v: first.v, ops, neg };
}

function zeroAt(at: ASTNode): Expression {
  return { kind: NodeKind.IntegerLiteral, value: 0n, suffix: '', base: 10, raw: '0', location: at.location, leadingTrivia: [], trailingTrivia: [] } as unknown as Expression;
}

function same(a: Expression, b: Expression): boolean {
  try {
    return emit(a as never) === emit(b as never);
  } catch {
    return false;
  }
}

/**
 * Most bytes from one subtraction to the next in a run: `sub r, imm32; jcc rel32` is 12, and
 * VC8 schedules a few independent stores between the first subtraction and its jump
 * (UNITMODE_SendWalkToPosition 00480ef0: `sub eax, 0`, three moves, `je`, 16 bytes on).
 */
const RUN_GAP = 24;

/**
 * A SUB that takes a register off the running value (`sub eax, ebx` with EBX holding 1): the
 * instruction names no amount, the decompile's constant does. After the run's first test the
 * amount is what takes the running total to that constant; a first test needs its own.
 */
function stepOf(t: EqualityTest, total: bigint | null): bigint | undefined {
  if (t.delta !== undefined) return BigInt(t.delta);
  if (t.mnemonic !== 'SUB' || total === null || t.k === undefined) return undefined;
  return BigInt(t.k) - total;
}

/**
 * The runs of the function: subtractions on one register, each a few bytes after the last,
 * whose running total is the constant each one compares against. A run starts where a test
 * subtracts exactly its own constant. Each test offset maps to the offsets of its run.
 */
function countdownRuns(tests: ReadonlyMap<number, readonly EqualityTest[]>): Map<number, readonly number[]> {
  const byAt = new Map<number, EqualityTest>();
  for (const list of tests.values()) {
    for (const t of list) {
      if (SUBTRACTS.has(t.mnemonic) && t.k !== undefined && t.reg !== '-') byAt.set(t.at, t);
    }
  }
  const out = new Map<number, readonly number[]>();
  let run: EqualityTest[] = [];
  let total = 0n;
  const close = () => { const ats = run.map(t => t.at); for (const a of ats) out.set(a, ats); run = []; };
  for (const t of [...byAt.values()].sort((x, y) => x.at - y.at)) {
    const mask = (1n << BigInt(8 * t.size)) - 1n;
    const k = BigInt(t.k!) & mask;
    const last = run[run.length - 1];
    const step = last ? stepOf(t, total) : undefined;
    if (last && step !== undefined && t.reg === last.reg && t.size === last.size && t.at - last.at <= RUN_GAP && ((total + step) & mask) === k) {
      run.push(t);
      total = k;
      continue;
    }
    close();
    if (t.delta !== undefined && (BigInt(t.delta) & mask) === k) { run = [t]; total = k; }
  }
  close();
  return out;
}

/**
 * The bytes of `cmp reg, k`: an 8-bit immediate where k sign-extends from one, else the
 * accumulator's short form or the full one (and the 0x66 prefix for a word register).
 */
function compareLength(t: EqualityTest): number {
  const bits = 8 * t.size;
  const k = BigInt(t.k ?? 0) & ((1n << BigInt(bits)) - 1n);
  const signed = k >= 1n << BigInt(bits - 1) ? k - (1n << BigInt(bits)) : k;
  const acc = t.reg === 'EAX' || t.reg === 'AX' || t.reg === 'AL';
  if (t.size === 1) return acc ? 2 : 3;
  const prefix = t.size === 2 ? 1 : 0;
  if (signed >= -128n && signed <= 127n) return prefix + 3;
  return prefix + (acc ? 1 : 2) + t.size;
}

/** The next compare starts right after this one's jump: a short or a near jcc, nothing else. */
function followsDirectly(last: EqualityTest, t: EqualityTest): boolean {
  const gap = t.at - last.at - compareLength(last);
  return gap === 2 || gap === 6;
}

/**
 * The compare runs of the function: CMPs of one register against constants, each straight
 * after the last with nothing but its jump between (the gap is the compare's length and a
 * jump's, exactly). VC8 lowers a sparse switch of a few
 * cases to such a run, `cmp ecx, 6; je; cmp ecx, 0x16; je; cmp ecx, 0x1e; jne default`
 * (Skills_CltDoFunc_Mon_BaalTaunt_AnimCycle 004e2630), and an if-chain to compares with
 * each arm's code between them. Each test offset maps to the offsets of its run.
 */
function compareRuns(tests: ReadonlyMap<number, readonly EqualityTest[]>): Map<number, readonly number[]> {
  const byAt = new Map<number, EqualityTest>();
  for (const list of tests.values()) {
    for (const t of list) if (t.mnemonic === 'CMP' && t.k !== undefined && t.reg !== '-') byAt.set(t.at, t);
  }
  const out = new Map<number, readonly number[]>();
  let run: EqualityTest[] = [];
  const close = () => { if (run.length >= 2) { const ats = run.map(t => t.at); for (const a of ats) out.set(a, ats); } run = []; };
  for (const t of [...byAt.values()].sort((x, y) => x.at - y.at)) {
    const last = run[run.length - 1];
    if (last && t.reg === last.reg && t.size === last.size && followsDirectly(last, t)) { run.push(t); continue; }
    close();
    run = [t];
  }
  close();
  return out;
}

const wrapped = new WeakMap<Statement, Statement[]>();

/** An arm's statements; the same array each time, so a leaf is found again by identity. */
function asList(s: Statement): Statement[] {
  if (s.kind === NodeKind.CompoundStmt) return (s as CompoundStmt).statements;
  let l = wrapped.get(s);
  if (!l) { l = [s]; wrapped.set(s, l); }
  return l;
}

function freeBreakOrCase(stmts: Statement[]): boolean {
  return freeJumps(stmts).brk || holdsFreeCase(stmts);
}

const INTEGRAL = new Set([
  'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'int', 'unsigned int', 'unsigned',
  'long', 'unsigned long', 'long long', 'unsigned long long', 'bool', 'wchar_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'byte', 'uchar', 'ushort', 'uint', 'ulong', 'sbyte', 'word', 'dword', 'qword',
  'BYTE', 'WORD', 'DWORD', 'QWORD', 'UINT', 'INT', 'LONG', 'ULONG', 'SHORT', 'USHORT', 'CHAR', 'UCHAR',
  'BOOL', 'BOOLEAN', 'WPARAM', 'LPARAM', 'size_t', 'ptrdiff_t', 'intptr_t', 'uintptr_t',
  'undefined1', 'undefined2', 'undefined4', 'undefined8', '__int8', '__int16', '__int32', '__int64',
  // The parser prints `short` as `short int` (and so on): the spellings `emit` gives a declaration.
  'short int', 'unsigned short int', 'signed short', 'signed short int', 'signed', 'signed int',
  'long int', 'unsigned long int', 'signed long', 'signed long int', 'long long int', 'unsigned long long int',
]);

/** A declared type spelling is an integer or an enum (through typedefs); unknown is not. */
function integralType(spelled: string | undefined, opts: SwitchChainOptions, enums: ReadonlySet<string>, depth = 0): boolean {
  if (!spelled || depth > 8) return false;
  const t = spelled.replace(/\b(const|volatile|struct|enum|class|union)\b/g, '').replace(/\s+/g, ' ').trim();
  if (/[*&\[(]/.test(t)) return false;
  if (INTEGRAL.has(t)) return true;
  const bare = t.replace(/^.*::/, '');
  if (enums.has(t) || enums.has(bare)) return true;
  const target = opts.typedefTargets?.[t] ?? opts.typedefTargets?.[bare];
  return target !== undefined && integralType(target, opts, enums, depth + 1);
}

/**
 * The aggregate a member access reads from: the object's declared type, through one pointer
 * for `->` and none for `.`, without qualifiers, `struct` or namespaces. Undefined when the
 * type is unknown, has another level of indirection, or is not a plain name.
 */
function aggregateOf(spelled: string | undefined, arrow: boolean): string | undefined {
  if (!spelled) return undefined;
  let t = spelled.replace(/\b(const|volatile|struct|class|union)\b/g, '').replace(/\s+/g, ' ').trim();
  if (arrow) {
    if (!t.endsWith('*')) return undefined;
    t = t.slice(0, -1).trim();
  }
  if (/[*&\[(<]/.test(t)) return undefined;
  t = t.replace(/^::/, '').replace(/^.*::/, '');
  return /^\w+$/.test(t) ? t : undefined;
}

/** Locals declared in the body, name -> type as printed. */
function localTypes(body: ASTNode): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.VariableDecl) continue;
    const d = n as VariableDecl;
    const name = typeof d.name === 'string' ? d.name : (d.name as Identifier | undefined)?.name;
    if (!name) continue;
    try {
      const t = emit(d.type as never);
      // Two declarations of one name with different types: unknown.
      out.set(name, out.has(name) && out.get(name) !== t ? '?' : t);
    } catch { out.set(name, '?'); }
  }
  return out;
}

interface Ctx {
  /** The switch operand's type is an integer or an enum. */
  integral: (v: Expression) => boolean;
  reader: LayoutReader;
  enums: ReadonlySet<string>;
  noreturn: ReadonlySet<string>;
  onSite?: SwitchChainOptions['onSite'];
  /** If lines under a relational test, with the variables tested (splitLines). */
  split: Map<number, Set<string>>;
  /** Test offset -> the offsets of its countdown run (countdownRuns). */
  runs: Map<number, readonly number[]>;
  /** Test offset -> the offsets of its compare run (compareRuns). */
  compares: Map<number, readonly number[]>;
  n: number;
  /** The run after arm-constant-call (switchChainLatePlugin). */
  late: boolean;
}

/** A test of the decision: its if, the parsed test and the instructions behind it. */
interface Node {
  ifs: IfStmt;
  test: Test;
  /** Per operand of the test, in text order. */
  ev: EqualityTest[];
  /** Per operand, the compared constant, unsigned at the instruction's size. */
  k: bigint[];
  /** Tied by its own condition's lines: an if a pass split off a decompiled `&&`. */
  split?: boolean;
}

/**
 * Where control goes for one value: the first statement that is not a test (the arm's rest
 * from there is the case's code), or null when every test falls through to the end.
 */
interface Leaf {
  /** The list holding it and its index there. */
  list: readonly Statement[];
  at: number;
}

class Decision {
  readonly nodes = new Map<IfStmt, Node>();
  /** The ifs read as `if (v == K) { if (R) B }`, with their printed condition and arm. */
  private readonly unfolded: Array<{ ifs: IfStmt; condition: Expression; thenBranch: Statement }> = [];
  /** Every leaf the tests can reach, in source order. */
  readonly leaves: Leaf[] = [];
  why: string | null = null;

  constructor(private readonly v: Expression, private readonly ctx: Ctx) {}

  /** A test of this decision: an if on the variable with one subtraction behind it. */
  testOf(s: Statement): Node | null | 'other' {
    if (s.kind !== NodeKind.IfStmt) return 'other';
    const ifs = s as IfStmt;
    if (ifs.init || ifs.isConstexpr) return 'other';
    let t = equality(ifs.condition, this.ctx.enums);
    const lead = t ? null : leadingTest(ifs, this.ctx.enums);
    if (lead) t = lead.test;
    if (!t || !same(t.v, this.v)) return 'other';
    const known = this.nodes.get(ifs);
    if (known) return known;
    const probe = lead ? ({ ...ifs, condition: lead.first } as IfStmt) : ifs;
    const own = this.ctx.reader.conditionTests(probe);
    const split = !own;
    const ev = own ?? this.ctx.reader.conditionTests(probe, true);
    if (!ev) { this.why = this.why ?? 'no-evidence'; return null; }
    if (ev.length !== t.ops.length) { this.why = this.why ?? 'tokens'; return null; }
    const ks: bigint[] = [];
    for (let j = 0; j < ev.length; j++) {
      const e = ev[j];
      const counted = SUBTRACTS.has(e.mnemonic) && e.k !== undefined && (e.delta !== undefined || this.ctx.runs.has(e.at));
      if (!counted && !(e.mnemonic === 'CMP' && e.k !== undefined && this.ctx.compares.has(e.at))) { this.why = this.why ?? 'compare'; return null; }
      const mask = (1n << BigInt(8 * e.size)) - 1n;
      const k = BigInt(e.k) & mask;
      const value = t.ops[j].value;
      if (value !== null && (value & mask) !== k) { this.why = this.why ?? 'value'; return null; }
      ks.push(k);
    }
    if (new Set(ks).size !== ks.length) { this.why = this.why ?? 'value'; return null; }
    if (lead) {
      this.unfolded.push({ ifs, condition: ifs.condition, thenBranch: ifs.thenBranch });
      ifs.condition = lead.first;
      ifs.thenBranch = Stmt.compound([lead.inner]);
    }
    const n: Node = { ifs, test: t, ev: [...ev], k: ks, ...(split ? { split: true } : {}) };
    this.nodes.set(ifs, n);
    return n;
  }

  /** Collect the tests and leaves under `list` (the decision part of an arm). */
  scan(list: readonly Statement[]): void {
    for (let i = 0; i < list.length; i++) {
      const n = this.testOf(list[i]);
      if (n === null) return;
      if (n === 'other') { this.leaves.push({ list, at: i }); return; }
      this.scan(asList(n.ifs.thenBranch));
      if (n.ifs.elseBranch) this.scan(asList(n.ifs.elseBranch));
    }
  }

  /**
   * Follow the tests for `val` (null: a value no test names): the leaf it reaches, with the
   * ifs it went through (list and index, outermost first), or null when it falls through
   * every test to the end of the decision.
   */
  follow(list: readonly Statement[], val: bigint | null, path: Frame[] = []): { leaf: Leaf; path: Frame[] } | null {
    for (let i = 0; i < list.length; i++) {
      const n = this.nodes.get(list[i] as IfStmt);
      if (!n) return { leaf: { list, at: i }, path };
      const eq = val !== null && n.k.includes(val);
      const arm = eq !== n.test.neg ? n.ifs.thenBranch : n.ifs.elseBranch;
      if (!arm) continue;
      const r = this.follow(asList(arm), val, [...path, { list, at: i }]);
      if (r !== null) return r;
    }
    return null;
  }

  /**
   * Where a leaf's code goes when it ends without leaving: the statement after the
   * innermost enclosing if that has one (another leaf), null for the end of the decision,
   * 'bad' when that is a further test.
   */
  next(path: readonly Frame[]): Leaf | null | 'bad' {
    for (let k = path.length - 1; k >= 0; k--) {
      const f = path[k];
      if (f.at + 1 >= f.list.length) continue;
      if (this.nodes.has(f.list[f.at + 1] as IfStmt)) return 'bad';
      return { list: f.list, at: f.at + 1 };
    }
    return null;
  }

  find(l: Leaf): Leaf | undefined {
    return this.leaves.find(x => x.list === l.list && x.at === l.at);
  }

  /** Put back every if read as two: the decision stays ifs as printed. */
  revert(): void {
    for (const u of this.unfolded.reverse()) {
      u.ifs.condition = u.condition;
      u.ifs.thenBranch = u.thenBranch;
    }
    this.unfolded.length = 0;
  }
}

/**
 * `if (v == K && R) B` with no else, the test `v == K` on lines of its own: that test, and
 * `if (R) B` to put in the arm. The operands are read in text order; `&&` evaluates the
 * same in either grouping.
 */
function leadingTest(ifs: IfStmt, enums: ReadonlySet<string>): { test: Test; first: Expression; inner: IfStmt } | null {
  if (ifs.elseBranch) return null;
  const leaves: Expression[] = [];
  const flatten = (e: Expression): void => {
    const u = unwrap(e);
    if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '&&') {
      flatten((u as BinaryExpr).left);
      flatten((u as BinaryExpr).right);
    } else leaves.push(e);
  };
  flatten(ifs.condition);
  if (leaves.length < 2) return null;
  const one = equalityOperand(leaves[0], enums);
  if (!one || one.neg) return null;
  const first = leaves[0];
  const rest = leaves.slice(1);
  const end = first.location?.end.line;
  if (end === undefined || rest.some(r => (r.location?.start.line ?? end) <= end)) return null;
  const cond = rest.slice(1).reduce<Expression>((l, r) => ({
    kind: NodeKind.BinaryExpr, operator: '&&', left: l, right: r, location: { start: l.location!.start, end: r.location!.end },
    leadingTrivia: [], trailingTrivia: [],
  }) as unknown as Expression, rest[0]);
  const inner = {
    kind: NodeKind.IfStmt, condition: cond, thenBranch: ifs.thenBranch, elseBranch: null, isConstexpr: false,
    location: { start: rest[0].location!.start, end: ifs.location?.end ?? rest[rest.length - 1].location!.end },
    leadingTrivia: [], trailingTrivia: [],
  } as unknown as IfStmt;
  return { test: { v: one.v, ops: [one.op], neg: false }, first, inner };
}

interface Frame {
  list: readonly Statement[];
  at: number;
}

/** `case A: case B: [default:] { body [break;] }`; a group without labels is its block alone. */
function labelled(labels: (Expression | null)[], body: Statement[], brk: boolean, at: ASTNode): Statement {
  let s: Statement = Stmt.compound(brk ? [...body, Stmt.break_()] : body);
  for (let i = labels.length - 1; i >= 0; i--) {
    const l = labels[i];
    s = l
      ? ({ kind: NodeKind.CaseStmt, value: l, statement: s, location: at.location, leadingTrivia: [], trailingTrivia: [] } as CaseStmt)
      : ({ kind: NodeKind.DefaultStmt, statement: s, location: at.location, leadingTrivia: [], trailingTrivia: [] } as DefaultStmt);
  }
  return s;
}

interface Group {
  labels: (Expression | null)[];
  body: Statement[];
  /** The group its code runs into, when it does not leave and is not the last. */
  into: Group | null;
  /** Ends by leaving. */
  leaves: boolean;
}

/**
 * The decision starting at `list[i]`: consecutive ifs testing one variable, their arms
 * testing it further, down to the first statement of each arm that is not such a test.
 * Returns the switch replacing `list[i..end)` when there is one, and `end` either way (a
 * refused decision's tail is not tried on its own). `inBlock`: `list` is a block's
 * statements, so what follows the decision may become a case's code.
 */
function decisionAt(list: readonly Statement[], i: number, ctx: Ctx, inBlock = true): { replace: Statement | null; end: number } | null {
  const head = list[i];
  if (head.kind !== NodeKind.IfStmt) return null;
  const t = equality((head as IfStmt).condition, ctx.enums);
  if (!t) return null;
  const d = new Decision(t.v, ctx);
  let end = i;
  while (end < list.length && d.testOf(list[end]) !== 'other' && !d.why) end++;
  const region = list.slice(i, end);
  const line = head.location?.start.line ?? 0;
  const left = (why: string, cases: number) => {
    d.revert();
    if (why !== 'no-evidence' && why !== 'tokens') ctx.onSite?.({ rule: 'left', line, cases, why });
    return { replace: null, end: Math.max(end, i + 1) };
  };
  if (d.why || !region.length) return left(d.why ?? 'no-evidence', 0);
  d.scan(region);
  if (d.why) return left(d.why, d.nodes.size);
  if (ctx.split.get(line)?.has(emit(t.v as never))) return left('split', d.nodes.size);
  if (!ctx.integral(t.v)) return left('type', d.nodes.size);

  // The tests are one whole countdown run.
  const nodes = [...d.nodes.values()];
  const ats = new Set(nodes.flatMap(n => n.ev.map(e => e.at)));
  const first = nodes[0].ev[0];
  // A compare run is a switch only over two ifs or more, each testing one constant: one
  // `if (v == A || v == B)` compiles to the same run, and a run with such a test among the
  // ifs is the original's if-chain as often as not (AI_BAAL_HasPowerfulSkill 005fc0c0,
  // Q12_UpdateQuestRecord 0059adb0, INPUT_HandleSysCommand 0044c570 match as ifs).
  const cmpSwitch = nodes.length >= 2 && nodes.every(n => n.ev.length === 1);
  const run = first.mnemonic === 'CMP' ? (cmpSwitch ? ctx.compares.get(first.at) : undefined) : ctx.runs.get(first.at);
  if (!run) return left('sum', nodes.length);
  // A split-off test counts only in a run of subtractions: a compare run of such tests is the
  // original's if-chain (QUESTLOG_ShowQuestDescription 004a27d0, `CMP CX,0xe8c; CMP CX,0xe8d`).
  if (first.mnemonic === 'CMP' && nodes.some(n => n.split)) return left('split-compare', nodes.length);
  if (run.length !== ats.size || run.some(a => !ats.has(a))) return left('partial', nodes.length);

  // Where each value goes, and where each leaf's code goes after it.
  const values = [...new Set(nodes.flatMap(n => n.k))].sort((a, b) => (a < b ? -1 : 1));
  const valuesOf = new Map<Leaf | null, (bigint | null)[]>();
  const nextOf = new Map<Leaf, Leaf | null | 'leaves'>();
  const visit = (leaf: Leaf, path: Frame[]): string | null => {
    if (nextOf.has(leaf)) return null;
    const body = leaf.list.slice(leaf.at) as Statement[];
    if (leaves(Stmt.compound(body), ctx.noreturn)) { nextOf.set(leaf, 'leaves'); return null; }
    const n = d.next(path);
    if (n === 'bad') return 'fallthrough';
    const target = n === null ? null : d.find(n);
    if (n !== null && !target) return 'leaf';
    nextOf.set(leaf, target ?? null);
    return null;
  };
  for (const val of [...values, null]) {
    const r = d.follow(region, val);
    const leaf = r === null ? null : d.find(r.leaf);
    if (r !== null && !leaf) return left('leaf', nodes.length);
    if (leaf && r) { const why = visit(leaf, r.path); if (why) return left(why, nodes.length); }
    valuesOf.set(leaf, [...(valuesOf.get(leaf) ?? []), val]);
  }
  // A leaf no value reaches directly may be where another one's code runs into: follow
  // those continuations too until nothing new appears.
  for (let grew = true; grew;) {
    grew = false;
    for (const to of [...nextOf.values()]) {
      if (!to || to === 'leaves' || nextOf.has(to)) continue;
      const r = pathTo(d, region, to);
      if (!r) return left('leaf', nodes.length);
      const why = visit(to, r);
      if (why) return left(why, nodes.length);
      grew = true;
    }
  }
  if (d.leaves.some(l => !valuesOf.has(l) && ![...nextOf.values()].includes(l))) return left('unreached', nodes.length);

  // Falling out: the code after the decision. When a value no test names goes there, the
  // values that fall out are the default's and the code stays after the switch. Otherwise
  // they get a case, and what follows in the block becomes its code when every other leaf
  // leaves or runs into another, at most one into the end.
  const fallOut = valuesOf.get(null) ?? [];
  const intoEnd = [...nextOf.values()].filter(x => x === null).length;
  const endGroup = fallOut.length > 0 && !fallOut.includes(null);
  const moveTail = endGroup && inBlock && intoEnd <= 1;
  // After arm-constant-call only a chain of ifs whose cases keep their own code is taken:
  // one `if (v != A && v != B)`, or a guard whose exit leads into the rest of the block, was
  // left by the first run for a reason the later passes do not change
  // (QUESTLOG_ShowQuestDescription 004a27d0 matches as the guard).
  if (ctx.late && (moveTail || nodes.length < 2)) return left('late-shape', nodes.length);
  const tail = moveTail ? (list.slice(end) as Statement[]) : [];
  const labelFor = (val: bigint | null): Expression | null => {
    if (val === null) return null;
    const n = nodes.find(x => x.k.includes(val))!;
    return n.test.ops[n.k.indexOf(val)].label;
  };

  const groups = new Map<Leaf | null, Group>();
  for (const l of d.leaves) {
    groups.set(l, { labels: (valuesOf.get(l) ?? []).map(labelFor), body: l.list.slice(l.at) as Statement[], into: null, leaves: nextOf.get(l) === 'leaves' });
  }
  if (endGroup) groups.set(null, { labels: fallOut.map(labelFor), body: tail, into: null, leaves: leaves(Stmt.compound(tail), ctx.noreturn) });
  const incoming = new Map<Group, number>();
  for (const [l, to] of nextOf) {
    if (to === 'leaves') continue;
    if (to === null && !moveTail) continue; // `break;` reaches the code after the switch
    const target = groups.get(to);
    if (!target) continue;
    groups.get(l)!.into = target;
    incoming.set(target, (incoming.get(target) ?? 0) + 1);
  }
  if ([...incoming.values()].some(c => c > 1)) return left('join', nodes.length);
  const all = [...groups.values()];
  if (all.some(g => freeBreakOrCase(g.body))) return left('break', nodes.length);
  if (!all.some(g => g.labels.some(x => x !== null))) return left('empty', nodes.length);
  for (const g of all) g.labels.sort((a, b) => (a === null ? 1 : b === null ? -1 : 0));

  // Chains of groups that run into each other, highest code address first (the bodies lie in
  // reverse source order); printed order where unknown.
  const heads = all.filter(g => !incoming.has(g));
  const after = Math.max(...nodes.flatMap(n => n.ev.map(e => e.at)));
  const entries = heads.map(g => ctx.reader.entry(g.body, after));
  const known = entries.every(e => e !== null) && new Set(entries).size === entries.length;
  const orderedHeads = known ? heads.map((g, k) => ({ g, e: entries[k]! })).sort((x, y) => y.e - x.e).map(x => x.g) : heads;
  const sequence: Group[] = [];
  for (let g of orderedHeads) {
    for (;;) {
      sequence.push(g);
      if (!g.into || sequence.length > all.length) break;
      g = g.into;
    }
  }
  if (sequence.length !== all.length) return left('cycle', nodes.length);
  // A `default` written last needs no `break;` (the switch ends there); a last `case` keeps
  // it, as switch-reconstruct writes them.
  const emitted = sequence.map((g, k) => labelled(g.labels, g.body,
    !g.leaves && !g.into && !(k === sequence.length - 1 && g.labels.includes(null)), head));

  const sw: SwitchStmt = {
    kind: NodeKind.SwitchStmt,
    condition: t.v,
    body: Stmt.compound(emitted),
    location: head.location,
    leadingTrivia: head.leadingTrivia ?? [],
    trailingTrivia: head.trailingTrivia ?? [],
  } as SwitchStmt;
  ctx.onSite?.({ rule: 'switch', line, cases: values.length });
  ctx.n++;
  return { replace: sw, end: moveTail ? list.length : end };
}

/** The ifs on the way from the decision's top to `leaf` (list and index, outermost first). */
function pathTo(d: Decision, region: readonly Statement[], leaf: Leaf): Frame[] | null {
  const walk = (list: readonly Statement[], path: Frame[]): Frame[] | null => {
    if (list === leaf.list) return path;
    for (let i = 0; i < list.length; i++) {
      const n = d.nodes.get(list[i] as IfStmt);
      if (!n) return null;
      for (const arm of [n.ifs.thenBranch, n.ifs.elseBranch]) {
        if (!arm) continue;
        const r = walk(asList(arm), [...path, { list, at: i }]);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(region, []);
}

/**
 * Lines of the ifs that sit under a relational test of a variable (`v < 5`), with that
 * variable: VC8 splits a larger switch by such a test and counts down each half, so a chain
 * there is a fragment of one switch, not a switch of its own. A variable the block assigns
 * before the chain holds a new value there, so the test above no longer splits it
 * (DRLGPRESET_AddPresetUnitToDrlgMap 00667620: `if (nClassId < nTableSize) .. else {
 * nTableSize = ..; if (nTableSize == 0x21) ..` is one countdown, `sub ecx, 0x21; je; dec ecx`).
 */
function splitLines(root: ASTNode): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  const visit = (n: ASTNode, under: readonly string[]): void => {
    let inner = under;
    if (n.kind === NodeKind.CompoundStmt && under.length) {
      let cur = under;
      for (const s of (n as CompoundStmt).statements) {
        visit(s, cur);
        const written = assignedBy(s);
        if (written) cur = cur.filter(u => u !== written);
      }
      return;
    }
    if (n.kind === NodeKind.IfStmt) {
      const i = n as IfStmt;
      if (i.location && under.length) {
        const set = out.get(i.location.start.line) ?? new Set<string>();
        under.forEach(u => set.add(u));
        out.set(i.location.start.line, set);
      }
      const c = unwrap(i.condition);
      if (c.kind === NodeKind.BinaryExpr && ['<', '<=', '>', '>='].includes((c as BinaryExpr).operator)) {
        const b = c as BinaryExpr;
        for (const side of [b.left, b.right]) {
          const x = unwrap(side);
          if (x.kind === NodeKind.CStyleCastExpr) { inner = [...inner, emit(unwrap((x as CStyleCastExpr).expression) as never)]; continue; }
          if (pureLvalue(x)) inner = [...inner, emit(x as never)];
        }
      }
      visit(i.thenBranch, inner);
      if (i.elseBranch) visit(i.elseBranch, inner);
      return;
    }
    for (const k of getChildren(n)) visit(k, inner);
  };
  visit(root, []);
  return out;
}

/** The variable a plain `v = ...;` statement assigns, as printed. */
function assignedBy(s: Statement): string | undefined {
  if (s.kind !== NodeKind.ExprStmt) return undefined;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr) return undefined;
  const left = unwrap((e as AssignExpr).left);
  return pureLvalue(left) ? emit(left as never) : undefined;
}

function rewriteList(list: readonly Statement[], ctx: Ctx): Statement[] | null {
  let out: Statement[] | null = null;
  for (let i = 0; i < list.length;) {
    const r = decisionAt(list, i, ctx);
    if (r?.replace) {
      out = out ?? list.slice(0, i);
      out.push(r.replace);
      i = r.end;
    } else if (r) {
      out?.push(...list.slice(i, r.end));
      i = r.end;
    } else {
      out?.push(list[i]);
      i++;
    }
  }
  return out;
}

function rewriteFunction(fn: FunctionDecl, ev: BranchLayoutEvidence, opts: SwitchChainOptions): FunctionDecl | undefined {
  if (!fn.body || !ev.tests || ev.tests.size === 0) return undefined;
  const locals = localTypes(fn.body);
  const enums = new Set(opts.enumTypes ?? []);
  for (const p of fn.parameters ?? []) {
    const name = (p as { name?: Identifier | string }).name;
    const pn = typeof name === 'string' ? name : name?.name;
    if (pn && !locals.has(pn)) { try { locals.set(pn, emit(p.type as never)); } catch { /* unknown */ } }
  }
  const typeOf = (v: Expression): string | undefined => {
    const e = unwrap(v);
    if (e.kind === NodeKind.Identifier) {
      const n = (e as Identifier).name;
      return locals.get(n) ?? opts.varTypes?.[n];
    }
    if (e.kind === NodeKind.QualifiedId) {
      // A global spelled with its namespace: the globals' types are keyed by the bare name.
      const q = (e as QualifiedId).name;
      return q.kind === NodeKind.Identifier ? opts.varTypes?.[(q as Identifier).name] : undefined;
    }
    if (e.kind === NodeKind.MemberExpr) {
      const me = e as MemberExpr;
      const m = me.member as Identifier | string;
      const field = typeof m === 'string' ? m : m.name;
      // The aggregate the member is read from, when the object's declared type names it:
      // exact where the field's name means different types in different aggregates.
      const agg = aggregateOf(typeOf(me.object), me.isArrow);
      const exact = agg !== undefined ? opts.structFields?.[agg]?.[field] : undefined;
      return exact ?? opts.fieldTypes?.[field];
    }
    return undefined;
  };
  const ctx: Ctx = {
    integral: v => integralType(typeOf(v), opts, enums),
    reader: new LayoutReader(ev, fn.body),
    enums: new Set(opts.enumConstants ?? []),
    noreturn: new Set([...DEFAULT_NORETURN_FUNCTIONS, ...(opts.noreturnFunctions ?? [])]),
    onSite: opts.onSite,
    late: !!opts.late,
    split: splitLines(fn.body),
    runs: countdownRuns(ev.tests),
    compares: compareRuns(ev.tests),
    n: 0,
  };
  const t = createTransformer({
    visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
      const r = rewriteList(block.statements, ctx);
      return r ? updateNode(block, { statements: r } as Partial<CompoundStmt>) : undefined;
    },
    visitIfStmt(node: IfStmt): ASTNode | undefined {
      // A chain hanging off an arm of a test on something else. When this if is itself a
      // link on the same variable, the chain starts higher up and is taken there whole.
      const self = equality(node.condition, ctx.enums);
      for (const key of ['thenBranch', 'elseBranch'] as const) {
        const arm = node[key];
        if (!arm || arm.kind !== NodeKind.IfStmt) continue;
        const head = equality((arm as IfStmt).condition, ctx.enums);
        if (!head || (self && key === 'elseBranch' && same(self.v, head.v))) continue;
        const r = decisionAt([arm], 0, ctx, false);
        if (r?.replace) return updateNode(node, { [key]: r.replace } as Partial<IfStmt>);
      }
      return undefined;
    },
  });
  const body = t(fn.body) as CompoundStmt;
  return ctx.n ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
}

export function switchChain_forTest(fn: FunctionDecl, opts: SwitchChainOptions): FunctionDecl {
  return opts.branchLayout ? rewriteFunction(fn, opts.branchLayout, opts) ?? fn : fn;
}

function createSwitchChainTransformer(options: SwitchChainOptions = {}): Transformer {
  const ev = options.branchLayout;
  if (!ev) return (node: ASTNode) => node;
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, ev, options);
    },
  });
}

export const switchChainPlugin: TransformPlugin = {
  id: 'switch-chain',
  name: 'Switch Chain',
  description:
    "Writes a switch back where the original tests the variable by running subtractions (VC8's lowering of a short switch) and the decompile prints an if-chain",
  version: '1.0.0',
  defaultEnabled: true,
  // Before switch-reconstruct (45), which would take a long else-if chain without evidence
  // and in value order; after compare-form (3), whose decisions are tied to the printed tests.
  priority: 44,
  tags: ['control-flow', 'layout'],
  createTransformer: createSwitchChainTransformer,
};

/**
 * The same rule once more after arm-constant-call (59.4). A switch whose cases each end in
 * their own copy of a call VC8 cross-jumped (`push 0x5a; jmp L` / `push 0x5b` into one CALL)
 * prints as one call after the if-chain, which joins two leaves and is refused at 44;
 * arm-constant-call writes the call back into each arm. Taken here only as a chain of two
 * ifs or more whose cases keep their own code (`late`). AITHINK_Fn1_ClawViper 005f1b60 and
 * AITHINK_Fn1_ClawViperEx 005f1de0 match with both of their `aip[5]` tests as switches.
 */
export const switchChainLatePlugin: TransformPlugin = {
  ...switchChainPlugin,
  id: 'switch-chain-late',
  name: 'Switch Chain (late)',
  // After arm-constant-call (59.4), before nest-call (59.5).
  priority: 59.45,
  createTransformer: (options: SwitchChainOptions = {}) => createSwitchChainTransformer({ ...options, late: true }),
};
