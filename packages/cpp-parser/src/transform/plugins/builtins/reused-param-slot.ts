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
import { calleeName, bareName, unwrapParens, typeFromSpelling } from './call-arg-cast.js';
import { emit } from '../../../emit/index.js';

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
  /**
   * The enclosing function's parameters that live in a 4-byte STACK slot. Only those can
   * be reused by MSVC for a second value: a register parameter is not address-tied, so
   * the decompiler splits its lifetimes itself. Absent: the value split does not run.
   */
  stackParameters?: readonly string[];
  /** Callable name (bare AND qualified) -> declared return type, for a store's value type. */
  functionReturnTypes?: Record<string, string>;
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


// ── The value split ──────────────────────────────────────────────────────────
//
// The same compiler habit with a plain value. MSVC keeps a dead stack parameter's slot
// as storage for a later local of another type: HirelingFollowOwnerAction @005e3930
// keeps `UNITS_GetRoom(pOwner)` in the slot of `int nVelocity`, ITEM_RollSocketCount
// @0062bcb0 an inventory height in the slot of `D2UnitStrc *pUnit`. The decompiler
// cannot split a locked stack parameter, so it prints one variable of the parameter's
// type and casts on both sides:
//
//   nVelocity = (int32_t)D2Common::Units::Units::UNITS_GetRoom(pOwner);
//   ...((D2RoomStrc *)nVelocity, ...)
//
// The source had a second local. It is given back when all of this is proven:
//  - P is a 4-byte stack parameter whose address is never taken;
//  - every write of P is a statement `P = e`;
//  - by reaching definitions, every read any write reaches is reached by writes alone,
//    and no read of the entry value is reached by one;
//  - the second range has ONE type T: every read of it casts P to T, or (the reads
//    disagreeing or not casting) every write stores `(PT)x` with x evidently a T - a
//    cast, a callee's return type, a typed local;
//  - T is not PT and one of the two is a pointer (or both, to different types): an
//    integer reused as another integer is the same variable as far as C is concerned.
// The rewrite keeps every bit: the store keeps x (cast to T only where x is not
// evidently one), a `(T)P` read becomes the local, a bare read `(PT)local`.

/** Spellings of a 32-bit integer, Ghidra's and the tree's, by signedness. */
const WORD_INTEGERS: Readonly<Record<string, 'u' | 's'>> = {
  uint: 'u', uint32_t: 'u', DWORD: 'u', dword: 'u', ulong: 'u', UINT: 'u', undefined4: 'u', size_t: 'u', uintptr_t: 'u',
  int: 's', int32_t: 's', long: 's', LONG: 's', BOOL: 's', intptr_t: 's', 'unsigned int': 'u', 'unsigned long': 'u',
};

function spellingOf(t: TypeNode): string {
  try { return emit(t as never).replace(/\s+/g, ' ').replace(/\s*\*/g, '*').trim(); } catch { return ''; }
}

/** 'ptr' | 'int' | 'enum' | null, from a type's spelling; an unknown name is not guessed at. */
function wordClass(spelling: string): 'ptr' | 'int' | 'enum' | null {
  if (spelling.endsWith('*')) return 'ptr';
  if (WORD_INTEGERS[spelling]) return 'int';
  if (/^e[A-Z]\w*$/.test(spelling)) return 'enum';
  return null;
}

function sameType(a: string, b: string): boolean {
  if (a === b) return true;
  const ca = WORD_INTEGERS[a], cb = WORD_INTEGERS[b];
  return ca !== undefined && ca === cb;
}

/** Strip parens; one `(PT)x` cast to the parameter's own type comes off too. */
function storedValue(rhs: Expression, paramType: string): Expression {
  const x = unwrapParens(rhs);
  if (x.kind === NodeKind.CStyleCastExpr && sameType(spellingOf((x as CStyleCastExpr).type), paramType)) {
    return unwrapParens((x as CStyleCastExpr).expression);
  }
  return x;
}

/** The type an expression evidently has, or null. */
function evidentType(e: Expression, o: ReusedParamSlotOptions, localTypes: ReadonlyMap<string, TypeNode>): TypeNode | null {
  const x = unwrapParens(e);
  if (x.kind === NodeKind.CStyleCastExpr) return (x as CStyleCastExpr).type;
  if (x.kind === NodeKind.Identifier) return localTypes.get((x as Identifier).name) ?? null;
  if (x.kind === NodeKind.CallExpr) {
    const name = calleeName((x as CallExpr).callee);
    const rt = name ? lookup(o.functionReturnTypes, name) : undefined;
    return rt ? typeFromSpelling(rt) : null;
  }
  return null;
}

/**
 * A name for the second value. Ghidra has no variable to carry one, so it comes from
 * the type where the type is a program struct (`D2RoomStrc *` -> pRoom, `D2MissilesTxt *`
 * -> pMissilesTxt), and from the parameter whose slot it shares otherwise.
 */
function valueLocalName(type: string, param: string, taken: ReadonlySet<string>): string {
  const typed = /^(?:struct )?D2(\w+?)(?:Strc)?\*$/.exec(type);
  const stem = param.replace(/^(?:p+|n|dw|b|e|sz|w|by|f)(?=[A-Z])/, '');
  const cap = stem.charAt(0).toUpperCase() + stem.slice(1);
  const base = typed ? `p${typed[1]}` : type.endsWith('*') ? `p${cap}` : `n${cap}`;
  let name = base;
  for (let i = 2; taken.has(name) || name === param; i++) name = `${base}${i}`;
  return name;
}

export function splitReusedValueSlots(fn: FunctionDecl, o: ReusedParamSlotOptions, statementsIn?: Statement[]): Statement[] | null {
  const body = fn.body as CompoundStmt | undefined;
  if (!body || !o.stackParameters || o.stackParameters.length === 0) return null;
  const stackParams = new Set(o.stackParameters);
  const params = fn.parameters.map(p => p as ParameterDecl).filter(p => p.name);
  const declared = new Set<string>(params.map(p => p.name!.name));
  const localTypes = new Map<string, TypeNode>();
  for (const p of params) localTypes.set(p.name!.name, p.type);
  for (const d of findNodesByKind(body, NodeKind.VariableDecl)) {
    const v = d as VariableDecl;
    declared.add(v.name.name);
    localTypes.set(v.name.name, v.type);
  }
  let statements = statementsIn ?? body.statements as Statement[];
  let changed = false;
  const fnName = (fn.name as { name?: string })?.name ?? '?';

  for (const param of params) {
    const p = param.name!.name;
    if (!stackParams.has(p)) continue;
    const paramType = spellingOf(param.type);
    const paramClass = wordClass(paramType);
    if (!paramClass) continue;
    const flow = buildFunctionFlow(statements, declared);
    if (flow.isEscaped(p)) continue;

    // The writes, each a statement `P = e`.
    const stores = new Map<number, { stmt: ExprStmt; value: Expression }>();
    let other = false;
    for (const n of flow.cfg.nodes) {
      if (!flow.writes(n.id).has(p)) continue;
      const st = n.stmt;
      const e = st && st.kind === NodeKind.ExprStmt ? unwrapParens((st as ExprStmt).expression) : null;
      const a = e && e.kind === NodeKind.AssignExpr ? e as AssignExpr : null;
      const left = a ? unwrapParens(a.left) : null;
      if (!a || a.operator !== '=' || left?.kind !== NodeKind.Identifier || (left as Identifier).name !== p) { other = true; break; }
      stores.set(n.id, { stmt: st as ExprStmt, value: a.right });
    }
    if (stores.size === 0 || other) continue;

    // The reads of the second range: reached by writes alone.
    const second = new Set<number>();
    let mixed = false;
    for (const n of flow.cfg.nodes) {
      if (!flow.reads(n.id).has(p)) continue;
      const reach = [...flow.reaching(n.id, p)];
      const fromStores = reach.filter(r => stores.has(r));
      if (fromStores.length === 0) continue;
      if (fromStores.length !== reach.length) { mixed = true; break; }
      second.add(n.id);
    }
    if (mixed) { o.onRefused?.(fnName, `${p}: a read is reached by the parameter and by a later store`); continue; }
    if (second.size === 0) continue;

    // Every occurrence of P the second range reads, with the cast around it (if any).
    // The store statements' own left-hand sides are writes, not reads.
    const lhs = new Set<object>();
    for (const s of stores.values()) lhs.add(unwrapParens((unwrapParens(s.stmt.expression) as AssignExpr).left));
    const occurrences: { id: Identifier; cast: CStyleCastExpr | null }[] = [];
    for (const n of second) {
      const walk = (x: unknown, parentCast: CStyleCastExpr | null): void => {
        if (Array.isArray(x)) { for (const i of x) walk(i, null); return; }
        if (!x || typeof x !== 'object') return;
        const node = x as ASTNode;
        if (node.kind === NodeKind.Identifier && (node as Identifier).name === p && !lhs.has(node)) {
          occurrences.push({ id: node as Identifier, cast: parentCast });
          return;
        }
        if (node.kind === NodeKind.CStyleCastExpr) {
          const c = node as CStyleCastExpr;
          const inner = unwrapParens(c.expression);
          walk(inner, c);
          return;
        }
        for (const [k, v] of Object.entries(node)) {
          if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
          if (v && typeof v === 'object') walk(v, null);
        }
      };
      walk(flow.ownExprs(n), null);
    }
    if (occurrences.length === 0) continue;

    // T: from the reads when they all say it, else from the stores.
    let target: TypeNode | null = null;
    const readCasts = occurrences.map(oc => oc.cast ? spellingOf(oc.cast.type) : null);
    if (readCasts.every(c => c !== null) && new Set(readCasts).size === 1) {
      target = occurrences[0].cast!.type;
    } else {
      const evident = [...stores.values()].map(s => evidentType(storedValue(s.value, paramType), o, localTypes));
      const spelled = evident.map(t => t ? spellingOf(t) : null);
      if (spelled.every(t => t !== null) && new Set(spelled).size === 1) target = evident[0];
    }
    if (!target) { o.onRefused?.(fnName, `${p}: the reused slot's second type is not evident`); continue; }
    const targetType = spellingOf(target);
    const targetClass = wordClass(targetType);
    if (!targetClass || sameType(targetType, paramType)) continue;
    // A slot holding a function address is the funcdef split's (above): `code *` is
    // Ghidra's untyped pointer, not the type the source declared.
    if (/\bcode\b/.test(targetType)) continue;
    if (targetClass !== 'ptr' && paramClass !== 'ptr') continue;
    // Every cast read must agree with T: a read reinterpreting the slot as a third type
    // is not one variable either.
    if (readCasts.some(c => c !== null && !sameType(c, targetType) && !sameType(c, paramType))) {
      o.onRefused?.(fnName, `${p}: the second range is read as more than one type`);
      continue;
    }

    const local = valueLocalName(targetType, p, declared);
    declared.add(local);
    const castReads = new Map<object, Expression>();
    const bareReads = new Set<object>();
    for (const oc of occurrences) {
      if (oc.cast && sameType(spellingOf(oc.cast.type), targetType)) castReads.set(oc.cast, Expr.identifier(local));
      else bareReads.add(oc.id);
    }
    const storeStmts = new Map<object, Expression>();
    // An integer the slot's new type takes without a cast: a literal, or arithmetic on
    // a read of the slot itself (`(int)p - 1` once that read is the local).
    const isOwnRead = (e: Expression): boolean => {
      const u = unwrapParens(e);
      if (u.kind === NodeKind.Identifier) return bareReads.has(u);
      return castReads.has(u);
    };
    const plainInteger = (e: Expression): boolean => {
      const u = unwrapParens(e);
      if (u.kind === NodeKind.IntegerLiteral) return true;
      if (u.kind !== NodeKind.BinaryExpr) return false;
      const b = u as unknown as { operator: string; left: Expression; right: Expression };
      if (!['+', '-', '*', '&', '|', '^', '<<', '>>'].includes(b.operator)) return false;
      const lit = (x: Expression) => unwrapParens(x).kind === NodeKind.IntegerLiteral;
      return (castReads.has(unwrapParens(b.left)) && lit(b.right)) || (lit(b.left) && castReads.has(unwrapParens(b.right)));
    };
    for (const s of stores.values()) {
      const x = storedValue(s.value, paramType);
      const t = evidentType(x, o, localTypes);
      const fits = (t && sameType(spellingOf(t), targetType))
        || (targetClass === 'int' && plainInteger(x))
        || isOwnRead(x);
      storeStmts.set(s.stmt, fits ? x : Expr.cast(target, Expr.paren(x)));
    }
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
        return { ...st, expression: { ...a, left: Expr.identifier(local), right: rebuild(store) } };
      }
      const asLocal = castReads.get(node);
      if (asLocal) return asLocal;
      if (bareReads.has(node)) return Expr.paren(Expr.cast(param.type, Expr.identifier(local)));
      let copy: Record<string, unknown> | null = null;
      for (const [k, v] of Object.entries(node)) {
        if (k === 'location' || k === 'type' || !v || typeof v !== 'object') continue;
        const r = rebuild(v);
        if (r !== v) { copy = copy ?? { ...(node as object) } as Record<string, unknown>; copy[k] = r; }
      }
      return copy ?? x;
    };
    const rewritten = rebuild(statements) as Statement[];
    const decl = Stmt.declStmt([Decl.variable(local, target)]) as unknown as DeclStmt;
    let at = 0;
    while (at < rewritten.length && rewritten[at].kind === NodeKind.DeclStmt) at++;
    statements = [...rewritten.slice(0, at), decl as unknown as Statement, ...rewritten.slice(at)];
    localTypes.set(local, target);
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
  if ((!o.functionSignatures || !o.funcdefSignatures) && !o.stackParameters) return (n: ASTNode) => n;
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const pointers = o.functionSignatures && o.funcdefSignatures ? splitReusedParameterSlots(fn, o) : null;
      const values = splitReusedValueSlots(fn, o, pointers ?? undefined);
      const statements = values ?? pointers;
      if (!statements) return undefined;
      return updateNode(fn, { body: { ...(fn.body as CompoundStmt), statements } } as Partial<FunctionDecl>);
    },
  });
}

export const reusedParamSlotPlugin: TransformPlugin = {
  id: 'reused-param-slot',
  name: 'Reused Parameter Slot',
  description:
    'A dead stack-parameter slot MSVC reused for a second value -> a local of its own (a funcdef pointer, or the value\'s type), proven by reaching definitions',
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
