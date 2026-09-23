/**
 * Checks about LOCALS that never receive a value - the decompiler dropped the store, the
 * register, or the callee's return, and the emitted code reads stack garbage.
 */

import { NodeKind } from '@ghidra-mcp/cpp-parser';
import {
  calleeName, innermostElement, isArrayType, line, primitiveName, strip, typeText, unparen,
} from '../ast.js';
import type { Check, Finding } from '../context.js';
import { localFacts, rootName, storedObject, SYNTHETIC_NAME } from '../locals.js';

/**
 * A local that is declared, never assigned, and then READ.
 *
 * The shape a lost return value leaves: `SRP_ConstructContext` returns `this` in EAX but was
 * typed void, so its caller stored an uninitialised slot into g_pSrpContext, and whether that
 * killed the process depended only on what the slot held - the same source behaved
 * differently at two revisions. The fix is in Ghidra (the callee's real return type), never
 * a hand-initialisation in the tree.
 *
 * What the regex could not see: a declaration not indented by exactly four spaces or named
 * with a capital; `x.f = v` and `*(T *)(x + 4) = v` as writes; an array filled through
 * decay (`sprintf(buf, ...)`, `p = buf; *p = 0`); `sizeof(x)` as not-a-read; a member named
 * like a local (`p->nCount`) as not-a-read. Static locals are zero-initialised and excluded.
 * Ghidra's own register names (extraout_/in_/unaff_) are the register-contract class,
 * enumerated separately.
 */
export const unassignedLocalRead: Check = {
  id: 'unassigned-local-read',
  blurb: 'local read but never assigned - the callee lost a return value Ghidra typed void',
  run(ctx) {
    const out: Finding[] = [];
    for (const fn of ctx.tree.functions) {
      const scope = fn.scope();
      let facts: ReturnType<typeof localFacts> | null = null;
      for (const e of scope.values()) {
        if (e.kind !== 'local' || e.isStatic) continue;
        if (SYNTHETIC_NAME.test(e.name)) continue;
        if (e.decl.initializer) continue;
        facts ??= localFacts(fn);
        if (facts.writes.has(e.name) || facts.escaped.has(e.name) || !facts.reads.has(e.name)) continue;
        out.push({
          check: this.id, file: fn.file.path, line: line(e.decl), fn: fn.qualifiedName, subject: e.name,
          detail: `${typeText(e.type)} read but never assigned (line ${line(e.decl)})`,
        });
      }
    }
    return out;
  },
};

/** Calls that READ through a pointer argument, and which argument positions are the source. */
function sourceArgs(name: string, argc: number): number[] | null {
  if (name === 'memcpy' || name === 'memmove') return [1];
  if (name === 'SStrCopy' || name === 'SStrPack') return [1];
  if (/Send/.test(name)) return Array.from({ length: argc }, (_, i) => i);
  return null;
}

const SEND_SCALARS = new Set(['char', 'byte', 'uint8_t', 'int8_t', 'undefined1', 'uint16_t', 'int16_t',
  'uint32_t', 'int32_t', 'uint', 'int', 'unsigned int', 'unsigned char', 'unsigned short', 'short',
  'BYTE', 'WORD', 'DWORD', 'wchar_t']);

/**
 * A stack buffer whose address is handed to a SEND, and which nothing ever fills.
 *
 * unassigned-local-read treats `&x` as giving x a value - the common shape is an
 * out-parameter. That inverts for a send: the buffer is the SOURCE. In
 * NET_D2GS_SERVER_SendStateCommand the one-byte packet lived in a PUSH spill slot, the
 * decompiler eliminated the byte store, and the server sent garbage as the join-state
 * opcode; three subsystems later the first stat packet faulted on a null player.
 *
 * A candidate is a primitive-typed local (or an array of one) that reaches a source position
 * of a sink - any argument of a `*Send*` call, the source of memcpy/SStrCopy/SStrPack - as
 * `&x`, `&x[0]` or a decaying array name. It is filled by any write through it, or by
 * reaching ANY other call by address, where the callee may fill it; the regex counted only
 * a mem* destination as a fill.
 */
export const uninitialisedSendBuffer: Check = {
  id: 'uninitialised-send-buffer',
  blurb: 'stack buffer handed to a send that nothing fills - uninitialised bytes on the wire',
  run(ctx) {
    const out: Finding[] = [];
    for (const fn of ctx.tree.functions) {
      const calls = ctx.of(fn, NodeKind.CallExpr);
      if (!calls.length) continue;
      const scope = fn.scope();
      const sunk = new Map<string, any>();
      const filledByCall = new Set<string>();
      for (const c of calls) {
        const name = calleeName(c.callee) ?? '';
        const src = sourceArgs(name, c.arguments.length);
        c.arguments.forEach((arg: any, i: number) => {
          const s = strip(arg);
          const byAddress = s?.kind === NodeKind.UnaryExpr && s.operator === '&';
          const root = byAddress
            ? storedObject(s.operand, (n) => isArrayType(scope.get(n)?.type))
            : rootName(s);
          if (!root) return;
          const e = scope.get(root);
          if (!e || e.kind !== 'local' || e.isStatic) return;
          if (!byAddress && !isArrayType(e.type)) return;
          if (!byAddress && unparen(s)?.kind !== NodeKind.Identifier) return;
          if (src && src.includes(i)) { if (!sunk.has(root)) sunk.set(root, c); }
          else filledByCall.add(root);
        });
      }
      if (!sunk.size) continue;
      const facts = localFacts(fn);
      for (const [name, call] of sunk) {
        const e = scope.get(name)!;
        if (SYNTHETIC_NAME.test(name) || e.decl.initializer) continue;
        const base = isArrayType(e.type) ? innermostElement(e.type) : e.type;
        const p = primitiveName(base);
        if (!p || !SEND_SCALARS.has(p)) continue;
        if (facts.writes.has(name) || filledByCall.has(name)) continue;
        // An alias taken by assignment (`p = &x`, `p = buf`) can fill it too.
        const aliased = ctx.of(fn, NodeKind.AssignExpr).some((a: any) => {
          const r = strip(a.right);
          return rootName(r) === name && (r?.kind === NodeKind.UnaryExpr || isArrayType(e.type));
        }) || ctx.of(fn, NodeKind.VariableDecl).some((d: any) => {
          const r = strip(d.initializer);
          return d !== e.decl && r && rootName(r) === name && (r.kind === NodeKind.UnaryExpr || isArrayType(e.type));
        });
        if (aliased) continue;
        out.push({
          check: this.id, file: fn.file.path, line: line(e.decl), fn: fn.qualifiedName, subject: name,
          detail: `${typeText(e.type)} passed to ${calleeName(call.callee)} (line ${line(call)}) but never assigned`,
        });
      }
    }
    return out;
  },
};

