/**
 * Calls the original made and VC8 inlined, found where the decompiler printed them.
 *
 * A function Game.exe holds with VC8's own register convention and no reference
 * anywhere in the image was a static the original called: VC8 emits a static's copy,
 * in a convention of its own, for a call it then inlines (DRLGGRID_GetCellAddress,
 * 0067c4d0, RET 4 with arguments in EAX and EDX). The calls survive only as their
 * inlined bodies, which the decompiler prints in the callers. Declared static and
 * left uncalled, the rebuild's copy disappears; declared extern, it takes the stack
 * convention (RET 0xc). Writing the call back where a caller holds an exact copy of
 * the body, and defining the function `static inline`, gives VC8 what the original
 * gave it: the same inlined code at the site and the same copy.
 *
 * The matching is `inlined-call-restore` (cpp-parser), run here over every function
 * of the callee's unit to decide which callees have a site, and again by the
 * transform pipeline to write the calls. Both parse the same text the same way:
 * the body the pipeline parses, wrapped in the signature it wraps it in.
 */

import {
  NodeKind, parse, preprocessGhidraCode, restoreInlinedCalls,
  type FunctionDecl, type InlinedCallee, type InlinedCallTables,
} from '@ghidra-mcp/cpp-parser';
import type { ExtractedFunction } from '../types.js';
import { decompiledFunctionName, decompiledParameterNames, splitDecompiledBody, wrapperSignature } from './impl.js';

export interface InlinedCallPlan {
  /** Site function address key -> the callees whose calls the pipeline writes back in it. */
  calleesBySite: Map<string, InlinedCallee[]>;
  /** Callee address key -> the site functions holding its body. */
  sitesByCallee: Map<string, Set<string>>;
  /** Callee address key -> the callee as the sites call it. */
  calleeByKey: Map<string, InlinedCallee>;
  /** The declarations argument types are read from, shared with the pipeline. */
  tables: InlinedCallTables;
}

/** The callee as the pipeline would parse its own body, or undefined when its names cannot be trusted. */
export function inlinedCallee(func: ExtractedFunction): InlinedCallee | undefined {
  if (!func.decompiled || func.hasVarArgs) return undefined;
  const sig = wrapperSignature(func);
  const split = splitDecompiledBody(func.decompiled);
  const callName = decompiledFunctionName(func.decompiled);
  if (!sig || !split || !callName) return undefined;
  // The body names its parameters as the decompiler printed them; the wrapper as the
  // definition declares them. A site can only be bound where the two agree.
  const printed = decompiledParameterNames(func.decompiled) ?? [];
  const declared = (func.parameters ?? []).map(p => p.name);
  if (printed.length !== declared.length || printed.some((n, i) => n !== declared[i])) return undefined;
  for (const n of declared) if (!new RegExp(`\\b${n}\\b`).test(sig.params)) return undefined;
  return { callName, returnType: sig.returnType, params: sig.params, body: preprocessGhidraCode(split.body) };
}

/** A function's body parsed exactly as `transformDecompiledCode` hands it to the pipeline. */
export function pipelineFunction(func: ExtractedFunction): FunctionDecl | undefined {
  if (!func.decompiled) return undefined;
  const split = splitDecompiledBody(func.decompiled);
  if (!split) return undefined;
  const sig = wrapperSignature(func);
  const wrapped = `${sig ? `${sig.returnType} dummy(${sig.params}) {` : 'void dummy() {'}${preprocessGhidraCode(split.body)}}`;
  try {
    const tu = parse(preprocessGhidraCode(wrapped));
    return tu.declarations.find(d => d.kind === NodeKind.FunctionDecl) as FunctionDecl | undefined;
  } catch {
    return undefined;
  }
}

/**
 * The sites of each callee in the functions of its unit. `functionsOf` lists a
 * unit's emitted functions; `skipSite` removes the ones whose body is not the
 * decompile (an override replaces or patches it).
 */
export function planInlinedCalls(
  callees: ReadonlyArray<{ key: string; func: ExtractedFunction; unit: string }>,
  functionsOf: (unit: string) => ReadonlyArray<{ key: string; func: ExtractedFunction }>,
  tables: InlinedCallTables,
  skipSite?: (func: ExtractedFunction) => boolean,
): InlinedCallPlan {
  const calleesBySite = new Map<string, InlinedCallee[]>();
  const sitesByCallee = new Map<string, Set<string>>();
  const byUnit = new Map<string, Array<{ key: string; callee: InlinedCallee }>>();
  const calleeByKey = new Map<string, InlinedCallee>();
  for (const c of callees) {
    const callee = inlinedCallee(c.func);
    if (!callee) continue;
    calleeByKey.set(c.key, callee);
    let list = byUnit.get(c.unit);
    if (!list) byUnit.set(c.unit, (list = []));
    list.push({ key: c.key, callee });
  }
  for (const [unit, unitCallees] of byUnit) {
    for (const site of functionsOf(unit)) {
      if (skipSite?.(site.func)) continue;
      const others = unitCallees.filter(c => c.key !== site.key);
      if (others.length === 0) continue;
      const fn = pipelineFunction(site.func);
      if (!fn) continue;
      const { sites } = restoreInlinedCalls(fn, others.map(c => c.callee), tables);
      if (sites.length === 0) continue;
      const hit = new Set(sites.map(s => s.callee));
      const used = others.filter(c => hit.has(c.callee.callName));
      calleesBySite.set(site.key, used.map(c => c.callee));
      for (const c of used) {
        let set = sitesByCallee.get(c.key);
        if (!set) sitesByCallee.set(c.key, (set = new Set()));
        set.add(site.key);
      }
    }
  }
  return { calleesBySite, sitesByCallee, calleeByKey, tables };
}
