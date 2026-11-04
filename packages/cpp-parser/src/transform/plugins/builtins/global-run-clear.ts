/**
 * Global Run Clear Plugin
 *
 * TEXT_InitTextDisplaySettings (0049d440) starts with
 *
 *     memset(&Dialog::DialogHandle, 0, 0x9f);
 *
 * DialogHandle is four bytes. The 0x9f bytes from it (0x007bf1b0..0x007bf24e) are 32
 * separate text and dialog globals in the image, the last of which ends exactly on the
 * span's edge; NPCMENU_Initialize (004b23e0) clears 0x160 bytes from the one-byte
 * gbNpcMenuInitialized over 45. The original's span is one block of adjacent objects. In a
 * rebuild the linker places each object on its own, so the memset clears 4 (or 1) bytes of
 * the one it names and the rest of whatever follows: relinked, Text's smeared the weather
 * and light arrays and npcmenu's zeroed the tile clip rectangle.
 *
 * The same write set, independent of placement, is one clear per object the span covers,
 * in address order:
 *
 *     memset(&Dialog::DialogHandle, 0, sizeof(Dialog::DialogHandle));
 *     memset(&gpTextMessageLogHead, 0, sizeof(gpTextMessageLogHead));
 *     ...
 *
 * and, for an object the span covers only in part, its bytes inside the span:
 * `memset((char *)&g + k, 0, n)`. Bytes of the span no object holds are not cleared: no
 * symbol names them, so no code can read them.
 *
 * Exact, never inferred:
 *  - `memset(&G, 0, N)` (or `memset(G, 0, N)` for an array G) with a literal N larger than
 *    G's extent, G the global starting at the span's base;
 *  - N is larger than G as Ghidra declares it, not only than its extent clamped at the
 *    next label (a label inside G does not make G's own memset a run);
 *  - the objects come from the address table (one primary per address, extents clamped
 *    at the next base); two that overlap inside the span, or a member the function cannot
 *    name (another function's static), leave the call as printed and are reported.
 *
 * `globalRunMembers` is the selection, shared with the scope analysis that moves a
 * function-local static a span covers out to file scope so this body can reach it.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CallExpr, CompoundStmt, Expression, ExprStmt, Identifier, IntegerLiteralExpr, ParenExpr, QualifiedId,
  Statement, UnaryExpr,
} from '../../../ast/nodes.js';
import { Expr, Stmt, Type } from '../../../ast/factory.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';

export interface GlobalRunClearOptions extends PluginOptions {
  /** Global name (as emitted) -> address. */
  globalAddresses?: Record<string, number>;
  /** Global name -> size in bytes, clamped at the next label (the address table's extents). */
  globalSizes?: Record<string, number>;
  /**
   * Global name -> the size Ghidra declares for the destination, NOT clamped at the next
   * label: a label inside an object (`lpCriticalSection_0089db90`, 0x30 into the 0x50-byte
   * `D2GfxMemoryStrc_0089db60`) must not make the object's own memset look like a run.
   */
  globalDeclaredSizes?: Record<string, number>;
  /** Global name -> element size, for arrays. */
  globalElementSizes?: Record<string, number>;
  /** Global name -> namespace segments of its definition. */
  globalNamespaces?: Record<string, readonly string[]>;
  /** Names this body cannot reach: another function's local statics. */
  unreachable?: ReadonlySet<string> | readonly string[];
  onRewrite?: (info: { name: string; length: number; members: number }) => void;
  onRefusal?: (reason: string) => void;
}

/** One object of a run, and the bytes of it the span covers. */
export interface GlobalRunMember {
  name: string;
  address: number;
  size: number;
  /** Offset into the object of the first byte the span covers. */
  from: number;
  /** Bytes of the object the span covers. */
  length: number;
}

/**
 * Every object whose extent meets [start, start + length), in address order, each with
 * the bytes of it the span covers. Null when two objects overlap inside the span (the
 * table does not say which one holds those bytes).
 */
export function globalRunMembers(
  start: number,
  length: number,
  addresses: Record<string, number>,
  sizes: Record<string, number>,
): GlobalRunMember[] | null {
  const end = start + length;
  const hits: GlobalRunMember[] = [];
  for (const [name, address] of Object.entries(addresses)) {
    const size = sizes[name];
    if (size === undefined || !(size > 0)) continue;
    if (address >= end || address + size <= start) continue;
    const lo = Math.max(start, address);
    const hi = Math.min(end, address + size);
    hits.push({ name, address, size, from: lo - address, length: hi - lo });
  }
  hits.sort((a, b) => a.address - b.address || a.name.localeCompare(b.name));
  for (let i = 1; i < hits.length; i++) {
    const prev = hits[i - 1]!;
    if (hits[i]!.address < prev.address + prev.size) return null;
  }
  return hits;
}

function unwrap(e: Expression): Expression {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as ParenExpr).expression;
  return x;
}

function lastSegment(e: Expression): string | null {
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name;
  if (e.kind === NodeKind.QualifiedId) {
    const q = e as QualifiedId;
    return q.name.kind === NodeKind.Identifier ? (q.name as Identifier).name : null;
  }
  return null;
}

function isMemset(callee: Expression): boolean {
  return lastSegment(unwrap(callee)) === 'memset';
}

/** The global a memset's destination names: `&G`, or `G` for an array. */
function destination(e: Expression, elementSizes: Record<string, number>): string | null {
  const x = unwrap(e);
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '&') return lastSegment(unwrap((x as UnaryExpr).operand));
  const name = lastSegment(x);
  return name && elementSizes[name] !== undefined ? name : null;
}

function literal(e: Expression): number | null {
  const x = unwrap(e);
  if (x.kind !== NodeKind.IntegerLiteral) return null;
  const v = (x as IntegerLiteralExpr).value;
  return v >= 0n && v < 0x1_0000_0000n ? Number(v) : null;
}

/** The global span `memset(&G, 0, N)` clears, when N runs past G; null otherwise. */
export function globalRunSpan(
  call: CallExpr,
  addresses: Record<string, number>,
  sizes: Record<string, number>,
  elementSizes: Record<string, number>,
  declaredSizes: Record<string, number> = sizes,
): { name: string; start: number; length: number } | null {
  if (!isMemset(call.callee) || call.arguments.length !== 3) return null;
  const [dst, value, count] = call.arguments as Expression[];
  if (literal(value!) !== 0) return null;
  const length = literal(count!);
  const name = destination(dst!, elementSizes);
  if (length === null || !name) return null;
  const start = addresses[name];
  const size = Math.max(sizes[name] ?? 0, declaredSizes[name] ?? 0);
  if (start === undefined || !(size > 0) || length <= size) return null;
  return { name, start, length };
}

export function createGlobalRunClearTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as GlobalRunClearOptions;
  const addresses = o.globalAddresses ?? {};
  const sizes = o.globalSizes ?? {};
  const elementSizes = o.globalElementSizes ?? {};
  const declaredSizes = o.globalDeclaredSizes ?? sizes;
  const namespaces = o.globalNamespaces ?? {};
  const unreachable = new Set(o.unreachable ?? []);
  if (Object.keys(addresses).length === 0) return (n: ASTNode) => n;

  const reference = (name: string): Expression => {
    const segs = namespaces[name] ?? [];
    return segs.length === 0 ? Expr.identifier(name) : Expr.qualifiedId([...segs, name]);
  };

  /** One clear: the whole object, or the bytes of it the span covers. */
  function clear(callee: Expression, m: GlobalRunMember): ExprStmt {
    const whole = m.from === 0 && m.length === m.size;
    const at = Expr.unary('&', reference(m.name));
    const args: Expression[] = whole
      ? [at, Expr.intLiteral(0), Expr.sizeof(reference(m.name), false)]
      : [m.from === 0
          ? Expr.cast(Type.pointer(Type.char()), at)
          : Expr.binary(Expr.cast(Type.pointer(Type.char()), at), '+', Expr.intLiteral(m.from)),
        Expr.intLiteral(0), Expr.intLiteral(m.length)];
    return Stmt.expr(Expr.call(callee, args));
  }

  /** The clears replacing `stmt`, or null to leave it. */
  function expanded(stmt: Statement): ExprStmt[] | null {
    if (stmt.kind !== NodeKind.ExprStmt) return null;
    const e = unwrap((stmt as ExprStmt).expression);
    if (e.kind !== NodeKind.CallExpr) return null;
    const call = e as CallExpr;
    const span = globalRunSpan(call, addresses, sizes, elementSizes, declaredSizes);
    if (!span) return null;
    const members = globalRunMembers(span.start, span.length, addresses, sizes);
    if (!members) {
      o.onRefusal?.(`memset(&${span.name}, 0, 0x${span.length.toString(16)}): two objects overlap inside the span`);
      return null;
    }
    const blocked = members.filter(m => unreachable.has(m.name)).map(m => m.name);
    if (blocked.length > 0) {
      o.onRefusal?.(`memset(&${span.name}, 0, 0x${span.length.toString(16)}): ${blocked.join(', ')} is another function's static`);
      return null;
    }
    o.onRewrite?.({ name: span.name, length: span.length, members: members.length });
    const out = members.map(m => clear(call.callee, m));
    // The statement's comments stay with the run: the leading ones before the first clear.
    out[0] = { ...out[0]!, leadingTrivia: stmt.leadingTrivia };
    out[out.length - 1] = { ...out[out.length - 1]!, trailingTrivia: stmt.trailingTrivia };
    return out;
  }

  return createTransformer({
    visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
      let out: Statement[] | null = null;
      for (let i = 0; i < block.statements.length; i++) {
        const st = block.statements[i]!;
        const clears = expanded(st);
        if (!clears && !out) continue;
        if (!out) out = block.statements.slice(0, i);
        out.push(...(clears ?? [st]));
      }
      return out ? ({ ...block, statements: out } as CompoundStmt) : undefined;
    },
  });
}

export const globalRunClearPlugin: TransformPlugin = createPlugin(
  'global-run-clear',
  'Global Run Clear',
  'A memset from one global across the run of globals after it, cleared one object at a time',
  (options?: PluginOptions) => createGlobalRunClearTransformer(options),
  {
    priority: 13, // with the other address passes, before the namespace and cast passes
    defaultEnabled: true,
    tags: ['correctness'],
    version: '1.0.0',
  },
);
