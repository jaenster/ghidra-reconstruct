/**
 * Calling conventions in emitted declarations.
 *
 * On this ABI the convention is part of a function's TYPE, not a hint about it.
 * A `__stdcall` procedure emitted with no convention is a `__cdecl` procedure,
 * and no conversion exists from one to the other — which is why a thread entry
 * point will not convert to `LPTHREAD_START_ROUTINE`, a window procedure will
 * not convert to `WNDPROC`, and a service handler will not convert to
 * `LPHANDLER_FUNCTION`. Ghidra records the convention at every address; the
 * emitter's job here is only to spell it.
 *
 * What is deliberately NOT spelled:
 *
 * - `__thiscall`. The emitter writes those as free functions carrying an
 *   explicit receiver parameter, and gcc rejects the attribute on a non-member,
 *   so spelling it would trade a silent ABI difference for a hard error.
 * - `__cdecl`. It is the target default; emitting it changes nothing and adds a
 *   keyword to every declaration in the tree.
 * - `unknown`. That is Ghidra saying it has no answer, which is not evidence for
 *   one.
 *
 * The spelling is the bare `__stdcall` / `__fastcall` keyword, which is what
 * `d2_platform.h` already uses for the Smack/Bink imports and for the
 * `__beginthreadex` shim, and what the entry-point forwarder in `impl.ts`
 * already writes. mingw takes it as `__attribute__((stdcall))`; clang on a
 * non-x86 host parses it and ignores it, so the Mac path still compiles.
 */

/** Conventions that are worth spelling and safe to spell. */
const SPELLED: ReadonlySet<string> = new Set(['__stdcall']);

/**
 * The convention keyword for a declaration, or '' when there is nothing to say.
 */
export function conventionKeyword(convention: string | undefined): string {
  if (!convention) return '';
  return SPELLED.has(convention) ? convention : '';
}

/**
 * `<returnType> ` or `<returnType> <convention> ` — the head of a function
 * declaration or definition, with the trailing space the name needs.
 */
export function declarationHead(returnType: string, convention: string | undefined): string {
  const keyword = conventionKeyword(convention);
  return keyword ? `${returnType} ${keyword} ` : `${returnType} `;
}

/**
 * `` or `<convention> ` — what precedes the `*` inside a function-pointer
 * declarator, as in `R (__stdcall *name)(args)`.
 */
export function pointerConvention(convention: string | undefined): string {
  const keyword = conventionKeyword(convention);
  return keyword ? `${keyword} ` : '';
}
