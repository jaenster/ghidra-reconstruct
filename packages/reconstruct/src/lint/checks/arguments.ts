/**
 * Checks about what a CALL hands its callee: a global's address passed where the callee
 * writes an object larger than the global.
 */

import { NodeKind } from '@ghidra-mcp/cpp-parser';
import {
  calleeName, declName, elementType, isArrayType, isCast, isPointerType, line, primitiveName, refName, signature,
  strip, typeRefName, typeText, typeWidth, unparen, unqualified, walk, type SizeEnv,
} from '../ast.js';
import type { Check, Finding, LintContext, Resolved } from '../context.js';
import type { FunctionInfo } from '../tree.js';

// -------------------------------------------------------------------------------------------
// undersized-global-argument
// -------------------------------------------------------------------------------------------

/**
 * The Windows pointer typedefs the tree passes globals through, and the object each points
 * at. The tree compiles against the mingw headers, so the object the callee writes is the
 * mingw one: every size in SDK_OBJECT_SIZE was read off i686-w64-mingw32-g++ (sizeof), not
 * Ghidra's archive. The snapshot (Ghidra's model) sizes a name this table lacks.
 */
export const SDK_POINTER_TYPEDEFS: Record<string, string> = {
  LPCRITICAL_SECTION: '_RTL_CRITICAL_SECTION', PCRITICAL_SECTION: '_RTL_CRITICAL_SECTION',
  PRTL_CRITICAL_SECTION: '_RTL_CRITICAL_SECTION',
  LPOVERLAPPED: '_OVERLAPPED',
  LPWIN32_FIND_DATAA: '_WIN32_FIND_DATAA', PWIN32_FIND_DATAA: '_WIN32_FIND_DATAA',
  LPSYSTEMTIME: '_SYSTEMTIME', PSYSTEMTIME: '_SYSTEMTIME',
  LPFILETIME: '_FILETIME', PFILETIME: '_FILETIME',
  LPOSVERSIONINFOA: '_OSVERSIONINFOA', POSVERSIONINFOA: '_OSVERSIONINFOA',
  LPMEMORYSTATUS: '_MEMORYSTATUS',
  LPPOINT: 'tagPOINT', PPOINT: 'tagPOINT',
  LPRECT: 'tagRECT', PRECT: 'tagRECT', LPCRECT: 'tagRECT',
  LPSIZE: 'tagSIZE', PSIZE: 'tagSIZE',
  LPWSADATA: 'WSAData',
  PLARGE_INTEGER: '_LARGE_INTEGER', PULARGE_INTEGER: '_ULARGE_INTEGER',
  PCONTEXT: '_CONTEXT', LPCONTEXT: '_CONTEXT',
  LPSYSTEM_INFO: '_SYSTEM_INFO',
  LPSTARTUPINFOA: '_STARTUPINFOA',
  LPPROCESS_INFORMATION: '_PROCESS_INFORMATION',
  LPSECURITY_ATTRIBUTES: '_SECURITY_ATTRIBUTES', PSECURITY_ATTRIBUTES: '_SECURITY_ATTRIBUTES',
  LPMSG: 'tagMSG', PMSG: 'tagMSG',
  LPWNDCLASSA: 'tagWNDCLASSA',
  LPPAINTSTRUCT: 'tagPAINTSTRUCT',
  LPTIME_ZONE_INFORMATION: '_TIME_ZONE_INFORMATION',
  LPBY_HANDLE_FILE_INFORMATION: '_BY_HANDLE_FILE_INFORMATION',
  PMEMORY_BASIC_INFORMATION: '_MEMORY_BASIC_INFORMATION',
  LPSOCKADDR: 'sockaddr', PSOCKADDR: 'sockaddr',
  LPSOCKADDR_IN: 'sockaddr_in', PSOCKADDR_IN: 'sockaddr_in',
  LPTIMEVAL: 'timeval', PTIMEVAL: 'timeval',
  LPEXCEPTION_POINTERS: '_EXCEPTION_POINTERS', PEXCEPTION_POINTERS: '_EXCEPTION_POINTERS',
  PEXCEPTION_RECORD: '_EXCEPTION_RECORD',
  LPGUID: '_GUID', LPCGUID: '_GUID', LPIID: '_GUID', LPCLSID: '_GUID',
  LPPALETTEENTRY: 'tagPALETTEENTRY',
  LPDWORD: 'DWORD', PDWORD: 'DWORD', LPLONG: 'LONG', PLONG: 'LONG', PULONG: 'ULONG',
  LPWORD: 'WORD', PWORD: 'WORD', LPBOOL: 'BOOL', PBOOL: 'BOOL', LPINT: 'INT', PINT: 'INT',
  PUINT: 'UINT', LPUINT: 'UINT', LPHANDLE: 'HANDLE', PHANDLE: 'HANDLE', PHKEY: 'HANDLE',
  PSHORT: 'SHORT', PUSHORT: 'USHORT', PLONGLONG: 'QWORD', PULONGLONG: 'QWORD',
  PDWORD_PTR: 'DWORD', PULONG_PTR: 'DWORD', PLONG_PTR: 'DWORD', PSIZE_T: 'DWORD',
};

/** i686 mingw sizeof() of the objects above, by every spelling the tree may use. */
export const SDK_OBJECT_SIZE: Record<string, number> = {
  _RTL_CRITICAL_SECTION: 24, RTL_CRITICAL_SECTION: 24, CRITICAL_SECTION: 24,
  _OVERLAPPED: 20, OVERLAPPED: 20,
  _WIN32_FIND_DATAA: 320, WIN32_FIND_DATAA: 320,
  _SYSTEMTIME: 16, SYSTEMTIME: 16,
  _FILETIME: 8, FILETIME: 8,
  _OSVERSIONINFOA: 148, OSVERSIONINFOA: 148,
  _MEMORYSTATUS: 32, MEMORYSTATUS: 32,
  tagPOINT: 8, POINT: 8,
  tagRECT: 16, RECT: 16,
  tagSIZE: 8, SIZE: 8,
  WSAData: 400, WSADATA: 400,
  _LARGE_INTEGER: 8, LARGE_INTEGER: 8, _ULARGE_INTEGER: 8, ULARGE_INTEGER: 8,
  _CONTEXT: 716, CONTEXT: 716,
  _SYSTEM_INFO: 36, SYSTEM_INFO: 36,
  _STARTUPINFOA: 68, STARTUPINFOA: 68,
  _PROCESS_INFORMATION: 16, PROCESS_INFORMATION: 16,
  _SECURITY_ATTRIBUTES: 12, SECURITY_ATTRIBUTES: 12,
  tagMSG: 28, MSG: 28,
  tagWNDCLASSA: 40, WNDCLASSA: 40,
  tagPAINTSTRUCT: 64, PAINTSTRUCT: 64,
  _TIME_ZONE_INFORMATION: 172, TIME_ZONE_INFORMATION: 172,
  _BY_HANDLE_FILE_INFORMATION: 52, BY_HANDLE_FILE_INFORMATION: 52,
  _MEMORY_BASIC_INFORMATION: 28, MEMORY_BASIC_INFORMATION: 28,
  sockaddr: 16, SOCKADDR: 16, sockaddr_in: 16, SOCKADDR_IN: 16,
  timeval: 8, TIMEVAL: 8,
  _EXCEPTION_POINTERS: 8, EXCEPTION_POINTERS: 8,
  _EXCEPTION_RECORD: 80, EXCEPTION_RECORD: 80,
  _GUID: 16, GUID: 16, IID: 16, CLSID: 16,
  tagPALETTEENTRY: 4, PALETTEENTRY: 4,
};

/** Pointer typedefs the snapshot and the tree's own headers define: name -> pointee type text. */
function pointerTypedefs(ctx: LintContext): Map<string, any> {
  const out = new Map<string, any>();
  for (const file of ctx.tree.files) {
    if (!file.isHeader) continue;
    walk(file.tu as any, (n: any) => {
      if (n.kind === NodeKind.FunctionDecl) return 'skip';
      if (n.kind === NodeKind.TypedefDecl && isPointerType(n.type)) {
        const name = refName(n.name) ?? n.name?.name;
        if (typeof name === 'string' && !out.has(name)) out.set(name, unqualified(n.type).pointee);
      }
      return undefined;
    });
  }
  return out;
}

/** Prototypes by simple name: each declaration's parameter types. */
function prototypes(ctx: LintContext): Map<string, any[][]> {
  const out = new Map<string, any[][]>();
  for (const file of ctx.tree.files) {
    walk(file.tu as any, (n: any) => {
      if (n.kind !== NodeKind.FunctionDecl) return undefined;
      const name = calleeName(n.name);
      if (name) {
        let l = out.get(name);
        if (!l) out.set(name, (l = []));
        l.push((n.parameters ?? []).map((p: any) => p.type));
      }
      return 'skip';
    });
  }
  return out;
}

interface Pointee { text: string; size: number }

/**
 * A global declared as a named, non-primitive type - a struct someone typed. When it meets a
 * LARGER struct pointer the parameter is as likely wrong as the global (SRP_ClientKeyExchange
 * once took the SRP credentials as a D2UnitStrc*); the finding says so.
 */
function aggregate(t: any): boolean {
  const u = unqualified(t);
  return !!typeRefName(u) && primitiveName(u) === null;
}

/**
 * The global an argument hands over, and how many bytes of it lie at and past that address.
 * `&g`, `g` for an array global (it decays) and `&g[k]` for a constant k. A pointer global
 * passed by value hands over what it points AT, which is not the global.
 */
function globalObject(ctx: LintContext, fn: FunctionInfo, arg: any): { r: Extract<Resolved, { kind: 'global' | 'file' }>; cap: number | null } | null {
  const s = strip(arg);
  if (!s) return null;
  const asGlobal = (e: any) => {
    const r = refName(e) ? ctx.resolve(fn, e) : null;
    return r && (r.kind === 'global' || r.kind === 'file') ? r : null;
  };
  if (s.kind === NodeKind.UnaryExpr && s.operator === '&') {
    const op = strip(s.operand);
    const r = asGlobal(op);
    if (r) return { r, cap: isPointerType(r.type) ? 4 : typeWidth(r.type, ctx.sizeEnv) };
    if (op?.kind === NodeKind.SubscriptExpr) {
      const ar = asGlobal(unparen(op.array));
      if (!ar || !isArrayType(ar.type)) return null;
      const k = ctx.value(fn, op.index);
      const total = typeWidth(ar.type, ctx.sizeEnv);
      const ew = typeWidth(elementType(ar.type), ctx.sizeEnv);
      if (k === null || total === null || ew === null) return null;
      return { r: ar, cap: total - k * ew };
    }
    return null;
  }
  const r = asGlobal(s);
  if (r && isArrayType(r.type)) return { r, cap: typeWidth(r.type, ctx.sizeEnv) };
  return null;
}

/**
 * A global's address passed to a parameter whose pointee is larger than the global.
 *
 * `InitializeCriticalSection(&gcsErrorHandlerList)` with the critical section modelled as one
 * byte: the callee wrote its 24 bytes over the rebuild's own neighbours, corrupted pFormsList
 * and crashed the game. oversized-global-write sees only memcpy/memset spans; this sees a
 * write sized by a TYPE - every SDK struct out-parameter, every D2 struct pointer.
 *
 * The pointee is what the callee receives: the outermost pointer cast on the argument - the
 * emitter casts precisely because the global's type is not the parameter's, and a strict C++
 * tree cannot pass `uint8_t*` as `LPCRITICAL_SECTION` without one - or, uncast, the
 * parameter type every prototype of the callee agrees on. Pointer typedefs (LPRECT) resolve
 * through the tree's headers, then the SDK table. Character and void pointees never report:
 * they are the byte-wise view, not a claim about the object.
 */
export const undersizedGlobalArgument: Check = {
  id: 'undersized-global-argument',
  blurb: 'global passed by address to a parameter whose pointee is larger than the global',
  run(ctx) {
    const typedefs = pointerTypedefs(ctx);
    const protos = prototypes(ctx);
    const env: SizeEnv = {
      named: (n: string) => SDK_OBJECT_SIZE[n] ?? ctx.sizeEnv.named?.(n) ?? null,
    };
    const pointeeOf = (t: any): Pointee | null => {
      const u = unqualified(t);
      if (!u) return null;
      let pointee: any;
      if (u.kind === NodeKind.PointerType) pointee = u.pointee;
      else {
        const n = typeRefName(u);
        if (!n) return null;
        if (SDK_POINTER_TYPEDEFS[n]) {
          const obj = SDK_POINTER_TYPEDEFS[n];
          const size = SDK_OBJECT_SIZE[obj] ?? typeWidth({ kind: NodeKind.TypedefType, name: { kind: NodeKind.Identifier, name: obj } }, env);
          return size === null ? null : { text: `${n} -> ${obj}`, size };
        }
        pointee = typedefs.get(n);
        if (!pointee) return null;
      }
      const p = primitiveName(pointee);
      if (p && /char|^u?int8_t$|^byte$|^BYTE$|^undefined1?$|^CHAR$|^UCHAR$/.test(p)) return null;
      const size = typeWidth(pointee, env);
      return size === null ? null : { text: typeText(t), size };
    };

    const worst = new Map<string, { f: Finding; need: number; sites: number }>();
    for (const fn of ctx.tree.functions) {
      for (const c of ctx.of(fn, NodeKind.CallExpr)) {
        const callee = calleeName(c.callee);
        const args: any[] = c.arguments ?? [];
        for (let ai = 0; ai < args.length; ai++) {
          const obj = globalObject(ctx, fn, args[ai]);
          if (!obj) continue;
          // The outermost pointer cast is the type the callee receives.
          let pointee: Pointee | null = null;
          let cast = false;
          for (let e = unparen(args[ai]); e && isCast(e); e = unparen(e.expression)) {
            const u = unqualified(e.type);
            if (u?.kind === NodeKind.PointerType || typeRefName(u)) { pointee = pointeeOf(e.type); cast = true; break; }
          }
          if (!cast && callee) {
            const decls = (protos.get(callee) ?? []).filter(ps => ps.length > ai);
            const sizes = decls.map(ps => pointeeOf(ps[ai]));
            if (sizes.length && sizes.every(s => s && s.size === sizes[0]!.size)) pointee = sizes[0];
          }
          if (!pointee || obj.cap === null || pointee.size <= obj.cap) continue;
          const name = obj.r.kind === 'global' ? obj.r.decl.name : declName(obj.r.decl) ?? refName(strip(args[ai])) ?? '?';
          const f: Finding = {
            check: this.id, subject: name, file: fn.file.path, line: line(c), fn: fn.qualifiedName,
            sig: signature(args[ai]),
            detail: `${callee ?? '(indirect)'} arg ${ai}: ${pointee.text} is ${pointee.size} bytes, `
              + `${name} is ${obj.cap}-byte ${typeText(obj.r.type)}`
              + (aggregate(obj.r.type) ? ' - the global is a typed aggregate: suspect the parameter type first' : ''),
          };
          const prev = worst.get(name);
          if (!prev) worst.set(name, { f, need: pointee.size, sites: 1 });
          else {
            prev.sites++;
            if (pointee.size > prev.need) { prev.f = f; prev.need = pointee.size; }
          }
        }
      }
    }
    return [...worst.values()].map(({ f, sites }) => ({
      check: f.check, subject: f.subject,
      detail: `${f.detail} (${f.file}:${f.line}${sites > 1 ? `, ${sites} sites` : ''})`,
    }));
  },
};

