/**
 * EH State Guard Plugin
 *
 * VC8 /EHsc builds a C++ EH frame (`push -1; push __ehhandler$f; mov eax, fs:[0]; push eax;
 * mov fs:[0], esp`) around a function that holds an object whose destructor must run when an
 * exception unwinds through it, and stores the frame's state into `[ebp-4]`: 0 once the object
 * is constructed, -1 just before its destructor runs on the normal path. A derived class'
 * destructor is the common case: the base subobject is the object (SpinnerImplementation
 * ::~SpinnerImplementation 004bbe10 saves `this`, stores the vtable, sets state 0, runs its own
 * body, sets state -1 and calls UIWidget's destructor). The decompiler prints the frame:
 *
 *   pfnEHHandlerRoutine pExceptionHandler = SehHandler_6ca198;
 *   void *pSavedExceptionList = ExceptionList;
 *   ExceptionList = &pSavedExceptionList;
 *   pThis->pVtable = SpinnerImplementation::vftable;       construction
 *   dwSehState = 0;
 *   DC6_FreeAndDelete(pThis->pDC6);                          the object's lifetime
 *   dwSehState = -1;
 *   UI::Destructor((UIWidget *)pThis);                       destruction
 *   ExceptionList = pSavedExceptionList;
 *
 * which compiles to stores into an ordinary `ExceptionList` global and no frame at all. This
 * pass writes the object back: a local guard whose constructor is the construction and whose
 * destructor is the destruction, the lifetime between them.
 *
 *   struct EhState0 {
 *     ::SpinnerImplementation* pThis;
 *     __forceinline EhState0(::SpinnerImplementation* pThis_) { this->pThis = pThis_; pThis->pVtable = ...; }
 *     __forceinline ~EhState0() { UI::Destructor((::UIWidget*)pThis); }
 *   };
 *   EhState0 eh0(pThis);
 *   DC6_FreeAndDelete(pThis->pDC6);
 *
 * VC8 compiles that to the original frame, state stores and all (004bbe10 is MATCH). The guard
 * holds a copy of each local the two bodies read (`this` is the saved `[ebp-0x10]`).
 * `__forceinline` is needed: VC8 /Ob1 does not inline a local class' members otherwise.
 *
 * Value-preserving on every path that returns normally: the construction runs where it ran,
 * the destruction runs when the block ends, which is where it ran, since only the shape below
 * is taken:
 *  - the link `ExceptionList = &P`, one store of 0 and then one store of -1 into one state
 *    variable, and the restore `ExceptionList = P` as statements of the function body, in that
 *    order, the restore last (or before a bare `return;`);
 *  - nothing between the link and the restore returns, jumps or is a label;
 *  - the destruction (between the -1 store and the restore) is not empty, and the guard's
 *    copies stay equal to the locals: the lifetime never assigns a copied local, and no copied
 *    local has its address taken; a copied local is declared before the guard;
 *  - the state variable, the saved list and the handler local are used nowhere else.
 * The construction is the leading statements before the 0 store that assign no local; they go
 * into the constructor. The statements after them (a local loaded before the lifetime, as
 * ButtonWrapper::Destructor 004badd0 loads its implementation pointer) follow the guard in the
 * same order, which is where VC8 sets state 0 for them too.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl, Identifier,
  IntegerLiteralExpr, ReturnStmt, Statement, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { parse } from '../../../parser/index.js';
import { localTypesOf } from './compare-form.js';
import { Expr, Stmt } from '../../../ast/factory.js';

/** Statements as source, each with its terminator: the text of a block, without the braces. */
function block(stmts: Statement[]): string {
  if (stmts.length === 0) return '';
  const t = emit(Stmt.compound(stmts) as never).trim();
  return t.slice(1, -1);
}

export interface EhStateGuardOptions extends PluginOptions {
  onSite?: (s: { guard: string; copies: string[]; constructed: boolean }) => void;
  onRefuse?: (why: string) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as unknown as { expression: Expression }).expression;
  return e;
}

const text = (n: ASTNode | null | undefined): string => (n ? emit(n as never).replace(/\s+/g, ' ').trim() : '');

/** `lhs = rhs` of an expression statement, or the declared name and initializer of a one-variable declaration. */
function storeOf(s: Statement): { lhs: string; rhs: Expression; decl?: VariableDecl } | null {
  if (s.kind === NodeKind.ExprStmt) {
    const e = unwrap((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    return { lhs: text((e as AssignExpr).left), rhs: (e as AssignExpr).right };
  }
  if (s.kind === NodeKind.DeclStmt) {
    const ds = (s as DeclStmt).declarations as VariableDecl[] | undefined;
    if (!ds || ds.length !== 1 || !ds[0].initializer) return null;
    return { lhs: ds[0].name.name, rhs: ds[0].initializer as Expression, decl: ds[0] };
  }
  return null;
}

function intOf(e: Expression): bigint | null {
  let x = unwrap(e);
  while (x.kind === NodeKind.CStyleCastExpr) x = unwrap((x as unknown as { expression: Expression }).expression);
  if (x.kind === NodeKind.IntegerLiteral) return (x as IntegerLiteralExpr).value;
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
    const o = unwrap((x as UnaryExpr).operand);
    if (o.kind === NodeKind.IntegerLiteral) return -(o as IntegerLiteralExpr).value;
  }
  return null;
}

/** The root variable of an lvalue spelling: `p` of `p`, `__frame0` of `__frame0.nState`. */
function rootOf(lhs: string): string {
  return lhs.replace(/^&/, '').split(/[.\[\-]/)[0].trim();
}

function createEhStateGuardTransformer(options: EhStateGuardOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const refuse = (why: string) => { options.onRefuse?.(why); return undefined; };
      const body = fn.body as CompoundStmt;
      const list = body.statements;
      const link = list.findIndex(s => {
        const st = storeOf(s);
        return st?.lhs === 'ExceptionList' && unwrap(st.rhs).kind === NodeKind.UnaryExpr && (unwrap(st.rhs) as UnaryExpr).operator === '&';
      });
      if (link < 0) return undefined;
      const saved = text((unwrap(storeOf(list[link])!.rhs) as UnaryExpr).operand);
      // The restore: last, or before a bare `return;`.
      let restore = list.length - 1;
      if (restore > link && list[restore].kind === NodeKind.ReturnStmt && !(list[restore] as ReturnStmt).value) restore--;
      const rs = storeOf(list[restore]);
      if (!rs || rs.lhs !== 'ExceptionList' || text(rs.rhs) !== saved) return refuse('no restore as the last statement');
      // One store of 0, then one of -1, into one state variable, between link and restore.
      let zero = -1, minus = -1, state = '';
      for (let i = link + 1; i < restore; i++) {
        const st = storeOf(list[i]);
        if (!st) continue;
        const v = intOf(st.rhs);
        if (v === 0n && zero < 0 && /State|Level|state|level/.test(st.lhs)) { zero = i; state = st.lhs; continue; }
        if (state && st.lhs === state && (v === -1n || v === 0xffffffffn)) { if (minus >= 0) return refuse('two -1 stores'); minus = i; }
        else if (state && st.lhs === state) return refuse('another state store');
      }
      if (zero < 0 || minus < 0 || minus === restore - 1) return refuse('not one 0 then one -1 store with a destruction after');
      // Frame statements before the link: the handler local, the save of the list, the state's -1.
      const frameRoots = new Set([rootOf(saved), rootOf(state)]);
      const dropBefore = new Set<number>();
      let handler: string | null = null;
      for (let i = 0; i < link; i++) {
        const st = storeOf(list[i]);
        if (!st) continue;
        if (text(st.rhs) === 'ExceptionList' && st.lhs === saved) { dropBefore.add(i); continue; }
        if (st.lhs === state && intOf(st.rhs) === -1n || st.lhs === state && intOf(st.rhs) === 0xffffffffn) { dropBefore.add(i); continue; }
        const t = st.decl ? text(st.decl.type) : '';
        if (/EHHandler|ExceptionFilter|EhHandler|SehHandler|pfnEH/i.test(t + ' ' + text(st.rhs)) && /^[\w:]+$/.test(text(st.rhs))) {
          if (handler) return refuse('two handler locals');
          handler = st.lhs; dropBefore.add(i);
        }
      }
      if (![...dropBefore].some(i => storeOf(list[i])?.lhs === saved)) return refuse('no save of the list');
      // The frame's own names are used by the frame statements alone.
      const frameStmts = new Set<Statement>([...[...dropBefore].map(i => list[i]), list[link], list[zero], list[minus], list[restore]]);
      const frameNames = new Set([saved, state, ...(handler ? [handler] : [])].map(rootOf));
      for (let i = 0; i < list.length; i++) {
        if (frameStmts.has(list[i])) continue;
        for (const id of findNodesByKind(list[i], NodeKind.Identifier)) {
          const n = (id as Identifier).name;
          // A frame-group struct shares its root with other slots; its slots are named members.
          if (frameNames.has(n) && !/^__frame\d+$/.test(n)) return refuse(`frame name ${n} used elsewhere`);
        }
        if (/^__frame\d+$/.test(rootOf(saved))) {
          const t = text(list[i]);
          for (const lv of [saved, state, ...(handler ? [handler] : [])]) if (t.includes(lv)) return refuse(`frame slot ${lv} used elsewhere`);
        }
      }
      const pre = list.slice(link + 1, zero).filter(s => !dropBefore.has(list.indexOf(s)));
      const region = list.slice(zero + 1, minus);
      const post = list.slice(minus + 1, restore);
      const span = [...pre, ...region, ...post];
      for (const s of span) {
        if (s.kind === NodeKind.LabelStmt || findNodesByKind(s, NodeKind.ReturnStmt).length || findNodesByKind(s, NodeKind.GotoStmt).length
          || findNodesByKind(s, NodeKind.LabelStmt).length) return refuse('a return, goto or label in the frame');
      }
      // A 0 store that was a declaration keeps nothing: its variable is the frame's.
      const types = localTypesOf(fn);
      const writes = (stmts: Statement[]) => {
        const w = new Set<string>();
        for (const s of stmts) {
          for (const a of findNodesByKind(s, NodeKind.AssignExpr)) { const l = unwrap((a as AssignExpr).left); if (l.kind === NodeKind.Identifier) w.add((l as Identifier).name); }
          for (const k of [NodeKind.UnaryExpr, NodeKind.PostfixExpr]) for (const u of findNodesByKind(s, k)) {
            const op = (u as UnaryExpr).operator, o = unwrap((u as UnaryExpr).operand);
            if ((op === '++' || op === '--') && o.kind === NodeKind.Identifier) w.add((o as Identifier).name);
          }
          for (const d of findNodesByKind(s, NodeKind.VariableDecl)) w.add((d as VariableDecl).name.name);
        }
        return w;
      };
      // The construction is the leading statements that assign no local; the rest of what
      // stood before the 0 store follows the guard, in the same order.
      let cut = 0;
      while (cut < pre.length && [...writes([pre[cut]])].every(n => !types.has(n))) cut++;
      const ctor = pre.slice(0, cut), after = pre.slice(cut);
      const construct = ctor.length > 0;
      const inside = [...ctor, ...post];
      const declaredIn = new Set<string>();
      for (const s of [...after, ...region]) for (const d of findNodesByKind(s, NodeKind.VariableDecl)) declaredIn.add((d as VariableDecl).name.name);
      const copies: string[] = [];
      for (const s of inside) for (const id of findNodesByKind(s, NodeKind.Identifier)) {
        const n = (id as Identifier).name;
        if (types.has(n) && !copies.includes(n) && !frameNames.has(n)) copies.push(n);
      }
      const later = writes([...after, ...region, ...post]);
      const addressed = new Set<string>();
      for (const u of findNodesByKind(body, NodeKind.UnaryExpr)) {
        const o = unwrap((u as UnaryExpr).operand);
        if ((u as UnaryExpr).operator === '&' && o.kind === NodeKind.Identifier) addressed.add((o as Identifier).name);
      }
      for (const c of copies) {
        if (later.has(c) || addressed.has(c) || declaredIn.has(c)) return refuse(`copied local ${c} changes or escapes`);
        if (types.get(c)!.kind === NodeKind.ArrayType) return refuse(`copied local ${c} is an array`);
      }
      // Names the guard introduces must be new.
      const used = new Set(findNodesByKind(fn, NodeKind.Identifier).map(n => (n as Identifier).name));
      let k = 0;
      while (used.has(`EhState${k}`) || used.has(`eh${k}`)) k++;
      const G = `EhState${k}`, v = `eh${k}`;
      const typeText = (t: TypeNode) => text(t);
      const members = copies.map(c => `${typeText(types.get(c)!)} ${c};`).join(' ');
      const params = copies.map(c => `${typeText(types.get(c)!)} ${c}_`).join(', ');
      const inits = copies.map(c => `this->${c} = ${c}_;`).join(' ');
      const ctorBody = `${inits} ${block(ctor)}`;
      const src = `void __ehf() { struct ${G} { ${members} __forceinline ${G}(${params}) { ${ctorBody} } `
        + `__forceinline ~${G}() { ${block(post)} } }; `
        + `${G} ${v}${copies.length ? '((__ehc))' : ''}; }`;
      let made: Statement[];
      try {
        made = ((parse(src).declarations[0] as FunctionDecl).body as CompoundStmt).statements;
      } catch (e) {
        return refuse(`the guard does not parse: ${String(e).slice(0, 120)} in ${src.slice(0, 400)}`);
      }
      if (made.length !== 2) return refuse('the guard does not parse as two statements');
      // `T v{a, b}`: the copies as constructor arguments (vc8 translate writes `T v(a, b)`); a
      // parenthesised list would parse as a function declaration.
      if (copies.length) {
        const d = ((made[1] as DeclStmt).declarations as VariableDecl[])[0];
        if (d?.kind !== NodeKind.VariableDecl || d.initializer?.kind !== NodeKind.InitListExpr) return refuse('the guard variable does not parse');
        made[1] = updateNode(made[1], { declarations: [updateNode(d, { initializer: Expr.initList(copies.map(c => Expr.identifier(c))) } as Partial<VariableDecl>)] } as Partial<DeclStmt>);
      }
      const out: Statement[] = [];
      for (let i = 0; i < link; i++) if (!dropBefore.has(i)) out.push(list[i]);
      // Only a bare `return;` follows: the guard is destroyed there, where the destruction ran.
      const tail = list.slice(restore + 1);
      out.push(...made, ...after, ...region);
      out.push(...tail);
      options.onSite?.({ guard: G, copies, constructed: construct });
      return updateNode(fn, { body: updateNode(body, { statements: out } as Partial<CompoundStmt>) } as Partial<FunctionDecl>);
    },
  });
}

export const ehStateGuardPlugin: TransformPlugin = {
  id: 'eh-state-guard',
  name: 'EH State Guard',
  description: 'A C++ EH frame with one state is the local object whose destructor it protects',
  version: '1.0.0',
  defaultEnabled: true,
  // After every pass that edits statements (assert-order 987), before seh-native (989).
  priority: 988,
  tags: ['matching'],
  createTransformer: (options: EhStateGuardOptions = {}) => createEhStateGuardTransformer(options),
};
