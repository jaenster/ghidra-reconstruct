/**
 * Narrow Compare Widen Plugin
 *
 * Ghidra types a local by the width it is loaded with: a `movzx ebx, word ptr [...]` value
 * becomes `ushort`. Where the original compares that value in the whole register
 * (`cmp ebx, 0x20`), Blizzard's local was an int; a `ushort` local makes VC8 compare the
 * 16-bit register (`cmp bx, 0x20`) and allocate around it (INPUT_HelpCloseButtonUp 00496720:
 * `nMouseY - 0x18 < 0x21`). extract/compare-sites.ts records each comparison's setter width.
 *
 * A local declared 8 or 16 bits wide is declared 32 bits wide (same signedness) when a
 * comparison of it, or of it plus or minus a constant, was compiled from a 4-byte register
 * compare. Tied to a site by operator, width 4 with a register first operand, and either the
 * variable's fingerprint or, for an expression, the other side's constant. A wider local
 * holds what the narrow one truncated, so only a local whose every assignment is a load of a
 * value no wider than its type (a field or a variable of that width) is widened: then the
 * value is the same, zero- or sign-extended as the narrow type would have extended it.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, BuiltinType, CStyleCastExpr, Expression, FunctionDecl, Identifier, IntegerLiteralExpr,
  ParenExpr, TypedefType, VariableDecl, AssignExpr,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import type { Transformer } from '../../transformer.js';

export interface NarrowCompareWidenOptions extends PluginOptions {
  compareSites?: string;
  onSite?: (e: { name: string; from: string; to: string }) => void;
}

interface Row { op: string; fp: [string, string]; k?: bigint; width: number; a: string }

function parseRows(s: string | undefined): Row[] {
  if (!s) return [];
  const out: Row[] = [];
  for (const line of s.split('\n')) {
    const f = line.split('\t');
    if (f.length < 18 || f[2] === '-') continue;
    out.push({ op: f[1], fp: [f[6], f[7]], k: /^[0-9a-f]+$/i.test(f[5]) ? BigInt('0x' + f[5]) : undefined, width: Number(f[13]), a: f[14] });
  }
  return out;
}

const NARROW: Record<string, string> = {
  ushort: 'uint', uint16_t: 'uint32_t', WORD: 'DWORD', USHORT: 'uint', short: 'int', int16_t: 'int32_t',
  byte: 'uint', uchar: 'uint', uint8_t: 'uint32_t', BYTE: 'DWORD', UCHAR: 'uint', char: 'int', int8_t: 'int32_t',
};

function narrowName(t: VariableDecl['type']): string | null {
  if (t.kind === NodeKind.TypedefType) {
    const n = (t as TypedefType).name; const s = n.kind === NodeKind.Identifier ? (n as Identifier).name : null;
    return s && NARROW[s] ? s : null;
  }
  if (t.kind === NodeKind.BuiltinType) {
    const b = t as BuiltinType;
    if (b.name === 'char' || (b.name === 'int' && b.modifiers.includes('short')) || b.name === 'short') {
      const base = b.name === 'char' ? 'char' : 'short';
      return b.modifiers.includes('unsigned') ? (base === 'char' ? 'uchar' : 'ushort') : base;
    }
  }
  return null;
}

function unwrap(e: Expression): Expression {
  for (;;) {
    if (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
    else if (e.kind === NodeKind.CStyleCastExpr) e = (e as CStyleCastExpr).expression;
    else return e;
  }
}

/** v, or v +/- literal: v's name. */
function baseVar(e: Expression): { name: string; plain: boolean } | null {
  const u = unwrap(e);
  if (u.kind === NodeKind.Identifier) return { name: (u as Identifier).name, plain: true };
  if (u.kind === NodeKind.BinaryExpr) {
    const b = u as BinaryExpr;
    if ((b.operator === '+' || b.operator === '-') && unwrap(b.right).kind === NodeKind.IntegerLiteral) {
      const l = unwrap(b.left);
      if (l.kind === NodeKind.Identifier) return { name: (l as Identifier).name, plain: false };
    }
  }
  return null;
}

function literal(e: Expression): bigint | null {
  const u = unwrap(e);
  if (u.kind !== NodeKind.IntegerLiteral) return null;
  const v = (u as IntegerLiteralExpr & { value: number | bigint | string }).value;
  try { return BigInt(v as never); } catch { return null; }
}

const CMP = new Set(['<', '>', '<=', '>=', '==', '!=']);

function widenFunction(fn: FunctionDecl, rows: Row[], opts: NarrowCompareWidenOptions): void {
  if (!fn.body) return;
  const decls = new Map<string, VariableDecl>();
  for (const n of traverseAST(fn.body as ASTNode)) {
    if (n.kind === NodeKind.VariableDecl) {
      const d = n as VariableDecl; if (narrowName(d.type)) decls.set(d.name.name, d);
    }
  }
  if (decls.size === 0) return;
  const wide = rows.filter(r => r.width === 4 && r.a === 'r');
  const hit = new Set<string>();
  for (const n of traverseAST(fn.body as ASTNode)) {
    if (n.kind !== NodeKind.BinaryExpr || !CMP.has((n as BinaryExpr).operator)) continue;
    const b = n as BinaryExpr;
    for (const [side, other] of [[b.left, b.right], [b.right, b.left]] as const) {
      const v = baseVar(side); if (!v || !decls.has(v.name)) continue;
      const k = literal(other);
      const tied = wide.some(r => r.op === b.operator && (
        r.fp.includes('v:' + v.name) || (!v.plain && r.fp.includes('e') && k !== null && r.k === k)));
      if (tied) hit.add(v.name);
    }
  }
  // Only a local whose every assignment is a plain load (no arithmetic it would truncate).
  for (const n of traverseAST(fn.body as ASTNode)) {
    if (n.kind !== NodeKind.AssignExpr) continue;
    const a = n as AssignExpr; const t = unwrap(a.left);
    if (t.kind !== NodeKind.Identifier || !hit.has((t as Identifier).name)) continue;
    const r = unwrap(a.right);
    if (a.operator !== '=' || !(r.kind === NodeKind.MemberExpr || r.kind === NodeKind.Identifier || r.kind === NodeKind.IntegerLiteral)) hit.delete((t as Identifier).name);
  }
  for (const name of hit) {
    const d = decls.get(name)!; const from = narrowName(d.type)!; const to = NARROW[from];
    if (d.initializer) {
      const r = unwrap(d.initializer as Expression);
      if (!(r.kind === NodeKind.MemberExpr || r.kind === NodeKind.Identifier || r.kind === NodeKind.IntegerLiteral)) continue;
    }
    (d as { type: VariableDecl['type'] }).type = { kind: NodeKind.TypedefType, name: { kind: NodeKind.Identifier, name: to, leadingTrivia: [], trailingTrivia: [] } as Identifier, location: d.type.location, leadingTrivia: d.type.leadingTrivia ?? [], trailingTrivia: d.type.trailingTrivia ?? [] } as TypedefType;
    opts.onSite?.({ name, from, to });
  }
}

export const narrowCompareWidenPlugin: TransformPlugin = {
  id: 'narrow-compare-widen',
  name: 'Narrow Compare Widen',
  description: 'A byte/word local the original compares in a whole register is declared 32 bits wide',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 989.985,
  tags: ['codegen', 'vc8'],
  createTransformer(options?: PluginOptions): Transformer {
    const opts = (options ?? {}) as NarrowCompareWidenOptions;
    const rows = parseRows(opts.compareSites);
    return (ast: ASTNode) => {
      if (rows.length === 0) return ast;
      for (const n of traverseAST(ast)) if (n.kind === NodeKind.FunctionDecl) widenFunction(n as FunctionDecl, rows, opts);
      return ast;
    };
  },
};
