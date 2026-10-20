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
    if (u.field === 'Next' && identName(u.value) !== LIST) return refuse(`${frame}.Next is not ExceptionList`), false;
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
