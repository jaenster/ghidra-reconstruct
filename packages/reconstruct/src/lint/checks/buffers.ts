/**
 * Checks about STACK objects written or read past their declared extent - the frame-layout
 * species, where Ghidra split one object into several locals or sized a buffer to the next
 * phantom slot.
 */

import { NodeKind } from '@ghidra-mcp/cpp-parser';
import {
  arrayLength, calleeName, elementType, innermostElement, isArrayType, line, localStructs,
  memberOffsets, primitiveName, refName, signature, strip, typeRefName, typeText, typeWidth,
  unparen, walk,
} from '../ast.js';
import type { Check, Finding, LintContext, Resolved } from '../context.js';
import type { FunctionInfo } from '../tree.js';
import { rootName } from '../locals.js';

const CHARLIKE = new Set(['char', 'uint8_t', 'byte', 'CHAR', 'int8_t', 'undefined1', 'BYTE',
  'unsigned char', 'signed char', 'UCHAR']);

function isLocal(r: Resolved | null): r is Extract<Resolved, { kind: 'local' | 'param' }> {
  return !!r && r.kind === 'local' && !r.entry.isStatic;
}

/** The array object an argument denotes: `buf`, `&buf[0]`, `(T *)buf`, `&buf`. */
function arrayArg(ctx: LintContext, fn: FunctionInfo, arg: any): { name: string; r: Resolved } | null {
  let s = strip(arg);
  if (s?.kind === NodeKind.UnaryExpr && s.operator === '&') {
    const op = unparen(s.operand);
    if (op?.kind === NodeKind.SubscriptExpr && ctx.value(fn, op.index) === 0) s = unparen(op.array);
    else s = strip(op);
  }
  const name = refName(s);
  if (!name) return null;
  const r = ctx.resolve(fn, s);
  if (!r || !isArrayType(r.type)) return null;
  return { name, r };
}

// -------------------------------------------------------------------------------------------
// undersized-stack-buffer
// -------------------------------------------------------------------------------------------

/**
 * Minimum rendered length of a printf format, NUL included, given the argument nodes.
 *
 * A floor, never an estimate: a conversion contributes its field width, `%s` contributes the
 * literal it is handed (up to a precision) or nothing when that is not a literal. The regex
 * scored `%02d` as four characters by reading it as text; this parses the specification.
 */
export function renderedLength(fmt: string, args: any[]): { need: number; sample: string } {
  let n = 0;
  let sample = '';
  let ai = 0;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch !== '%') { n++; sample += ch; continue; }
    const m = /^%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d+))?(hh|h|ll|l|L|I64|I32|I|w|z|j|t)?([diouxXcsSpeEfgGaAn%])/.exec(fmt.slice(i));
    if (!m) { n++; sample += ch; continue; }
    i += m[0].length - 1;
    const [, , widthS, precS, , conv] = m;
    if (conv === '%') { n++; sample += '%'; continue; }
    let width = 0;
    if (widthS === '*') { ai++; } else if (widthS) width = parseInt(widthS, 10);
    let prec: number | null = null;
    if (precS === '*') { ai++; } else if (precS !== undefined) prec = parseInt(precS, 10);
    const arg = args[ai++];
    let len = 0;
    if (conv === 's' || conv === 'S') {
      const lit = strip(arg);
      if (lit?.kind === NodeKind.StringLiteral) {
        len = String(lit.value).length;
        if (prec !== null) len = Math.min(len, prec);
        sample += String(lit.value).slice(0, len);
      } else {
        sample += '?';
      }
    } else if (conv === 'n') {
      len = 0;
    } else {
      len = 1;
      sample += '1';
    }
    n += Math.max(len, width);
  }
  return { need: n + 1, sample };
}

const FORMAT_CALLS: Record<string, { fmt: number; literal?: boolean }> = {
  sprintf: { fmt: 1 }, wsprintfA: { fmt: 1 }, wsprintf: { fmt: 1 },
  strcpy: { fmt: 1, literal: true }, lstrcpyA: { fmt: 1, literal: true }, lstrcpy: { fmt: 1, literal: true },
};

/**
 * A stack buffer written past its declared size.
 *
 * Two shapes. A formatted or string write whose minimum output exceeds the buffer - a
 * phantom local inside a real buffer makes Ghidra declare only the fragment up to it, as in
 * D2WINPAL_LoadActPalette where ".dat" landed on nActIndex and came back out as a number.
 * And a clear-loop that advances MORE than one element per iteration, where the extent is
 * iterations x stride, not iterations - the shape that crashed the main menu while the
 * one-element model reported nothing.
 *
 * The regex took buffer sizes FILE-wide, so a `wszTempBuffer[10]` in one function redefined
 * the `[256]` of another; here a buffer is the declaration the name resolves to in the
 * function that uses it. It also searched a six-line window for the stride; here the stride
 * is a `+=` inside the loop and the cursor's origin is its last assignment before the loop.
 */
export const undersizedStackBuffer: Check = {
  id: 'undersized-stack-buffer',
  blurb: 'stack buffer written past its declared size',
  run(ctx) {
    const out: Finding[] = [];
    for (const fn of ctx.tree.functions) {
      for (const c of ctx.of(fn, NodeKind.CallExpr)) {
        const name = calleeName(c.callee);
        const spec = name ? FORMAT_CALLS[name] : undefined;
        if (!spec || c.arguments.length <= spec.fmt) continue;
        const a = arrayArg(ctx, fn, c.arguments[0]);
        if (!a) continue;
        const el = primitiveName(elementType(a.r.type));
        if (!el || !CHARLIKE.has(el)) continue;
        const cap = arrayLength(a.r.type);
        if (cap === null) continue;
        const lit = strip(c.arguments[spec.fmt]);
        if (lit?.kind !== NodeKind.StringLiteral) continue;
        const { need, sample } = spec.literal
          ? { need: String(lit.value).length + 1, sample: String(lit.value) }
          : renderedLength(String(lit.value), c.arguments.slice(spec.fmt + 1));
        if (need > cap) {
          out.push({
            check: this.id, file: fn.file.path, line: line(c), fn: fn.qualifiedName, subject: a.name,
            detail: `${need} bytes into ${a.name}[${cap}] (${fn.file.path}:${line(c)}) -> ${JSON.stringify(sample.slice(0, 60))}`,
            sig: signature(c),
          });
        }
      }
      out.push(...stridingClearLoops(ctx, fn));
    }
    return out;
  },
};

/** The statement list a statement sits in, and its index there. */
function enclosingList(parents: Map<any, any>, stmt: any): { list: any[]; index: number } | null {
  const p = parents.get(stmt);
  if (p?.kind === NodeKind.CompoundStmt) return { list: p.statements, index: p.statements.indexOf(stmt) };
  return null;
}

function stridingClearLoops(ctx: LintContext, fn: FunctionInfo): Finding[] {
  const out: Finding[] = [];
  const fors = ctx.of(fn, NodeKind.ForStmt);
  if (!fors.length) return out;
  const parents = new Map<any, any>();
  walk((fn.node as any).body, (n, p) => { parents.set(n, p); });
  for (const loop of fors) {
    // Iteration count: `for (n = C; ...)` or `for (T n = C; ...)`.
    let iters: number | null = null;
    const init = loop.init;
    if (init?.kind === NodeKind.ExprStmt && init.expression?.kind === NodeKind.AssignExpr &&
        init.expression.operator === '=') {
      iters = ctx.value(fn, init.expression.right);
    } else if (init?.kind === NodeKind.DeclStmt) {
      const d = init.declarations?.[0];
      if (d?.initializer) iters = ctx.value(fn, d.initializer);
    }
    if (iters === null || iters <= 0) continue;
    // Stride: `cursor += K`, K >= 2, in the body or the increment - for a cursor the loop
    // STORES through (`*cursor = ...`, `cursor[i] = ...`); a read cursor walking the source
    // of a copy is not what overflows.
    const strides = new Map<string, number>();
    const storedThrough = new Set<string>();
    const scan = (root: any) => walk(root, (n: any) => {
      if (n.kind !== NodeKind.AssignExpr) return;
      const lhs = unparen(n.left);
      if (n.operator === '+=' && refName(lhs)) {
        const k = ctx.value(fn, n.right);
        if (k !== null && k >= 2 && !strides.has(refName(lhs)!)) strides.set(refName(lhs)!, k);
      }
      const target = lhs?.kind === NodeKind.UnaryExpr && lhs.operator === '*' ? lhs.operand
        : lhs?.kind === NodeKind.SubscriptExpr ? lhs.array : null;
      const root = target ? rootName(target) : null;
      if (root) storedThrough.add(root);
    });
    scan(loop.body);
    if (loop.increment) scan(loop.increment);
    const cursor = [...strides.keys()].find(c => storedThrough.has(c)) ?? null;
    if (!cursor) continue;
    const step = strides.get(cursor)!;
    // Origin: the last assignment to the cursor before the loop in the same block.
    const where = enclosingList(parents, loop);
    if (!where) continue;
    let origin: any = null;
    for (let i = where.index - 1; i >= 0 && !origin; i--) {
      const st = where.list[i];
      walk(st, (n: any) => {
        if (n.kind === NodeKind.AssignExpr && n.operator === '=' && refName(unparen(n.left)) === cursor) origin = n.right;
        else if (n.kind === NodeKind.VariableDecl && refName(n.name) === cursor && n.initializer) origin = n.initializer;
      });
    }
    if (!origin) continue;
    const a = arrayArg(ctx, fn, origin);
    if (!a) continue;
    const len = arrayLength(a.r.type);
    if (len === null) continue;
    const cursorType = fn.scope().get(cursor)?.type;
    const cw = cursorType ? typeWidth(elementType(cursorType), ctx.sizeEnv) : null;
    const bw = typeWidth(elementType(a.r.type), ctx.sizeEnv);
    const extentElems = iters * step;
    const over = cw !== null && bw !== null
      ? extentElems * cw > len * bw
      : extentElems > len;
    if (over) {
      out.push({
        check: 'undersized-stack-buffer', file: fn.file.path, line: line(loop), fn: fn.qualifiedName, subject: a.name,
        detail: `clear-loop writes ${extentElems} elements into ${a.name}[${len}] (stride ${step})`,
        sig: signature(loop),
      });
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// oversized-frame-write
// -------------------------------------------------------------------------------------------

/** name -> [destination arg, count arg, extra multiplier arg or null] */
export const SIZED_SINKS: Record<string, [number, number, number | null]> = {
  memset: [0, 2, null], memcpy: [0, 2, null], memmove: [0, 2, null],
  ZeroMemory: [0, 1, null], RtlZeroMemory: [0, 1, null],
  FillMemory: [0, 1, null], RtlFillMemory: [0, 1, null],
  CopyMemory: [0, 2, null], RtlCopyMemory: [0, 2, null],
  MoveMemory: [0, 2, null], RtlMoveMemory: [0, 2, null],
  strncpy: [0, 2, null], strncat: [0, 2, null], wcsncpy: [0, 2, null], wcsncat: [0, 2, null],
  builtin_strncpy: [0, 2, null], builtin_memcpy: [0, 2, null],
  SStrCopy: [0, 2, null], SStrNCat: [0, 2, null],
  ReadFile: [1, 2, null], thunk_ReadFile: [1, 2, null],
  snprintf: [0, 1, null], _snprintf: [0, 1, null], swprintf: [0, 1, null], _snwprintf: [0, 1, null],
  fread: [0, 2, 1],
};

/** `SStrCopy(dst, src, 0x7fffffff)` is the "no limit" sentinel, not a size. */
const NO_LIMIT = 0x7fffffff;

interface FrameGroup { struct: any; size: number; offsets: Map<string, number | null>; arrays: Set<string> }

/** Local struct types carrying `static_assert(... sizeof(T) == N ...)`, i.e. frame groups. */
function frameGroups(ctx: LintContext, fn: FunctionInfo): Map<string, FrameGroup> {
  const structs = localStructs(fn.node);
  const out = new Map<string, FrameGroup>();
  if (!structs.size) return out;
  for (const sa of ctx.of(fn, NodeKind.StaticAssertDecl)) {
    walk(sa.condition, (n: any) => {
      if (n.kind !== NodeKind.BinaryExpr || n.operator !== '==') return;
      const so = strip(n.left);
      if (so?.kind !== NodeKind.SizeofExpr) return;
      const tn = so.isType ? typeRefName(so.operand) : refName(so.operand);
      const s = tn ? structs.get(tn) : null;
      const size = ctx.value(fn, n.right);
      if (!s || size === null) return;
      const arrays = new Set<string>();
      for (const m of s.members ?? []) {
        if (m.kind === NodeKind.VariableDecl && isArrayType(m.type)) arrays.add(m.name?.name);
      }
      out.set(tn!, { struct: s, size, offsets: memberOffsets(s, ctx.sizeEnv), arrays });
    });
  }
  return out;
}

/**
 * A call that writes more bytes than the frame group it targets holds.
 *
 * `LAUNCHER_LoadCharacterAppearanceFromD2s` proved it: one 8 KB save image that Ghidra
 * modelled as thirteen frame positions, grouped only partly, so `fread(&local, 1, 0x2000)`
 * wrote 8108 bytes past the frame - saved EBP, return address, the caller's frame.
 *
 * The group's `static_assert(sizeof(__frameN_t) == N)` is its real size, so the test is
 * exact. Where the member's offset inside the group is known (a packed struct of sized
 * fields), the write is measured from THAT offset - a write that starts mid-group and runs
 * off the end is the same defect, and the regex compared the count to the whole group.
 * A pointer member passed by value writes to the heap and is not this defect: the argument
 * must be `&g.m`, `&g`, or an ARRAY member decaying.
 */
export const oversizedFrameWrite: Check = {
  id: 'oversized-frame-write',
  blurb: 'call writes more bytes than the destination frame group holds - smashes the frame',
  run(ctx) {
    const out: Finding[] = [];
    for (const fn of ctx.tree.functions) {
      const calls = ctx.of(fn, NodeKind.CallExpr);
      if (!calls.length) continue;
      const groups = frameGroups(ctx, fn);
      if (!groups.size) continue;
      const scope = fn.scope();
      for (const c of calls) {
        const name = calleeName(c.callee);
        const spec = name ? SIZED_SINKS[name] : undefined;
        if (!spec) continue;
        const [di, si, xi] = spec;
        if (c.arguments.length <= Math.max(di, si, xi ?? 0)) continue;
        let n = ctx.value(fn, c.arguments[si]);
        if (n === null || n <= 0 || n === NO_LIMIT) continue;
        if (xi !== null) {
          const x = ctx.value(fn, c.arguments[xi]);
          if (x === null) continue;
          n *= x;
        }
        let d = strip(c.arguments[di]);
        const amp = d?.kind === NodeKind.UnaryExpr && d.operator === '&';
        if (amp) d = strip(d.operand);
        let groupVar: string | null = null;
        let member: string | null = null;
        if (d?.kind === NodeKind.MemberExpr && !d.isArrow && refName(unparen(d.object))) {
          groupVar = refName(unparen(d.object));
          member = d.member?.name ?? null;
        } else if (amp && refName(d)) {
          groupVar = refName(d);
        }
        if (!groupVar) continue;
        const e = scope.get(groupVar);
        const tn = e ? typeRefName(e.type) : null;
        const g = tn ? groups.get(tn) : null;
        if (!g) continue;
        if (member && !amp && !g.arrays.has(member)) continue;   // pointer member: bytes go elsewhere
        const off = member ? g.offsets.get(member) ?? null : 0;
        const end = (off ?? 0) + n;
        if (end > g.size) {
          const at = member ? `&${groupVar}.${member}` : `&${groupVar}`;
          out.push({
            check: this.id, file: fn.file.path, line: line(c), fn: fn.qualifiedName, subject: `${groupVar}${member ? '.' + member : ''}`,
            detail: `${name} writes 0x${n.toString(16)} into ${g.size}-byte ${tn} (${at}${off ? ` at +${off}` : ''})`,
            sig: signature(c),
          });
        }
      }
    }
    return out;
  },
};

// -------------------------------------------------------------------------------------------
// oversized-formatted-write
// -------------------------------------------------------------------------------------------

/**
 * name -> index of the size argument. wsprintfA takes no size and is measured by
 * undersized-stack-buffer. The _s forms take the destination size second.
 */
const SIZED_FORMAT_SINKS: Record<string, number> = {
  SStrPrintf: 1, _snprintf: 1, snprintf: 1, SStrCopy: 2, SStrPack: 2,
  vsnprintf: 1, _vsnprintf: 1, __vsnprintf: 1, _snprintf_s: 1, __snprintf_s: 1, _vsnprintf_s: 1,
  _strncpy_s: 1, strncpy_s: 1,
};

const FORMAT_DEST_ELEMS = new Set(['char', 'byte', 'uint8_t', 'int8_t', 'uint16_t', 'wchar_t', 'undefined1',
  'BYTE', 'CHAR', 'unsigned char', 'WCHAR']);

/**
 * A formatted or copying write whose SIZE argument exceeds its destination's declared size.
 *
 * `FindRoom` declared `char szErrorMsg[4]` and called `SStrPrintf(szErrorMsg, 0x200, ...)`:
 * the frame proves a 0x200 buffer, the four bytes were a lifting artifact. It detonates far
 * away - the Fog halt does not terminate here, the smashed frame is returned through, and
 * the fault EIP was ASCII from the function's own message.
 *
 * The regex assumed the size is always the SECOND argument, so its SStrCopy and SStrPack
 * entries (size third) could never match; the size position is per function here. The
 * destination is whatever the name resolves to - a local, a file-scope or a global array.
 */
export const oversizedFormattedWrite: Check = {
  id: 'oversized-formatted-write',
  blurb: 'printf-family write larger than its destination - smashes the frame on the error path',
  run(ctx) {
    const out: Finding[] = [];
    for (const fn of ctx.tree.functions) {
      for (const c of ctx.of(fn, NodeKind.CallExpr)) {
        const name = calleeName(c.callee);
        const si = name ? SIZED_FORMAT_SINKS[name] : undefined;
        if (si === undefined || c.arguments.length <= si) continue;
        const a = arrayArg(ctx, fn, c.arguments[0]);
        if (!a) continue;
        const el = primitiveName(innermostElement(a.r.type));
        if (!el || !FORMAT_DEST_ELEMS.has(el)) continue;
        const cap = typeWidth(a.r.type, ctx.sizeEnv);
        const n = ctx.value(fn, c.arguments[si]);
        if (cap === null || n === null || n === NO_LIMIT) continue;
        if (n > cap) {
          out.push({
            check: this.id, file: fn.file.path, line: line(c), fn: fn.qualifiedName, subject: a.name,
            detail: `${name} writes ${n} bytes into ${a.name}[${arrayLength(a.r.type)}] (${cap} bytes, ${a.r.kind})`,
            sig: signature(c),
          });
        }
      }
    }
    return out;
  },
};

// -------------------------------------------------------------------------------------------
// oob-local-access
// -------------------------------------------------------------------------------------------

const MEM_SPANS: Record<string, { args: number[]; count: number }> = {
  memset: { args: [0], count: 2 },
  memcpy: { args: [0, 1], count: 2 },
  memmove: { args: [0, 1], count: 2 },
  builtin_memcpy: { args: [0, 1], count: 2 },
  builtin_strncpy: { args: [0], count: 2 },
  strncpy: { args: [0], count: 2 },
};

/**
 * An emitted LOCAL indexed, copied or cleared past its own declaration.
 *
 * A run of stack slots the machine treats as ONE object becomes several C++ locals when the
 * frame-group pass misses it; the tell is an access that leaves the declared object. The A*
 * init node in DRLGOUTROOM_FindPathBetweenExits was ten dwords copied OUT of an int[4] and
 * hung Act 1 forever - a read, which the regex never looked at: it checked only the first
 * argument of memset/memcpy. Here the SOURCE of a copy counts too.
 *
 * Indexing checks every dimension: `a[i][k]` is measured against the inner length. `&a[N]`
 * (one past the end) is a legal address and is not reported; `a[N]` is. Member arrays of a
 * frame group are deliberately excluded - reaching past a member inside a group is how the
 * group is used.
 */
export const oobLocalAccess: Check = {
  id: 'oob-local-access',
  blurb: 'local indexed or mem*-written past its own declaration - a split frame group',
  run(ctx) {
    const out: Finding[] = [];
    for (const fn of ctx.tree.functions) {
      const scope = fn.scope();
      const locals = [...scope.values()].filter(e => e.kind === 'local' && !e.isStatic && isArrayType(e.type));
      if (!locals.length) continue;
      const parents = new Map<any, any>();
      const subs = ctx.of(fn, NodeKind.SubscriptExpr);
      if (subs.length) walk((fn.node as any).body, (n, p) => { parents.set(n, p); });
      for (const s of subs) {
        // Only the OUTERMOST subscript of a chain is examined; it walks inward itself.
        const p = parents.get(s);
        if (p?.kind === NodeKind.SubscriptExpr && p.array === s) continue;
        let cur: any = s;
        const indices: any[] = [];
        while (cur?.kind === NodeKind.SubscriptExpr) { indices.unshift(cur.index); cur = unparen(cur.array); }
        const base = refName(cur);
        if (!base) continue;
        const r = ctx.resolve(fn, cur);
        if (!isLocal(r) || !isArrayType(r.type)) continue;
        let t = r.type;
        let up = parents.get(s);
        while (up?.kind === NodeKind.ParenExpr) up = parents.get(up);
        const addressOnly = up?.kind === NodeKind.UnaryExpr && up.operator === '&';
        for (let i = 0; i < indices.length && isArrayType(t); i++) {
          const len = arrayLength(t);
          const k = ctx.value(fn, indices[i]);
          const last = i === indices.length - 1;
          if (len !== null && k !== null && (k > len || (k === len && !(last && addressOnly)) || k < 0)) {
            out.push({
              check: this.id, file: fn.file.path, line: line(s), fn: fn.qualifiedName, subject: base,
              detail: `${base}${i ? `[..]`.repeat(i) : ''}[${k}] but declared [${len}]`,
              sig: signature(s),
            });
            break;
          }
          t = elementType(t);
        }
      }
      for (const c of ctx.of(fn, NodeKind.CallExpr)) {
        const name = calleeName(c.callee);
        const spec = name ? MEM_SPANS[name] : undefined;
        if (!spec || c.arguments.length <= spec.count) continue;
        const n = ctx.value(fn, c.arguments[spec.count]);
        if (n === null) continue;
        for (const ai of spec.args) {
          const a = arrayArg(ctx, fn, c.arguments[ai]);
          if (!a || !isLocal(a.r)) continue;
          const bytes = typeWidth(a.r.type, ctx.sizeEnv);
          if (bytes === null || n <= bytes) continue;
          const role = ai === 0 ? 'into' : 'out of';
          out.push({
            check: this.id, file: fn.file.path, line: line(c), fn: fn.qualifiedName, subject: a.name,
            detail: `${name} of ${n} bytes ${role} ${a.name} (${typeText(a.r.type)} = ${bytes} bytes)`,
            sig: signature(c) + `#arg${ai}`,
          });
        }
      }
    }
    return out;
  },
};
