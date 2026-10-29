/**
 * Array-Fill Collapse Plugin
 *
 * The decompiler unrolls `memset(arr, 0, n)` into a run of element assignments:
 *
 *   gObjModeTokens[0] = 0;
 *   gObjModeTokens[1] = 0;
 *   ...
 *   gObjModeTokens[7] = 0;
 *
 * (and the char variant `name[0] = '\0'; name[1] = '\0'; ...`). This collapses a
 * run of >= THRESHOLD consecutive zero-assignments to the same base, with
 * consecutive integer indices, back into a single memset:
 *
 *   memset(gObjModeTokens, 0, 8 * sizeof(gObjModeTokens[0]));
 *
 * Only zero fills (0 / '\0' / nullptr) are collapsed — those are the byte-fill
 * cases memset can represent. The base must be side-effect-free (an lvalue, no
 * calls) so evaluating it once is equivalent to N times. Partial runs
 * (`arr[3]..arr[9]`) become `memset(arr + 3, 0, 7 * sizeof(arr[0]))`.
 *
 * A run of more than 32 bytes is written as an index loop instead, where the element size is
 * known (a local array the function declares, or a global array): VC8 SP1 /O2 does not
 * inline a memset of more than 32 bytes, so the memset becomes a call the original does not
 * have, while the index loop compiles back to the original's unrolled stores
 * (HELP_DrawHelpButtonTooltip 00495030 clears `uint16_t wszKeyLine[30]` with fifteen
 * `mov dword ptr [ebp-x], eax`):
 *
 *   for (int i = 0; i < 30; i++) wszKeyLine[i] = 0;
 *
 * The loop stores the same zeros to the same elements; its counter is a new name, declared
 * in the loop.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  Statement,
  CompoundStmt,
  ExprStmt,
  AssignExpr,
  SubscriptExpr,
  ParenExpr,
  UnaryExpr,
  MemberExpr,
  IntegerLiteralExpr,
} from '../../../ast/nodes.js';
import { createTransformer, cloneNode, updateNode, nodesEqual, type Transformer } from '../../transformer.js';
import { Expr, Stmt, Decl, Type } from '../../../ast/factory.js';
import type { FunctionDecl, VariableDecl, ArrayType, Identifier } from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

const THRESHOLD = 4;

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** A zero-valued RHS: integer 0, char '\0', or nullptr. */
function isZero(e: Expression): boolean {
  const u = unwrap(e);
  if (u.kind === NodeKind.IntegerLiteral) return (u as IntegerLiteralExpr).value === 0n;
  if (u.kind === NodeKind.NullptrLiteral) return true;
  if (u.kind === NodeKind.CharLiteral) {
    const v = (u as { value?: unknown }).value;
    if (typeof v === 'number') return v === 0;
    if (typeof v === 'string') return v === '\0' || v === '\\0' || v === '\\x00' || v.charCodeAt(0) === 0;
  }
  return false;
}

/** Side-effect-free lvalue base (so evaluating it once == N times). No calls. */
function isSafeBase(e: Expression): boolean {
  const u = unwrap(e);
  switch (u.kind) {
    case NodeKind.Identifier:
      return true;
    case NodeKind.MemberExpr:
      return isSafeBase((u as MemberExpr).object);
    case NodeKind.UnaryExpr: {
      const un = u as UnaryExpr;
      return (un.operator === '*' || un.operator === '&') && isSafeBase(un.operand);
    }
    case NodeKind.SubscriptExpr: {
      const s = u as SubscriptExpr;
      return isSafeBase(s.array) && (s.index.kind === NodeKind.IntegerLiteral || s.index.kind === NodeKind.Identifier);
    }
    default:
      return false;
  }
}

/** Match `base[<int>] = <zero>;` → { base, idx } or null. */
function matchZeroFill(s: Statement): { base: Expression; idx: number } | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr) return null;
  const a = e as AssignExpr;
  if (a.operator !== '=' || !isZero(a.right)) return null;
  const lhs = unwrap(a.left);
  if (lhs.kind !== NodeKind.SubscriptExpr) return null;
  const sub = lhs as SubscriptExpr;
  const idxNode = unwrap(sub.index);
  if (idxNode.kind !== NodeKind.IntegerLiteral) return null;
  if (!isSafeBase(sub.array)) return null;
  return { base: sub.array, idx: Number((idxNode as IntegerLiteralExpr).value) };
}

/** memset(<base>[+start], 0, count * sizeof(<base>[0])); */
function makeMemset(base: Expression, startIdx: number, count: number, model: Statement): ExprStmt {
  const dest =
    startIdx === 0
      ? cloneNode(base)
      : Expr.binary(cloneNode(base), '+', Expr.intLiteral(startIdx));
  const size = Expr.binary(
    Expr.intLiteral(count),
    '*',
    Expr.sizeof(Expr.subscript(cloneNode(base), Expr.intLiteral(0)), false),
  );
  const call = Expr.call('memset', [dest, Expr.intLiteral(0), size]);
  return {
    kind: NodeKind.ExprStmt,
    expression: call,
    location: model.location,
    leadingTrivia: model.leadingTrivia || [],
    trailingTrivia: [],
  };
}

/** The bytes above which VC8 SP1 /O2 calls memset instead of expanding it. */
const MEMSET_INLINE_MAX = 32;

/** Element size of a scalar spelling, or null. */
function scalarSize(name: string): number | null {
  if (/^(char|signed char|unsigned char|byte|uchar|uint8_t|int8_t|BYTE|CHAR|UCHAR|undefined1|bool)$/.test(name)) return 1;
  if (/^(WCHAR|wchar_t|short|ushort|unsigned short|uint16_t|int16_t|WORD|SHORT|USHORT|undefined2)$/.test(name)) return 2;
  if (/^(int|uint|unsigned|unsigned int|long|ulong|uint32_t|int32_t|DWORD|LONG|ULONG|UINT|INT|BOOL|undefined4|float)$/.test(name) || /\*$/.test(name)) return 4;
  return null;
}

/** What a function knows about the arrays it can fill: element sizes and the names in use. */
interface FillScope {
  elemSize(base: Expression): number | null;
  freshName(): string;
}

/** for (int i = start; i < start + count; i++) base[i] = value; */
function makeLoop(base: Expression, startIdx: number, count: number, value: Expression, counter: string, model: Statement): Statement {
  const i = () => Expr.identifier(counter);
  const loop = Stmt.for_(
    Stmt.declStmt([Decl.variable(counter, Type.int(), Expr.intLiteral(startIdx))]),
    Expr.binary(i(), '<', Expr.intLiteral(startIdx + count)),
    Expr.postfix(i(), '++'),
    Stmt.compound([Stmt.expr(Expr.assign(Expr.subscript(cloneNode(base), i()), cloneNode(value)))]),
  );
  return { ...loop, location: model.location, leadingTrivia: model.leadingTrivia || [], trailingTrivia: [], ghidraInfo: { sourceLoop: true } };
}

function collapseBlock(block: CompoundStmt, scope?: FillScope): CompoundStmt | null {
  const s = block.statements;
  const out: Statement[] = [];
  let changed = false;
  let i = 0;
  while (i < s.length) {
    const m = matchZeroFill(s[i]);
    if (m) {
      // Extend the run: same base, consecutive ascending indices.
      let j = i + 1;
      let lastIdx = m.idx;
      while (j < s.length) {
        const m2 = matchZeroFill(s[j]);
        if (!m2 || m2.idx !== lastIdx + 1 || !nodesEqual(m2.base, m.base)) break;
        lastIdx = m2.idx;
        j++;
      }
      const count = j - i;
      if (count >= THRESHOLD) {
        const elem = scope?.elemSize(m.base) ?? null;
        if (elem !== null && count * elem > MEMSET_INLINE_MAX) {
          const value = ((s[i] as ExprStmt).expression as AssignExpr).right;
          out.push(makeLoop(m.base, m.idx, count, unwrap(value), scope!.freshName(), s[i]));
        } else {
          out.push(makeMemset(m.base, m.idx, count, s[i]));
        }
        changed = true;
        i = j;
        continue;
      }
    }
    out.push(s[i]);
    i++;
  }
  return changed ? updateNode(block, { statements: out }) : null;
}

function fillScope(fn: FunctionDecl, options: ArrayFillCollapseOptions): FillScope {
  const locals = new Map<string, number | null>();
  const names = new Set<string>();
  for (const p of fn.parameters) if ((p as { name?: Identifier }).name) { names.add((p as { name: Identifier }).name.name); locals.set((p as { name: Identifier }).name.name, null); }
  for (const n of findNodesByKind(fn, NodeKind.Identifier)) names.add((n as Identifier).name);
  for (const d of findNodesByKind(fn, NodeKind.VariableDecl)) {
    const v = d as VariableDecl;
    names.add(v.name.name);
    if (v.type.kind === NodeKind.ArrayType && (v.type as ArrayType).elementType.kind !== NodeKind.ArrayType) {
      locals.set(v.name.name, scalarSize(emit((v.type as ArrayType).elementType as unknown as AnyNode).replace(/\s+/g, ' ').trim()));
    } else {
      locals.set(v.name.name, null);
    }
  }
  const globalElementSizes = options.globalElementSizes ?? {};
  return {
    elemSize(base: Expression): number | null {
      const b = unwrap(base);
      if (b.kind !== NodeKind.Identifier) return null;
      const name = (b as Identifier).name;
      if (locals.has(name)) return locals.get(name) ?? null;
      const e = globalElementSizes[name];
      return e === 1 || e === 2 || e === 4 ? e : null;
    },
    freshName(): string {
      for (let k = 0; ; k++) {
        const n = k === 0 ? 'iFill' : `iFill${k + 1}`;
        if (!names.has(n)) { names.add(n); return n; }
      }
    },
  };
}

function createArrayFillTransformer(options: ArrayFillCollapseOptions = {}): Transformer {
  const blocks = (scope?: FillScope) => createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind === NodeKind.CompoundStmt) {
        return collapseBlock(node as CompoundStmt, scope) ?? undefined;
      }
      return undefined;
    },
  });
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const body = blocks(fillScope(fn, options))(fn.body);
      return body !== fn.body ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export interface ArrayFillCollapseOptions extends PluginOptions {
  /** Global name -> the stride of one element, for globals Ghidra typed as arrays. */
  globalElementSizes?: Record<string, number>;
}

/**
 * Array-Fill Collapse Plugin
 *
 * Collapse unrolled zero-fill assignment runs back into a single memset.
 */
export const arrayFillCollapsePlugin: TransformPlugin = {
  id: 'array-fill-collapse',
  name: 'Array-Fill Collapse',
  description: 'Collapse runs of arr[i] = 0; into a single memset(arr, 0, n * sizeof(arr[0]))',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 50,
  tags: ['core', 'readability', 'cleanup'],

  createTransformer(options?: ArrayFillCollapseOptions) {
    return createArrayFillTransformer(options ?? {});
  },
};
