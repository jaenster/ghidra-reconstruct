/**
 * SEH-Lowering Plugin
 *
 * MSVC compiles `__try { B } __except (F) { H }` into an inline registration on
 * fs:[0] (EH3: `push -1; push <scope table>; push _except_handler3; push fs:[0];
 * mov fs:[0],esp`), a try-level store `[ebp-4] = 0` before B and `[ebp-4] = -1`
 * after it, and two funclets the scope table points at: the filter (which returns
 * F) and the handler (which reloads ESP from `[ebp-0x18]` and runs H). Ghidra types
 * the record and prints the stores:
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
 * and nothing of the funclets, which no flow reaches. In the rebuild `ExceptionList`
 * is an ordinary global, so the stores register nothing and no filter or handler
 * ever runs. This pass puts the `__try` back, on `D2SehScope` from d2_platform.h (a
 * real fs:[0] registration whose handler runs the filter, unwinds and resumes the
 * `__except` block through `__builtin_setjmp`):
 *
 *     {
 *       D2SehScope __seh0(1);
 *       if (D2_SEH_SETJMP(__seh0) == 0) {
 *         __seh0.Enter();
 *         ... B ...
 *       } else {
 *       }
 *     }
 *   LAB_004e0980:
 *
 * What the instructions say about the funclets arrives as options (the generator
 * reads them off the extraction): the filter's constant, and where the handler
 * resumes. Only the shape that is proven is lowered:
 *  - one scope, level 0 enclosed by -1, both try-level stores printed once each,
 *    as statements of the function body itself, in order;
 *  - the handler resumes at the try's own exit (the -1 store), so the `__except`
 *    block is empty and both paths continue after the region; when the decompiler
 *    put a label there (`LAB_<resume>`) the region ends at that label;
 *  - every use of the record and of `ExceptionList` is one of the stores above;
 *  - no goto from outside the region targets a label inside it, and no
 *    declaration the region holds is used after it.
 * Anything else is reported and left as Ghidra printed it.
 *
 * The handler resumes through `__builtin_longjmp`, so setjmp's rule applies: a local
 * the `__try` block modifies has an indeterminate value afterwards unless it is
 * volatile. Every function-scope local the region writes (or whose address is taken
 * and the region names) and the code the receiver reaches still reads is qualified
 * `volatile`, and `&x` is cast back to the pointer type it had; a parameter in that
 * position is refused, because the signature is not the body's to change.
 * At -O2 GCC otherwise hands the `__except` path the values from before the setjmp.

 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, DeclStmt, ExprStmt, Expression, FunctionDecl, GotoStmt,
  Identifier, IfStmt, IntegerLiteralExpr, LabelStmt, MemberExpr, Statement, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { Expr, Type, Decl, Stmt } from '../../../ast/factory.js';
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
}

export interface SehLoweringOptions extends PluginOptions {
  sehScopes?: SehLoweringScope[];
  /** Told why a frame was left as printed. */
  onRefusal?: (reason: string) => void;
}

const FRAME_TYPE = 'EH3_EXCEPTION_REGISTRATION';
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

function lower(fn: FunctionDecl, scopes: SehLoweringScope[], refuse: (r: string) => void): boolean {
  const body = fn.body;
  if (!body) return false;
  if (scopes.length !== 1 || scopes[0].level !== 0) return refuse('only a single level-0 scope is lowered'), false;
  const scope = scopes[0];

  // The registration record: a local of the EH3 type.
  const frames = body.statements
    .filter((s): s is DeclStmt => s.kind === NodeKind.DeclStmt)
    .flatMap(d => d.declarations)
    .filter((d): d is VariableDecl => d.kind === NodeKind.VariableDecl && typeText((d as VariableDecl).type) === FRAME_TYPE);
  if (frames.length !== 1) return refuse(`${frames.length} locals of type ${FRAME_TYPE}`), false;
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
  const at = (s: Statement) => top.indexOf(s);
  const tryLevel = [...uses].filter(([, u]) => u.kind === 'field' && u.field === 'TryLevel');
  const enter = tryLevel.filter(([, u]) => u.kind === 'field' && constValue(u.value) === scope.level);
  const leave = tryLevel.filter(([, u]) => u.kind === 'field' && constValue(u.value) === -1);
  if (enter.length !== 1 || leave.length !== 1 || tryLevel.length !== 2) {
    return refuse(`try level stores: ${tryLevel.length} (enter ${enter.length}, leave ${leave.length})`), false;
  }
  const i0 = at(enter[0][0]);
  const i1 = at(leave[0][0]);
  if (i0 < 0 || i1 < 0 || i1 <= i0) return refuse('the try level stores are not statements of the body, in order'), false;
  const registers = [...uses].filter(([, u]) => u.kind === 'register');
  if (registers.length !== 1) return refuse(`${registers.length} registrations`), false;
  for (const [s, u] of uses) {
    if (u.kind !== 'field' || u.field === 'TryLevel') continue;
    if (!['ScopeTable', 'ExceptionHandler', 'Next'].includes(u.field)) return refuse(`a store to ${frame}.${u.field}`), false;
    if (u.field === 'Next' && identName(withoutCast(u.value)) !== LIST) return refuse(`${frame}.Next is not ExceptionList`), false;
    const k = at(s);
    if (k < 0 || k > i0) return refuse(`${frame}.${u.field} is set inside the region`), false;
  }
  const ri = at(registers[0][0]);
  if (ri < 0) return refuse('the registration is not a statement of the body'), false;

  // The region ends where the handler resumes: the label the decompiler put on the
  // exit, else the -1 store itself.
  const resumeLabel = `LAB_${scope.resumeAddress.toLowerCase().padStart(8, '0')}`;
  let iEnd = i1;
  for (let k = i0 + 1; k < i1; k++) {
    const s = top[k];
    if (s.kind === NodeKind.LabelStmt && (s as LabelStmt).label.name === resumeLabel) { iEnd = k; break; }
  }
  if (ri > iEnd) return refuse('the registration follows the region'), false;
  const region = top.slice(i0 + 1, iEnd).filter(s => s !== registers[0][0]);

  // __finally: the block is what the decompiler inlined between the -1 store and the
  // deregistration (the instructions prove nothing else is there). The __try may only
  // be left by its end: a return or a goto out would be an abnormal termination, which
  // runs the block too (MSVC's _local_unwind2) and is not modelled here.
  const isFinally = scope.kind === 'finally';
  let finallyStmts: Statement[] = [];
  let iTail = iEnd;
  if (isFinally) {
    const deregs = [...uses].filter(([, u]) => u.kind === 'deregister');
    if (deregs.length !== 1) return refuse(`${deregs.length} deregistrations; a __finally has the one after its block`), false;
    const iD = at(deregs[0][0]);
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
    // The block becomes a lambda's body: a declaration in it may stay there only when
    // nothing after the block names it.
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
  const regionNodes = new Set<ASTNode>();
  for (const s of region) for (const g of findNodesByKind(s, NodeKind.GotoStmt)) regionNodes.add(g);
  for (const g of findNodesByKind(body, NodeKind.GotoStmt) as GotoStmt[]) {
    if (!regionNodes.has(g) && inside.has(g.label.name)) return refuse(`goto ${g.label.name} enters the region`), false;
  }
  // A declaration the region holds would go out of scope at its end. One the code
  // after the region still names moves in front of the scope block: as it stands
  // when it has no initializer, split into `T x;` there and `x = init;` in place
  // when it has a plain one. Declaring earlier changes nothing a value depends on.
  const after = new Set<string>();
  for (const s of top.slice(iEnd)) {
    for (const id of findNodesByKind(s, NodeKind.Identifier) as Identifier[]) after.add(id.name);
  }
  const hoisted: Statement[] = [];
  for (let k = 0; k < region.length; k++) {
    const s = region[k];
    if (s.kind !== NodeKind.DeclStmt) continue;
    const decls = (s as DeclStmt).declarations;
    if (!decls.some(d => d.kind === NodeKind.VariableDecl && after.has((d as VariableDecl).name.name))) continue;
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

  // setjmp semantics: after the handler's longjmp, a non-volatile local the try block
  // modified has an indeterminate value (C11 7.13.2.1; __builtin_setjmp restores only
  // EBP/ESP/EIP, and at -O1 and up GCC keeps such a local in a register or propagates
  // its value at the setjmp into the receiver). Every function-scope local the region
  // writes - directly, or through an address taken anywhere - and the code outside the
  // region names is volatile-qualified; its address is cast back where it is taken, so
  // a callee still receives the pointer type it declares.
  const keptDecls = new Map<string, VariableDecl>();
  for (const s of [...top.slice(0, i0), ...hoisted]) {
    if (s.kind !== NodeKind.DeclStmt) continue;
    for (const d of (s as DeclStmt).declarations) {
      if (d.kind === NodeKind.VariableDecl) keptDecls.set((d as VariableDecl).name.name, d as VariableDecl);
    }
  }
  const params = new Set(fn.parameters.map(p => p.name?.name).filter((n): n is string => !!n));
  const written = writtenNames(region);
  const addressed = addressTakenNames(body);
  const regionNames = new Set<string>();
  for (const s of region) for (const id of findNodesByKind(s, NodeKind.Identifier) as Identifier[]) regionNames.add(id.name);
  // Where the receiver can go: the code after the region, and the code before it only
  // when a goto after the region leads back there. A declarator is not a use.
  const declarators = new Set<ASTNode>();
  for (const d of findNodesByKind(body, NodeKind.VariableDecl) as VariableDecl[]) declarators.add(d.name);
  const preLabels = new Set<string>();
  for (const s of top.slice(0, i0)) for (const l of findNodesByKind(s, NodeKind.LabelStmt)) preLabels.add((l as LabelStmt).label.name);
  const loopsBack = top.slice(iEnd).some(s => (findNodesByKind(s, NodeKind.GotoStmt) as GotoStmt[]).some(g => preLabels.has(g.label.name)));
  const outsideNames = new Set<string>();
  for (const s of [...(loopsBack ? top.slice(0, i0) : []), ...top.slice(iEnd)]) {
    for (const id of findNodesByKind(s, NodeKind.Identifier) as Identifier[]) if (!declarators.has(id)) outsideNames.add(id.name);
  }
  const preserve: VariableDecl[] = [];
  for (const n of new Set([...written, ...[...addressed].filter(a => regionNames.has(a))])) {
    if (!outsideNames.has(n)) continue;
    if (params.has(n)) return refuse(`parameter ${n} is written in the region and read outside it`), false;
    const v = keptDecls.get(n);
    if (!v) continue; // a global, or a local of a nested block the region cannot see
    if (v.type.kind === NodeKind.ArrayType) return refuse(`array ${n} is written in the region and read outside it`), false;
    if ((v.specifiers as string[]).includes('static')) continue;
    preserve.push(v);
  }
  for (const v of preserve) {
    const original = v.type;
    v.type = volatileOf(original) as VariableDecl["type"];
    castAddressOf(body, v.name.name, original);
  }

  // A fault is an asynchronous exception: any load or store through a pointer in the
  // __try can be the one that raises it, and C++ lets the compiler move such an access
  // across a store the handler path observes (a volatile local, a global, memory) -
  // at -O2 GCC hoisted the faulting `*p` above `nStep = 2`, and the __finally saw 1.
  // MSVC keeps them in order inside a __try. A compiler fence before and after every
  // statement with an observable store, and at the edges of the blocks its condition
  // guards, restores that order.
  const unobservable = new Set<string>();
  for (const [n] of keptDecls) unobservable.add(n);
  for (const n of params) unobservable.add(n);
  for (const v of preserve) unobservable.delete(v.name.name);
  for (const st of region) {
    for (const d of findNodesByKind(st, NodeKind.VariableDecl) as VariableDecl[]) {
      if (!preserve.includes(d)) unobservable.add(d.name.name);
    }
  }
  const fenced = fenceStatements(region, unobservable);
  region.splice(0, region.length, ...fenced);

  if (isFinally) {
    buildFinally(body, scope, top, i0, iTail, region, finallyStmts, hoisted, uses);
    return true;
  }

  // Build the scope.
  const name = `__seh${scope.level}`;
  const scopeDecl = Decl.variable(name, Type.typedef('D2SehScope'), Expr.initList([Expr.intLiteral(scope.filter)]));
  scopeDecl.directInit = true;
  const scopeStmt = Stmt.declStmt([scopeDecl]);
  const filterWord = scope.filter > 0 ? 'EXCEPTION_EXECUTE_HANDLER' : scope.filter < 0 ? 'EXCEPTION_CONTINUE_EXECUTION' : 'EXCEPTION_CONTINUE_SEARCH';
  scopeStmt.leadingTrivia = [
    lineComment(`__try / __except (${filterWord}): scope table ${scope.scopeTable}, filter ${scope.filterAddress}`, scopeStmt),
  ];
  const enterStmt = Stmt.expr(Expr.call(Expr.member(Expr.identifier(name), 'Enter'), []));
  const tryBlock = Stmt.compound([enterStmt, ...region]);
  const handlerBlock = Stmt.compound([]);
  const cond = Expr.binary(Expr.call('D2_SEH_SETJMP', [Expr.identifier(name)]), '==', Expr.intLiteral(0));
  const ifStmt = Stmt.if_(cond, tryBlock, handlerBlock) as IfStmt;
  ifStmt.leadingTrivia = [
    lineComment(`__except block: the handler ${scope.handlerAddress} resumes at ${scope.resumeAddress}, after the __try`, ifStmt),
  ];
  const block = Stmt.compound([scopeStmt, ifStmt]);

  // The stores the scope replaces: the record's setup, the try levels, the
  // registration and every deregistration.
  const doomed = new Set<ASTNode>();
  for (const [s, u] of uses) doomed.add(s);
  const before = top.slice(0, i0).filter(s => !doomed.has(s));
  const afterRegion = top.slice(iEnd).filter(s => !doomed.has(s));
  body.statements = [...before, ...hoisted, block, ...afterRegion];
  removeStatements(body, doomed);
  return true;
}

/**
 * The `__finally` shape:
 *
 *     auto __finally0 = [&]() { <block> };
 *     {
 *       D2SehScope __seh0{__finally0};   // the unwind of an exception runs the block
 *       __seh0.Enter();
 *       <try>
 *     }
 *     __finally0();                      // the normal path's own call, after the __try
 *
 * The scope is popped before the normal path runs the block, as the original's -1
 * store does before its CALL: an exception the block raises is not this scope's.
 */
function buildFinally(
  body: CompoundStmt, scope: SehLoweringScope, top: Statement[], i0: number, iTail: number,
  region: Statement[], finallyStmts: Statement[], hoisted: Statement[], uses: Map<Statement, FrameUse>,
): void {
  const fname = `__finally${scope.level}`;
  const name = `__seh${scope.level}`;
  const lambda = {
    kind: NodeKind.LambdaExpr, captures: [], captureDefault: '&', parameters: [], returnType: null,
    body: Stmt.compound(finallyStmts), specifiers: [], location: body.location,
  } as unknown as Expression;
  const lambdaDecl = Stmt.declStmt([Decl.variable(fname, Type.auto(), lambda)]);
  lambdaDecl.leadingTrivia = [
    lineComment(`__finally block: run by the termination handler ${scope.handlerAddress} on unwind and by the normal path; both reach ${scope.bodyAddress}`, lambdaDecl),
  ];
  const scopeDecl = Decl.variable(name, Type.typedef('D2SehScope'), Expr.initList([Expr.identifier(fname)]));
  scopeDecl.directInit = true;
  const scopeStmt = Stmt.declStmt([scopeDecl]);
  scopeStmt.leadingTrivia = [lineComment(`__try / __finally: scope table ${scope.scopeTable}`, scopeStmt)];
  const enterStmt = Stmt.expr(Expr.call(Expr.member(Expr.identifier(name), 'Enter'), []));
  const block = Stmt.compound([scopeStmt, enterStmt, ...region]);
  const callStmt = Stmt.expr(Expr.call(fname, []));
  callStmt.leadingTrivia = [lineComment(`normal termination: the parent calls ${scope.bodyAddress} after the __try`, callStmt)];

  const doomed = new Set<ASTNode>();
  for (const [s] of uses) doomed.add(s);
  const before = top.slice(0, i0).filter(s => !doomed.has(s));
  const tail = top.slice(iTail).filter(s => !doomed.has(s));
  body.statements = [...before, ...hoisted, lambdaDecl, block, callStmt, ...tail];
  removeStatements(body, doomed);
}

const FENCE = 'D2_SEH_FENCE';

/** Library calls GCC expands into inline stores (so they are stores, not barriers). */
const INLINE_STORE_BUILTINS = new Set([
  'memset', 'memcpy', 'memmove', 'strcpy', 'strncpy', 'strcat', 'strncat', 'stpcpy', 'bzero',
  '_memset', '_memcpy', '_memmove', '_strcpy', '_strncpy', '_strcat', '_strncat',
]);

function fenceStmt(): Statement {
  return Stmt.expr(Expr.call(FENCE, []));
}

function isFence(s: Statement | null | undefined): boolean {
  if (!s || s.kind !== NodeKind.ExprStmt) return false;
  const e = (s as ExprStmt).expression;
  return e.kind === NodeKind.CallExpr && identName((e as unknown as { callee: Expression }).callee) === FENCE;
}

/** The expressions a statement evaluates itself, not those of the statements it holds. */
function ownExpressions(s: Statement): ASTNode[] {
  const n = s as unknown as Record<string, ASTNode | null | undefined>;
  switch (s.kind) {
    case NodeKind.ExprStmt: return [n.expression!];
    case NodeKind.IfStmt: case NodeKind.WhileStmt: case NodeKind.DoWhileStmt: case NodeKind.SwitchStmt:
      return [n.condition!, n.init].filter((x): x is ASTNode => !!x);
    case NodeKind.ForStmt: return [n.init, n.condition, n.increment].filter((x): x is ASTNode => !!x);
    case NodeKind.ReturnStmt: return n.value ? [n.value] : [];
    case NodeKind.DeclStmt: return [s];
    default: return [];
  }
}

/** Does the expression store somewhere the code after a fault can see? */
function hasObservableStore(nodes: ASTNode[], unobservable: Set<string>): boolean {
  const observable = (lv: Expression): boolean => {
    let x: Expression = lv;
    for (;;) {
      if (x.kind === NodeKind.ParenExpr) x = (x as unknown as { expression: Expression }).expression;
      else if (x.kind === NodeKind.MemberExpr && !(x as MemberExpr).isArrow) x = (x as MemberExpr).object;
      else break;
    }
    const n = identName(x);
    return !(n && unobservable.has(n));
  };
  for (const node of nodes) {
    // A call to an opaque function already orders memory around it; one GCC may expand
    // inline into plain stores does not.
    for (const c of findNodesByKind(node, NodeKind.CallExpr) as unknown as { callee: Expression }[]) {
      let callee = identName(c.callee);
      if (!callee && c.callee.kind === NodeKind.QualifiedId) {
        const q = c.callee as unknown as { name: ASTNode };
        callee = q.name.kind === NodeKind.Identifier ? (q.name as Identifier).name : undefined;
      }
      if (callee && INLINE_STORE_BUILTINS.has(callee)) return true;
    }
    for (const a of findNodesByKind(node, NodeKind.AssignExpr) as AssignExpr[]) if (observable(a.left)) return true;
    for (const u of findNodesByKind(node, NodeKind.UnaryExpr) as UnaryExpr[]) {
      if ((u.operator === '++' || u.operator === '--') && observable(u.operand)) return true;
    }
    for (const p of findNodesByKind(node, NodeKind.PostfixExpr) as unknown as { operand: Expression }[]) {
      if (observable(p.operand)) return true;
    }
  }
  return false;
}

function asBlock(s: Statement): CompoundStmt {
  return s.kind === NodeKind.CompoundStmt ? s as CompoundStmt : Stmt.compound([s]);
}

/** Fence a statement list: see the comment where it is called. */
function fenceStatements(list: Statement[], unobservable: Set<string>): Statement[] {
  const out: Statement[] = [];
  const push = (s: Statement) => { if (!(isFence(s) && isFence(out[out.length - 1]))) out.push(s); };
  for (const s of list) {
    // Labels stay on the statement they name; the fence goes inside them.
    const labels: Statement[] = [];
    let core = s;
    while (core.kind === NodeKind.LabelStmt || core.kind === NodeKind.CaseStmt || core.kind === NodeKind.DefaultStmt) {
      labels.push(core);
      core = (core as unknown as { statement: Statement }).statement;
    }
    const guard = hasObservableStore(ownExpressions(core), unobservable);
    const n = core as unknown as Record<string, Statement | null>;
    const fenceBody = (key: string, atEnd: boolean) => {
      if (!n[key]) return;
      const b = asBlock(n[key]!);
      const inner = fenceStatements(b.statements, unobservable);
      if (guard) { if (!isFence(inner[0])) inner.unshift(fenceStmt()); if (atEnd && !isFence(inner[inner.length - 1])) inner.push(fenceStmt()); }
      n[key] = { ...b, statements: inner } as CompoundStmt;
    };
    switch (core.kind) {
      case NodeKind.CompoundStmt: {
        const c = core as CompoundStmt;
        c.statements = fenceStatements(c.statements, unobservable);
        break;
      }
      case NodeKind.IfStmt: fenceBody('thenBranch', false); fenceBody('elseBranch', false); break;
      case NodeKind.WhileStmt: case NodeKind.DoWhileStmt: case NodeKind.ForStmt: fenceBody('body', true); break;
      case NodeKind.SwitchStmt: fenceBody('body', false); break;
    }
    if (!guard) { push(s); continue; }
    if (labels.length > 0) {
      // `L: s` -> `L: FENCE; s; FENCE`: a jump to L still passes the first fence.
      (labels[labels.length - 1] as unknown as { statement: Statement }).statement = fenceStmt();
      push(s);
      push(core);
    } else {
      push(fenceStmt());
      push(core);
    }
    push(fenceStmt());
  }
  return out;
}

/** Names the statements assign, increment or decrement (as the root of the lvalue). */
function writtenNames(stmts: Statement[]): Set<string> {
  const out = new Set<string>();
  const root = (e: Expression): string | undefined => {
    let x: Expression = e;
    for (;;) {
      if (x.kind === NodeKind.ParenExpr) x = (x as unknown as { expression: Expression }).expression;
      else if (x.kind === NodeKind.MemberExpr && !(x as MemberExpr).isArrow) x = (x as MemberExpr).object;
      else if (x.kind === NodeKind.SubscriptExpr) x = (x as unknown as { array: Expression }).array;
      else break;
    }
    return identName(x);
  };
  for (const s of stmts) {
    for (const a of findNodesByKind(s, NodeKind.AssignExpr) as AssignExpr[]) {
      const n = root(a.left); if (n) out.add(n);
    }
    for (const u of findNodesByKind(s, NodeKind.UnaryExpr) as UnaryExpr[]) {
      if (u.operator === '++' || u.operator === '--') { const n = root(u.operand); if (n) out.add(n); }
    }
    for (const p of findNodesByKind(s, NodeKind.PostfixExpr) as unknown as { operand: Expression }[]) {
      const n = root(p.operand); if (n) out.add(n);
    }
  }
  return out;
}

/** Names whose address is taken (`&x`, `&x.f`, `&x[i]`) anywhere in the function. */
function addressTakenNames(node: ASTNode): Set<string> {
  const out = new Set<string>();
  for (const u of findNodesByKind(node, NodeKind.UnaryExpr) as UnaryExpr[]) {
    if (u.operator !== '&') continue;
    let x: Expression = u.operand;
    while (x.kind === NodeKind.ParenExpr || x.kind === NodeKind.MemberExpr || x.kind === NodeKind.SubscriptExpr) {
      if (x.kind === NodeKind.MemberExpr && (x as MemberExpr).isArrow) break;
      x = x.kind === NodeKind.ParenExpr ? (x as unknown as { expression: Expression }).expression
        : x.kind === NodeKind.MemberExpr ? (x as MemberExpr).object : (x as unknown as { array: Expression }).array;
    }
    const n = identName(x);
    if (n) out.add(n);
  }
  return out;
}

/** `T` -> `volatile T`; a pointer is qualified itself (`T * volatile`), not its pointee. */
function volatileOf(t: ASTNode): ASTNode {
  if (t.kind === NodeKind.PointerType) {
    const p = t as unknown as { qualifiers: string[] };
    return p.qualifiers.includes('volatile') ? t : { ...t, qualifiers: [...p.qualifiers, 'volatile'] } as ASTNode;
  }
  if (t.kind === NodeKind.QualifiedType) {
    const q = t as unknown as { qualifiers: string[] };
    return q.qualifiers.includes('volatile') ? t : { ...t, qualifiers: [...q.qualifiers, 'volatile'] } as ASTNode;
  }
  return Type.qualified(t as never, ['volatile']);
}

/** `&x` -> `(T *)&x`: the address of the now-volatile local, as the pointer it was. */
function castAddressOf(root: ASTNode, name: string, original: ASTNode): void {
  const visit = (n: ASTNode): void => {
    for (const [key, child] of Object.entries(n)) {
      if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia') continue;
      const fix = (x: unknown): unknown => {
        if (!x || typeof x !== 'object' || !('kind' in x)) return x;
        const node = x as ASTNode;
        if (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '&'
          && identName((node as UnaryExpr).operand) === name) {
          return Expr.paren(Expr.cast(Type.pointer(structuredClone(original) as never), node as Expression));
        }
        visit(node);
        return node;
      };
      if (Array.isArray(child)) for (let i = 0; i < child.length; i++) child[i] = fix(child[i]);
      else if (child && typeof child === 'object' && 'kind' in child) (n as unknown as Record<string, unknown>)[key] = fix(child);
    }
  };
  visit(root);
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
  'Lowers an MSVC EH3 __try/__except frame to a D2SehScope that really registers on fs:[0]',
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
