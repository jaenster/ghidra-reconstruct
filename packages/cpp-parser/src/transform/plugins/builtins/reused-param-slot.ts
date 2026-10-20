/**
 * Reused Parameter Slot Plugin
 *
 * MSVC reuses a dead incoming-argument slot as storage for a local. In
 * AITHINK_Fn1_NpcOutOfTown (005e7880) the slot of `pAiParam` ([EBP+8]) holds a
 * function pointer once the parameter is no longer needed:
 *
 *   5e7940  MOV [EBP+8], 0x5944f0          ; Q04_InitializeTristramObjects
 *   5e794e  MOV [EBP+8], 0x58a980          ; Q33_StartAnyaRescuePhase (Anya)
 *   5e799d  MOV EDX,ESI; MOV ECX,EBX; CALL [EBP+8]
 *
 * A locked stack parameter is address-tied in the decompiler, so Ghidra cannot split
 * the two lifetimes and prints
 *
 *   pAiParam = (D2AiParamStrc *)Q04_InitializeTristramObjects;
 *   ...
 *   (*(code *)pAiParam)(pGame,pUnit);
 *
 * which calls through Ghidra's untyped `code` (cdecl, variadic). The source had a
 * local of the funcdef type, as the sibling AI_QuestNpc_InitializeQuestPhase still
 * shows. This pass gives it back that local:
 *
 *   fpGameMechanicQuest *pfnGameMechanicQuest;
 *   pfnGameMechanicQuest = Q04_InitializeTristramObjects;
 *   ...
 *   (*pfnGameMechanicQuest)(pGame,pUnit);
 *
 * Only when all of this is proven:
 *  - P is a parameter of pointer type whose address is never taken;
 *  - every write of P after entry is a statement `P = (T)F` with F a function the
 *    program names, and they all have one signature and one calling convention,
 *    which exactly one (non-auto_proto) funcdef Fn has as well;
 *  - by reaching definitions over the CFG, every read of P that any of those writes
 *    reaches is reached by nothing else, and is the callee of a call `(*(X)P)(...)`;
 *  - no read reached by the entry value (the real parameter) is reached by one of
 *    them, so the parameter keeps its own uses untouched.
 * Otherwise the site is left as Ghidra printed it.
 *
 * The local is named from the funcdef (`fp`/`pfn`/`fn` prefix dropped, `pfn` added),
 * since Ghidra has no slot to carry a name for it.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CompoundStmt, CStyleCastExpr, DeclStmt, ExprStmt, Expression,
  FunctionDecl, Identifier, ParameterDecl, Statement, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { Expr, Type, Decl, Stmt } from '../../../ast/factory.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { buildFunctionFlow, ENTRY_DEF } from '../../cfg/index.js';
import { calleeName, bareName, unwrapParens } from './call-arg-cast.js';

export interface ReusedParamSlotOptions extends PluginOptions {
  /** Function name (qualified and bare) → signature key. */
  functionSignatures?: Record<string, string>;
  /** Function name → Ghidra's calling convention. */
  functionConventions?: Record<string, string>;
  /** Funcdef name → signature key, in the same spelling. */
  funcdefSignatures?: Record<string, string>;
  /** Funcdef name → Ghidra's calling convention. */
  funcdefConventions?: Record<string, string>;
  /**
   * Function → the funcdefs the program stores it as elsewhere (a typed local, a
   * table). Settles which of several identical funcdefs the pointer had.
   */
  functionStoredAs?: Record<string, readonly string[]>;
  /** Receives one line per site it refused, for the run's report. */
  onRefused?: (fn: string, why: string) => void;
}

/** Anonymous call-site override funcdefs: never the source's type. */
const AUTO_PROTO = /^dt_[0-9a-f]{8}$/;

function lookup<T>(table: Record<string, T> | undefined, name: string): T | undefined {
  if (!table) return undefined;
  return table[name] ?? table[bareName(name)];
}

/** `(T)F` / `F` with F naming a function: F's spelling. */
function functionOperand(e: Expression, o: ReusedParamSlotOptions): { name: string; expr: Expression } | null {
  let x = unwrapParens(e);
  while (x.kind === NodeKind.CStyleCastExpr) x = unwrapParens((x as CStyleCastExpr).expression);
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '&') x = unwrapParens((x as UnaryExpr).operand);
  if (x.kind !== NodeKind.Identifier && x.kind !== NodeKind.QualifiedId) return null;
  const name = calleeName(x);
  if (!name || lookup(o.functionSignatures, name) === undefined) return null;
  return { name, expr: x };
}

/** `(*(X)P)` or `((X)P)` as a callee: true when it calls through P. */
function callsThrough(callee: Expression, p: string): boolean {
  let x = unwrapParens(callee);
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') x = unwrapParens((x as UnaryExpr).operand);
  while (x.kind === NodeKind.CStyleCastExpr) x = unwrapParens((x as CStyleCastExpr).expression);
  return x.kind === NodeKind.Identifier && (x as Identifier).name === p;
}

function localName(funcdef: string, taken: ReadonlySet<string>): string {
  const stem = funcdef.replace(/^(?:pfn|fp|fn|PFN_?)/, '');
  const base = `pfn${stem.charAt(0).toUpperCase()}${stem.slice(1)}`;
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  return name;
}

export function splitReusedParameterSlots(fn: FunctionDecl, o: ReusedParamSlotOptions): Statement[] | null {
  const body = fn.body as CompoundStmt | undefined;
  if (!body) return null;
  const params = fn.parameters.map(p => p as ParameterDecl).filter(p => p.name);
  const declared = new Set<string>(params.map(p => p.name!.name));
  for (const d of findNodesByKind(body, NodeKind.VariableDecl)) declared.add((d as VariableDecl).name.name);
  let statements = body.statements as Statement[];
  let changed = false;
  const fnName = (fn.name as { name?: string })?.name ?? '?';

  for (const param of params) {
    const p = param.name!.name;
    if (param.type.kind !== NodeKind.PointerType) continue;
    const flow = buildFunctionFlow(statements, declared);
    if (flow.isEscaped(p)) continue;

    // The writes: every node that writes P.
    const stores = new Map<number, { stmt: ExprStmt; fnName: string; fnExpr: Expression }>();
    let other = false;
    for (const n of flow.cfg.nodes) {
      if (!flow.writes(n.id).has(p)) continue;
      const st = n.stmt;
      const e = st && st.kind === NodeKind.ExprStmt ? unwrapParens((st as ExprStmt).expression) : null;
      const a = e && e.kind === NodeKind.AssignExpr ? e as AssignExpr : null;
      const left = a ? unwrapParens(a.left) : null;
      const f = a && a.operator === '=' && left?.kind === NodeKind.Identifier && (left as Identifier).name === p
        ? functionOperand(a.right, o) : null;
      if (!f) { other = true; continue; }
      stores.set(n.id, { stmt: st as ExprStmt, fnName: f.name, fnExpr: f.expr });
    }
    if (stores.size === 0) continue;
    if (other) { o.onRefused?.(fnName, `${p}: written by something other than a function address`); continue; }

    // One signature, one convention, one funcdef.
    const sigs = new Set([...stores.values()].map(s => lookup(o.functionSignatures, s.fnName)));
    const convs = new Set([...stores.values()].map(s => lookup(o.functionConventions, s.fnName) ?? ''));
    if (sigs.size !== 1 || convs.size !== 1) { o.onRefused?.(fnName, `${p}: the stored functions disagree`); continue; }
    const sig = [...sigs][0]!;
    const conv = [...convs][0]!;
    let funcdefs = Object.entries(o.funcdefSignatures ?? {})
      .filter(([name, s]) => s === sig && !AUTO_PROTO.test(name) && (o.funcdefConventions?.[name] ?? '') === conv)
      .map(([name]) => name);
    if (funcdefs.length > 1) {
      // Identical contracts: the one the program itself stores these functions as.
      // Every stored function must agree, and at least one must say.
      const said = new Set<string>();
      let conflict = false;
      for (const s of stores.values()) {
        const as = (lookup(o.functionStoredAs, s.fnName) ?? []).filter(x => funcdefs.includes(x));
        if (as.length > 1) conflict = true;
        for (const x of as) said.add(x);
      }
      if (!conflict && said.size === 1) funcdefs = [...said];
    }
    if (funcdefs.length !== 1) {
      o.onRefused?.(fnName, `${p}: ${funcdefs.length} funcdefs match ${conv} ${sig}`);
      continue;
    }
    const funcdef = funcdefs[0];

    // Every read reached by a store is a call through P, reached by stores alone; and no
    // read the parameter's own value reaches is reached by a store.
    const calls: CallExpr[] = [];
    let ok = true;
    for (const n of flow.cfg.nodes) {
      if (!flow.reads(n.id).has(p)) continue;
      const reach = [...flow.reaching(n.id, p)];
      const fromStores = reach.filter(r => stores.has(r));
      if (fromStores.length === 0) continue;
      if (fromStores.length !== reach.length || reach.includes(ENTRY_DEF)) { ok = false; break; }
      // Every occurrence of P in this node must be a call's callee.
      const exprs = flow.ownExprs(n.id);
      const ids: Identifier[] = [];
      const calleeIds = new Set<Identifier>();
      const walk = (x: unknown): void => {
        if (Array.isArray(x)) { for (const i of x) walk(i); return; }
        if (!x || typeof x !== 'object') return;
        const node = x as ASTNode;
        if (node.kind === NodeKind.Identifier && (node as Identifier).name === p) ids.push(node as Identifier);
        if (node.kind === NodeKind.CallExpr && callsThrough((node as CallExpr).callee, p)) {
          calls.push(node as CallExpr);
          for (const id of findNodesByKind((node as CallExpr).callee, NodeKind.Identifier)) {
            if ((id as Identifier).name === p) calleeIds.add(id as Identifier);
          }
        }
        for (const [k, v] of Object.entries(node)) {
          if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
          if (v && typeof v === 'object') walk(v);
        }
      };
      walk(exprs);
      if (ids.length === 0 || ids.some(id => !calleeIds.has(id))) { ok = false; break; }
    }
    if (!ok || calls.length === 0) {
      o.onRefused?.(fnName, `${p}: a read the stored function reaches is not a call through it`);
      continue;
    }

    const local = localName(funcdef, declared);
    declared.add(local);
    const storeStmts = new Map<object, { fnExpr: Expression }>();
    for (const s of stores.values()) storeStmts.set(s.stmt, s);
    const callSet = new Set<object>(calls);
    const rebuild = (x: unknown): unknown => {
      if (Array.isArray(x)) {
        let ch = false;
        const out = x.map(i => { const r = rebuild(i); if (r !== i) ch = true; return r; });
        return ch ? out : x;
      }
      if (!x || typeof x !== 'object') return x;
      const node = x as ASTNode;
      const store = storeStmts.get(node);
      if (store) {
        const st = node as ExprStmt;
        const a = unwrapParens(st.expression) as AssignExpr;
        return { ...st, expression: { ...a, left: Expr.identifier(local), right: store.fnExpr } };
      }
      if (callSet.has(node)) {
        const c = node as CallExpr;
        const args = rebuild(c.arguments) as Expression[];
        return { ...c, callee: Expr.paren(Expr.deref(Expr.identifier(local))), arguments: args };
      }
      let copy: Record<string, unknown> | null = null;
      for (const [k, v] of Object.entries(node)) {
        if (k === 'location' || !v || typeof v !== 'object') continue;
        const r = rebuild(v);
        if (r !== v) { copy = copy ?? { ...(node as object) } as Record<string, unknown>; copy[k] = r; }
      }
      return copy ?? x;
    };
    const rewritten = rebuild(statements) as Statement[];
    // The declaration goes after the leading declarations, where Ghidra lists its locals.
    const decl = Stmt.declStmt([Decl.variable(local, Type.pointer(Type.typedef(funcdef)) as TypeNode)]) as unknown as DeclStmt;
    let at = 0;
    while (at < rewritten.length && rewritten[at].kind === NodeKind.DeclStmt) at++;
    statements = [...rewritten.slice(0, at), decl as unknown as Statement, ...rewritten.slice(at)];
    changed = true;
  }
  return changed ? statements : null;
}

function createReusedParamSlotTransformer(options?: PluginOptions): Transformer {
  const given = (options ?? {}) as ReusedParamSlotOptions;
  const trace = typeof process !== 'undefined' && process.env?.REUSED_SLOT_TRACE === '1';
  const o: ReusedParamSlotOptions = trace && !given.onRefused
    ? { ...given, onRefused: (fn, why) => process.stderr.write(`[reused-param-slot] ${fn}: ${why}\n`) }
    : given;
  if (!o.functionSignatures || !o.funcdefSignatures) return (n: ASTNode) => n;
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const statements = splitReusedParameterSlots(fn, o);
      if (!statements) return undefined;
      return updateNode(fn, { body: { ...(fn.body as CompoundStmt), statements } } as Partial<FunctionDecl>);
    },
  });
}

export const reusedParamSlotPlugin: TransformPlugin = {
  id: 'reused-param-slot',
  name: 'Reused Parameter Slot',
  description:
    'A dead parameter slot MSVC reused for a function pointer -> a local of the funcdef type, proven by reaching definitions',
  version: '1.0.0',
  defaultEnabled: true,
  // Early, on Ghidra's own spelling: the new local is declared as Ghidra would have
  // declared it (`Fn *p`), and every later pass treats it like one Ghidra printed -
  // funcdef-cast-collapse (70) peels the star, call-site-override-cast (614) sees a
  // typed callee and leaves it alone.
  priority: 14,
  tags: ['correctness', 'type'],
  createTransformer: createReusedParamSlotTransformer,
};
