/**
 * Calling conventions in emitted declarations.
 *
 * On this ABI the convention is part of a function's TYPE, not a hint about it.
 * A `__stdcall` procedure emitted with no convention is a `__cdecl` procedure,
 * and no conversion exists from one to the other — which is why a thread entry
 * point will not convert to `LPTHREAD_START_ROUTINE` and a window procedure will
 * not convert to `WNDPROC`. The same holds for `__fastcall`: a callback the
 * binary calls with ECX/EDX loaded (`ForEachClient`, 0052df26: ECX = client,
 * EDX = context, `CALL EDI`) has to be declared `__fastcall` on both sides, the
 * function and the funcdef it is stored as, or the rebuild passes its arguments
 * on the stack and the callee reads whatever the registers held. Ghidra records
 * the convention at every address and on every funcdef; the emitter's job here
 * is only to spell it, and every declaration, definition, funcdef typedef,
 * function-pointer field and vtable slot asks this module how.
 *
 * Spelled: `__stdcall`, `__fastcall` and `__thiscall`, as the bare keyword —
 * what `d2_platform.h` already uses for the Smack/Bink imports and what the
 * entry-point forwarder in `impl.ts` writes. mingw takes them as
 * `__attribute__((stdcall))` / `((fastcall))` / `((thiscall))`, on a free
 * function and on a member alike; clang on a non-x86 host parses them, warns
 * that the convention is not supported for the target, and ignores them, so
 * the Mac path still compiles.
 *
 * A `__thiscall` function is emitted free, with its receiver as the explicit
 * first parameter (Ghidra's `this`, renamed). The keyword is what puts that
 * parameter in ECX and the rest on the stack for the callee to pop; without it
 * the function is `__cdecl` and every caller outside the rebuild — the
 * original's own vtable dispatch, an injected DLL — passes the receiver where
 * the rebuild does not read it.
 *
 * Not spelled:
 *
 * - `__cdecl`. It is the target default; emitting it changes nothing.
 * - `unknown`. That is Ghidra saying it has no answer, which is not evidence for
 *   one.
 * - `__fastcall` or `__thiscall` on a callable with NO parameters and no
 *   varargs. Both differ from `__cdecl` only in where the first argument(s)
 *   travel (ECX, and EDX for `__fastcall`) and in the callee popping the rest;
 *   with no parameters neither exists, and the conventions are one ABI: a plain
 *   `RET`, the result in EAX. C++ still treats the spellings as distinct types,
 *   so `UIAction_ResetKeyBindingsToDefaults` (`__fastcall`, no parameters)
 *   would not convert to `pfnUIConfigTabAction` (`__cdecl`, no parameters)
 *   although the binary stores one in the other. Both sides take the `__cdecl`
 *   spelling instead. A parameterless `__thiscall` has lost its receiver in the
 *   database; spelling it would assert a register contract nothing supplies.
 *   A parameterless `__stdcall` keeps its keyword although it is the same ABI
 *   too: the SDK spells `WINAPI` on parameterless functions (`GetTickCount`,
 *   `GetCurrentThread`), and the funcdefs that hold them have to match the
 *   header, not the other way round.
 * - `__thiscall` on a non-static member function (a registered template's
 *   member with a receiver). Its receiver is the implicit `this`, and a
 *   member's default convention on this target is already `__thiscall`; the
 *   class declaration, the out-of-class definition and every cast name it the
 *   same way by leaving it implicit.
 * - `__thiscall` with varargs. A variadic member is `__cdecl` on MSVC — the
 *   receiver goes on the stack and the caller pops — and gcc compiles a
 *   variadic `__thiscall` the same way, so the keyword would name a convention
 *   the code does not have.

 *
 * Prototype models the program defines itself — `__stdcall_edxsafe`,
 * `__fastcall_ecxsafe`, `__stdcall_ecxedxsafe`, `__stdcall_x87safe` and the
 * like — are spelled as the stock convention they extend. Such a model differs
 * from its base only in which registers a call leaves intact (EDX moved from
 * killed-by-call to unaffected, say), so the decompiler stops losing a value a
 * caller keeps in that register across the call (0055f240, 006711a0, 0064f0f5).
 * That is a fact about the original's register allocation, already spent in
 * the C the decompiler produced: the caller's source names the value it reuses,
 * and the compiler that builds the rebuild keeps it alive in whatever register
 * it likes. Nothing in the emitted text can say "this call leaves EDX alone",
 * and nothing needs to. What the source does need is where the arguments
 * travel and who pops them, and an unrecognised name used to answer "nowhere
 * special": all such functions came out `__cdecl`.
 *
 * Which base applies is read from the parameter storage when that storage is
 * all-stack or exactly the `__fastcall` registers, because a custom model is
 * always applied with custom storage and the storage is what the callers in the
 * binary honour. `GetItemQuality` (00627e70) carries `__fastcall_ecxsafe` with
 * its one argument at `Stack[0x4]` and returns with `RET 4`: a `__stdcall`
 * function. `SKILLS_PopValue` (006c0ba0) carries `__stdcall_ecxedxsafe` with its
 * argument in ECX and a plain `RET`: a `__fastcall` one. Both conventions pop
 * their own stack arguments, so the storage settles which of the two it is.
 * Storage in any other register (EAX, ESI, ST0 — a file-static function's own
 * convention, see `file-static-functions.ts`) fits neither and keeps the base
 * the model is named after.
 */
import { templateRegistry } from './templates/registry.js';

const SPELLED: ReadonlySet<string> = new Set(['__stdcall', '__fastcall', '__thiscall']);

/** A program-defined prototype model: a stock name, `_`, and what it changes. */
const CUSTOM_MODEL = /^(__cdecl|__stdcall|__fastcall|__thiscall)_[A-Za-z0-9_]+$/;

/** The parts of a function or funcdef that decide how its convention is spelled. */
export interface ConventionBearer {
  callingConvention?: string;
  /** The function's address; a funcdef has none. Says whether it is a non-static member. */
  address?: string;
  /**
   * The declared parameters. Their number matters everywhere; their storage
   * only for a program-defined model (see the module note).
   */
  parameters?: ReadonlyArray<unknown>;
  hasVarArgs?: boolean;
}

/** The register a storage piece names, by its full 32-bit register, or 'stack'. */
function storageHome(piece: string): string | undefined {
  const loc = piece.trim().replace(/:\d+$/, '').toUpperCase();
  if (loc.startsWith('STACK[')) return 'stack';
  if (['ECX', 'CX', 'CL'].includes(loc)) return 'ECX';
  if (['EDX', 'DX', 'DL'].includes(loc)) return 'EDX';
  return loc || undefined;
}

/**
 * `__stdcall` or `__fastcall` when the parameter storage is exactly what that
 * convention does — every argument on the stack, or the first in ECX, the
 * second (if any) in EDX and the rest on the stack — and undefined when it is
 * neither, or when there is no storage to read.
 */
function calleePopConventionFromStorage(parameters: ReadonlyArray<unknown> | undefined): string | undefined {
  const params = [...(parameters ?? [])]
    .map(p => p as { storage?: unknown; ordinal?: unknown })
    .sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0));
  if (params.length === 0) return undefined;
  const homes: string[] = [];
  for (const p of params) {
    if (typeof p.storage !== 'string' || p.storage.includes(',')) return undefined;
    const home = storageHome(p.storage);
    if (!home) return undefined;
    homes.push(home);
  }
  if (homes.every(h => h === 'stack')) return '__stdcall';
  const registers = homes.findIndex(h => h === 'stack');
  const registerPrefix = registers === -1 ? homes : homes.slice(0, registers);
  if (registers !== -1 && homes.slice(registers).some(h => h !== 'stack')) return undefined;
  const fastcallOrder = ['ECX', 'EDX'];
  if (registerPrefix.length <= 2 && registerPrefix.every((h, i) => h === fastcallOrder[i])) return '__fastcall';
  return undefined;
}

/**
 * The stock convention a callable's code follows: Ghidra's own for a stock
 * name, and for a program-defined model the base it extends, chosen between
 * `__stdcall` and `__fastcall` by the parameter storage where that storage is
 * one of the two (see the module note). Undefined, '' and `unknown` pass
 * through unchanged.
 */
export function abiConvention(callable: ConventionBearer): string | undefined {
  const convention = callable.callingConvention;
  const custom = convention ? CUSTOM_MODEL.exec(convention) : null;
  if (!custom) return convention;
  const base = custom[1];
  if (base !== '__stdcall' && base !== '__fastcall') return base;
  if (callable.hasVarArgs) return base;
  return calleePopConventionFromStorage(callable.parameters) ?? base;
}

/**
 * The convention keyword for a declaration, or '' when there is nothing to say.
 */
export function conventionKeyword(callable: ConventionBearer): string {
  const convention = abiConvention(callable);
  if (!convention || !SPELLED.has(convention)) return '';
  const registerPassed = convention === '__fastcall' || convention === '__thiscall';
  if (registerPassed && (callable.parameters?.length ?? 0) === 0 && !callable.hasVarArgs) return '';
  if (convention === '__thiscall' && callable.hasVarArgs) return '';
  if (convention === '__thiscall' && templateRegistry()?.isInstanceMember(callable.address)) return '';
  return convention;
}

/**
 * `<returnType> ` or `<returnType> <convention> ` — the head of a function
 * declaration or definition, with the trailing space the name needs.
 */
export function declarationHead(returnType: string, callable: ConventionBearer): string {
  const keyword = conventionKeyword(callable);
  return keyword ? `${returnType} ${keyword} ` : `${returnType} `;
}

/**
 * `` or `<convention> ` — what precedes the `*` inside a function-pointer
 * declarator, as in `R (__stdcall *name)(args)`.
 */
export function pointerConvention(callable: ConventionBearer): string {
  const keyword = conventionKeyword(callable);
  return keyword ? `${keyword} ` : '';
}
