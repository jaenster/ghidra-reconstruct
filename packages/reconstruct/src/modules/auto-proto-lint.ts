/**
 * Call-site prototype overrides (`/auto_proto/dt_*`) must name a calling
 * convention.
 *
 * A varargs override left at `unknown` makes the decompiler fall back to the
 * program's default prototype model — `__stdcall` here, whose `extrapop` is
 * itself unknown, so it derives a callee purge of N*4 from the parameter count.
 * The callee is `__cdecl` (purge 0) and the caller does its own `ADD ESP, N*4`,
 * so ESP is credited twice and the stack model drifts N*4 per overridden call,
 * cumulatively — outgoing-argument blocks and return addresses walk up into the
 * tail of the lowest local array. It cost three investigations to find, and
 * nothing about the emitted C++ says it is happening.
 */

import type { ExtractedDataType, ExtractedFunctionDefinition } from '../types.js';

export interface AutoProtoLintResult {
  /** Overrides whose calling convention is explicitly `unknown`. */
  unknownConvention: string[];
  /** True when the extraction carries no convention for ANY override. */
  conventionUnavailable: boolean;
  /** Total `/auto_proto/` function definitions seen. */
  total: number;
}

const AUTO_PROTO = /(^|\/)auto_proto(\/|$)/;

export function lintAutoProtoConventions(dataTypes: ExtractedDataType[]): AutoProtoLintResult {
  const unknownConvention: string[] = [];
  let total = 0;
  let anyConvention = false;

  for (const dt of dataTypes) {
    if (dt.kind !== 'FUNCTION_DEFINITION') continue;
    if (!AUTO_PROTO.test(dt.category ?? '')) continue;
    total++;
    const cc = (dt as ExtractedFunctionDefinition).callingConvention;
    if (cc === undefined || cc === null || cc === '') continue;
    anyConvention = true;
    if (cc.toLowerCase() === 'unknown') unknownConvention.push(dt.name);
  }

  return {
    unknownConvention,
    conventionUnavailable: total > 0 && !anyConvention,
    total,
  };
}

/** Human-readable lines for the warning channel; empty when the lint is clean. */
export function describeAutoProtoLint(result: AutoProtoLintResult): string[] {
  const lines: string[] = [];
  if (result.unknownConvention.length > 0) {
    const shown = result.unknownConvention.slice(0, 8).join(', ');
    const more = result.unknownConvention.length > 8 ? ', …' : '';
    lines.push(
      `${result.unknownConvention.length} of ${result.total} /auto_proto/ call-site overrides ` +
      `carry callingConvention=unknown (${shown}${more}) — the decompiler will double-credit ` +
      `ESP at those call sites and the stack frames it reports will drift`
    );
  }
  if (result.conventionUnavailable) {
    lines.push(
      `${result.total} /auto_proto/ call-site overrides were extracted without a ` +
      `callingConvention field, so the unknown-convention guard cannot run — the daemon's ` +
      `data-type detail does not carry it`
    );
  }
  return lines;
}
