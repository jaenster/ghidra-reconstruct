/**
 * Param Check Block Plugin
 *
 * Storm opens its exported functions with a block of parameter checks that set
 * ERROR_INVALID_PARAMETER and leave when one fails. The block is not an `||` chain: every
 * check ANDs an all-ones-or-zero mask into one accumulator, all of them are evaluated, and one
 * test of the accumulator decides. VC8 compiles each check to `neg; sbb` (a null test) and
 * the accumulation to `and`, with a single conditional jump over `push 0x57` (SStrCmp, 00413550):
 *
 *     mov eax, esi ; neg eax ; sbb eax, eax       ; str_1 ? -1 : 0
 *     mov ecx, edi ; neg ecx ; sbb ecx, ecx       ; str_2 ? -1 : 0
 *     and eax, ecx ; jne ok
 *     push 0x57 ; call SErrSetLastError
 *
 * The decompiler folds the masks back into `if (!str_1 || !str_2) { SErrSetLastError(0x57);
 * return R; }`, which VC8 compiles to two tests and two jumps. This pass writes the block
 * back with the support macros (CHECK_BLOCK_SUPPORT_LINES):
 *
 *     D2_CHECKS_BEGIN;
 *     D2_CHECK(str_1);
 *     D2_CHECK(str_2);
 *     D2_CHECKS_END(SErr::SErrSetLastError(0x57), R);
 *
 * Gated on the original's instructions (branch-layout evidence, `tests`): the decompiler ties
 * each `==`/`!=` it folded out of a mask to the NEG that computed it, and a genuine `if`
 * ties it to a TEST or CMP. Every equality test of the condition must sit on a NEG, one per
 * leaf of its `||` chain, and no leaf may feed a conditional branch of its own (`operands`).
 * The checks are written in the order of those NEGs.
 *
 * Value-preserving: the `||` chain stops at the first failing check, the block evaluates them
 * all, so every leaf must be free of side effects and unable to fault: names, literals,
 * casts, `.` members and arithmetic other than division; no call, assignment, dereference,
 * `->`, subscript, `/`, `%` or nested `&&`/`||`/`?:`. The failure arm runs the same call and
 * returns the same value, after it as before. Shapes:
 *
 *   if (C) { fail; return R; }                     -> block ending in D2_CHECKS_END(fail, R)
 *   if (C) { fail; return; }                       -> block ending in D2_CHECKS_END_VOID(fail)
 *   if (C) { fail; } else E   followed by `return R;` (or the end of a void function)
 *                                                  -> the block, then E, then the return
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  AnyNode, ASTNode, BinaryExpr, CallExpr, CompoundStmt, DeclStmt, ExprStmt, Expression,
  FunctionDecl, IfStmt, IntegerLiteralExpr, MemberExpr, ParenExpr, ReturnStmt, Statement, UnaryExpr,
  VariableDecl, BuiltinType,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { LayoutReader, type BranchLayoutEvidence, type EqualityTest } from './branch-layout/evidence.js';
import { bareName } from './call-arg-cast.js';

export const CHECKS_BEGIN = 'D2_CHECKS_BEGIN';
export const CHECK = 'D2_CHECK';
export const CHECKS_END = 'D2_CHECKS_END';
export const CHECKS_END_VOID = 'D2_CHECKS_END_VOID';

/** The macros' text; the platform header includes it verbatim. C++03, so VC8 compiles it too. */
export const CHECK_BLOCK_SUPPORT_LINES: readonly string[] = [
  '// A parameter-check block (see param-check-block.ts): every D2_CHECK ANDs an all-ones or zero',
  '// mask into one accumulator, all checks are evaluated, and one test of it runs the failure arm.',
  '// VC8 compiles a check to neg/sbb and the accumulation to and; with the assumption after the block',
  '// it lays the block out as the original does. Other compilers need no assumption.',
  '#if defined(_MSC_VER)',
  '#define D2_CHECKS_ASSUME_(c) __assume(c)',
  '#else',
  '#define D2_CHECKS_ASSUME_(c) ((void)0)',
  '#endif',
  `#define ${CHECKS_BEGIN} do { int d2Checks_ = -1`,
  `#define ${CHECK}(c) d2Checks_ &= (c) ? -1 : 0`,
  `#define ${CHECKS_END}(fail, r) if (!d2Checks_) { fail; return r; } D2_CHECKS_ASSUME_(d2Checks_); } while (0)`,
  `#define ${CHECKS_END_VOID}(fail) if (!d2Checks_) { fail; return; } D2_CHECKS_ASSUME_(d2Checks_); } while (0)`,
];

export interface ParamCheckBlockOptions extends PluginOptions {
  /** Per-line instruction facts of the decompile (extract/branch-layout.ts); without them nothing changes. */
  branchLayout?: BranchLayoutEvidence | null;
  /** The function that records the failure (`SErrSetLastError`); unset, the pass is off. */
  errorSetter?: string;
  /** The code it is called with. */
  errorCode?: number;
  /** Called once per rewritten block. */
  onSite?: (site: { line: number; checks: number; form: 'return' | 'void' | 'else' }) => void;
  /** Called once per failure arm left as it is, with the reason. */
  onLeft?: (site: { line: number; why: string }) => void;
}

const stripParens = (e: Expression): Expression => {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
};

/** The leaves of a top-level `||` (or `&&`) chain, in text order. */
function chainLeaves(e: Expression, op: '||' | '&&', out: Expression[] = []): Expression[] {
  const x = stripParens(e);
  if (x.kind === NodeKind.BinaryExpr && (x as BinaryExpr).operator === op) {
    chainLeaves((x as BinaryExpr).left, op, out);
    chainLeaves((x as BinaryExpr).right, op, out);
  } else {
    out.push(x);
  }
  return out;
}

const PURE_UNARY = new Set(['+', '-', '!', '~', '&']);
const IMPURE_BINARY = new Set(['/', '%', '&&', '||']);

/** Whether evaluating `e` has no side effect and cannot fault, whatever the other checks found. */
function pureLeaf(e: Expression): boolean {
  for (const n of traverseAST(e)) {
    switch (n.kind) {
      case NodeKind.Identifier: case NodeKind.QualifiedId:
      case NodeKind.IntegerLiteral: case NodeKind.CharLiteral: case NodeKind.BoolLiteral:
      case NodeKind.NullptrLiteral: case NodeKind.ParenExpr:
      case NodeKind.CStyleCastExpr: case NodeKind.StaticCastExpr: case NodeKind.ReinterpretCastExpr:
        break;
      case NodeKind.UnaryExpr:
        if (!PURE_UNARY.has((n as UnaryExpr).operator)) return false;
        break;
      case NodeKind.BinaryExpr:
        if (IMPURE_BINARY.has((n as BinaryExpr).operator)) return false;
        break;
      case NodeKind.MemberExpr:
        if ((n as MemberExpr).isArrow) return false;
        break;
      default:
        // Types under a cast are not evaluated.
        if (String(n.kind).endsWith('Type')) break;
        return false;
    }
  }
  return true;
}

/** `!d`, written without a double negation where the leaf allows it. */
function negate(d: Expression): Expression {
  const x = stripParens(d);
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '!') return (x as UnaryExpr).operand;
  if (x.kind === NodeKind.BinaryExpr) {
    const b = x as BinaryExpr;
    if (b.operator === '==') return Expr.binary(b.left, '!=', b.right);
    if (b.operator === '!=') return Expr.binary(b.left, '==', b.right);
  }
  const atom = x.kind === NodeKind.Identifier || x.kind === NodeKind.QualifiedId || x.kind === NodeKind.MemberExpr;
  return Expr.unary('!', atom ? x : Expr.paren(x));
}

/** A macro argument may not hold a top-level comma. */
function macroArg(e: Expression): Expression {
  const x = stripParens(e);
  return x.kind === NodeKind.CommaExpr ? Expr.paren(x) : e;
}

/** Whether every path through `s` ends in a return. */
function alwaysLeaves(s: Statement): boolean {
  if (s.kind === NodeKind.ReturnStmt) return true;
  if (s.kind === NodeKind.CompoundStmt) {
    const ss = (s as CompoundStmt).statements;
    return ss.length > 0 && alwaysLeaves(ss[ss.length - 1]);
  }
  if (s.kind === NodeKind.IfStmt) {
    const i = s as IfStmt;
    return !!i.elseBranch && alwaysLeaves(i.thenBranch) && alwaysLeaves(i.elseBranch);
  }
  return false;
}

function isVoid(fn: FunctionDecl): boolean {
  const t = fn.returnType as ASTNode;
  return t.kind === NodeKind.BuiltinType && (t as BuiltinType).name === 'void' && (t as BuiltinType).modifiers.length === 0;
}

function statementsOf(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s];
}

function declaredNames(stmts: readonly Statement[]): string[] {
  const out: string[] = [];
  for (const s of stmts) {
    if (s.kind !== NodeKind.DeclStmt) continue;
    for (const d of (s as DeclStmt).declarations) {
      if (d.kind === NodeKind.VariableDecl) out.push((d as VariableDecl).name.name);
    }
  }
  return out;
}

function createParamCheckBlockTransformer(options: ParamCheckBlockOptions = {}): Transformer {
  const ev = options.branchLayout;
  const setter = options.errorSetter;
  const code = BigInt(options.errorCode ?? 0x57);

  /** The failure call `setter(code)`, or null. */
  const failCall = (s: Statement): Expression | null => {
    if (s.kind !== NodeKind.ExprStmt) return null;
    const c = (s as ExprStmt).expression;
    if (c.kind !== NodeKind.CallExpr) return null;
    const call = c as CallExpr;
    if (bareName(emit(call.callee as AnyNode)) !== setter || call.arguments.length !== 1) return null;
    const a = stripParens(call.arguments[0]);
    return a.kind === NodeKind.IntegerLiteral && (a as IntegerLiteralExpr).value === code ? call : null;
  };

  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!ev || !setter || !fn.body) return undefined;
      const top = fn.body.statements;
      if (!top.some(s => s.kind === NodeKind.IfStmt)) return undefined;
      const reader = new LayoutReader(ev, fn.body);
      const voidFn = isVoid(fn);
      let changed = false;
      const out: Statement[] = [];

      const outer = new Set([...declaredNames(top), ...fn.parameters.flatMap(p => (p.name ? [p.name.name] : []))]);
      /** An arm's statements at the function's top level; kept as a block where a name there would clash. */
      const splice = (arm: Statement | null): Statement[] => {
        if (!arm) return [];
        const stmts = statementsOf(arm);
        return arm.kind === NodeKind.CompoundStmt && declaredNames(stmts).some(n => outer.has(n)) ? [arm] : stmts;
      };
      /** `[fail]` or `[fail, return R]`: the call, and the return when there is one. */
      const failRun = (stmts: readonly Statement[]): { call: Expression; ret?: ReturnStmt } | null => {
        const call = stmts.length >= 1 && stmts.length <= 2 ? failCall(stmts[0]) : null;
        if (!call) return null;
        if (stmts.length === 1) return { call };
        return stmts[1].kind === NodeKind.ReturnStmt ? { call, ret: stmts[1] as ReturnStmt } : null;
      };
      /** The equality tests from the `if` keyword to its arm's opening line: a condition may wrap. */
      const headerTests = (ifs: IfStmt): readonly EqualityTest[] | null => {
        const own = reader.conditionTests(ifs);
        const arm = ifs.thenBranch.location;
        if (!own || !ev.tests || !arm || arm.file === '<generated>' || arm.start.line <= ifs.location.start.line) return own;
        const out: EqualityTest[] = [];
        for (let l = ifs.location.start.line; l <= arm.start.line; l++) out.push(...(ev.tests.get(l) ?? []));
        return out.length >= own.length ? out : own;
      };

      for (let i = 0; i < top.length; i++) {
        const s = top[i];
        if (s.kind !== NodeKind.IfStmt) { out.push(s); continue; }
        const ifs = s as IfStmt;
        const after = top.slice(i + 1);

        // Which arm fails, and what runs once the checks pass.
        let failing: { call: Expression; ret?: ReturnStmt } | null = failRun(statementsOf(ifs.thenBranch));
        let negated = true;
        let passArm: Statement | null = ifs.elseBranch;
        let consumed = 0;
        if (!failing && ifs.elseBranch) {
          failing = failRun(statementsOf(ifs.elseBranch));
          negated = false;
          passArm = ifs.thenBranch;
        }
        if (!failing && !ifs.elseBranch) {
          // `if (ok) { ...leaves... } fail; return R;`: the failure is what follows the if.
          failing = failRun(after);
          negated = false;
          passArm = ifs.thenBranch;
          consumed = after.length;
          if (failing && !alwaysLeaves(ifs.thenBranch)) failing = null;
        }
        if (!failing) { out.push(s); continue; }
        const left = (why: string) => { out.push(s); options.onLeft?.({ line: ifs.location?.start?.line ?? 0, why }); };

        // The failure leaves with the value it returns, or falls to the function's last return.
        let ret: Expression | null;
        if (failing.ret) {
          ret = failing.ret.value;
        } else if (consumed > 0 ? voidFn : after.length === 0 && voidFn) {
          ret = null;
        } else if (consumed === 0 && after.length === 1 && after[0].kind === NodeKind.ReturnStmt && (after[0] as ReturnStmt).value) {
          ret = (after[0] as ReturnStmt).value;
        } else { left('the failure does not leave by the last return'); continue; }
        if ((ret === null) !== voidFn) { left('return value against the function type'); continue; }
        const form: 'return' | 'void' | 'else' = passArm && negated ? 'else' : ret === null ? 'void' : 'return';

        const leaves = chainLeaves(ifs.condition, negated ? '||' : '&&');
        if (!leaves.every(pureLeaf)) { left('a check has a side effect or can fault'); continue; }
        const tests = headerTests(ifs);
        if (!tests || tests.length !== leaves.length) { left(`${tests?.length ?? 'no'} equality tests for ${leaves.length} checks`); continue; }
        if (!tests.every(t => t.mnemonic === 'NEG')) { left(`a test on ${tests.find(t => t.mnemonic !== 'NEG')!.mnemonic}, not a mask`); continue; }
        if (leaves.length > 1) {
          const ops = reader.operandBranches(ifs, leaves.length);
          if (ops && (ops.length !== leaves.length || ops.some(b => b.length > 0))) { left('a check feeds a branch of its own'); continue; }
        }

        const order = leaves.map((leaf, k) => ({ leaf, at: tests[k].at })).sort((a, b) => a.at - b.at);
        out.push(Stmt.expr(Expr.identifier(CHECKS_BEGIN)));
        for (const { leaf } of order) out.push(Stmt.expr(Expr.call(CHECK, [macroArg(negated ? negate(leaf) : leaf)])));
        out.push(Stmt.expr(ret === null
          ? Expr.call(CHECKS_END_VOID, [failing.call])
          : Expr.call(CHECKS_END, [failing.call, macroArg(ret)])));
        out.push(...splice(passArm));
        i += consumed;
        changed = true;
        options.onSite?.({ line: ifs.location?.start?.line ?? 0, checks: leaves.length, form });
      }
      if (!changed) return undefined;
      return updateNode(fn, { body: updateNode(fn.body, { statements: out } as Partial<CompoundStmt>) } as Partial<FunctionDecl>);
    },
  });
}

export { createParamCheckBlockTransformer };

export const paramCheckBlockPlugin: TransformPlugin = {
  id: 'param-check-block',
  name: 'Param Check Block',
  description: 'A Storm parameter check the original compiled as one neg/sbb mask chain, written back as a D2_CHECKS block',
  version: '1.0.0',
  defaultEnabled: true,
  // After the casts and names are final and storm-next-link (975), before assert-order (987)
  // and branch-layout (988) read the arms: the block has no arms left to order.
  priority: 980,
  tags: ['matching'],
  createTransformer: createParamCheckBlockTransformer,
};
