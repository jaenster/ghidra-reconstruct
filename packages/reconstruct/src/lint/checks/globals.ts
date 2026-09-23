/**
 * Checks about GLOBAL objects: a global Ghidra sized too small for what the code does to it,
 * and addresses that only work while the original link order holds.
 */

import { NodeKind, getChildren, type ASTNode } from '@ghidra-mcp/cpp-parser';
import {
  addressOfName, calleeName, declName, isArrayType, isCast, isPointerType, line, parentMap, primitiveName,
  refName, signature, strip, typeRefName, typeText, typeWidth, unparen, walk,
} from '../ast.js';
import type { Check, Finding, LintContext, Resolved } from '../context.js';
import type { FunctionInfo, SourceFile } from '../tree.js';

/**
 * Every node of the given kinds across the tree - inside functions AND at file scope (a
 * global initializer or an inline header function indexes a global just as well) - each
 * with the function it sits in, so names resolve against the right scope.
 */
function* sitesInTree(ctx: LintContext, kinds: Set<string>, opts: { headers?: boolean; skipGlobalsH?: boolean } = {}):
    Generator<{ node: any; fn: FunctionInfo | null; file: SourceFile }> {
  const fnByNode = new Map<ASTNode, FunctionInfo>();
  for (const f of ctx.tree.functions) fnByNode.set(f.node as ASTNode, f);
  for (const file of ctx.tree.files) {
    if (file.isHeader && !opts.headers) continue;
    if (opts.skipGlobalsH && file.path === 'globals.h') continue;
    const stack: Array<[any, FunctionInfo | null]> = [[file.tu, null]];
    while (stack.length) {
      const [n, outer] = stack.pop()!;
      if (!n || typeof n !== 'object') continue;
      const fn = fnByNode.get(n) ?? outer;
      if (kinds.has(n.kind)) yield { node: n, fn, file };
      const kids = getChildren(n);
      for (let i = kids.length - 1; i >= 0; i--) if (kids[i]) stack.push([kids[i], fn]);
    }
  }
}

const isGlobalObject = (r: Resolved | null): r is Extract<Resolved, { kind: 'global' | 'file' }> =>
  !!r && (r.kind === 'global' || r.kind === 'file');

// -------------------------------------------------------------------------------------------
// indexed-scalar-global
// -------------------------------------------------------------------------------------------

/**
 * A global Ghidra models as a SCALAR that the code indexes as an array.
 *
 * A scalar that is indexed is a contradiction: either the index is always zero, or the
 * object is really an array and Ghidra has its extent wrong. The second kind smears -
 * `gaItemPaletteTransformData`, one byte, took 0x35D00 of writes.
 *
 * The three shapes, as AST, not text: `&g + i` (a BinaryExpr whose operand is the address of
 * g), `(&g)[i]` (a SubscriptExpr on it), and `&g[i]` when g itself is not a pointer - for a
 * POINTER global `&p[i]` indexes the pointee and is ordinary code, which the regex could not
 * tell apart. A constant zero index is a no-op and is not a use. A local that shadows the
 * global is not the global.
 *
 * Reported only when the snapshot shows a large unnamed region behind the symbol (gap
 * >= 0x400 and the modelled size smaller than the gap) - the dangerous shape. The candidate
 * list without that filter is a census, not a finding.
 */
export const indexedScalarGlobal: Check = {
  id: 'indexed-scalar-global',
  blurb: 'global modelled as a scalar but indexed as an array',
  run(ctx) {
    const uses = new Map<string, number>();
    const kinds = new Set<string>([NodeKind.BinaryExpr, NodeKind.SubscriptExpr, NodeKind.UnaryExpr]);
    for (const { node: n, fn, file } of sitesInTree(ctx, kinds, { headers: true, skipGlobalsH: true })) {
      let target: any = null;
      let index: any = null;
      if (n.kind === NodeKind.BinaryExpr && (n.operator === '+' || n.operator === '-')) {
        if (addressOfName(n.left)) { target = strip(n.left).operand; index = n.right; }
        else if (n.operator === '+' && addressOfName(n.right)) { target = strip(n.right).operand; index = n.left; }
      } else if (n.kind === NodeKind.SubscriptExpr && addressOfName(n.array)) {
        target = strip(n.array).operand; index = n.index;
      } else if (n.kind === NodeKind.UnaryExpr && n.operator === '&') {
        const op = unparen(n.operand);
        if (op?.kind === NodeKind.SubscriptExpr && refName(unparen(op.array))) {
          const r = ctx.resolve(fn, unparen(op.array), file);
          if (isGlobalObject(r) && !isPointerType(r.type)) { target = unparen(op.array); index = op.index; }
        }
      }
      if (!target) continue;
      const r = ctx.resolve(fn, strip(target), file);
      if (!r || r.kind !== 'global' || isArrayType(r.type)) continue;
      if (ctx.value(fn, index) === 0) continue;
      const name = refName(strip(target))!;
      uses.set(name, (uses.get(name) ?? 0) + 1);
    }
    const out: Finding[] = [];
    const snap = ctx.snapshot;
    if (!snap) return out;
    for (const [name, count] of uses) {
      const g = snap.globalByName.get(name);
      if (!g) continue;
      const gap = snap.gapAfter.get(g.address) ?? null;
      if (gap !== null && gap >= 0x400 && g.size < gap) {
        out.push({
          check: this.id, subject: name,
          detail: `gap 0x${gap.toString(16)}, declared ${g.size} (${count} indexed use(s))`,
        });
      }
    }
    return out;
  },
};

// -------------------------------------------------------------------------------------------
// oversized-global-write
// -------------------------------------------------------------------------------------------

const MEM_WRITES = new Set(['memcpy', 'memset', 'memmove']);

/**
 * memcpy/memset/memmove that writes more bytes into a global than it is declared to hold.
 *
 * The same defect as an indexed scalar, invisible to that check: `memcpy(&gPaletteAct1,
 * src, 0x30000)` never spells an index. Found only when the boot died in
 * D2WINPAL_LoadActPalette with four act palettes modelled one byte each.
 *
 * The destination is the global ITSELF - `&g`, or `g` when g is an array (it decays) - never
 * a pointer global passed by value, which writes through the pointer. A struct global is
 * sized from the snapshot, which the compiler-checked layout (struct-packing-mismatch) keeps
 * honest; where no size is known the site is still reported, for a human, because silently
 * dropping it once hid a live wild write into gaItemTypeBaseIdTable.
 */
export const oversizedGlobalWrite: Check = {
  id: 'oversized-global-write',
  blurb: 'memcpy/memset writes past a global declared size',
  run(ctx) {
    const worst = new Map<string, { n: number; cap: number | null; call: string; file: string; line: number; ty: string }>();
    for (const fn of ctx.tree.functions) {
      for (const c of ctx.of(fn, NodeKind.CallExpr)) {
        const name = calleeName(c.callee);
        if (!name || !MEM_WRITES.has(name) || c.arguments.length !== 3) continue;
        const dst = strip(c.arguments[0]);
        let r: Resolved | null = null;
        let viaAddress = false;
        if (dst?.kind === NodeKind.UnaryExpr && dst.operator === '&' && refName(strip(dst.operand))) {
          r = ctx.resolve(fn, strip(dst.operand));
          viaAddress = true;
        } else if (refName(dst)) {
          r = ctx.resolve(fn, dst);
        }
        if (!r || r.kind !== 'global') continue;
        if (!viaAddress && isPointerType(r.type)) continue;     // writes THROUGH the pointer
        const n = ctx.value(fn, c.arguments[2]);
        if (n === null) continue;
        const cap = viaAddress && isPointerType(r.type) ? 4 : typeWidth(r.type, ctx.sizeEnv);
        if (cap !== null && n <= cap) continue;
        const gname = r.decl.name;
        const prev = worst.get(gname);
        if (!prev || n > prev.n) {
          worst.set(gname, { n, cap, call: name, file: fn.file.path, line: line(c), ty: typeText(r.type) });
        }
      }
    }
    return [...worst].map(([g, w]) => ({
      check: this.id, subject: g,
      detail: w.cap === null
        ? `span write into ${w.ty} - size not derivable, check by hand (${w.file}:${w.line})`
        : `${w.call} 0x${w.n.toString(16)} into ${w.cap}-byte ${w.ty} (${w.file}:${w.line})`,
    }));
  },
};

// -------------------------------------------------------------------------------------------
// truncated-string-global
// -------------------------------------------------------------------------------------------

const STRINGISH_SCALARS = new Set(['uint8_t', 'byte', 'char', 'int8_t', 'undefined', 'undefined1',
  'uint16_t', 'int16_t', 'uint32_t', 'int32_t', 'int', 'uint', 'BYTE', 'unsigned char', 'unsigned int']);

function isCharPointer(t: any): boolean {
  let u = t;
  while (u?.kind === NodeKind.QualifiedType) u = u.type;
  if (u?.kind !== NodeKind.PointerType) return false;
  const p = primitiveName(u.pointee);
  return p === 'char';
}

/** Pointer-to-char typedefs the Windows headers and the emitter spell instead of `char *`. */
const CHAR_POINTER_TYPEDEFS = new Set(['LPSTR', 'LPCSTR', 'PSTR', 'PCSTR', 'LPCCH', 'PCHAR', 'LPCH', 'PCH']);

function isStringParamType(t: any): boolean {
  if (isCharPointer(t)) return true;
  const n = typeRefName(t);
  return !!n && CHAR_POINTER_TYPEDEFS.has(n);
}

/** Library calls whose listed arguments are C strings, whatever their prototype in the tree says. */
const STRING_SINKS: Record<string, number[]> = {
  strcpy: [0, 1], strcat: [0, 1], strncpy: [0, 1], strncat: [0, 1], strcmp: [0, 1], strncmp: [0, 1],
  _stricmp: [0, 1], stricmp: [0, 1], _strcmpi: [0, 1], strcmpi: [0, 1], _strnicmp: [0, 1], strnicmp: [0, 1],
  strlen: [0], strchr: [0], strrchr: [0], strstr: [0, 1], strdup: [0], _strdup: [0], atoi: [0], atol: [0],
  strtol: [0], strtoul: [0], fopen: [0, 1], _mkdir: [0], remove: [0], rename: [0, 1],
  lstrcpyA: [0, 1], lstrcpy: [0, 1], lstrcpynA: [0, 1], lstrcatA: [0, 1], lstrcat: [0, 1],
  lstrcmpA: [0, 1], lstrcmp: [0, 1], lstrcmpiA: [0, 1], lstrcmpi: [0, 1], lstrlenA: [0], lstrlen: [0],
  CreateFileA: [0], CreateDirectoryA: [0], DeleteFileA: [0], FindFirstFileA: [0], GetFileAttributesA: [0],
  LoadLibraryA: [0], GetModuleHandleA: [0], OutputDebugStringA: [0], MessageBoxA: [1, 2], SetWindowTextA: [1],
  SStrCopy: [0, 1], SStrNCat: [0, 1], SStrPack: [0, 1], SStrCmp: [0, 1], SStrCmpI: [0, 1], SStrLen: [0],
  SStrChr: [0], SStrChrR: [0], SStrStr: [0, 1], SStrStrI: [0, 1], SStrDup: [0], SStrHash: [0],
};

/** printf/scanf-family calls: index of the format argument. A `%s` argument is a string. */
const FORMAT_SINKS: Record<string, number> = {
  sprintf: 1, wsprintfA: 1, wsprintf: 1, printf: 0, fprintf: 1, sscanf: 1, fscanf: 1,
  SStrPrintf: 2, snprintf: 2, _snprintf: 2,
};

/** The conversion each variadic argument feeds, in order; `*` widths consume an int. */
export function formatConversions(fmt: string): string[] {
  const out: string[] = [];
  const re = /%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d+))?(hh|h|ll|l|L|I64|I32|I|w|z|j|t)?([diouxXcsSpeEfgGaAn%])/g;
  for (let m; (m = re.exec(fmt));) {
    if (m[5] === '%') continue;
    if (m[2] === '*') out.push('*');
    if (m[3] === '*') out.push('*');
    out.push(m[5]);
  }
  return out;
}

/** Prototypes by simple name: the parameter types and whether it is variadic. */
type Protos = Map<string, Array<{ params: any[]; variadic: boolean }>>;

function collectPrototypes(ctx: LintContext): Protos {
  const out: Protos = new Map();
  for (const file of ctx.tree.files) {
    walk(file.tu as any, (n: any) => {
      if (n.kind !== NodeKind.FunctionDecl) return undefined;
      const name = calleeName(n.name);
      if (name) {
        let l = out.get(name);
        if (!l) out.set(name, (l = []));
        l.push({ params: (n.parameters ?? []).map((p: any) => p.type), variadic: !!n.isVariadic });
      }
      return 'skip';
    });
  }
  return out;
}

/**
 * Is argument `ai` of `call` used as a C string? A known string function, a `%s` slot of a
 * format (the library's or any variadic prototype whose last fixed parameter is a char
 * pointer), or a parameter every prototype of that name declares as a char pointer.
 */
function stringArgument(call: any, ai: number, protos: Protos): string | null {
  const name = calleeName(call.callee);
  if (!name) return null;
  if (STRING_SINKS[name]?.includes(ai)) return `${name} arg ${ai}`;
  const decls = protos.get(name) ?? [];
  let fmtIndex: number | undefined = FORMAT_SINKS[name];
  if (fmtIndex === undefined) {
    const v = decls.find(d => d.variadic && d.params.length && isStringParamType(d.params[d.params.length - 1]));
    if (v) fmtIndex = v.params.length - 1;
  }
  if (fmtIndex !== undefined) {
    if (ai === fmtIndex) return `${name} format`;
    const lit = strip(call.arguments[fmtIndex]);
    if (ai > fmtIndex && lit?.kind === NodeKind.StringLiteral) {
      const conv = formatConversions(String(lit.value))[ai - fmtIndex - 1];
      if (conv === 's') return `${name} %s`;
      return null;
    }
  }
  if (decls.length && decls.every(d => d.params.length > ai && isStringParamType(d.params[ai]))) {
    return `${name} char* param ${ai}`;
  }
  return null;
}

/** Climb parens and casts from `e`: the node that actually sits in the enclosing expression. */
function outermost(parents: Map<any, any>, e: any): any {
  let cur = e;
  for (let p = parents.get(cur); p && (p.kind === NodeKind.ParenExpr || isCast(p)); p = parents.get(cur)) cur = p;
  return cur;
}

/**
 * A string constant modelled as a one-byte (or one-int) scalar, so relinking keeps only its
 * first character. `gaLanguageCodeAbbrevTable` is "ENG\0" typed undefined1; relinked, the
 * game built `data\local\lng\E\string.tbl` and faulted on the NULL load.
 *
 * The signal is a contradiction the AST states directly: the ADDRESS of a global of
 * primitive scalar type used as a string. Two spellings:
 *
 * - a CAST to `char *` of `&g`, used as a pointer rather than dereferenced on the spot;
 * - `&g` under any cast (`(uint32_t)&gszDirObjects`) handed to a string argument - a known
 *   string function, a `%s` slot of a format, a parameter the callee declares `char *` -
 *   directly or through one local it is stored in. COMPOSIT_BuildCofPath did the second:
 *   `nTypeToken = (uintptr_t)&gszDirObjects` then `wsprintfA(..., "%s\\%s\\COF...", nTypeToken,
 *   ...)`, with the 20-byte "DATA\GLOBAL\OBJECTS" emitted as one uint8_t zero - an empty
 *   directory, and every object COF load failed.
 *
 * The regex also fired on a local or parameter that shares a global's name (nPosX, nPosY,
 * nScreenMode) and on sized stores like `*(uint16_t *)(char *)&gnUICtrlConfigPendingKeyStrId
 * = v`, which write the scalar and read no string; name resolution and the dereference rule
 * the AST can see rule both out.
 */
export const truncatedStringGlobal: Check = {
  id: 'truncated-string-global',
  blurb: 'string constant modelled as a scalar - only its first char survives relinking',
  run(ctx) {
    const hits = new Map<string, { sites: Array<{ file: string; line: number; how: string }>; ty: string }>();
    const record = (r: Extract<Resolved, { kind: 'global' }>, file: string, ln: number, how: string) => {
      const name = r.decl.name;
      let h = hits.get(name);
      if (!h) hits.set(name, (h = { sites: [], ty: typeText(r.type) }));
      h.sites.push({ file, line: ln, how });
    };
    const scalarGlobal = (r: Resolved | null): r is Extract<Resolved, { kind: 'global' }> => {
      if (!r || r.kind !== 'global') return false;
      if (isArrayType(r.type) || isPointerType(r.type)) return false;
      const p = primitiveName(r.type);
      return !!p && STRINGISH_SCALARS.has(p) && !stringFits(r);
    };
    // A scalar whose initialised bytes hold a NUL is a string that ends inside the object:
    // `uint32_t gdwSystemMemoryMax = 0x29` is ")" and relinks intact.
    const stringFits = (r: Extract<Resolved, { kind: 'global' }>): boolean => {
      const v = ctx.snapshot?.globalByName.get(r.decl.name)?.value;
      const w = typeWidth(r.type, ctx.sizeEnv);
      if (v === null || v === undefined || w === null) return false;
      let x = BigInt.asUintN(w * 8, BigInt(v));
      for (let i = 0; i < w; i++, x >>= 8n) if ((x & 0xffn) === 0n) return true;
      return false;
    };
    // `*(uint16_t *)(char *)&g = v` is a sized store into g, not a string: a char* cast that
    // is dereferenced (directly, through further casts, or after `+ k`) is byte access.
    const dereferenced = new Set<any>();
    const kinds = new Set<string>([NodeKind.CStyleCastExpr, NodeKind.ReinterpretCastExpr, NodeKind.UnaryExpr, NodeKind.SubscriptExpr]);
    const markDeref = (e: any) => {
      for (let cur = e; cur;) {
        if (cur.kind === NodeKind.ParenExpr) cur = cur.expression;
        else if (cur.kind === NodeKind.CStyleCastExpr || cur.kind === NodeKind.ReinterpretCastExpr) { dereferenced.add(cur); cur = cur.expression; }
        else if (cur.kind === NodeKind.BinaryExpr && (cur.operator === '+' || cur.operator === '-')) cur = cur.left;
        else break;
      }
    };
    const sites = [...sitesInTree(ctx, kinds, { headers: true, skipGlobalsH: true })];
    for (const { node: n } of sites) {
      if (n.kind === NodeKind.UnaryExpr && n.operator === '*') markDeref(n.operand);
      else if (n.kind === NodeKind.SubscriptExpr) markDeref(n.array);
    }
    const viaCast = new Set<any>();
    for (const { node: n, fn, file } of sites) {
      if (n.kind !== NodeKind.CStyleCastExpr && n.kind !== NodeKind.ReinterpretCastExpr) continue;
      if (!isCharPointer(n.type) || dereferenced.has(n)) continue;
      const op = unparen(n.expression);
      if (op?.kind !== NodeKind.UnaryExpr || op.operator !== '&') continue;
      const r = ctx.resolve(fn, unparen(op.operand), file);
      if (!scalarGlobal(r)) continue;
      viaCast.add(op);
      record(r, file.path, line(n), 'char* cast');
    }

    // The address under any other cast, reaching a string argument.
    const protos = collectPrototypes(ctx);
    for (const fn of ctx.tree.functions) {
      const addrs = ctx.of(fn, NodeKind.UnaryExpr).filter((u: any) => u.operator === '&' && !viaCast.has(u));
      if (!addrs.length) continue;
      let parents: Map<any, any> | null = null;
      for (const a of addrs) {
        const r = ctx.resolve(fn, strip(a.operand));
        if (!scalarGlobal(r)) continue;
        parents ??= parentMap((fn.node as any).body);
        const top = outermost(parents, a);
        if (dereferenced.has(top)) continue;
        const p = parents.get(top);
        const asArg = (node: any, via: string) => {
          const call = parents!.get(node);
          if (call?.kind !== NodeKind.CallExpr) return false;
          const ai = (call.arguments ?? []).indexOf(node);
          if (ai < 0) return false;
          const how = stringArgument(call, ai, protos);
          if (how) record(r, fn.file.path, line(call), via + how);
          return !!how;
        };
        if (asArg(top, '')) continue;
        // Stored in a local first, then handed on: `t = (uintptr_t)&g; wsprintfA(b, "%s", t)`.
        let local: string | null = null;
        if (p?.kind === NodeKind.AssignExpr && p.operator === '=' && p.right === top) local = refName(unparen(p.left));
        else if (p?.kind === NodeKind.VariableDecl && p.initializer === top) local = declName(p);
        if (!local) continue;
        const lr = ctx.resolve(fn, { kind: NodeKind.Identifier, name: local });
        if (lr?.kind !== 'local') continue;
        // Reaching the uses: the statements after the store in its own block, up to the next
        // store to the same local. The emitter reuses one local for several stores (three
        // directory names into nTypeToken in COMPOSIT_BuildCofPath), each read right after.
        let stmt = p;
        while (stmt && parents.get(stmt)?.kind !== NodeKind.CompoundStmt) stmt = parents.get(stmt);
        const block = stmt ? parents.get(stmt) : null;
        if (!block) continue;
        const list: any[] = block.statements ?? [];
        for (let i = list.indexOf(stmt) + 1; i < list.length; i++) {
          let used = false;
          let stored = false;
          walk(list[i], (n: any) => {
            if (used) return 'skip';
            if (n.kind === NodeKind.AssignExpr && refName(unparen(n.left)) === local) stored = true;
            if (n.kind === NodeKind.Identifier && n.name === local && asArg(outermost(parents!, n), `via ${local}: `)) used = true;
            return undefined;
          });
          if (used || stored) break;
        }
      }
    }
    return [...hits].map(([name, h]) => ({
      check: this.id, subject: name,
      detail: `${h.sites.length} string use(s) of its address, declared ${h.ty} ` +
        `(${h.sites[0].file}:${h.sites[0].line} ${h.sites[0].how})`,
    }));
  },
};

// -------------------------------------------------------------------------------------------
// constant-shaped-address
// -------------------------------------------------------------------------------------------

/**
 * A data symbol whose ADDRESS is more plausible as a constant.
 *
 * Ghidra sees `PUSH 0x800000`, decides that is a data location, and the tree emits
 * `&D2PoolManagerStrc_00800000` where the machine pushed eight million. Pure snapshot data -
 * there is no C++ to read here, only Ghidra's symbol table. Confirm a hit by the
 * immediate-vs-memory-reference split before acting (docs/analysis/address-literal-class.md).
 */
export const constantShapedAddress: Check = {
  id: 'constant-shaped-address',
  blurb: 'data symbol at an address that is more plausibly a constant',
  run(ctx) {
    const out: Finding[] = [];
    for (const g of ctx.snapshot?.globals ?? []) {
      const v = g.address;
      if (!(v >= 0x400000 && v < 0x1000000) || !g.xrefCount) continue;
      const why: string[] = [];
      if (v && (v & (v - 1)) === 0) why.push('power-of-two');
      if (((v + 1) & v) === 0) why.push('2^n-1 mask');
      const h = v.toString(16);
      if (h.length >= 5 && h.endsWith('0000')) why.push('4+ trailing zero nibbles');
      if (h.endsWith('ffff')) why.push('low bits all set');
      if (why.length) {
        out.push({ check: this.id, subject: g.name, detail: `${g.addressText}, ${g.xrefCount} xrefs [${why.join(',')}]` });
      }
    }
    return out;
  },
};

// -------------------------------------------------------------------------------------------
// address-run-bound
// -------------------------------------------------------------------------------------------

/**
 * Ordering comparisons only. `p != &gHead` is how every Storm list walk ends - the head IS the
 * sentinel, its address is the intended value, and relinking does not move it relative to
 * itself - so an equality test against a global's address is not this defect.
 */
const RELATIONAL = new Set(['<', '<=', '>', '>=']);

/**
 * A loop whose bound is spelled as another global's ADDRESS.
 *
 * The original is a bounded walk `while (p < end)` where end folded to a literal equal to the
 * next global's address. The emitter resolves the literal back to that symbol, which is right
 * only while the linker keeps the two adjacent - and it does not. D2COMP_InitEmblemColorTables
 * should walk 31 bytes in 10 iterations; relinked it ran ~5.7 million times and smeared 2.2 MB
 * of .bss. The `address-run-bound` pass respells these as a distance from the walked global
 * (`&g + 31`), so only a BARE `&global` bound is the defect.
 *
 * AST: a relational comparison in a loop CONDITION (while, do-while, for) with an operand
 * that is, through casts, exactly `&G` for a global or file-scope G. The regex needed the
 * `(uintptr_t)` spelling and a `while` on one line; this sees any cast, a `for`, and a
 * condition split across lines.
 */
export const addressRunBound: Check = {
  id: 'address-run-bound',
  blurb: "loop bound spelled as another global's address - runs away after relinking",
  run(ctx) {
    const out: Finding[] = [];
    const loopKinds = [NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt];
    for (const fn of ctx.tree.functions) {
      for (const k of loopKinds) {
        for (const loop of ctx.of(fn, k)) {
          if (!loop.condition) continue;
          walk(loop.condition, (n: any) => {
            if (n.kind !== NodeKind.BinaryExpr || !RELATIONAL.has(n.operator)) return;
            for (const side of [n.left, n.right]) {
              const name = addressOfName(side);
              if (!name) continue;
              const r = ctx.resolve(fn, strip(strip(side).operand));
              if (!isGlobalObject(r)) continue;
              out.push({
                check: this.id, file: fn.file.path, line: line(n), fn: fn.qualifiedName, subject: name,
                detail: `loop bound is the address of '${name}' - breaks when relinked`, sig: signature(n),
              });
            }
          });
        }
      }
    }
    return out;
  },
};

