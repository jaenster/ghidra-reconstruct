/**
 * One function definition as the steering checks see it: its parse, its tokens, its comments,
 * and every local and parameter resolved per declaration.
 *
 * The scope model is per declaration, not per name: a body that declares `nPresetY` in four
 * sibling blocks has four variables, each with its own reads and writes. A name-keyed map (as
 * ast.functionScope builds) would merge them into one variable read four times and hide every
 * single-use temporary the four blocks hold.
 */

import { Lexer, NodeKind, TokenKind, TriviaKind, getChildren, parse } from '@ghidra-mcp/cpp-parser';

type AnyNode = Record<string, any>;

export interface Comment {
  line: number;
  text: string;
}

export interface Tok {
  kind: string;
  text: string;
  line: number;
}

export interface Directive {
  line: number;
  text: string;
}

export interface Body {
  /** The definition text as given. */
  text: string;
  /** The definition, or null when the text did not parse. */
  fn: AnyNode | null;
  parseErrors: string[];
  tokens: Tok[];
  comments: Comment[];
  directives: Directive[];
  /** Line of the text's first line in the file it came from (1 for a stored body). */
  firstLine: number;
}

/** A local or parameter: one declaration and every use that resolves to it. */
export interface Var {
  name: string;
  decl: AnyNode;
  kind: 'local' | 'param';
  /** The statement that declares it (a DeclStmt), for a local. */
  stmt: AnyNode | null;
  reads: Use[];
  writes: Use[];
  escapes: Use[];
  /** Used as the object of `.` (a struct value): never a scalar. */
  memberBase: boolean;
}

export interface Use {
  id: AnyNode;
  /** Ancestors, outermost first, ending with the identifier's parent. */
  path: AnyNode[];
  /** For a write: the assignment (or `++`/`--`) node. */
  at?: AnyNode;
  /** A write to part of the object (`x.f = v`, `a[i] = v`). */
  partial?: boolean;
}

export interface Bound {
  vars: Var[];
  /** Identifier node -> the variable it names. */
  ref: Map<AnyNode, Var>;
  /** Labels or jumps the body contains. */
  hasGoto: boolean;
  /**
   * Whether a name the body does not declare is a variable (a load) rather than a function,
   * an enumerator or a macro constant. Unset: every such name is taken for a variable.
   */
  isVariable?: (parts: string[], isGlobal: boolean) => boolean;
}

export function lexBody(text: string): { tokens: Tok[]; comments: Comment[]; directives: Directive[] } {
  const tokens: Tok[] = [];
  const comments: Comment[] = [];
  const directives: Directive[] = [];
  let lexed;
  try {
    lexed = new Lexer(text, {}).tokenizeWithTrivia();
  } catch {
    return { tokens, comments, directives };
  }
  for (const t of lexed) {
    for (const tr of [...t.leadingTrivia, ...t.trailingTrivia]) {
      const line = tr.location.start.line;
      if (tr.kind === TriviaKind.LineComment || tr.kind === TriviaKind.BlockComment) comments.push({ line, text: tr.text });
      else if (tr.kind === TriviaKind.Directive) directives.push({ line, text: tr.text });
    }
    if (t.token.kind !== TokenKind.EOF) tokens.push({ kind: String(t.token.kind), text: t.token.text, line: t.token.location.start.line });
  }
  // A comment can be both one token's trailing and the next one's leading trivia.
  const seen = new Set<string>();
  const uniq = <T extends { line: number; text: string }>(xs: T[]) => xs.filter(x => {
    const k = `${x.line}\u0000${x.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { tokens, comments: uniq(comments), directives: uniq(directives) };
}

export function parseBody(text: string, firstLine = 1): Body {
  const { tokens, comments, directives } = lexBody(text);
  let fn: AnyNode | null = null;
  let parseErrors: string[] = [];
  try {
    const tu: AnyNode = parse(text, { recover: true });
    parseErrors = (tu.parseErrors ?? []).map((e: any) => String(e.message).replace(/^.*?:\d+:\d+: /, ''));
    fn = findDefinition(tu.declarations ?? []);
  } catch (e: any) {
    parseErrors = [String(e?.message ?? e)];
  }
  if (!fn && !parseErrors.length) parseErrors = ['no function definition'];
  return { text, fn, parseErrors, tokens, comments, directives, firstLine };
}

function findDefinition(ds: AnyNode[]): AnyNode | null {
  for (const d of ds) {
    if (!d) continue;
    if (d.kind === NodeKind.FunctionDecl && d.body) return d;
    if (d.kind === NodeKind.NamespaceDecl || d.kind === NodeKind.LinkageSpec) {
      const f = findDefinition(d.declarations ?? []);
      if (f) return f;
    }
    if (d.kind === NodeKind.TemplateDecl && d.declaration) {
      const f = findDefinition([d.declaration]);
      if (f) return f;
    }
  }
  return null;
}

export function lineOf(n: AnyNode | null | undefined): number {
  return n?.location?.start?.line ?? 0;
}

export function unparen(n: AnyNode | null | undefined): AnyNode | null | undefined {
  let x = n;
  while (x?.kind === NodeKind.ParenExpr) x = x.expression;
  return x;
}

const CAST_KINDS = new Set<string>([
  NodeKind.CStyleCastExpr, NodeKind.StaticCastExpr, NodeKind.ReinterpretCastExpr, NodeKind.ConstCastExpr,
  NodeKind.FunctionalCastExpr,
]);

export function isCastNode(n: AnyNode | null | undefined): boolean {
  return !!n && CAST_KINDS.has(n.kind);
}

export function castOperand(n: AnyNode): AnyNode | null {
  return n.expression ?? n.operand ?? (Array.isArray(n.arguments) ? n.arguments[0] : null) ?? null;
}

/** Type nodes carry no variable reads (sizeof(x) parses x as a type, and does not read it). */
function isTypeNode(n: AnyNode): boolean {
  return typeof n.kind === 'string' && n.kind.endsWith('Type');
}

/**
 * Resolve every identifier of the body to its declaration and classify each use as a read,
 * a write, or an escape (address taken).
 */
export function bindBody(fn: AnyNode): Bound {
  const vars: Var[] = [];
  const ref = new Map<AnyNode, Var>();
  const scopes: Array<Map<string, Var>> = [new Map()];
  let hasGoto = false;
  for (const p of fn.parameters ?? []) {
    const name = p?.name?.name;
    if (!name) continue;
    const v: Var = { name, decl: p, kind: 'param', stmt: null, reads: [], writes: [], escapes: [], memberBase: false };
    vars.push(v);
    scopes[0].set(name, v);
  }
  const lookup = (name: string): Var | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const v = scopes[i].get(name);
      if (v) return v;
    }
    return undefined;
  };

  const path: AnyNode[] = [];
  let currentDeclStmt: AnyNode | null = null;

  const classify = (id: AnyNode, v: Var) => {
    // Climb the lvalue chain rooted at the identifier: `x.f`, `a[i]` (x the array), parens.
    let child: AnyNode = id;
    let partial = false;
    let i = path.length - 1;
    for (; i >= 0; i--) {
      const p = path[i];
      if (p.kind === NodeKind.ParenExpr) { child = p; continue; }
      if (p.kind === NodeKind.MemberExpr && p.object === child && !p.isArrow) { v.memberBase = true; partial = true; child = p; continue; }
      if (p.kind === NodeKind.SubscriptExpr && p.array === child && isArrayDecl(v.decl)) { partial = true; child = p; continue; }
      break;
    }
    const parent = i >= 0 ? path[i] : null;
    const use: Use = { id, path: [...path] };
    if (parent?.kind === NodeKind.SizeofExpr) return;
    if (parent?.kind === NodeKind.AssignExpr && parent.left === child) {
      use.at = parent;
      use.partial = partial;
      v.writes.push(use);
      if (parent.operator !== '=' || partial) v.reads.push({ ...use });
      return;
    }
    if ((parent?.kind === NodeKind.UnaryExpr && (parent.operator === '++' || parent.operator === '--')) ||
        parent?.kind === NodeKind.PostfixExpr) {
      use.at = parent;
      use.partial = partial;
      v.writes.push(use);
      v.reads.push({ ...use });
      return;
    }
    if (parent?.kind === NodeKind.UnaryExpr && parent.operator === '&') { v.escapes.push(use); return; }
    // An array name anywhere else decays to a pointer: an alias that can write it.
    if (isArrayDecl(v.decl) && child === id) { v.escapes.push(use); v.reads.push(use); return; }
    v.reads.push(use);
  };

  const visit = (n: AnyNode | null | undefined): void => {
    if (!n || typeof n !== 'object' || typeof n.kind !== 'string') return;
    if (isTypeNode(n)) return;
    switch (n.kind) {
      case NodeKind.StructDecl:
      case NodeKind.ClassDecl:
      case NodeKind.UnionDecl:
      case NodeKind.EnumDecl:
        return;
      case NodeKind.LambdaExpr: {
        // A lambda's own parameters shadow; everything else it names is a read of the outer variable.
        scopes.push(new Map());
        for (const p of n.parameters ?? []) {
          const name = p?.name?.name;
          if (name) {
            const v: Var = { name, decl: p, kind: 'param', stmt: null, reads: [], writes: [], escapes: [], memberBase: false };
            scopes[scopes.length - 1].set(name, v);
          }
        }
        path.push(n);
        visit(n.body);
        path.pop();
        scopes.pop();
        return;
      }
      case NodeKind.GotoStmt:
      case NodeKind.LabelStmt:
        hasGoto = true;
        if (n.kind === NodeKind.GotoStmt) return;
        path.push(n);
        visit(n.statement);
        path.pop();
        return;
      case NodeKind.DeclStmt: {
        const prev = currentDeclStmt;
        currentDeclStmt = n;
        path.push(n);
        for (const d of n.declarations ?? []) visit(d);
        path.pop();
        currentDeclStmt = prev;
        return;
      }
      case NodeKind.VariableDecl: {
        path.push(n);
        visit(n.initializer);
        visit(n.bitWidth);
        path.pop();
        const name = n.name?.name;
        if (name) {
          const v: Var = { name, decl: n, kind: 'local', stmt: currentDeclStmt, reads: [], writes: [], escapes: [], memberBase: false };
          vars.push(v);
          scopes[scopes.length - 1].set(name, v);
        }
        return;
      }
      case NodeKind.MemberExpr:
        path.push(n);
        visit(n.object);
        path.pop();
        return;
      case NodeKind.Identifier: {
        const v = lookup(n.name);
        if (v) {
          ref.set(n, v);
          classify(n, v);
        }
        return;
      }
      case NodeKind.QualifiedId:
        return;
      case NodeKind.CompoundStmt:
      case NodeKind.ForStmt:
      case NodeKind.WhileStmt:
      case NodeKind.IfStmt:
      case NodeKind.SwitchStmt:
      case NodeKind.CatchClause: {
        scopes.push(new Map());
        path.push(n);
        for (const c of getChildren(n as any)) visit(c as AnyNode);
        path.pop();
        scopes.pop();
        return;
      }
      default:
        path.push(n);
        for (const c of getChildren(n as any)) visit(c as AnyNode);
        path.pop();
    }
  };
  path.push(fn);
  visit(fn.body);
  path.pop();
  return { vars, ref, hasGoto };
}

export function isArrayDecl(decl: AnyNode): boolean {
  let t = decl?.type;
  while (t?.kind === NodeKind.QualifiedType) t = t.type;
  return t?.kind === NodeKind.ArrayType;
}

export function hasQualifier(type: AnyNode | null | undefined, q: string): boolean {
  let t = type;
  while (t) {
    if ((t.qualifiers ?? []).includes(q) || (t.modifiers ?? []).includes(q)) return true;
    if (t.kind === NodeKind.QualifiedType) { t = t.type; continue; }
    return false;
  }
  return false;
}

/** Any qualifier anywhere in a type: `volatile int*` and `int* volatile` both carry it. */
export function typeMentions(type: AnyNode | null | undefined, q: string): boolean {
  let found = false;
  const rec = (t: AnyNode | null | undefined, depth: number) => {
    if (!t || typeof t !== 'object' || depth > 20 || found) return;
    if ((t.qualifiers ?? []).includes(q) || (t.modifiers ?? []).includes(q)) { found = true; return; }
    for (const k of ['type', 'pointee', 'elementType', 'referenced', 'returnType']) rec(t[k], depth + 1);
  };
  rec(type, 0);
  return found;
}

/** A pointer type (through qualifiers). */
export function isPointerTypeNode(type: AnyNode | null | undefined): boolean {
  let t = type;
  while (t?.kind === NodeKind.QualifiedType) t = t.type;
  return t?.kind === NodeKind.PointerType || t?.kind === NodeKind.FunctionType;
}

/** A struct-valued declaration cannot be a scalar temporary. */
export function isScalarDecl(v: Var): boolean {
  if (v.memberBase) return false;
  let t = v.decl?.type;
  while (t?.kind === NodeKind.QualifiedType) t = t.type;
  if (!t) return false;
  if (t.kind === NodeKind.ArrayType || t.kind === NodeKind.ElaboratedType) return false;
  if (v.decl?.initializer?.kind === NodeKind.InitListExpr || v.decl?.directInit) return false;
  return true;
}

export function isStaticDecl(v: Var): boolean {
  const s: string[] = v.decl?.specifiers ?? [];
  return s.includes('static') || s.includes('extern');
}

/**
 * What evaluating a subtree does, as far as moving another evaluation past it is concerned.
 * Memory is split by what can alias what: a named global, something reached through a
 * pointer, and a local whose address escaped. A store into a local array cannot change a
 * named global; a store through a pointer can change anything but a register local.
 */
export interface Effects {
  calls: number;
  /** Assignments, `++`, `--` anywhere in it. */
  sideEffects: number;
  localWrites: Set<Var>;
  localReads: Set<Var>;
  globalReads: boolean;
  ptrReads: boolean;
  escReads: boolean;
  globalWrites: boolean;
  ptrWrites: boolean;
  escWrites: boolean;
  /** Every name, member access, dereference, call and store it evaluates. */
  evals: number;
  /** Only the calls, memory reads and memory stores among them. */
  memEvals: number;
}

export function emptyEffects(): Effects {
  return {
    calls: 0, sideEffects: 0, localWrites: new Set(), localReads: new Set(), globalReads: false, ptrReads: false,
    escReads: false, globalWrites: false, ptrWrites: false, escWrites: false, evals: 0, memEvals: 0,
  };
}

export function mergeEffects(into: Effects, e: Effects): Effects {
  into.calls += e.calls;
  into.sideEffects += e.sideEffects;
  for (const v of e.localWrites) into.localWrites.add(v);
  for (const v of e.localReads) into.localReads.add(v);
  into.globalReads ||= e.globalReads;
  into.ptrReads ||= e.ptrReads;
  into.escReads ||= e.escReads;
  into.globalWrites ||= e.globalWrites;
  into.ptrWrites ||= e.ptrWrites;
  into.escWrites ||= e.escWrites;
  into.evals += e.evals;
  into.memEvals += e.memEvals;
  return into;
}

type Root = { kind: 'local'; v: Var } | { kind: 'global' } | { kind: 'ptr' };

/** What an lvalue stores into: a local (`x`, `x.f`, `a[i]` with a an array), a named global, or memory through a pointer. */
function lvalueRoot(n: AnyNode | null | undefined, b: Bound): Root {
  let x = unparen(n);
  for (;;) {
    if (!x) return { kind: 'ptr' };
    if (x.kind === NodeKind.Identifier) {
      const v = b.ref.get(x);
      return v ? { kind: 'local', v } : { kind: 'global' };
    }
    if (x.kind === NodeKind.QualifiedId) return { kind: 'global' };
    if (x.kind === NodeKind.MemberExpr && !x.isArrow) { x = unparen(x.object); continue; }
    if (x.kind === NodeKind.SubscriptExpr) {
      const base = unparen(x.array);
      if (base?.kind === NodeKind.Identifier) {
        const v = b.ref.get(base);
        if (v && isArrayDecl(v.decl)) return { kind: 'local', v };
        if (!v) return { kind: 'global' };
      }
      return { kind: 'ptr' };
    }
    return { kind: 'ptr' };
  }
}

/** `A::B::c` as its parts. */
export function qualifiedParts(q: AnyNode): string[] {
  const seg = (n: AnyNode | null | undefined): string => n?.name?.name ?? n?.name ?? '';
  return [...(q.qualifier ?? []).map(seg), seg(q.name) || (typeof q.name === 'string' ? q.name : '')].filter(Boolean);
}

/** The effects of evaluating `n`, skipping the subtrees in `skip`. */
export function effectsOf(n: AnyNode | null | undefined, b: Bound, skip: Set<AnyNode> = new Set()): Effects {
  const e = emptyEffects();
  const noteWrite = (lhs: AnyNode) => {
    e.evals++;
    const r = lvalueRoot(lhs, b);
    if (r.kind === 'local') {
      e.localWrites.add(r.v);
      if (r.v.escapes.length) { e.escWrites = true; e.memEvals++; }
    } else if (r.kind === 'global') { e.globalWrites = true; e.memEvals++; }
    else { e.ptrWrites = true; e.memEvals++; }
  };
  const rec = (x: AnyNode | null | undefined) => {
    if (!x || typeof x !== 'object' || typeof x.kind !== 'string' || skip.has(x)) return;
    if (isTypeNode(x)) return;
    switch (x.kind) {
      case NodeKind.SizeofExpr:
      case NodeKind.LambdaExpr:
      case NodeKind.StructDecl:
      case NodeKind.ClassDecl:
        return;
      case NodeKind.CallExpr: {
        e.calls++;
        e.evals++;
        e.memEvals++;
        // Naming the function called is not a load; calling through a variable reads it.
        const callee = unparen(x.callee);
        if (callee?.kind === NodeKind.QualifiedId || callee?.kind === NodeKind.Identifier && !b.ref.get(callee)) {
          for (const a of x.arguments ?? []) rec(a);
          return;
        }
        break;
      }
      case NodeKind.AssignExpr: {
        e.sideEffects++;
        noteWrite(x.left);
        // A plain store into a named variable does not evaluate the name.
        const l = unparen(x.left);
        if (x.operator === '=' && (l?.kind === NodeKind.Identifier || l?.kind === NodeKind.QualifiedId)) { rec(x.right); return; }
        break;
      }
      case NodeKind.PostfixExpr:
        e.sideEffects++;
        noteWrite(x.operand);
        break;
      case NodeKind.UnaryExpr:
        if (x.operator === '++' || x.operator === '--') { e.sideEffects++; noteWrite(x.operand); }
        else if (x.operator === '*') { e.ptrReads = true; e.evals++; e.memEvals++; }
        else if (x.operator === '&') { addressOf(x.operand); return; }
        break;
      case NodeKind.MemberExpr:
        e.evals++;
        if (x.isArrow) { e.ptrReads = true; e.memEvals++; }
        rec(x.object);
        return;
      case NodeKind.SubscriptExpr: {
        e.evals++;
        const base = unparen(x.array);
        const v = base?.kind === NodeKind.Identifier ? b.ref.get(base) : null;
        if (v && isArrayDecl(v.decl)) { if (v.escapes.length) { e.escReads = true; e.memEvals++; } }
        else if (base?.kind === NodeKind.Identifier && !v) { e.globalReads = true; e.memEvals++; }
        else { e.ptrReads = true; e.memEvals++; }
        break;
      }
      case NodeKind.Identifier: {
        const v = b.ref.get(x);
        e.evals++;
        if (v) {
          e.localReads.add(v);
          if (v.escapes.length) { e.escReads = true; e.memEvals++; }
        } else if (!b.isVariable || b.isVariable([x.name], false)) { e.globalReads = true; e.memEvals++; }
        return;
      }
      case NodeKind.QualifiedId:
        e.evals++;
        if (!b.isVariable || b.isVariable(qualifiedParts(x), !!x.isGlobal)) { e.globalReads = true; e.memEvals++; }
        return;
    }
    for (const c of getChildren(x as any)) rec(c as AnyNode);
  };
  // `&x`, `&p->f`, `&a[i]`: only what the address is computed from is evaluated, nothing is loaded.
  const addressOf = (x: AnyNode | null | undefined): void => {
    const y = unparen(x);
    if (!y) return;
    if (y.kind === NodeKind.Identifier || y.kind === NodeKind.QualifiedId) return;
    if (y.kind === NodeKind.MemberExpr) { if (y.isArrow) rec(y.object); else addressOf(y.object); return; }
    if (y.kind === NodeKind.SubscriptExpr) {
      const base = unparen(y.array);
      const v = base?.kind === NodeKind.Identifier ? b.ref.get(base) : null;
      const fixedBase = (v && isArrayDecl(v.decl)) || (base?.kind === NodeKind.Identifier && !v);
      if (!fixedBase) rec(y.array);
      rec(y.index);
      return;
    }
    if (y.kind === NodeKind.UnaryExpr && y.operator === '*') { rec(y.operand); return; }
    rec(y);
  };
  rec(n);
  return e;
}

/**
 * Would evaluating an initializer with effects `init` after `region` (instead of before it)
 * give every value the same? False when the region stores what the initializer reads, or
 * when either side calls something and the other touches memory.
 */
export function reorderConflicts(init: Effects, region: Effects): boolean {
  for (const w of region.localWrites) if (init.localReads.has(w)) return true;
  const regionStores = region.globalWrites || region.ptrWrites || region.escWrites;
  if (init.globalReads && (region.calls || region.globalWrites || region.ptrWrites)) return true;
  if ((init.ptrReads || init.escReads) && (region.calls || regionStores)) return true;
  if (init.calls && (region.calls || regionStores || region.globalReads || region.ptrReads || region.escReads)) return true;
  return false;
}
