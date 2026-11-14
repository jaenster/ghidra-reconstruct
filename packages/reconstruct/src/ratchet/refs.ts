/**
 * The references in one function definition, found on its AST.
 *
 * A *site* is a place in the text where a name stands for something declared elsewhere: a
 * name in an expression (`f`, `NS::g`), a member name (`p->field`) or a type name. Sites
 * are enumerated in one deterministic walk of the parse, so the same text always yields the
 * same numbered list; a stored body keeps its bindings by site number and the walk over the
 * stored text finds them again without the index it was captured under.
 *
 * A *binding* is what a site denotes, independent of spelling: a function or global by
 * address, a field by (struct, offset), an enum constant by (enum, value), a type by name,
 * a parameter of the enclosing function by its position when captured (the stored body's
 * parameter list says which name and storage that was; params.ts maps it to the current one).
 */
import { createHash } from 'node:crypto';
import { NodeKind, TokenKind, getChildren, parse, type ASTNode } from '@ghidra-mcp/cpp-parser';

import { lexTokens, matchParen, type Tok, type TypeRef } from './scan.js';
import { type Resolved, type SymbolIndex } from './symbol-index.js';

/**
 * `p`/`pt`/`rt`: a callee's parameter names, parameter types and return type when captured;
 * `ps`: its parameters' storage, when the tree's maps carried it (params.ts);
 * `x`: the name is the callee's extern entry (`<name>_Extern`, file-static-functions.ts);
 * `t`: a global's or field's type. A change in any of them means the stored body was written
 * against another declaration, and the rewrite refuses it rather than guess a cast.
 */
export type Binding =
  | { k: 'fn'; a: string[]; p?: string[]; ps?: string[]; pt?: string[]; rt?: string; x?: true }
  | { k: 'gl'; a: string; t?: string }
  | { k: 'en'; e: string; v: string }
  | { k: 'ty'; q: string }
  | { k: 'param'; i: number }
  | { k: 'fd'; s: string; o: number; t?: string }
  | { k: 'fdc'; c: Array<[string, number]> };

export function typeRefString(t: TypeRef | undefined): string | undefined {
  return t ? `${t.base}${'*'.repeat(t.ptr)}` : undefined;
}

export interface Site {
  kind: 'name' | 'member' | 'type';
  start: number;
  end: number;
  /** The spelling's parts, `['NS', 'f']`, and whether it starts with `::`. */
  parts: string[];
  isGlobal: boolean;
  /** For a name that is called: the argument ranges between its parentheses. */
  call?: { open: number; close: number; args: Array<[number, number]>; pure: boolean[] };
  /** The name is called, whether or not its argument list could be delimited (`call`). */
  called?: boolean;
}

export interface SiteScan {
  sites: Site[];
  /** Offset of the body's `{` in the text. */
  bodyStart: number;
  /** Offset one past the body's `}`. */
  bodyEnd: number;
  params: string[];
  /** Hash of the site spellings in order: proves a re-walk found the same sites. */
  siteHash: string;
  locals: Map<string, TypeRef | undefined>;
  paramTypes: Map<string, TypeRef | undefined>;
  root: AnyNode;
  toks: Tok[];
}

type AnyNode = ASTNode & Record<string, any>;

function span(n: AnyNode): [number, number] {
  return [n.location.start.offset, n.location.end.offset];
}

function tokenAt(toks: Tok[], offset: number): number {
  let lo = 0;
  let hi = toks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid].start === offset) return mid;
    if (toks[mid].start < offset) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/** The text range of a QualifiedId: its own location covers only the first token. */
function qualifiedSpan(n: AnyNode, toks: Tok[]): [number, number] {
  const parts: AnyNode[] = [...n.qualifier, n.name];
  let start = parts[0].location.start.offset;
  if (n.isGlobal) {
    const i = tokenAt(toks, start);
    if (i > 0 && toks[i - 1].kind === TokenKind.ColonColon) start = toks[i - 1].start;
  }
  return [start, parts[parts.length - 1].location.end.offset];
}

function nameParts(n: AnyNode | undefined): { parts: string[]; isGlobal: boolean } | undefined {
  if (!n) return undefined;
  if (n.kind === NodeKind.Identifier) return { parts: [n.name], isGlobal: false };
  if (n.kind === NodeKind.QualifiedId) {
    const ps: string[] = [];
    for (const q of n.qualifier) {
      if (q.kind !== NodeKind.Identifier) return undefined;
      ps.push(q.name);
    }
    if (n.name.kind !== NodeKind.Identifier) return undefined;
    ps.push(n.name.name);
    return { parts: ps, isGlobal: !!n.isGlobal };
  }
  return undefined;
}

/** TypeRef of a TypeNode. */
export function typeRefOfNode(n: AnyNode | null | undefined): TypeRef | undefined {
  if (!n) return undefined;
  switch (n.kind) {
    case NodeKind.PointerType: {
      const t = typeRefOfNode(n.pointee);
      return t ? { base: t.base, ptr: t.ptr + 1 } : undefined;
    }
    case NodeKind.ArrayType: {
      const t = typeRefOfNode(n.elementType ?? n.element ?? n.type);
      return t ? { base: t.base, ptr: t.ptr + 1 } : undefined;
    }
    case NodeKind.ReferenceType:
    case NodeKind.RValueReferenceType:
      return typeRefOfNode(n.referencedType ?? n.referenced ?? n.type ?? n.referent);
    case NodeKind.QualifiedType:
      return typeRefOfNode(n.type);
    case NodeKind.TypedefType:
    case NodeKind.ElaboratedType:
    case NodeKind.TemplateType: {
      const np = nameParts(n.name);
      return np ? { base: np.parts[np.parts.length - 1], ptr: 0 } : undefined;
    }
    case NodeKind.BuiltinType:
      return { base: n.name, ptr: 0 };
    default:
      return undefined;
  }
}

/** Does the expression have a side effect (a call, an assignment, ++/--)? */
function hasSideEffect(n: AnyNode): boolean {
  const stack: AnyNode[] = [n];
  while (stack.length) {
    const c = stack.pop()!;
    if (c.kind === NodeKind.CallExpr || c.kind === NodeKind.AssignExpr || c.kind === NodeKind.PostfixExpr
      || c.kind === NodeKind.NewExpr || c.kind === NodeKind.DeleteExpr) return true;
    if (c.kind === NodeKind.UnaryExpr && (c.operator === '++' || c.operator === '--')) return true;
    for (const ch of getChildren(c)) stack.push(ch as AnyNode);
  }
  return false;
}

/** The argument ranges of the parenthesised list that follows offset `from`. */
function callArgs(toks: Tok[], from: number): { open: number; close: number; args: Array<[number, number]> } | undefined {
  const i = toks.findIndex(t => t.start >= from);
  if (i < 0 || toks[i].kind !== TokenKind.LeftParen) return undefined;
  const close = matchParen(toks, i);
  if (close < 0) return undefined;
  const args: Array<[number, number]> = [];
  let depth = 0;
  let segStart = i + 1;
  for (let k = i + 1; k < close; k++) {
    const kk = toks[k].kind;
    if (kk === TokenKind.LeftParen || kk === TokenKind.LeftBracket || kk === TokenKind.LeftBrace) depth++;
    else if (kk === TokenKind.RightParen || kk === TokenKind.RightBracket || kk === TokenKind.RightBrace) depth--;
    else if (kk === TokenKind.Comma && depth === 0) {
      args.push([toks[segStart].start, toks[k - 1].end]);
      segStart = k + 1;
    }
  }
  if (segStart < close) args.push([toks[segStart].start, toks[close - 1].end]);
  return { open: toks[i].start, close: toks[close].end, args };
}

/**
 * Parse a function definition and enumerate its sites. `text` is the whole definition,
 * signature and body; only sites inside the body are listed.
 */
export function scanSites(text: string): SiteScan | undefined {
  const toks = lexTokens(text);
  if (!toks) return undefined;
  let tu;
  try {
    tu = parse(text, { recover: false });
  } catch {
    return undefined;
  }
  // The definition, possibly under `template<>`.
  const findFn = (ds: AnyNode[]): AnyNode | undefined => {
    for (const d of ds) {
      if (d.kind === NodeKind.FunctionDecl && d.body) return d;
      const inner = d.kind === NodeKind.FunctionDecl ? undefined : findFn(getChildren(d).filter(c => c.kind === NodeKind.FunctionDecl || c.kind === NodeKind.TemplateDecl) as AnyNode[]);
      if (inner) return inner;
    }
    return undefined;
  };
  const fn = findFn(tu.declarations as AnyNode[]);
  if (!fn) return undefined;
  const params: string[] = (fn.parameters as AnyNode[]).map(p => p.name?.name ?? '');
  const paramTypes = new Map<string, TypeRef | undefined>();
  for (const p of fn.parameters as AnyNode[]) if (p.name) paramTypes.set(p.name.name, typeRefOfNode(p.type));
  const bodyStart = (fn.body as AnyNode).location.start.offset;
  // The body ends at the last `}` of the text.
  let bodyEnd = text.length;
  for (let i = toks.length - 1; i >= 0; i--) if (toks[i].kind === TokenKind.RightBrace) { bodyEnd = toks[i].end; break; }
  const sites: Site[] = [];
  const locals = new Map<string, TypeRef | undefined>();

  const visit = (n: AnyNode | null | undefined, parent: AnyNode | undefined, role: string | undefined): void => {
    if (!n || typeof n !== 'object' || !('kind' in n)) return;
    switch (n.kind) {
      case NodeKind.VariableDecl:
        locals.set(n.name.name, typeRefOfNode(n.type));
        visit(n.type, n, 'type');
        visit(n.initializer, n, 'init');
        visit(n.bitWidth, n, 'init');
        return;
      case NodeKind.LabelStmt:
        visit(n.statement, n, undefined);
        return;
      case NodeKind.GotoStmt:
        return;
      case NodeKind.MemberExpr: {
        visit(n.object, n, 'object');
        const m = n.member as AnyNode;
        if (m.kind === NodeKind.Identifier) {
          const [s, e] = span(m);
          sites.push({ kind: 'member', start: s, end: e, parts: [m.name], isGlobal: false });
        }
        return;
      }
      case NodeKind.TypedefType:
      case NodeKind.ElaboratedType:
      case NodeKind.TemplateType: {
        const nm = n.name as AnyNode;
        const np = nameParts(nm);
        if (np) {
          const [s, e] = nm.kind === NodeKind.QualifiedId ? qualifiedSpan(nm, toks) : span(nm);
          sites.push({ kind: 'type', start: s, end: e, ...np });
        }
        for (const a of (n.arguments ?? []) as AnyNode[]) visit(a, n, 'targ');
        return;
      }
      case NodeKind.Identifier:
      case NodeKind.QualifiedId: {
        const np = nameParts(n);
        if (!np) return;
        const [s, e] = n.kind === NodeKind.QualifiedId ? qualifiedSpan(n, toks) : span(n);
        const site: Site = { kind: 'name', start: s, end: e, ...np };
        if (parent?.kind === NodeKind.CallExpr && role === 'callee') {
          site.called = true;
          const ca = callArgs(toks, e);
          if (ca && ca.args.length === (parent.arguments as AnyNode[]).length) {
            site.call = { ...ca, pure: (parent.arguments as AnyNode[]).map(a => !hasSideEffect(a)) };
          }
        }
        sites.push(site);
        return;
      }
      case NodeKind.CallExpr:
        visit(n.callee, n, 'callee');
        for (const a of n.arguments as AnyNode[]) visit(a, n, 'arg');
        return;
      default:
        for (const c of getChildren(n)) visit(c as AnyNode, n, undefined);
    }
  };
  visit(fn.body as AnyNode, fn, undefined);
  sites.sort((a, b) => a.start - b.start);
  const siteHash = createHash('sha256')
    .update(sites.map(s => `${s.kind}:${s.isGlobal ? '::' : ''}${s.parts.join('::')}`).join('\n'))
    .digest('hex').slice(0, 16);
  return { sites, bodyStart, bodyEnd, params, siteHash, locals, paramTypes, root: fn, toks };
}

/**
 * The structs a function body declares for itself, by name: each member's name and type.
 * The frame-group pass emits one (`struct __frame0_t { ... }; __frame0_t __frame0;`), and
 * the index, which reads headers, never sees it.
 */
function localStructs(body: AnyNode | undefined): Map<string, Map<string, TypeRef | undefined>> {
  const out = new Map<string, Map<string, TypeRef | undefined>>();
  const walk = (n: AnyNode | null | undefined): void => {
    if (!n || typeof n !== 'object' || !('kind' in n)) return;
    if (n.kind === NodeKind.StructDecl && n.name?.kind === NodeKind.Identifier && !n.isForwardDeclaration) {
      const fields = new Map<string, TypeRef | undefined>();
      for (const m of (n.members ?? []) as AnyNode[]) {
        // The parser reads a block-scope struct's members as variable declarations.
        if ((m.kind === NodeKind.FieldDecl || m.kind === NodeKind.VariableDecl) && m.name) fields.set(m.name.name, typeRefOfNode(m.type));
      }
      out.set(n.name.name, fields);
    }
    for (const c of getChildren(n)) walk(c as AnyNode);
  };
  walk(body);
  return out;
}

/** What each site of a scan denotes under `index`, seen from `scope`. */
export function bindSites(scan: SiteScan, index: SymbolIndex, scope: string[]): Array<Binding | undefined> {
  const out: Array<Binding | undefined> = new Array(scan.sites.length);
  const bySpan = new Map<number, number>();
  scan.sites.forEach((s, i) => bySpan.set(s.start, i));
  const isLocal = (name: string) => scan.locals.has(name) || scan.paramTypes.has(name);
  const typeOfResolved = (r: Resolved | undefined): TypeRef | undefined => {
    if (!r) return undefined;
    if (r.k === 'gl') return index.glByAddr.get(r.a)?.type;
    if (r.k === 'en') return { base: 'int', ptr: 0 };
    return undefined;
  };
  const bodyStructs = localStructs(scan.root.body as AnyNode);
  const fieldOf = (ot: TypeRef | undefined, isArrow: boolean, member: AnyNode) => {
    if (!ot || member.kind !== NodeKind.Identifier) return undefined;
    if (ot.ptr !== (isArrow ? 1 : 0)) return undefined;
    // A struct the body declares itself (the frame record `__frame0_t`): its members are the
    // body's own and bind to nothing, but their types carry the access path on, so a field
    // reached through one (`__frame0.dwTickCount.sHash`) binds with its type as anywhere else.
    const local = bodyStructs.get(ot.base);
    if (local) {
      if (!local.has(member.name)) return undefined;
      return { local: true as const, type: local.get(member.name) };
    }
    const st = index.structOf(ot.base, scope);
    if (!st) return undefined;
    const f = st.fields.find(x => x.name === member.name);
    return f ? { struct: st.qname, ...f } : undefined;
  };
  // The static type of an expression, as far as the index can say.
  const typeOf = (n: AnyNode | undefined): TypeRef | undefined => {
    if (!n) return undefined;
    switch (n.kind) {
      case NodeKind.Identifier:
      case NodeKind.QualifiedId: {
        const np = nameParts(n);
        if (!np) return undefined;
        if (!np.isGlobal && np.parts.length === 1) {
          if (scan.locals.has(np.parts[0])) return scan.locals.get(np.parts[0]);
          if (scan.paramTypes.has(np.parts[0])) return scan.paramTypes.get(np.parts[0]);
        }
        return typeOfResolved(index.resolve(np.parts, np.isGlobal, scope));
      }
      case NodeKind.ParenExpr: return typeOf(n.expression);
      case NodeKind.MemberExpr: return fieldOf(typeOf(n.object), n.isArrow, n.member)?.type;
      case NodeKind.CallExpr: {
        const np = nameParts(n.callee);
        if (!np) return undefined;
        const r = index.resolve(np.parts, np.isGlobal, scope);
        return r?.k === 'fn' && r.a.length === 1 ? index.fnByAddr.get(r.a[0])?.ret : undefined;
      }
      case NodeKind.CStyleCastExpr:
      case NodeKind.StaticCastExpr:
      case NodeKind.ReinterpretCastExpr:
      case NodeKind.ConstCastExpr:
      case NodeKind.FunctionalCastExpr:
        return typeRefOfNode(n.type);
      case NodeKind.UnaryExpr: {
        const t = typeOf(n.operand);
        if (!t) return undefined;
        if (n.operator === '*') return t.ptr > 0 ? { base: t.base, ptr: t.ptr - 1 } : undefined;
        if (n.operator === '&') return { base: t.base, ptr: t.ptr + 1 };
        return undefined;
      }
      case NodeKind.SubscriptExpr: {
        const t = typeOf(n.array);
        return t && t.ptr > 0 ? { base: t.base, ptr: t.ptr - 1 } : undefined;
      }
      case NodeKind.AssignExpr: return typeOf(n.left);
      case NodeKind.ConditionalExpr: return typeOf(n.thenExpr);
      default: return undefined;
    }
  };

  const walk = (n: AnyNode | null | undefined): void => {
    if (!n || typeof n !== 'object' || !('kind' in n)) return;
    if (n.kind === NodeKind.MemberExpr) {
      walk(n.object);
      const m = n.member as AnyNode;
      const i = bySpan.get(m.location.start.offset);
      if (i !== undefined && scan.sites[i].kind === 'member') {
        const f = fieldOf(typeOf(n.object), n.isArrow, m);
        if (f && !('local' in f)) out[i] = f.type ? { k: 'fd', s: f.struct, o: f.offset, t: typeRefString(f.type) } : { k: 'fd', s: f.struct, o: f.offset };
        else {
          const owners = index.fieldOwners.get(m.name);
          if (owners && owners.length > 0) out[i] = { k: 'fdc', c: owners.map(o => [o.s, o.o] as [string, number]) };
        }
      }
      return;
    }
    for (const c of getChildren(n)) walk(c as AnyNode);
  };
  walk(scan.root.body as AnyNode);

  scan.sites.forEach((s, i) => {
    if (s.kind === 'member') return;
    if (s.kind === 'name' && !s.isGlobal && s.parts.length === 1) {
      const pi = scan.params.indexOf(s.parts[0]);
      if (pi >= 0 && !scan.locals.has(s.parts[0])) { out[i] = { k: 'param', i: pi }; return; }
      if (isLocal(s.parts[0])) return;
    }
    const r = index.resolve(s.parts, s.isGlobal, scope);
    if (!r) return;
    if (s.kind === 'type' && r.k !== 'ty') return;
    if (r.k === 'fn') {
      const info = r.a.length === 1 ? index.fnByAddr.get(r.a[0]) : undefined;
      const b: Binding = r.x ? { k: 'fn', a: r.a, x: true } : { k: 'fn', a: r.a };
      if (info?.params) b.p = [...info.params];
      if (info?.storage) b.ps = [...info.storage];
      if (info?.paramTypes) b.pt = [...info.paramTypes];
      if (info?.retText !== undefined) b.rt = info.retText;
      out[i] = b;
    } else if (r.k === 'gl') {
      const t = typeRefString(index.glByAddr.get(r.a)?.type);
      out[i] = t ? { k: 'gl', a: r.a, t } : r;
    } else out[i] = r;
  });
  return out;
}

/** A comparison key for a binding: equal keys denote the same thing. */
export function bindingKey(b: Binding): string {
  switch (b.k) {
    case 'fn': return `fn:${[...b.a].sort().join(',')}${b.x ? ':extern' : ''}`;
    case 'gl': return `gl:${b.a}`;
    case 'en': return `en:${b.e}=${b.v}`;
    case 'ty': return `ty:${b.q}`;
    case 'param': return `param:${b.i}`;
    case 'fd': return `fd:${b.s}+${b.o}`;
    case 'fdc': return `fdc:${b.c.map(([s, o]) => `${s}+${o}`).sort().join(',')}`;
  }
}

/**
 * The body as a token sequence in which every bound site is its binding: two bodies that
 * differ only in how they spell the same things have the same form.
 */
export function bodyForm(scan: SiteScan, bindings: Array<Binding | undefined>): string[] {
  return bodyFormSites(scan, bindings).form;
}

/**
 * The body's form with, per entry, the spelling of a site the bindings leave unbound:
 * `spelling[k]` is set where `form[k]` is such a site.
 */
export function bodyFormSites(scan: SiteScan, bindings: Array<Binding | undefined>): { form: string[]; spelling: Array<string | undefined>; site: boolean[] } {
  const out: string[] = [];
  const spelling: Array<string | undefined> = [];
  const site: boolean[] = [];
  let si = 0;
  const sites = scan.sites;
  for (const t of scan.toks) {
    if (t.start < scan.bodyStart || t.kind === TokenKind.EOF) continue;
    while (si < sites.length && sites[si].end <= t.start) si++;
    const s = sites[si];
    if (s && t.start >= s.start && t.start < s.end) {
      if (t.start === s.start) {
        const b = bindings[si];
        const sp = `${s.isGlobal ? '::' : ''}${s.parts.join('::')}`;
        // A member bound by candidates alone compares by spelling.
        out.push(b && b.k !== 'fdc' ? `@{${bindingKey(b)}}` : sp);
        spelling.push(b ? undefined : sp);
        site.push(true);
      }
      continue;
    }
    out.push(t.text);
    spelling.push(undefined);
    site.push(false);
  }
  return { form: out, spelling, site };
}

/** The spelling of every site, bound or not, in form order (bodyFormSites). */
export function siteSpellings(scan: SiteScan): Array<string | undefined> {
  return bodyFormSites(scan, []).spelling;
}
