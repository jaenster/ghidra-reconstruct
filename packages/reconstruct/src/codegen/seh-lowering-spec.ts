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
 * A `__finally` entry (no filter) is lowered when the instructions prove where its
 * block is in the decompile:
 *
 *  - after the parent's `[ebp-4] = -1` store comes one CALL T and then nothing but
 *    register loads from the frame up to the `mov fs:[0],reg` deregistration, so the
 *    statements the decompiler prints between that store and the deregistration are
 *    T's body, inlined (Ghidra says "Inlined function"), and nothing else;
 *  - the scope table's handler (the termination handler the unwind calls) reaches T by
 *    fall-through after register setup only (`XOR EBX,EBX`, `MOV EDI,[EBP-0x1c]`):
 *    the unwind path runs the same block.
 *
 * Each level must be stored exactly once (the decompiler's one printed store is then
 * that instruction); a store of a register (`mov [ebp-4],ebx`) counts, its value is the
 * one the decompiler prints. EH4 frames are recognised by extraction but their
 * registration is not typed in Ghidra, so nothing here lowers them.
 */

import type { ExtractedFunction } from '../types.js';
import type { SehInstruction, SehFrameFacts } from '../extract/seh-frames.js';

export interface SehLoweringScopeSpec {
  /** `__except` (the default) or `__finally`. */
  kind?: 'except' | 'finally';
  /** `__finally`: the termination handler's body, which the normal path CALLs. */
  bodyAddress?: string;
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
  if (!e.filter) return finallyDecision(frame);
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

/** Register-only setup a termination handler may run before its body. */
const REGISTER_SETUP = /^(XOR (E[A-Z]{2}),\2|MOV E[A-Z]{2},dword ptr \[EBP \+ -?0x[0-9a-f]+\])$/i;
const FRAME_LOAD = /^MOV E[A-Z]{2},dword ptr \[EBP \+ -?0x[0-9a-f]+\]$/i;
const DEREGISTER = /^MOV dword ptr FS:\[0x0\],E[A-Z]{2}$/i;

/** The `__finally` half: see the header. */
export function finallyDecision(frame: SehFrameFacts): SehLoweringDecision {
  const e = frame.entries[0];
  const stores = frame.tryLevelStores;
  const zero = (stores['0'] ?? 0) + (stores['reg'] ?? 0);
  if (stores['-1'] !== 1 || zero !== 1 || Object.keys(stores).some(k => !['0', '-1', 'reg'].includes(k))) {
    return { lower: false, reason: 'a try level is stored more than once' };
  }
  const leave = Object.values(frame.afterStores ?? {}).find(a => a.level === '-1');
  if (!leave) return { lower: false, reason: 'a __finally scope (no record of the code after the try)' };
  // One CALL T, then frame loads only, then the deregistration.
  const code = leave.code;
  const call = code.findIndex(c => c.callTarget !== undefined);
  if (call < 0) return { lower: false, reason: 'no call of the termination handler after the try' };
  const pre = code.slice(0, call), post = code.slice(call + 1);
  const end = post.findIndex(c => DEREGISTER.test(c.text));
  if (pre.some(c => !FRAME_LOAD.test(c.text)) || end < 0 || post.slice(0, end).some(c => !FRAME_LOAD.test(c.text))) {
    return { lower: false, reason: 'the code between the try and the deregistration is not one call' };
  }
  const body = code[call].callTarget!;
  // The termination handler falls through register setup into the same body.
  const at = e.handlerCode.findIndex(i => i.address === body);
  if (at < 0 || e.handlerCode.slice(0, at).some(i => !REGISTER_SETUP.test(i.text))) {
    return { lower: false, reason: `termination handler ${e.handler} does not reach ${body} by register setup alone` };
  }
  return {
    lower: true,
    scopes: [{
      kind: 'finally',
      bodyAddress: body,
      level: 0,
      filter: 0,
      filterAddress: '-',
      handlerAddress: e.handler,
      resumeAddress: '-',
      scopeTable: frame.scopeTable,
    }],
  };
}
