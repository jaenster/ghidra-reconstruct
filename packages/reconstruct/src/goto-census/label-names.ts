/**
 * Names for the gotos that stay (design section 6, step 11).
 *
 * A kept goto gets the name a programmer plausibly gave its label, derived from evidence in
 * the function itself - never `LAB_xxxx`, never a counter that claims nothing. The names go
 * into Ghidra as labels at the block's address (by the single writer, from the proposals
 * TSV); the decompile then prints them, so the generator never invents a label name.
 *
 * A wrong name is worse than `LAB_`: every rule below would rather leave a label as a
 * residual ticket than name it from weak evidence.
 *
 * In order, the first rule that applies:
 *
 *   library     the library source's own label (library-evidence.ts `sourceLabel`, or a fact
 *               keyed by the block's address - `dodist` in zlib's inflate_fast), and the
 *               library's case enumerators (zlib inflate's `inflate_mode`)
 *   user        a label someone already named: kept as it is
 *   structural  true by construction from where the label sits:
 *                 case_<v>       a case body entered from outside its case; v as written
 *                                (`0x1b`, an enumerator), a char as its letter or code
 *                                (`case_z`, `case_0x24`), a negative or high value as
 *                                unsigned 32-bit hex (`case_0x80000006`)
 *                 end_<x>_loop   the follow of the loop around the jumps (a break out of more
 *                                than one level); x is the variable that loop steps
 *                 next_<x>       the continue point of an enclosing loop, from a nested one
 *                 resume_<x>     a point inside a loop entered from outside it
 *               None of the three without the loop's variable: `end_outer_loop`,
 *               `next_outer`, `resume_loop` claim nothing, and the descriptive rule names
 *               the block instead.
 *               None of the loop names for a block that runs straight to a return or halt:
 *               that is an exit Ghidra laid inside the loop, named by the semantic rule.
 *   semantic    the block from the label runs straight (no control flow, at most 8
 *               statements) to a return, a halt, or the end of a void function:
 *                 error          it releases an acquired resource, returns a failure value,
 *                                is not fallen into, and the function returns something else
 *                                elsewhere
 *                 cleanup        it releases an acquired resource otherwise
 *                 done           it only stores (out-params, fields) and returns
 *               A release is a resource verb (Free, Close, Release, Unlock, Leave, Destroy..)
 *               on something the function acquired (assigned from a call, or passed to an
 *               acquiring call: Alloc, Open, Create, Lock, Enter..); UI verbs (close a menu)
 *               are not releases.
 *   descriptive what the block does first, in the corpus's lower-case: the call it makes
 *               (`play_sound` for `SOUND_PlaySound(...)`), the field it sets (`set_mode`),
 *               steps (`step_count`) or clears (`clear_next`), what it tests first
 *               (`check_mode`) - for a shared block that is not an exit.
 *
 * Evidence is a name a person gave: never a decompiler default (`iVar1`, `uStack_c`), a type
 * name from a cast (`uint32_t`), a flag or compare lowering temporary (`bSignedLess`,
 * `nCmpResult`), a positional or scratch name (`nParam2`, `dwArg0`, `pTmp`, `xCopy`), an
 * unknown-field placeholder (`unk0x14`, `field18`), a member of a decompiler stack temp
 * (`PStack_108.y`), a FILE field (`_base`), or a function spelled like a global
 * (`gnRecordingIndex`). A getter whose result only feeds the next statement names nothing;
 * the consumer does. A verbatim one-word API call (`socket`, `sleep`, `unlock`) takes what it
 * works on, or names nothing.
 *
 * A second label with the same name in one function takes another word of its block that
 * the name does not say, else the suffix `2` (`3`, ..) - never an incidental literal.
 */

import { NodeKind, emit } from '@ghidra-mcp/cpp-parser';

type Any = any;

export interface LabelProposal {
  label: string;
  name: string;
  kind: 'library' | 'user' | 'structural' | 'semantic' | 'descriptive' | 'residual';
  evidence: string;
}

const KEYWORDS = new Set(['break', 'case', 'continue', 'default', 'do', 'else', 'for', 'goto', 'if', 'return', 'switch', 'while', 'int', 'char', 'void', 'new', 'delete', 'this', 'try', 'catch', 'throw', 'true', 'false', 'auto', 'register', 'static', 'const', 'volatile', 'union', 'struct', 'class', 'enum', 'unsigned', 'signed', 'long', 'short', 'float', 'double', 'sizeof', 'operator', 'template', 'typename', 'public', 'private', 'protected', 'virtual', 'inline', 'extern', 'friend', 'namespace', 'using', 'bool']);
const GHIDRA_LABEL = /^(LAB_|switchD_|caseD_|joined_r0x|code_r0x|override_jmp_)/;

export const isGhidraLabel = (n: string) => GHIDRA_LABEL.test(n);

// ---------------------------------------------------------------- library facts

/** zlib 1.2.8 inflate.h `inflate_mode`, by value: inflate()'s case labels. */
export const ZLIB_INFLATE_MODE = ['HEAD', 'FLAGS', 'TIME', 'OS', 'EXLEN', 'EXTRA', 'NAME', 'COMMENT', 'HCRC', 'DICTID', 'DICT', 'TYPE', 'TYPEDO', 'STORED', 'COPY_', 'COPY', 'TABLE', 'LENLENS', 'CODELENS', 'LEN_', 'LEN', 'LENEXT', 'DIST', 'DISTEXT', 'MATCH', 'LIT', 'CHECK', 'LENGTH', 'DONE', 'BAD', 'MEM', 'SYNC'];
/** Functions whose switch cases are a library's enumerators, by function address. */
export const LIBRARY_CASE_ENUMS: Readonly<Record<string, { enumerators: readonly string[]; source: string }>> = {
  '00429bb0': { enumerators: ZLIB_INFLATE_MODE, source: 'zlib 1.2.8 inflate.c (inflate_mode, inflate.h)' },
};
/** Library source labels keyed by the block's address (the function is identified by address, not by its symbol). */
export const LIBRARY_ADDRESS_LABELS: Readonly<Record<string, { fn: string; name: string; evidence: string }>> = {
  '0042de50': { fn: '0042dca0', name: 'dodist', evidence: 'zlib 1.2.8 inffast.c `dodist:`: the second-level distance code loop that `goto dodist` re-enters (inflate_fast, 0042dca0)' },
};

// ---------------------------------------------------------------- AST helpers

function strip(e: Any): Any {
  while (e && (e.kind === NodeKind.ParenExpr || e.kind === NodeKind.CStyleCastExpr)) e = e.expression;
  return e;
}

function kids(n: Any): Any[] {
  const out: Any[] = [];
  for (const k of Object.keys(n)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
    const v = n[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && typeof x.kind === 'string') out.push(x); }
    else if (v && typeof v === 'object' && typeof v.kind === 'string') out.push(v);
  }
  return out;
}
function* all(n: Any): Generator<Any> {
  if (!n || typeof n !== 'object') return;
  yield n;
  for (const c of kids(n)) yield* all(c);
}

/** lower_snake from PascalCase / camelCase, Hungarian prefix and module tag removed. */
export function snake(raw: string, dropHungarian = false): string {
  let s = raw.replace(/^.*::/, '');
  // a leading underscore hides the Hungarian prefix (`_bIsOpen`)
  s = s.replace(/^_+/, '');
  // Storm's S<Group> prefix (SStrCopy, SFileReadFile, SMemFree) is a module tag; a lone word
  // left keeps the group as its noun (SStrCopy -> str_copy)
  const storm = /^S(Str|File|Mem|Reg|Net|Bmp|Draw|Evt|Msg|Comp|Err|Trans|Cmd|Video|Big|Code|Dlg|Gdi|Log|Uni|Lock)(?=[A-Z])/.exec(s);
  if (storm) { const rest = s.slice(storm[0].length); s = /[a-z][A-Z]/.test(rest) ? rest : `${storm[1]}_${rest}`; }
  // MODULE_ tags (NET_D2GS_ConnectToServer -> ConnectToServer); a lone word left keeps the
  // last tag as its verb (DRAW_text -> draw_text).
  const tags = /^((?:[A-Z0-9]{2,}_)+)(?=[A-Za-z])/.exec(s);
  if (tags) {
    s = s.slice(tags[1].length);
    if (!/[a-z][A-Z]/.test(s) && !/_/.test(s)) s = tags[1].split('_').filter(Boolean).pop()!.toLowerCase() + '_' + s;
  }
  if (dropHungarian) s = s.replace(/^g_/, 'g').replace(/^(lpwsz|lpsz|pwsz|wsz|psz|pfn|fp|pp|pw|pb|pn|p|n|dw|w|by|b|e|sz|f|a|g[a-z]{0,3}|i|u|s|h|lp|c|ch)(?=[A-Z])/, '').replace(/^(Wsz|Sz|Psz|Pfn)(?=[A-Z])/, '');
  // a hex number is one word (`From0xAE` -> from_0xae)
  s = s.replace(/0x([0-9A-Fa-f]+)/g, (_m, h: string) => `_0x${h.toLowerCase()}_`);
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
  s = s.replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const words = s.split('_').filter(Boolean).slice(0, 5);
  return words.join('_');
}

/** A function spelled like a global (`gnRecordingIndex`): its name is not evidence. */
const GLOBAL_SPELLED = /^g_?(?!et[A-Z]|o[A-Z]|en[A-Z])[a-z]{0,3}[A-Z]/;
/** A decompiler default name: no evidence of what the value is. */
const DEFAULT_NAME = /^(param_\d+|local_\w+|[A-Za-z]{1,3}Var\d+|[A-Za-z]{1,4}Stack\w*|extraout_\w+|in_\w+|unaff_\w+|DAT_\w+|PTR_\w+|FUN_\w+|temp_\w+|register0x\w+|stack0x\w+)$/;
/**
 * Names that are not evidence of what a block does (rule 3 of the step-11 check): type names
 * from casts, flag and compare lowering temporaries, positional and scratch names, unknown-field
 * placeholders, FILE fields on a mistyped struct.
 */
const NOT_EVIDENCE: RegExp[] = [
  /^_*u?int(\d+|ptr|max)?(_t)?$/i, /^\w+_t$/, /^(undefined\d*|byte|word|dword|qword|bool|char|uchar|ushort|uint|ulong|size_t|float\d*|double|code|pointer\d*)$/i,
  /^b(Signed|Unsigned)?(Less|Greater|Below|Above|Carry|Overflow|Zero|Sign|Parity|Equal)/, /^b?(Carry|Overflow)\w*$/,
  /Cmp(Sign|Result|Diff)?/i, /ByteDiff/i, /MemcmpResult/i, /StrcmpResult/i,
  /^[a-z]{0,3}_?(Param|Arg)\d*$/i, /^[a-z]{0,3}_?(Param|Arg)\d+/i, /Tmp/i, /^[a-z]{0,3}_?Temp\d*$/i, /Copy\d*$/, /^[a-z]{0,3}Scratch/i,
  /^[a-z]{0,3}_?(unk|unknown|field|dummy|pad|padding|reserved|undefined|unused|stub)(_|\d|[A-Z]|$)/i, /0x[0-9a-f]+/i, /_[0-9a-f]*\d[0-9a-f]*$/i, /^[A-Za-z]?_?(?=[0-9a-f]*\d)[0-9a-f]{2,}$/,
  /^_(base|flag|ptr|cnt|charbuf|bufsiz|tmpfname|file)$/, /Var\d+$/, /^__/, /^_*frame\d*$/i, /^[A-Z][A-Z0-9_]+$/,
];
/** Whether a variable or field name is evidence; `call` judges a callee's name (only defaults, types, global spellings fail). */
export function isEvidence(n: string | null | undefined, call = false): boolean {
  if (!n) return false;
  if (DEFAULT_NAME.test(n)) return false;
  if (call) {
    if (NOT_EVIDENCE[0].test(n) || NOT_EVIDENCE[1].test(n) || NOT_EVIDENCE[2].test(n) || /0x[0-9a-f]+/i.test(n) || /^(sub|fn|func|unk)_?[0-9a-f]+$/i.test(n)) return false;
    // a generator macro (D2_STORE24) is not in Ghidra; a placeholder function names nothing
    if (!/[a-z]/.test(n)) return false;
    if (/(^|_)(Stub|Unused|Unknown|Dummy|Placeholder)/i.test(n)) return false;
    if (GLOBAL_SPELLED.test(n) && !/(pfn|fn|Fn|Func|Callback|Proc|Handler)/.test(n)) return false;
    return snake(n).length > 1;
  }
  for (const r of NOT_EVIDENCE) if (r.test(n)) return false;
  return snake(n, true).length > 1;
}
/**
 * The function's locals while a label is named. A local's name is not evidence for a label:
 * the decompiler merges reused stack slots and registers into one variable and its name fits
 * only one of the uses (the step-11 re-read: nearly every wrong name came from a misnamed or
 * reused local). Fields, globals, parameters and called functions are named once, for one thing.
 */
let currentLocals: ReadonlySet<string> = new Set();
// `nAlignment_00` is Ghidra's second variable for nAlignment: the name is still evidence.
const evidenceName = (n: string | null) => { if (!n) return null; const m = n.replace(/_0\d*$/, ''); return isEvidence(m) ? m : null; };
const named = (n: string | null) => (n && currentLocals.has(n) ? null : evidenceName(n));

/** The identifier at the root of an lvalue / member chain (`PStack_108.y` -> PStack_108). */
function rootIdent(e: Any): string | null {
  e = strip(e);
  while (e) {
    if (e.kind === NodeKind.Identifier) return e.name;
    if (e.kind === NodeKind.MemberExpr) e = strip(e.object);
    else if (e.kind === NodeKind.SubscriptExpr) e = strip(e.array);
    else if (e.kind === NodeKind.UnaryExpr) e = strip(e.operand);
    else return null;
  }
  return null;
}
/** A member's name, unless it is a member of a decompiler temp (whose type is a guess). */
function memberName(x: Any): string | null {
  const root = rootIdent(x.object);
  if (root && DEFAULT_NAME.test(root.replace(/_0\d*$/, '')) && /Stack|^local_/.test(root)) return null;
  // a member of a frame group (`__frame0.x`) is a local the generator grouped
  if (root && /^__frame\d*$/.test(root)) return null;
  return evidenceName(x.member?.name ?? null);
}

function calleeName(e: Any): string | null {
  e = strip(e);
  if (!e) return null;
  if (e.kind === NodeKind.AssignExpr) return calleeName(e.right);
  if (e.kind !== NodeKind.CallExpr) return null;
  let c = strip(e.callee);
  if (c.kind === NodeKind.QualifiedId) c = c.name;
  if (c.kind === NodeKind.Identifier) return c.name;
  if (c.kind === NodeKind.MemberExpr) return c.member?.name ?? null;
  // (*pfn)(..): the pointer's name
  if (c.kind === NodeKind.UnaryExpr && c.operator === '*') { const o = strip(c.operand); if (o.kind === NodeKind.Identifier) return o.name; if (o.kind === NodeKind.MemberExpr) return o.member?.name ?? null; }
  return null;
}
function callOf(e: Any): Any | null {
  e = strip(e);
  if (e?.kind === NodeKind.AssignExpr) e = strip(e.right);
  return e?.kind === NodeKind.CallExpr ? e : null;
}

/** The innermost name an lvalue writes: `p->mode` -> mode, `aBuf[i]` -> aBuf, `*pOut` -> pOut. */
function lvalueName(e: Any): string | null {
  e = strip(e);
  if (!e) return null;
  if (e.kind === NodeKind.Identifier) return named(e.name);
  if (e.kind === NodeKind.MemberExpr) return memberName(e);
  if (e.kind === NodeKind.SubscriptExpr) return lvalueName(e.array);
  if (e.kind === NodeKind.UnaryExpr) return lvalueName(e.operand);
  return null;
}

/** Flatten a tail: its statements in order, through compounds and labels. */
function flatTail(stmts: Any[]): Any[] {
  const out: Any[] = [];
  for (let s of stmts) {
    while (s && (s.kind === NodeKind.LabelStmt || s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt)) s = s.statement;
    if (!s || s.kind === NodeKind.NullStmt) continue;
    if (s.kind === NodeKind.CompoundStmt) out.push(...flatTail(s.statements));
    else out.push(s);
  }
  return out;
}

function isFailureValue(e: Any): boolean {
  e = strip(e);
  if (!e) return false;
  if (e.kind === NodeKind.IntegerLiteral) return BigInt(e.value) === 0n;
  if (e.kind === NodeKind.UnaryExpr && e.operator === '-') return true;
  if (e.kind === NodeKind.NullptrLiteral) return true;
  if (e.kind === NodeKind.BoolLiteral) return e.value === false;
  if (e.kind === NodeKind.Identifier) return /^(FALSE|NULL)$/.test(e.name);
  return false;
}

/** The first name in evaluation order that is evidence (a field, a named variable). */
function firstNamed(e: Any): string | null {
  for (const x of all(e)) {
    if (x.kind === NodeKind.MemberExpr) { const m = memberName(x); if (m) return m; continue; }
    if (x.kind === NodeKind.Identifier && named(x.name)) return named(x.name);
  }
  return null;
}
function usesName(n: Any, name: string): boolean {
  for (const x of all(n)) if (x.kind === NodeKind.Identifier && x.name === name) return true;
  return false;
}

// ---------------------------------------------------------------- releases

const RELEASE_API = /^(LeaveCriticalSection|CloseHandle|RegCloseKey|closesocket|fclose|_?free|FindClose|ReleaseDC|DeleteDC|DeleteObject|GlobalFree|GlobalUnlock|LocalFree|HeapFree|VirtualFree|UnmapViewOfFile|ImmReleaseContext|FreeLibrary|ReleaseMutex|ReleaseSemaphore|CloseServiceHandle|InternetCloseHandle|SMemFree|SFileCloseFile|SFileCloseArchive|SRegCloseKey|_close|_fclose|delete|operator_delete)$/;
const RELEASE_VERB = new Set(['free', 'release', 'close', 'destroy', 'unlock', 'leave', 'unload', 'unmap', 'dealloc', 'delete', 'unregister', 'unreserve']);
const UI_OBJECT = /(interaction|menu|panel|window|dialog|ui|screen|npc|ai|think|tooltip|popup|box|text|chat|cursor)/;
const ACQUIRE_VERB = /^(alloc|allocate|malloc|calloc|realloc|new|create|open|lock|enter|acquire|get|load|map|init|initialize|begin|find|query|reserve|register|duplicate|dup|connect|fopen|reg)$/;

/** A call name's words after its namespace, module tags and pointer prefix (`FOG_Free` -> free). */
function bareWords(call: string): string[] {
  const s = call.replace(/^.*::/, '').replace(/^_+/, '').replace(/^((?:[A-Z0-9]{2,}_)+)(?=[A-Za-z])/, '').replace(/^(pfn|fp|p)(?=[A-Z])/, '');
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
/** The verb word of a call name: the first word after module tags. */
const verbOf = (call: string) => bareWords(call)[0] ?? '';

function isReleaseCall(call: string): boolean {
  const base = call.replace(/^.*::/, '');
  if (RELEASE_API.test(base)) return true;
  const w = bareWords(base);
  if (!RELEASE_VERB.has(w[0])) return false;
  return !w.slice(1).some(x => UI_OBJECT.test(x));
}

/** The release verb of a call (`LeaveCriticalSection` -> leave, `SMemFree` -> free). */
function releaseVerb(call: string): string | null {
  const w = bareWords(call);
  for (const x of w) if (RELEASE_VERB.has(x)) return x;
  if (/^closesocket$/i.test(call.replace(/^.*::/, ''))) return 'close';
  if (/^_?f?close$/.test(call.replace(/^.*::/, ''))) return 'close';
  if (/^_?free$/.test(call.replace(/^.*::/, ''))) return 'free';
  return null;
}
/** What acquires what each release verb gives back. */
const PAIRED: Record<string, RegExp> = {
  free: /^(alloc|allocate|malloc|calloc|realloc|new|create|dup|duplicate|load|strdup)$/,
  dealloc: /^(alloc|allocate|new)$/,
  delete: /^(new|create|alloc|allocate)$/,
  release: /^(acquire|create|get|query|lock|alloc|init|initialize)$/,
  close: /^(open|fopen|create|connect|socket|find|accept|dup|duplicate)$/,
  destroy: /^(create|alloc|allocate|new|init|initialize|build)$/,
  unlock: /^(lock|get|find)$/,
  leave: /^(enter)$/,
  unload: /^(load)$/,
  unmap: /^(map)$/,
  unregister: /^(register)$/,
  unreserve: /^(reserve)$/,
};

/**
 * Whether the function acquired, before the label, what `call` releases: an acquiring call
 * of the paired verb whose result is stored in the released object (`p = FOG_Alloc(..)` ..
 * `FOG_Free(p)`), or that takes the released object (`EnterCriticalSection(&cs)` ..
 * `LeaveCriticalSection(&cs)`), or - for a release without an object - names the same thing
 * (`MPQ_LoadAllMediaMpqFiles` .. `MPQ_UnloadAllMediaMpqFiles`).
 */
function acquiredBefore(fnBody: Any, before: number, call: Any, name: string): boolean {
  const verb = releaseVerb(name);
  if (!verb) return false;
  const pair = PAIRED[verb];
  const objs = new Set<string>();
  const callee = strip(call.callee);
  if (callee?.kind === NodeKind.MemberExpr) { const r = rootIdent(callee.object); if (r) objs.add(r); }
  for (const a of call.arguments ?? []) { const r = rootIdent(a); if (r) objs.add(r); }
  const rest = bareWords(name).filter(x => x !== verb).join('_');
  const pairs = (c: string) => bareWords(c).some(x => pair.test(x)) || (verb === 'leave' && /EnterCriticalSection/.test(c)) || (verb === 'close' && /^(CreateFile\w*|OpenFile|RegOpenKey\w*|socket|FindFirstFile\w*)$/.test(c)) || (verb === 'free' && /^(LoadLibrary\w*|GlobalAlloc|LocalAlloc|HeapAlloc|VirtualAlloc)$/.test(c));
  for (const x of all(fnBody)) {
    if ((x.location?.start?.offset ?? -1) >= before) continue;
    if (x.kind === NodeKind.AssignExpr || x.kind === NodeKind.VariableDecl) {
      const rhs = strip(x.kind === NodeKind.AssignExpr ? x.right : x.initializer);
      const c = rhs?.kind === NodeKind.CallExpr ? calleeName(rhs) : null;
      const r = x.kind === NodeKind.AssignExpr ? rootIdent(x.left) : x.name?.name;
      if (c && r && objs.has(r) && pairs(c)) return true;
    }
    if (x.kind === NodeKind.CallExpr) {
      const c = calleeName(x);
      if (!c || !pairs(c)) continue;
      for (const a of x.arguments ?? []) { const r = rootIdent(a); if (r && objs.has(r)) return true; }
      if (objs.size === 0 && rest && bareWords(c).filter(w => !pair.test(w)).join('_') === rest) return true;
    }
  }
  return false;
}

/** Releases in the block whose object the function acquired before the label. */
function releases(block: Any[], fnBody: Any | undefined, before = Infinity): string[] {
  const out: string[] = [];
  for (const s of block) {
    if (s.kind !== NodeKind.ExprStmt) continue;
    const call = callOf(s.expression);
    const name = call ? calleeName(call) : null;
    if (!call || !name || !isReleaseCall(name)) continue;
    if (!fnBody) { out.push(name); continue; }
    // released and then acquired again in the same block (unload, reload) is a refresh, not a release
    const words = bareWords(name).slice(1).join('_');
    const reacquired = block.slice(block.indexOf(s) + 1).some(t => { const n2 = t.kind === NodeKind.ExprStmt ? calleeName(t.expression) : null; return !!n2 && ACQUIRE_VERB.test(verbOf(n2)) && bareWords(n2).slice(1).join('_') === words; });
    if (reacquired) continue;
    if (acquiredBefore(fnBody, before, call, name)) out.push(name);
  }
  return out;
}

/** Whether another exit of the function (a return outside the block) also makes one of these releases first. */
function otherExitReleases(fnBody: Any, block: Any[], names: string[]): boolean {
  const inBlock = new Set(block);
  const want = new Set(names.map(n => n.replace(/^.*::/, '')));
  for (const x of all(fnBody)) {
    if (x.kind !== NodeKind.CompoundStmt) continue;
    const list = flatTail(x.statements);
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind !== NodeKind.ReturnStmt || inBlock.has(list[i])) continue;
      for (let k = i - 1; k >= 0 && list[k].kind === NodeKind.ExprStmt; k--) {
        const c = calleeName(list[k].expression);
        if (c && want.has(c.replace(/^.*::/, ''))) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- describe

/** A call's name as a label: a one-word or CRT routine takes what it works on. */
function callLabel(call: string, e: Any): string | null {
  const ptr = /^p[A-Z]|^pfn|^fp[A-Z]/.test(call);
  const nm = snake(call, ptr);
  if (!nm || !isEvidence(call.replace(/^.*::/, ''), true)) return null;
  const oneWord = !nm.includes('_') || /^[a-z_0-9]+$/.test(call.replace(/^.*::/, ''));
  if (oneWord && !ptr) {
    const c = callOf(e);
    const args = c?.arguments ?? [];
    let on: string | null = null;
    const callee = c ? strip(c.callee) : null;
    if (callee?.kind === NodeKind.MemberExpr) on = firstNamed(callee.object);
    if (!on) for (const a of args) { on = firstNamed(a); if (on) break; }
    if (on) { const o = snake(on, true); return o && !nm.split('_').includes(o) ? `${nm}_${o}` : nm.includes('_') ? nm : null; }
    // a verbatim one-word API (`socket`, `sleep`, `unlock`) claims nothing on its own
    return nm.includes('_') ? nm : null;
  }
  return ptr ? `call_${nm}` : nm;
}

const GETTER = /^(get|find|lookup|query|read|fetch|load)$/;

function isZero(e: Any): boolean {
  e = strip(e);
  return !!e && ((e.kind === NodeKind.IntegerLiteral && BigInt(e.value) === 0n) || e.kind === NodeKind.NullptrLiteral || (e.kind === NodeKind.BoolLiteral && e.value === false) || (e.kind === NodeKind.Identifier && /^(NULL|FALSE)$/.test(e.name)));
}

/** The first leaf of a condition in evaluation order (through &&, ||, !, comma). */
function firstLeaf(c: Any): Any {
  c = strip(c);
  while (c) {
    if (c.kind === NodeKind.BinaryExpr && (c.operator === '&&' || c.operator === '||' || c.operator === ',')) c = strip(c.left);
    else if (c.kind === NodeKind.UnaryExpr && c.operator === '!') c = strip(c.operand);
    else break;
  }
  return c;
}

function describeTest(cond: Any, verb: string, how: string): { name: string; why: string } | null {
  const leaf = firstLeaf(cond);
  if (!leaf) return null;
  const callNode = [...all(leaf)].find(x => x.kind === NodeKind.CallExpr);
  if (callNode) {
    const call = calleeName(callNode);
    if (call && isEvidence(call.replace(/^.*::/, ''), true)) {
      let nm = snake(call, /^p[A-Z]|^pfn|^fp[A-Z]/.test(call));
      const w = nm.split('_');
      if (GETTER.test(w[0])) nm = w.slice(1).join('_'); // check_room, not check_get_room
      if (nm && nm.length > 1) return { name: `${verb}_${nm}`, why: `${how} ${call}(..) first` };
    }
  }
  // a null or truth guard on a pointer (`!p`, `p == 0`, `p`) is a guard, not what the block tests for
  const bare = strip(leaf);
  const isNullTest = bare && (bare.kind === NodeKind.Identifier
    || (bare.kind === NodeKind.BinaryExpr && (bare.operator === '==' || bare.operator === '!=') && ((isZero(bare.right) && strip(bare.left)?.kind === NodeKind.Identifier) || (isZero(bare.left) && strip(bare.right)?.kind === NodeKind.Identifier))));
  if (isNullTest && verb === 'check') return null;
  const lv = firstNamed(leaf);
  if (lv) return { name: `${verb}_${snake(lv, true)}`, why: `${how} ${lv} first` };
  return null;
}

/** Describe what a block does first, as a label name, with the evidence. */
function describe(stmts: Any[]): { name: string; why: string } | null {
  const flat = flatTail(stmts).filter(s => !isEpilogue(s));
  for (let i = 0; i < flat.length; i++) {
    const s = flat[i];
    if (s.kind === NodeKind.ExprStmt) {
      const e = strip(s.expression);
      const call = calleeName(e);
      if (call) {
        // a getter whose result only feeds the next statement: the consumer names the block
        if (e.kind === NodeKind.AssignExpr && GETTER.test(verbOf(call)) && i + 1 < flat.length) {
          const v = rootIdent(e.left);
          if (v && usesName(flat[i + 1], v)) continue;
        }
        const nm = callLabel(call, e);
        if (nm) return { name: nm, why: `calls ${call}` };
        continue;
      }
      if (e.kind === NodeKind.AssignExpr) {
        const lv = lvalueName(e.left);
        if (lv) {
          const r = strip(e.right);
          const self = r?.kind === NodeKind.BinaryExpr && (r.operator === '+' || r.operator === '-') && usesName(r.left, rootIdent(e.left) ?? '\0') && strip(e.left).kind === NodeKind.Identifier;
          if (e.operator === '+=' || e.operator === '-=' || self) return { name: `step_${snake(lv, true)}`, why: `steps ${lv}` };
          if (e.operator === '=' && isZero(e.right)) return { name: `clear_${snake(lv, true)}`, why: `clears ${lv}` };
          return { name: `set_${snake(lv, true)}`, why: `sets ${lv}` };
        }
        // a temporary loaded from a field: what it is loaded from (not a copy of a variable,
        // not a computed value or comparison)
        const r = strip(e.right);
        const load = r && (r.kind === NodeKind.MemberExpr || r.kind === NodeKind.SubscriptExpr || (r.kind === NodeKind.UnaryExpr && r.operator === '*'));
        const from = load ? firstNamed(r) : null;
        // a load whose value only feeds the next statement: the consumer names the block
        if (from && i + 1 < flat.length && usesName(flat[i + 1], strip(e.left).name ?? '\0')) continue;
        if (from && strip(e.left).kind === NodeKind.Identifier && e.operator === '=') return { name: `get_${snake(from, true)}`, why: `loads ${from}` };
      }
      if (e.kind === NodeKind.UnaryExpr || e.kind === NodeKind.PostfixExpr) {
        const lv = lvalueName(e.operand);
        if (lv) return { name: `step_${snake(lv, true)}`, why: `steps ${lv}` };
      }
      continue; // a temporary with no evidence: what follows says what the block does
    }
    if (s.kind === NodeKind.IfStmt || s.kind === NodeKind.WhileStmt || s.kind === NodeKind.DoWhileStmt || s.kind === NodeKind.SwitchStmt) {
      const verb = s.kind === NodeKind.SwitchStmt ? 'dispatch' : s.kind === NodeKind.IfStmt ? 'check' : 'scan';
      const how = s.kind === NodeKind.IfStmt ? 'tests' : s.kind === NodeKind.SwitchStmt ? 'switches on' : 'loops on';
      const t = s.condition ? describeTest(s.condition, verb, how) : null;
      if (t) return t;
      // a loop whose test names nothing: what its body does first
      if (s.kind !== NodeKind.IfStmt && s.kind !== NodeKind.SwitchStmt) {
        const inner = describe([s.body]);
        if (inner) return { name: inner.name.startsWith('scan_') ? inner.name : `scan_${inner.name.replace(/^(check|set|get|clear|step)_/, '').replace(/^scan_/, '')}`, why: `loops; its body ${inner.why}` };
      }
      return null;
    }
    if (s.kind === NodeKind.ForStmt) {
      const lv = (s.init ? firstNamed(s.init) : null) ?? (s.condition ? firstNamed(s.condition) : null);
      if (lv) return { name: `scan_${snake(lv, true)}`, why: `loops over ${lv}` };
      return null;
    }
    if (s.kind === NodeKind.ReturnStmt) return null;
    if (s.kind === NodeKind.DeclStmt) continue;
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- the rules

export interface LabelContext {
  label: string;
  /** The statements from the label to the end of its list or the next case. */
  tail: Any[];
  /** Whether falling off the tail continues (false: it returns, breaks, halts). */
  tailFalls: boolean;
  /** The case values of `case v:` labels on the label's statement, or of cases that only jump here. */
  caseValues: string[];
  /** Structural position, when one applies. */
  loopExitOf?: string | null;   // the loop variable whose loop's follow this is, from a nested loop
  loopNextOf?: string | null;   // ... whose continue point this is, from a nested loop
  resumeOf?: string | null;     // ... whose body this is inside, entered from outside
  librarySourceLabel?: string | null;
  noreturn?: ReadonlySet<string>;
  /** The function's body: what it acquired, what it returns elsewhere. */
  fnBody?: Any;
  /** The function's address (library case enumerators are keyed by it). */
  fnAddress?: string;
  /** The block's address (address-keyed library labels). */
  address?: string | null;
  /** Whether the statement before the label falls into it (the normal path reaches it). */
  fallsInto?: boolean;
  /** The tail falls off the end of a void function (an implicit `return;`). */
  endsFunction?: boolean;
  /** The function's locals (not evidence for a name). */
  locals?: ReadonlySet<string>;
  /** Source offset of the label: an acquisition must come before it. */
  labelOffset?: number;
}

/** The stack-cookie check before a return: compiler epilogue, not the block's work. */
const EPILOGUE_CALL = /^(GuardStack|__security_check_cookie|_RTC_CheckEsp|__chkstk|_EH_epilog3|__EH_epilog3)$/;
const isEpilogue = (s: Any) => s.kind === NodeKind.ExprStmt && EPILOGUE_CALL.test((calleeName(s.expression) ?? '').replace(/^.*::/, ''));

/** The straight-line block from the label: no control flow, at most `cap` statements, ending the function. */
export function straightExit(c: LabelContext, cap = 8): { block: Any[]; ret: Any | null } | null {
  const flat = flatTail(c.tail).filter(s => !isEpilogue(s));
  if (!flat.length || flat.length > cap) return null;
  const last = flat[flat.length - 1];
  const body = flat.slice(0, -1);
  if (!body.every(s => s.kind === NodeKind.ExprStmt || s.kind === NodeKind.DeclStmt)) return null;
  if (last.kind === NodeKind.ReturnStmt) return { block: flat, ret: last };
  if (last.kind === NodeKind.ExprStmt) {
    const call = calleeName(last.expression);
    if (!c.tailFalls && call && c.noreturn?.has(call.replace(/^.*::/, ''))) return { block: flat, ret: null }; // a halt
    if (c.endsFunction && c.tailFalls) return { block: flat, ret: null };
  }
  return null;
}

/** A returned variable's value: the last store to it before the return in the same list (`bVar1 = false; return bVar1;`). */
function resolveReturn(ret: Any, list: Any[]): Any {
  const v = strip(ret.value);
  if (!v || (v.kind !== NodeKind.Identifier && v.kind !== NodeKind.UnaryExpr && v.kind !== NodeKind.MemberExpr && v.kind !== NodeKind.SubscriptExpr)) return ret.value;
  const text = (x: Any) => { try { return emit(strip(x) as never).replace(/\s+/g, ''); } catch { return null; } };
  const want = text(v);
  for (let i = list.indexOf(ret) - 1; i >= 0; i--) {
    const e = list[i].kind === NodeKind.ExprStmt ? strip(list[i].expression) : null;
    if (e?.kind === NodeKind.AssignExpr && e.operator === '=' && want !== null && text(e.left) === want) return e.right;
  }
  return ret.value;
}

/** Whether the function returns a non-failure value on some return outside `block`. */
function returnsSomethingElse(fnBody: Any, block: Any[]): boolean {
  const inBlock = new Set(block);
  for (const x of all(fnBody)) {
    if (x.kind !== NodeKind.CompoundStmt) continue;
    const list = flatTail(x.statements);
    for (const r of list) if (r.kind === NodeKind.ReturnStmt && !inBlock.has(r) && r.value && !isFailureValue(resolveReturn(r, list))) return true;
  }
  return false;
}

/** A case value's number (a char's code), or null for an enumerator. */
export function caseNumber(v: string): bigint | null {
  const t = v.replace(/^\((?:unsigned\s+)?\w+\)\s*/, '').trim();
  const ch = /^'(.)'$/.exec(t);
  if (ch) return BigInt(ch[1].charCodeAt(0));
  if (/^-?(0x[0-9a-f]+|\d+)[uUlL]*$/i.test(t)) { const n = BigInt(t.replace(/^-/, '').replace(/[uUlL]+$/, '')); return t.startsWith('-') ? -n : n; }
  return null;
}

/** A case value as a label word. */
export function caseWord(v: string, fnAddress?: string): { word: string; library?: string } {
  const lib = fnAddress ? LIBRARY_CASE_ENUMS[fnAddress] : undefined;
  const t = v.replace(/^\((?:unsigned\s+)?\w+\)\s*/, '').trim();
  const ch = /^'(.*)'$/.exec(t);
  let n: bigint | null = null;
  if (ch) {
    const body = ch[1];
    const esc: Record<string, number> = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11 };
    const code = body.length === 1 ? body.charCodeAt(0) : body.startsWith('\\x') ? parseInt(body.slice(2), 16) : body.startsWith('\\') && esc[body.slice(1)] !== undefined ? esc[body.slice(1)] : NaN;
    if (Number.isNaN(code)) return { word: '' };
    if (/^[A-Za-z0-9]$/.test(body)) return { word: body };
    n = BigInt(code);
  } else if (/^-?(0x[0-9a-f]+|\d+)[uUlL]*$/i.test(t)) {
    const neg = t.startsWith('-');
    n = BigInt(t.replace(/^-/, '').replace(/[uUlL]+$/, ''));
    if (neg) n = -n;
  }
  if (n !== null) {
    if (lib && n >= 0n && n < BigInt(lib.enumerators.length)) return { word: lib.enumerators[Number(n)], library: lib.source };
    if (n < 0n) n = (1n << 32n) + n;
    if (n >= 0x80000000n) return { word: `0x${n.toString(16)}` };
    if (ch) return { word: `0x${n.toString(16)}` };
    return { word: t.replace(/[uUlL]+$/, '').toLowerCase() };
  }
  // an enumerator: its own name
  const id = t.replace(/^.*::/, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+$/, '').replace(/^_+/, '');
  return { word: id };
}

export function proposeName(c: LabelContext): LabelProposal {
  currentLocals = c.locals ?? new Set();
  try { return proposeNameIn(c); } finally { currentLocals = new Set(); }
}

function proposeNameIn(c: LabelContext): LabelProposal {
  const { label } = c;
  if (c.librarySourceLabel) return { label, name: c.librarySourceLabel, kind: 'library', evidence: `library source label ${c.librarySourceLabel}` };
  const libAddr = c.address ? LIBRARY_ADDRESS_LABELS[c.address] : undefined;
  if (libAddr && (!c.fnAddress || libAddr.fn === c.fnAddress)) return { label, name: libAddr.name, kind: 'library', evidence: libAddr.evidence };
  if (!isGhidraLabel(label)) return { label, name: label, kind: 'user', evidence: 'existing user label, kept' };
  if (c.caseValues.length) {
    // several values reach one body: the lowest names it (Ghidra's own caseD_ convention)
    // Ghidra's own caseD_<v> names the body by one of its values; else the lowest; an
    // enumerator list by its first
    const nums = c.caseValues.map(x => ({ x, n: caseNumber(x) }));
    const gv = /caseD_([0-9a-f]+)$/i.exec(label);
    const byGhidra = gv ? nums.find(y => y.n !== null && BigInt.asUintN(32, y.n) === BigInt('0x' + gv[1])) : undefined;
    const v = c.caseValues.includes('default') ? 'default' : byGhidra ? byGhidra.x : nums.every(y => y.n !== null) ? nums.reduce((m, y) => (y.n! < m.n! ? y : m)).x : c.caseValues[0];
    if (v === 'default') return { label, name: 'default_case', kind: 'structural', evidence: `the default case body, entered from outside it` };
    const w = caseWord(v, c.fnAddress);
    if (!w.word) return { label, name: label, kind: 'residual', evidence: `case ${v}: the value does not spell as an identifier` };
    if (w.library) return { label, name: `case_${w.word}`, kind: 'library', evidence: `case ${c.caseValues.join(', ')} = ${w.word} in ${w.library}, entered from outside it` };
    return { label, name: `case_${w.word}`, kind: 'structural', evidence: `the body of case ${c.caseValues.join(', ')}, entered from outside it` };
  }

  const exit = straightExit(c);
  // Loop positions, unless the block is an exit Ghidra laid inside the loop.
  if (!exit) {
    if (c.loopExitOf) return { label, name: `end_${snake(c.loopExitOf, true)}_loop`, kind: 'structural', evidence: `follow of the ${c.loopExitOf} loop, jumped to from a nested loop` };
    if (c.loopNextOf) return { label, name: `next_${snake(c.loopNextOf, true)}`, kind: 'structural', evidence: `continue point of the ${c.loopNextOf} loop, jumped to from a nested loop` };
    // resume_<x> is not proposed: where Ghidra lays a block inside a loop says nothing about
    // the source's loop (the step-11 re-read found most such blocks were exits or the next loop)
  }

  if (exit) {
    const released = releases(exit.block, c.fnBody, c.labelOffset ?? Infinity);
    const v = exit.ret ? resolveReturn(exit.ret, exit.block) : null;
    if (released.length) {
      const failure = !!v && isFailureValue(v);
      if (failure && c.fnBody && returnsSomethingElse(c.fnBody, exit.block))
        return { label, name: 'error', kind: 'semantic', evidence: `releases (${released.join(', ')}) and returns a failure value; the other paths return something else` };
      // cleanup is the one exit both outcomes share: if another exit makes the same release
      // first, this block is one outcome's exit, and without a failure value nothing says which
      if (!c.fnBody || !otherExitReleases(c.fnBody, exit.block, released))
        return { label, name: 'cleanup', kind: 'semantic', evidence: `releases (${released.join(', ')}) and ${exit.ret ? 'returns' : 'ends the function'}; no other exit releases it` };
    }
    const stores = exit.block.slice(0, -1);
    const rv = v ? strip(v) : null;
    // done: write-back and return - at least one store, and not a failure or error-code return
    const failing = !!rv && (isFailureValue(rv) || (rv.kind === NodeKind.Identifier && /(BAD|ERR|FAIL|INVALID|DENIED|REJECT)/i.test(rv.name)) || (rv.kind === NodeKind.QualifiedId && /(BAD|ERR|FAIL|INVALID)/i.test(JSON.stringify(rv))));
    // ... and it returns the computed result (a constant 1/TRUE could as well mean "blocked" as
    // "done"), or in a void function it is the only exit
    const returnsResult = rv ? !(rv.kind === NodeKind.IntegerLiteral || rv.kind === NodeKind.BoolLiteral || rv.kind === NodeKind.NullptrLiteral || (rv.kind === NodeKind.Identifier && /^[A-Z][A-Z0-9_]*$/.test(rv.name)))
      : !!c.fnBody && ![...all(c.fnBody)].some(x => x.kind === NodeKind.ReturnStmt && !exit.block.includes(x));
    // write-back: each store puts a value already computed (a variable, a constant, a load) into
    // an out-parameter or a field - a store of fresh arithmetic is the function's work, not its done
    const plain = (x: Any): boolean => { x = strip(x); return !!x && (x.kind === NodeKind.Identifier || x.kind === NodeKind.IntegerLiteral || x.kind === NodeKind.BoolLiteral || x.kind === NodeKind.NullptrLiteral || x.kind === NodeKind.MemberExpr || x.kind === NodeKind.SubscriptExpr || (x.kind === NodeKind.UnaryExpr && (x.operator === '*' || x.operator === '&' || x.operator === '-') && plain(x.operand))); };
    const writeBack = stores.every(st => { const e = st.kind === NodeKind.ExprStmt ? strip(st.expression) : null; return !!e && e.kind === NodeKind.AssignExpr && e.operator === '=' && plain(e.right) && strip(e.left).kind !== NodeKind.Identifier; });
    const onlyStores = exit.ret && returnsResult && writeBack && stores.length > 0 && !failing && stores.every(s => s.kind === NodeKind.ExprStmt && strip(s.expression).kind === NodeKind.AssignExpr && !calleeName(s.expression) && ![...all(s.expression)].some(x => x.kind === NodeKind.CallExpr));
    if (onlyStores) return { label, name: 'done', kind: 'semantic', evidence: exit.block.length > 1 ? 'stores the results and returns' : 'returns' };
  }
  const d = describe(c.tail);
  if (d && d.name && !KEYWORDS.has(d.name) && /^[a-z][a-z0-9_]*$/.test(d.name) && !/__/.test(d.name)) return { label, name: d.name, kind: 'descriptive', evidence: `the block ${d.why}` };
  return { label, name: label, kind: 'residual', evidence: 'nothing in the block names it' };
}

/** The first named thing in the block that the name does not already say. */
function otherWord(tail: Any[], base: string): string | null {
  const have = new Set(base.split('_'));
  for (const st of flatTail(tail)) {
    for (const x of all(st)) {
      const n = x.kind === NodeKind.MemberExpr ? memberName(x) : x.kind === NodeKind.Identifier ? named(x.name) : null;
      if (!n) continue;
      const w = snake(n, true);
      if (w && w.length > 1 && !/^\d/.test(w) && !w.split('_').every(t => have.has(t))) return w;
    }
  }
  return null;
}

/**
 * Make the names of one function unique: a descriptive name takes another word of its block;
 * otherwise (and for the section-6 vocabulary) the suffix `2`, `3`, ...
 */
export function uniquify(props: { p: LabelProposal; tail: Any[] }[], locals: ReadonlySet<string> = new Set()): void {
  currentLocals = locals;
  try { uniquifyIn(props); } finally { currentLocals = new Set(); }
}
function uniquifyIn(props: { p: LabelProposal; tail: Any[] }[]): void {
  const taken = new Set<string>(props.filter(x => x.p.kind === 'user' || x.p.kind === 'residual').map(x => x.p.name));
  for (const x of props) {
    if (x.p.kind === 'residual' || x.p.kind === 'user') continue;
    const base = x.p.name;
    let name = base;
    if (taken.has(name)) {
      const word = x.p.kind === 'descriptive' ? otherWord(x.tail, base) : null;
      if (word && !taken.has(`${base}_${word}`)) name = `${base}_${word}`;
      else { const sep = /\d$/.test(base) ? '_' : ''; let n = 2; while (taken.has(`${base}${sep}${n}`)) n++; name = `${base}${sep}${n}`; }
      x.p.evidence += `; '${base}' already names another label here`;
    }
    taken.add(name);
    x.p.name = name;
  }
}
