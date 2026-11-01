/**
 * Field Pointer Fold Plugin
 *
 * The decompiler gives an updated field a pointer temporary of its own. Q28_PlayerComplete-
 * ForgeInAct4 (005b5b00) prints
 *
 *     int* pForgeCompletedCount = &pQuest->pQuestSpecificData.pA2Q6->nStatusCode;
 *     (*pForgeCompletedCount)++;
 *
 * which VC8 compiles into an `lea` and an `inc dword ptr [reg]`, where the original is one
 * `inc dword ptr [eax+0x14]`: the source updated the field in place,
 * `pQuest->pQuestSpecificData.pA2Q6->nStatusCode++`. A pointer to a field that is used
 * several times is the other shape. Q05_SetRewardForPlayersInTower (00594dd0) prints
 *
 *     D2QuestGUIDStrc* pList = &pQuestData->pQuestSpecificData.pA1Q5->sQuestGUID;
 *     Search(pList, n); Add(pList, n);
 *
 * where the original keeps the record pointer in a register and forms the field's address
 * at each use (`mov edi,[edi]; lea eax,[edi+6]`): the source held the record, not the field.
 *
 * Two rewrites, each value-preserving by construction:
 *
 *   single  `T* p = &E;` (or `p = &E;` with `p` declared without an initialiser) followed
 *           directly by `(*p)++`, `(*p)--`, `++*p`, `--*p` or `*p op= v` becomes `E++`,
 *           `E op= v`, ... and the temporary goes. Made only when
 *             - E is an lvalue built from names, members, `*` and subscripts, with no call
 *               and no write in it, so evaluating it at the update is evaluating it at the
 *               declaration (nothing runs between the two);
 *             - v calls nothing and writes nothing (C++03 leaves the order of E and v
 *               unspecified; with both pure the order cannot matter);
 *             - p is named nowhere else and is declared once, and E does not name p;
 *             - E's type is the declared pointee (no conversion hides behind the pointer).
 *   multi   `T* p = &X->f;` with X itself a load (a member, a subscript or a `*`), read two
 *           or more times and never written or addressed, becomes `S* b = X;` with each use
 *           `&b->f` (`*p` as `b->f`, `p->g` as `b->f.g`). b holds the value X had at the
 *           declaration, which is where p took it, so every use forms the same address.
 *           Made only when X has no call or write, its type is a known pointer `S*`, the
 *           type of `&X->f` is p's declared type, and p is never written, addressed or tested
 *           (a test of `&b->f` is one a compiler may fold, where a test of p is not).
 *
 * A function whose name has more than one declaration, or a parameter of that name, is
 * left alone. Without a type for E (or X) nothing changes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl, Identifier,
  MemberExpr, ParameterDecl, ParenExpr, PostfixExpr, Statement, SubscriptExpr, TypeNode, UnaryExpr,
  VariableDecl, CStyleCastExpr,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { Decl, Stmt, Expr, Type } from '../../../ast/factory.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { sameShape, shapeOfNode, type TypedefResolver, type TypeShape } from './call-arg-cast.js';
import { createExprShape } from './expr-shape.js';
import { effectsOf } from './access-order-evidence.js';
import { emit } from '../../../emit/index.js';

export interface FieldPointerFoldOptions extends PluginOptions {
  functionReturnTypes?: Record<string, string>;
  globalTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  /** Type names a same-named namespace shadows: spelled `::Name`. */
  shadowedTypeNames?: string[];
  /** Every candidate: folded (no `why`) or left as printed (`why`). */
  onSite?: (e: { rule: 'single' | 'multi'; line: number; name: string; why?: string }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function pure(e: ASTNode): boolean {
  const f = effectsOf(e);
  return f.calls === 0 && f.writes === 0;
}

/** An lvalue of names, members, `*` and subscripts (casts allowed inside). */
function isPlace(e: Expression): boolean {
  e = unwrap(e);
  switch (e.kind) {
    case NodeKind.Identifier:
    case NodeKind.QualifiedId:
      return true;
    case NodeKind.MemberExpr: {
      const m = e as MemberExpr;
      if (m.member.kind !== NodeKind.Identifier) return false;
      return m.isArrow ? isValue(m.object) : isPlace(m.object);
    }
    case NodeKind.SubscriptExpr:
      return isValue((e as SubscriptExpr).array);
    case NodeKind.UnaryExpr:
      return (e as UnaryExpr).operator === '*' && isValue((e as UnaryExpr).operand);
    default:
      return false;
  }
}

/** A pointer or index value read from places (for `->` objects, `*` operands, arrays). */
function isValue(e: Expression): boolean {
  e = unwrap(e);
  if (e.kind === NodeKind.CStyleCastExpr) return isValue((e as CStyleCastExpr).expression);
  return isPlace(e);
}

/** `*p` with p the name; else false. */
function isDerefOf(e: Expression, name: string): boolean {
  e = unwrap(e);
  if (e.kind !== NodeKind.UnaryExpr || (e as UnaryExpr).operator !== '*') return false;
  const o = unwrap((e as UnaryExpr).operand);
  return o.kind === NodeKind.Identifier && (o as Identifier).name === name;
}

function isName(e: Expression, name: string): boolean {
  e = unwrap(e);
  return e.kind === NodeKind.Identifier && (e as Identifier).name === name;
}

/** An expression that may stand under a postfix operator or `->` without parentheses. */
function tight(e: Expression): Expression {
  const u = unwrap(e);
  switch (u.kind) {
    case NodeKind.Identifier: case NodeKind.QualifiedId: case NodeKind.MemberExpr: case NodeKind.SubscriptExpr:
      return u;
    default:
      return Expr.paren(u);
  }
}

/** Every Identifier that names a variable (not a member, a declarator or part of a type). */
function nameUses(root: ASTNode): Array<{ node: Identifier; parent: ASTNode | null; grand: ASTNode | null }> {
  const out: Array<{ node: Identifier; parent: ASTNode | null; grand: ASTNode | null }> = [];
  const walk = (n: ASTNode, parent: ASTNode | null, grand: ASTNode | null): void => {
    if (n.kind.endsWith('Type') && n.kind !== NodeKind.TemplateType) return;
    if (n.kind === NodeKind.TemplateType) return;
    if (n.kind === NodeKind.Identifier) { out.push({ node: n as Identifier, parent, grand }); return; }
    for (const k of getChildren(n)) {
      if (n.kind === NodeKind.MemberExpr && k === (n as MemberExpr).member) continue;
      if (n.kind === NodeKind.VariableDecl && k === (n as VariableDecl).name) continue;
      if (n.kind === NodeKind.ParameterDecl && k === (n as ParameterDecl).name) continue;
      if (n.kind === NodeKind.FunctionDecl && k === (n as FunctionDecl).name) continue;
      walk(k, n, parent);
    }
  };
  walk(root, null, null);
  return out;
}

const UPDATE_OPS = new Set(['+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

/** The update of `*name` a statement makes, rebuilt over `place`; null if it is not one. */
function foldUpdate(s: Statement, name: string, place: Expression): Expression | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind === NodeKind.PostfixExpr) {
    const p = e as PostfixExpr;
    return isDerefOf(p.operand, name) ? Expr.postfix(tight(place), p.operator) : null;
  }
  if (e.kind === NodeKind.UnaryExpr) {
    const u = e as UnaryExpr;
    if ((u.operator === '++' || u.operator === '--') && isDerefOf(u.operand, name)) {
      return Expr.unary(u.operator, tight(place));
    }
    return null;
  }
  if (e.kind === NodeKind.AssignExpr) {
    const a = e as AssignExpr;
    if (!UPDATE_OPS.has(a.operator) || !isDerefOf(a.left, name)) return null;
    if (!pure(a.right)) return null;
    for (const n of traverseAST(a.right)) if (n.kind === NodeKind.Identifier && (n as Identifier).name === name) return null;
    return Expr.assign(tight(place), a.right, a.operator);
  }
  return null;
}

function typeOfShape(shape: TypeShape, shadowed: Set<string>): TypeNode {
  let t: TypeNode = Type.typedefAt(shape.base, shadowed.has(shape.base));
  for (let i = 0; i < shape.stars; i++) t = Type.pointer(t);
  return t;
}

/** A name for the record local: the member it was read from when that is a pointer name. */
function recordName(x: Expression): string {
  const u = unwrap(x);
  if (u.kind === NodeKind.MemberExpr) {
    const m = (u as MemberExpr).member;
    if (m.kind === NodeKind.Identifier) {
      const n = (m as Identifier).name;
      if (/^p[A-Z0-9]/.test(n)) return n;
      return `p${n[0].toUpperCase()}${n.slice(1)}`;
    }
  }
  return 'pRecord';
}

function rewriteFunction(fn: FunctionDecl, opts: FieldPointerFoldOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const body = cloneNode(fn.body);
  const typedefTargets = opts.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];
  const localTypes = new Map<string, TypeNode>();
  const declCount = new Map<string, number>();
  for (const p of fn.parameters as ParameterDecl[]) {
    if (p.name && p.name.kind === NodeKind.Identifier) {
      localTypes.set(p.name.name, p.type);
      declCount.set(p.name.name, (declCount.get(p.name.name) ?? 0) + 1);
    }
  }
  const declOf = new Map<string, { stmt: DeclStmt; decl: VariableDecl }>();
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      localTypes.set(v.name.name, v.type);
      declCount.set(v.name.name, (declCount.get(v.name.name) ?? 0) + 1);
    }
    if (n.kind === NodeKind.DeclStmt) {
      const d = n as DeclStmt;
      if (d.declarations.length === 1 && d.declarations[0].kind === NodeKind.VariableDecl) {
        const v = d.declarations[0] as VariableDecl;
        declOf.set(v.name.name, { stmt: d, decl: v });
      }
    }
  }
  const shapeOf = createExprShape(localTypes, {
    globalTypes: opts.globalTypes, enclosingVarTypes: opts.enclosingVarTypes, structFields: opts.structFields,
    fieldTypes: opts.fieldTypes, returnTypes: opts.functionReturnTypes, resolve,
  });
  const shadowed = new Set(opts.shadowedTypeNames ?? []);
  const taken = new Set<string>();
  for (const u of nameUses(fn)) taken.add(u.node.name);
  for (const k of localTypes.keys()) taken.add(k);
  const fresh = (want: string): string => {
    let name = want;
    for (let i = 2; taken.has(name); i++) name = `${want}${i}`;
    taken.add(name);
    return name;
  };
  const usesOf = (name: string) => nameUses(body).filter(u => u.node.name === name);
  /** The pointer's declared type matches `&E`'s. */
  const typed = (pointerType: TypeNode, place: Expression): boolean => {
    const want = shapeOfNode(pointerType, 0, resolve);
    const have = shapeOf(unwrap(place));
    if (!want || !have || want.stars < 1) return false;
    return sameShape({ ...have, stars: have.stars + 1 }, want);
  };

  /**
   * The record the field is reached through (`X` of `X->f.g`), when it is itself a load and
   * the function reads it again: the null test that guards the update (`if (pGame->pArenaCtrl)`,
   * ARENA_ClearUpdateFlag 0053fae0) or another use. There the original held X in a local,
   * and the update through the pointer is what VC8 makes of that; folding loses the MATCH.
   */
  const recordReadElsewhere = (place: Expression): boolean => {
    let e = unwrap(place);
    while (e.kind === NodeKind.MemberExpr && !(e as MemberExpr).isArrow) e = unwrap((e as MemberExpr).object);
    while (e.kind === NodeKind.SubscriptExpr) e = unwrap((e as SubscriptExpr).array);
    if (e.kind !== NodeKind.MemberExpr) return false;
    const x = unwrap((e as MemberExpr).object);
    if (x.kind === NodeKind.Identifier || x.kind === NodeKind.ThisExpr) return false;
    const text = emit(x).trim();
    let seen = 0;
    for (const n of traverseAST(body)) {
      if (n.kind === x.kind && emit(n as Expression).trim() === text) seen++;
    }
    return seen > 1;
  };

  let changed = 0;
  // A separately declared pointer goes once none of its `p = &E; <update of *p>` pairs is left.
  const removed = new Map<ASTNode, string>();
  // Each name's `p = &E;` statements directly followed by an update of `*p`.
  const assignPairs = new Map<string, number>();
  const pairsFolded = new Map<string, number>();
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.CompoundStmt) continue;
    const st = (n as CompoundStmt).statements;
    for (let k = 0; k + 1 < st.length; k++) {
      if (st[k].kind !== NodeKind.ExprStmt) continue;
      const a = unwrap((st[k] as ExprStmt).expression);
      if (a.kind !== NodeKind.AssignExpr || (a as AssignExpr).operator !== '=') continue;
      const l = unwrap((a as AssignExpr).left), r = unwrap((a as AssignExpr).right);
      if (l.kind !== NodeKind.Identifier || r.kind !== NodeKind.UnaryExpr || (r as UnaryExpr).operator !== '&') continue;
      const nm = (l as Identifier).name;
      if (foldUpdate(st[k + 1], nm, unwrap((r as UnaryExpr).operand))) assignPairs.set(nm, (assignPairs.get(nm) ?? 0) + 1);
    }
  }
  const site = (rule: 'single' | 'multi', s: Statement, name: string, why?: string) =>
    opts.onSite?.({ rule, line: s.location?.start.line ?? 0, name, ...(why ? { why } : {}) });

  const trySingle = (block: CompoundStmt, i: number): boolean => {
    const s = block.statements[i];
    const next = block.statements[i + 1];
    let name: string, init: Expression, pointerType: TypeNode, expectUses: number;
    let separate: { stmt: DeclStmt; decl: VariableDecl } | undefined;
    if (s.kind === NodeKind.DeclStmt) {
      const d = s as DeclStmt;
      if (d.declarations.length !== 1 || d.declarations[0].kind !== NodeKind.VariableDecl) return false;
      const v = d.declarations[0] as VariableDecl;
      if (!v.initializer) return false;
      name = v.name.name; init = v.initializer; pointerType = v.type; expectUses = 1;
    } else if (s.kind === NodeKind.ExprStmt) {
      const a = unwrap((s as ExprStmt).expression);
      if (a.kind !== NodeKind.AssignExpr || (a as AssignExpr).operator !== '=') return false;
      const left = unwrap((a as AssignExpr).left);
      if (left.kind !== NodeKind.Identifier) return false;
      name = (left as Identifier).name; init = (a as AssignExpr).right;
      separate = declOf.get(name);
      if (!separate || separate.decl.initializer) return false;
      pointerType = separate.decl.type; expectUses = 2 * ((assignPairs.get(name) ?? 0) - (pairsFolded.get(name) ?? 0));
    } else return false;
    const addr = unwrap(init);
    if (addr.kind !== NodeKind.UnaryExpr || (addr as UnaryExpr).operator !== '&') return false;
    const place = unwrap((addr as UnaryExpr).operand);
    if (!next) return false;
    const folded = foldUpdate(next, name, place);
    if (!folded) return false;
    if (declCount.get(name) !== 1) { site('single', s, name, 'declared more than once'); return false; }
    if (!isPlace(place) || !pure(place)) { site('single', s, name, 'not a pure place'); return false; }
    if (nameUses(place).some(u => u.node.name === name)) { site('single', s, name, 'place names the pointer'); return false; }
    if (usesOf(name).length !== expectUses) { site('single', s, name, 'named elsewhere'); return false; }
    if (recordReadElsewhere(place)) { site('single', s, name, 'record read elsewhere'); return false; }
    if (!typed(pointerType, place)) { site('single', s, name, 'type of the place unknown or different'); return false; }
    const stmt: ExprStmt = Stmt.expr(folded);
    stmt.location = next.location;
    stmt.leadingTrivia = [...(s.leadingTrivia ?? []), ...(next.leadingTrivia ?? [])];
    stmt.trailingTrivia = next.trailingTrivia;
    block.statements.splice(i, 2, stmt);
    if (separate) { removed.set(separate.stmt, name); pairsFolded.set(name, (pairsFolded.get(name) ?? 0) + 1); }
    changed++;
    site('single', s, name);
    return true;
  };

  /**
   * Why the pointer's uses cannot be rewritten, or null: it is written, its address taken,
   * or it is tested as a pointer (`!p`, `p && ..`, `p == 0`, a condition). A test of `&E`
   * is one a compiler may fold to true, where the test of the variable it replaces is not.
   */
  const usesBlocked = (name: string): string | null => {
    for (const n of traverseAST(body)) {
      const kids = getChildren(n).map(k => {
        let c = k;
        while (c.kind === NodeKind.ParenExpr) c = (c as ParenExpr).expression;
        return { k, c };
      });
      for (const { k, c } of kids) {
        if (!isName(c as Expression, name) || n.kind === NodeKind.ParenExpr) continue;
        if (n.kind === NodeKind.MemberExpr && k === (n as MemberExpr).member) continue;
        if (n.kind === NodeKind.VariableDecl && k === (n as VariableDecl).name) continue;
        if (n.kind === NodeKind.AssignExpr && k === (n as AssignExpr).left) return 'pointer written or addressed';
        if (n.kind === NodeKind.PostfixExpr) return 'pointer written or addressed';
        if (n.kind === NodeKind.UnaryExpr) {
          const op = (n as UnaryExpr).operator;
          if (op === '&' || op === '++' || op === '--') return 'pointer written or addressed';
          if (op === '!') return 'pointer tested';
        }
        if (n.kind === NodeKind.BinaryExpr && ['&&', '||', '==', '!='].includes((n as BinaryExpr).operator)) return 'pointer tested';
        if ((n.kind === NodeKind.IfStmt || n.kind === NodeKind.WhileStmt || n.kind === NodeKind.DoWhileStmt
          || n.kind === NodeKind.ForStmt || n.kind === NodeKind.ConditionalExpr)
          && k === (n as { condition?: ASTNode }).condition) return 'pointer tested';
      }
    }
    return null;
  };

  /** Each use of `name` after statement i: `*p` -> place, `p->g` -> place.g, else &place. */
  const substitute = (block: CompoundStmt, i: number, name: string, place: () => Expression): void => {
    const replace = (n: ASTNode): ASTNode => {
      if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '*' && isName((n as UnaryExpr).operand, name)) {
        return place();
      }
      if (n.kind === NodeKind.MemberExpr && (n as MemberExpr).isArrow && isName((n as MemberExpr).object, name)) {
        return { ...(n as MemberExpr), object: tight(place()), isArrow: false } as MemberExpr;
      }
      if (n.kind === NodeKind.Identifier && (n as Identifier).name === name) return Expr.paren(Expr.addressOf(place()));
      return n;
    };
    const rewrite = (n: ASTNode): void => {
      for (const [key, val] of Object.entries(n)) {
        if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia') continue;
        if (n.kind === NodeKind.MemberExpr && key === 'member') continue;
        if (n.kind === NodeKind.VariableDecl && key === 'name') continue;
        if (Array.isArray(val)) {
          for (let k = 0; k < val.length; k++) {
            const c = val[k];
            if (c && typeof c === 'object' && typeof (c as ASTNode).kind === 'string') {
              if ((c as ASTNode).kind.endsWith('Type')) continue;
              const r = replace(c as ASTNode);
              if (r !== c) val[k] = r; else rewrite(c as ASTNode);
            }
          }
        } else if (val && typeof val === 'object' && typeof (val as ASTNode).kind === 'string') {
          if ((val as ASTNode).kind.endsWith('Type')) continue;
          const r = replace(val as ASTNode);
          if (r !== val) (n as unknown as Record<string, unknown>)[key] = r; else rewrite(val as ASTNode);
        }
      }
    };
    for (let k = i + 1; k < block.statements.length; k++) rewrite(block.statements[k]);
  };

  /** `T* p = &E;`: its declaration, name, and E. */
  const pointerDecl = (s: Statement): { v: VariableDecl; name: string; place: Expression } | null => {
    if (s.kind !== NodeKind.DeclStmt) return null;
    const d = s as DeclStmt;
    if (d.declarations.length !== 1 || d.declarations[0].kind !== NodeKind.VariableDecl) return null;
    const v = d.declarations[0] as VariableDecl;
    if (!v.initializer) return null;
    const addr = unwrap(v.initializer);
    if (addr.kind !== NodeKind.UnaryExpr || (addr as UnaryExpr).operator !== '&') return null;
    return { v, name: v.name.name, place: unwrap((addr as UnaryExpr).operand) };
  };

  const tryMulti = (block: CompoundStmt, i: number): boolean => {
    const s = block.statements[i];
    const pd = pointerDecl(s);
    if (!pd) return false;
    const { v, name, place } = pd;
    if (place.kind !== NodeKind.MemberExpr || !(place as MemberExpr).isArrow) return false;
    const member = (place as MemberExpr).member;
    if (member.kind !== NodeKind.Identifier) return false;
    const x = unwrap((place as MemberExpr).object);
    const load = x.kind === NodeKind.MemberExpr || x.kind === NodeKind.SubscriptExpr
      || (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*');
    if (!load) return false;
    const uses = usesOf(name);
    if (uses.length < 2) return false;
    if (declCount.get(name) !== 1) { site('multi', s, name, 'declared more than once'); return false; }
    if (!isValue(x) || !pure(x)) { site('multi', s, name, 'record is not a pure load'); return false; }
    const blocked = usesBlocked(name);
    if (blocked) { site('multi', s, name, blocked); return false; }
    const xs = shapeOf(x);
    if (!xs || xs.stars !== 1 || xs.isConst || xs.base === 'void') { site('multi', s, name, 'record type unknown'); return false; }
    if (!typed(v.type, place)) { site('multi', s, name, 'type of the field unknown or different'); return false; }

    const b = fresh(recordName(x));
    const fieldName = (member as Identifier).name;
    substitute(block, i, name, () => Expr.member(Expr.identifier(b), fieldName, true));
    const decl = Decl.variable(b, typeOfShape(xs, shadowed), cloneNode(x));
    const ds: DeclStmt = Stmt.declStmt([decl]);
    ds.location = s.location;
    ds.leadingTrivia = s.leadingTrivia;
    ds.trailingTrivia = s.trailingTrivia;
    block.statements[i] = ds;
    changed++;
    site('multi', s, name);
    return true;
  };

  const visitBlock = (block: CompoundStmt): void => {
    for (let i = 0; i < block.statements.length; i++) {
      for (const k of getChildren(block.statements[i])) visitAll(k);
    }
    for (let i = 0; i < block.statements.length; i++) {
      if (trySingle(block, i)) { i--; continue; }
      tryMulti(block, i);
    }
  };
  const visitAll = (n: ASTNode): void => {
    if (n.kind === NodeKind.CompoundStmt) { visitBlock(n as CompoundStmt); return; }
    for (const k of getChildren(n)) visitAll(k);
  };
  visitAll(body);
  if (!changed) return undefined;
  for (const [stmt, name] of [...removed]) if (usesOf(name).length) removed.delete(stmt);
  if (removed.size) {
    const drop = (n: ASTNode): void => {
      if (n.kind === NodeKind.CompoundStmt) {
        const c = n as CompoundStmt;
        (c as { statements: Statement[] }).statements = c.statements.filter(s => !removed.has(s));
      }
      for (const k of getChildren(n)) drop(k);
    };
    drop(body);
  }
  return updateNode(fn, { body } as Partial<FunctionDecl>);
}

function createFieldPointerFoldTransformer(options: FieldPointerFoldOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  });
}

export const fieldPointerFoldPlugin: TransformPlugin = {
  id: 'field-pointer-fold',
  name: 'Field Pointer Fold',
  description:
    'A pointer temporary to a field goes: an in-place update of the field, or the record held and the field addressed at each use',
  version: '1.0.0',
  defaultEnabled: true,
  // After decl-init-merge (60) has joined `T* p; p = &E;`, after decl-scope-sink (62) has
  // put declarations next to their use; before phi-node-ternary (63).
  priority: 62.5,
  tags: ['matching'],
  createTransformer: createFieldPointerFoldTransformer,
};
