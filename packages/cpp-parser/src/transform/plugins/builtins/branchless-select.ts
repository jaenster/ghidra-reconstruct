/**
 * Branchless Select Plugin
 *
 * Transforms the compiler/decompiler "(cond - 1) & mask" branchless select
 * idiom back into a readable ternary. This is the dual of the SBB pattern
 * handled by sbb-branchless (`-(cond) & x`).
 *
 * x86 compilers materialize a boolean (0/1), do `dec` (→ 0 or -1 all-bits),
 * `and mask`, optionally `add offset`. Ghidra decompiles this as:
 *
 *   (cond - 1 & mask)            // cond ? 0 : mask
 *   (cond - 1 & mask) + offset   // cond ? offset : offset+mask
 *
 * Transforms:
 * - (C) - 1 & M          →  C ? 0 : M
 * - (C) - 1U & M         →  C ? 0 : M
 * - ((C) - 1 & M) + V    →  C ? V : (V + M)
 *   e.g. ((0x14 < n) - 1 & -21) + 0x14  →  0x14 < n ? 0x14 : -1
 *
 * `C` must be a comparison (< > <= >= == !=) or `!expr` so we never rewrite a
 * genuine bitmask on a non-boolean value.
 *
 * Where the arithmetic runs in an enum's type Ghidra spells the 1 with the enum's name
 * (`((int)eSkill < 1) - SKILL_Kick`, SKILL_Kick = 1): the constant is read by its value.
 * A non-constant mask is selected the same way when it is pure - `E & ((C) - 1)` is
 * `C ? 0 : E`, and `X &= (C) - 1` is `X = C ? 0 : X` (MISSILE_ClampSkillLevel's
 * `eSkill & ((int)eSkill < 1) - SKILL_Kick`, a clamp to 0) - since E is then read once
 * either way.
 *
 * SETcc + ADD over an enum: `(C) + K` and `K - (C)`, K an enum constant, is the select
 * `C ? K+1 : K` / `C ? K-1 : K` between two members of that enum (GAMBLE's
 * `(set + unique <= roll) + QUALITY_SET` is QUALITY_RARE or QUALITY_SET; zlib's
 * `(avail_out != 0) + finish_started` is finish_done or finish_started). Rewritten only
 * where exactly one member of K's enum has the neighbouring value, and spelled with it.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  AssignExpr,
  Identifier,
  Expression,
  BinaryExpr,
  UnaryExpr,
  ConditionalExpr,
  IntegerLiteralExpr,
  ParenExpr,
} from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { isPure } from './pseudo-op-lower.js';
import { memoOnInputs, type MemoSlot } from './input-memo.js';

const CMP_OPS = new Set(['<', '>', '<=', '>=', '==', '!=']);

function unwrapParens(expr: Expression): Expression {
  while (expr.kind === NodeKind.ParenExpr) {
    expr = (expr as ParenExpr).expression;
  }
  return expr;
}

/** Unambiguous enum constant name -> value (the select reads a named 1 as a 1). */
let enumValueOf: ReadonlyMap<string, bigint> = new Map();

/** Integer value of a literal or +/- unary-wrapped literal, else null. */
function intVal(expr: Expression): bigint | null {
  const e = unwrapParens(expr);
  if (e.kind === NodeKind.IntegerLiteral) return (e as IntegerLiteralExpr).value;
  if (e.kind === NodeKind.UnaryExpr) {
    const u = e as UnaryExpr;
    if (u.operator === '-') {
      const v = intVal(u.operand);
      return v === null ? null : -v;
    }
    if (u.operator === '+') return intVal(u.operand);
  }
  return null;
}

/** A comparison, `!x`, or a `&&`/`||` of them: a 0/1 value. */
function isBoolean(expr: Expression): boolean {
  const e = unwrapParens(expr);
  if (isComparison(e)) return true;
  if (e.kind === NodeKind.BinaryExpr) {
    const b = e as BinaryExpr;
    return (b.operator === '&&' || b.operator === '||') && isBoolean(b.left) && isBoolean(b.right);
  }
  return false;
}

/** True if `expr` is a boolean-valued comparison (so the idiom is a select). */
function isComparison(expr: Expression): boolean {
  const e = unwrapParens(expr);
  if (e.kind === NodeKind.BinaryExpr) return CMP_OPS.has((e as BinaryExpr).operator);
  if (e.kind === NodeKind.UnaryExpr) return (e as UnaryExpr).operator === '!';
  return false;
}

/** A literal's value, or an enum constant's. */
function constVal(expr: Expression): bigint | null {
  const v = intVal(expr);
  if (v !== null) return v;
  const e = unwrapParens(expr);
  return e.kind === NodeKind.Identifier ? enumValueOf.get((e as Identifier).name) ?? null : null;
}

/** Match `(C) - 1` where C is a comparison; return C. */
function matchCondMinusOne(expr: Expression): Expression | null {
  const e = unwrapParens(expr);
  if (e.kind !== NodeKind.BinaryExpr) return null;
  const sub = e as BinaryExpr;
  if (sub.operator !== '-') return null;
  if (constVal(sub.right) !== 1n) return null;
  const cond = unwrapParens(sub.left);
  return isComparison(cond) ? cond : null;
}

/**
 * Match `(C) - 1 & M` (either operand order). Returns { cond, mask }.
 */
function matchSelect(node: BinaryExpr): { cond: Expression; mask: bigint } | null {
  if (node.operator !== '&') return null;
  // try left = (C-1), right = M
  let cond = matchCondMinusOne(node.left);
  let mask = intVal(node.right);
  if (cond !== null && mask !== null) return { cond, mask };
  // try commuted: left = M, right = (C-1)
  cond = matchCondMinusOne(node.right);
  mask = intVal(node.left);
  if (cond !== null && mask !== null) return { cond, mask };
  return null;
}

function makeLit(src: ASTNode, value: bigint): IntegerLiteralExpr {
  // 0 → "0"; negatives → decimal (-1); else hex (0x1f)
  const decimal = value <= 0n;
  return {
    kind: NodeKind.IntegerLiteral,
    value,
    suffix: '',
    base: decimal ? 10 : 16,
    raw: decimal ? value.toString(10) : '0x' + value.toString(16),
    location: src.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
}

function makeConditional(
  src: ASTNode,
  condition: Expression,
  thenExpr: Expression,
  elseExpr: Expression
): ConditionalExpr {
  return {
    kind: NodeKind.ConditionalExpr,
    condition,
    thenExpr,
    elseExpr,
    location: src.location,
    leadingTrivia: src.leadingTrivia || [],
    trailingTrivia: src.trailingTrivia || [],
  };
}

interface EnumTables {
  /** Enum -> member -> value. */
  members: ReadonlyMap<string, ReadonlyMap<string, bigint>>;
  /** Member -> the enums declaring it. */
  owners: ReadonlyMap<string, readonly string[]>;
  /** Names several enums give different values: no unqualified spelling exists. */
  ambiguous: ReadonlySet<string>;
}

/**
 * The member of K's enum one step from K (`delta` = +1 / -1): the one name every enum
 * declaring K agrees on, or null.
 */
function neighbourMember(k: string, delta: bigint, t: EnumTables): string | null {
  if (t.ambiguous.has(k)) return null;
  const owners = t.owners.get(k);
  if (!owners?.length) return null;
  let found: string | null = null;
  for (const e of owners) {
    const m = t.members.get(e);
    const v = m?.get(k);
    if (!m || v === undefined) return null;
    const hits = [...m].filter(([, x]) => x === v + delta).map(([n]) => n);
    if (hits.length !== 1) return null;
    if (found !== null && found !== hits[0]) return null;
    found = hits[0];
  }
  return found && !t.ambiguous.has(found) ? found : null;
}

function makeIdent(src: ASTNode, name: string): Identifier {
  return { kind: NodeKind.Identifier, name, location: src.location, leadingTrivia: [], trailingTrivia: [] } as Identifier;
}

function createBranchlessSelectTransformer(enumTables: EnumTables | null): Transformer {
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      // X &= (C) - 1  →  X = C ? 0 : X, for a pure X.
      if (node.kind === NodeKind.AssignExpr) {
        const a = node as AssignExpr;
        if (a.operator !== '&=' || !isPure(a.left)) return undefined;
        const cond = matchCondMinusOne(a.right);
        if (!cond) return undefined;
        return { ...a, operator: '=', right: makeConditional(a.right, cond, makeLit(node, 0n), a.left) } as AssignExpr;
      }
      if (node.kind !== NodeKind.BinaryExpr) return undefined;
      const bin = node as BinaryExpr;

      // Core: (C) - 1 & M  →  C ? 0 : M
      if (bin.operator === '&') {
        const m = matchSelect(bin);
        if (m) {
          return makeConditional(node, m.cond, makeLit(node, 0n), makeLit(node, m.mask));
        }
        // A pure, non-constant M: read once on either path.
        for (const [sel, val] of [[bin.left, bin.right], [bin.right, bin.left]] as const) {
          const cond = matchCondMinusOne(sel);
          if (cond && constVal(val) === null && isPure(val)) {
            return makeConditional(node, cond, makeLit(node, 0n), val);
          }
        }
        return undefined;
      }

      // SETcc + ADD over an enum: (C) + K → C ? K+1 : K; K - (C) → C ? K-1 : K.
      if (enumTables && (bin.operator === '+' || bin.operator === '-')) {
        const tries: Array<[Expression, Expression, bigint]> = bin.operator === '+'
          ? [[bin.left, bin.right, 1n], [bin.right, bin.left, 1n]]
          : [[bin.right, bin.left, -1n]];
        for (const [c, k, delta] of tries) {
          const cond = unwrapParens(c);
          const kk = unwrapParens(k);
          if (!isBoolean(cond) || kk.kind !== NodeKind.Identifier) continue;
          const other = neighbourMember((kk as Identifier).name, delta, enumTables);
          if (!other) continue;
          return makeConditional(node, cond, makeIdent(node, other), kk);
        }
      }

      // Offset fold (bottom-up: the & was already rewritten to `C ? 0 : M`):
      // (C ? 0 : M) + V  →  C ? V : (V + M)   (and the commuted V + (...))
      if (bin.operator === '+') {
        const tryFold = (ternSide: Expression, vSide: Expression): ConditionalExpr | undefined => {
          const tern = unwrapParens(ternSide);
          if (tern.kind !== NodeKind.ConditionalExpr) return undefined;
          const t = tern as ConditionalExpr;
          if (intVal(t.thenExpr) !== 0n) return undefined; // only our select shape (then == 0)
          const mask = intVal(t.elseExpr);
          const v = intVal(vSide);
          if (mask === null || v === null) return undefined;
          return makeConditional(node, t.condition, vSide, makeLit(node, v + mask));
        };
        return tryFold(bin.left, bin.right) ?? tryFold(bin.right, bin.left);
      }

      return undefined;
    },
  });
}

export interface BranchlessSelectOptions extends PluginOptions {
  /** Unambiguous enum constant name -> value. */
  enumValues?: Record<string, number>;
  /** Enum -> member -> value, every emitted enum. */
  enumMemberValues?: Record<string, Record<string, number>>;
  /** Names enums give different values (exported by none). */
  ambiguousConstants?: string[];
}

const enumTablesMemo: MemoSlot<EnumTables> = {};
const enumValuesMemo: MemoSlot<Map<string, bigint>> = {};

/** The enum tables, built once per run; the result is shared and read-only. */
function enumTablesOf(o: BranchlessSelectOptions | undefined): EnumTables | null {
  if (!o?.enumMemberValues) return null;
  return memoOnInputs(enumTablesMemo, [o.enumMemberValues, o.ambiguousConstants], () => buildEnumTables(o.enumMemberValues!, o.ambiguousConstants));
}

function buildEnumTables(
  enumMemberValues: Record<string, Record<string, number>>,
  ambiguousConstants: string[] | undefined,
): EnumTables {
  const members = new Map<string, Map<string, bigint>>();
  const owners = new Map<string, string[]>();
  for (const [e, vals] of Object.entries(enumMemberValues)) {
    const m = new Map<string, bigint>();
    for (const [n, v] of Object.entries(vals)) {
      if (!Number.isFinite(v)) continue;
      m.set(n, BigInt(v));
      const list = owners.get(n) ?? [];
      if (!list.length) owners.set(n, list);
      list.push(e);
    }
    members.set(e, m);
  }
  return { members, owners, ambiguous: new Set(ambiguousConstants ?? []) };
}

/**
 * Branchless Select Plugin
 *
 * Detects the `(cond - 1) & mask (+ offset)?` branchless-select idiom and
 * rewrites it as `cond ? offset : offset+mask` (offset defaults to 0).
 */
export const branchlessSelectPlugin: TransformPlugin = {
  id: 'branchless-select',
  name: 'Branchless Select',
  description:
    'Transform (cond - 1 & mask) + offset → cond ? offset : offset+mask (compiler branchless select)',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 43, // after sbb-branchless (42), before ternary-simplify (55)
  tags: ['core', 'cleanup', 'x86', 'branchless'],

  createTransformer(options?: BranchlessSelectOptions) {
    const values = memoOnInputs(enumValuesMemo, [options?.enumValues], () => {
      const m = new Map<string, bigint>();
      for (const [n, v] of Object.entries(options?.enumValues ?? {})) if (Number.isFinite(v)) m.set(n, BigInt(v));
      return m;
    });
    const inner = createBranchlessSelectTransformer(enumTablesOf(options));
    return (node: ASTNode) => {
      const saved = enumValueOf;
      enumValueOf = values;
      try { return inner(node); } finally { enumValueOf = saved; }
    };
  },
};
