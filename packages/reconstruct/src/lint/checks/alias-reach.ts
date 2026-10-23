/**
 * A local pointer that aliases a stack local and then reaches outside it.
 *
 * The shape one stack object leaves when Ghidra splits it into several locals: the code
 * takes the address of the first piece into a pointer and walks the WHOLE object through
 * it. FOG_ParseBinField's 280 field-hash nodes (12 bytes each) were split into
 * `int aFieldHashNodesHead[2]` and `int aFieldHashNodes[838]`; the loop did
 *
 *     pHashNodeSlot = aFieldHashNodesHead;
 *     do { pHashNodeSlot[1] = h; pHashNodeSlot[2] = f; *pHashNodeSlot = b; pHashNodeSlot += 3; } while (...);
 *
 * which in the original fills one contiguous array and in the rebuild writes across
 * whatever the compiler put after an 8-byte local - aHashBuckets, there. oob-local-access
 * sees only a constant index on the array's own name; this check follows the alias.
 *
 * For each pointer local, every assignment whose value is the address of a stack local
 * (`p = buf`, `p = &x`, `p = &a[2]`, `p = (int *)((char *)&s + 8)`) starts a segment, and
 * every mention of the pointer up to its next assignment is a use. A use's reach is asked
 * of the same per-pointer machinery the frame-group run rule uses for parameters
 * (cpp-parser transform/cfg/param-reach.ts), in partial mode: a use it cannot follow (a
 * variable index, an unknown callee, a store of the pointer) adds nothing. Steps
 * (`p += 3`, `p++`, `p = p - 1`) move the pointer by a constant number of bytes:
 *   - a step textually before the use is always taken;
 *   - a step that shares a loop with the use (a loop that does not also re-assign the
 *     pointer) is taken from the second iteration on, so one more step is counted.
 * So the reported range is a LOWER bound - trip counts are not modelled - and a finding
 * means the alias provably touches bytes outside `[0, sizeof local)` when the loop runs
 * at least twice. Parameters are not roots: walking past `&param` is the varargs class.
 */

import { NodeKind, getChildren, type ASTNode } from '@ghidra-mcp/cpp-parser';
import { paramReaches, type ParamReachContext, type ReachField } from '@ghidra-mcp/cpp-parser/transform/cfg/index';
import {
  PRIMITIVE_WIDTH, elementType, isArrayType, isPointerType, line, refName, signature, typeRefName, typeText,
  typeWidth, unparen,
} from '../ast.js';
import type { Check, Finding, LintContext } from '../context.js';
import type { FunctionInfo } from '../tree.js';
import type { Snapshot } from '../snapshot.js';

export const ALIAS_REACH_CHECK_ID = 'alias-reach';

const LOOPS = new Set<string>([NodeKind.ForStmt, NodeKind.WhileStmt, NodeKind.DoWhileStmt]);
const CASTS = new Set<string>([NodeKind.CStyleCastExpr, NodeKind.StaticCastExpr, NodeKind.ReinterpretCastExpr]);

/** Integer spellings a cast or declaration may use that PRIMITIVE_WIDTH lists under another name. */
const SPELLING_ALIASES: Record<string, string> = {
  'short int': 'short', 'unsigned short int': 'unsigned short', 'signed short': 'short',
  'long int': 'long', 'unsigned long int': 'unsigned long', 'signed long': 'long',
  'signed int': 'int', signed: 'int', unsigned: 'unsigned int',
  'long long int': 'long long', 'unsigned long long int': 'unsigned long long',
};

/** Byte size of a type as spelled (`int`, `uint32_t *`, `::D2::D2UnitStrc`), or null. */
export function spelledSize(spelling: string, snapshot: Snapshot | null): number | null {
  let s = spelling.replace(/\b(const|volatile|struct|union|class|enum)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.endsWith('*')) return 4;
  s = s.replace(/^::/, '');
  const base = s.includes('::') ? s.split('::').pop()! : s;
  const prim = SPELLING_ALIASES[base] ?? base;
  if (PRIMITIVE_WIDTH[prim] !== undefined) return PRIMITIVE_WIDTH[prim];
  return snapshot?.typeSize.get(base) ?? null;
}

/** The pointer machinery's view of the model: sizes and fields from the snapshot, no callees. */
function reachContext(snapshot: Snapshot | null): ParamReachContext {
  let fields: Map<string, Map<string, ReachField> | null> | null = null;
  return {
    typeSize: (s) => spelledSize(s, snapshot),
    field: (aggregate, member) => {
      if (!fields) {
        fields = new Map();
        for (const st of snapshot?.structs ?? []) {
          const t = new Map<string, ReachField>();
          for (const f of st.fields) {
            if (f.name && typeof f.offset === 'number' && f.dataType) t.set(f.name, { offset: f.offset, type: f.dataType });
          }
          // Two structs of one name that disagree are no answer.
          fields.set(st.name, fields.has(st.name) ? null : t);
        }
      }
      return fields.get(aggregate)?.get(member) ?? null;
    },
    // Lower bound: a use passed to a callee adds nothing unless it is a counted sink (memset).
    calleeReach: () => null,
  };
}

/** A stack local the address points into: its name, the byte offset, and the pointee size for `+ k`. */
interface Derived { root: string; off: number; scale: number | null }

interface Seg { def: ASTNode; base: Derived | null }

export const aliasReach: Check = {
  id: ALIAS_REACH_CHECK_ID,
  blurb: 'local pointer aliasing a stack local walks outside it - one stack object Ghidra split into several locals',
  run(ctx) {
    const out: Finding[] = [];
    const rctx = reachContext(ctx.snapshot);
    for (const fn of ctx.tree.functions) out.push(...checkFunction(ctx, rctx, fn));
    return out;
  },
};

function checkFunction(ctx: LintContext, rctx: ParamReachContext, fn: FunctionInfo): Finding[] {
  const scope = fn.scope();
  const pointers = [...scope.values()].filter(e => e.kind === 'local' && !e.isStatic && isPointerType(e.type));
  if (!pointers.length) return [];
  const body = (fn.node as any).body;
  if (!body) return [];

  // Pre-order numbering with the subtree's last index, and parent links.
  const start = new Map<ASTNode, number>();
  const end = new Map<ASTNode, number>();
  const parent = new Map<ASTNode, ASTNode | null>();
  let counter = 0;
  const number = (n: ASTNode, p: ASTNode | null): void => {
    const stack: Array<[ASTNode, ASTNode | null, boolean]> = [[n, p, false]];
    while (stack.length) {
      const [x, px, done] = stack.pop()!;
      if (done) { end.set(x, counter - 1); continue; }
      if (!x || typeof x !== 'object') continue;
      start.set(x, counter++);
      parent.set(x, px);
      stack.push([x, px, true]);
      if (x.kind === NodeKind.StructDecl || x.kind === NodeKind.ClassDecl || x.kind === NodeKind.UnionDecl) continue;
      const kids = getChildren(x);
      for (let i = kids.length - 1; i >= 0; i--) if (kids[i]) stack.push([kids[i], x, false]);
    }
  };
  number(body, null);

  const localWidth = (name: string): number | null => {
    const e = scope.get(name);
    if (!e || e.kind !== 'local' || e.isStatic) return null;
    return typeWidth(e.type, ctx.sizeEnv);
  };
  const value = (e: any): number | null => ctx.value(fn, e);

  /** `x`, `a[k]`, `s.f` as a place inside a stack local: root, byte offset, type. */
  const place = (e: any): { root: string; off: number; type: any } | null => {
    const x = unparen(e);
    const name = refName(x);
    if (name) {
      const ent = scope.get(name);
      if (!ent || ent.kind !== 'local' || ent.isStatic || localWidth(name) === null) return null;
      return { root: name, off: 0, type: ent.type };
    }
    if (x?.kind === NodeKind.SubscriptExpr) {
      const b = place(x.array);
      if (!b || !isArrayType(b.type)) return null;
      const k = value(x.index);
      const w = typeWidth(elementType(b.type), ctx.sizeEnv);
      if (k === null || w === null) return null;
      return { root: b.root, off: b.off + k * w, type: elementType(b.type) };
    }
    if (x?.kind === NodeKind.MemberExpr && !x.isArrow) {
      const b = place(x.object);
      const agg = b && typeRefName(b.type);
      const member = refName(x.member);
      if (!b || !agg || !member) return null;
      const f = rctx.field(agg, member);
      return f ? { root: b.root, off: b.off + f.offset, type: null } : null;
    }
    return null;
  };

  /** The value of an address expression, when it points into a stack local at a constant offset. */
  const derive = (e: any): Derived | null => {
    const x = unparen(e);
    if (!x) return null;
    const name = refName(x);
    if (name) {
      const ent = scope.get(name);
      if (!ent || !isArrayType(ent.type)) return null;          // only an array name decays to an address
      const p = place(x);
      return p ? { root: p.root, off: 0, scale: typeWidth(elementType(ent.type), ctx.sizeEnv) } : null;
    }
    if (x.kind === NodeKind.UnaryExpr && x.operator === '&') {
      const p = place(x.operand);
      return p ? { root: p.root, off: p.off, scale: p.type ? typeWidth(p.type, ctx.sizeEnv) : null } : null;
    }
    if (x.kind === NodeKind.SubscriptExpr || x.kind === NodeKind.MemberExpr) {
      // An array-typed place decays (`s.aBuf`, `grid[1]`).
      const p = place(x);
      return p && p.type && isArrayType(p.type)
        ? { root: p.root, off: p.off, scale: typeWidth(elementType(p.type), ctx.sizeEnv) } : null;
    }
    if (CASTS.has(x.kind)) {
      const d = derive(x.expression);
      if (!d) return null;
      if (isPointerType(x.type)) return { ...d, scale: typeWidth(elementType(x.type), ctx.sizeEnv) };
      return typeWidth(x.type, ctx.sizeEnv) === 4 ? { ...d, scale: 1 } : null;
    }
    if (x.kind === NodeKind.BinaryExpr && (x.operator === '+' || x.operator === '-')) {
      const lv = value(x.left);
      const d = derive(lv !== null && x.operator === '+' ? x.right : x.left);
      const k = lv !== null && x.operator === '+' ? lv : value(x.right);
      if (!d || k === null || d.scale === null) return null;
      return { ...d, off: d.off + (x.operator === '+' ? k : -k) * d.scale };
    }
    return null;
  };

  const loopsOf = (n: ASTNode): ASTNode[] => {
    const ls: ASTNode[] = [];
    for (let p = parent.get(n); p; p = parent.get(p) ?? null) if (LOOPS.has(p.kind)) ls.push(p);
    return ls;
  };
  const inside = (outer: ASTNode, n: ASTNode): boolean =>
    start.get(n)! >= start.get(outer)! && start.get(n)! <= end.get(outer)!;

  const out: Finding[] = [];
  for (const ptr of pointers) {
    const name = ptr.name;
    const pointeeSize = spelledSize(typeText(elementType(ptr.type)), ctx.snapshot);
    const isName = (n: any) => n?.kind === NodeKind.Identifier && n.name === name;

    // Classify every mention: definitions, steps, and the rest (uses).
    const defs: Seg[] = [];
    const steps: Array<{ node: ASTNode; bytes: number }> = [];
    const modelled = new Set<ASTNode>();
    walkNodes(body, (n) => {
      if (n.kind === NodeKind.VariableDecl && refName((n as any).name) === name && (n as any).initializer) {
        defs.push({ def: n, base: derive(initValue((n as any).initializer)) });
        modelled.add((n as any).name);
        return;
      }
      if (n.kind === NodeKind.AssignExpr && isName(unparen((n as any).left))) {
        const lhs = unparen((n as any).left);
        const op = (n as any).operator;
        const rhs = (n as any).right;
        modelled.add(lhs);
        const k = value(rhs);
        if ((op === '+=' || op === '-=') && k !== null && pointeeSize !== null) {
          steps.push({ node: n, bytes: (op === '+=' ? k : -k) * pointeeSize });
          return;
        }
        if (op === '=') {
          const r = unparen(rhs);
          if (r?.kind === NodeKind.BinaryExpr && (r.operator === '+' || r.operator === '-') && isName(unparen(r.left))) {
            const kk = value(r.right);
            if (kk !== null && pointeeSize !== null) {
              modelled.add(unparen(r.left));
              steps.push({ node: n, bytes: (r.operator === '+' ? kk : -kk) * pointeeSize });
              return;
            }
          }
          defs.push({ def: n, base: derive(rhs) });
          return;
        }
        defs.push({ def: n, base: null });                       // `p += n`, `p |= ...`: lost track
        return;
      }
      if ((n.kind === NodeKind.PostfixExpr || n.kind === NodeKind.UnaryExpr)
          && ((n as any).operator === '++' || (n as any).operator === '--') && isName(unparen((n as any).operand))) {
        modelled.add(unparen((n as any).operand));
        if (pointeeSize !== null) steps.push({ node: n, bytes: ((n as any).operator === '++' ? 1 : -1) * pointeeSize });
        else defs.push({ def: n, base: null });
      }
    });
    if (!defs.some(d => d.base)) continue;
    defs.sort((a, b) => start.get(a.def)! - start.get(b.def)!);

    // The segment a node belongs to: the last definition COMPLETED before it.
    const segOf = (n: ASTNode): Seg | null => {
      const s = start.get(n)!;
      let found: Seg | null = null;
      for (const d of defs) if (end.get(d.def)! < s) found = d;
      return found;
    };

    // Per use, the range it touches relative to the pointer's current value.
    const uses: Array<{ node: ASTNode; lo: number; hi: number }> = [];
    paramReaches(body, [{ name, type: typeText(ptr.type) }], rctx, {
      partial: true,
      include: (u) => !modelled.has(u),
      onUse: (u, r) => { if (r && r.hi > r.lo) uses.push({ node: u, lo: r.lo, hi: r.hi }); },
    });

    // Per root local, the widest provable extent and the use that set it.
    const byRoot = new Map<string, { lo: number; hi: number; site: ASTNode; base: Derived; walked: number; worst: number }>();
    for (const u of uses) {
      const seg = segOf(u.node);
      if (!seg?.base) continue;
      let always = 0;
      let looped = 0;
      const uLoops = loopsOf(u.node).filter(l => !inside(l, seg.def));
      for (const s of steps) {
        if (segOf(s.node) !== seg) continue;
        const shared = uLoops.some(l => inside(l, s.node));
        if (end.get(s.node)! < start.get(u.node)!) always += s.bytes;
        if (shared) looped += s.bytes;
      }
      const lo = seg.base.off + always + Math.min(0, looped) + u.lo;
      const hi = seg.base.off + always + Math.max(0, looped) + u.hi;
      // The union over the root's uses; the site is the use that leaves it furthest.
      const prev = byRoot.get(seg.base.root);
      const width = localWidth(seg.base.root)!;
      const excess = (a: { lo: number; hi: number }) => Math.max(0, -a.lo) + Math.max(0, a.hi - width);
      if (!prev) {
        byRoot.set(seg.base.root, { lo, hi, site: u.node, base: seg.base, walked: Math.abs(looped), worst: excess({ lo, hi }) });
        continue;
      }
      if (excess({ lo, hi }) > prev.worst) {
        prev.site = u.node; prev.base = seg.base; prev.worst = excess({ lo, hi });
      }
      prev.lo = Math.min(prev.lo, lo);
      prev.hi = Math.max(prev.hi, hi);
      prev.walked = Math.max(prev.walked, Math.abs(looped));
    }
    for (const [root, r] of byRoot) {
      const width = localWidth(root)!;
      if (r.lo >= 0 && r.hi <= width) continue;
      const ent = scope.get(root)!;
      const at = r.base.off ? ` + ${r.base.off}` : '';
      const walk = r.walked ? `, stepping ${r.walked} bytes a loop iteration` : '';
      out.push({
        check: ALIAS_REACH_CHECK_ID, file: fn.file.path, line: line(r.site), fn: fn.qualifiedName, subject: root,
        detail: `${name} = &${root}${at} reaches [${r.lo}, ${r.hi}) of ${root} (${typeText(ent.type)} = ${width} bytes)${walk}`,
        sig: `${name}->${root}#${signature(r.site.kind === NodeKind.Identifier ? (parent.get(r.site) ?? r.site) : r.site)}`,
      });
    }
  }
  return out;
}

/** `T x = e` and `T x(e)` / `T x{e}`: the initialising expression. */
function initValue(init: any): any {
  if (!init) return null;
  if (init.kind === NodeKind.InitListExpr) return init.elements?.length === 1 ? init.elements[0] : null;
  return init;
}

function walkNodes(root: ASTNode, visit: (n: ASTNode) => void): void {
  const stack: ASTNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (!n || typeof n !== 'object') continue;
    if (n.kind === NodeKind.StructDecl || n.kind === NodeKind.ClassDecl || n.kind === NodeKind.UnionDecl) continue;
    visit(n);
    const kids = getChildren(n);
    for (let i = kids.length - 1; i >= 0; i--) if (kids[i]) stack.push(kids[i]);
  }
}
