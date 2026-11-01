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

import { parse, preprocessGhidraCode, summarizeWriteEffects, type EffectFunction, type WriteEffect, type CompoundStmt, type FunctionDecl, type AggregateModel } from '@ghidra-mcp/cpp-parser';
import type { DataValue, ExtractedFunction, ExtractedGlobal } from '../types.js';
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

const leafOf = (name: string) => name.slice(name.lastIndexOf(':') + 1);

const isNullAddress = (v: string) => /^(0x)?0+$/i.test(v) || v === 'DAT_00000000';

/**
 * What each scalar global's initial value may call, as its definition is emitted: a null
 * pointer ([]), or the function at the address it holds. Null when it holds anything else,
 * when some datum holds its address (it may then be written through that), or when a
 * function that names it has no body that parses (its stores to it cannot be seen).
 */
function initialTargets(
  globals: readonly (ExtractedGlobal & { initializedData?: DataValue })[], functions: readonly ExtractedFunction[],
  readable: ReadonlySet<string>,
): Record<string, string[] | null> {
  const byAddress = new Map<string, string>();
  for (const f of functions) {
    if (f.address && f.name) byAddress.set(f.address.toLowerCase().replace(/^0x/, ''), f.namespace ? `${f.namespace}::${f.name}` : f.name);
  }
  const addressOf = new Map<string, string>();
  for (const g of globals) if (g.address) addressOf.set(g.address.toLowerCase().replace(/^0x/, ''), leafOf(g.name));
  const referenced = new Set<string>();
  const walk = (d: DataValue | undefined): void => {
    if (!d) return;
    if (d.kind === 'pointer' && d.value) {
      referenced.add(leafOf(d.value.split('+')[0].trim()));
      const at = addressOf.get(d.value.toLowerCase().replace(/^0x/, ''));
      if (at) referenced.add(at);
    }
    for (const e of d.elements ?? []) walk(e);
    for (const f of d.fields ?? []) walk(f.value);
  };
  for (const g of globals) {
    walk(g.initializedData);
    if (g.value) {
      const at = addressOf.get(g.value.toLowerCase().replace(/^0x/, ''));
      if (at) referenced.add(at);
    }
  }
  const out: Record<string, string[] | null> = {};
  for (const g of globals) {
    if (!g.name || g.name.includes('[') || g.dataType.includes('[')) continue;
    const leaf = leafOf(g.name);
    let t: string[] | null;
    const d = g.initializedData;
    if (d) {
      t = d.kind === 'pointer' && d.value
        ? (isNullAddress(d.value) ? [] : [byAddress.get(d.value.toLowerCase().replace(/^0x/, '')) ?? d.value])
        : null;
    } else if (g.value && !isNullAddress(g.value)) {
      const f = byAddress.get(g.value.toLowerCase().replace(/^0x/, ''));
      t = f ? [f] : null;
    } else {
      t = [];
    }
    if (referenced.has(leaf) || (g.referencingFunctions ?? []).some(f => !readable.has(f))) t = null;
    const prev = out[leaf];
    out[leaf] = leaf in out ? (prev === null || t === null ? null : [...prev, ...t]) : t;
  }
  return out;
}

/**
 * `globalTypes`: every global's spelling; an array's name is an address, not a pointer
 * variable. `model.globals` lets a call through a global function pointer resolve to the
 * functions it can hold; `model.aggregates` gives writes through typed pointers their regions.
 */
export function buildWriteEffects(
  functions: readonly ExtractedFunction[], globalTypes: Record<string, string>,
  onUnknown?: (key: string, why: string) => void,
  model: { globals?: readonly ExtractedGlobal[]; aggregates?: AggregateModel } = {},
): Record<string, WriteEffect> {
  const globalArrays = new Set<string>();
  const globalNames = new Set<string>();
  const leafTypes: Record<string, string> = {};
  const spellings = new Map<string, Set<string>>();
  for (const [name, spelling] of Object.entries(globalTypes)) {
    const leaf = leafOf(name);
    globalNames.add(leaf);
    if (spelling.includes('[')) globalArrays.add(leaf);
    let s = spellings.get(leaf);
    if (!s) spellings.set(leaf, s = new Set());
    s.add(spelling);
  }
  // A leaf two globals share has a type only when they agree.
  for (const [leaf, s] of spellings) if (s.size === 1) leafTypes[leaf] = [...s][0];
  const fns: EffectFunction[] = [];
  const readable = new Set<string>();
  for (const fn of functions) {
    if (!fn.name || fn.platform) continue;
    const params = [...(fn.parameters ?? [])].sort((a, b) => a.ordinal - b.ordinal)
      .map((p, i) => (p.name === 'this' ? 'self' : p.name) || `param_${i + 1}`);
    const qualified = fn.namespace ? `${fn.namespace}::${fn.name}` : fn.name;
    const paramTypes = [...(fn.parameters ?? [])].sort((a, b) => a.ordinal - b.ordinal).map(p => p.dataType);
    const body = bodyOf(fn, params);
    if (body) readable.add(qualified);
    fns.push({ keys: suffixes(qualified), params, paramTypes, body });
  }
  return summarizeWriteEffects(fns, {
    globalArrays, globalNames, onUnknown, globalTypes: leafTypes, aggregates: model.aggregates,
    globalInitialTargets: model.globals ? initialTargets(model.globals, functions, readable) : undefined,
  });
}
