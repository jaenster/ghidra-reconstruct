/**
 * MSVC C++ exception-handler stubs: defined as a frame that handles nothing.
 *
 * For every function with a C++ EH frame, MSVC emits a compiler-generated
 * `__ehhandler$` stub that loads the function's FuncInfo and jumps to the
 * personality routine. Ghidra decompiles each one as
 *
 *     Fog::Debug::GuardStack();                       // the /GS cookie check, 0-2 times
 *     _Var1 = FID_conflict____CxxFrameHandler3(pExceptionRecord, pRegistrationNode,
 *                                              pContext, pDispatcherContext, &FuncInfo_00700a78);
 *     return _Var1;
 *
 * In 1.14d there are 56, at 0x6c9bfb-0x6ca6c5, named `__GSHandlerCheck_EH_*` /
 * `SehHandler_*` and spread over the root, `_Wrappers` and game namespaces.
 * They are not source: the compiler writes them from the frame's EH tables. The
 * FuncInfo they pass heads a chain (`UnwindMapEntry.action` -> unwind funclets
 * that address the parent frame through EBP) that the tree does not and cannot
 * reconstruct, and the EH metadata globals are dropped by `isMsvcEhInternal`.
 *
 * The decompiled body is never emitted. The kept functions that install one in
 * their SEH frame take its address, but they chain that frame through the
 * `ExceptionList` global, not fs:[0], so the OS never calls it. Each stub is
 * defined to return ExceptionContinueSearch (impl.ts generateEhHandlerDefinition),
 * which is what a frame with no handler for the exception answers, and the
 * tree links with no symbol left to supply by hand.
 *
 * Recognised by shape, not by name or address: the body calls the C++ frame
 * handler with the address of a global whose type is an MSVC EH internal, and
 * calls nothing else but the /GS stack guard.
 */

import { Lexer, TokenKind } from '@ghidra-mcp/cpp-parser';
import { isMsvcEhInternal } from './platform-types.js';

const FRAME_HANDLER = /^_*(?:FID_conflict_*)?_*CxxFrameHandler3$/;
const STACK_GUARD = new Set(['GuardStack', '__security_check_cookie', '___security_check_cookie']);

export function isMsvcEhHandlerStub(
  func: { name: string; decompiled?: string },
  globalTypes: Readonly<Record<string, string>>,
): boolean {
  const body = func.decompiled;
  if (!body) return false;
  const open = body.indexOf('{');
  if (open === -1) return false;
  let tokens;
  try {
    tokens = new Lexer(body.slice(open), { preserveTrivia: false }).tokenize();
  } catch {
    return false;
  }
  let callsFrameHandler = false;
  let passesEhMetadata = false;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== TokenKind.Identifier) continue;
    // The whole `a::b::c` chain; its last segment is the symbol.
    let end = i;
    while (tokens[end + 1]?.kind === TokenKind.ColonColon && tokens[end + 2]?.kind === TokenKind.Identifier) end += 2;
    const name = tokens[end].text;
    const isCall = tokens[end + 1]?.kind === TokenKind.LeftParen;
    i = end;
    if (isCall) {
      if (FRAME_HANDLER.test(name)) callsFrameHandler = true;
      else if (!STACK_GUARD.has(name)) return false;
      continue;
    }
    const type = globalTypes[name];
    if (type && isMsvcEhInternal(type.replace(/[*&]/g, '').replace(/\[[^\]]*\]/g, '').trim())) passesEhMetadata = true;
  }
  return callsFrameHandler && passesEhMetadata;
}
