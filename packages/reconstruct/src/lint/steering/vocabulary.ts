/**
 * The names a hand-owned body may use beyond the tree's symbol index, and the tree's own
 * vocabulary headers.
 *
 * The index binds what Ghidra owns: functions and globals by address, fields, enum constants,
 * types. A hand body that names anything else names something no regen can rebind - unless it
 * is the C library, Win32, or a spelling a vocabulary header defines on purpose. Those headers
 * are read from the tree itself: every macro they `#define` and every name they declare.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lexer, NodeKind, TokenKind, getChildren, parse } from '@ghidra-mcp/cpp-parser';
import { lexBody } from './body.js';

export const DEFAULT_VOCABULARY = resolve(dirname(fileURLToPath(import.meta.url)), 'vocabulary.json');

export interface VocabularyFile {
  vocabularyHeaders: string[];
  /** Headers that define the steering spellings (the platform macros): not counted as uses. */
  definitionHeaders: string[];
  generatorMacros: string[];
  volatileFieldFiles: string[];
  system: string[];
}

export interface Vocabulary {
  names: Set<string>;
  /** check id -> macro names whose expansion is that check's spelling (`D2_FORCEINLINE`). */
  macroSpellings: Map<string, string[]>;
  isVocabularyHeader(path: string): boolean;
  isDefinitionHeader(path: string): boolean;
  isVolatileFieldFile(path: string): boolean;
  accepts(parts: string[]): boolean;
}

/** `**` any depth, `*` within one segment; a path glob, matched against tree-relative paths. */
export function globMatcher(globs: string[]): (path: string) => boolean {
  const res = globs.map(g => new RegExp('^' + g.split('**').map(seg =>
    seg.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$'));
  return (p: string) => res.some(r => r.test(p));
}

export function readVocabularyFile(path = DEFAULT_VOCABULARY): VocabularyFile {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    vocabularyHeaders: raw.vocabularyHeaders ?? [],
    definitionHeaders: raw.definitionHeaders ?? [],
    generatorMacros: raw.generatorMacros ?? [],
    volatileFieldFiles: raw.volatileFieldFiles ?? [],
    system: raw.system ?? [],
  };
}

/** `#define NAME ...`: the macro's name and its expansion's tokens. */
export function defineOf(directive: string): { name: string; expansion: string[] } | null {
  let toks;
  try {
    toks = new Lexer(directive.replace(/^\s*#/, ''), {}).tokenize().filter((t: any) => t.kind !== TokenKind.EOF);
  } catch {
    return null;
  }
  if (toks[0]?.text !== 'define' || !toks[1]) return null;
  return { name: toks[1].text, expansion: toks.slice(2).map((t: any) => t.text) };
}

/** Names a header declares at namespace scope: functions, variables, types, enumerators. */
export function declaredNames(text: string): string[] {
  const out: string[] = [];
  let tu: any;
  try {
    tu = parse(text, { recover: true });
  } catch {
    return out;
  }
  const rec = (n: any, depth: number) => {
    if (!n || typeof n !== 'object' || depth > 6) return;
    switch (n.kind) {
      case NodeKind.FunctionDecl:
      case NodeKind.VariableDecl:
      case NodeKind.TypedefDecl:
      case NodeKind.EnumeratorDecl:
      case NodeKind.StructDecl:
      case NodeKind.ClassDecl:
      case NodeKind.UnionDecl:
      case NodeKind.EnumDecl: {
        const nm = n.name?.kind === NodeKind.QualifiedId ? n.name.name?.name : n.name?.name ?? n.name;
        if (typeof nm === 'string') out.push(nm);
        if (n.kind === NodeKind.FunctionDecl || n.kind === NodeKind.VariableDecl) return;
        break;
      }
    }
    for (const c of getChildren(n)) rec(c, depth + 1);
  };
  for (const d of tu.declarations ?? []) rec(d, 0);
  return out;
}

const CHECK_SPELLINGS: Record<string, string[]> = {
  forceinline: ['__forceinline', 'always_inline', '__always_inline__'],
  noinline: ['noinline', '__noinline__'],
};

/**
 * The vocabulary for one tree: the file's lists plus what the tree's vocabulary headers
 * define. `readTree(rel)` returns a tree file's text; `paths` are the tree's files.
 */
export function buildVocabulary(file: VocabularyFile, paths: string[], readTree: (rel: string) => string | undefined): Vocabulary {
  const names = new Set<string>([...file.system, ...file.generatorMacros]);
  const macroSpellings = new Map<string, string[]>();
  const isVocabularyHeader = globMatcher(file.vocabularyHeaders);
  for (const p of paths) {
    if (!isVocabularyHeader(p)) continue;
    const text = readTree(p);
    if (text === undefined) continue;
    const lexed = lexBody(text);
    // Everything a vocabulary header spells is vocabulary: the parser cannot read every
    // declaration form these headers use (a macro in specifier position), the lexer can.
    for (const t of lexed.tokens) if (t.kind === TokenKind.Identifier) names.add(t.text);
    for (const d of lexed.directives) {
      const def = defineOf(d.text);
      if (!def) continue;
      names.add(def.name);
      for (const [check, sp] of Object.entries(CHECK_SPELLINGS)) {
        if (def.expansion.some(t => sp.includes(t))) macroSpellings.set(check, [...(macroSpellings.get(check) ?? []), def.name]);
      }
    }
    for (const n of declaredNames(text)) names.add(n);
  }
  return {
    names,
    macroSpellings,
    isVocabularyHeader,
    isDefinitionHeader: globMatcher(file.definitionHeaders),
    isVolatileFieldFile: globMatcher(file.volatileFieldFiles),
    accepts: (parts: string[]) => names.has(parts.join('::')) || names.has(parts[parts.length - 1]),
  };
}
