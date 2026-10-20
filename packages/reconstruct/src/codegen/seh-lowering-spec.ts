/**
 * What the instructions prove about a function's EH3 frame, as `seh-lowering` needs it.
 *
 * The decompiler shows the registration and the try-level stores; the filter and the
 * handler are funclets only the scope table reaches, so their meaning is read here off
 * the instructions extraction recorded (`ExtractedFunction.sehFrame`). Only a small,
 * exact vocabulary is accepted:
 *
 *  - a filter that returns a constant: `MOV EAX,imm; RET`, `OR EAX,0xffffffff; RET`
 *    (-1) or `XOR EAX,EAX; RET` (0);
 *  - a handler that reloads ESP (`MOV ESP,dword ptr [EBP + -0x18]`) and goes on, by
 *    fall-through or one jump, at the parent's own `[ebp-4] = <enclosing level>` store:
 *    an empty `__except` block whose code is the code after the `__try`.
 *
 * Each level must be stored exactly once (the decompiler's one printed store is then
 * that instruction). EH4 frames are recognised by extraction but their registration is
 * not typed in Ghidra, so nothing here lowers them; neither are `__finally` entries,
 * whose funclet the normal path also calls.
 */

import type { ExtractedFunction } from '../types.js';
import type { SehInstruction } from '../extract/seh-frames.js';

export interface SehLoweringScopeSpec {
  level: number;
  filter: number;
  filterAddress: string;
  handlerAddress: string;
  resumeAddress: string;
  scopeTable: string;
}

export type SehLoweringDecision =
  | { lower: true; scopes: SehLoweringScopeSpec[] }
  | { lower: false; reason: string };

const ESP_RELOAD = 'MOV ESP,dword ptr [EBP + -0x18]';

/** The constant a filter funclet returns, or undefined when it computes one. */
export function constantFilter(code: SehInstruction[]): number | undefined {
  if (code.length !== 2 || code[1].text !== 'RET') return undefined;
  const t = code[0].text;
  const mov = /^MOV EAX,(0x[0-9a-f]+|\d+)$/i.exec(t);
  if (mov) return Number(BigInt.asIntN(32, BigInt(mov[1])));
  if (/^OR EAX,0xffffffff$/i.test(t)) return -1;
  if (/^XOR EAX,EAX$/i.test(t)) return 0;
  return undefined;
}

/** Where an ESP-reloading handler goes on, if that is the level store it must be. */
export function handlerResume(code: SehInstruction[], enclosingLevel: number): string | undefined {
  if (code.length < 2 || code[0].text !== ESP_RELOAD) return undefined;
  let next = code[1];
  if (/^JMP /.test(next.text)) {
    if (code.length < 3) return undefined;
    next = code[2];
  }
  const want = `MOV dword ptr [EBP + -0x4],0x${(enclosingLevel >>> 0).toString(16)}`;
  if (!next.inParent || next.text.toLowerCase() !== want.toLowerCase()) return undefined;
  return next.address;
}

export function sehLoweringDecision(func: Pick<ExtractedFunction, 'sehFrame'>): SehLoweringDecision | undefined {
  const frame = func.sehFrame;
  if (!frame) return undefined;
  if (frame.kind !== 'eh3') return { lower: false, reason: `${frame.kind} frames are not typed in Ghidra` };
  if (frame.entries.length !== 1) return { lower: false, reason: `${frame.entries.length} scope table entries` };
  const e = frame.entries[0];
  if (e.level !== 0 || e.enclosingLevel !== -1) return { lower: false, reason: 'a nested scope' };
  if (!e.filter) return { lower: false, reason: 'a __finally scope' };
  const filter = constantFilter(e.filterCode);
  if (filter === undefined) return { lower: false, reason: `filter ${e.filter} is not a constant` };
  const resume = handlerResume(e.handlerCode, e.enclosingLevel);
  if (!resume) return { lower: false, reason: `handler ${e.handler} does not resume at the try's exit` };
  if (frame.tryLevelStores['0'] !== 1 || frame.tryLevelStores['-1'] !== 1) {
    return { lower: false, reason: 'a try level is stored more than once' };
  }
  return {
    lower: true,
    scopes: [{
      level: 0,
      filter,
      filterAddress: e.filter,
      handlerAddress: e.handler,
      resumeAddress: resume,
      scopeTable: frame.scopeTable,
    }],
  };
}
