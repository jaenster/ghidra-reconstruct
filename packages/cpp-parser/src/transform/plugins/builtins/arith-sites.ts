/**
 * Three arithmetic spellings the decompiler normalises, put back as the instructions say
 * (reconstruct extract/arith-sites.ts reads them off the p-code and the listing, per line):
 *
 *   shift-multiply  `a * 2^k` whose INT_MULT came from a SHL by k, or from a byte MOV into a
 *                   high-byte register the block zeroed (`xor edx, edx; mov dh, b`), is the
 *                   shift, with a defined signed-result helper where needed. VC8 compiles the multiply of a byte as movzx + shl and
 *                   the shift as the high-byte load (OBJECT_ClientFn_OperateToOpened 004bde00).
 *                   An IMUL, LEA or ADD keeps the multiply.
 *   add-nesting     `x + a + b` the p-code computes as `x + (a + b)`: INT_ADD is associative to
 *                   Ghidra's printer, so the parentheses are lost from the text. Where the inner
 *                   sum is a two-operand ADD into the register of the variable `a` it reads, the
 *                   statement `x = x + a + b;` is the original's `a = a + b; x = x + a;`
 *                   (SKILLS_AddRandomSkillDamage 0056e170: `add eax, ebx; add [ecx + 8], eax`,
 *                   where `x = x + (a + b)` compiles to `lea edx, [eax + ebx]`).
 *   concat-widen    a CONCAT the p-code only widens, at no 8/16-bit zero-extension or mask, is
 *                   tagged; pseudo-op-lower then writes it without the truncation to its own
 *                   width, which the value never needs (DRAW_SetTransparentColorRGB 00605320).
 *
 * Every rewrite keeps the value:
 *   - A signed negative left shift is undefined in C++17. Proved integer operands which
 *     may be negative use d2_shift_left: shift their unsigned representation, then copy the
 *     bits back to the promoted signed type. Overloads preserve integral promotions and
 *     the exact result type of multiplication by an unsuffixed int literal. Unknown types
 *     and contexts requiring a constant expression keep the multiply.
 *   - `(x + a) + b` and `x + (a + b)` are the same value modulo 2^32 when both ops are 4-byte
 *     INT_ADDs (or the outer a PTRADD over a 4-byte index): the facts say so per op.
 *   - `a = a + b; x = x + a;` stores `a + b` into `a` as well: only where `a` is a 32-bit
 *     integer local or parameter, never address-taken, the statement in a block of the
 *     function or of an if (no loop, no switch), the function without a goto, nothing that
 *     runs after it naming `a`, and no call, assignment or increment in `x`, `a` or `b`.
 *   - A CONCAT's value is below 2^(8 * its width) by construction; dropping the truncation to
 *     that width drops nothing.
 *
 * Ties: per line, the operator tokens of a kind in text order against the AST's nodes of that
 * kind on the line, by the operator's position; a line whose counts differ is left alone. All
 * three run early, on the body as the decompiler printed it.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, ExprStmt, Expression, FunctionDecl, Identifier, IfStmt,
  IntegerLiteralExpr, ParenExpr, Statement, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST, findNodesByKind, getChildren } from '../../../ast/visitor.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { localTypesOf } from './compare-form.js';
import { collectLocalStructs, createExprShape, thisClassOf } from './expr-shape.js';
import { calleeName, shapeOfNode } from './call-arg-cast.js';
import { builtinTruthSite } from './truth-form-safety.js';
import type { SelectArgumentOptions } from './select-argument.js';

/** Emitted after d2_bits_as in d2_platform.h. Primitive overloads let C++ do the promotions. */
export const SHIFT_MULTIPLY_SUPPORT_LINES = [
  'static inline int d2_shift_left(int value, unsigned int count) { return d2_bits_as<int>((unsigned int)value << count); }',
  'static inline unsigned int d2_shift_left(unsigned int value, unsigned int count) { return value << count; }',
  'static inline long d2_shift_left(long value, unsigned int count) { return d2_bits_as<long>((unsigned long)value << count); }',
  'static inline unsigned long d2_shift_left(unsigned long value, unsigned int count) { return value << count; }',
  'static inline long long d2_shift_left(long long value, unsigned int count) { return d2_bits_as<long long>((unsigned long long)value << count); }',
  'static inline unsigned long long d2_shift_left(unsigned long long value, unsigned int count) { return value << count; }',
];

/** One item of a line, as reconstruct's extract/arith-sites.ts parses it. */
export type ArithFact =
  | { kind: 'mul'; log2?: number; evidence?: 'shift' | 'highbyte' | 'other' }
  | { kind: 'add'; consumer?: number; width: 'int' | 'ptr' | 'other'; into?: { input: number; name: string } }
  | { kind: 'concat'; bytes: number; widened: boolean };

export interface ArithSiteOptions extends PluginOptions {
  /** Parsed-text line -> its items in token order. Absent: nothing changes. */
  arith?: Map<number, ArithFact[]>;
  integerTypes?: Pick<SelectArgumentOptions, 'globalTypes' | 'enclosingVarTypes' | 'structFields' | 'fieldTypes' | 'functionReturnTypes' | 'typedefTargets'>;
  onSite?: (e: { line: number; rule: string }) => void;
}

const unparen = (e: Expression): Expression => {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
};

const generated = (n: ASTNode) => (n as { location?: { file?: string } }).location?.file === '<generated>';

/** The nodes of `kind` per line, in operator order (`pos` gives the operator's position). */
function byLine<T extends ASTNode>(body: ASTNode, keep: (n: ASTNode) => n is T, pos: (n: T) => number | undefined): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const n of traverseAST(body)) {
    if (!keep(n) || generated(n)) continue;
    const line = n.location?.start.line;
    if (line === undefined || pos(n) === undefined) continue;
    const l = out.get(line) ?? [];
    l.push(n);
    out.set(line, l);
  }
  for (const l of out.values()) l.sort((a, b) => pos(a)! - pos(b)!);
  return out;
}

const isBinary = (op: string) => (n: ASTNode): n is BinaryExpr => n.kind === NodeKind.BinaryExpr && (n as BinaryExpr).operator === op;
const opPos = (b: BinaryExpr) => b.right.location?.start?.offset;
const at = (n: ASTNode) => `${n.location?.start.line}:${n.location?.start.column}:${n.location?.start.offset}`;

/** The facts of a kind on a line, tied to the nodes when the counts agree. */
function tie<T>(facts: ArithFact[], kind: ArithFact['kind'], nodes: T[] | undefined): [ArithFact, T][] | null {
  const f = facts.filter(x => x.kind === kind);
  if (!nodes || f.length === 0 || f.length !== nodes.length) return null;
  return f.map((x, i) => [x, nodes[i]]);
}

// ============================================
// shift-multiply
// ============================================

const INTEGER_BASES = new Set(['bool', 'char', 'signed char', 'unsigned char', 'short', 'unsigned short',
  'int', 'unsigned int', 'long', 'unsigned long', 'long long', 'unsigned long long', 'wchar_t', 'char16_t', 'char32_t']);

/** The helper is ordinary inline C++03, not constexpr: keep compile-time and unevaluated uses. */
function runtimeShiftSite(fn: FunctionDecl, node: ASTNode, parents: Map<ASTNode, ASTNode>): boolean {
  if (fn.specifiers.some(s => s === 'constexpr' || s === 'consteval')) return false;
  for (let child = node, p = parents.get(child); p; child = p, p = parents.get(p)) {
    const parent = p as AnyNode;
    if ([NodeKind.ArrayType, NodeKind.TemplateType, NodeKind.ExprTemplateArg, NodeKind.EnumeratorDecl,
      NodeKind.StaticAssertDecl, NodeKind.SizeofExpr, NodeKind.AlignofExpr, NodeKind.DecltypeType,
      NodeKind.TypeidExpr, NodeKind.NoexceptExpr, NodeKind.LambdaExpr, NodeKind.FunctionDecl,
      NodeKind.ClassDecl, NodeKind.StructDecl, NodeKind.UnionDecl, NodeKind.FieldDecl, NodeKind.ParameterDecl].includes(p.kind)) return false;
    if (parent.kind === NodeKind.CaseStmt && child === parent.value) return false;
    if (parent.kind === NodeKind.IfStmt && parent.isConstexpr && child === parent.condition) return false;
    if (p.kind === NodeKind.VariableDecl) {
      const v = p as VariableDecl;
      if (v.specifiers.some(s => ['static', 'extern', 'thread_local', 'constexpr', 'constinit'].includes(s))
        || /\bconst\b/.test(emit(v.type as AnyNode))) return false;
    }
  }
  return true;
}

function rewriteMultiplies(fn: FunctionDecl, o: ArithSiteOptions): FunctionDecl | undefined {
  if (!fn.body || !o.arith) return undefined;
  const lines = byLine(fn.body, isBinary('*'), opPos);
  if (lines.size === 0) return undefined;
  const types = o.integerTypes ?? {};
  const resolve = (name: string) => types.typedefTargets?.[name];
  const locals = localTypesOf(fn);
  const shapeOf = createExprShape(locals, { ...types, returnTypes: types.functionReturnTypes, resolve,
    localStructs: collectLocalStructs(fn.body), thisClass: thisClassOf(fn, resolve) });
  const parents = new Map<ASTNode, ASTNode>();
  for (const n of traverseAST(fn.body)) for (const child of getChildren(n)) parents.set(child, n);
  const integerShape = (s: ReturnType<typeof shapeOf>): boolean => !!s && s.stars === 0 && INTEGER_BASES.has(s.base);
  // builtinTruthSite separately proves bindings and builtin operators; this only narrows
  // their scalar result to an integer. Never guess a class conversion or a pointer result.
  const integer = (expr: Expression): boolean => {
    const e = unparen(expr);
    switch (e.kind) {
      case NodeKind.IntegerLiteral: case NodeKind.CharLiteral: case NodeKind.BoolLiteral: return true;
      case NodeKind.BinaryExpr:
        if (['<', '<=', '>', '>=', '==', '!=', '&&', '||'].includes(e.operator)) return true;
        return integer(e.left) && integer(e.right);
      case NodeKind.ConditionalExpr: return integer(e.thenExpr) && integer(e.elseExpr);
      case NodeKind.AssignExpr: return integer(e.left);
      case NodeKind.UnaryExpr:
        if (e.operator === '!') return true;
        if (['+', '-', '~', '++', '--'].includes(e.operator)) return integer(e.operand);
        return e.operator === '*' && integerShape(shapeOf(e));
      case NodeKind.PostfixExpr: return integer(e.operand);
      case NodeKind.CallExpr: {
        // The model's named return type cannot type a local callable hiding that name.
        const name = calleeName(e.callee);
        return !!name && !locals.has(name) && integerShape(shapeOf(e));
      }
      case NodeKind.CStyleCastExpr: case NodeKind.StaticCastExpr: case NodeKind.ConstCastExpr:
      case NodeKind.ReinterpretCastExpr: case NodeKind.DynamicCastExpr: case NodeKind.FunctionalCastExpr:
        return integerShape(shapeOfNode(e.type, 0, resolve));
      default: return integerShape(shapeOf(e));
    }
  };
  const nonnegative = (expr: Expression): boolean => {
    const e = unparen(expr);
    if (e.kind === NodeKind.IntegerLiteral) return e.value >= 0n;
    if (e.kind === NodeKind.BoolLiteral || (e.kind === NodeKind.UnaryExpr && e.operator === '!')) return true;
    if (e.kind === NodeKind.BinaryExpr && ['<', '<=', '>', '>=', '==', '!=', '&&', '||'].includes(e.operator)) return true;
    // Restrict this to atoms: -unsignedShort has promoted type int and may be negative.
    if (![NodeKind.Identifier, NodeKind.QualifiedId, NodeKind.MemberExpr, NodeKind.SubscriptExpr,
      NodeKind.CallExpr, NodeKind.CStyleCastExpr].includes(e.kind)) return false;
    const s = shapeOf(e);
    return !!s && s.stars === 0 && (s.base === 'bool' || s.base.startsWith('unsigned '));
  };
  const take = new Map<string, { count: number; helper: boolean }>();
  for (const [line, facts] of o.arith) {
    for (const [f, b] of tie(facts, 'mul', lines.get(line)) ?? []) {
      if (f.kind !== 'mul' || f.log2 === undefined || !Number.isInteger(f.log2) || f.log2 < 0 || f.log2 > 30
        || (f.evidence !== 'shift' && f.evidence !== 'highbyte')) continue;
      const k = unparen(b.right);
      if (k.kind !== NodeKind.IntegerLiteral) continue;
      const lit = k as IntegerLiteralExpr;
      // An unsuffixed literal: the multiply's type is then the promoted left operand's.
      if (lit.suffix !== '' || lit.value !== 1n << BigInt(f.log2) || lit.value > 0x7fffffffn) continue;
      if (!builtinTruthSite(fn, b, b.left, types) || !integer(b.left)) continue;
      const helper = !nonnegative(b.left);
      if (helper && !runtimeShiftSite(fn, b, parents)) continue;
      take.set(at(b), { count: f.log2, helper });
      o.onSite?.({ line, rule: 'shift-multiply' });
    }
  }
  if (take.size === 0) return undefined;
  const t = createTransformer({
    visitBinaryExpr(node: BinaryExpr): ASTNode | undefined {
      if (node.operator !== '*' || !node.location) return undefined;
      const selected = take.get(at(node));
      if (!selected) return undefined;
      const k = selected.count;
      const count = Expr.intLiteral(k, k < 10 ? 10 : 16);
      if (selected.helper) return { ...Expr.call(Expr.qualifiedId(['d2_shift_left'], true), [node.left, count]), location: node.location };
      const shift = { ...Expr.binary(node.left, '<<', count), location: node.location } as BinaryExpr;
      return { ...Expr.paren(shift), location: node.location } as unknown as ASTNode;
    },
  });
  return updateNode(fn, { body: t(fn.body) } as Partial<FunctionDecl>);
}

// ============================================
// add-nesting
// ============================================

const INT32 = /^(?:u?int32_t|int|unsigned|unsigned int|signed int|uint|long|unsigned long|ulong|DWORD|LONG|ULONG|BOOL|UINT|INT|size_t|ssize_t|intptr_t|uintptr_t|undefined4)$/;

function is32BitInteger(t: TypeNode | undefined): boolean {
  if (!t) return false;
  return INT32.test(emit(t as unknown as AnyNode).replace(/\s+/g, ' ').trim());
}

interface Nesting {
  /** The outer node as printed, `(q.left + q.right) + right`. */
  outer: BinaryExpr;
  inner: BinaryExpr;
  /** The variable the inner sum is added into, when the facts say so. */
  into?: string;
}

function findNestings(fn: FunctionDecl, o: ArithSiteOptions): Map<string, Nesting> {
  const out = new Map<string, Nesting>();
  if (!fn.body || !o.arith) return out;
  const lines = byLine(fn.body, isBinary('+'), opPos);
  for (const [line, facts] of o.arith) {
    const pairs = tie(facts, 'add', lines.get(line));
    if (!pairs) continue;
    const index = new Map<BinaryExpr, number>(pairs.map(([, b], i) => [b, i]));
    pairs.forEach(([fp, p], ip) => {
      const q = unparen(p.left);
      if (q.kind !== NodeKind.BinaryExpr || (q as BinaryExpr).operator !== '+') return;
      const iq = index.get(q as BinaryExpr);
      if (iq === undefined) return;
      const fq = pairs[iq][0];
      if (fp.kind !== 'add' || fq.kind !== 'add') return;
      // The p-code nests the other way: q's op takes p's op's output.
      if (fp.consumer !== iq || fq.consumer === ip) return;
      // Two-term chains only: neither side is part of a longer printed chain.
      if (unparen((q as BinaryExpr).left).kind === NodeKind.BinaryExpr && (unparen((q as BinaryExpr).left) as BinaryExpr).operator === '+') return;
      if (fp.width !== 'int' || (fq.width !== 'int' && fq.width !== 'ptr')) return;
      // The inner sum is p's op: its inputs print as q.right and p.right, in that order.
      let into: string | undefined;
      if (fp.into) {
        const operand = unparen(fp.into.input === 0 ? (q as BinaryExpr).right : p.right);
        if (operand.kind === NodeKind.Identifier && (operand as Identifier).name === fp.into.name) into = fp.into.name;
      }
      out.set(at(p), { outer: p, inner: q as BinaryExpr, ...(into ? { into } : {}) });
      o.onSite?.({ line, rule: into ? 'add-into' : 'add-nesting' });
    });
  }
  return out;
}

/** Every identifier named `name` under `n`. */
function names(n: ASTNode, name: string): number {
  let c = 0;
  for (const x of traverseAST(n)) if (x.kind === NodeKind.Identifier && (x as Identifier).name === name) c++;
  return c;
}

/** No call, assignment or increment anywhere in it. */
function pure(n: ASTNode): boolean {
  for (const x of traverseAST(n)) {
    if (x.kind === NodeKind.CallExpr || x.kind === NodeKind.AssignExpr || x.kind === NodeKind.PostfixExpr) return false;
    if (x.kind === NodeKind.UnaryExpr && ((x as UnaryExpr).operator === '++' || (x as UnaryExpr).operator === '--')) return false;
  }
  return true;
}

function addressTaken(body: ASTNode, name: string): boolean {
  for (const x of traverseAST(body)) {
    if (x.kind !== NodeKind.UnaryExpr || (x as UnaryExpr).operator !== '&') continue;
    const e = unparen((x as UnaryExpr).operand);
    if (e.kind === NodeKind.Identifier && (e as Identifier).name === name) return true;
  }
  return false;
}

const LOOPS = new Set<string>([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt]);

function rewriteAdds(fn: FunctionDecl, o: ArithSiteOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const nest = findNestings(fn, o);
  if (nest.size === 0) return undefined;
  const types = localTypesOf(fn);
  const hasGoto = findNodesByKind(fn.body, NodeKind.GotoStmt).length > 0;
  // Statements in a loop body cannot be split: a later iteration may read `a`.
  const inLoop = new Set<ASTNode>();
  for (const n of traverseAST(fn.body)) if (LOOPS.has(n.kind)) for (const x of traverseAST(n)) inLoop.add(x);

  /** `x = x + a + b;` as the statement pair, or null. */
  const split = (s: Statement, rest: Statement[]): Statement[] | null => {
    if (s.kind !== NodeKind.ExprStmt || hasGoto || inLoop.has(s)) return null;
    const a = unparen((s as ExprStmt).expression);
    if (a.kind !== NodeKind.AssignExpr || (a as AssignExpr).operator !== '=') return null;
    const right = unparen((a as AssignExpr).right);
    if (right.kind !== NodeKind.BinaryExpr || !right.location) return null;
    const n = nest.get(at(right));
    if (!n?.into) return null;
    const x = n.inner.left;
    if (emit(unparen(x) as unknown as AnyNode) !== emit(unparen((a as AssignExpr).left) as unknown as AnyNode)) return null;
    const v = n.into;
    if (!is32BitInteger(types.get(v)) || addressTaken(fn.body!, v)) return null;
    if (names(unparen(x), v) > 0) return null;
    // The split evaluates the other operand before the target: neither may have an effect.
    if (!pure(x) || !pure(n.inner.right) || !pure(n.outer.right)) return null;
    if (rest.some(r => names(r, v) > 0)) return null;
    const other = unparen(n.inner.right).kind === NodeKind.Identifier && (unparen(n.inner.right) as Identifier).name === v ? n.outer.right : n.inner.right;
    const loc = { location: s.location };
    const first = { ...Stmt.expr({ ...Expr.assign(Expr.identifier(v), { ...Expr.binary(Expr.identifier(v), '+', other), ...loc } as Expression), ...loc } as Expression), ...loc } as Statement;
    const second = {
      ...s,
      expression: { ...a, right: { ...Expr.binary(x, '+', Expr.identifier(v)), ...loc } },
    } as unknown as Statement;
    return [first, second];
  };

  // A statement is split in a block of the function's own or of an if's arms, never under a
  // loop or a switch; what runs after it is the rest of its block and of every enclosing block.
  const done = new Set<string>();
  const walk = (s: Statement, after: Statement[]): Statement => {
    if (s.kind === NodeKind.CompoundStmt) {
      const block = s as CompoundStmt;
      let changed = false;
      const next: Statement[] = [];
      block.statements.forEach((c, i) => {
        const rest = [...block.statements.slice(i + 1), ...after];
        const pair = split(c, rest);
        if (pair) {
          next.push(...pair);
          changed = true;
          done.add(at(unparen(((c as ExprStmt).expression as AssignExpr).right)));
          return;
        }
        const w = walk(c, rest);
        if (w !== c) changed = true;
        next.push(w);
      });
      return changed ? ({ ...block, statements: next } as CompoundStmt) : s;
    }
    if (s.kind === NodeKind.IfStmt) {
      const f = s as IfStmt;
      const thenBranch = walk(f.thenBranch, after);
      const elseBranch = f.elseBranch ? walk(f.elseBranch, after) : f.elseBranch;
      return thenBranch !== f.thenBranch || elseBranch !== f.elseBranch ? ({ ...f, thenBranch, elseBranch } as IfStmt) : s;
    }
    return s;
  };
  const body: Statement = walk(fn.body, []);
  // Every other nesting the facts give: `x + (a + b)`.
  const t = createTransformer({
    visitBinaryExpr(node: BinaryExpr): ASTNode | undefined {
      if (node.operator !== '+' || !node.location) return undefined;
      const n = nest.get(at(node));
      if (!n || done.has(at(node))) return undefined;
      const inner = { ...Expr.binary(n.inner.right, '+', node.right), location: node.right.location } as BinaryExpr;
      return { ...Expr.binary(n.inner.left, '+', { ...Expr.paren(inner), location: node.right.location } as Expression), location: node.location } as unknown as ASTNode;
    },
  });
  return updateNode(fn, { body: t(body as ASTNode) } as Partial<FunctionDecl>);
}

// ============================================
// concat-widen
// ============================================

function tagConcats(fn: FunctionDecl, o: ArithSiteOptions): FunctionDecl | undefined {
  if (!fn.body || !o.arith) return undefined;
  const isConcat = (n: ASTNode): n is CallExpr => n.kind === NodeKind.CallExpr && (n as CallExpr).callee.kind === NodeKind.Identifier
    && /^CONCAT\d+$/.test(((n as CallExpr).callee as Identifier).name);
  const lines = byLine(fn.body, isConcat, c => c.location?.start?.offset);
  const take = new Set<string>();
  for (const [line, facts] of o.arith) {
    for (const [f, c] of tie(facts, 'concat', lines.get(line)) ?? []) {
      if (f.kind !== 'concat' || !f.widened) continue;
      take.add(at(c));
      o.onSite?.({ line, rule: 'concat-widen' });
    }
  }
  if (take.size === 0) return undefined;
  const t = createTransformer({
    visitCallExpr(node: CallExpr): ASTNode | undefined {
      if (!node.location || !take.has(at(node))) return undefined;
      return updateNode(node, { ghidraInfo: { ...(node.ghidraInfo ?? {}), concatWidened: true } } as Partial<ASTNode>);
    },
  });
  return updateNode(fn, { body: t(fn.body) } as Partial<FunctionDecl>);
}

function plugin(id: string, name: string, description: string, run: (fn: FunctionDecl, o: ArithSiteOptions) => FunctionDecl | undefined): TransformPlugin {
  return {
    id,
    name,
    description,
    version: '1.0.0',
    defaultEnabled: true,
    // Early, on the body as the decompiler printed it: the facts are tied to that text.
    priority: 3,
    tags: ['matching'],
    createTransformer: (options: ArithSiteOptions = {}): Transformer => createTransformer({
      visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
        return run(node, options);
      },
    }),
  };
}

export const shiftMultiplyPlugin = plugin('shift-multiply', 'Shift Multiply',
  'A proved integer multiply the original shifted uses a shift with defined signed-result semantics', rewriteMultiplies);
export const addNestingPlugin = plugin('add-nesting', 'Add Nesting',
  'A sum the p-code nests to the right is written so, and an in-place add into a variable as its own statement', rewriteAdds);
export const concatWidenPlugin = plugin('concat-widen', 'Concat Widen',
  'Tags a CONCAT the p-code only widens, so pseudo-op-lower drops its truncation', tagConcats);
