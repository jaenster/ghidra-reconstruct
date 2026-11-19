/**
 * SEH-Lowering Plugin
 *
 * MSVC compiles `__try { B } __except (F) { H }` into an inline registration on
 * fs:[0] (EH3: `push -1; push <scope table>; push _except_handler3`; EH4: `push -2;
 * push <scope table>; push __except_handler4` with the table XORed with the /GS
 * cookie), a try-level store `[ebp-4] = 0` before B and `[ebp-4] = -1` (EH4: -2)
 * after it, and two funclets the scope table points at: the filter (which returns F)
 * and the handler (which reloads ESP from `[ebp-0x18]` and runs H). Ghidra types the
 * record and prints the stores:
 *
 *     tSehFrame.ScopeTable = gaWardenDecryptModuleScopeTable;
 *     tSehFrame.ExceptionHandler = compiler::_except_handler3;
 *     tSehFrame.Next = ExceptionList;
 *     tSehFrame.TryLevel = 0;
 *     ExceptionList = &tSehFrame;
 *     ... B ...
 *   LAB_004e0980:
 *     tSehFrame.TryLevel = -1;
 *     ...
 *     ExceptionList = tSehFrame.Next;
 *
 * and nothing of the funclets, which no flow reaches. This pass puts the source
 * construct back, spelled with the d2_platform.h macros (a real `__try` under
 * _MSC_VER; the bare body elsewhere, which is what the Mac build of the same source
 * compiled to):
 *
 *     // __try / __except (EXCEPTION_EXECUTE_HANDLER): scope table ..., filter ...
 *     D2_SEH_TRY
 *       ... B ...
 *     D2_SEH_EXCEPT(EXCEPTION_EXECUTE_HANDLER)
 *     D2_SEH_END
 *   LAB_004e0980:
 *
 * What the instructions say about the funclets arrives as options (the generator
 * reads them off the extraction): the filter's constant, and where the handler
 * resumes. Only the shape that is proven is lowered:
 *  - one scope, level 0 enclosed by the outside level, entered once;
 *  - the scope is left by the one store of the outside level in the same block, or
 *    (when the instructions show the handler resuming at a leave store that only
 *    precedes the deregistration, a store the decompiler drops as dead) at the end of
 *    that block, with nothing but the deregistration after it up to the function end;
 *  - the handler resumes at the try's own exit, so the `__except` block is empty and
 *    both paths continue after the region; when the decompiler put a label there
 *    (`LAB_<resume>`) the region ends at that label;
 *  - every use of the record and of `ExceptionList` is one of the stores above;
 *  - no goto from outside the region targets a label inside it, and no declaration
 *    the region holds is used after it unless it can be declared in front of it.
 * Anything else is reported and left as Ghidra printed it.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, DeclStmt, ExprStmt, Expression, FunctionDecl, GotoStmt,
  Identifier, IfStmt, IntegerLiteralExpr, LabelStmt, MemberExpr, SehTryStmt, Statement, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { TriviaKind } from '../../../lexer/trivia.js';
import { emit } from '../../../emit/index.js';
import type { Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface SehLoweringScope {
  /** `__except` (the default) or `__finally`. */
  kind?: 'except' | 'finally';
  /**
   * `__finally`: the termination handler's body. The decompiler prints it inlined
   * between the -1 store and the deregistration (the normal path CALLs it there).
   */
  bodyAddress?: string;
  /** Try level of the scope (its index in the scope table). */
  level: number;
  /** The filter funclet's constant result: 1 execute handler, 0 continue search, -1 continue execution. */
  filter: number;
  filterAddress: string;
  handlerAddress: string;
  /** The address the handler resumes at: the try level store that leaves the scope. */
  resumeAddress: string;
  scopeTable: string;
  /** The registration's layout: EH3 (`_except_handler3`, outside = -1) or EH4 (`__except_handler4`, -2). */
  frame?: 'eh3' | 'eh4';
  /**
   * The handler resumes at the store that leaves the scope, and only the frame's
   * deregistration follows that store: the decompiler may drop it as dead.
   */
  leaveDeregisters?: boolean;
}

export interface SehLoweringOptions extends PluginOptions {
  sehScopes?: SehLoweringScope[];
  /** Told why a frame was left as printed. */
  onRefusal?: (reason: string) => void;
}

const FRAME_TYPE = 'EH3_EXCEPTION_REGISTRATION';
const FRAME_TYPE_EH4 = 'EH4_EXCEPTION_REGISTRATION';
const LIST = 'ExceptionList';

function identName(e: ASTNode | null | undefined): string | undefined {
  if (!e) return undefined;
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name;
  if (e.kind === NodeKind.QualifiedId) {
    const q = e as unknown as { qualifier: ASTNode[]; name: ASTNode };
    if (q.qualifier.length === 0 && q.name.kind === NodeKind.Identifier) return (q.name as Identifier).name;
  }
  if (e.kind === NodeKind.ParenExpr) return identName((e as unknown as { expression: Expression }).expression);
  return undefined;
}

/**
 * `(EH3_EXCEPTION_REGISTRATION*)ExceptionList`: the cast `assign-cast` writes where C
 * converted the TEB's `void*` into the typed link implicitly. It is the same load.
 */
function withoutCast(e: Expression): Expression {
  let cur = e;
  while (cur.kind === NodeKind.CStyleCastExpr || cur.kind === NodeKind.ParenExpr) {
    cur = (cur as unknown as { expression: Expression }).expression;
  }
  return cur;
}

function constValue(e: Expression): number | undefined {
  switch (e.kind) {
    case NodeKind.IntegerLiteral: {
      const v = Number(BigInt.asIntN(32, (e as IntegerLiteralExpr).value));
      return v;
    }
    case NodeKind.UnaryExpr: {
      const u = e as UnaryExpr;
      if (u.operator !== '-') return undefined;
      const v = constValue(u.operand);
      return v === undefined ? undefined : -v;
    }
    case NodeKind.ParenExpr:
      return constValue((e as unknown as { expression: Expression }).expression);
    case NodeKind.CStyleCastExpr:
      return constValue((e as unknown as { expression: Expression }).expression);
    default:
      return undefined;
  }
}

type FrameUse =
  | { kind: 'field'; field: string; value: Expression }
  | { kind: 'register' }
  | { kind: 'deregister' };

/** What a statement does with the frame `F`, when it is one of the recognised stores. */
function frameUse(s: Statement, frame: string): FrameUse | undefined {
  if (s.kind !== NodeKind.ExprStmt) return undefined;
  const e = (s as ExprStmt).expression;
  if (e.kind !== NodeKind.AssignExpr) return undefined;
  const a = e as AssignExpr;
  if (a.operator !== '=') return undefined;
  if (a.left.kind === NodeKind.MemberExpr) {
    const m = a.left as MemberExpr;
    if (m.isArrow || identName(m.object) !== frame || m.member.kind !== NodeKind.Identifier) return undefined;
    return { kind: 'field', field: (m.member as Identifier).name, value: a.right };
  }
  if (identName(a.left) !== LIST) return undefined;
  if (a.right.kind === NodeKind.UnaryExpr) {
    const u = a.right as UnaryExpr;
    if (u.operator === '&' && identName(u.operand) === frame) return { kind: 'register' };
    return undefined;
  }
  if (a.right.kind === NodeKind.MemberExpr) {
    const m = a.right as MemberExpr;
    if (!m.isArrow && identName(m.object) === frame && m.member.kind === NodeKind.Identifier
      && (m.member as Identifier).name === 'Next') return { kind: 'deregister' };
  }
  return undefined;
}

function typeText(t: ASTNode): string {
  try { return emit(t as never).replace(/\s+/g, ' ').trim(); } catch { return ''; }
}

/** Every statement, at any depth, with the list that holds it. */
function* statementsIn(node: ASTNode): Generator<Statement> {
  for (const c of findNodesByKind(node, NodeKind.ExprStmt)) yield c as Statement;
}

function lineComment(text: string, at: ASTNode) {
  return { kind: TriviaKind.LineComment, text: `// ${text}`, location: at.location };
}

/** Remove the given statements wherever they sit; a lone branch becomes `;`. */
function removeStatements(root: ASTNode, doomed: Set<ASTNode>): void {
  const visit = (n: ASTNode): void => {
    if (!n || typeof n !== 'object') return;
    if (n.kind === NodeKind.CompoundStmt) {
      const c = n as CompoundStmt;
      c.statements = c.statements.filter(s => !doomed.has(s));
    }
    for (const [key, child] of Object.entries(n)) {
      if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia') continue;
      if (Array.isArray(child)) {
        for (let i = 0; i < child.length; i++) {
          const x = child[i];
          if (x && typeof x === 'object' && 'kind' in x) {
            if (doomed.has(x)) child[i] = Stmt.null_();
            else visit(x as ASTNode);
          }
        }
      } else if (child && typeof child === 'object' && 'kind' in child) {
        if (doomed.has(child as ASTNode)) (n as unknown as Record<string, unknown>)[key] = Stmt.null_();
        else visit(child as ASTNode);
      }
    }
  };
  visit(root);
}

/** The compound statement whose own list holds `s`, at any depth. */
function containingList(root: ASTNode, s: Statement): CompoundStmt | undefined {
  for (const c of findNodesByKind(root, NodeKind.CompoundStmt) as CompoundStmt[]) {
    if (c.statements.includes(s)) return c;
  }
  return undefined;
}

/** The chain of compound statements from the body down to `inner` (both included), or undefined. */
function blockPath(body: CompoundStmt, inner: CompoundStmt): CompoundStmt[] | undefined {
  if (body === inner) return [body];
  for (const s of body.statements) {
    const blocks = [s, ...findNodesByKind(s, NodeKind.CompoundStmt)] as ASTNode[];
    for (const c of blocks) {
      if (c.kind !== NodeKind.CompoundStmt) continue;
      if (c === inner || findNodesByKind(c, NodeKind.CompoundStmt).includes(inner)) {
        const rest = blockPath(c as CompoundStmt, inner);
        if (rest) return [body, ...rest];
      }
    }
  }
  return undefined;
}

function filterSpelling(filter: number): Expression {
  if (filter === 1) return Expr.identifier('EXCEPTION_EXECUTE_HANDLER');
  if (filter === 0) return Expr.identifier('EXCEPTION_CONTINUE_SEARCH');
  if (filter === -1) return Expr.identifier('EXCEPTION_CONTINUE_EXECUTION');
  return Expr.intLiteral(filter);
}

function sehTryStmt(at: ASTNode, body: Statement[], kind: 'except' | 'finally', filter: Expression | null, handler: Statement[]): SehTryStmt {
  return {
    kind: NodeKind.SehTryStmt, location: at.location, leadingTrivia: [], trailingTrivia: [],
    body: Stmt.compound(body), handlerKind: kind, filter, handler: Stmt.compound(handler), macro: true,
  } as unknown as SehTryStmt;
}

/** The statement of the body that holds `inner` (at any depth). */
function path0(body: CompoundStmt, inner: CompoundStmt): Statement {
  return body.statements.find(s => s === inner || findNodesByKind(s, NodeKind.CompoundStmt).includes(inner)) ?? body.statements[0];
}

/** Does `s` hold `block` as one of its own branches or bodies (not deeper)? */
function holdsDirectly(s: Statement, block: CompoundStmt): boolean {
  if (s === block) return true;
  if (s.kind === NodeKind.IfStmt) return (s as IfStmt).thenBranch === block;
  return false;
}

function lower(fn: FunctionDecl, scopes: SehLoweringScope[], refuse: (r: string) => void): boolean {
  const body = fn.body;
  if (!body) return false;
  if (scopes.length !== 1 || scopes[0].level !== 0) return refuse('only a single level-0 scope is lowered'), false;
  const scope = scopes[0];
  const eh4 = scope.frame === 'eh4';
  const frameType = eh4 ? FRAME_TYPE_EH4 : FRAME_TYPE;
  const outside = eh4 ? -2 : -1;

  // The registration record: a local of the EH3/EH4 type.
  const frames = body.statements
    .filter((s): s is DeclStmt => s.kind === NodeKind.DeclStmt)
    .flatMap(d => d.declarations)
    .filter((d): d is VariableDecl => d.kind === NodeKind.VariableDecl && typeText((d as VariableDecl).type) === frameType);
  if (frames.length !== 1) return refuse(`${frames.length} locals of type ${frameType}`), false;
  const frame = frames[0].name.name;

  // Every statement that touches the record or the list must be a recognised store.
  const uses = new Map<Statement, FrameUse>();
  for (const s of statementsIn(body)) {
    const u = frameUse(s, frame);
    if (u) uses.set(s, u);
  }
  const usedIn = new Set<ASTNode>();
  for (const s of uses.keys()) for (const id of findNodesByKind(s, NodeKind.Identifier)) usedIn.add(id);
  for (const id of findNodesByKind(body, NodeKind.Identifier) as Identifier[]) {
    if ((id.name === frame || id.name === LIST) && !usedIn.has(id) && id !== frames[0].name) {
      return refuse(`an unrecognised use of ${id.name}`), false;
    }
  }

  const top = body.statements;
  const atTop = (s: Statement) => top.indexOf(s);
  const tryLevel = [...uses].filter(([, u]) => u.kind === 'field' && u.field === 'TryLevel');
  const enter = tryLevel.filter(([, u]) => u.kind === 'field' && constValue(u.value) === scope.level);
  const leaveAll = tryLevel.filter(([, u]) => u.kind === 'field' && constValue(u.value) === outside);
  const registers = [...uses].filter(([, u]) => u.kind === 'register');
  if (registers.length !== 1) return refuse(`${registers.length} registrations`), false;
  const ri = atTop(registers[0][0]);
  if (ri < 0) return refuse('the registration is not a statement of the body'), false;
  // EH4 opens with the record's TryLevel at -2 (the prologue's `push -2`), before the
  // registration: that store is the frame's setup, not the end of a scope.
  const leave = leaveAll.filter(([s]) => !(eh4 && atTop(s) >= 0 && atTop(s) < ri));
  if (enter.length !== 1 || leave.length > 1 || tryLevel.length !== enter.length + leaveAll.length
      || leaveAll.length - leave.length > (eh4 ? 1 : 0) || (!eh4 && leave.length !== 1)) {
    return refuse(`try level stores: ${tryLevel.length} (enter ${enter.length}, leave ${leave.length})`), false;
  }
  const list = containingList(body, enter[0][0]);
  if (!list) return refuse('the try level store is not a statement'), false;
  const stmts = list.statements;
  const i0 = stmts.indexOf(enter[0][0]);
  let i1: number;
  if (leave.length === 1) {
    i1 = stmts.indexOf(leave[0][0]);
    if (i1 <= i0) return refuse('the try level stores are not statements of one block, in order'), false;
  } else {
    // The decompiler drops the store that leaves the scope when only the deregistration
    // follows it (the instructions say so: the handler resumes at that store and the
    // frame is popped right after it). The scope then runs to the end of its block, and
    // everything after the block up to the function's end must be that deregistration.
    if (!scope.leaveDeregisters) return refuse('no store leaves the scope'), false;
    i1 = stmts.length;
    const path = blockPath(body, list);
    if (!path) return refuse('the scope block is not reachable from the body'), false;
    for (let d = path.length - 1; d > 0; d--) {
      const outer = path[d - 1];
      const holder = outer.statements.findIndex(s => holdsDirectly(s, path[d]));
      if (holder < 0) return refuse('the scope block is not a plain block or an if without else'), false;
      const h = outer.statements[holder];
      if (h.kind === NodeKind.IfStmt && (h as IfStmt).elseBranch) return refuse('the scope block has an else'), false;
      if (outer.statements.slice(holder + 1).some(s => !uses.has(s) && s.kind !== NodeKind.NullStmt)) {
        return refuse('code follows the scope block besides the deregistration'), false;
      }
    }
  }
  for (const [s, u] of uses) {
    if (u.kind !== 'field' || u.field === 'TryLevel') continue;
    if (!['ScopeTable', 'EncodedScopeTable', 'ExceptionHandler', 'Next'].includes(u.field)) return refuse(`a store to ${frame}.${u.field}`), false;
    if (u.field === 'Next' && identName(withoutCast(u.value)) !== LIST) return refuse(`${frame}.Next is not ExceptionList`), false;
    if (atTop(s) < 0 || (list === body && atTop(s) > i0)) return refuse(`${frame}.${u.field} is set inside the region`), false;
  }

  // The region ends where the handler resumes: the label the decompiler put on the
  // exit, else the leave store itself.
  const resumeLabel = `LAB_${scope.resumeAddress.toLowerCase().padStart(8, '0')}`;
  let iEnd = i1;
  for (let k = i0 + 1; k < i1; k++) {
    const s = stmts[k];
    if (s.kind === NodeKind.LabelStmt && (s as LabelStmt).label.name === resumeLabel) { iEnd = k; break; }
  }
  // The decompiler may print the registration just after the level store: it is part of
  // the frame's setup either way, and it must not come after the region.
  if (list === body ? ri > iEnd : ri > atTop(path0(body, list))) return refuse('the registration follows the region'), false;
  const region = stmts.slice(i0 + 1, iEnd).filter(s => s !== registers[0][0]);
  if (leave.length === 0
      && region.some(st => st.kind === NodeKind.ReturnStmt || findNodesByKind(st, NodeKind.ReturnStmt).length > 0)) {
    // With no exit store, a return inside is the decompiler's copy of the tail, not a
    // return the __try made: refused rather than guessed.
    return refuse('a return inside a scope with no exit store'), false;
  }

  // __finally: the block is what the decompiler inlined between the leave store and
  // the deregistration (the instructions prove nothing else is there). The __try may
  // only be left by its end: a return or a goto out would be an abnormal termination.
  const isFinally = scope.kind === 'finally';
  let finallyStmts: Statement[] = [];
  let iTail = iEnd;
  if (isFinally) {
    if (list !== body || leave.length !== 1) return refuse('a __finally scope must be statements of the body'), false;
    const deregs = [...uses].filter(([, u]) => u.kind === 'deregister');
    if (deregs.length !== 1) return refuse(`${deregs.length} deregistrations; a __finally has the one after its block`), false;
    const iD = atTop(deregs[0][0]);
    if (iD <= i1) return refuse('the deregistration is not a statement after the __try'), false;
    finallyStmts = top.slice(i1 + 1, iD);
    iTail = iD;
    if (region.some(st => findNodesByKind(st, NodeKind.ReturnStmt).length > 0 || st.kind === NodeKind.ReturnStmt)) {
      return refuse('a return leaves the __try (an abnormal termination)'), false;
    }
    const regionLabels = new Set<string>();
    for (const st of region) for (const l of findNodesByKind(st, NodeKind.LabelStmt)) regionLabels.add((l as LabelStmt).label.name);
    for (const st of region) {
      for (const g of findNodesByKind(st, NodeKind.GotoStmt) as GotoStmt[]) {
        if (!regionLabels.has(g.label.name)) return refuse(`goto ${g.label.name} leaves the __try (an abnormal termination)`), false;
      }
    }
    // The block is a block of its own in every spelling: a declaration in it may stay
    // there only when nothing after the block names it.
    const tailNames = new Set<string>();
    for (const st of top.slice(iD)) for (const id of findNodesByKind(st, NodeKind.Identifier) as Identifier[]) tailNames.add(id.name);
    for (const st of finallyStmts) {
      if (st.kind === NodeKind.DeclStmt && (st as DeclStmt).declarations.some(d => d.kind === NodeKind.VariableDecl && tailNames.has((d as VariableDecl).name.name))) {
        return refuse('a declaration in the __finally block is used after it'), false;
      }
      if (st.kind === NodeKind.LabelStmt || st.kind === NodeKind.ReturnStmt
        || findNodesByKind(st, NodeKind.ReturnStmt).length > 0 || findNodesByKind(st, NodeKind.GotoStmt).length > 0
        || findNodesByKind(st, NodeKind.LabelStmt).length > 0) {
        return refuse('the __finally block labels, returns or jumps'), false;
      }
    }
  }

  // No entry into the region except from its top.
  const inside = new Set<string>();
  for (const s of region) for (const l of findNodesByKind(s, NodeKind.LabelStmt)) inside.add((l as LabelStmt).label.name);
  const regionGotos = new Set<ASTNode>();
  for (const s of region) for (const g of findNodesByKind(s, NodeKind.GotoStmt)) regionGotos.add(g);
  for (const g of findNodesByKind(body, NodeKind.GotoStmt) as GotoStmt[]) {
    if (!regionGotos.has(g) && inside.has(g.label.name)) return refuse(`goto ${g.label.name} enters the region`), false;
  }
  // A declaration the region holds would go out of scope at its end. One the code
  // outside the region still names moves in front of the scope: as it stands when it
  // has no initializer, split into `T x;` there and `x = init;` in place when it has a
  // plain one. Declaring earlier changes nothing a value depends on.
  const regionSet = new Set<ASTNode>(region);
  const outsideNames = new Set<string>();
  const collectOutside = (n: ASTNode): void => {
    if (regionSet.has(n)) return;
    if (n.kind === NodeKind.Identifier) outsideNames.add((n as Identifier).name);
    for (const [key, child] of Object.entries(n)) {
      if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia') continue;
      if (Array.isArray(child)) { for (const x of child) if (x && typeof x === 'object' && 'kind' in x) collectOutside(x as ASTNode); }
      else if (child && typeof child === 'object' && 'kind' in child) collectOutside(child as ASTNode);
    }
  };
  collectOutside(body);
  const hoisted: Statement[] = [];
  for (let k = 0; k < region.length; k++) {
    const s = region[k];
    if (s.kind !== NodeKind.DeclStmt) continue;
    const decls = (s as DeclStmt).declarations;
    if (!decls.some(d => d.kind === NodeKind.VariableDecl && outsideNames.has((d as VariableDecl).name.name))) continue;
    const keep: Statement[] = [];
    for (const d of decls) {
      if (d.kind !== NodeKind.VariableDecl) return refuse('a declaration in the region is not a variable'), false;
      const v = d as VariableDecl;
      if (!v.initializer) { hoisted.push(Stmt.declStmt([v])); continue; }
      const t = typeText(v.type);
      if (v.directInit || v.initializer.kind === NodeKind.InitListExpr || /[&\[]|\bconst\b|\bstatic\b/.test(t)
        || v.specifiers.length > 0) {
        return refuse(`${v.name.name} is declared in the region and used after it`), false;
      }
      hoisted.push(Stmt.declStmt([{ ...v, initializer: null } as VariableDecl]));
      keep.push(Stmt.expr(Expr.assign(Expr.identifier(v.name.name), v.initializer as Expression)));
    }
    region.splice(k, 1, ...keep);
    k += keep.length - 1;
  }

  // The stores the scope replaces: the record's setup, the try levels, the
  // registration and every deregistration.
  const doomed = new Set<ASTNode>();
  for (const [s] of uses) doomed.add(s);
  // The record itself: every use of it is one of those stores.
  const frameDecl = frames[0];
  for (const st of body.statements) {
    if (st.kind !== NodeKind.DeclStmt) continue;
    const ds = st as DeclStmt;
    if (!ds.declarations.includes(frameDecl)) continue;
    if (ds.declarations.length === 1) doomed.add(st);
    else ds.declarations = ds.declarations.filter(d => d !== frameDecl);
  }

  if (isFinally) {
    const seh = sehTryStmt(body, region, 'finally', null, finallyStmts);
    seh.leadingTrivia = [
      lineComment(`__try / __finally: scope table ${scope.scopeTable}; the termination handler ${scope.handlerAddress} and the normal path both run ${scope.bodyAddress}`, seh),
    ];
    const before = top.slice(0, i0).filter(s => !doomed.has(s));
    const tail = top.slice(iTail).filter(s => !doomed.has(s));
    body.statements = [...before, ...hoisted, seh, ...tail];
    removeStatements(body, doomed);
    return true;
  }

  const filterWord = scope.filter > 0 ? 'EXCEPTION_EXECUTE_HANDLER' : scope.filter < 0 ? 'EXCEPTION_CONTINUE_EXECUTION' : 'EXCEPTION_CONTINUE_SEARCH';
  const seh = sehTryStmt(list, region, 'except', filterSpelling(scope.filter), []);
  seh.leadingTrivia = [
    lineComment(`__try / __except (${filterWord}): scope table ${scope.scopeTable}, filter ${scope.filterAddress}; the handler ${scope.handlerAddress} resumes at ${scope.resumeAddress}, after the __try`, seh),
  ];
  const before = stmts.slice(0, i0).filter(s => !doomed.has(s));
  const afterRegion = stmts.slice(iEnd).filter(s => !doomed.has(s));
  list.statements = [...before, ...hoisted, seh, ...afterRegion];
  removeStatements(body, doomed);
  return true;
}

function createSehLoweringTransformer(options: SehLoweringOptions = {}): Transformer {
  const scopes = options.sehScopes ?? [];
  if (scopes.length === 0) return (n: ASTNode) => n;
  return (root: ASTNode) => {
    // The lowering edits statement lists in place, so it works on its own copy and
    // hands back the original when it refuses.
    const copy = structuredClone(root);
    const fn = (findNodesByKind(copy, NodeKind.FunctionDecl) as FunctionDecl[]).find(f => f.body);
    if (!fn) return root;
    return lower(fn, scopes, r => options.onRefusal?.(r)) ? copy : root;
  };
}

import { createPlugin } from '../registry.js';

export const sehLoweringPlugin: TransformPlugin = createPlugin(
  'seh-lowering',
  'SEH Lowering',
  'Puts an MSVC EH3/EH4 __try/__except/__finally frame back as the D2_SEH_TRY macros (a real __try under MSVC)',
  (options?: PluginOptions) => createSehLoweringTransformer(options as SehLoweringOptions),
  {
    // After the structural passes (goto-cleanup and the loop passes would otherwise
    // move code across the region's edges), before the label passes at 690+.
    priority: 680,
    defaultEnabled: true,
    tags: ['correctness', 'cpp'],
    version: '1.0.0',
  }
);
