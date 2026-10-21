/**
 * What a lowered SEH frame takes the place of.
 *
 * `seh-lowering` turns an MSVC EH3 `__try` into a `D2SehScope` whose filter, handler
 * and `__finally` block are written inline in the parent (see seh-lowering-spec.ts).
 * Two things in the binary existed only to serve the frame that lowering replaces,
 * and emitting them beside it is wrong rather than redundant:
 *
 *  - the `__finally` block's own function. MSVC compiles the termination handler as
 *    code the parent CALLs on its normal exit and the scope table's handler falls
 *    into on unwind. Ghidra marks it inline, so the parent decompiles with the block
 *    in place - which the lowering turns into the `__finally` lambda - and the
 *    function itself is left with the parent's frame as register "parameters"
 *    (`SOUNDUTIL_CleanupFileMapping` @00516c01 reads `[EBP-0x24]` through an
 *    `int32_t nStackFrame` it is never passed). Nothing else calls it.
 *  - the scope table. `D2SehScope` carries the filter constant and the handler; the
 *    table's `HandlerFunc` points at a label INSIDE the parent (the termination
 *    handler entry 00516bfc, `SOUNDUTIL_ReadVersionResource_finally`), which no C++
 *    initializer can name, and the store that installed it is gone.
 *
 * Decided from the same proof the lowering uses (`sehLoweringDecision`), before any
 * file is written, so the function list, the headers and the globals agree.
 */

import { collectReferencedNames } from './exclusion-closure.js';
import { sehLoweringDecision } from './seh-lowering-spec.js';
import type { ExtractedFunction } from '../types.js';

export interface SehSubsumed {
  /** `__finally` block functions the lowering inlines (normalised hex addresses). */
  finallyBodies: Set<string>;
  /** Scope tables of lowered frames (normalised hex addresses). */
  scopeTables: Set<string>;
}

/** `Game.exe.ram:00516c01`, `0x00516C01` and `00516c01` are one address. */
export function normaliseAddress(address: string): string {
  const hex = address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
  return hex.replace(/^0x/i, '').toLowerCase().replace(/^0+(?=.)/, '');
}

export function sehSubsumedSymbols(functions: ReadonlyArray<ExtractedFunction>): SehSubsumed {
  const finallyBodies = new Set<string>();
  const scopeTables = new Set<string>();
  const byAddress = new Map<string, ExtractedFunction>();
  for (const f of functions) byAddress.set(normaliseAddress(f.address), f);

  for (const parent of functions) {
    const decision = sehLoweringDecision(parent);
    if (!decision || !decision.lower) continue;
    for (const scope of decision.scopes) {
      scopeTables.add(normaliseAddress(scope.scopeTable));
      if (scope.kind !== 'finally' || !scope.bodyAddress) continue;
      const body = byAddress.get(normaliseAddress(scope.bodyAddress));
      if (!body) continue;
      // Only the parent may reach it: a body some other function names keeps its
      // definition, because that caller still needs one.
      // (The substring test only spares the lexer the bodies that cannot name it.)
      const named = functions.some(f => f !== parent && f !== body && f.decompiled
        && f.decompiled.includes(body.name) && collectReferencedNames(f.decompiled).has(body.name));
      if (!named) finallyBodies.add(normaliseAddress(body.address));
    }
  }
  return { finallyBodies, scopeTables };
}
