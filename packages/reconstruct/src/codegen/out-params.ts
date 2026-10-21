/**
 * Which pointer parameters a function only ever WRITES through before reading - its
 * out-parameters - read from each function's own decompile, on demand.
 *
 * The question comes from the call site (`dead-out-slot-store`): a store into a local that
 * the next call overwrites through `&local` is dead only if the callee writes the whole
 * local on every path that returns before it reads it. The callee's body is in the model;
 * it is parsed the first time a call asks about it (once per generation worker), and the
 * answer for a callee whose body passes the pointer on is the answer for ITS callee,
 * asked the same way. A function whose analysis is still running answers no, so a cycle
 * answers no.
 */

import { parse, preprocessGhidraCode, NodeKind, type FunctionDecl, type Statement } from '@ghidra-mcp/cpp-parser';
import { outParamWidths, type OutParamContext } from '@ghidra-mcp/cpp-parser/transform/cfg/index';
import { DEFAULT_NORETURN_FUNCTIONS } from '@ghidra-mcp/cpp-parser/transform/plugins/builtins/goto-cleanup/types';
import type { ExtractedDataType, ExtractedFunction } from '../types.js';

const SCALAR_SIZES: Record<string, number> = {
  char: 1, 'signed char': 1, 'unsigned char': 1, uchar: 1, byte: 1, BYTE: 1, CHAR: 1, bool: 1, int8_t: 1, uint8_t: 1, undefined1: 1, sbyte: 1,
  short: 2, 'unsigned short': 2, ushort: 2, word: 2, WORD: 2, WCHAR: 2, wchar_t: 2, wchar16: 2, int16_t: 2, uint16_t: 2, undefined2: 2, SHORT: 2, USHORT: 2,
  int: 4, 'unsigned int': 4, unsigned: 4, uint: 4, long: 4, 'unsigned long': 4, ulong: 4, dword: 4, DWORD: 4, BOOL: 4, LONG: 4, ULONG: 4, INT: 4, UINT: 4,
  HRESULT: 4, float: 4, int32_t: 4, uint32_t: 4, undefined4: 4, size_t: 4, HANDLE: 4, LPVOID: 4, intptr_t: 4, uintptr_t: 4,
  double: 8, longlong: 8, ulonglong: 8, 'long long': 8, 'unsigned long long': 8, int64_t: 8, uint64_t: 8, undefined8: 8, qword: 8, QWORD: 8,
};

/** Bytes a value of the spelled type occupies (pointers 4), from the model's sizes; null when unknown. */
export function makeTypeSize(dataTypes: readonly ExtractedDataType[]): (spelling: string) => number | null {
  const sizes = new Map<string, number>();
  for (const dt of dataTypes) {
    if (!dt.name || typeof dt.size !== 'number' || dt.size <= 0) continue;
    if (dt.kind === 'STRUCTURE' || dt.kind === 'UNION' || dt.kind === 'ENUM' || dt.kind === 'TYPEDEF') {
      if (!sizes.has(dt.name)) sizes.set(dt.name, dt.size);
      else if (sizes.get(dt.name) !== dt.size) sizes.set(dt.name, -1);
    }
  }
  return (spelling: string): number | null => {
    const s = spelling.replace(/\b(const|volatile|struct|union|enum)\b/g, ' ').replace(/\s+/g, ' ').trim().replace(/^::/, '')
      // The parser spells `short` as `short int`, `unsigned` as `unsigned int`.
      .replace(/\b(short|long long|long|unsigned short|unsigned long long|unsigned long|signed|unsigned)\s+int\b/g, '$1');
    if (!s) return null;
    if (s.endsWith('*')) return 4;
    if (/[[\]()&<>]/.test(s)) return null;
    if (s in SCALAR_SIZES) return SCALAR_SIZES[s];
    const k = sizes.get(s);
    return k !== undefined && k > 0 ? k : null;
  };
}

/** The `{ ... }` body of a decompile (signature and plate stripped), or null. */
export function decompiledBody(decompiled: string): string | null {
  const m = decompiled.match(/\)[\s\n]*\{([\s\S]*)\}[\s\S]*$/);
  return m ? m[1] : null;
}

export interface OutParamOracle {
  outParamWidth(callee: string, index: number): number | null;
  typeSize(spelling: string): number | null;
}

/**
 * @param byKey  every call-site spelling of a function (the same keys the cast passes'
 *               parameter tables use) -> the one function it denotes; ambiguous keys absent.
 */
export function createOutParamOracle(
  byKey: ReadonlyMap<string, ExtractedFunction>,
  dataTypes: readonly ExtractedDataType[],
): OutParamOracle {
  const typeSize = makeTypeSize(dataTypes);
  const results = new Map<ExtractedFunction, Map<number, number> | 'pending'>();
  const noreturn = new Set<string>([...DEFAULT_NORETURN_FUNCTIONS]);
  const analyse = (fn: ExtractedFunction): Map<number, number> => {
    const done = results.get(fn);
    if (done === 'pending') return new Map();
    if (done) return done;
    results.set(fn, 'pending');
    let answer = new Map<number, number>();
    try {
      const params = [...(fn.parameters ?? [])].sort((a, b) => a.ordinal - b.ordinal);
      const body = fn.decompiled ? decompiledBody(fn.decompiled) : null;
      if (body && params.length > 0) {
        const tu = parse(`void dummy() {${preprocessGhidraCode(body)}}`) as unknown as { declarations: FunctionDecl[] };
        const f = tu.declarations.find(d => d.kind === NodeKind.FunctionDecl);
        const stmts = (f?.body as unknown as { statements?: Statement[] } | undefined)?.statements;
        if (stmts) {
          const ctx: OutParamContext = {
            pointeeWidth: (i: number) => {
              const t = (params[i]?.dataType ?? '').trim();
              const m = /^(.*\S)\s*\*$/.exec(t);
              return m ? typeSize(m[1]) : null;
            },
            typeSize,
            calleeOut: (callee: string, index: number) => outParamWidth(callee, index),
            noreturn,
          };
          answer = outParamWidths(stmts, params.map(p => p.name ?? ''), ctx);
        }
      }
    } catch {
      answer = new Map();
    }
    results.set(fn, answer);
    return answer;
  };
  const outParamWidth = (callee: string, index: number): number | null => {
    const fn = byKey.get(callee) ?? byKey.get(callee.replace(/^::/, ''));
    if (!fn) return null;
    return analyse(fn).get(index) ?? null;
  };
  return { outParamWidth, typeSize };
}
