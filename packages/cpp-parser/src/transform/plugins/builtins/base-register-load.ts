/**
 * Base Register Load Plugin
 *
 * Where the original loads a call argument into the very register its address came
 * through, `mov eax, [eax + ecx*4 + 0x10]; push eax` (Q32_PropagateCompleteToParty,
 * 005887a0), the source held the loaded value in a variable of its own:
 *
 *     pQuestFlags = GetPlayerData(pUnit)->pQuestRecord[pGame->nDifficulty];
 *     GetQuestState(pQuestFlags, QUEST_RescueOnMountArreat, QUESTSTATE_JustCompleted);
 *
 * The decompiler prints the load inside the argument list, which VC8 compiles into a
 * fresh register (`mov edx, [eax + ...]; push edx`). This pass gives the argument its
 * local again, declared right above the statement, where the facts (reconstruct
 * extract/access-order.ts) show the reused register and it is EAX, ECX or EDX. A
 * callee-saved base (ESI/EDI/EBX) is left alone: there VC8 picks the register by other
 * rules and a local does not bring it back.
 *
 * When the base is a local assigned from a call on the statement straight above and
 * named nowhere else, the call goes into the new local's initializer and the temporary
 * goes (`GetPlayerData(pUnit)->pQuestRecord[...]` above).
 *
 * Value-preserving by construction, made only when:
 *   - the call is the statement's top expression (alone, assigned, initialising one
 *     declaration, returned, or an `if` condition under `!`, casts and a comparison
 *     with a constant) and the only call it makes; nothing in it writes;
 *   - the argument is one load: `p->f`, `p->f[i]`, `p[i]` or `*p`, with `p` a local or
 *     parameter and `i` free of calls and writes; nothing else in the statement can
 *     change what it reads, so reading it first reads the same value;
 *   - the new local has the argument's own type (a scalar or a pointer, from the
 *     declarations), so the call sees the same conversion;
 *   - no label, case or default follows in the block (a jump past an initialised
 *     declaration);
 *   - the folded temporary has its callee's return type, or a cast to its type.
 *
 * Without the facts nothing changes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, CStyleCastExpr, DeclStmt, Expression,
  ExprStmt, FunctionDecl, Identifier, IfStmt, MemberExpr, ParameterDecl, ParenExpr, ReturnStmt,
  Statement, SubscriptExpr, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { Decl, Stmt, Expr, Type } from '../../../ast/factory.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import {
  calleeName, bareName, scopedLookup, shapeOfNode, shapeOfSpelling, sameShape, SCALAR_BASES,
  type TypedefResolver, type TypeShape,
} from './call-arg-cast.js';
import { createExprShape } from './expr-shape.js';
import { effectsOf, placed, type AccessOrderEvidence, type ArgLoadFact } from './access-order-evidence.js';

export interface BaseRegisterLoadOptions extends PluginOptions {
  /** The original's accesses, keyed by line of the parsed text; absent: nothing changes. */
  accessOrder?: AccessOrderEvidence | null;
  functionReturnTypes?: Record<string, string>;
  globalTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  /** Type names a same-named namespace shadows: spelled `::Name`. */
  shadowedTypeNames?: string[];
  /** The enclosing function's namespace, innermost last, for unqualified callee lookup. */
  enclosingSegments?: string[];
  onSite?: (e: { line: number; name: string; folded: boolean }) => void;
}

const SCRATCH = new Set(['EAX', 'ECX', 'EDX']);
const LOOPS = new Set<string>([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt]);
const COMPARE = new Set(['==', '!=', '<', '>', '<=', '>=']);

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function isConstant(e: Expression): boolean {
  const u = unwrap(e);
  if (u.kind === NodeKind.IntegerLiteral || u.kind === NodeKind.CharLiteral
    || u.kind === NodeKind.NullptrLiteral || u.kind === NodeKind.BoolLiteral) return true;
  return u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-'
    && unwrap((u as UnaryExpr).operand).kind === NodeKind.IntegerLiteral;
}

/** The expression a statement evaluates first and unconditionally, and its lvalue side if any. */
function topExpression(s: Statement): { expr: Expression; lhs: Expression | null } | null {
  switch (s.kind) {
    case NodeKind.ExprStmt: {
      const e = unwrap((s as ExprStmt).expression);
      if (e.kind === NodeKind.AssignExpr) {
        const a = e as AssignExpr;
        return a.operator === '=' ? { expr: a.right, lhs: a.left } : null;
      }
      return { expr: e, lhs: null };
    }
    case NodeKind.DeclStmt: {
      const d = (s as DeclStmt).declarations;
      if (d.length !== 1 || d[0].kind !== NodeKind.VariableDecl) return null;
      const v = d[0] as VariableDecl;
      if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr || v.directInit) return null;
      return { expr: v.initializer as Expression, lhs: null };
    }
    case NodeKind.ReturnStmt: {
      const v = (s as ReturnStmt).value;
      return v ? { expr: v, lhs: null } : null;
    }
    case NodeKind.IfStmt: {
      const i = s as IfStmt;
      return i.init ? null : { expr: i.condition, lhs: null };
    }
    default:
      return null;
  }
}

/** The call reached from `e` through parens, casts, `!` and a comparison with a constant. */
function callOf(e: Expression): CallExpr | null {
  for (;;) {
    e = unwrap(e);
    if (e.kind === NodeKind.CallExpr) return e as CallExpr;
    if (e.kind === NodeKind.CStyleCastExpr) { e = (e as CStyleCastExpr).expression; continue; }
    if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '!') { e = (e as UnaryExpr).operand; continue; }
    if (e.kind === NodeKind.BinaryExpr && COMPARE.has((e as BinaryExpr).operator)) {
      const b = e as BinaryExpr;
      if (isConstant(b.right)) { e = b.left; continue; }
      if (isConstant(b.left)) { e = b.right; continue; }
    }
    return null;
  }
}

interface Local { decl: VariableDecl; param: boolean; addressed: boolean }

function collectLocals(fn: FunctionDecl, body: CompoundStmt): Map<string, Local> {
  const out = new Map<string, Local>();
  const dup = new Set<string>();
  const add = (name: string, decl: VariableDecl, param: boolean) => {
    if (out.has(name)) dup.add(name);
    out.set(name, { decl, param, addressed: false });
  };
  for (const p of fn.parameters as ParameterDecl[]) {
    const n = (p as unknown as { name?: Identifier | null }).name;
    if (n && n.kind === NodeKind.Identifier) add(n.name, p as unknown as VariableDecl, true);
  }
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.VariableDecl) add((n as VariableDecl).name.name, n as VariableDecl, false);
  }
  for (const d of dup) out.delete(d);
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      for (const m of traverseAST((n as UnaryExpr).operand)) {
        if (m.kind === NodeKind.Identifier) {
          const l = out.get((m as Identifier).name);
          if (l) l.addressed = true;
        }
      }
    }
  }
  return out;
}

/** The load an argument is, its base identifier and the name its value is given. */
function loadOf(e: Expression, locals: Map<string, Local>): { base: Identifier; name: string } | null {
  e = unwrap(e);
  const pure = (x: Expression) => { const f = effectsOf(x); return f.calls === 0 && f.writes === 0; };
  const baseIdent = (x: Expression): Identifier | null => {
    x = unwrap(x);
    return x.kind === NodeKind.Identifier && locals.has((x as Identifier).name) ? x as Identifier : null;
  };
  const memberName = (m: MemberExpr): string | null => {
    const n = m.member as { kind?: string; name?: unknown };
    return n.kind === NodeKind.Identifier && typeof n.name === 'string' ? n.name : null;
  };
  if (e.kind === NodeKind.MemberExpr && (e as MemberExpr).isArrow) {
    const m = e as MemberExpr;
    const b = baseIdent(m.object);
    const name = memberName(m);
    return b && name ? { base: b, name } : null;
  }
  if (e.kind === NodeKind.SubscriptExpr) {
    const s = e as SubscriptExpr;
    if (!pure(s.index)) return null;
    const a = unwrap(s.array);
    if (a.kind === NodeKind.MemberExpr && (a as MemberExpr).isArrow) {
      const b = baseIdent((a as MemberExpr).object);
      const name = memberName(a as MemberExpr);
      return b && name ? { base: b, name } : null;
    }
    const b = baseIdent(a);
    return b ? { base: b, name: `${b.name}Item` } : null;
  }
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '*') {
    const b = baseIdent((e as UnaryExpr).operand);
    return b ? { base: b, name: `${b.name}Value` } : null;
  }
  return null;
}

function parentOf(root: ASTNode, target: ASTNode): ASTNode | null {
  for (const n of traverseAST(root)) if (getChildren(n).includes(target)) return n;
  return null;
}

function replaceChild(parent: ASTNode, from: ASTNode, to: ASTNode): boolean {
  const rec = parent as unknown as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const v = rec[key];
    if (v === from) { rec[key] = to; return true; }
    if (Array.isArray(v)) {
      const i = v.indexOf(from);
      if (i >= 0) { v[i] = to; return true; }
    }
  }
  return false;
}

function hasJumpTarget(stmts: Statement[]): boolean {
  for (const s of stmts) {
    for (const n of traverseAST(s)) {
      if (n.kind === NodeKind.LabelStmt || n.kind === NodeKind.CaseStmt || n.kind === NodeKind.DefaultStmt) return true;
    }
  }
  return false;
}

function typeOfShape(shape: TypeShape, shadowed: Set<string>): TypeNode {
  let t: TypeNode = Type.typedefAt(shape.base, shadowed.has(shape.base));
  for (let i = 0; i < shape.stars; i++) t = Type.pointer(t);
  return t;
}

function rewriteFunction(fn: FunctionDecl, ev: AccessOrderEvidence, opts: BaseRegisterLoadOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const body = cloneNode(fn.body);
  const locals = collectLocals(fn, body);
  const typedefTargets = opts.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];
  const localTypes = new Map<string, TypeNode>();
  for (const [name, l] of locals) localTypes.set(name, l.decl.type);
  const shapeOf = createExprShape(localTypes, {
    globalTypes: opts.globalTypes, enclosingVarTypes: opts.enclosingVarTypes, structFields: opts.structFields,
    fieldTypes: opts.fieldTypes, returnTypes: opts.functionReturnTypes, resolve,
  });
  const shadowed = new Set(opts.shadowedTypeNames ?? []);
  // Every name the function spells, member names aside (a local may share a field's name).
  const members = new Set<ASTNode>();
  for (const n of traverseAST(fn)) if (n.kind === NodeKind.MemberExpr) members.add((n as MemberExpr).member);
  const taken = new Set<string>();
  for (const n of traverseAST(fn)) if (n.kind === NodeKind.Identifier && !members.has(n)) taken.add((n as Identifier).name);

  // How many calls of each bare name print on each line: a fact names one call only.
  const callsOnLine = new Map<string, number>();
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.CallExpr || !placed(n)) continue;
    const name = calleeName((n as CallExpr).callee);
    if (!name) continue;
    const k = `${n.location.start.line}:${bareName(name)}`;
    callsOnLine.set(k, (callsOnLine.get(k) ?? 0) + 1);
  }
  const factFor = (call: CallExpr): ArgLoadFact | null => {
    if (!placed(call)) return null;
    const name = calleeName(call.callee);
    if (!name) return null;
    const line = call.location.start.line;
    if (callsOnLine.get(`${line}:${bareName(name)}`) !== 1) return null;
    const hits = (ev.args.get(line) ?? []).filter(f => bareName(f.name) === bareName(name));
    return hits.length === 1 ? hits[0] : null;
  };
  const mentions = (name: string): Identifier[] => {
    const out: Identifier[] = [];
    for (const n of traverseAST(body)) if (n.kind === NodeKind.Identifier && (n as Identifier).name === name) out.push(n as Identifier);
    return out;
  };
  const fresh = (want: string): string | null => {
    if (!/^[a-z]\w*$/.test(want) || want === 'min' || want === 'max') return null;
    let name = want;
    for (let i = 2; taken.has(name); i++) name = `${want}${i}`;
    taken.add(name);
    return name;
  };
  const returnShape = (call: CallExpr): TypeShape | null => {
    const name = calleeName(call.callee);
    if (!name) return null;
    const spelling = scopedLookup(opts.functionReturnTypes ?? {}, name, opts.enclosingSegments ?? []);
    return spelling ? shapeOfSpelling(spelling, resolve) : null;
  };

  /**
   * Whether `v` is read nowhere but in `use` from statement `s` on: no other mention in
   * `s`, none after it, and none in a loop around it.
   */
  const deadAfter = (v: string, use: ASTNode, s: Statement): boolean => {
    const inUse = new Set<ASTNode>(traverseAST(use));
    const order = [...traverseAST(body)];
    const start = order.indexOf(s);
    if (start < 0) return false;
    for (let i = start; i < order.length; i++) {
      const n = order[i];
      if (n.kind === NodeKind.Identifier && (n as Identifier).name === v && !inUse.has(n)) return false;
    }
    for (const n of order) {
      if (!LOOPS.has(n.kind) || ![...traverseAST(n)].includes(s)) continue;
      for (const m of traverseAST(n)) {
        if (m.kind === NodeKind.Identifier && (m as Identifier).name === v && !inUse.has(m)) return false;
      }
    }
    return true;
  };

  /** `v = call(..);` or `T v = call(..);` at `s`, for the local `v`: the call's value, or null. */
  const callAssigned = (s: Statement, v: string): { value: Expression; decl: boolean } | null => {
    if (s.kind === NodeKind.ExprStmt) {
      const e = unwrap((s as ExprStmt).expression);
      if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
      const a = e as AssignExpr;
      if (unwrap(a.left).kind !== NodeKind.Identifier || (unwrap(a.left) as Identifier).name !== v) return null;
      return { value: a.right, decl: false };
    }
    if (s.kind === NodeKind.DeclStmt) {
      const d = (s as DeclStmt).declarations;
      if (d.length !== 1 || d[0].kind !== NodeKind.VariableDecl) return null;
      const vd = d[0] as VariableDecl;
      if (vd.name.name !== v || !vd.initializer || vd.initializer.kind === NodeKind.InitListExpr || vd.directInit) return null;
      return { value: vd.initializer as Expression, decl: true };
    }
    return null;
  };

  let changed = 0;
  const visitBlock = (block: CompoundStmt): void => {
    for (let b = 0; b < block.statements.length; b++) {
      const s = block.statements[b];
      for (const k of getChildren(s)) visitAll(k);
      const top = topExpression(s);
      if (!top) continue;
      const call = callOf(top.expr);
      if (!call) continue;
      const fx = effectsOf(top.expr);
      if (fx.calls !== 1 || fx.writes !== 0) continue;
      if (top.lhs) { const lf = effectsOf(top.lhs); if (lf.calls || lf.writes) continue; }
      const fact = factFor(call);
      if (!fact || fact.params !== call.arguments.length) continue;
      if (hasJumpTarget(block.statements.slice(b + 1))) continue;
      // Right to left, as the arguments are pushed.
      const loads = fact.loads.filter(l => SCRATCH.has(l.reg) && l.param < call.arguments.length)
        .sort((x, y) => y.param - x.param);
      const decls: DeclStmt[] = [];
      let removeAbove = false;
      for (const ld of loads) {
        const slot = call.arguments[ld.param];
        let target = unwrap(slot);
        if (target.kind === NodeKind.CStyleCastExpr) target = unwrap((target as CStyleCastExpr).expression);
        const load = loadOf(target, locals);
        if (!load) continue;
        const shape = shapeOf(target);
        if (!shape || shape.isConst || (shape.stars === 0 && (!SCALAR_BASES.has(shape.base) || shape.base === 'void'))) continue;
        // Fold a call temporary assigned right above and named nowhere else.
        let value: Expression = cloneNode(target);
        let fold = false;
        const base = locals.get(load.base.name)!;
        if (!base.param && !base.addressed && b > 0 && !removeAbove && decls.length === 0) {
          const above = callAssigned(block.statements[b - 1], load.base.name);
          const all = mentions(load.base.name);
          const expected = 1 + (above && !above.decl ? 1 : 0) + (base.decl.name ? 1 : 0);
          const inner = above ? unwrap(above.value) : null;
          const innerCall = inner && (inner.kind === NodeKind.CallExpr
            ? inner as CallExpr
            : inner.kind === NodeKind.CStyleCastExpr && unwrap((inner as CStyleCastExpr).expression).kind === NodeKind.CallExpr
              ? unwrap((inner as CStyleCastExpr).expression) as CallExpr : null);
          if (above && innerCall && all.length === expected && effectsOf(above.value).writes === 0) {
            const declShape = shapeOfNode(base.decl.type, 0, resolve);
            const valueShape = inner!.kind === NodeKind.CStyleCastExpr
              ? shapeOfNode((inner as CStyleCastExpr).type, 0, resolve) : returnShape(innerCall);
            if (declShape && valueShape && sameShape(declShape, valueShape)) {
              const baseUse = [...traverseAST(value)].find(n => n.kind === NodeKind.Identifier && (n as Identifier).name === load.base.name) as Identifier | undefined;
              const holder = baseUse && parentOf(value, baseUse);
              const replacement: Expression = inner!.kind === NodeKind.CallExpr ? cloneNode(inner!) : Expr.paren(cloneNode(inner!));
              if (holder && replaceChild(holder, baseUse!, replacement)) { fold = true; removeAbove = true; }
            }
          }
        }
        // Without a fold the base is a parameter the argument is its last read of. A local
        // base (`pSkillTxt->calc[0]` after `pSkillTxt = GetLine(..)` and a check) gains
        // nothing measurable and moves VC8's allocation elsewhere in the function.
        if (!fold && (!base.param || !deadAfter(load.base.name, target, s))) continue;
        const name = fresh(load.name);
        if (!name) continue;
        const decl = Decl.variable(name, typeOfShape(shape, shadowed), value);
        const ds = Stmt.declStmt([decl]);
        ds.location = s.location;
        decls.push(ds);
        const holder = parentOf(slot === target ? call : slot, target) ?? call;
        replaceChild(holder, target, Expr.identifier(name));
        opts.onSite?.({ line: s.location?.start.line ?? 0, name, folded: fold });
      }
      if (decls.length === 0) continue;
      if (removeAbove) {
        const above = block.statements[b - 1];
        // The temporary's own declaration, when it stood apart, goes with it.
        const tempName = above.kind === NodeKind.DeclStmt
          ? ((above as DeclStmt).declarations[0] as VariableDecl).name.name
          : ((unwrap((above as ExprStmt).expression) as AssignExpr).left as Identifier).name;
        s.leadingTrivia = [...(above.leadingTrivia ?? []), ...(s.leadingTrivia ?? [])];
        block.statements.splice(b - 1, 1);
        b--;
        if (above.kind !== NodeKind.DeclStmt) dropDecl(body, locals.get(tempName)!.decl);
      }
      // Dropping the temporary's declaration may have moved the statement up.
      b = block.statements.indexOf(s);
      decls[0].leadingTrivia = s.leadingTrivia;
      s.leadingTrivia = [];
      block.statements.splice(b, 0, ...decls);
      b += decls.length;
      changed++;
    }
  };
  const visitAll = (n: ASTNode): void => {
    if (n.kind === NodeKind.CompoundStmt) { visitBlock(n as CompoundStmt); return; }
    for (const k of getChildren(n)) visitAll(k);
  };
  visitAll(body);
  if (!changed) return undefined;
  return updateNode(fn, { body } as Partial<FunctionDecl>);
}

function dropDecl(body: CompoundStmt, decl: VariableDecl): void {
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.CompoundStmt) continue;
    const block = n as CompoundStmt;
    for (let i = 0; i < block.statements.length; i++) {
      const st = block.statements[i];
      if (st.kind !== NodeKind.DeclStmt) continue;
      const ds = st as DeclStmt;
      const k = ds.declarations.indexOf(decl);
      if (k < 0) continue;
      if (ds.declarations.length === 1) block.statements.splice(i, 1);
      else ds.declarations.splice(k, 1);
      return;
    }
  }
}

function createBaseRegisterLoadTransformer(options: BaseRegisterLoadOptions = {}): Transformer {
  const ev = options.accessOrder;
  if (!ev || ev.args.size === 0) return (node: ASTNode) => node;
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, ev, options);
    },
  });
}

export const baseRegisterLoadPlugin: TransformPlugin = {
  id: 'base-register-load',
  name: 'Base Register Load',
  description:
    'Gives a call argument its own local where the original loaded it into the scratch register its address came through',
  version: '1.0.0',
  defaultEnabled: true,
  // After nest-call (59.5), so a temporary it nests is not taken apart here; before
  // decl-init-merge (60).
  priority: 59.6,
  tags: ['matching'],
  createTransformer: createBaseRegisterLoadTransformer,
};
