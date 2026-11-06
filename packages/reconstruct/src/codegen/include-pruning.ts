/**
 * Include what you use, on the finished tree.
 *
 * Each emitted file keeps a `#include` only when it names something that header
 * provides, or needs a type that header defines in full. A struct the file uses
 * only through a pointer or a reference is forward-declared instead, so a module
 * header no longer drags every module whose types it points at into each
 * translation unit that includes it.
 *
 * Every decision is read off the parsed files, not off the generator's tables:
 * what a header provides is what its declarations say, and what a file needs is
 * what its code does with each name. A type is needed complete where the code
 * does something only a complete type allows - an object or array of it, a field
 * access through it, pointer arithmetic or indexing on a pointer to it, sizeof,
 * a value of it passed, returned or assigned, a cast to it by value, a base
 * class, a qualifier naming it. Anything else (a pointer parameter, field, extern
 * or cast) needs only a declaration.
 *
 * The pass never widens what a translation unit sees. An include that has to
 * become direct (its home used to arrive through a header that no longer brings
 * it) is one the file already reached. A file the parser could not read whole
 * keeps its includes untouched, and so does every include inside a conditional.
 */

import { Lexer, NodeKind, TokenKind, TriviaKind, getChildren, parse } from '@ghidra-mcp/cpp-parser';
import { quotedIncludePath } from './path-case.js';

/** The guard the headers put around a declaration the Win32 SDK provides on Windows. */
const SDK_BLOCK_OPEN = '#ifndef _WIN32  // provided by the Win32 SDK / CRT on Windows';
const SDK_BLOCK_CLOSE = '#endif // _WIN32';
const FORWARD_BANNER = '// Forward declarations (used only by pointer here)';

export interface PrunableFile {
  path: string;
  content: string;
  includes?: string[];
  /** A header that exists to pass others on (a module's public header): kept as written. */
  reexport?: boolean;
}

export interface IncludePruneOptions {
  /** Types the Win32 SDK defines: their forward declarations go inside the SDK guard. */
  sdkTypeNames?: ReadonlySet<string>;
  /** Files never pruned (their includes kept as written); they still provide names to others. */
  keepAsWritten?: (path: string) => boolean;
  /** Told why each include a file keeps is kept: the first name that needed it. */
  trace?: (file: string, include: string, why: string) => void;
  /** Told of each member access whose object's type the analysis could not work out. */
  traceUntyped?: (file: string, member: unknown) => void;
  /** Told of each type a file needs complete, with the declaration or statement that needs it. */
  traceComplete?: (file: string, type: string, at: unknown) => void;
}

export interface IncludePruneResult {
  files: number;
  pruned: number;
  dropped: number;
  added: number;
  forwardDeclared: number;
  /** Files left untouched because the parser could not read all of them. */
  unparsed: string[];
  /** Member accesses whose object type could not be worked out, so every struct with that field counted as needed. */
  untypedMembers: number;
}

/**
 * `fndef`: a function DEFINED in a header (an inline host) - every translation unit that
 * calls it needs that definition, not only a declaration.
 */
type ProvideKind = 'type' | 'fwd' | 'typedef' | 'fn' | 'fndef' | 'var' | 'macro' | 'enum';

interface Provide {
  file: string;
  kind: ProvideKind;
  ns: string[];
}

/** A type as the analysis needs it: the named type it bottoms out in, and how many pointers above it. */
interface TypeRef {
  base: string | null;
  ptr: number;
  /** For a function or a pointer to one: what calling it returns. */
  ret?: TypeRef[];
  /** A template-id's arguments: completing it instantiates the template, which may hold them by value. */
  args?: any[];
}

interface StructInfo {
  key: 'struct' | 'class' | 'union';
  fields: Map<string, any[]>;
  methods: Map<string, any[]>;
  bases: string[];
}

interface FileFacts {
  path: string;
  parsed: boolean;
  tu: any;
  /** Every quoted include, in order: line index, the text's path, the resolved file, and whether a conditional encloses it. */
  includes: Array<{ line: number; text: string; target: string | undefined; conditional: boolean }>;
  /** name -> what this file itself declares under it. */
  provides: Map<string, Provide[]>;
  /** Every name the file references, with each spelling (qualifier chain) it is written in. */
  refs: Map<string, Set<string>>;
  /** The namespaces code in this file sits in ('' = global). */
  contexts: Set<string>;
  /** Names this file declares with the `union` class-key. */
  unions: Set<string>;
}

// ---------------------------------------------------------------------------
// Reading the files

function nameOf(n: any): string | undefined {
  if (!n) return undefined;
  if (n.kind === NodeKind.Identifier) return n.name;
  if (n.kind === NodeKind.QualifiedId) return nameOf(n.name);
  if (n.kind === NodeKind.TemplateType) return nameOf(n.name);
  return undefined;
}

function qualifierOf(n: any): string[] {
  if (!n || n.kind !== NodeKind.QualifiedId) return [];
  return (n.qualifier ?? []).map((q: any) => nameOf(q) ?? '');
}

function addProvide(map: Map<string, Provide[]>, name: string | undefined, p: Provide): void {
  if (!name) return;
  const list = map.get(name);
  if (list) list.push(p); else map.set(name, [p]);
}

const STRUCT_KINDS = new Set<string>([NodeKind.StructDecl, NodeKind.ClassDecl, NodeKind.UnionDecl]);

function structKey(kind: string): 'struct' | 'class' | 'union' {
  return kind === NodeKind.ClassDecl ? 'class' : kind === NodeKind.UnionDecl ? 'union' : 'struct';
}

/**
 * The `#define`d names of a text and their replacement texts, read from the lexer's
 * directive trivia, and the text's lines. A macro body is code too: the names it
 * spells are references of the file that defines it.
 */
function directivesOf(text: string): { macros: string[]; bodies: string[]; lines: string[] } {
  const macros: string[] = [];
  const bodies: string[] = [];
  try {
    for (const t of new Lexer(text, { preserveTrivia: true }).tokenizeWithTrivia()) {
      for (const tr of [...t.leadingTrivia, ...t.trailingTrivia]) {
        if (tr.kind !== TriviaKind.Directive) continue;
        const words = tr.text.replace(/^\s*#\s*/, '').split(/[\s(]+/);
        if (words[0] !== 'define' || !words[1]) continue;
        macros.push(words[1]);
        bodies.push(tr.text.replace(/^\s*#\s*define\s+/, '').replace(/\\\n/g, ' '));
      }
    }
  } catch { /* a text the lexer refuses provides no macros it can name */ }
  return { macros, bodies, lines: text.split('\n') };
}

/**
 * Every identifier the text references, each with the qualifier chains it is spelled with
 * (`x` alone for an unqualified use). A name written right after `.` or `->` is a member,
 * never a reference to a namespace-scope name, and is left out.
 */
function referencesOf(text: string, unions: Set<string>): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  let tokens: Array<{ kind: string; text: string }>;
  try {
    tokens = new Lexer(text, { preserveTrivia: false }).tokenize().map(t => ({ kind: t.kind, text: t.text }));
  } catch {
    tokens = [];
    for (const m of text.matchAll(/[A-Za-z_]\w*/g)) tokens.push({ kind: TokenKind.Identifier, text: m[0] });
  }
  const note = (chain: string[]) => {
    const name = chain[chain.length - 1].replace(/::$/, '');
    let set = refs.get(name);
    if (!set) refs.set(name, (set = new Set()));
    set.add(chain.join('::'));
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // The parser reads `union U` as a struct; the class-key a forward declaration has to repeat is taken here.
    if (t.kind === TokenKind.Union && tokens[i + 1]?.kind === TokenKind.Identifier) unions.add(tokens[i + 1].text);
    if (t.kind !== TokenKind.Identifier) continue;
    const prev = tokens[i - 1];
    if (prev && (prev.kind === TokenKind.Dot || prev.kind === TokenKind.Arrow)) continue;
    // Part of a longer chain: only the last segment is recorded, with the whole chain.
    if (tokens[i + 1]?.kind === TokenKind.ColonColon && tokens[i + 2]?.kind === TokenKind.Identifier) {
      // A qualifier is a name too, of a namespace or a type, recorded as `name::`.
      note([`${t.text}::`]);
      continue;
    }
    const chain = [t.text];
    let j = i - 1;
    while (j >= 1 && tokens[j].kind === TokenKind.ColonColon && tokens[j - 1].kind === TokenKind.Identifier) {
      chain.unshift(tokens[j - 1].text);
      j -= 2;
    }
    note(chain);
  }
  return refs;
}

function readFile(path: string, content: string): FileFacts {
  const { macros, bodies, lines } = directivesOf(content);
  const includes: FileFacts['includes'] = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trimStart();
    if (/^#\s*if/.test(s)) depth++;
    else if (/^#\s*endif/.test(s)) depth = Math.max(0, depth - 1);
    const inc = quotedIncludePath(lines[i]);
    if (inc) includes.push({ line: i, text: inc.path, target: undefined, conditional: depth > 0 });
  }
  let tu: any;
  let parsed = true;
  try {
    tu = parse(content, { filename: path, recover: true });
    if ((tu.parseErrors ?? []).length > 0) parsed = false;
  } catch {
    parsed = false;
    tu = { kind: NodeKind.TranslationUnit, declarations: [] };
  }
  const provides = new Map<string, Provide[]>();
  const contexts = new Set<string>(['']);
  const rec = (decls: any[], ns: string[]) => {
    for (const d of decls ?? []) {
      if (!d) continue;
      switch (d.kind) {
        case NodeKind.NamespaceDecl: {
          const inner = [...ns, ...qualifierOf(d.name), nameOf(d.name) ?? ''].filter(Boolean);
          contexts.add(inner.join('::'));
          rec(d.declarations, inner);
          break;
        }
        case NodeKind.LinkageSpec:
          rec(d.declarations, ns);
          break;
        case NodeKind.TemplateDecl:
          rec([d.declaration], ns);
          break;
        case NodeKind.StructDecl:
        case NodeKind.ClassDecl:
        case NodeKind.UnionDecl: {
          addProvide(provides, nameOf(d.name), { file: path, kind: d.isForwardDeclaration ? 'fwd' : 'type', ns });
          break;
        }
        case NodeKind.EnumDecl:
          addProvide(provides, nameOf(d.name), { file: path, kind: 'enum', ns });
          for (const e of d.enumerators ?? []) addProvide(provides, nameOf(e.name), { file: path, kind: 'enum', ns });
          break;
        case NodeKind.TypedefDecl:
        case NodeKind.TypeAliasDecl:
          addProvide(provides, nameOf(d.name), { file: path, kind: 'typedef', ns });
          break;
        case NodeKind.FunctionDecl: {
          const q = qualifierOf(d.name);
          const header = !/\.(cpp|c)$/.test(path);
          if (q.length === 0) addProvide(provides, nameOf(d.name), { file: path, kind: d.body && header ? 'fndef' : 'fn', ns });
          else contexts.add([...ns, ...q].join('::'));
          break;
        }
        case NodeKind.VariableDecl: {
          if (qualifierOf(d.name).length === 0) addProvide(provides, nameOf(d.name), { file: path, kind: 'var', ns });
          break;
        }
        default:
          break;
      }
    }
  };
  rec(tu.declarations, []);
  for (const m of macros) addProvide(provides, m, { file: path, kind: 'macro', ns: [] });
  const unions = new Set<string>();
  const refs = referencesOf(content, unions);
  for (const body of bodies) {
    for (const [name, spellings] of referencesOf(body, unions)) {
      const set = refs.get(name);
      if (set) for (const sp of spellings) set.add(sp); else refs.set(name, spellings);
    }
  }
  return { path, parsed, tu, includes, provides, refs, contexts, unions };
}

// ---------------------------------------------------------------------------
// The type tables, over every file

class TypeTables {
  structs = new Map<string, StructInfo>();
  typedefs = new Map<string, any>();
  functions = new Map<string, any[]>();
  variables = new Map<string, any[]>();
  /** Every struct that has a base or is one: a pointer conversion between them needs both complete. */
  inheritance = new Set<string>();
  /** field name -> every struct declaring it. */
  fieldOwners = new Map<string, Set<string>>();
  /** Class templates: a template cannot be forward-declared as a class, so a use needs its header. */
  templates = new Set<string>();

  collect(tu: any): void {
    const push = (m: Map<string, any[]>, k: string | undefined, v: any) => {
      if (!k || !v) return;
      const l = m.get(k);
      if (l) l.push(v); else m.set(k, [v]);
    };
    const rec = (decls: any[]) => {
      for (const d of decls ?? []) {
        if (!d) continue;
        if (d.kind === NodeKind.NamespaceDecl || d.kind === NodeKind.LinkageSpec) { rec(d.declarations); continue; }
        if (d.kind === NodeKind.TemplateDecl) {
          const inner = d.declaration;
          if (inner && STRUCT_KINDS.has(inner.kind) && inner.name?.kind === NodeKind.Identifier) this.templates.add(inner.name.name);
          rec([inner]);
          continue;
        }
        if (STRUCT_KINDS.has(d.kind)) { this.addStruct(d); continue; }
        if (d.kind === NodeKind.TypedefDecl || d.kind === NodeKind.TypeAliasDecl) {
          const n = nameOf(d.name);
          if (n && !this.typedefs.has(n)) this.typedefs.set(n, d.type);
          continue;
        }
        if (d.kind === NodeKind.FunctionDecl) {
          const q = qualifierOf(d.name);
          const owner = q[q.length - 1];
          if (owner && this.structs.has(owner)) push(this.structs.get(owner)!.methods, nameOf(d.name), d.returnType);
          push(this.functions, nameOf(d.name), d.returnType);
          continue;
        }
        if (d.kind === NodeKind.VariableDecl) { push(this.variables, nameOf(d.name), d.type); continue; }
      }
    };
    rec(tu.declarations);
  }

  /**
   * Run `fn` with the structs a function body defines in scope: a frame group
   * (`struct __frame0_t { ... } __frame0;`) is a local type, and every function has its own.
   */
  withLocalStructs<T>(body: any, fn: () => T): T {
    const locals: any[] = [];
    const stack = [body];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (STRUCT_KINDS.has(n.kind) && nameOf(n.name) && !n.isForwardDeclaration) { locals.push(n); continue; }
      if (n.kind === NodeKind.LambdaExpr) continue;
      for (const k of getChildren(n)) stack.push(k);
    }
    if (locals.length === 0) return fn();
    const saved = new Map<string, StructInfo | undefined>();
    for (const d of locals) {
      const n = nameOf(d.name)!;
      if (!saved.has(n)) saved.set(n, this.structs.get(n));
      this.structs.delete(n);
    }
    for (const d of locals) this.addStruct(d, false);
    try {
      return fn();
    } finally {
      for (const [n, info] of saved) {
        if (info) this.structs.set(n, info); else this.structs.delete(n);
      }
    }
  }

  private addStruct(d: any, shared = true): void {
    const n = nameOf(d.name);
    if (!n || d.isForwardDeclaration) return;
    let info = this.structs.get(n);
    if (!info) {
      info = { key: structKey(d.kind), fields: new Map(), methods: new Map(), bases: [] };
      this.structs.set(n, info);
    }
    for (const b of d.bases ?? []) {
      const bn = typeNameOf(b.type);
      if (bn) { info.bases.push(bn); this.inheritance.add(bn); this.inheritance.add(n); }
    }
    const addMembers = (members: any[]) => {
      for (const m of members ?? []) {
        if (!m) continue;
        if (m.kind === NodeKind.VariableDecl || m.kind === NodeKind.FieldDecl) {
          const fn = nameOf(m.name);
          if (!fn) continue;
          const l = info!.fields.get(fn);
          if (l) l.push(m.type); else info!.fields.set(fn, [m.type]);
          if (!shared) continue;
          let owners = this.fieldOwners.get(fn);
          if (!owners) this.fieldOwners.set(fn, (owners = new Set()));
          owners.add(n);
        } else if (m.kind === NodeKind.MethodDecl || m.kind === NodeKind.FunctionDecl) {
          const mn = nameOf(m.name);
          if (!mn) continue;
          const l = info!.methods.get(mn);
          if (l) l.push(m.returnType); else info!.methods.set(mn, [m.returnType]);
        } else if (STRUCT_KINDS.has(m.kind) && !nameOf(m.name)) {
          // An anonymous member struct or union: its fields are the enclosing type's.
          addMembers(m.members);
        } else if (STRUCT_KINDS.has(m.kind)) {
          this.addStruct(m, shared);
        }
      }
    };
    addMembers(d.members);
  }

  isStruct(name: string | null | undefined): name is string {
    return !!name && this.structs.has(name);
  }

  /** A type node as a TypeRef; typedefs are seen through. */
  ref(t: any, guard = 0): TypeRef {
    if (!t || guard > 16) return { base: null, ptr: 0 };
    switch (t.kind) {
      case NodeKind.PointerType: {
        const r = this.ref(t.pointee, guard + 1);
        return { ...r, ptr: r.ptr + 1 };
      }
      case NodeKind.ArrayType: {
        const r = this.ref(t.elementType, guard + 1);
        return { ...r, ptr: r.ptr + 1 };
      }
      case NodeKind.ReferenceType:
      case NodeKind.RValueReferenceType:
        return this.ref(t.referenced, guard + 1);
      case NodeKind.QualifiedType:
        return this.ref(t.type, guard + 1);
      case NodeKind.FunctionType:
        return { base: null, ptr: 0, ret: [this.ref(t.returnType, guard + 1)] };
      case NodeKind.ElaboratedType:
      case NodeKind.TypedefType:
      case NodeKind.TemplateType: {
        const n = nameOf(t.name);
        if (!n) return { base: null, ptr: 0 };
        if (!this.structs.has(n) && this.typedefs.has(n)) return this.ref(this.typedefs.get(n), guard + 1);
        const args = t.kind === NodeKind.TemplateType ? (t.arguments ?? []).map((a: any) => a?.type).filter(Boolean) : [];
        return args.length > 0 ? { base: n, ptr: 0, args } : { base: n, ptr: 0 };
      }
      default:
        return { base: null, ptr: 0 };
    }
  }
}

function typeNameOf(t: any): string | undefined {
  if (!t) return undefined;
  switch (t.kind) {
    case NodeKind.ElaboratedType:
    case NodeKind.TypedefType:
    case NodeKind.TemplateType:
      return nameOf(t.name);
    case NodeKind.QualifiedType:
      return typeNameOf(t.type);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// What a file needs complete

interface Usage {
  complete: Set<string>;
  untypedMembers: number;
}

/**
 * The struct types a file needs complete. A function declaration's by-value parameter
 * and return types count: a caller needs them so, and the header declaring the function
 * is where callers get them.
 */
function completeTypes(
  tu: any, tables: TypeTables, onUntyped?: (member: any) => void, onComplete?: (type: string, at: any) => void,
): Usage {
  let at: any = null;
  const complete = new Set<string>();
  if (onComplete) {
    const add = complete.add.bind(complete);
    complete.add = (n: string) => { if (!complete.has(n)) onComplete(n, at); return add(n); };
  }
  let untypedMembers = 0;
  const mark = (n: string | null | undefined) => { if (tables.isStruct(n)) complete.add(n); };

  /** A declarator's type in a position that needs the type complete: an object, a field, a by-value parameter. */
  const needObject = (t: any, guard = 0): void => {
    if (!t || guard > 16) return;
    switch (t.kind) {
      case NodeKind.QualifiedType: needObject(t.type, guard + 1); return;
      case NodeKind.ArrayType: needObject(t.elementType, guard + 1); return;
      case NodeKind.PointerType:
      case NodeKind.ReferenceType:
      case NodeKind.RValueReferenceType:
      case NodeKind.FunctionType:
        return;
      case NodeKind.TemplateType:
        mark(nameOf(t.name));
        for (const a of t.arguments ?? []) if (a?.type) needObject(a.type, guard + 1);
        return;
      case NodeKind.ElaboratedType:
      case NodeKind.TypedefType: {
        const n = nameOf(t.name);
        if (!n) return;
        if (tables.isStruct(n)) { complete.add(n); return; }
        const r = tables.ref(t);
        if (r.ptr === 0) mark(r.base);
        return;
      }
      default:
        return;
    }
  };
  /** A typedef's target or an extern's type: only an array of the type needs it complete. */
  const needArrayElement = (t: any, guard = 0): void => {
    if (!t || guard > 16) return;
    if (t.kind === NodeKind.QualifiedType) needArrayElement(t.type, guard + 1);
    else if (t.kind === NodeKind.ArrayType) needObject(t.elementType, guard + 1);
  };

  type Scope = Map<string, any>;
  const lookupVar = (name: string, scope: Scope | null): TypeRef[] => {
    const local = scope?.get(name);
    if (local) return [tables.ref(local)];
    const g = tables.variables.get(name);
    if (g) return g.map(t => tables.ref(t));
    return [];
  };
  const dedupe = (rs: TypeRef[]): TypeRef[] => {
    const seen = new Set<string>();
    const out: TypeRef[] = [];
    for (const r of rs) {
      const k = `${r.base}:${r.ptr}:${r.ret ? 'f' : ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
      if (out.length >= 8) break;
    }
    return out;
  };
  const deref = (rs: TypeRef[]): TypeRef[] => rs.filter(r => r.ptr > 0).map(r => ({ ...r, ptr: r.ptr - 1 }));
  /** Arithmetic on a pointer, or indexing it, needs the pointee's size. */
  const markRef = (r: TypeRef) => {
    mark(r.base);
    for (const a of r.args ?? []) needObject(a);
  };
  /** A qualifier: a class, or a template-id whose instantiation the qualified name needs. */
  const markQualifier = (q: any) => {
    if (q?.kind === NodeKind.TemplateType) needObject(q);
    else mark(nameOf(q));
  };
  const pointeeSized = (rs: TypeRef[]) => { for (const r of rs) if (r.ptr === 1) markRef(r); };
  const valueUse = (rs: TypeRef[]) => { for (const r of rs) if (r.ptr === 0 && !r.ret) markRef(r); };
  const fnReturns = (rs: TypeRef[]): TypeRef[] => {
    const out: TypeRef[] = [];
    for (const r of rs) if (r.ret && r.ptr <= 1) out.push(...r.ret);
    return out;
  };
  const markCastPair = (to: TypeRef, from: TypeRef[]) => {
    if (to.ptr === 0) { mark(to.base); return; }
    const inherits = (n: string | null) => !!n && tables.inheritance.has(n);
    if (inherits(to.base) || from.some(f => inherits(f.base))) {
      mark(to.base);
      for (const f of from) mark(f.base);
    }
  };

  const evalExpr = (e: any, scope: Scope | null, thisType: TypeRef | null, addressTaken = false): TypeRef[] => {
    if (!e || typeof e !== 'object') return [];
    const ev = (x: any, at = false) => evalExpr(x, scope, thisType, at);
    let result: TypeRef[] = [];
    switch (e.kind) {
      case NodeKind.Identifier: {
        const v = lookupVar(e.name, scope);
        if (v.length > 0) { result = v; break; }
        const f = tables.functions.get(e.name);
        if (f) { result = [{ base: null, ptr: 0, ret: f.map(t => tables.ref(t)) }]; break; }
        // A type named where an expression stands: offsetof(T, f), a misread functional cast.
        mark(e.name);
        break;
      }
      case NodeKind.QualifiedId: {
        for (const q of e.qualifier ?? []) markQualifier(q);
        const n = nameOf(e.name);
        if (!n) break;
        const owner = nameOf(e.qualifier?.[e.qualifier.length - 1]);
        const info = owner ? tables.structs.get(owner) : undefined;
        if (info?.methods.has(n)) { result = [{ base: null, ptr: 0, ret: info.methods.get(n)!.map(t => tables.ref(t)) }]; break; }
        const v = tables.variables.get(n);
        if (v) { result = v.map(t => tables.ref(t)); break; }
        const f = tables.functions.get(n);
        if (f) result = [{ base: null, ptr: 0, ret: f.map(t => tables.ref(t)) }];
        break;
      }
      case NodeKind.ThisExpr:
        result = thisType ? [thisType] : [];
        break;
      case NodeKind.ParenExpr:
        return ev(e.expression, addressTaken);
      case NodeKind.UnaryExpr: {
        if (e.operator === '&') { result = ev(e.operand, true).map(r => ({ ...r, ptr: r.ptr + 1 })); break; }
        const inner = ev(e.operand);
        if (e.operator === '*') {
          const fns = inner.filter(r => r.ret && r.ptr <= 1);
          result = [...deref(inner.filter(r => !r.ret)), ...fns.map(r => ({ ...r, ptr: 0 }))];
        } else if (e.operator === '++' || e.operator === '--') {
          pointeeSized(inner);
          result = inner;
        } else {
          result = inner.filter(r => r.ptr > 0);
        }
        break;
      }
      case NodeKind.PostfixExpr: {
        const inner = ev(e.operand);
        pointeeSized(inner);
        result = inner;
        break;
      }
      case NodeKind.BinaryExpr: {
        const l = ev(e.left);
        const r = ev(e.right);
        if (e.operator === '+' || e.operator === '-') {
          pointeeSized(l);
          pointeeSized(r);
          result = e.operator === '-' && l.some(x => x.ptr > 0) && r.some(x => x.ptr > 0) ? [] : [...l, ...r].filter(x => x.ptr > 0);
        }
        break;
      }
      case NodeKind.AssignExpr: {
        const l = ev(e.left);
        ev(e.right);
        if (e.operator === '+=' || e.operator === '-=') pointeeSized(l);
        result = l;
        break;
      }
      case NodeKind.ConditionalExpr:
        ev(e.condition);
        result = [...ev(e.thenExpr), ...ev(e.elseExpr)];
        break;
      case NodeKind.CommaExpr: {
        const parts = (e.expressions ?? []).map((x: any) => ev(x));
        result = parts[parts.length - 1] ?? [];
        break;
      }
      case NodeKind.MemberExpr: {
        const obj = ev(e.object);
        const bases = e.isArrow ? deref(obj) : obj;
        const member = nameOf(e.member);
        for (const q of e.member?.kind === NodeKind.QualifiedId ? e.member.qualifier ?? [] : []) markQualifier(q);
        const typed = bases.filter(b => b.ptr === 0 && tables.isStruct(b.base));
        // A type the tree does not define (the SDK's WNDCLASSA) has no header here to keep.
        if (typed.length === 0 && bases.some(b => b.base && !tables.typedefs.has(b.base))) break;
        if (typed.length === 0) {
          // The object's type is unknown: every struct with such a member may be the one.
          untypedMembers++;
          onUntyped?.(e);
          for (const o of tables.fieldOwners.get(member ?? '') ?? []) complete.add(o);
          const methods: TypeRef[] = [];
          for (const [sn, info] of tables.structs) {
            const m = member ? info.methods.get(member) : undefined;
            if (m) { complete.add(sn); methods.push(...m.map(t => tables.ref(t))); }
          }
          if (methods.length > 0) result = [{ base: null, ptr: 0, ret: methods }];
          break;
        }
        for (const b of typed) {
          markRef(b);
          const found = member ? findMember(tables, b.base!, member) : undefined;
          if (found?.field) result.push(...found.field.map(t => tables.ref(t)));
          if (found?.method) result.push({ base: null, ptr: 0, ret: found.method.map(t => tables.ref(t)) });
        }
        break;
      }
      case NodeKind.SubscriptExpr: {
        const a = ev(e.array);
        const i = ev(e.index);
        pointeeSized(a);
        pointeeSized(i);
        result = deref([...a, ...i]);
        break;
      }
      case NodeKind.CallExpr: {
        const callee = ev(e.callee);
        for (const a of e.arguments ?? []) valueUse(ev(a));
        result = fnReturns(callee);
        valueUse(result);
        break;
      }
      case NodeKind.CStyleCastExpr:
      case NodeKind.StaticCastExpr:
      case NodeKind.ReinterpretCastExpr:
      case NodeKind.ConstCastExpr:
      case NodeKind.DynamicCastExpr: {
        const from = ev(e.expression);
        const to = tables.ref(e.type);
        needObject(e.type);
        markCastPair(to, from);
        result = [to];
        break;
      }
      case NodeKind.FunctionalCastExpr: {
        for (const a of e.arguments ?? []) ev(a);
        needObject(e.type);
        result = [tables.ref(e.type)];
        break;
      }
      case NodeKind.SizeofExpr:
      case NodeKind.AlignofExpr:
      case NodeKind.TypeidExpr: {
        const operand = e.operand ?? e.type;
        if (e.isType || e.kind === NodeKind.AlignofExpr) needObject(operand);
        else valueUse(ev(operand));
        break;
      }
      case NodeKind.NewExpr:
        needObject(e.type);
        for (const p of e.placement ?? []) ev(p);
        if (e.initializer) ev(e.initializer);
        if (e.arraySize) ev(e.arraySize);
        result = [{ ...tables.ref(e.type), ptr: tables.ref(e.type).ptr + 1 }];
        break;
      case NodeKind.DeleteExpr:
        pointeeSized(ev(e.expression));
        break;
      case NodeKind.InitListExpr:
        for (const x of e.elements ?? []) valueUse(ev(x));
        break;
      case NodeKind.DesignatedInitExpr:
        valueUse(ev(e.initializer));
        break;
      default:
        // Anything else: read every expression below it for the uses it holds.
        for (const k of getChildren(e)) visit(k, scope, thisType);
        break;
    }
    result = dedupe(result);
    if (!addressTaken) valueUse(result);
    return result;
  };

  const declareLocals = (body: any, scope: Scope) => {
    const stack = [body];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (n.kind === NodeKind.VariableDecl || n.kind === NodeKind.ParameterDecl) {
        const name = nameOf(n.name);
        if (name && !scope.has(name)) scope.set(name, n.type);
      }
      if (n.kind === NodeKind.LambdaExpr) continue;
      for (const k of getChildren(n)) stack.push(k);
    }
  };

  /** Walk a statement or declaration; every expression root found is evaluated. */
  const visit = (n: any, scope: Scope | null, thisType: TypeRef | null): void => {
    if (!n || typeof n !== 'object' || !n.kind) return;
    if (onComplete && !isExpressionNode(n) && n.kind !== NodeKind.CompoundStmt) at = n;
    switch (n.kind) {
      case NodeKind.FunctionDecl:
      case NodeKind.MethodDecl:
      case NodeKind.ConstructorDecl:
      case NodeKind.DestructorDecl:
        visitFunction(n, thisType);
        return;
      case NodeKind.VariableDecl:
      case NodeKind.FieldDecl: {
        for (const q of n.name?.kind === NodeKind.QualifiedId ? n.name.qualifier ?? [] : []) markQualifier(q);
        const isExtern = (n.specifiers ?? []).includes('extern');
        if (isExtern) needArrayElement(n.type);
        else needObject(n.type);
        if (n.initializer) valueUse(evalExpr(n.initializer, scope, thisType));
        if (n.bitWidth) evalExpr(n.bitWidth, scope, thisType);
        return;
      }
      case NodeKind.TypedefDecl:
      case NodeKind.TypeAliasDecl:
        needArrayElement(n.type);
        return;
      case NodeKind.StructDecl:
      case NodeKind.ClassDecl:
      case NodeKind.UnionDecl: {
        for (const b of n.bases ?? []) needObject(b.type);
        const self = nameOf(n.name);
        const inner: TypeRef | null = self ? { base: self, ptr: 1 } : thisType;
        for (const m of n.members ?? []) visit(m, scope, inner);
        return;
      }
      case NodeKind.EnumDecl:
        for (const en of n.enumerators ?? []) if (en.value) evalExpr(en.value, scope, thisType);
        return;
      case NodeKind.StaticAssertDecl:
        for (const k of getChildren(n)) {
          if (isExpressionNode(k)) evalExpr(k, scope, thisType);
        }
        return;
      default:
        break;
    }
    if (isExpressionNode(n)) { evalExpr(n, scope, thisType); return; }
    for (const k of getChildren(n)) visit(k, scope, thisType);
  };

  const visitFunction = (fn: any, enclosing: TypeRef | null) => {
    const q = qualifierOf(fn.name);
    for (const s of fn.name?.kind === NodeKind.QualifiedId ? fn.name.qualifier ?? [] : []) markQualifier(s);
    const owner = q[q.length - 1];
    const thisType: TypeRef | null = owner && tables.isStruct(owner) ? { base: owner, ptr: 1 } : enclosing;
    // A definition needs its by-value parameter and return types complete; a declaration is
    // held to the same, so a header declaring one hands its callers the complete type.
    if (fn.returnType) needObject(fn.returnType);
    for (const p of fn.parameters ?? []) {
      needObject(p.type);
      if (p.defaultValue) evalExpr(p.defaultValue, null, thisType);
    }
    if (!fn.body) return;
    const scope: Scope = new Map();
    for (const p of fn.parameters ?? []) {
      const pn = nameOf(p.name);
      if (pn) scope.set(pn, p.type);
    }
    declareLocals(fn.body, scope);
    tables.withLocalStructs(fn.body, () => {
      for (const init of fn.initializers ?? []) for (const k of getChildren(init)) visit(k, scope, thisType);
      visit(fn.body, scope, thisType);
    });
  };

  for (const d of tu.declarations ?? []) visit(d, null, null);
  return { complete, untypedMembers };
}

function isExpressionNode(n: any): boolean {
  switch (n?.kind) {
    case NodeKind.Identifier: case NodeKind.QualifiedId: case NodeKind.ThisExpr: case NodeKind.ParenExpr:
    case NodeKind.BinaryExpr: case NodeKind.UnaryExpr: case NodeKind.PostfixExpr: case NodeKind.ConditionalExpr:
    case NodeKind.AssignExpr: case NodeKind.CommaExpr: case NodeKind.MemberExpr: case NodeKind.SubscriptExpr:
    case NodeKind.CallExpr: case NodeKind.CStyleCastExpr: case NodeKind.StaticCastExpr:
    case NodeKind.DynamicCastExpr: case NodeKind.ReinterpretCastExpr: case NodeKind.ConstCastExpr:
    case NodeKind.FunctionalCastExpr: case NodeKind.SizeofExpr: case NodeKind.AlignofExpr: case NodeKind.TypeidExpr:
    case NodeKind.NewExpr: case NodeKind.DeleteExpr: case NodeKind.InitListExpr: case NodeKind.DesignatedInitExpr:
      return true;
    default:
      return false;
  }
}

function findMember(tables: TypeTables, struct: string, member: string, guard = 0): { field?: any[]; method?: any[] } | undefined {
  const info = tables.structs.get(struct);
  if (!info || guard > 8) return undefined;
  const field = info.fields.get(member);
  const method = info.methods.get(member);
  if (field || method) return { field, method };
  for (const b of info.bases) {
    const found = findMember(tables, b, member, guard + 1);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The pass

/** How many leading directories two paths share. */
function nearness(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  let n = 0;
  while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++;
  return n;
}

/** Does a declaration in namespace `ns` answer a reference spelled `spelling` from a file whose code sits in `contexts`? */
function answers(ns: string[], name: string, spelling: string, contexts: Set<string>): boolean {
  const chain = spelling.split('::');
  if (chain.length > 1) {
    const full = [...ns, name];
    if (chain.length > full.length) return false;
    for (let i = 1; i <= chain.length; i++) {
      if (chain[chain.length - i] !== full[full.length - i]) return false;
    }
    return true;
  }
  const own = ns.join('::');
  if (own === '') return true;
  for (const c of contexts) if (c === own || c.startsWith(`${own}::`)) return true;
  return false;
}

export function pruneIncludes(files: Map<string, PrunableFile>, options: IncludePruneOptions = {}): IncludePruneResult {
  const sources = [...files.keys()].filter(p => /\.(h|hpp|inl|cpp|c)$/.test(p));
  const facts = new Map<string, FileFacts>();
  for (const p of sources) facts.set(p, readFile(p, files.get(p)!.content));

  const resolveInclude = (from: string, text: string): string | undefined => {
    if (facts.has(text)) return text;
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    const parts = (dir ? `${dir}/${text}` : text).split('/');
    const out: string[] = [];
    for (const s of parts) {
      if (s === '..') out.pop();
      else if (s !== '.' && s !== '') out.push(s);
    }
    const joined = out.join('/');
    return facts.has(joined) ? joined : undefined;
  };
  for (const f of facts.values()) for (const inc of f.includes) inc.target = resolveInclude(f.path, inc.text);

  const tables = new TypeTables();
  // Structs first: a method defined out of line is filed under its class.
  for (const f of facts.values()) tables.collect({ declarations: (f.tu.declarations ?? []).filter((d: any) => d && (STRUCT_KINDS.has(d.kind) || d.kind === NodeKind.NamespaceDecl || d.kind === NodeKind.LinkageSpec)) });
  for (const f of facts.values()) tables.collect({ declarations: (f.tu.declarations ?? []).filter((d: any) => d && !STRUCT_KINDS.has(d.kind)) });

  const unionNames = new Set<string>();
  for (const f of facts.values()) for (const u of f.unions) unionNames.add(u);
  /** A typedef can qualify a name only when it names a class. */
  const namesClass = (name: string): boolean => {
    const r = tables.ref({ kind: NodeKind.TypedefType, name: { kind: NodeKind.Identifier, name } });
    return r.ptr === 0 && tables.isStruct(r.base);
  };
  const keyOf = (name: string): string => unionNames.has(name) ? 'union' : (tables.structs.get(name)?.key ?? 'struct');

  const providers = new Map<string, Provide[]>();
  for (const f of facts.values()) {
    for (const [name, list] of f.provides) {
      const all = providers.get(name);
      if (all) all.push(...list); else providers.set(name, [...list]);
    }
  }

  // The include graph as written: the reach each file has today.
  const direct = (p: string): string[] => (facts.get(p)?.includes ?? []).map(i => i.target).filter((t): t is string => !!t);
  const oldClosure = new Map<string, Set<string>>();
  const closureOf = (p: string, edges: (p: string) => string[], memo: Map<string, Set<string>>): Set<string> => {
    const hit = memo.get(p);
    if (hit) return hit;
    const out = new Set<string>();
    memo.set(p, out);
    const stack = [...edges(p)];
    while (stack.length) {
      const h = stack.pop()!;
      if (out.has(h)) continue;
      out.add(h);
      const known = memo.get(h);
      if (known && known !== out && h !== p) { for (const k of known) out.add(k); continue; }
      stack.push(...edges(h));
    }
    return out;
  };

  const result: IncludePruneResult = {
    files: facts.size, pruned: 0, dropped: 0, added: 0, forwardDeclared: 0, unparsed: [], untypedMembers: 0,
  };
  const finalIncludes = new Map<string, string[]>();
  const finalClosure = new Map<string, Set<string>>();
  const newEdges = (p: string): string[] => finalIncludes.get(p) ?? direct(p);

  /** Everything a list of includes reaches, through each one's final include list. */
  const closeOver = (targets: string[]): Set<string> => {
    const out = new Set<string>();
    const stack = [...targets];
    while (stack.length) {
      const h = stack.pop()!;
      if (out.has(h)) continue;
      out.add(h);
      const done = finalClosure.get(h);
      if (done) { for (const k of done) out.add(k); continue; }
      stack.push(...newEdges(h));
    }
    return out;
  };

  const state = new Map<string, 'busy' | 'done'>();
  const order: string[] = [];
  const dfs = (p: string) => {
    if (state.has(p)) return;
    state.set(p, 'busy');
    for (const t of direct(p)) dfs(t);
    state.set(p, 'done');
    order.push(p);
  };
  for (const p of [...facts.keys()].sort()) dfs(p);
  for (const p of facts.keys()) closureOf(p, direct, oldClosure);

  for (const path of order) {
    const f = facts.get(path)!;
    const file = files.get(path)!;
    // Nothing to place a new include or a forward declaration after: left as written.
    const anchored = f.includes.some(i => i.target && !i.conditional);
    // A re-export header's includes are its content: nothing in it uses them, its users do.
    const keepWhole = !f.parsed || !anchored || file.reexport === true || options.keepAsWritten?.(path);
    if (!f.parsed) result.unparsed.push(path);
    if (keepWhole) {
      finalIncludes.set(path, direct(path));
      finalClosure.set(path, closeOver(direct(path)));
      continue;
    }
    const usage = completeTypes(f.tu, tables,
      options.traceUntyped ? m => options.traceUntyped!(path, m) : undefined,
      options.traceComplete ? (t, n) => options.traceComplete!(path, t, n) : undefined);
    result.untypedMembers += usage.untypedMembers;
    const old = oldClosure.get(path)!;
    const stem = path.replace(/\.[^./]+$/, '');

    // The includes that stay whatever the file uses: outside the tree, in a conditional,
    // the file's own unit header, or a header the parser could not read whole.
    const kept = new Set<string>();
    for (const inc of f.includes) {
      if (!inc.target || inc.conditional) continue;
      const t = inc.target;
      const targetFacts = facts.get(t)!;
      if (!targetFacts.parsed || t.replace(/\.[^./]+$/, '') === stem || t.startsWith(`${stem}.`)) kept.add(t);
    }
    const reach = new Set<string>();
    const addReach = (h: string) => {
      if (reach.has(h)) return;
      reach.add(h);
      for (const k of finalClosure.get(h) ?? closeOver(newEdges(h))) reach.add(k);
    };
    for (const inc of f.includes) if (inc.target && inc.conditional) addReach(inc.target);
    for (const k of kept) addReach(k);

    const writtenDirect = new Set(f.includes.map(i => i.target).filter((t): t is string => !!t));
    const fwd: Array<{ name: string; key: string }> = [];
    const added: string[] = [];
    const require = (candidates: Provide[], why: string) => {
      if (candidates.some(c => c.file === path || reach.has(c.file))) return;
      const choices = [...new Set(candidates.map(c => c.file).filter(c => old.has(c)))];
      if (choices.length === 0) return;
      // Several headers declare it: the one the file already includes, else the one
      // nearest the file in the tree - its own module's, where the layout has one.
      const pick = choices.sort((a, b) => nearness(path, b) - nearness(path, a) || (a < b ? -1 : a > b ? 1 : 0))
        .find(c => writtenDirect.has(c)) ?? choices[0];
      kept.add(pick);
      addReach(pick);
      options.trace?.(path, pick, choices.length > 1 ? `${why}, of ${choices.length}` : why);
    };

    const names = [...f.refs.keys()].sort();
    for (const name of names) {
      const all = providers.get(name);
      if (!all) continue;
      const own = f.provides.get(name);
      const reachable = all.filter(p => old.has(p.file));
      if (reachable.length === 0) continue;
      for (const spelling of [...f.refs.get(name)!].sort()) {
        // A qualifier names a namespace or a type, never a function or an object.
        const qualifier = spelling.endsWith('::');
        const visible = (p: Provide) => qualifier
          ? p.kind === 'type' || p.kind === 'fwd' || p.kind === 'enum' || (p.kind === 'typedef' && namesClass(name))
          : answers(p.ns, name, spelling, f.contexts);
        // What the file itself declares answers the reference - except a function or an
        // object it defines: its declaring header stays, so declaration and definition meet.
        if (own?.some(p => visible(p) && p.kind !== 'fn' && p.kind !== 'fndef' && p.kind !== 'var')) continue;
        // Lookup finds a name only where its spelling and the enclosing namespaces lead;
        // a declaration elsewhere is not the one referenced, whatever its name.
        const matched = reachable.filter(visible);
        if (matched.length === 0) continue;
        const typeLike = matched.filter(p => p.kind === 'type' || p.kind === 'fwd');
        // Every namespace the name is visible from keeps one declaration: dropping the one
        // lookup used to find could leave another of the same name for it to bind to.
        // An inline body is needed beside the declaration, by every caller.
        const byNamespace = new Map<string, Provide[]>();
        for (const p of matched) {
          if (p.kind === 'type' || p.kind === 'fwd') continue;
          const k = `${p.ns.join('::')}${p.kind === 'fndef' ? ' body' : ''}`;
          const list = byNamespace.get(k);
          if (list) list.push(p); else byNamespace.set(k, [p]);
        }
        for (const k of [...byNamespace.keys()].sort()) require(byNamespace.get(k)!, `${spelling} (${byNamespace.get(k)![0].kind})`);
        if (typeLike.length === 0) continue;
        if (tables.templates.has(name)
          || (tables.isStruct(name) && (usage.complete.has(name) || tables.inheritance.has(name)))) {
          const defs = typeLike.filter(p => p.kind === 'type');
          require(defs.length > 0 ? defs : typeLike, `${name} complete`);
        } else if (!typeLike.some(p => p.file === path || reach.has(p.file))) {
          fwd.push({ name, key: keyOf(name) });
        }
      }
    }
    // Types the code needs complete without spelling them: a field reached through a chain.
    for (const name of [...usage.complete].sort()) {
      if (f.refs.has(name) || f.provides.get(name)?.some(p => p.kind === 'type')) continue;
      const defs = (providers.get(name) ?? []).filter(p => p.kind === 'type' && old.has(p.file));
      if (defs.length > 0) require(defs, `${name} complete, unnamed`);
    }
    // A forward declaration the kept includes made unnecessary after all.
    const forwardNames = new Set<string>();
    const forwards = fwd.filter(d => {
      if (forwardNames.has(d.name)) return false;
      forwardNames.add(d.name);
      return !(providers.get(d.name) ?? []).some(p => (p.kind === 'type' || p.kind === 'fwd') && reach.has(p.file));
    });

    // Rewrite: drop what is not kept, put each newly direct include where the include it
    // used to arrive through stood, and forward-declare the pointer-only types.
    const writtenTargets = new Set(f.includes.map(i => i.target).filter(Boolean) as string[]);
    for (const k of kept) if (!writtenTargets.has(k)) added.push(k);
    const lastInclude = Math.max(...f.includes.filter(i => !i.conditional).map(i => i.line));
    const lines = file.content.split('\n');
    const insertAt = new Map<number, string[]>();
    for (const a of added.sort()) {
      const via = f.includes.find(i => i.target && !i.conditional && (i.target === a || oldClosure.get(i.target)?.has(a)));
      const at = via?.line ?? lastInclude;
      const list = insertAt.get(at);
      if (list) list.push(a); else insertAt.set(at, [a]);
    }
    const dropLines = new Set<number>();
    for (const inc of f.includes) {
      if (!inc.target || inc.conditional) continue;
      if (!kept.has(inc.target)) dropLines.add(inc.line);
    }
    const seenTarget = new Set<string>();
    for (const inc of f.includes) {
      if (!inc.target || inc.conditional || dropLines.has(inc.line)) continue;
      if (seenTarget.has(inc.target)) dropLines.add(inc.line);
      seenTarget.add(inc.target);
    }
    if (dropLines.size === 0 && added.length === 0 && forwards.length === 0) {
      finalIncludes.set(path, direct(path));
      finalClosure.set(path, reach);
      continue;
    }
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!dropLines.has(i)) out.push(lines[i]);
      for (const a of insertAt.get(i) ?? []) out.push(`#include "${a}"`);
      if (i === lastInclude && forwards.length > 0) {
        out.push('', FORWARD_BANNER);
        const sdk = forwards.filter(d => options.sdkTypeNames?.has(d.name));
        for (const d of forwards) if (!options.sdkTypeNames?.has(d.name)) out.push(`${d.key} ${d.name};`);
        if (sdk.length > 0) {
          out.push(SDK_BLOCK_OPEN);
          for (const d of sdk) out.push(`${d.key} ${d.name};`);
          out.push(SDK_BLOCK_CLOSE);
        }
      }
    }
    const content = out.join('\n');
    const newTargets = [...new Set([
      ...f.includes.filter(i => i.target && (i.conditional || kept.has(i.target))).map(i => i.target!),
      ...added,
    ])];
    files.set(path, {
      ...file,
      content,
      includes: file.includes?.filter(i => !facts.has(i) || newTargets.includes(i) || f.includes.some(x => x.text === i && x.conditional)),
    });
    finalIncludes.set(path, newTargets);
    finalClosure.set(path, reach);
    result.pruned++;
    result.dropped += [...dropLines].length;
    result.added += added.length;
    result.forwardDeclared += forwards.length;
  }
  return result;
}
