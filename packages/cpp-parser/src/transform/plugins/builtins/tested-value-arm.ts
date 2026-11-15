/**
 * Tested Value Arm Plugin
 *
 * An if-chain that tests one variable against constants, where each arm does what the
 * final else does with the tested constant written in place of the variable
 * (DispatchCpuidCall, 0040e9e0):
 *
 *     if (nLeaf == 0) r = D2_Cpuid(0);
 *     else if (nLeaf == 1) r = D2_Cpuid(1);
 *     ...
 *     else if (nLeaf == -0x7ffffffe) r = D2_Cpuid(0x80000002);
 *     else r = D2_Cpuid(nLeaf);
 *
 * The decompiler spells one `cpuid` per leaf because it names the leaves; the original
 * is a single CPUID on the argument. Every such arm is the else arm evaluated with the
 * value the test just proved the variable holds, so its test can go:
 *
 *     r = D2_Cpuid(nLeaf);
 *
 * Value-preserving: in `if (V == c) A else B` with A equal to B with c for V, A runs only
 * when V holds c, where it computes what B computes. Dropping one arm of a chain keeps
 * the earlier tests, so each arm is judged on its own. Made only when:
 *   - V is a parameter or a local of the function, a plain integer of at most 32 bits,
 *     never address-taken (`&V`) anywhere in the function, and the else arm writes no V;
 *   - the test is `V == c`, `c == V` or `!V` (c = 0), c an integer literal;
 *   - each arm and the else arm are one expression or return statement, and the arm is
 *     the else arm with some direct call arguments `V` replaced by a literal of the
 *     value V holds there. A call argument converts by value, so the literal and V give
 *     the parameter the same value. When V is compared in unsigned arithmetic (a 32-bit
 *     unsigned V) a negative c means V holds c + 2^32; the arm's literal must carry
 *     exactly that value. A literal that equals V only modulo 2^32 is accepted only as an
 *     argument of a callee whose parameter is known to be 32 bits (D2_Cpuid, the
 *     platform header's `int D2_Cpuid(uint32_t)`).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  AnyNode, ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl,
  Identifier, IfStmt, IntegerLiteralExpr, ParameterDecl, ParenExpr, PostfixExpr, ReturnStmt, Statement,
  UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import { emit } from '../../../emit/index.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { childStatements, withChildStatements } from './stmt-structure.js';

export interface TestedValueArmOptions extends PluginOptions {
  onSite?: (e: { variable: string; arms: number; collapsed: boolean }) => void;
}

/** Callees whose every integer parameter is 32 bits wide. */
const THIRTY_TWO_BIT_PARAMS = new Set(['D2_Cpuid']);

const SIGNED_NARROW = new Set([
  'int', 'signed', 'signed int', 'long', 'long int', 'signed long', 'int32_t', 'LONG', 'INT', 'BOOL',
  'short', 'short int', 'signed short', 'int16_t', 'SHORT', 'char', 'signed char', 'int8_t', 'CHAR',
  'uint8_t', 'unsigned char', 'BYTE', 'UCHAR', 'byte', 'uint16_t', 'unsigned short', 'unsigned short int',
  'WORD', 'USHORT', 'ushort',
]);
const UNSIGNED_32 = new Set([
  'uint32_t', 'unsigned', 'unsigned int', 'unsigned long', 'unsigned long int', 'uint', 'DWORD', 'UINT',
  'ULONG', 'ulong',
]);

type Arith = 'signed' | 'unsigned32';

function unparen(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** The value of an integer literal, possibly negated; null for anything else. */
function literalValue(e: Expression): bigint | null {
  let x = unparen(e);
  let neg = false;
  while (x.kind === NodeKind.UnaryExpr && ((x as UnaryExpr).operator === '-' || (x as UnaryExpr).operator === '+')) {
    if ((x as UnaryExpr).operator === '-') neg = !neg;
    x = unparen((x as UnaryExpr).operand);
  }
  if (x.kind !== NodeKind.IntegerLiteral) return null;
  const v = (x as IntegerLiteralExpr).value;
  return neg ? -v : v;
}

function isIdent(e: Expression, name: string): boolean {
  const x = unparen(e);
  return x.kind === NodeKind.Identifier && (x as Identifier).name === name;
}

/** `V == c`, `c == V`, `!V` -> [V, c]. */
function testOf(cond: Expression): [string, bigint] | null {
  const c = unparen(cond);
  if (c.kind === NodeKind.UnaryExpr && (c as UnaryExpr).operator === '!') {
    const o = unparen((c as UnaryExpr).operand);
    if (o.kind === NodeKind.Identifier) return [(o as Identifier).name, 0n];
    return null;
  }
  if (c.kind !== NodeKind.BinaryExpr || (c as BinaryExpr).operator !== '==') return null;
  const b = c as BinaryExpr;
  const l = unparen(b.left), r = unparen(b.right);
  if (l.kind === NodeKind.Identifier) {
    const v = literalValue(r);
    if (v !== null) return [(l as Identifier).name, v];
  }
  if (r.kind === NodeKind.Identifier) {
    const v = literalValue(l);
    if (v !== null) return [(r as Identifier).name, v];
  }
  return null;
}

/** The one statement of an arm: an expression or return statement, alone or braced alone. */
function soleStatement(s: Statement): ExprStmt | ReturnStmt | null {
  let x: Statement = s;
  while (x.kind === NodeKind.CompoundStmt) {
    const st = (x as CompoundStmt).statements;
    if (st.length !== 1) return null;
    x = st[0];
  }
  if (x.kind === NodeKind.ExprStmt) return x as ExprStmt;
  if (x.kind === NodeKind.ReturnStmt && (x as ReturnStmt).value) return x as ReturnStmt;
  return null;
}

function calleeIdent(call: CallExpr): string | null {
  const c = unparen(call.callee);
  return c.kind === NodeKind.Identifier ? (c as Identifier).name : null;
}

const MOD32 = 1n << 32n;
const mod32 = (v: bigint) => ((v % MOD32) + MOD32) % MOD32;

/**
 * The arm with every direct call argument that is a literal of V's value (on that arm)
 * replaced by V. `held` is the value V holds when the arm runs.
 */
function generalise(stmt: Statement, name: string, held: bigint): Statement {
  const copy = cloneNode(stmt);
  for (const n of traverseAST(copy)) {
    if (n.kind !== NodeKind.CallExpr) continue;
    const call = n as CallExpr;
    const wide32 = THIRTY_TWO_BIT_PARAMS.has(calleeIdent(call) ?? '');
    call.arguments = call.arguments.map(a => {
      const v = literalValue(a);
      if (v === null) return a;
      if (v === held || (wide32 && mod32(v) === mod32(held))) {
        return { kind: NodeKind.Identifier, name } as Identifier as Expression;
      }
      return a;
    });
  }
  return copy;
}

function writesName(stmt: ASTNode, name: string): boolean {
  for (const n of traverseAST(stmt)) {
    if (n.kind === NodeKind.AssignExpr && isIdent((n as AssignExpr).left, name)) return true;
    if (n.kind === NodeKind.PostfixExpr && isIdent((n as PostfixExpr).operand, name)) return true;
    if (n.kind === NodeKind.UnaryExpr) {
      const u = n as UnaryExpr;
      if ((u.operator === '++' || u.operator === '--') && isIdent(u.operand, name)) return true;
    }
  }
  return false;
}

interface FnFacts {
  arith: Map<string, Arith>;
  addressTaken: Set<string>;
}

function factsOf(fn: FunctionDecl): FnFacts {
  const arith = new Map<string, Arith>();
  const declared = new Map<string, number>();
  const note = (name: string, typeText: string) => {
    declared.set(name, (declared.get(name) ?? 0) + 1);
    const t = typeText.replace(/\s+/g, ' ').trim();
    if (SIGNED_NARROW.has(t)) arith.set(name, 'signed');
    else if (UNSIGNED_32.has(t)) arith.set(name, 'unsigned32');
  };
  for (const p of fn.parameters as ParameterDecl[]) {
    if (p.name) note(p.name.name, emit(p.type as unknown as AnyNode));
  }
  const addressTaken = new Set<string>();
  if (fn.body) {
    for (const n of traverseAST(fn.body)) {
      if (n.kind === NodeKind.DeclStmt) {
        for (const d of (n as DeclStmt).declarations) {
          if (d.kind !== NodeKind.VariableDecl) continue;
          const v = d as VariableDecl;
          if (v.specifiers.some(s => s === 'static' || s === 'extern')) {
            declared.set(v.name.name, 2);
            continue;
          }
          note(v.name.name, emit(v.type as unknown as AnyNode));
        }
      } else if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
        const o = unparen((n as UnaryExpr).operand);
        if (o.kind === NodeKind.Identifier) addressTaken.add((o as Identifier).name);
      }
    }
  }
  for (const [name, count] of declared) if (count !== 1) arith.delete(name);
  return { arith, addressTaken };
}

/** Rewrite one if-chain, dropping every arm that is the else arm at the tested value. */
function collapseChain(s: IfStmt, facts: FnFacts, opts: TestedValueArmOptions): Statement | null {
  const arms: { stmt: IfStmt; name: string; value: bigint }[] = [];
  let cur: Statement = s;
  while (cur.kind === NodeKind.IfStmt) {
    const i = cur as IfStmt;
    if (i.init || i.isConstexpr || !i.elseBranch) return null;
    const t = testOf(i.condition);
    if (!t) return null;
    arms.push({ stmt: i, name: t[0], value: t[1] });
    let next: Statement = i.elseBranch;
    while (next.kind === NodeKind.CompoundStmt && (next as CompoundStmt).statements.length === 1
      && (next as CompoundStmt).statements[0].kind === NodeKind.IfStmt) {
      next = (next as CompoundStmt).statements[0];
    }
    cur = next;
  }
  const name = arms[0].name;
  if (arms.some(a => a.name !== name)) return null;
  const arith = facts.arith.get(name);
  if (!arith || facts.addressTaken.has(name)) return null;
  const tail = soleStatement(cur);
  if (!tail || writesName(tail, name)) return null;
  const want = emit(tail as unknown as AnyNode);
  if (!want.includes(name)) return null;

  const keep: typeof arms = [];
  for (const a of arms) {
    const body = soleStatement(a.stmt.thenBranch);
    let held: bigint | null = a.value;
    if (arith === 'unsigned32') {
      if (a.value < 0n) held = a.value >= -(1n << 31n) ? a.value + MOD32 : null;
      else if (a.value >= MOD32) held = null;
    } else if (a.value < -(1n << 31n) || a.value >= (1n << 31n)) {
      held = null;
    }
    const same = body !== null && held !== null
      && emit(generalise(body, name, held) as unknown as AnyNode) === want;
    if (!same) keep.push(a);
  }
  if (keep.length === arms.length) return null;
  opts.onSite?.({ variable: name, arms: arms.length, collapsed: keep.length === 0 });

  // Every arm gone: the else arm's one statement stands alone, without its braces.
  let out: Statement = keep.length === 0 ? tail : cur;
  for (let k = keep.length - 1; k >= 0; k--) {
    out = updateNode(keep[k].stmt, { elseBranch: out } as Partial<IfStmt>);
  }
  return out;
}

function rewrite(s: Statement, facts: FnFacts, opts: TestedValueArmOptions): Statement {
  if (s.kind === NodeKind.IfStmt) {
    const c = collapseChain(s as IfStmt, facts, opts);
    if (c) return rewrite(c, facts, opts);
  }
  const kids = childStatements(s);
  if (kids.length === 0) return s;
  let changed = false;
  const nk = kids.map(k => {
    const r = rewrite(k, facts, opts);
    if (r !== k) changed = true;
    return r;
  });
  return changed ? withChildStatements(s, nk) : s;
}

function createTestedValueArmTransformer(options: TestedValueArmOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      const facts = factsOf(node);
      if (facts.arith.size === 0) return undefined;
      const body = rewrite(node.body, facts, options);
      if (body === node.body) return undefined;
      return updateNode(node, { body: body as CompoundStmt } as Partial<FunctionDecl>);
    },
  });
}

export const testedValueArmPlugin: TransformPlugin = {
  id: 'tested-value-arm',
  name: 'Tested Value Arm Collapse',
  description: 'Drops an if-chain arm that is the else arm with the tested constant for the variable',
  version: '1.0.0',
  defaultEnabled: true,
  // After pseudo-op-lower (20) names D2_Cpuid, before switch-chain (44) turns the chain
  // into nested switches.
  priority: 21.5,
  tags: ['matching', 'control-flow'],
  createTransformer: createTestedValueArmTransformer,
};
