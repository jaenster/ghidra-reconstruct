/**
 * The original's memory accesses per line of the parsed text, as the reconstruct side
 * extracts them (reconstruct extract/access-order.ts) and keys them by line of the
 * wrapper the body is parsed in (codegen/access-order-spec.ts). Read by
 * `base-register-load` and `store-order`.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, CallExpr, UnaryExpr } from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { calleeName } from './call-arg-cast.js';

/** A direct call with arguments the original loaded into the register they were addressed through. */
export interface ArgLoadFact {
  name: string;
  at: number;
  /** The callee's declared parameter count. */
  params: number;
  /** `mov reg, [reg + ...]` feeding parameter `param`. */
  loads: readonly { param: number; reg: string }[];
}

/** One `=` the decompile printed on a line. */
export interface StoreFact {
  /** Index among the line's `=` tokens. */
  ord: number;
  /** The store instruction's offset from the entry (the first of an 8-byte pair); null: unknown. */
  at: number | null;
  /** Bytes stored, 0 when unknown. */
  size: number;
  /** 8-byte store: which half the original wrote first. */
  half: 'h' | 'l' | null;
}

export interface AccessOrderEvidence {
  /** Parsed-text line -> the calls on it that load an argument through its own register. */
  args: ReadonlyMap<number, readonly ArgLoadFact[]>;
  /** Parsed-text line -> its `=` stores, in print order. */
  stores: ReadonlyMap<number, readonly StoreFact[]>;
}

export function placed(n: ASTNode): boolean {
  return !!n.location && n.location.file !== '<generated>' && n.location.start.line > 0;
}

/** Calls (not `sizeof`) and writes (assignment, increment, new/delete) anywhere in `e`. */
export function effectsOf(e: ASTNode): { calls: number; writes: number } {
  let calls = 0, writes = 0;
  for (const n of traverseAST(e)) {
    if (n.kind === NodeKind.CallExpr) {
      if (calleeName((n as CallExpr).callee) !== 'sizeof') calls++;
    } else if (n.kind === NodeKind.AssignExpr || n.kind === NodeKind.PostfixExpr
      || n.kind === NodeKind.NewExpr || n.kind === NodeKind.DeleteExpr) {
      writes++;
    } else if (n.kind === NodeKind.UnaryExpr) {
      const op = (n as UnaryExpr).operator;
      if (op === '++' || op === '--') writes++;
    }
  }
  return { calls, writes };
}
