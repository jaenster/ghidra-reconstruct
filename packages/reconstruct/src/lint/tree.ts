/**
 * Load an emitted tree into ASTs: every .cpp and .h, parsed with the project's own parser.
 *
 * Parsing runs in recovery mode. A declaration the parser cannot read costs that one
 * declaration, and it is recorded - a check that silently skips code it could not parse
 * reports "clean" for code it never looked at, which is worse than no check at all. The
 * CLI prints every unparsed declaration.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  Lexer,
  NodeKind,
  TriviaKind,
  emit,
  parse,
  type ASTNode,
  type FunctionDecl,
  type TranslationUnit,
} from '@ghidra-mcp/cpp-parser';
import { declName, functionScope, walk, type ScopeEntry } from './ast.js';
import { quotedIncludePath } from '../codegen/path-case.js';

export interface SourceFile {
  /** Path relative to the tree root, forward slashes. */
  path: string;
  isHeader: boolean;
  tu: TranslationUnit;
  parseErrors: Array<{ line: number; message: string }>;
  /** Every `#include "..."` directive, read from the lexer's directive trivia. */
  includes: Array<{ line: number; path: string }>;
}

export interface FunctionInfo {
  file: SourceFile;
  node: FunctionDecl;
  /** `ns::sub::Name` - the enclosing namespaces plus the declared name. */
  qualifiedName: string;
  /** Locals and parameters, computed on first use. */
  scope: () => Map<string, ScopeEntry>;
}

export interface GlobalDecl {
  name: string;
  type: any;
  line: number;
}

export interface Tree {
  root: string;
  files: SourceFile[];
  functions: FunctionInfo[];
  /** `extern` declarations in globals.h, by name. */
  globals: Map<string, GlobalDecl>;
  /**
   * Every file of the tree, any extension, relative and forward-slashed, as a checkout gets
   * it: git's index when the root is a repository (on a case-insensitive disk the index can
   * hold a spelling the disk no longer has, and the index is what a clone writes), else the
   * disk.
   */
  paths: string[];
  pathSource: 'git-index' | 'disk';
}

/** Directories that are not part of the program: VCS, build output, measurements, vendored ABI stubs. */
export const SKIP_DIRS = new Set(['.git', 'build', 'runs', 'metrics', 'cmake', 'thirdparty', 'node_modules']);

export function listSources(root: string): string[] {
  const out: string[] = [];
  const rec = (dir: string) => {
    for (const e of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(e)) continue;
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) rec(p);
      else if (e.endsWith('.cpp') || e.endsWith('.h')) out.push(p);
    }
  };
  rec(root);
  return out;
}

/** Every file under `root` outside SKIP_DIRS, relative and forward-slashed. */
export function listPaths(root: string): string[] {
  const out: string[] = [];
  const rec = (dir: string, rel: string) => {
    for (const e of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(e)) continue;
      const p = join(dir, e);
      const r = rel ? `${rel}/${e}` : e;
      if (statSync(p).isDirectory()) rec(p, r);
      else out.push(r);
    }
  };
  rec(root, '');
  return out;
}

/** The tree's files as git's index spells them, when `root` is the top of a repository. */
export function gitIndexPaths(root: string): string[] | null {
  if (!existsSync(join(root, '.git'))) return null;
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 << 20 });
    return out.split('\0').filter(p => p && !p.split('/').some(seg => SKIP_DIRS.has(seg)));
  } catch {
    return null;
  }
}

/** The quoted includes of a source text, from the lexer's directive trivia (EOF's included). */
export function sourceIncludes(path: string, text: string): Array<{ line: number; path: string }> {
  const out: Array<{ line: number; path: string }> = [];
  for (const t of new Lexer(text, { filename: path }).tokenizeWithTrivia()) {
    for (const tr of [...t.leadingTrivia, ...t.trailingTrivia]) {
      if (tr.kind !== TriviaKind.Directive) continue;
      const inc = quotedIncludePath(tr.text);
      if (inc) out.push({ line: tr.location.start.line, path: inc.path });
    }
  }
  return out;
}

export function parseSource(path: string, text: string): SourceFile {
  const tu = parse(text, { filename: path, recover: true });
  const parseErrors = (tu.parseErrors ?? []).map((e: any) => ({
    line: e.location?.start?.line ?? 0,
    message: String(e.message).replace(/^.*?:\d+:\d+: /, ''),
  }));
  return { path, isHeader: path.endsWith('.h'), tu, parseErrors, includes: sourceIncludes(path, text) };
}

function namespaceName(ns: any): string {
  return ns?.name?.name ?? '';
}

/** One segment of a name as written: `N`, or a template-id `TSHashTable<CELLIST, HASHKEY_NONE>`. */
function segmentText(n: any): string {
  if (!n) return '';
  return n.kind === NodeKind.TemplateType ? emit(n) : n.name;
}

function fnName(fn: any): string {
  const n = fn.name;
  if (!n) return '?';
  if (n.kind === NodeKind.Identifier) return n.name;
  if (n.kind === NodeKind.QualifiedId) {
    return [...(n.qualifier ?? []).map(segmentText), segmentText(n.name)].join('::');
  }
  return '?';
}

/** Every function definition in a file, with its namespace path. */
export function collectFunctions(file: SourceFile): FunctionInfo[] {
  const out: FunctionInfo[] = [];
  const rec = (decls: any[], prefix: string[]) => {
    for (const d of decls ?? []) {
      if (!d) continue;
      if (d.kind === NodeKind.NamespaceDecl) {
        rec(d.declarations, [...prefix, namespaceName(d)]);
      } else if (d.kind === NodeKind.LinkageSpec) {
        rec(d.declarations, prefix);
      } else if (d.kind === NodeKind.TemplateDecl) {
        // `template<> R C<A>::f() { ... }` - a member specialization is a function like any other.
        rec([d.declaration], prefix);
      } else if (d.kind === NodeKind.FunctionDecl && d.body) {
        out.push(makeFn(file, d, [...prefix, fnName(d)].filter(Boolean).join('::')));
      } else if (d.kind === NodeKind.StructDecl || d.kind === NodeKind.ClassDecl) {
        const sn = segmentText(d.name);
        for (const m of d.members ?? []) {
          if (m?.kind === NodeKind.FunctionDecl && m.body) {
            out.push(makeFn(file, m, [...prefix, sn, fnName(m)].filter(Boolean).join('::')));
          }
        }
      }
    }
  };
  rec(file.tu.declarations as any[], []);
  return out;
}

function makeFn(file: SourceFile, node: FunctionDecl, qualifiedName: string): FunctionInfo {
  let scope: Map<string, ScopeEntry> | null = null;
  return { file, node, qualifiedName, scope: () => (scope ??= functionScope(node)) };
}

/** `extern T name;` / `extern T name[N];` at the top level of globals.h. */
export function collectGlobals(file: SourceFile): Map<string, GlobalDecl> {
  const out = new Map<string, GlobalDecl>();
  for (const d of file.tu.declarations as any[]) {
    if (d?.kind !== NodeKind.VariableDecl) continue;
    if (!(d.specifiers ?? []).includes('extern')) continue;
    const name = declName(d);
    if (name) out.set(name, { name, type: d.type, line: d.location?.start?.line ?? 0 });
  }
  return out;
}

export interface LoadOptions {
  /** Restrict to these relative paths (tests). */
  only?: (rel: string) => boolean;
}

export function loadTree(root: string, opts: LoadOptions = {}): Tree {
  const files: SourceFile[] = [];
  for (const abs of listSources(root)) {
    const rel = relative(root, abs).split('\\').join('/');
    if (opts.only && !opts.only(rel)) continue;
    files.push(parseSource(rel, readFileSync(abs, 'utf8')));
  }
  const index = opts.only ? null : gitIndexPaths(root);
  return treeFromFiles(root, files, index ?? (opts.only ? files.map(f => f.path) : listPaths(root)),
    index ? 'git-index' : 'disk');
}

export function treeFromFiles(
  root: string, files: SourceFile[], paths: string[] = files.map(f => f.path),
  pathSource: Tree['pathSource'] = 'disk',
): Tree {
  const functions = files.flatMap(collectFunctions);
  const g = files.find(f => f.path === 'globals.h');
  const globals = g ? collectGlobals(g) : new Map<string, GlobalDecl>();
  return { root, files, functions, globals, paths, pathSource };
}

/**
 * File-scope variable declarations of a translation unit (not inside a function), by name.
 * A `static char buf[64];` at namespace scope is a real object a check may resolve to.
 */
export function fileScopeVars(file: SourceFile): Map<string, any> {
  const out = new Map<string, any>();
  walk(file.tu as ASTNode, (n) => {
    if (n.kind === NodeKind.FunctionDecl) return 'skip';
    if (n.kind === NodeKind.StructDecl || n.kind === NodeKind.ClassDecl || n.kind === NodeKind.UnionDecl) return 'skip';
    if (n.kind === NodeKind.VariableDecl) {
      const name = declName(n);
      if (name && !out.has(name)) out.set(name, n);
    }
    return undefined;
  });
  return out;
}
