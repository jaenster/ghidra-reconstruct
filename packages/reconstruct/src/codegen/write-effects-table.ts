/**
 * The model's write effects (cpp-parser write-effects.ts), read from each function's
 * decompile once per generation: what a call to each function may write, keyed by every
 * spelling a call may use. nest-call reads it to tell an argument a nested call cannot
 * change from one it might.
 *
 * The decompile is parsed as it comes from the database, before any transform: the
 * question is what the original code writes, which the transforms do not change. A body
 * that does not parse is unknown.
 */

import { parse, preprocessGhidraCode, summarizeWriteEffects, type EffectFunction, type WriteEffect, type CompoundStmt, type FunctionDecl } from '@ghidra-mcp/cpp-parser';
import type { ExtractedFunction } from '../types.js';
import { splitDecompiledBody } from './impl.js';

/** Every suffix of a qualified name: `A::B::f`, `B::f`, `f`. */
function suffixes(qualified: string): string[] {
  const parts = qualified.split('::');
  return parts.map((_p, i) => parts.slice(i).join('::'));
}

function bodyOf(fn: ExtractedFunction, params: string[]): CompoundStmt | null {
  if (!fn.decompiled || fn.isExternal || fn.isThunk) return null;
  const split = splitDecompiledBody(fn.decompiled);
  if (!split) return null;
  try {
    const wrapped = `void dummy(${params.map(p => `int ${p}`).join(', ')}) {${preprocessGhidraCode(split.body)}}`;
    const tu = parse(wrapped) as unknown as { declarations: FunctionDecl[] };
    const decl = tu.declarations.find(d => d.body);
    return (decl?.body as CompoundStmt | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Global names declared as arrays: the name is an address, not a pointer variable. */
export function buildWriteEffects(functions: readonly ExtractedFunction[], globalTypes: Record<string, string>): Record<string, WriteEffect> {
  const globalArrays = new Set<string>();
  for (const [name, spelling] of Object.entries(globalTypes)) {
    if (spelling.includes('[')) globalArrays.add(name.slice(name.lastIndexOf(':') + 1));
  }
  const fns: EffectFunction[] = [];
  for (const fn of functions) {
    if (!fn.name || fn.platform) continue;
    const params = [...(fn.parameters ?? [])].sort((a, b) => a.ordinal - b.ordinal)
      .map((p, i) => (p.name === 'this' ? 'self' : p.name) || `param_${i + 1}`);
    const qualified = fn.namespace ? `${fn.namespace}::${fn.name}` : fn.name;
    fns.push({ keys: suffixes(qualified), params, body: bodyOf(fn, params) });
  }
  return summarizeWriteEffects(fns, { globalArrays });
}
