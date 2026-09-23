/**
 * Checks about GLOBAL objects: a global Ghidra sized too small for what the code does to it,
 * and addresses that only work while the original link order holds.
 */

import { NodeKind, getChildren, type ASTNode } from '@ghidra-mcp/cpp-parser';
import {
  addressOfName, calleeName, isArrayType, isPointerType, line, primitiveName,
  refName, signature, strip, typeText, typeWidth, unparen, walk,
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

/**
 * A string constant modelled as a one-byte (or one-int) scalar, so relinking keeps only its
 * first character. `gaLanguageCodeAbbrevTable` is "ENG\0" typed undefined1; relinked, the
 * game built `data\local\lng\E\string.tbl` and faulted on the NULL load.
 *
 * The signal is a contradiction the AST states directly: a CAST to `char *` whose operand is
 * the address of a global of primitive scalar type, used as a pointer rather than
 * dereferenced on the spot. The regex also fired on a local or parameter that shares a
 * global's name (nPosX, nPosY, nScreenMode) and on sized stores like
 * `*(uint16_t *)(char *)&gnUICtrlConfigPendingKeyStrId = v`, which write the scalar and read
 * no string; name resolution and the dereference rule the AST can see rule both out.
 */
export const truncatedStringGlobal: Check = {
  id: 'truncated-string-global',
  blurb: 'string constant modelled as a scalar - only its first char survives relinking',
  run(ctx) {
    const hits = new Map<string, { sites: Array<{ file: string; line: number }>; ty: string }>();
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
    for (const { node: n, fn, file } of sites) {
      if (n.kind !== NodeKind.CStyleCastExpr && n.kind !== NodeKind.ReinterpretCastExpr) continue;
      if (!isCharPointer(n.type) || dereferenced.has(n)) continue;
      const op = unparen(n.expression);
      if (op?.kind !== NodeKind.UnaryExpr || op.operator !== '&') continue;
      const target = unparen(op.operand);
      const r = ctx.resolve(fn, target, file);
      if (!r || r.kind !== 'global') continue;
      if (isArrayType(r.type) || isPointerType(r.type)) continue;
      const p = primitiveName(r.type);
      if (!p || !STRINGISH_SCALARS.has(p)) continue;
      const name = r.decl.name;
      let h = hits.get(name);
      if (!h) hits.set(name, (h = { sites: [], ty: typeText(r.type) }));
      h.sites.push({ file: file.path, line: line(n) });
    }
    return [...hits].map(([name, h]) => ({
      check: this.id, subject: name,
      detail: `${h.sites.length} char* cast(s), declared ${h.ty} (${h.sites[0].file}:${h.sites[0].line})`,
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

