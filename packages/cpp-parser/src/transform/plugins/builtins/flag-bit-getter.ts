/**
 * Flag Bit Getter Plugin
 *
 * A flag bit of a record read through a pointer, `p->F >> n & 1` (or `p->F & 1`), tested
 * for truth, compiles under VC8 to a test of memory, `test byte ptr [p + F + n/8], 1 << n%8`.
 * The original instead loads the dword, shifts and masks it in a register and branches
 * on the AND's flags (AI_ForEachFn09_FindOwnMinionCorpse 005dcda0):
 *
 *     mov eax, [esi + 0xc4]; shr eax, 1; and eax, 1; je ...
 *
 * which is what VC8 makes of the bit read through a null-guarded header inline, the
 * value of its own that D2Common's flag getters return (UNITS_IsShapeshifted 0063a400:
 * `if (!p) return 0; return p->F >> 3 & 1;`). VC8 never makes an AND of a direct flag
 * test, so the AND is the evidence: where the extraction's equality tokens on a line
 * (branchLayout `tests`) hold one `AND` for each such bit test the line prints, each bit
 * test reads through a getter written once per unit, ahead of the first function that
 * calls it:
 *
 *     static D2_FORCEINLINE uint32_t FlagBit_D2UnitStrc_eUnitFlags_1(D2UnitStrc * p) {
 *         if (!p) { return 0; }
 *         return p->eUnitFlags >> 1 & 1;
 *     }
 *
 * The value is the same wherever the bit is read: the pointer is non-null there (the
 * printed read goes through it), and the getter returns the very bit. A line whose AND
 * count differs from its bit tests is left as printed.
 *
 * The getter is forced inline. The same AND is the evidence that the original expanded it at
 * the site (a call would leave no AND on the line), and VC8 at /Ob1 keeps a plain `inline`
 * as a call where its own heuristic declines (AI_ForEachFn11_AltHittableTarget 005dccc0:
 * `call FlagBit_...` where the original has `mov ecx, [esi + 0xc4]; shr ecx, 2; and ecx, 1`).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AnyNode, BinaryExpr, Expression, FunctionDecl, Identifier, IntegerLiteralExpr, MemberExpr, ParenExpr,
  PointerType, TypeNode,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { Expr } from '../../../ast/factory.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import type { BranchLayoutEvidence } from './branch-layout/evidence.js';
import { localTypesOf } from './compare-form.js';

export interface FlagBitGetterOptions extends PluginOptions {
  /** The original's addresses and equality tokens, keyed by line of the parsed text. */
  branchLayout?: BranchLayoutEvidence | null;
  /** Receives each getter definition the function calls, to write ahead of it. */
  onPrefix?: (definition: string) => void;
  onSite?: (e: { line: number; getter: string }) => void;
}

interface BitRead {
  node: Expression;
  pointer: string;
  path: string[];
  shift: number;
}

const unparen = (e: Expression): Expression => {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
};

function literal(e: Expression): number | null {
  const u = unparen(e);
  if (u.kind !== NodeKind.IntegerLiteral) return null;
  const v = (u as IntegerLiteralExpr).value;
  return typeof v === 'bigint' && v <= 31n ? Number(v) : null;
}

/** `p->a.b` with p a name: the name and the member path, outermost first. */
function fieldOf(e: Expression): { pointer: string; path: string[] } | null {
  const path: string[] = [];
  let cur = unparen(e);
  while (cur.kind === NodeKind.MemberExpr) {
    const m = cur as MemberExpr;
    if (m.member.kind !== NodeKind.Identifier) return null;
    path.unshift((m.member as Identifier).name);
    const obj = unparen(m.object);
    if (m.isArrow) return obj.kind === NodeKind.Identifier ? { pointer: (obj as Identifier).name, path } : null;
    cur = obj;
  }
  return null;
}

/** `p->F >> n & 1` or `p->F & 1`, or null. */
function bitRead(e: Expression): BitRead | null {
  const u = unparen(e);
  if (u.kind !== NodeKind.BinaryExpr) return null;
  const b = u as BinaryExpr;
  if (b.operator !== '&' || literal(b.right) !== 1) return null;
  const l = unparen(b.left);
  if (l.kind === NodeKind.BinaryExpr && (l as BinaryExpr).operator === '>>') {
    const s = l as BinaryExpr;
    const n = literal(s.right);
    const f = fieldOf(s.left);
    return n !== null && n > 0 && f ? { node: e, ...f, shift: n } : null;
  }
  const f = fieldOf(l);
  return f ? { node: e, ...f, shift: 0 } : null;
}

function pointeeName(t: TypeNode | undefined): string | null {
  if (!t || t.kind !== NodeKind.PointerType) return null;
  const p = (t as PointerType).pointee;
  const s = emit(p as unknown as AnyNode).trim();
  return /^[A-Za-z_][\w:]*$/.test(s) ? s : null;
}

function rewriteFunction(fn: FunctionDecl, opts: FlagBitGetterOptions): FunctionDecl | undefined {
  const ev = opts.branchLayout;
  if (!fn.body || !ev?.tests) return undefined;
  const types = localTypesOf(fn);
  const byLine = new Map<number, BitRead[]>();
  for (const n of traverseAST(fn.body)) {
    if (n.kind !== NodeKind.BinaryExpr) continue;
    const r = bitRead(n as Expression);
    const line = (n as Expression).location?.start.line;
    if (!r || line === undefined || (n as Expression).location?.file === '<generated>') continue;
    if (!pointeeName(types.get(r.pointer))) continue;
    const l = byLine.get(line) ?? [];
    l.push(r);
    byLine.set(line, l);
  }
  const at = (e: Expression): string => `${e.location?.start.line}:${e.location?.start.column}:${e.location?.start.offset}`;
  const take = new Map<string, string>();
  for (const [line, reads] of byLine) {
    const ands = (ev.tests.get(line) ?? []).filter(t => t.mnemonic === 'AND').length;
    if (ands === 0 || ands !== reads.length) continue;
    for (const r of reads) {
      const type = pointeeName(types.get(r.pointer))!;
      const name = `FlagBit_${type.replace(/::/g, '_')}_${r.path.join('_')}_${r.shift}`;
      const field = r.path.join('.');
      const value = r.shift ? `p->${field} >> ${r.shift} & 1` : `p->${field} & 1`;
      opts.onPrefix?.([
        `// The flag bit as the original's header getter returns it: a value of its own, tested in a register.`,
        `static D2_FORCEINLINE uint32_t ${name}(${type} * p) {`,
        `    if (!p) {`,
        `        return 0;`,
        `    }`,
        `    return ${value};`,
        `}`,
      ].join('\n'));
      opts.onSite?.({ line, getter: name });
      take.set(at(r.node), `${name}\0${r.pointer}`);
    }
  }
  if (take.size === 0) return undefined;
  const t = createTransformer({
    visitBinaryExpr(node: BinaryExpr): ASTNode | undefined {
      const hit = node.location ? take.get(at(node)) : undefined;
      if (!hit || !bitRead(node)) return undefined;
      const [name, pointer] = hit.split('\0');
      return { ...Expr.call(name, [Expr.identifier(pointer)]), location: node.location } as unknown as ASTNode;
    },
  });
  return updateNode(fn, { body: t(fn.body) } as Partial<FunctionDecl>);
}

export const flagBitGetterPlugin: TransformPlugin = {
  id: 'flag-bit-getter',
  name: 'Flag Bit Getter',
  description: 'A flag bit test the original ANDs in a register reads through the null-guarded getter VC8 compiles that way',
  version: '1.0.0',
  defaultEnabled: true,
  // After the condition shapes are settled (branch-layout 988, record passes), before the late cleanups.
  priority: 989.9,
  tags: ['matching'],
  createTransformer: (options: FlagBitGetterOptions = {}): Transformer => createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  }),
};
