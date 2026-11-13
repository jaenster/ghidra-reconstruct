/**
 * The thread environment block is not program data.
 *
 * Ghidra's PE loader gives a 32-bit Windows program a TEB block of its own at
 * 0xffdff000 and labels every field there (`ExceptionList`, `Self`,
 * `ProcessEnvironmentBlock`, `LastErrorValue`, ... `FlsData`), so `fs:[0x30]`
 * decompiles to a read of a global. At v1969 that was 86 labels: 81 declared in
 * globals.h and defined in globals.cpp, one homed in Application.cpp, and four
 * static locals, every one of them a zero no thread ever wrote. The block lies
 * outside every section of the image.
 *
 * Each label becomes the field of the running thread's block (`teb-field-access`
 * writes the references) and has no storage of its own.
 *
 * `ExceptionList` (fs:[0]) is left a global. The decompile links SEH frames
 * into it whose layout the emitter does not keep as an EXCEPTION_REGISTRATION_RECORD
 * (Direct3D's frame holds the previous record at +0 but its handler in a local
 * of its own), and written to the real fs:[0] such a frame installs the next
 * field as the handler of the thread's chain.
 */

import type { ExtractedGlobal, ProgramInfo } from '../types.js';
import type { TebField } from '@ghidra-mcp/cpp-parser';
import { normalizeGlobalDeclType, sanitizeSymbolName } from './globals-header.js';

/** Where Ghidra's loader places the TEB of a 32-bit PE, and how far it reaches. */
export const GHIDRA_TEB_BASE_32 = 0xffdff000;
export const GHIDRA_TEB_SIZE = 0x1000;

/** Fields kept as globals: see the module comment. */
const KEPT_AS_GLOBAL = new Set(['ExceptionList']);

export interface TebSplit<T> {
  /** Everything that is program data. */
  globals: T[];
  /** Emitted label name -> the field it reads. */
  fields: Record<string, TebField>;
  /** The labels taken out. */
  removed: T[];
}

function inDataSections(address: number, info: ProgramInfo | undefined): boolean {
  const sections = (info as { dataSections?: Array<[number, number]> } | undefined)?.dataSections;
  return (sections ?? []).some(([lo, hi]) => address >= lo && address < hi);
}

/** True for a label inside Ghidra's TEB block of a 32-bit PE. */
export function isTebLabel(g: Pick<ExtractedGlobal, 'address'>, info: ProgramInfo | undefined): boolean {
  if (!info || info.pointerSize !== 4 || !/Portable Executable/i.test(info.format ?? '')) return false;
  const a = Number.parseInt(g.address.slice(g.address.lastIndexOf(':') + 1).replace(/^0x/i, ''), 16);
  if (!Number.isFinite(a) || a < GHIDRA_TEB_BASE_32 || a >= GHIDRA_TEB_BASE_32 + GHIDRA_TEB_SIZE) return false;
  return !inDataSections(a, info);
}

export function splitTebFields<T extends ExtractedGlobal & { suggestedName?: string; suggestedType?: string }>(
  globals: readonly T[],
  info: ProgramInfo | undefined,
): TebSplit<T> {
  const kept: T[] = [];
  const removed: T[] = [];
  const fields: Record<string, TebField> = {};
  for (const g of globals) {
    const name = sanitizeSymbolName(g.suggestedName || g.name);
    if (!isTebLabel(g, info) || KEPT_AS_GLOBAL.has(name)) { kept.push(g); continue; }
    const a = Number.parseInt(g.address.slice(g.address.lastIndexOf(':') + 1).replace(/^0x/i, ''), 16);
    let type = normalizeGlobalDeclType(g.suggestedType || g.dataType);
    let count: number | undefined;
    const array = /^(.*?)\s*\[(\d+)\]$/.exec(type);
    if (array) { type = array[1].trim(); count = Number(array[2]); }
    removed.push(g);
    if (fields[name] === undefined) fields[name] = { type, offset: a - GHIDRA_TEB_BASE_32, ...(count !== undefined ? { count } : {}) };
  }
  return { globals: kept, fields, removed };
}

let tebFields: Record<string, TebField> = {};
export function setTebFields(fields: Record<string, TebField>): void { tebFields = fields; }
export function getTebFields(): Record<string, TebField> { return tebFields; }
