/**
 * Call Target Hold Plugin
 *
 * A handler fetched out of a table and called when it is set. The decompiler prints the
 * element twice, once in the test and once as the callee (MONSTER_DispatchUniqueModifiers,
 * 005a4270):
 *
 *     if (g_MonsterUModHandlerTable[pUModList[nUModSlot]].pfnMissile) {
 *       g_MonsterUModHandlerTable[pUModList[nUModSlot]].pfnMissile(pGame, pMissile, ..);
 *     }
 *
 * The original loads the element once, tests the register and calls it
 * (`mov esi, [edx*8+tbl]; test esi, esi; je; ..; call esi`). Compiled as printed, VC8
 * reads the index and the element again for the call (`movzx; lea; mov eax, [..]; call eax`,
 * 85 instructions against the original's 77). The source held the handler in a local:
 *
 *     fpMonsterUModHandler pfnHandler = g_MonsterUModHandlerTable[..].pfnMissile;
 *     if (pfnHandler) {
 *       pfnHandler(pGame, pMissile, ..);
 *     }
 *
 * `if (E) S` with S the single statement `F(args);` or `x = F(args);`, F being E or `*E`,
 * becomes `T h = E; if (h) S'` with S' calling h, when
 *   - E is an element of a table: a subscript, or a member of one, whose root is a global
 *     (no local or parameter), and some index in it reads memory (`a[i]`, `*p`, `p->f`).
 *     A table indexed by a plain local or a constant is read once by VC8 as printed
 *     (UMOD_ApplyEnchantmentsToMonster 005a2120 is MATCH that way); so is a plain global
 *     or a member of a pointer (`pTimer->nfpTimerFunction`, 00540f60);
 *   - E's type is known and spells as a name with stars: no inline function type. A
 *     Ghidra function definition is a pointer typedef in the tree, so `F *` declares `F`;
 *   - no argument calls, assigns or steps anything, so nothing between the test and the
 *     call can change the table;
 *   - the statement holds no label, `case` or `default`.
 *
 * Value-preserving: E has no side effect and nothing runs between its test and the call
 * that could store to it; the local holds E's value of E's own type, so the test and the
 * callee are the same value either way.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CompoundStmt, ExprStmt, Expression, FunctionDecl, Identifier, IfStmt,
  MemberExpr, ParenExpr, Statement, SubscriptExpr, TypeNode, UnaryExpr,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { Decl, Stmt, Expr } from '../../../ast/factory.js';
import { createTransformer, updateNode, cloneNode, nodesEqual, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape } from './expr-shape.js';
import { localTypesOf } from './compare-form.js';
import { typeFromSpelling } from './call-arg-cast.js';

export interface CallTargetHoldOptions extends PluginOptions {
  structFields?: Record<string, Record<string, string>>;
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  /**
   * Ghidra's function definitions. The tree spells each as a pointer typedef
   * (`typedef void (__fastcall *fpUmodInit)(..)`), so a Ghidra `fpUmodInit *` is the
   * tree's `fpUmodInit`.
   */
  funcdefNames?: readonly string[];
  onSite?: (e: { line: number; target: string }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** The single statement of an arm: the statement itself, or a compound holding one. */
function single(s: Statement | null): Statement | null {
  if (!s) return null;
  if (s.kind !== NodeKind.CompoundStmt) return s;
  const list = (s as CompoundStmt).statements;
  return list.length === 1 ? list[0] : null;
}

/** The call of `F(args);` or `x = F(args);`. */
function callOf(s: Statement): CallExpr | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  let e = unwrap((s as ExprStmt).expression);
  if (e.kind === NodeKind.AssignExpr) {
    const a = e as AssignExpr;
    if (a.operator !== '=' || unwrap(a.left).kind !== NodeKind.Identifier) return null;
    e = unwrap(a.right);
  }
  return e.kind === NodeKind.CallExpr ? e as CallExpr : null;
}

/** The callee with a leading `*` taken off: what the call fetches. */
function target(c: CallExpr): { e: Expression; deref: boolean } {
  const f = unwrap(c.callee);
  if (f.kind === NodeKind.UnaryExpr && (f as UnaryExpr).operator === '*') {
    return { e: unwrap((f as UnaryExpr).operand), deref: true };
  }
  return { e: f, deref: false };
}

/** Whether e reads memory: a subscript, `*p` or `p->f`. */
function readsMemory(e: ASTNode): boolean {
  for (const x of traverseAST(e)) {
    if (x.kind === NodeKind.SubscriptExpr) return true;
    if (x.kind === NodeKind.MemberExpr && (x as MemberExpr).isArrow) return true;
    if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') return true;
  }
  return false;
}

/** Whether e calls, assigns or steps anything. */
function hasEffect(e: ASTNode): boolean {
  for (const x of traverseAST(e)) {
    if (x.kind === NodeKind.CallExpr || x.kind === NodeKind.AssignExpr) return true;
    if (x.kind === NodeKind.UnaryExpr && /^(\+\+|--)$/.test((x as UnaryExpr).operator)) return true;
    if (x.kind === NodeKind.PostfixExpr) return true;
  }
  return false;
}

/**
 * The table element E: walks `.f`, `[i]` and `(&a)[i]` down to the table's root name.
 * Null unless the path holds a subscript, every member is `.` (an element, not a pointer
 * read), and some subscript's index reads memory.
 */
function tableElement(e: Expression): { root: string } | null {
  let x = unwrap(e);
  let subscripted = false;
  let memIndex = false;
  for (;;) {
    if (x.kind === NodeKind.SubscriptExpr) {
      const s = x as SubscriptExpr;
      subscripted = true;
      if (readsMemory(s.index)) memIndex = true;
      x = unwrap(s.array);
    } else if (x.kind === NodeKind.MemberExpr) {
      const m = x as MemberExpr;
      if (m.isArrow || m.member.kind !== NodeKind.Identifier) return null;
      x = unwrap(m.object);
    } else if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '&') {
      x = unwrap((x as UnaryExpr).operand);
    } else break;
  }
  if (!subscripted || !memIndex) return null;
  if (x.kind === NodeKind.Identifier) return { root: (x as Identifier).name };
  if (x.kind === NodeKind.QualifiedId) {
    const q = x as unknown as { name: Identifier };
    return q.name?.kind === NodeKind.Identifier ? { root: q.name.name } : null;
  }
  return null;
}

function holdsLabel(n: ASTNode): boolean {
  for (const x of traverseAST(n)) {
    if (x.kind === NodeKind.LabelStmt || x.kind === NodeKind.CaseStmt || x.kind === NodeKind.DefaultStmt) return true;
  }
  return false;
}

function freshName(fn: FunctionDecl, taken: Set<string>): string {
  const used = new Set<string>(taken);
  for (const x of traverseAST(fn)) if (x.kind === NodeKind.Identifier) used.add((x as Identifier).name);
  let n = 'pfnHandler';
  for (let k = 2; used.has(n); k++) n = `pfnHandler${k}`;
  taken.add(n);
  return n;
}

function createCallTargetHoldTransformer(options: CallTargetHoldOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const localTypes = localTypesOf(fn);
      const shapeOf = createExprShape(localTypes, {
        globalTypes: options.globalTypes ?? {},
        enclosingVarTypes: options.enclosingVarTypes ?? {},
        structFields: options.structFields ?? {},
        fieldTypes: options.fieldTypes ?? {},
        returnTypes: options.functionReturnTypes ?? {},
      });
      const taken = new Set<string>();
      const funcdefs = new Set(options.funcdefNames ?? []);

      const site = (ifs: IfStmt): Statement[] | null => {
        if (ifs.init || ifs.elseBranch || ifs.isConstexpr) return null;
        const body = single(ifs.thenBranch);
        const call = body && callOf(body);
        if (!call) return null;
        const t = target(call);
        if (!nodesEqual(unwrap(ifs.condition), t.e)) return null;
        const el = tableElement(t.e);
        if (!el || localTypes.has(el.root)) return null;
        if (call.arguments.some(hasEffect) || holdsLabel(ifs)) return null;
        const shape = shapeOf(t.e);
        if (!shape || shape.isConst) return null;
        // A funcdef read through Ghidra's pointer spelling is the tree's pointer typedef itself.
        const stars = funcdefs.has(shape.base) && shape.stars > 0 ? shape.stars - 1 : shape.stars;
        const spelling = shape.base + '*'.repeat(stars);
        const type: TypeNode | null = typeFromSpelling(spelling);
        if (!type) return null;
        const name = freshName(fn, taken);
        const callee = t.deref ? Expr.unary('*', Expr.identifier(name)) : Expr.identifier(name);
        const newCall = updateNode(call, { callee } as Partial<CallExpr>);
        const s = body as ExprStmt;
        const inner = unwrap(s.expression);
        const expression = inner.kind === NodeKind.AssignExpr
          ? updateNode(inner as AssignExpr, { right: newCall } as Partial<AssignExpr>)
          : newCall;
        const newBody = updateNode(s, { expression } as Partial<ExprStmt>);
        const thenBranch = ifs.thenBranch.kind === NodeKind.CompoundStmt
          ? updateNode(ifs.thenBranch as CompoundStmt, { statements: [newBody] } as Partial<CompoundStmt>)
          : newBody;
        const decl = {
          ...Stmt.declStmt([Decl.variable(name, type, cloneNode(t.e) as Expression)]),
          leadingTrivia: ifs.leadingTrivia,
        } as Statement;
        const test = updateNode(ifs, {
          condition: Expr.identifier(name), thenBranch, leadingTrivia: undefined,
        } as Partial<IfStmt>);
        options.onSite?.({ line: ifs.location?.start?.line ?? 0, target: name });
        return [decl, test];
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

export { createCallTargetHoldTransformer };

export const callTargetHoldPlugin: TransformPlugin = {
  id: 'call-target-hold',
  name: 'Call Target Hold',
  description: 'A table handler tested and then called is held in a local: the original reads the element once',
  version: '1.0.0',
  defaultEnabled: true,
  // With join-store-temp (970): after the types are final, before branch-layout (988).
  priority: 970.5,
  tags: ['matching'],
  createTransformer: createCallTargetHoldTransformer,
};
