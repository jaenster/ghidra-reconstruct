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
 */
import { templateRegistry } from './templates/registry.js';

const SPELLED: ReadonlySet<string> = new Set(['__stdcall', '__fastcall', '__thiscall']);

/** The parts of a function or funcdef that decide how its convention is spelled. */
export interface ConventionBearer {
  callingConvention?: string;
  /** The function's address; a funcdef has none. Says whether it is a non-static member. */
  address?: string;
  /** The declared parameters; only their number matters here. */
  parameters?: ReadonlyArray<unknown>;
  hasVarArgs?: boolean;
}

/**
 * The convention keyword for a declaration, or '' when there is nothing to say.
 */
export function conventionKeyword(callable: ConventionBearer): string {
  const convention = callable.callingConvention;
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
