/**
 * Loop Copy Sink Plugin
 *
 * A loop that walks a list keeps the next element in a second variable and steps at the
 * end of the body. ITEMMODE_RecalcAllEquippedStats (0055f500) steps there in the original:
 *
 *   55f570  TEST EDI,EDI        ; pNextItem
 *   55f572  MOV ESI,EDI         ; pCurItem = pNextItem, the last instruction of the body
 *   55f574  JNZ 0x55f530
 *
 * The decompiler places the copy of a loop-carried value right after the old value's last
 * read instead, in the middle of the body:
 *
 *   while (pCurItem) {
 *     pNextItem = INVENTORY_GetNextItem(pCurItem);
 *     pCarriedItem = GetCarriedItem(pCurItem);
 *     pCurItem = pNextItem;                      <- here
 *     if (pCarriedItem && ...) { ... }
 *   }
 *
 * Both variables are then live across the rest of the body, so VC8 needs one more
 * callee-saved register than it has and homes a value on the stack: `sub esp,0x24` where
 * the original has 0x20. The copy goes back to the end of the body:
 *
 *   while (pCurItem) {
 *     pNextItem = INVENTORY_GetNextItem(pCurItem);
 *     pCarriedItem = GetCarriedItem(pCurItem);
 *     if (pCarriedItem && ...) { ... }
 *     pCurItem = pNextItem;
 *   }
 *
 * Moved only when this is proven, for a statement `a = b;` directly in the body of a
 * while, do-while or for loop whose condition reads `a`:
 *  - a and b are distinct locals or parameters of one declared type, declared once, whose
 *    address is never taken;
 *  - nothing after the copy in the body names a;
 *  - nothing after it can leave the body other than by its end or a return: no break or
 *    continue of this loop, no goto, no label;
 *  - nothing after it writes b, or every value written to b after it is a life of its own
 *    (by reaching definitions: every read of b after the copy sees only those writes, and
 *    they reach no read outside that span). Such a life gets a variable of its own,
 *    declared where the copy was, as the source had (0055f500 tests the owner unit
 *    SEVER_ITEM_GetOwner returns in EAX, never in pNextItem's register).
 * At the end of the body b still holds the value the copy read and a held its old value
 * until there with no reader, so every read sees what it saw before.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AnyNode, AssignExpr, CompoundStmt, DeclStmt, DoWhileStmt, ExprStmt, Expression, ForStmt,
  FunctionDecl, Identifier, ParameterDecl, Statement, TypeNode, VariableDecl, WhileStmt,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { Decl, Stmt } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { buildFunctionFlow, ENTRY_DEF, type FunctionFlow } from '../../cfg/index.js';

export interface LoopCopySinkOptions extends PluginOptions {}

type Loop = WhileStmt | DoWhileStmt | ForStmt;

function unwrap(e: Expression): Expression {
  let x = e;
  while (x.kind === NodeKind.ParenExpr) x = (x as unknown as { expression: Expression }).expression;
  return x;
}

/** The declared type of every local and parameter declared exactly once, by name. */
function declaredTypes(fn: FunctionDecl): Map<string, TypeNode> {
  const out = new Map<string, TypeNode>();
  const twice = new Set<string>();
  const add = (name: string, t: TypeNode) => {
    if (out.has(name)) twice.add(name);
    out.set(name, t);
  };
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) add(p.name.name, p.type);
  for (const x of traverseAST(fn.body!)) {
    if (x.kind !== NodeKind.DeclStmt) continue;
    for (const d of (x as DeclStmt).declarations) {
      if (d.kind === NodeKind.VariableDecl) add((d as VariableDecl).name.name, (d as VariableDecl).type);
    }
  }
  for (const n of twice) out.delete(n);
  return out;
}

/** `a = b;` with both sides bare identifiers, or null. */
function plainCopy(s: Statement): { a: string; b: string } | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const l = unwrap((e as AssignExpr).left), r = unwrap((e as AssignExpr).right);
  if (l.kind !== NodeKind.Identifier || r.kind !== NodeKind.Identifier) return null;
  const a = (l as Identifier).name, b = (r as Identifier).name;
  return a === b ? null : { a, b };
}

function names(n: ASTNode | null | undefined, v: string): boolean {
  if (!n) return false;
  for (const x of traverseAST(n)) if (x.kind === NodeKind.Identifier && (x as Identifier).name === v) return true;
  return false;
}

/**
 * Can control leave `stmts` other than by falling off their end or returning? A break or
 * continue that binds to an enclosing statement, any goto, any label.
 */
function leavesSideways(stmts: Statement[]): boolean {
  const walk = (n: ASTNode, inLoop: boolean, inSwitch: boolean): boolean => {
    switch (n.kind) {
      case NodeKind.GotoStmt:
      case NodeKind.LabelStmt:
        return true;
      case NodeKind.ContinueStmt:
        return !inLoop;
      case NodeKind.BreakStmt:
        return !inLoop && !inSwitch;
      default:
        break;
    }
    const loop = n.kind === NodeKind.WhileStmt || n.kind === NodeKind.DoWhileStmt
      || n.kind === NodeKind.ForStmt || n.kind === NodeKind.ForRangeStmt;
    const sw = n.kind === NodeKind.SwitchStmt;
    for (const c of children(n)) if (walk(c, inLoop || loop, inSwitch || sw)) return true;
    return false;
  };
  return stmts.some(s => walk(s, false, false));
}

function children(n: ASTNode): ASTNode[] {
  const out: ASTNode[] = [];
  for (const [k, v] of Object.entries(n)) {
    if (k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'loc' || k === 'range') continue;
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && 'kind' in x) out.push(x as ASTNode); }
    else if (v && typeof v === 'object' && 'kind' in v) out.push(v as ASTNode);
  }
  return out;
}

/** The graph nodes of every statement inside `stmts`, nested ones included. */
function nodesIn(stmts: Statement[], flow: FunctionFlow): Set<number> {
  const out = new Set<number>();
  for (const s of stmts) {
    for (const x of traverseAST(s)) {
      const id = flow.nodeOf(x as Statement);
      if (id !== undefined) out.add(id);
    }
  }
  return out;
}

/** Does any node of the span write b? */
function writes(flow: FunctionFlow, span: Set<number>, b: string): boolean {
  for (const id of span) if (flow.writes(id).has(b)) return true;
  return false;
}

/**
 * The values written to b inside `span` are lives of their own: every read in the span
 * sees only writes from the span, and those writes reach no read outside it.
 */
function ownLives(flow: FunctionFlow, span: Set<number>, b: string): boolean {
  const defs: number[] = [];
  for (const id of span) {
    if (!flow.writes(id).has(b)) continue;
    const d = flow.definition(id, b);
    if (!d || !d.killing) return false;
    defs.push(id);
  }
  for (const id of span) {
    if (!flow.reads(id).has(b)) continue;
    for (const r of flow.reaching(id, b)) if (r === ENTRY_DEF || !span.has(r)) return false;
  }
  for (const d of defs) for (const u of flow.usesOf(d, b)) if (!span.has(u)) return false;
  return defs.length > 0;
}

function freshName(fn: FunctionDecl, base: string): string {
  const used = new Set<string>();
  for (const x of traverseAST(fn)) if (x.kind === NodeKind.Identifier) used.add((x as Identifier).name);
  let n = `${base}2`;
  for (let k = 3; used.has(n); k++) n = `${base}${k}`;
  return n;
}

function rename<T extends ASTNode>(n: T, from: string, to: string): T {
  const visit = createTransformer({
    visitIdentifier(id: Identifier): ASTNode | undefined {
      return id.name === from ? updateNode(id, { name: to } as Partial<Identifier>) : undefined;
    },
  });
  return visit(n) as T;
}

interface Ctx {
  fn: FunctionDecl;
  types: Map<string, TypeNode>;
  flow: FunctionFlow | null;
  changed: boolean;
}

function flowOf(ctx: Ctx): FunctionFlow {
  if (!ctx.flow) ctx.flow = buildFunctionFlow(ctx.fn.body!.statements, new Set(ctx.types.keys()));
  return ctx.flow;
}

/** The loop's body rewritten, or null when no copy in it can move. */
function sinkIn(loop: Loop, ctx: Ctx): Statement[] | null {
  if (loop.body.kind !== NodeKind.CompoundStmt) return null;
  const list = (loop.body as CompoundStmt).statements;
  if (!loop.condition) return null;
  for (let k = 0; k < list.length - 1; k++) {
    const c = plainCopy(list[k]);
    if (!c || !names(loop.condition, c.a)) continue;
    const ta = ctx.types.get(c.a), tb = ctx.types.get(c.b);
    if (!ta || !tb || emit(ta as unknown as AnyNode) !== emit(tb as unknown as AnyNode)) continue;
    const rest = list.slice(k + 1);
    if (rest.some(s => names(s, c.a)) || leavesSideways(rest)) continue;
    const flow = flowOf(ctx);
    if (flow.isEscaped(c.a) || flow.isEscaped(c.b)) continue;
    const span = nodesIn(rest, flow);
    let moved = rest;
    let head: Statement[] = [];
    if (span.size === 0) continue;
    if (writes(flow, span, c.b)) {
      if (!ownLives(flow, span, c.b)) continue;
      const other = freshName(ctx.fn, c.b);
      moved = rest.map(s => rename(s, c.b, other));
      const decl = Decl.variable(other, cloneNode(tb) as TypeNode, null);
      head = [{ ...Stmt.declStmt([decl]), leadingTrivia: list[k].leadingTrivia } as Statement];
    }
    return [...list.slice(0, k), ...head, ...moved, list[k]];
  }
  return null;
}

/** `root` with `target` replaced, rebuilding only the nodes on the path to it. */
function replaceNode(root: ASTNode, target: ASTNode, replacement: ASTNode): ASTNode {
  if (root === target) return replacement;
  for (const [k, v] of Object.entries(root)) {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        if (!x || typeof x !== 'object' || !('kind' in x)) continue;
        const y = replaceNode(x as ASTNode, target, replacement);
        if (y !== x) {
          const arr = v.slice();
          arr[i] = y;
          return { ...root, [k]: arr } as ASTNode;
        }
      }
    } else if (v && typeof v === 'object' && 'kind' in v) {
      const y = replaceNode(v as ASTNode, target, replacement);
      if (y !== v) return { ...root, [k]: y } as ASTNode;
    }
  }
  return root;
}

function rewriteFunction(fn: FunctionDecl): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const ctx: Ctx = { fn, types: declaredTypes(fn), flow: null, changed: false };
  if (ctx.types.size < 2) return undefined;
  // One site per round: each rewrite changes the graph the next proof needs.
  for (let round = 0; round < 32; round++) {
    let site: { loop: Loop; body: Statement[] } | null = null;
    for (const x of traverseAST(ctx.fn.body!)) {
      if (x.kind !== NodeKind.WhileStmt && x.kind !== NodeKind.DoWhileStmt && x.kind !== NodeKind.ForStmt) continue;
      const out = sinkIn(x as Loop, ctx);
      if (out) { site = { loop: x as Loop, body: out }; break; }
    }
    if (!site) break;
    const loop = updateNode(site.loop, {
      body: updateNode(site.loop.body as CompoundStmt, { statements: site.body } as Partial<CompoundStmt>),
    } as Partial<Loop>);
    const body = replaceNode(ctx.fn.body!, site.loop, loop) as CompoundStmt;
    ctx.fn = updateNode(ctx.fn, { body } as Partial<FunctionDecl>);
    ctx.types = declaredTypes(ctx.fn);
    ctx.flow = null;
    ctx.changed = true;
  }
  return ctx.changed ? ctx.fn : undefined;
}

function createLoopCopySinkTransformer(_options: LoopCopySinkOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node);
    },
  });
}

export const loopCopySinkPlugin: TransformPlugin = {
  id: 'loop-copy-sink',
  name: 'Loop Copy Sink',
  description: 'A loop-carried copy the decompiler placed mid-body moves to the end of the loop body, where the original stepped',
  version: '1.0.0',
  defaultEnabled: true,
  // After decl-scope-sink (62) has put the loop's locals in its body, beside new-result-temp.
  priority: 62.7,
  tags: ['matching'],
  createTransformer: createLoopCopySinkTransformer,
};

export { createLoopCopySinkTransformer };
