/**
 * Join Store Temp Plugin
 *
 * An if/else chain whose every arm stores one value into the same member. The decompiler
 * prints the store in each arm (SKILLS_ApplyAreaHitAtUnit, 0056bbc0):
 *
 *     if (eUnitType == UNIT_OBJECT || ...) {
 *       sNearestCtx.nX = pUnit->pPath.pStaticPath->nPosX;
 *     } else if (pUnit->pPath.pDynamicPath) {
 *       sNearestCtx.nX = GetXPos(pUnit->pPath.pDynamicPath);
 *     } else {
 *       sNearestCtx.nX = 0;
 *     }
 *
 * The original computes the value in one register in every arm and stores it once after
 * the arms join (`jmp 0x44; xor eax,eax` and one `mov [ebp-0xc],eax`): the source was a
 * value written into the member, an inlined getter. Written with one store per arm, VC8
 * stores in each arm. This pass gives the value a temporary and stores it after the join:
 *
 *     int32_t nXValue;
 *     if (..) { nXValue = ..->nPosX; } else if (..) { nXValue = GetXPos(..); } else { nXValue = 0; }
 *     sNearestCtx.nX = nXValue;
 *
 * Value-preserving: in either form an arm evaluates its value, converts it to the member's
 * type and then stores it, and nothing runs between the conversion and the store; the
 * temporary has the member's declared type, so `L = tmp` converts nothing. Made only when:
 *   - every arm of the chain, the last a plain `else`, is the single statement `L = e`
 *     with the same target L;
 *   - L is a member path from a local or parameter (`s.f`, `s.a.b`, `p->f`), the root named
 *     nowhere in the chain but as L's root, never addressed when L reads through it, and
 *     no member path holds a call, a subscript or an increment;
 *   - the member's declared type is known exactly (the object's own type declares it) and
 *     is a scalar or a pointer: no array, no aggregate, no bit-field, no volatile;
 *   - the chain holds no label, `case` or `default`;
 *   - some arm reads its value out of an object (a call, `p->f`, `a[i]`, `*p`): the getter
 *     VC8 inlined. Arms that only pick between constants, parameters and globals were
 *     per-arm stores in the original too (DrawPopupOk 0045fbc0, D2WinAnimImage 00500850,
 *     SMsgDispatchMessage 00420b00 are MATCH with the stores in the arms).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AnyNode, AssignExpr, CompoundStmt, ExprStmt, Expression, FunctionDecl, Identifier, IfStmt,
  MemberExpr, ParenExpr, Statement, TypeNode, UnaryExpr,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { Decl, Stmt, Expr } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape } from './expr-shape.js';
import { localTypesOf } from './compare-form.js';
import { typeFromSpelling } from './call-arg-cast.js';

export interface JoinStoreTempOptions extends PluginOptions {
  /** Aggregate name -> member name -> member spelling. */
  structFields?: Record<string, Record<string, string>>;
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  onSite?: (e: { line: number; target: string; arms: number }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function assignOf(s: Statement): AssignExpr | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  return e.kind === NodeKind.AssignExpr ? e as AssignExpr : null;
}

/** The single statement of an arm: the statement itself, or a compound holding one. */
function single(s: Statement | null): Statement | null {
  if (!s) return null;
  if (s.kind !== NodeKind.CompoundStmt) return s;
  const list = (s as CompoundStmt).statements;
  return list.length === 1 ? list[0] : null;
}

/** The arms of a chain `if .. else if .. else ..`, each with its store; null unless every arm is `L = e`. */
function chainArms(top: IfStmt): { arm: Statement; store: AssignExpr }[] | null {
  const arms: { arm: Statement; store: AssignExpr }[] = [];
  let cur: IfStmt = top;
  for (;;) {
    if (cur.init) return null;
    const then = single(cur.thenBranch);
    const a = then && assignOf(then);
    if (!a || a.operator !== '=') return null;
    arms.push({ arm: then!, store: a });
    const e = cur.elseBranch;
    if (!e) return null;
    const inner = e.kind === NodeKind.IfStmt ? e as IfStmt : single(e);
    if (inner && inner.kind === NodeKind.IfStmt) { cur = inner as IfStmt; continue; }
    const last = single(e);
    const b = last && assignOf(last);
    if (!b || b.operator !== '=') return null;
    arms.push({ arm: last!, store: b });
    return arms;
  }
}

/** The root name of a member path `s.f`, `s.a.b`, `p->f`; null for anything else. */
function memberRoot(target: Expression): { root: string; through: boolean } | null {
  let x = unwrap(target);
  if (x.kind !== NodeKind.MemberExpr) return null;
  let through = false;
  while (x.kind === NodeKind.MemberExpr) {
    const m = x as MemberExpr;
    if (m.member.kind !== NodeKind.Identifier) return null;
    if (m.isArrow) through = true;
    x = unwrap(m.object);
  }
  if (x.kind !== NodeKind.Identifier) return null;
  return { root: (x as Identifier).name, through };
}

function namesIn(n: ASTNode, name: string): number {
  let k = 0;
  for (const x of traverseAST(n)) if (x.kind === NodeKind.Identifier && (x as Identifier).name === name) k++;
  return k;
}

function addressed(fn: FunctionDecl, name: string): boolean {
  for (const x of traverseAST(fn.body!)) {
    if (x.kind !== NodeKind.UnaryExpr || (x as UnaryExpr).operator !== '&') continue;
    const o = unwrap((x as UnaryExpr).operand);
    if (o.kind === NodeKind.Identifier && (o as Identifier).name === name) return true;
  }
  return false;
}

/** Whether a value is read out of an object: a call, `p->f`, `a[i]` or `*p` - what an inlined getter returns. */
function readsObject(e: Expression): boolean {
  for (const x of traverseAST(e)) {
    if (x.kind === NodeKind.CallExpr || x.kind === NodeKind.SubscriptExpr) return true;
    if (x.kind === NodeKind.MemberExpr && (x as MemberExpr).isArrow) return true;
    if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') return true;
  }
  return false;
}

function holdsLabel(n: ASTNode): boolean {
  for (const x of traverseAST(n)) {
    if (x.kind === NodeKind.LabelStmt || x.kind === NodeKind.CaseStmt || x.kind === NodeKind.DefaultStmt) return true;
  }
  return false;
}

function freshName(fn: FunctionDecl, base: string, taken: Set<string>): string {
  const used = new Set<string>(taken);
  for (const x of traverseAST(fn)) if (x.kind === NodeKind.Identifier) used.add((x as Identifier).name);
  let n = `${base}Value`;
  for (let k = 2; used.has(n); k++) n = `${base}Value${k}`;
  taken.add(n);
  return n;
}

function createJoinStoreTempTransformer(options: JoinStoreTempOptions = {}): Transformer {
  const structFields = options.structFields ?? {};
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const localTypes = localTypesOf(fn);
      const shapeOf = createExprShape(localTypes, {
        globalTypes: options.globalTypes ?? {},
        enclosingVarTypes: options.enclosingVarTypes ?? {},
        structFields,
        fieldTypes: options.fieldTypes ?? {},
        returnTypes: options.functionReturnTypes ?? {},
      });
      const taken = new Set<string>();

      /** The member's declared spelling when the object's own type declares it. */
      const memberSpelling = (target: MemberExpr): string | null => {
        const obj = shapeOf(target.object);
        if (!obj || obj.stars !== (target.isArrow ? 1 : 0)) return null;
        const s = structFields[obj.base]?.[(target.member as Identifier).name];
        return typeof s === 'string' ? s : null;
      };

      const site = (ifs: IfStmt): Statement[] | null => {
        const arms = chainArms(ifs);
        if (!arms || arms.length < 2) return null;
        const target = unwrap(arms[0].store.left);
        const path = memberRoot(target);
        if (!path || !localTypes.has(path.root)) return null;
        const text = emit(target as unknown as AnyNode);
        for (const { store } of arms) if (emit(unwrap(store.left) as unknown as AnyNode) !== text) return null;
        // The root is read nowhere in the chain but as each target's root.
        if (namesIn(ifs, path.root) !== arms.length) return null;
        if (path.through && addressed(fn, path.root)) return null;
        if (holdsLabel(ifs)) return null;
        if (!arms.some(({ store }) => readsObject(store.right))) return null;
        const spelling = memberSpelling(target as MemberExpr);
        if (!spelling || /[\[\]():]|volatile/.test(spelling)) return null;
        const type: TypeNode | null = typeFromSpelling(spelling);
        if (!type) return null;
        const t = shapeOf(target);
        if (!t || (t.stars === 0 && structFields[t.base])) return null;
        const member = ((target as MemberExpr).member as Identifier).name;
        const tmp = freshName(fn, member, taken);

        const toTmp = (s: Statement, a: AssignExpr): Statement => {
          const moved = updateNode(a, { left: Expr.identifier(tmp) } as Partial<AssignExpr>);
          const e = (s as ExprStmt).expression;
          return updateNode(s as ExprStmt, {
            expression: e === a ? moved : updateNode(e, { expression: moved } as Partial<Expression>),
          } as Partial<ExprStmt>);
        };
        const rewrite = (s: Statement): Statement => {
          if (s.kind === NodeKind.CompoundStmt) {
            const c = s as CompoundStmt;
            return updateNode(c, { statements: c.statements.map(rewrite) } as Partial<CompoundStmt>);
          }
          if (s.kind === NodeKind.IfStmt) {
            const i = s as IfStmt;
            return updateNode(i, {
              thenBranch: rewrite(i.thenBranch),
              elseBranch: i.elseBranch ? rewrite(i.elseBranch) : null,
            } as Partial<IfStmt>);
          }
          const a = assignOf(s);
          return a ? toTmp(s, a) : s;
        };
        const decl = { ...Stmt.declStmt([Decl.variable(tmp, type, null)]), leadingTrivia: ifs.leadingTrivia } as Statement;
        const chain = updateNode(rewrite(ifs) as IfStmt, { leadingTrivia: undefined } as Partial<IfStmt>);
        const store = Stmt.expr(Expr.assign(cloneNode(target) as Expression, Expr.identifier(tmp)));
        options.onSite?.({ line: ifs.location?.start?.line ?? 0, target: text, arms: arms.length });
        return [decl, chain, store];
      };

      let changed = false;
      const visit = createTransformer({
        visitCompoundStmt(c: CompoundStmt): ASTNode | undefined {
          let any = false;
          const out: Statement[] = [];
          for (const s of c.statements) {
            const r = s.kind === NodeKind.IfStmt ? site(s as IfStmt) : null;
            if (r) { out.push(...r); any = true; } else out.push(s);
          }
          if (!any) return undefined;
          changed = true;
          return updateNode(c, { statements: out } as Partial<CompoundStmt>);
        },
      });
      const body = visit(fn.body) as CompoundStmt;
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export { createJoinStoreTempTransformer };

export const joinStoreTempPlugin: TransformPlugin = {
  id: 'join-store-temp',
  name: 'Join Store Temp',
  description: 'A store every arm of an if/else chain makes into one member: the value in a temporary, stored once after the join',
  version: '1.0.0',
  defaultEnabled: true,
  // After the types are final (narrow-local-widen 618, compare-signedness 619) and the
  // halts are folded (930); before branch-layout (988) reads the arms.
  priority: 970,
  tags: ['matching'],
  createTransformer: createJoinStoreTempTransformer,
};
