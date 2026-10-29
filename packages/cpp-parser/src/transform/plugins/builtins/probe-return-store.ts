/**
 * Probe Return Store Plugin
 *
 * A function with a large frame calls the stack probe (`__alloca_probe`, or `__SEH_prolog4`
 * for an EH4 frame) before its body. The probe runs on the frame it is allocating, so the
 * CALL's return address lands in the slot that becomes the frame's top local, and the
 * decompiler prints the CALL's push as a store into that local:
 *
 *     nNameColor = 0x454add;            aFrames[0x7f].a14[3] = 0x40307d;
 *     uint32_t dwSehHandlerAddr = 0x517c3f;
 *
 * The source never wrote it: the local is uninitialised there. The store is dropped (an
 * initialiser becomes a bare declaration) when its value is exactly the return address of
 * one of the function's probe CALLs and the target is the function's own local.
 *
 * Only where nothing can read the value: every path from the store overwrites the variable
 * whole before reading it, or leaves the function (store-liveness.ts). A store that may be
 * read is kept and reported.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, CompoundStmt, ExprStmt, DeclStmt, VariableDecl, Statement,
  Expression, AssignExpr, Identifier, ParenExpr, CStyleCastExpr, IntegerLiteralExpr,
  MemberExpr, SubscriptExpr, UnaryExpr, ParameterDecl, AnyNode,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { storeIsDead } from './store-liveness.js';

export interface ProbeReturnStoreOptions extends PluginOptions {
  /** Absolute return addresses of the function's stack-probe CALLs. */
  returnAddresses?: readonly number[];
  /** Each store recognised: dropped, or kept with the reason. */
  onSite?: (e: { value: number; kept?: string }) => void;
}

/** The integer a literal holds, through casts and parentheses. */
function constValue(e: Expression): number | null {
  let cur = e;
  while (cur.kind === NodeKind.ParenExpr || cur.kind === NodeKind.CStyleCastExpr) {
    cur = cur.kind === NodeKind.ParenExpr
      ? (cur as ParenExpr).expression
      : (cur as CStyleCastExpr).expression;
  }
  return cur.kind === NodeKind.IntegerLiteral ? Number((cur as IntegerLiteralExpr).value) : null;
}

/**
 * The local an lvalue is part of: `v`, `v.f`, `v[i]`, `v.a[3].b`, or a cast of the address
 * of one of those dereferenced (`*(uint32_t *)((char *)&v[0xff].d + 4)`). Null when the
 * store goes through a pointer the function does not own.
 */
function rootLocal(lv: Expression): string | null {
  let cur: Expression = lv;
  let viaAddress = false;
  for (;;) {
    switch (cur.kind) {
      case NodeKind.Identifier:
        return (cur as Identifier).name;
      case NodeKind.MemberExpr:
        if ((cur as MemberExpr).isArrow) return null;
        cur = (cur as MemberExpr).object;
        break;
      case NodeKind.SubscriptExpr: {
        const base = (cur as SubscriptExpr).array;
        cur = base;
        break;
      }
      case NodeKind.ParenExpr:
        cur = (cur as ParenExpr).expression;
        break;
      case NodeKind.CStyleCastExpr:
        if (!viaAddress) return null;
        cur = (cur as CStyleCastExpr).expression;
        break;
      case NodeKind.UnaryExpr: {
        const u = cur as UnaryExpr;
        if (u.operator === '*' && !viaAddress) { viaAddress = true; cur = u.operand; break; }
        if (u.operator === '&' && viaAddress) { cur = u.operand; break; }
        return null;
      }
      case NodeKind.BinaryExpr: {
        // `(char *)&v + 4`: an offset into the same local.
        const b = cur as unknown as { operator: string; left: Expression; right: Expression };
        if (!viaAddress || (b.operator !== '+' && b.operator !== '-') || constValue(b.right) === null) return null;
        cur = b.left;
        break;
      }
      default:
        return null;
    }
  }
}

interface Site {
  block: CompoundStmt;
  index: number;
  value: number;
  root: string;
  /** The store's target, spelled out: a whole variable when it equals `root`. */
  target: string;
  decl: boolean;
}

function rewriteFunction(fn: FunctionDecl, probes: ReadonlySet<number>, onSite: ProbeReturnStoreOptions['onSite']): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const body = fn.body;

  // The function's own locals: declared in its body and not a parameter.
  const locals = new Set<string>();
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      if (!v.specifiers.some(sp => (sp as string) === 'static' || (sp as string) === 'extern')) locals.add(v.name.name);
    }
  }
  for (const p of fn.parameters as ParameterDecl[]) {
    const nm = (p.name as Identifier | undefined)?.name;
    if (nm) locals.delete(nm);
  }

  const sites: Site[] = [];
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.CompoundStmt) continue;
    const block = n as CompoundStmt;
    block.statements.forEach((s, index) => {
      if (s.kind === NodeKind.ExprStmt) {
        const e = (s as ExprStmt).expression;
        if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return;
        const a = e as AssignExpr;
        const value = constValue(a.right);
        if (value === null || !probes.has(value)) return;
        const root = rootLocal(a.left);
        if (root === null || !locals.has(root)) return;
        sites.push({ block, index, value, root, target: a.left.kind === NodeKind.Identifier ? root : emit(a.left as unknown as AnyNode), decl: false });
      } else if (s.kind === NodeKind.DeclStmt) {
        const d = s as DeclStmt;
        if (d.declarations.length !== 1 || d.declarations[0].kind !== NodeKind.VariableDecl) return;
        const v = d.declarations[0] as VariableDecl;
        if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr) return;
        const value = constValue(v.initializer as Expression);
        if (value === null || !probes.has(value) || !locals.has(v.name.name)) return;
        sites.push({ block, index, value, root: v.name.name, target: v.name.name, decl: true });
      }
    });
  }
  if (sites.length === 0) return undefined;

  const drop = new Map<CompoundStmt, Map<number, Statement | null>>();
  for (const site of sites) {
    const kept = readReason(body, site);
    onSite?.(kept ? { value: site.value, kept } : { value: site.value });
    if (kept) continue;
    let m = drop.get(site.block);
    if (!m) { m = new Map(); drop.set(site.block, m); }
    if (site.decl) {
      const d = site.block.statements[site.index] as DeclStmt;
      const v = d.declarations[0] as VariableDecl;
      m.set(site.index, updateNode(d, {
        declarations: [updateNode(v, { initializer: undefined } as Partial<VariableDecl>)],
      } as Partial<DeclStmt>));
    } else {
      m.set(site.index, null);
    }
  }
  if (drop.size === 0) return undefined;

  // The blocks are found again by identity before anything below them is rebuilt.
  const rebuilt = new Map<CompoundStmt, CompoundStmt>();
  for (const [block, m] of drop) {
    const statements: Statement[] = [];
    block.statements.forEach((s, i) => {
      if (!m.has(i)) { statements.push(s); return; }
      const r = m.get(i);
      if (r) statements.push(r);
    });
    rebuilt.set(block, updateNode(block, { statements } as Partial<CompoundStmt>));
  }
  return updateNode(fn, { body: replaceBlocks(body, rebuilt) as CompoundStmt } as Partial<FunctionDecl>);
}

/**
 * Why the stored value might be read, or null when nothing can: every path from the store
 * overwrites the variable whole first (store-liveness.ts). A store into part of a variable
 * needs the part itself never to be spelled anywhere else.
 */
function readReason(body: CompoundStmt, site: Site): string | null {
  const own = site.block.statements[site.index];
  if (site.target !== site.root) {
    let others = 0;
    for (const n of traverseAST(body)) {
      if (n === own) continue;
      if ((n.kind === NodeKind.MemberExpr || n.kind === NodeKind.SubscriptExpr || n.kind === NodeKind.UnaryExpr)
          && emit(n as unknown as AnyNode) === site.target) others++;
    }
    // The store's own target is one of the spellings found.
    return others > 1 ? `${site.target} is read elsewhere` : null;
  }
  return storeIsDead(body, site.block, site.index, site.root) ? null : `${site.root} is read later`;
}

/** `root` with each block in `rebuilt` swapped in, found by identity. */
function replaceBlocks(root: ASTNode, rebuilt: ReadonlyMap<CompoundStmt, CompoundStmt>): ASTNode {
  const go = (n: ASTNode): ASTNode => {
    const r = rebuilt.get(n as CompoundStmt);
    const base = r ?? n;
    let changed = r !== undefined;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(base)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (Array.isArray(v)) {
        let c = false;
        const out = v.map(x => {
          if (!x || typeof x !== 'object' || typeof (x as ASTNode).kind !== 'string') return x;
          const y = go(x as ASTNode);
          if (y !== x) c = true;
          return y;
        });
        if (c) { patch[k] = out; changed = true; }
      } else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') {
        const y = go(v as ASTNode);
        if (y !== v) { patch[k] = y; changed = true; }
      }
    }
    if (!changed) return n;
    return Object.keys(patch).length > 0 ? updateNode(base, patch as Partial<ASTNode>) : base;
  };
  return go(root);
}

function createProbeReturnStoreTransformer(options: ProbeReturnStoreOptions = {}): Transformer {
  const probes = new Set(options.returnAddresses ?? []);
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (probes.size === 0) return undefined;
      return rewriteFunction(node, probes, options.onSite);
    },
  });
}

export const probeReturnStorePlugin: TransformPlugin = {
  id: 'probe-return-store',
  name: 'Probe Return Store',
  description: "Drops the store of a stack probe CALL's return address into the frame's top local",
  version: '1.0.0',
  defaultEnabled: true,
  // First: before declarations merge with their stores (60) and before any pass reads the
  // constant as an address.
  priority: 12,
  tags: ['cleanup', 'fidelity'],
  createTransformer: createProbeReturnStoreTransformer,
};
