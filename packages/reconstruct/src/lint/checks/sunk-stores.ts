/**
 * Stores into a stack object that the decompiler printed AFTER code that reads the object
 * through a pointer.
 *
 * Ghidra treats a load through a pointer as never reading the stack, so a store into an
 * element of an address-taken local array or struct is free to move past such a load. Its
 * heuristics sink the store to just before the next CALL, which is after the inlined
 * strlen/strcpy loop that was meant to see it. `PALSHIFT_LoadMonsterPalShift` @0x00477170
 * stores `szMonsterCode[0..1]` at 004771d9/00477207, before `LEA EAX,[EBP-0xc]` at 00477288
 * starts the copy; the pseudo-C prints both stores after the copy, so every monster's
 * palshift path was built from two NUL bytes.
 *
 * The rule is the `sunk-store-hoist` pass's (cpp-parser), asked of the emitted tree: a site
 * here is one the pass should have moved and did not.
 */

import { NodeKind, findSunkStores, type SunkStoreEnv } from '@ghidra-mcp/cpp-parser';
import { elementType, isArrayType, isPointerType, line, signature, typeWidth } from '../ast.js';
import type { Check, Finding, LintContext } from '../context.js';
import type { FunctionInfo } from '../tree.js';

function lintEnv(ctx: LintContext, fn: FunctionInfo): SunkStoreEnv {
  return {
    body: (fn.node as any).body,
    blocks: ctx.of(fn, NodeKind.CompoundStmt),
    scope: fn.scope(),
    resolve: name => {
      const r = ctx.resolve(fn, { kind: NodeKind.Identifier, name });
      if (!r) return null; // an enumerator or a macro constant
      return { kind: r.kind === 'local' || r.kind === 'param' ? r.kind : 'global' };
    },
    value: e => ctx.value(fn, e),
    width: t => typeWidth(t, ctx.sizeEnv),
    isArray: isArrayType,
    isPointer: isPointerType,
    element: elementType,
  };
}

export const storeSunkPastPointerRead: Check = {
  id: 'store-sunk-past-pointer-read',
  blurb: 'an element store printed after code that reads the object through its address',
  run(ctx) {
    const out: Finding[] = [];
    for (const fn of ctx.tree.functions) {
      if (!(fn.node as any).body) continue;
      for (const s of findSunkStores(lintEnv(ctx, fn))) {
        const st = s.block.statements[s.store];
        const at = s.block.statements[s.hoistTo];
        out.push({
          check: this.id, file: fn.file.path, line: line(st), fn: fn.qualifiedName, subject: s.object,
          detail: `store at line ${line(st)} belongs before the read through its address at line ${line(at)}`
            + (s.beforeCall ? ' (sunk to a call)' : ''),
          sig: `${signature(st)} ${signature(at)}`,
        });
      }
    }
    return out;
  },
};
