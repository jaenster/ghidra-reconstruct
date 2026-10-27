/**
 * Index Base Before Object Plugin
 *
 * MSVC indexes a table whose first index is 1 through an address one stride BELOW
 * the table, and that address can lie in bytes no object owns:
 *
 *     006b5dc1  encodes 0x970eac = gD3DGenericTextureCache (0x970ec8) - 0x1c,
 *               scaled by iMipLevel * 0x1c with iMipLevel = 1..3
 *
 * `RENDERER_DIRECT3D_UploadTextureToCache` @006b5d40 reads the texture cache set
 * `aCaches[iMipLevel - 1]` that way, and the node buffer at +0x18 through
 * 0x970ec4 = 0x970ec8 - 4. Ghidra has no object at either address, so the
 * decompiler names each by a label of its own:
 *
 *     pCache = (D3DTextureCacheStrc *)(&DAT_00970eac + iMipLevel * 0x1c);
 *     ... (&INT_00970ec4)[iMipLevel * 7] ...
 *
 * Both labels are referenced by this one function, so the emitter made them
 * function-local statics: in the rebuild the cache lookup reads two private
 * zero-filled bytes instead of the cache. An offset reference in Ghidra does not
 * help - the decompiler ignores it - so the fix is in the emitter.
 *
 * The address is respelled against the object the scaled index actually lands in:
 *
 *     &DAT_00970eac   ->   ((uint8_t *)&gD3DGenericTextureCache - 0x1c)
 *     &INT_00970ec4   ->   ((int *)((uint8_t *)&gD3DGenericTextureCache - 4))
 *
 * The same address in the image, the same pointer type, and the right object in
 * the rebuild. Held to the shape exactly:
 *
 *  - L is a Ghidra default label (`DAT_`, `INT_`, ... followed by its own address):
 *    a name nobody gave an object;
 *  - every use of L in the body is `&L` as the base of a SCALED index
 *    (`&L + i * C`, `(&L)[i * C]`, or `<< C`) - never read, written or offset by a
 *    constant;
 *  - one stride past L lands inside a single global G that starts at most
 *    MAX_GAP bytes above L, and L's own extent ends at or before G;
 *  - L is inside no other object, and G is a namespace-scope global this body can
 *    name, with a known type spelling for L.
 *
 * Anything else is left as printed.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, Expression, Identifier, IntegerLiteralExpr, ParenExpr, QualifiedId,
  SubscriptExpr, UnaryExpr,
} from '../../../ast/nodes.js';
import { Expr, Type } from '../../../ast/factory.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { typeFromSpelling } from './call-arg-cast.js';

export interface IndexBaseBeforeObjectOptions extends PluginOptions {
  /** Global name (as emitted) -> address. */
  globalAddresses?: Record<string, number>;
  /** Global name -> size in bytes. */
  globalSizes?: Record<string, number>;
  /** Global name -> namespace segments; present only for namespace-scope globals. */
  globalNamespaces?: Record<string, readonly string[]>;
  /** Global name -> its emitted type spelling. */
  globalTypes?: Record<string, string>;
  onRewrite?: (info: { label: string; target: string; distance: number }) => void;
}

/** How far below the object the label may sit. */
export const INDEX_BASE_MAX_GAP = 0x40;

const DEFAULT_LABEL_RE = /^(?:DAT|BYTE|WORD|DWORD|QWORD|INT|UINT|SHORT|USHORT|LONG|ULONG|CHAR|UCHAR|PTR|FLOAT|DOUBLE)_([0-9A-Fa-f]{8})$/;

const SCALAR_SIZES: Record<string, number> = {
  uint8_t: 1, int8_t: 1, char: 1, uchar: 1, byte: 1, BYTE: 1, undefined1: 1, bool: 1,
  uint16_t: 2, int16_t: 2, short: 2, ushort: 2, WORD: 2, undefined2: 2,
  int: 4, uint: 4, int32_t: 4, uint32_t: 4, DWORD: 4, undefined4: 4, float: 4, long: 4, ulong: 4,
};

function unwrap(e: Expression): Expression {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as ParenExpr).expression;
  return x;
}

function symbolName(e: Expression): string | null {
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name;
  if (e.kind === NodeKind.QualifiedId) {
    const q = e as QualifiedId;
    if (q.name.kind === NodeKind.Identifier) return (q.name as Identifier).name;
  }
  return null;
}

/** The label `e` takes the address of (`&L`), or null. */
function addressOfLabel(e: Expression): string | null {
  const x = unwrap(e);
  if (x.kind !== NodeKind.UnaryExpr || (x as UnaryExpr).operator !== '&') return null;
  return symbolName(unwrap((x as UnaryExpr).operand));
}

function literal(e: Expression): number | null {
  const x = unwrap(e);
  return x.kind === NodeKind.IntegerLiteral ? Number((x as IntegerLiteralExpr).value) : null;
}

/** The scale of `i * C`, `C * i` or `i << C` with `i` not a constant; null otherwise. */
function scaleOf(e: Expression): number | null {
  const x = unwrap(e);
  if (x.kind !== NodeKind.BinaryExpr) return null;
  const b = x as BinaryExpr;
  if (b.operator === '*') {
    const l = literal(b.left);
    const r = literal(b.right);
    if (r !== null && l === null && r > 0) return r;
    if (l !== null && r === null && l > 0) return l;
    return null;
  }
  if (b.operator === '<<') {
    const r = literal(b.right);
    if (r !== null && literal(b.left) === null && r >= 0 && r < 16) return 1 << r;
  }
  return null;
}

/** The pointee size of a label's type spelling, when it is one this pass knows. */
function spelledSize(spelling: string): number | null {
  const s = spelling.trim();
  if (s.endsWith('*')) return 4;
  return SCALAR_SIZES[s] ?? null;
}

interface Rebase { target: string; distance: number; type: string }

/**
 * The labels this body uses only as a scaled index base, each with the object
 * one stride past it lands in.
 */
export function indexBaseRebases(root: ASTNode, o: IndexBaseBeforeObjectOptions): Map<string, Rebase> {
  const addresses = o.globalAddresses ?? {};
  const sizes = o.globalSizes ?? {};
  const namespaces = o.globalNamespaces ?? {};
  const types = o.globalTypes ?? {};

  const isCandidate = (name: string): boolean => {
    const m = DEFAULT_LABEL_RE.exec(name);
    return !!m && addresses[name] !== undefined && Number.parseInt(m[1], 16) === addresses[name];
  };

  const total = new Map<string, number>();
  const strides = new Map<string, number[]>();
  for (const n of traverseAST(root)) {
    if (n.kind === NodeKind.Identifier) {
      const name = (n as Identifier).name;
      if (isCandidate(name)) total.set(name, (total.get(name) ?? 0) + 1);
      continue;
    }
    let label: string | null = null;
    let scale: number | null = null;
    if (n.kind === NodeKind.BinaryExpr && (n as BinaryExpr).operator === '+') {
      const b = n as BinaryExpr;
      const l = addressOfLabel(b.left);
      const r = addressOfLabel(b.right);
      if (l && !r) { label = l; scale = scaleOf(b.right); }
      else if (r && !l) { label = r; scale = scaleOf(b.left); }
    } else if (n.kind === NodeKind.SubscriptExpr) {
      const s = n as SubscriptExpr;
      label = addressOfLabel(s.array);
      if (label) scale = scaleOf(s.index);
    }
    if (!label || scale === null || !isCandidate(label)) continue;
    const list = strides.get(label);
    if (list) list.push(scale); else strides.set(label, [scale]);
  }

  // Every global's extent, for "which object contains this address".
  const extents = Object.entries(addresses)
    .filter(([name]) => sizes[name] !== undefined && sizes[name] > 0)
    .map(([name, start]) => ({ name, start, end: start + sizes[name] }));
  const containing = (addr: number): string[] =>
    extents.filter(e => e.start <= addr && addr < e.end).map(e => e.name);

  const out = new Map<string, Rebase>();
  for (const [label, scales] of strides) {
    if (scales.length !== total.get(label)) continue;
    const base = addresses[label];
    const size = sizes[label];
    const type = types[label];
    if (size === undefined || type === undefined || spelledSize(type) !== size) continue;
    if (containing(base).some(n => n !== label)) continue;
    let target: string | null = null;
    let ok = true;
    for (const scale of scales) {
      const at = base + scale * size;
      const owners = containing(at);
      if (owners.length !== 1 || (target !== null && owners[0] !== target)) { ok = false; break; }
      target = owners[0];
    }
    if (!ok || target === null || target === label) continue;
    const distance = addresses[target] - base;
    if (distance <= 0 || distance > INDEX_BASE_MAX_GAP || size > distance) continue;
    if (namespaces[target] === undefined) continue;
    out.set(label, { target, distance, type });
  }
  return out;
}

export function createIndexBaseBeforeObjectTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as IndexBaseBeforeObjectOptions;
  const addresses = o.globalAddresses ?? {};
  if (Object.keys(addresses).length === 0) return (n: ASTNode) => n;
  const namespaces = o.globalNamespaces ?? {};

  function reference(name: string): Expression {
    const segs = namespaces[name] ?? [];
    return segs.length === 0 ? Expr.identifier(name) : Expr.qualifiedId([...segs, name]);
  }

  /** `((T *)((uint8_t *)&G - d))`, or `((uint8_t *)&G - d)` for a byte label. */
  function respelled(r: Rebase): Expression | null {
    const bytes = Expr.binary(
      Expr.cast(Type.pointer(Type.typedef('uint8_t')), Expr.unary('&', reference(r.target))),
      '-', Expr.intLiteral(r.distance, 16));
    if (r.type.trim() === 'uint8_t') return Expr.paren(bytes);
    const t = typeFromSpelling(r.type);
    if (!t) return null;
    return Expr.paren(Expr.cast(Type.pointer(t), Expr.paren(bytes)));
  }

  return (root: ASTNode) => {
    const rebases = indexBaseRebases(root, o);
    if (rebases.size === 0) return root;
    const spelled = new Map<string, Expression>();
    for (const [label, r] of rebases) {
      const e = respelled(r);
      if (e) spelled.set(label, e);
    }
    if (spelled.size === 0) return root;
    for (const [label, r] of rebases) {
      if (spelled.has(label)) o.onRewrite?.({ label, target: r.target, distance: r.distance });
    }
    return createTransformer({
      visitUnaryExpr(node: UnaryExpr): ASTNode | undefined {
        if (node.operator !== '&') return undefined;
        const name = symbolName(unwrap(node.operand));
        const e = name ? spelled.get(name) : undefined;
        if (!e) return undefined;
        return { ...e, location: node.location,
          leadingTrivia: node.leadingTrivia, trailingTrivia: node.trailingTrivia } as Expression;
      },
    })(root);
  };
}

export const indexBaseBeforeObjectPlugin: TransformPlugin = createPlugin(
  'index-base-before-object',
  'Index Base Before Object',
  'A default label used only as a scaled index base just below a global is respelled against that global',
  (options?: PluginOptions) => createIndexBaseBeforeObjectTransformer(options),
  {
    priority: 12, // beside biased-table-index, before type-normalize (15) and the cast passes
    defaultEnabled: true,
    tags: ['correctness'],
    version: '1.0.0',
  },
);
