/**
 * Recover a VC8 inline memcmp used only for an equality decision.
 *
 * The word loop is matched structurally. Its byte tail is checked over the CFG,
 * including shared labels: counts 0..3 after equal words, and a differing word
 * with count >=4. Only zero/sign predicates are admitted on byte differences,
 * so {-1,0,1} represents every possible difference. A tail must read no byte
 * beyond its remaining count and reach the same zero/nonzero result in every
 * abstract case. Unknown work or another entry refuses the whole group.
 * The equality return and the existing full-range memcpy on mismatch establish
 * the readable range; known arrays or a dominating read establish non-null
 * inputs even when the count is zero.
 *
 * No function names, addresses or label spellings select a rewrite.
 */
import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  AssignExpr,
  BinaryExpr,
  BoolLiteralExpr,
  CallExpr,
  CStyleCastExpr,
  CompoundStmt,
  Expression,
  ExprStmt,
  ForStmt,
  FunctionDecl,
  GotoStmt,
  Identifier,
  IfStmt,
  IntegerLiteralExpr,
  LabelStmt,
  ReturnStmt,
  Statement,
  SubscriptExpr,
  TypeNode,
  UnaryExpr,
  VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { parse } from '../../../parser/index.js';
import { cloneNode } from '../../transformer.js';
import { buildFunctionFlow, type FunctionFlow } from '../../cfg/dataflow.js';
import { calleeName, unwrapParens, type TypeShape } from './call-arg-cast.js';

export interface WordMemcmpDeps {
  shape: (e: Expression) => TypeShape | null;
  locals: ReadonlySet<string>;
  declarationCounts?: ReadonlyMap<string, number>;
  /** Concrete byte-array objects, excluding names hidden by pointer declarations. */
  byteArrays?: ReadonlySet<string>;
  volatileNames?: ReadonlySet<string>;
  typeIsVolatile?: (type: TypeNode) => boolean;
}
const un = unwrapParens;
const id = (e: Expression | null | undefined): string | undefined => {
  const n = e && un(e);
  return n?.kind === NodeKind.Identifier ? (n as Identifier).name : undefined;
};
const literal = (e: Expression | null | undefined): number | undefined => {
  const n = e && un(e);
  if (n?.kind === NodeKind.IntegerLiteral) return Number((n as IntegerLiteralExpr).value);
  if (n?.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '-') {
    const v = literal((n as UnaryExpr).operand);
    return v === undefined ? undefined : -v;
  }
  return undefined;
};
const bodyOf = (s: Statement): Statement[] =>
  s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s];
const assign = (s: Statement): AssignExpr | undefined => {
  const e = s.kind === NodeKind.ExprStmt ? un((s as ExprStmt).expression) : undefined;
  return e?.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '='
    ? (e as AssignExpr)
    : undefined;
};
const I32 = new Set(['int', 'unsigned int', 'long', 'unsigned long']);
const U32 = new Set(['unsigned int', 'unsigned long']);
const BYTE = new Set(['char', 'signed char', 'unsigned char']);
const scalar32 = (s: TypeShape | null): boolean => !!s && s.stars === 0 && I32.has(s.base);
const nameExpr = (name: string): Identifier => ({ kind: NodeKind.Identifier, name }) as Identifier;
interface Loop {
  list: Statement[];
  at: number;
  loop: ForStmt;
  setup: [AssignExpr, AssignExpr];
  p: string;
  q: string;
  n: string;
  length: Expression;
  mismatch: GotoStmt;
}
function step(e: Expression, name: string, amount: number): boolean {
  const x = un(e);
  if (x.kind !== NodeKind.AssignExpr) return false;
  const a = x as AssignExpr;
  if (id(a.left) !== name) return false;
  if (a.operator === '+=' || a.operator === '-=')
    return literal(a.right) === (a.operator === '+=' ? amount : -amount);
  const r = un(a.right);
  return (
    a.operator === '=' &&
    r.kind === NodeKind.BinaryExpr &&
    id((r as BinaryExpr).left) === name &&
    (((r as BinaryExpr).operator === '+' && literal((r as BinaryExpr).right) === amount) ||
      ((r as BinaryExpr).operator === '-' && literal((r as BinaryExpr).right) === -amount))
  );
}
function wordRead(e: Expression, deps: WordMemcmpDeps): string | undefined {
  const x = un(e);
  if (x.kind !== NodeKind.UnaryExpr || (x as UnaryExpr).operator !== '*') return undefined;
  const cast = un((x as UnaryExpr).operand);
  const shape = deps.shape(cast);
  return cast.kind === NodeKind.CStyleCastExpr &&
    shape?.stars === 1 &&
    I32.has(shape.base) &&
    !deps.typeIsVolatile?.((cast as CStyleCastExpr).type)
    ? id((cast as CStyleCastExpr).expression)
    : undefined;
}
function loopAt(list: Statement[], at: number, deps: WordMemcmpDeps): Loop | undefined {
  const loop = list[at];
  if (at < 2 || loop.kind !== NodeKind.ForStmt) return undefined;
  const f = loop as ForStmt,
    a = assign(list[at - 2]),
    b = assign(list[at - 1]),
    init = f.init && assign(f.init);
  if (!a || !b || !init || !f.condition || !f.increment) return undefined;
  const p = id(a.left),
    q = id(b.left),
    n = id(init.left);
  if (!p || !q || !n || new Set([p, q, n]).size !== 3 || !id(a.right) || !id(b.right) || !id(init.right))
    return undefined;
  const ps = deps.shape(a.left),
    qs = deps.shape(b.left),
    ns = deps.shape(init.left);
  if (
    ps?.stars !== 1 ||
    qs?.stars !== 1 ||
    !BYTE.has(ps.base) ||
    !BYTE.has(qs.base) ||
    ns?.stars !== 0 ||
    !U32.has(ns.base) ||
    !scalar32(deps.shape(init.right))
  )
    return undefined;
  const c = un(f.condition);
  if (c.kind !== NodeKind.BinaryExpr) return undefined;
  const cmp = c as BinaryExpr;
  if (!(
    (id(cmp.left) === n &&
      ((cmp.operator === '>=' && literal(cmp.right) === 4) ||
        (cmp.operator === '>' && literal(cmp.right) === 3))) ||
    (id(cmp.right) === n &&
      ((cmp.operator === '<=' && literal(cmp.left) === 4) ||
        (cmp.operator === '<' && literal(cmp.left) === 3)))
  ))
    return undefined;
  const st = bodyOf(f.body);
  if (st.length !== 3 || st[0].kind !== NodeKind.IfStmt || !step(f.increment, n, -4)) return undefined;
  const test = st[0] as IfStmt,
    condition = un(test.condition),
    arm = bodyOf(test.thenBranch);
  if (
    test.elseBranch ||
    test.init ||
    condition.kind !== NodeKind.BinaryExpr ||
    (condition as BinaryExpr).operator !== '!=' ||
    wordRead((condition as BinaryExpr).left, deps) !== p ||
    wordRead((condition as BinaryExpr).right, deps) !== q ||
    arm.length !== 1 ||
    arm[0].kind !== NodeKind.GotoStmt
  )
    return undefined;
  const steps = st
    .slice(1)
    .map((s) => (s.kind === NodeKind.ExprStmt ? (s as ExprStmt).expression : undefined));
  if (
    !steps.every(Boolean) ||
    !((step(steps[0]!, p, 4) && step(steps[1]!, q, 4)) || (step(steps[0]!, q, 4) && step(steps[1]!, p, 4)))
  )
    return undefined;
  return { list, at, loop: f, setup: [a, b], p, q, n, length: init.right, mismatch: arm[0] as GotoStmt };
}
function byteRead(e: Expression, p: string, deps: WordMemcmpDeps): number | undefined {
  let x = un(e),
    unsignedByte = false;
  while (x.kind === NodeKind.CStyleCastExpr) {
    if (deps.typeIsVolatile?.((x as CStyleCastExpr).type)) return undefined;
    const s = deps.shape(x);
    if (!s || s.stars !== 0 || !(I32.has(s.base) || s.base === 'unsigned char')) return undefined;
    unsignedByte ||= s.base === 'unsigned char';
    x = un((x as CStyleCastExpr).expression);
  }
  const ps = deps.shape(nameExpr(p));
  if (ps?.stars !== 1 || !(unsignedByte || ps.base === 'unsigned char')) return undefined;
  if (
    x.kind === NodeKind.UnaryExpr &&
    (x as UnaryExpr).operator === '*' &&
    id((x as UnaryExpr).operand) === p
  )
    return 0;
  if (x.kind === NodeKind.SubscriptExpr && id((x as SubscriptExpr).array) === p) {
    const k = literal((x as SubscriptExpr).index);
    return k !== undefined && k >= 0 && k <= 3 ? k : undefined;
  }
  return undefined;
}
function difference(e: Expression, m: Loop, deps: WordMemcmpDeps): number | undefined {
  const x = un(e);
  if (x.kind !== NodeKind.BinaryExpr || (x as BinaryExpr).operator !== '-') return undefined;
  const a = byteRead((x as BinaryExpr).left, m.p, deps),
    b = byteRead((x as BinaryExpr).right, m.q, deps);
  return a !== undefined && a === b ? a : undefined;
}
interface Exit {
  test: IfStmt;
  result: string;
  ret: ReturnStmt;
  label: string;
}
function exitAt(list: Statement[], at: number, deps: WordMemcmpDeps): Exit | undefined {
  const s = list[at],
    next = list[at + 1];
  if (s.kind !== NodeKind.IfStmt || next?.kind !== NodeKind.LabelStmt) return undefined;
  const f = s as IfStmt,
    c = un(f.condition),
    arm = bodyOf(f.thenBranch);
  if (
    f.init ||
    f.elseBranch ||
    arm.length !== 1 ||
    arm[0].kind !== NodeKind.ReturnStmt ||
    c.kind !== NodeKind.BinaryExpr
  )
    return undefined;
  const b = c as BinaryExpr,
    result = id(b.left);
  if (
    !result ||
    literal(b.right) !== 0 ||
    b.operator !== '==' ||
    !scalar32(deps.shape(b.left))
  )
    return undefined;
  const ret = arm[0] as ReturnStmt;
  if (ret.value && literal(ret.value) === undefined && un(ret.value).kind !== NodeKind.BoolLiteral)
    return undefined;
  return { test: f, result, ret, label: (next as LabelStmt).label.name };
}
const compare = (a: number, op: string, b: number): boolean | undefined => {
  switch (op) {
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    default:
      return undefined;
  }
};
function tailCondition(
  e: Expression,
  m: Loop,
  d: string,
  count: number,
  diff: number | undefined,
): boolean | undefined {
  const x = un(e);
  if (x.kind !== NodeKind.BinaryExpr) return undefined;
  const b = x as BinaryExpr,
    name = id(b.left),
    k = literal(b.right);
  if (k === undefined) return undefined;
  if (name === m.n && [0, 1, 2, 3].includes(k) && ['==', '!='].includes(b.operator))
    return compare(count, b.operator, k);
  // These predicates partition every [-255,255] difference exactly as {-1,0,1}.
  if (name === d && diff !== undefined && (k === 0 || (k === 1 && ['<', '>='].includes(b.operator))))
    return compare(diff, b.operator, k);
  return undefined;
}
function proveTail(
  flow: FunctionFlow,
  start: number,
  terminal: number,
  m: Loop,
  d: string,
  result: string,
  count: number,
  bytes: number[],
  expectedEqual: boolean,
  visited: Set<number>,
  deps: WordMemcmpDeps,
): boolean {
  let at = start,
    diff: number | undefined,
    value: number | undefined;
  const seen = new Set<string>();
  for (let steps = 0; steps < 256; ++steps) {
    visited.add(at);
    if (at === terminal) return value !== undefined && (value === 0) === expectedEqual;
    const state = `${at}:${diff}:${value}`;
    if (seen.has(state)) return false;
    seen.add(state);
    const node = flow.cfg.nodes[at],
      s = node?.stmt;
    if (!s) return false;
    if (s.kind === NodeKind.IfStmt) {
      const condition = tailCondition((s as IfStmt).condition, m, d, count, diff);
      if (condition === undefined || (s as IfStmt).init) return false;
      at = node.succ[condition || node.succ.length === 1 ? 0 : 1];
      continue;
    }
    if ([NodeKind.LabelStmt, NodeKind.GotoStmt, NodeKind.NullStmt].includes(s.kind as never)) {
      if (node.succ.length !== 1) return false;
      at = node.succ[0];
      continue;
    }
    const a = assign(s),
      target = a && id(a.left);
    if (!a || !target || node.succ.length !== 1) return false;
    if (target === d) {
      const offset = difference(a.right, m, deps);
      if (offset === undefined || offset >= count) return false;
      diff = bytes[offset];
    } else if (target === result) {
      const v = literal(a.right);
      if (v === undefined || ![-1, 0, 1].includes(v)) return false;
      value = v;
    } else return false;
    at = node.succ[0];
  }
  return false;
}
function* patterns(count: number): Generator<number[]> {
  if (!count) {
    yield [];
    return;
  }
  for (const tail of patterns(count - 1)) for (const head of [-1, 0, 1]) yield [head, ...tail];
}
function reachable(flow: FunctionFlow, destination: number, skip = -1): boolean {
  const todo = [flow.cfg.entry, ...flow.cfg.extraEntries],
    seen = new Set<number>();
  while (todo.length) {
    const at = todo.pop()!;
    if (at === skip || seen.has(at)) continue;
    if (at === destination) return true;
    seen.add(at);
    const node = flow.cfg.nodes[at],
      s = node.stmt;
    // The builder keeps both if edges; a literal condition cannot take the other.
    const c = s?.kind === NodeKind.IfStmt ? un((s as IfStmt).condition) : undefined;
    const v = c?.kind === NodeKind.BoolLiteral ? (c as BoolLiteralExpr).value : c ? literal(c) : undefined;
    if (v !== undefined && node.succ.length === 2) todo.push(node.succ[v ? 0 : 1]);
    else todo.push(...node.succ);
  }
  return false;
}
function nonNullInput(e: Expression, m: Loop, flow: FunctionFlow, deps: WordMemcmpDeps): boolean {
  const name = id(e);
  if (!name || deps.volatileNames?.has(name)) return false;
  if (deps.locals.has(name) && deps.declarationCounts?.get(name) !== 1) return false;
  if (deps.byteArrays?.has(name)) return true;
  if (
    !deps.locals.has(name) ||
    deps.declarationCounts?.get(name) !== 1 ||
    flow.isEscaped(name) ||
    flow.cfg.nodes.some((n) => flow.writes(n.id).has(name))
  )
    return false;
  const dest = flow.nodeOf(m.list[m.at - 2]);
  if (dest === undefined || !reachable(flow, dest)) return false;
  for (const node of flow.cfg.nodes) {
    const s = node.stmt;
    const e =
      s?.kind === NodeKind.SwitchStmt ? (s as unknown as { condition: Expression }).condition : undefined;
    if (
      e &&
      un(e).kind === NodeKind.UnaryExpr &&
      (un(e) as UnaryExpr).operator === '*' &&
      id((un(e) as UnaryExpr).operand) === name &&
      !reachable(flow, dest, node.id)
    )
      return true;
  }
  return false;
}

/**
 * A short-circuit word walk need not touch all n bytes after a mismatch, whereas
 * memcmp may. Require the non-equal continuation to copy that same n-byte range
 * before other work. Equal paths already read all n bytes in the original loop;
 * unequal paths need both ranges valid for this existing copy. Zero-count null
 * inputs are checked separately by nonNullInput.
 */
function rangesValidOnMismatch(m: Loop, exit: Exit, flow: FunctionFlow, deps: WordMemcmpDeps): boolean {
  const length = id(m.length)!;
  if (
    !deps.locals.has(length) ||
    deps.declarationCounts?.get(length) !== 1 ||
    flow.isEscaped(length) ||
    flow.cfg.nodes.some((n) => flow.writes(n.id).has(length))
  )
    return false;
  const test = flow.nodeOf(exit.test);
  if (test === undefined || flow.cfg.nodes[test].succ.length !== 2) return false;
  let at = flow.cfg.nodes[test].succ[1];
  const seen = new Set<number>();
  for (let steps = 0; steps < 64 && !seen.has(at); ++steps) {
    seen.add(at);
    const node = flow.cfg.nodes[at],
      s = node.stmt;
    if (!s || node.succ.length !== 1) return false;
    if ([NodeKind.LabelStmt, NodeKind.GotoStmt, NodeKind.NullStmt].includes(s.kind as never)) {
      at = node.succ[0];
      continue;
    }
    const expression = s.kind === NodeKind.ExprStmt ? un((s as ExprStmt).expression) : undefined;
    if (expression?.kind === NodeKind.CallExpr) {
      const call = expression as CallExpr;
      const name = calleeName(call.callee);
      if (
        !name ||
        !['memcpy', '::memcpy', 'compiler::memcpy', 'std::memcpy'].includes(name) ||
        deps.locals.has('memcpy') ||
        call.arguments.length !== 3 ||
        id(call.arguments[2]) !== length
      )
        return false;
      const [a, b] = m.setup.map((s) => id(s.right));
      const [dst, src] = call.arguments.map(id);
      return (dst === a && src === b) || (dst === b && src === a);
    }
    // A plain scalar copy may precede the range copy (e.g. a tick snapshot).
    const a = assign(s),
      target = a && id(a.left),
      source = a && id(a.right);
    if (
      !a ||
      !target ||
      !source ||
      target === length ||
      !deps.locals.has(target) ||
      !deps.locals.has(source) ||
      deps.declarationCounts?.get(target) !== 1 ||
      deps.declarationCounts?.get(source) !== 1 ||
      deps.volatileNames?.has(target) ||
      deps.volatileNames?.has(source) ||
      !scalar32(deps.shape(a.left)) ||
      !scalar32(deps.shape(a.right))
    )
      return false;
    at = node.succ[0];
  }
  return false;
}
function replacement(m: Loop, exit: Exit): Statement[] {
  const fn = parse(
    `void f() { if (::memcmp(a,b,(uint32_t)n) == 0) return; goto ${exit.label}; }`,
  ).declarations[0] as FunctionDecl;
  const test = fn.body!.statements[0] as IfStmt,
    condition = test.condition as BinaryExpr;
  const call = condition.left as CallExpr;
  call.arguments[0] = cloneNode(m.setup[0].right);
  call.arguments[1] = cloneNode(m.setup[1].right);
  (call.arguments[2] as CStyleCastExpr).expression = cloneNode(m.length);
  call.location = exit.test.condition.location;
  condition.location = exit.test.condition.location;
  condition.right.location = exit.test.condition.location;
  test.thenBranch = cloneNode(exit.ret);
  test.location = m.list[m.at - 2].location;
  return fn.body!.statements;
}

/** Returns the original list unless every part of one shared comparison group is proved. */
export function lowerWordMemcmps(body: Statement[], deps: WordMemcmpDeps): Statement[] {
  if (!deps.declarationCounts || !deps.typeIsVolatile || deps.locals.has('memcmp')) return body;
  const originalNodes = [...traverseAST({ kind: NodeKind.CompoundStmt, statements: body } as CompoundStmt)];
  // These constructs can hide writes or entries from the statement CFG.
  const opaque = new Set([
    NodeKind.AsmDecl,
    NodeKind.SehTryStmt,
    NodeKind.PpConditionalStmt,
    NodeKind.LambdaExpr,
    NodeKind.CoAwaitExpr,
    NodeKind.CoYieldExpr,
    NodeKind.CoReturnStmt,
  ]);
  if (originalNodes.some((n) => opaque.has(n.kind))) return body;
  // Most functions contain no word comparison. Avoid cloning/building a CFG for them.
  if (
    !originalNodes.some(
      (n) =>
        n.kind === NodeKind.CompoundStmt &&
        (n as CompoundStmt).statements.some((_, at, list) => loopAt(list, at, deps)),
    )
  )
    return body;
  const copy = cloneNode({ kind: NodeKind.CompoundStmt, statements: body } as CompoundStmt);
  const all = [...traverseAST(copy)],
    lists = all.filter((n) => n.kind === NodeKind.CompoundStmt).map((n) => (n as CompoundStmt).statements);
  const loops = lists.flatMap((list) =>
    list.flatMap((_, at) => {
      const m = loopAt(list, at, deps);
      return m ? [m] : [];
    }),
  );
  if (!loops.length) return body;
  const flow = buildFunctionFlow(copy.statements, deps.locals);
  const declarations = new Map<string, VariableDecl>();
  for (const n of all)
    if (n.kind === NodeKind.VariableDecl) declarations.set((n as VariableDecl).name.name, n as VariableDecl);
  for (const list of lists)
    for (let at = 0; at < list.length; ++at) {
      const exit = exitAt(list, at, deps);
      if (!exit) continue;
      const tried = new Set<string>();
      for (const seed of loops) {
        const key = JSON.stringify([seed.p, seed.q, seed.n]);
        if (tried.has(key)) continue;
        tried.add(key);
        const group = loops.filter((m) => m.p === seed.p && m.q === seed.q && m.n === seed.n);
        const differences = new Set<string>();
        for (const n of all)
          if (n.kind === NodeKind.AssignExpr) {
            const a = n as AssignExpr,
              target = id(a.left);
            if (a.operator === '=' && target && difference(a.right, seed, deps) !== undefined)
              differences.add(target);
          }
        if (differences.size !== 1) continue;
        const d = [...differences][0],
          temps = new Set([seed.p, seed.q, seed.n, d, exit.result]);
        if (
          temps.size !== 5 ||
          [...temps].some(
            (v) =>
              !declarations.has(v) ||
              deps.declarationCounts!.get(v) !== 1 ||
              deps.volatileNames?.has(v) ||
              declarations.get(v)!.initializer ||
              declarations.get(v)!.specifiers.length,
          )
        )
          continue;
        const ds = deps.shape(nameExpr(d));
        if (ds?.stars !== 0 || ds.base !== 'int') continue;
        const terminal = flow.nodeOf(exit.test);
        if (terminal === undefined) continue;
        const visited = new Set<number>();
        let valid = true;
        for (const m of group) {
          if ([m.setup[0].right, m.setup[1].right, m.length].some((e) => temps.has(id(e)!))) {
            valid = false;
            break;
          }
          if (
            deps.volatileNames?.has(id(m.length)!) ||
            !nonNullInput(m.setup[0].right, m, flow, deps) ||
            !nonNullInput(m.setup[1].right, m, flow, deps) ||
            !rangesValidOnMismatch(m, exit, flow, deps)
          ) {
            valid = false;
            break;
          }
          const loopNode = flow.nodeOf(m.loop),
            jumpNode = flow.nodeOf(m.mismatch);
          if (
            loopNode === undefined ||
            jumpNode === undefined ||
            flow.cfg.nodes[loopNode].succ.length !== 2
          ) {
            valid = false;
            break;
          }
          for (let count = 0; count < 4 && valid; ++count)
            for (const bytes of patterns(count)) {
              if (
                !proveTail(
                  flow,
                  flow.cfg.nodes[loopNode].succ[1],
                  terminal,
                  m,
                  d,
                  exit.result,
                  count,
                  bytes,
                  bytes.every((v) => v === 0),
                  visited,
                  deps,
                )
              ) {
                valid = false;
                break;
              }
            }
          for (const bytes of patterns(4))
            if (
              valid &&
              bytes.some((v) => v !== 0) &&
              !proveTail(
                flow,
                flow.cfg.nodes[jumpNode].succ[0],
                terminal,
                m,
                d,
                exit.result,
                4,
                bytes,
                false,
                visited,
                deps,
              )
            ) {
              valid = false;
              break;
            }
        }
        if (!valid) continue;
        // A branch can be impossible in every abstract case (e.g. all four bytes
        // equal after a differing word). Include its inert jump only when it is
        // inside a proved conditional and rejoins the proved tail. Outside jumps
        // into it are still rejected by the entry check below.
        let added = true;
        while (added) {
          added = false;
          for (const at of [...visited]) {
            const s = flow.cfg.nodes[at].stmt;
            if (s?.kind !== NodeKind.IfStmt) continue;
            for (const child of traverseAST(s)) {
              if (![NodeKind.GotoStmt, NodeKind.LabelStmt, NodeKind.NullStmt].includes(child.kind as never))
                continue;
              const nodeId = flow.nodeOf(child as Statement);
              if (nodeId === undefined || visited.has(nodeId)) continue;
              const node = flow.cfg.nodes[nodeId];
              if (node.succ.length === 1 && visited.has(node.succ[0])) {
                visited.add(nodeId);
                added = true;
              }
            }
          }
        }
        const returnNodes = new Set([...traverseAST(exit.ret)]);
        const tailStatement = (s: Statement): boolean => {
          const nodes = new Set([...traverseAST(s)]);
          return flow.cfg.nodes
            .filter((n) => (n.stmt && nodes.has(n.stmt)) || (n.expr && nodes.has(n.expr)))
            .every((n) => visited.has(n.id) || (!!n.stmt && returnNodes.has(n.stmt)));
        };
        const spans = group.map((m) => {
          let end = m.at + 1;
          while (end < m.list.length && tailStatement(m.list[end])) ++end;
          return { m, start: m.at - 2, end };
        });
        const erased = new Set<ASTNode>();
        for (const span of spans)
          for (const s of span.m.list.slice(span.start, span.end))
            for (const n of traverseAST(s)) erased.add(n);
        if (
          !erased.has(exit.test) ||
          [...visited].some((n) => flow.cfg.nodes[n].stmt && !erased.has(flow.cfg.nodes[n].stmt!))
        )
          continue;
        // Entering a loop body, its second setup, or the shared tail would bypass
        // part of the proof. Check the entire erased region, not just the tail.
        const removedNodes = new Set(
          flow.cfg.nodes
            .filter((n) => (n.stmt && erased.has(n.stmt)) || (n.expr && erased.has(n.expr)))
            .map((n) => n.id),
        );
        const starts = new Set(group.map((m) => flow.nodeOf(m.list[m.at - 2])));
        if (
          starts.has(undefined) ||
          flow.cfg.extraEntries.some((n) => removedNodes.has(n) && !starts.has(n)) ||
          flow.cfg.nodes.some(
            (n) => !removedNodes.has(n.id) && n.succ.some((s) => removedNodes.has(s) && !starts.has(s)),
          )
        )
          continue;
        if (
          all.some(
            (n) =>
              n.kind === NodeKind.Identifier &&
              temps.has((n as Identifier).name) &&
              !erased.has(n) &&
              ![...declarations.values()].some((v) => v.name === n),
          )
        )
          continue;
        for (const span of spans.sort((a, b) => b.start - a.start))
          span.m.list.splice(span.start, span.end - span.start, ...replacement(span.m, exit));
        return copy.statements;
      }
    }
  return body;
}
