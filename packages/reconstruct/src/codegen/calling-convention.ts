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
 * Spelled: `__stdcall` and `__fastcall`, as the bare keyword — what
 * `d2_platform.h` already uses for the Smack/Bink imports and what the
 * entry-point forwarder in `impl.ts` writes. mingw takes them as
 * `__attribute__((stdcall))` / `__attribute__((fastcall))`; clang on a non-x86
 * host parses and ignores them, so the Mac path still compiles.
 *
 * Not spelled:
 *
 * - `__thiscall`. The emitter writes those as free functions carrying an
 *   explicit receiver parameter, and gcc rejects the attribute on a non-member,
 *   so spelling it would trade a silent ABI difference for a hard error.
 * - `__cdecl`. It is the target default; emitting it changes nothing.
 * - `unknown`. That is Ghidra saying it has no answer, which is not evidence for
 *   one.
 * - `__fastcall` on a callable with NO parameters and no varargs. `__fastcall`
 *   differs from `__cdecl` only in where the first two arguments travel (ECX,
 *   EDX) and in the callee popping the rest; with no parameters neither exists,
 *   and the two are one ABI: a plain `RET`, the result in EAX. C++ still treats
 *   the spellings as distinct types, so `UIAction_ResetKeyBindingsToDefaults`
 *   (`__fastcall`, no parameters) would not convert to `pfnUIConfigTabAction`
 *   (`__cdecl`, no parameters) although the binary stores one in the other.
 *   Both sides take the `__cdecl` spelling instead. A parameterless `__stdcall`
 *   keeps its keyword although it is the same ABI too: the SDK spells `WINAPI`
 *   on parameterless functions (`GetTickCount`, `GetCurrentThread`), and the
 *   funcdefs that hold them have to match the header, not the other way round.
 */
const SPELLED: ReadonlySet<string> = new Set(['__stdcall', '__fastcall']);

/** The parts of a function or funcdef that decide how its convention is spelled. */
export interface ConventionBearer {
  callingConvention?: string;
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
  if (convention === '__fastcall' && (callable.parameters?.length ?? 0) === 0 && !callable.hasVarArgs) return '';
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
