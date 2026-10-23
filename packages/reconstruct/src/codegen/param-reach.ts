/**
 * How far each function's body reaches through each pointer parameter, read from the
 * function's own decompile, on demand - the callee side of `frame-group-locals`' run
 * rule (cpp-parser transform/cfg/param-reach.ts has the per-body analysis).
 *
 * A body is parsed the first time a call asks about it (once per generation worker). A
 * parameter the body passes on to another function reaches what THAT function reaches
 * at that position, asked the same way, so the answer is interprocedural. Unknown
 * (null) is the safe answer and is given for:
 *   - a name that denotes no single function in the model, or one the emitter declares
 *     from a header (a Win32 import, a CRT name) - nothing to read;
 *   - an argument count that is not the callee's parameter count, or a variadic tail:
 *     the call and the prototype disagree about which argument is which parameter;
 *   - a body that reads arguments outside its prototype (`in_stack_...`, `in_EAX`, ...):
 *     the prototype is wrong, so its parameter names are not where the caller's
 *     arguments land;
 *   - a body that does not parse, and a function without one;
 *   - RECURSION. A function already being analysed answers unknown to its own callees.
 *
 * The answer must not depend on the order questions are asked in: generation is sharded
 * and every shard asks a different subset, and the tree must come out byte-identical.
 * So a result that consulted a function still on the analysis stack is kept only for the
 * current top-level question, and recomputed for the next; only a result that touched
 * nothing in progress - a pure function of the callee - is cached for good.
 */

import { parse, preprocessGhidraCode, NodeKind, type FunctionDecl } from '@ghidra-mcp/cpp-parser';
import { paramReaches, type Reach, type ReachField } from '@ghidra-mcp/cpp-parser/transform/cfg/index';
import type { ExtractedDataType, ExtractedFunction, ExtractedStruct } from '../types.js';
import { decompiledBody, makeTypeSize } from './out-params.js';

export interface ParamReachOracle {
  /** Reach of `callee`'s parameter `index` for a call with `argCount` arguments; null = unknown. */
  argReach(callee: string, index: number, argCount: number): Reach;
}

/** A register or stack read outside the prototype: the parameter mapping is not trustworthy. */
const OFF_PROTOTYPE = /^in_(?:E?[A-D]X|[A-D][LH]|E?[SD]I|E?BP|stack_[0-9a-fA-F]+)$/;

/** How deep a chain of pass-throughs is followed before the answer is unknown. */
const MAX_DEPTH = 64;

/** Field tables by aggregate name; a name two aggregates disagree over is dropped. */
function fieldTables(dataTypes: readonly ExtractedDataType[]): Map<string, Map<string, ReachField> | null> {
  const tables = new Map<string, Map<string, ReachField> | null>();
  for (const dt of dataTypes) {
    if (dt.kind !== 'STRUCTURE' && dt.kind !== 'UNION') continue;
    if (dt.detailUnavailable) continue;
    const fields = (dt as ExtractedStruct).fields;
    if (!Array.isArray(fields)) continue;
    const table = new Map<string, ReachField>();
    for (const f of fields) {
      if (!f.name || typeof f.offset !== 'number') continue;
      // A bitfield's storage unit is not its own; keep it out rather than guess.
      if (f.bitSize !== undefined) continue;
      if (table.has(f.name)) { table.delete(f.name); continue; }
      table.set(f.name, { offset: f.offset, type: f.dataType });
    }
    const seen = tables.get(dt.name);
    if (seen === undefined) tables.set(dt.name, table);
    else if (seen !== null && !sameTable(seen, table)) tables.set(dt.name, null);
  }
  return tables;
}

function sameTable(a: Map<string, ReachField>, b: Map<string, ReachField>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.offset !== v.offset || w.type !== v.type) return false;
  }
  return true;
}

/**
 * @param byKey  every call-site spelling of a function (the same keys the cast passes'
 *               parameter tables use) -> the one function it denotes; ambiguous keys absent.
 */
export function createParamReachOracle(
  byKey: ReadonlyMap<string, ExtractedFunction>,
  dataTypes: readonly ExtractedDataType[],
): ParamReachOracle {
  const typeSize = makeTypeSize(dataTypes);
  const tables = fieldTables(dataTypes);
  const field = (aggregate: string, member: string): ReachField | null =>
    tables.get(aggregate)?.get(member) ?? null;

  /** Results that are a pure function of the callee. */
  const settled = new Map<ExtractedFunction, Reach[]>();
  /** Results that consulted a function in progress: valid for the current question only. */
  let provisional = new Map<ExtractedFunction, Reach[]>();
  const stack: { fn: ExtractedFunction; tainted: boolean }[] = [];

  const unknownFor = (fn: ExtractedFunction): Reach[] => (fn.parameters ?? []).map(() => null);

  const resolve = (callee: string): ExtractedFunction | undefined =>
    byKey.get(callee) ?? byKey.get(callee.replace(/^::/, ''));

  const analyse = (fn: ExtractedFunction): Reach[] => {
    const done = settled.get(fn);
    if (done) return done;
    const guessed = provisional.get(fn);
    if (guessed) {
      // Whoever reads a guess inherits it.
      for (const f of stack) f.tainted = true;
      return guessed;
    }
    const at = stack.findIndex(f => f.fn === fn);
    if (at >= 0 || stack.length >= MAX_DEPTH) {
      // Everything above the function in progress now depends on a guess about it.
      for (let i = at >= 0 ? at + 1 : 0; i < stack.length; i++) stack[i].tainted = true;
      return unknownFor(fn);
    }
    const frame = { fn, tainted: false };
    stack.push(frame);
    let answer: Reach[];
    try {
      answer = compute(fn);
    } catch {
      answer = unknownFor(fn);
    } finally {
      stack.pop();
    }
    (frame.tainted ? provisional : settled).set(fn, answer);
    return answer;
  };

  const compute = (fn: ExtractedFunction): Reach[] => {
    const params = [...(fn.parameters ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    const body = fn.decompiled ? decompiledBody(fn.decompiled) : null;
    if (!body || params.length === 0) return unknownFor(fn);
    const tu = parse(`void dummy() {${preprocessGhidraCode(body)}}`) as unknown as { declarations: FunctionDecl[] };
    const f = tu.declarations.find(d => d.kind === NodeKind.FunctionDecl);
    if (!f?.body) return unknownFor(fn);
    // Ghidra prints a register or stack argument outside the prototype under one of
    // these names; the caller's arguments then do not land where the names say.
    const names: string[] = [];
    const stackOf = [f.body as unknown as Record<string, unknown>];
    while (stackOf.length > 0) {
      const n = stackOf.pop()!;
      if (n.kind === NodeKind.Identifier && typeof n.name === 'string') names.push(n.name);
      for (const [k, v] of Object.entries(n)) {
        if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
        for (const ch of Array.isArray(v) ? v : [v]) {
          if (ch && typeof ch === 'object' && typeof (ch as { kind?: unknown }).kind === 'string') {
            stackOf.push(ch as Record<string, unknown>);
          }
        }
      }
    }
    if (names.some(n => OFF_PROTOTYPE.test(n))) return unknownFor(fn);
    return paramReaches(f.body, params.map(p => ({ name: p.name ?? '', type: p.dataType ?? '' })), {
      typeSize,
      field,
      calleeReach: (callee, index, argCount) => reachAt(callee, index, argCount),
    });
  };

  const reachAt = (callee: string, index: number, argCount: number): Reach => {
    const fn = resolve(callee);
    if (!fn) return null;
    const count = fn.parameters?.length ?? 0;
    if (index >= count) return null;
    if (!fn.hasVarArgs && argCount !== count) return null;
    if (fn.hasVarArgs && argCount < count) return null;
    return analyse(fn)[index] ?? null;
  };

  return {
    argReach(callee: string, index: number, argCount: number): Reach {
      // A new question: nothing provisional from the last one may answer it.
      if (stack.length === 0) provisional = new Map();
      return reachAt(callee, index, argCount);
    },
  };
}
