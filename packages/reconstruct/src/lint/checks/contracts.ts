/**
 * Checks about what a function or a value CROSSES: an address that was never relocated, a
 * calling convention the rebuild forgot, an argument block the callee reads but nobody wrote.
 *
 * Inside the rebuilt exe every caller and callee agree, so none of these fails there. They
 * fail at the boundary - a downloaded module calling a vtable slot, a callback reading a block
 * the machine filled from a register, a literal that was a 1.14d address.
 */

import { NodeKind } from '@ghidra-mcp/cpp-parser';
import {
  arrayLength, calleeName, constValue, elementType, isArrayType, line, signature, strip, typeWidth, walk,
} from '../ast.js';
import type { Check, Finding } from '../context.js';
import type { FunctionInfo } from '../tree.js';

const REGISTER_CONVENTIONS = new Set(['__thiscall', '__fastcall', '__fastcall_ecxsafe']);

/** `// 1.14d: 00480040` above a definition. */
function addressOfFunction(fn: FunctionInfo): number | null {
  for (const t of (fn.node as any).leadingTrivia ?? []) {
    const m = /1\.14d:\s*([0-9a-fA-F]{8})\b/.exec(String(t.text ?? ''));
    if (m) return parseInt(m[1], 16);
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// raw-code-address-argument
// -------------------------------------------------------------------------------------------

/**
 * A call argument that is a literal equal to the 1.14d address of a FUNCTION.
 *
 * A callback handed over as a number - the parameter was typed int, so the machine's
 * `PUSH OFFSET fn` became `0x4c1d20`. The relinked exe puts the function elsewhere and the
 * callee jumps into whatever lives at the old address. A data address as an argument is
 * raw-address-argument's; this is its code twin. Only an exact function start inside the
 * image counts, written in hex, which keeps sizes and flags out.
 */
export const rawCodeAddressArgument: Check = {
  id: 'raw-code-address-argument',
  blurb: 'call argument that is a literal 1.14d function address - never relocated by the relink',
  run(ctx) {
    const out: Finding[] = [];
    const snap = ctx.snapshot;
    if (!snap) return out;
    const code = new Map<number, string>();
    for (const f of snap.functions().values()) code.set(f.address, f.name);
    const hit = (v: number): { kind: string; name: string } | null => {
      if (v < 0x401000 || v > 0x1000000) return null;
      const f = code.get(v);
      if (f) return { kind: 'function', name: f };
      return null;
    };
    for (const fn of ctx.tree.functions) {
      for (const c of ctx.of(fn, NodeKind.CallExpr)) {
        const args: any[] = c.arguments;
        for (let i = 0; i < args.length; i++) {
          const lit = strip(args[i]);
          if (lit?.kind !== NodeKind.IntegerLiteral) continue;
          // The emitter spells an address in hex; 10000000 is a decimal that happens to be one.
          if (lit.base !== 16) continue;
          const v = constValue(lit);
          const h = v === null ? null : hit(v);
          if (!h) continue;
          out.push({
            check: this.id, file: fn.file.path, line: line(c), fn: fn.qualifiedName, subject: `${calleeName(c.callee) ?? '?'}#arg${i}`,
            detail: `0x${v!.toString(16)} is ${h.kind} ${h.name} in 1.14d`,
            sig: signature(c) + `#arg${i}`,
          });
        }
      }
    }
    return out;
  },
};

// -------------------------------------------------------------------------------------------
// callback-convention-dropped
// -------------------------------------------------------------------------------------------

function isFunctionPointer(t: any): { fnType: any } | null {
  let u = t;
  while (u && (u.kind === NodeKind.QualifiedType)) u = u.type;
  if (u?.kind === NodeKind.PointerType && u.pointee?.kind === NodeKind.FunctionType) return { fnType: u.pointee };
  return null;
}

/**
 * A callback typedef or function-pointer member Ghidra gives a register convention that the
 * emitted declaration does not spell.
 *
 * The `WardenClient` vtable is called by a downloaded module with the object in ECX. Every
 * typedef in WardenClient.h says `void (*)(WardenClient*, ...)`, the funcdef in Ghidra says
 * `__thiscall`, and rebuilt callers and callees agree on cdecl - so the tree works until
 * something that was NOT rebuilt makes the call. `__stdcall` survives the rebuild and
 * `__fastcall`/`__thiscall` do not, so this is the register conventions only.
 */
export const callbackConventionDropped: Check = {
  id: 'callback-convention-dropped',
  blurb: 'function-pointer typedef or member Ghidra types __thiscall/__fastcall, emitted without it',
  run(ctx) {
    const out: Finding[] = [];
    const snap = ctx.snapshot;
    if (!snap) return out;
    const fieldFuncdef = new Map<string, string>();
    for (const s of snap.structs) {
      for (const f of s.fields) {
        if (!f.name || !f.dataType) continue;
        const dt = String(f.dataType).replace(/\s*\*+\s*$/, '');
        if (snap.funcdefs.has(dt)) fieldFuncdef.set(`${s.name}.${f.name}`, dt);
      }
    }
    for (const file of ctx.tree.files) {
      walk(file.tu as any, (n: any) => {
        if (n.kind === NodeKind.TypedefDecl) {
          const name = n.name?.name;
          const conv = name ? snap.funcdefs.get(name) : undefined;
          const fp = isFunctionPointer(n.type);
          if (conv && REGISTER_CONVENTIONS.has(conv) && fp && !fp.fnType.callingConvention) {
            out.push({
              check: this.id, file: file.path, line: line(n), subject: name,
              detail: `typedef ${name} is ${conv} in Ghidra, spelled without it`, sig: `typedef:${name}`,
            });
          }
        } else if (n.kind === NodeKind.StructDecl && n.name?.name) {
          for (const m of n.members ?? []) {
            if (m?.kind !== NodeKind.VariableDecl) continue;
            const mn = m.name?.name;
            const fd = mn ? fieldFuncdef.get(`${n.name.name}.${mn}`) : undefined;
            const conv = fd ? snap.funcdefs.get(fd) : undefined;
            const fp = isFunctionPointer(m.type);
            if (conv && REGISTER_CONVENTIONS.has(conv) && fp && !fp.fnType.callingConvention) {
              out.push({
                check: this.id, file: file.path, line: line(m), subject: `${n.name.name}.${mn}`,
                detail: `member is ${fd} (${conv}) in Ghidra, spelled without it`, sig: `member:${n.name.name}.${mn}`,
              });
            }
          }
        }
        return undefined;
      });
    }
    return out;
  },
};

// -------------------------------------------------------------------------------------------
// escaped-method-convention-dropped
// -------------------------------------------------------------------------------------------

/**
 * A function Ghidra gives __thiscall/__fastcall whose address leaves the program's own call
 * graph - stored in a vtable or table, handed to a call - and whose definition does not
 * spell that convention.
 *
 * `Class::WardenClient::LoadModule` and `GetRC4Data` (00480040, 00480150) are in the
 * `vftable[7]` the downloaded Warden module calls with ECX = this. A direct call between
 * two rebuilt functions needs no convention; a call from outside does. The address-taken
 * test is the proxy for "can be called from outside": a function nobody takes the address of
 * is called by name, by rebuilt code, and is fine as it is.
 */
export const escapedMethodConventionDropped: Check = {
  id: 'escaped-method-convention-dropped',
  blurb: 'function Ghidra types __thiscall/__fastcall, address stored in a table or passed on, defined without it',
  run(ctx) {
    const out: Finding[] = [];
    const snap = ctx.snapshot;
    if (!snap) return out;
    const byLast = new Map<string, FunctionInfo[]>();
    for (const f of ctx.tree.functions) {
      const last = f.qualifiedName.split('::').pop()!;
      let l = byLast.get(last);
      if (!l) byLast.set(last, (l = []));
      l.push(f);
    }
    const table = snap.functions();
    const resolveRef = (n: any): FunctionInfo | null => {
      let last: string | undefined;
      let quals: string[] = [];
      if (n.kind === NodeKind.Identifier) last = n.name;
      else if (n.kind === NodeKind.QualifiedId) {
        last = n.name?.name;
        quals = (n.qualifier ?? []).map((q: any) => q?.name?.name ?? q?.name).filter(Boolean);
      }
      if (!last) return null;
      const cands = (byLast.get(last) ?? []).filter(f => {
        const segs = f.qualifiedName.split('::');
        const want = [...quals, last!];
        return want.every((w, i) => segs[segs.length - want.length + i] === w);
      });
      return cands.length === 1 ? cands[0] : null;
    };
    const escaped = new Map<FunctionInfo, { file: string; line: number; via: string }>();
    for (const file of ctx.tree.files) {
      if (file.isHeader) continue;
      // Names that sit inside a file-scope initializer: a vtable or dispatch table.
      const inTable = new Set<any>();
      walk(file.tu as any, (n: any) => {
        if (n.kind === NodeKind.FunctionDecl) return 'skip';
        if (n.kind === NodeKind.VariableDecl && n.initializer) {
          walk(n.initializer, (m: any) => { inTable.add(m); });
        }
        return undefined;
      });
      walk(file.tu as any, (n: any, p: any) => {
        if (n.kind !== NodeKind.Identifier && n.kind !== NodeKind.QualifiedId) return undefined;
        if (!p) return undefined;
        // A callee is a call, not an escape; the same goes for a declarator's own name.
        if (p.kind === NodeKind.CallExpr && p.callee === n) return undefined;
        let via: string | null = null;
        if (inTable.has(n)) via = 'table';
        else if (p.kind === NodeKind.AssignExpr && p.right === n) via = 'assignment';
        else if (p.kind === NodeKind.UnaryExpr && p.operator === '&') via = 'address-of';
        if (!via) return undefined;
        const f = resolveRef(n);
        if (!f) return undefined;
        const prev = escaped.get(f);
        if (!prev || (prev.via !== 'table' && via === 'table')) escaped.set(f, { file: file.path, line: line(n), via });
        return undefined;
      });
    }
    const wanted = new Set(['table', 'assignment']);
    for (const [fn, at] of escaped) {
      if (!wanted.has(at.via)) continue;
      const addr = addressOfFunction(fn);
      const sf = addr === null ? null : table.get(addr);
      if (!sf || !REGISTER_CONVENTIONS.has(sf.callingConvention)) continue;
      const spelled = (fn.node as any).callingConvention as string | undefined;
      if (spelled && REGISTER_CONVENTIONS.has(spelled)) continue;
      out.push({
        check: this.id, file: fn.file.path, line: line(fn.node), fn: fn.qualifiedName, subject: fn.qualifiedName,
        detail: `${sf.name} @${addr!.toString(16)} is ${sf.callingConvention} in Ghidra (${sf.storage.slice(0, 2).join(', ')}), ` +
          `defined ${spelled ?? 'without a convention'}; address taken (${at.via}) at ${at.file}:${at.line}`,
        sig: `fn:${fn.qualifiedName}`,
      });
    }
    return out;
  },
};

// -------------------------------------------------------------------------------------------
// partial-argument-block
// -------------------------------------------------------------------------------------------

/**
 * A local array that is filled by constant-index stores with a hole in them and then handed
 * to a call - an argument block the callee reads whole.
 *
 * `SCMD_GenerateError` builds `sCallbackArgs[3]`, stores [0] and [2] and calls the user's
 * callback with it. [1] is the filename the machine kept in EBX: a register argument Ghidra's
 * signature never declared, so no store was emitted, the callback reads stack garbage and the
 * error text names the wrong file. A hole BELOW the highest store is the tell; trailing
 * unwritten slots are usually just a frame run Ghidra sized generously.
 */
export const partialArgumentBlock: Check = {
  id: 'partial-argument-block',
  blurb: 'local array with constant-index stores that skip a slot, then handed to a call - a dropped register argument',
  run(ctx) {
    const out: Finding[] = [];
    for (const fn of ctx.tree.functions) {
      const scope = fn.scope();
      const arrays = [...scope.values()].filter(e => e.kind === 'local' && !e.isStatic && isArrayType(e.type) && !e.decl.initializer);
      if (!arrays.length) continue;
      const parents = new Map<any, any>();
      walk((fn.node as any).body, (n, p) => { parents.set(n, p); });
      for (const a of arrays) {
        const n = arrayLength(a.type);
        const w = typeWidth(elementType(a.type), ctx.sizeEnv);
        if (n === null || n < 2 || n > 16 || w === null || w < 4) continue;
        const stores = new Set<number>();
        let passed: any = null;
        let other = false;
        for (const id of ctx.of(fn, NodeKind.Identifier)) {
          if (id.name !== a.name) continue;
          let up = parents.get(id);
          if (up?.kind === NodeKind.SubscriptExpr && up.array === id) {
            const k = ctx.value(fn, up.index);
            const asg = parents.get(up);
            if (k !== null && asg?.kind === NodeKind.AssignExpr && asg.left === up && asg.operator === '=') stores.add(k);
            else if (k === null) other = true;
            continue;
          }
          while (up && (up.kind === NodeKind.ParenExpr || up.kind === NodeKind.CStyleCastExpr || up.kind === NodeKind.ReinterpretCastExpr)) up = parents.get(up);
          if (up?.kind === NodeKind.CallExpr && up.callee !== id && !passed) { passed = up; continue; }
          if (up?.kind === NodeKind.VariableDecl && up.name === id) continue;
          other = true;
        }
        if (other || !passed || stores.size < 2) continue;
        const max = Math.max(...stores);
        const holes: number[] = [];
        for (let k = 0; k < max; k++) if (!stores.has(k)) holes.push(k);
        if (!holes.length) continue;
        out.push({
          check: this.id, file: fn.file.path, line: line(passed), fn: fn.qualifiedName, subject: a.name,
          detail: `${a.name}[${n}]: [${[...stores].sort((x, y) => x - y).join(', ')}] stored, [${holes.join(', ')}] never, then passed to ${calleeName(passed.callee) ?? 'an indirect call'}`,
          sig: signature(passed) + `#${a.name}`,
        });
      }
    }
    return out;
  },
};
