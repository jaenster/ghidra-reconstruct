/**
 * A module's public header: its library interface, one file.
 *
 * Every Blizzard module was its own DLL, and another DLL saw only what it
 * imported. `<M>/<M>.h` is that surface for the tree: the declarations of every
 * function and global another module references, and the definitions of the
 * types those modules can reach, copied out of M's own headers. It includes only
 * the public headers of the modules M imports, so the public headers form the
 * import graph and cannot close a cycle. A LoadLibrary edge never becomes an
 * include.
 *
 * What cannot be said that way stays out: a declaration or type that needs a
 * type complete from a module M may not import (or one of M's own types that
 * needs such a thing) is not published. Its users keep including the internal
 * header that has it, and the build's gate report lists that include.
 *
 * A type copied here is guarded (`D2_DEFINED_<name>`), and so is the same
 * definition in M's internal header, so a translation unit that reaches both
 * defines it once. A declaration is repeated as written, which C++ allows.
 */

import { scanReferences } from './needle-index.js';
import type { CompletenessOracle } from './include-pruning.js';
import {
  DECLS_BEGIN_MARKER, DECLS_END_MARKER, DECL_MARKER, DECL_END_MARKER, TYPE_MARKER, TYPE_END_MARKER, GLOBAL_MARKER, GLOBAL_END_MARKER,
  INLINE_MARKER, INLINE_END_MARKER,
} from './header.js';
import type { ModuleGraph } from '../modules/module-libraries.js';
import type { ModuleExternDecl } from './globals-header.js';

const FPTD_GUARD = '#ifndef RECON_FPTD_';

/** The guard around one type definition, shared by the public header and the header that owns it. */
export function definedGuard(name: string): string {
  return `D2_DEFINED_${name.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/** The guard around one inline body, shared by the public header and the unit's inline header. */
export function inlineGuard(address: string): string {
  return `D2_DEFINED_INLINE_${normalizedAddress(address)}`;
}

function normalizedAddress(a: string): string {
  return a.slice(a.lastIndexOf(':') + 1).toLowerCase().replace(/^0x/, '').padStart(8, '0');
}

export interface MarkedGroup {
  /** Header the group sits in. */
  header: string;
  /** A declaration's address, or a type's name. */
  key: string;
  text: string;
  /** The namespace the header wraps it in. */
  namespace?: string;
}

/**
 * A header's marked groups with the namespace each sits in - function declarations,
 * type definitions, a unit data header's externs - and its function-pointer typedef blocks.
 */
export function readMarkedGroups(path: string, content: string): {
  decls: MarkedGroup[];
  types: MarkedGroup[];
  globals: MarkedGroup[];
  inlines: MarkedGroup[];
  typedefBlocks: Map<string, string>;
} {
  const decls: MarkedGroup[] = [];
  const types: MarkedGroup[] = [];
  const globals: MarkedGroup[] = [];
  const inlines: MarkedGroup[] = [];
  const typedefBlocks = new Map<string, string>();
  const ns: string[] = [];
  let group: { kind: 'decl' | 'type' | 'global' | 'inline'; key: string; lines: string[] } | undefined;
  let block: { name: string; lines: string[] } | undefined;
  for (const line of content.split('\n')) {
    if (block) {
      block.lines.push(line);
      if (line.startsWith('#endif')) {
        if (!typedefBlocks.has(block.name)) typedefBlocks.set(block.name, block.lines.join('\n'));
        block = undefined;
      }
      continue;
    }
    if (line.startsWith(FPTD_GUARD) && !group) { block = { name: line.slice(FPTD_GUARD.length).trim(), lines: [line] }; continue; }
    if (line.startsWith(DECL_MARKER)) { group = { kind: 'decl', key: line.slice(DECL_MARKER.length).trim(), lines: [] }; continue; }
    if (line.startsWith(TYPE_MARKER)) { group = { kind: 'type', key: line.slice(TYPE_MARKER.length), lines: [] }; continue; }
    if (line.startsWith(GLOBAL_MARKER)) { group = { kind: 'global', key: line.slice(GLOBAL_MARKER.length).trim(), lines: [] }; continue; }
    if (line.startsWith(INLINE_MARKER)) { group = { kind: 'inline', key: normalizedAddress(line.slice(INLINE_MARKER.length).trim()), lines: [] }; continue; }
    if (group && (line === DECL_END_MARKER || line === TYPE_END_MARKER || line === GLOBAL_END_MARKER || line === INLINE_END_MARKER)) {
      const g: MarkedGroup = { header: path, key: group.key, text: group.lines.join('\n') };
      if (group.kind !== 'type' && ns.length) g.namespace = ns.join('::');
      ({ decl: decls, type: types, global: globals, inline: inlines })[group.kind].push(g);
      group = undefined;
      continue;
    }
    if (group) { group.lines.push(line); continue; }
    if (line === DECLS_BEGIN_MARKER || line === DECLS_END_MARKER) continue;
    // The emitter's namespace lines: `namespace X {` and `} // namespace X`.
    if (line.startsWith('namespace ') && line.endsWith(' {')) ns.push(line.slice('namespace '.length, -2).trim());
    else if (line.startsWith('} // namespace ')) ns.pop();
  }
  return { decls, types, globals, inlines, typedefBlocks };
}

export interface PublicHeaderInput {
  graph: ModuleGraph;
  /** Every header, by path, with its markers still in. */
  headers: ReadonlyMap<string, string>;
  /** Function addresses another module references, per owning module. */
  publicFunctions: ReadonlyMap<string, ReadonlySet<string>>;
  /** A function's emitted name, by normalized address. */
  functionNames: ReadonlyMap<string, string>;
  /** Global names another module references, per owning module: module data and unit data alike. */
  publicGlobals: ReadonlyMap<string, ReadonlySet<string>>;
  /** Types other modules can reach, per owning module. */
  publicTypes: ReadonlyMap<string, ReadonlySet<string>>;
  moduleExterns: ReadonlyMap<string, readonly ModuleExternDecl[]>;
  oracle: CompletenessOracle;
  /** Type name -> the header that defines it (the generator's placement). */
  typeOwnerMap: ReadonlyMap<string, string>;
  /** globals.h: the root header that includes every module - never an include of a public header. */
  globalsPath: string;
  /** The root header every generated header includes first. */
  platformHeader: string;
  /** Types the Win32 SDK defines: never forward-declared, never required. */
  sdkTypeNames?: ReadonlySet<string>;
}

export interface PublicHeaderPlan {
  module: string;
  path: string;
  content: string;
  /** What was published. */
  types: string[];
  functions: string[];
  globals: string[];
  /** Inline bodies (header inlines another module calls), by address. */
  inlines: string[];
  /** What another module uses but the header could not carry, with the type or name that stopped it. */
  withheld: Array<{ kind: Item['kind']; key: string; needs: string }>;
  includes: string[];
}

const BANNER = `// Auto-generated by ghidra-mcp ${String.fromCharCode(0x2014)} DO NOT EDIT`;

interface Item {
  kind: 'type' | 'function' | 'global' | 'inline';
  key: string;
  text: string;
  namespace?: string;
  /** Names the item needs defined: struct types it holds by value, typedefs it spells. */
  needs: string[];
  /** An inline body's functions, objects and macros: each needs a declaration. */
  symbols: string[];
  /** Struct names it spells, by pointer or otherwise. */
  structs: string[];
  /** Function-pointer typedefs it spells whose guarded block is copied. */
  typedefs: string[];
}

/**
 * Plan every module's public header. A type, declaration or extern is published when
 * every type it needs defined is published by M itself, by a module M imports, or by a
 * root header other than globals.h; that is a fixpoint, since a module's types need
 * other modules' published types.
 */
export function planPublicHeaders(input: PublicHeaderInput, gateLines: (module: string) => string[]): Map<string, PublicHeaderPlan> {
  const { graph, oracle } = input;
  const sdk = input.sdkTypeNames ?? new Set<string>();

  // Every module's marked groups, in path order; typedef blocks from every header.
  const typedefBlocks = new Map<string, string>();
  const typeGroups = new Map<string, Map<string, MarkedGroup>>();
  const declGroups = new Map<string, Map<string, MarkedGroup>>();
  const globalGroups = new Map<string, Map<string, MarkedGroup>>();
  const inlineGroups = new Map<string, Map<string, MarkedGroup>>();
  for (const path of [...input.headers.keys()].sort()) {
    const read = readMarkedGroups(path, input.headers.get(path)!);
    for (const [n, b] of read.typedefBlocks) if (!typedefBlocks.has(n)) typedefBlocks.set(n, b);
    const module = graph.moduleOfPath(path);
    if (!module) continue;
    const types = typeGroups.get(module) ?? new Map<string, MarkedGroup>();
    for (const t of read.types) if (!types.has(t.key)) types.set(t.key, t);
    typeGroups.set(module, types);
    const decls = declGroups.get(module) ?? new Map<string, MarkedGroup>();
    for (const d of read.decls) {
      const addr = d.key.slice(d.key.lastIndexOf(':') + 1).toLowerCase().replace(/^0x/, '').padStart(8, '0');
      if (!decls.has(addr)) decls.set(addr, d);
    }
    declGroups.set(module, decls);
    const globals = globalGroups.get(module) ?? new Map<string, MarkedGroup>();
    for (const g of read.globals) if (!globals.has(g.key)) globals.set(g.key, g);
    globalGroups.set(module, globals);
    const inlines = inlineGroups.get(module) ?? new Map<string, MarkedGroup>();
    for (const g of read.inlines) if (!inlines.has(g.key)) inlines.set(g.key, g);
    inlineGroups.set(module, inlines);
  }

  const analyse = (kind: Item['kind'], key: string, text: string, namespace?: string): Item => {
    const complete = oracle.complete(text);
    const needs = new Set<string>();
    const structs = new Set<string>();
    const typedefs = new Set<string>();
    const symbols = new Set<string>();
    for (const id of scanReferences(text).identifiers) {
      if (kind === 'type' && id === key) continue;
      if (sdk.has(id)) continue;
      if (typedefBlocks.has(id)) { typedefs.add(id); continue; }
      if (oracle.isStruct(id)) {
        structs.add(id);
        if (complete.has(id) || oracle.isTemplate(id)) needs.add(id);
      } else if (oracle.definers(id).length > 0) needs.add(id);
      else if (kind === 'inline' && oracle.declarers(id).length > 0) symbols.add(id);
    }
    // A typedef block names structs by pointer only.
    for (const t of typedefs) {
      for (const id of scanReferences(typedefBlocks.get(t)!).identifiers) {
        if (!sdk.has(id) && oracle.isStruct(id) && !oracle.isTemplate(id)) structs.add(id);
      }
    }
    // Its own name is declared beside it.
    if (kind === 'inline') symbols.delete(input.functionNames.get(key) ?? '');
    return { kind, key, text, namespace, needs: [...needs], symbols: [...symbols], structs: [...structs], typedefs: [...typedefs] };
  };

  const items = new Map<string, Item[]>();
  for (const module of graph.names) {
    const list: Item[] = [];
    const types = typeGroups.get(module);
    for (const name of [...(input.publicTypes.get(module) ?? [])].sort()) {
      const g = types?.get(name);
      if (g) list.push(analyse('type', name, g.text));
    }
    const decls = declGroups.get(module);
    for (const addr of [...(input.publicFunctions.get(module) ?? [])].sort()) {
      const g = decls?.get(addr);
      if (g) list.push(analyse('function', addr, g.text, g.namespace));
    }
    const pubGlobals = input.publicGlobals.get(module);
    const listed = new Set<string>();
    for (const d of input.moduleExterns.get(module) ?? []) {
      if (pubGlobals?.has(d.name) && !listed.has(d.name)) { list.push(analyse('global', d.name, d.decl, d.namespace)); listed.add(d.name); }
    }
    for (const [name, g] of globalGroups.get(module) ?? []) {
      if (pubGlobals?.has(name) && !listed.has(name)) { list.push(analyse('global', name, g.text, g.namespace)); listed.add(name); }
    }
    const inlines = inlineGroups.get(module);
    for (const addr of [...(input.publicFunctions.get(module) ?? [])].sort()) {
      const g = inlines?.get(addr);
      if (g) list.push(analyse('inline', addr, g.text, g.namespace));
    }
    if (list.length > 0) items.set(module, list);
  }

  // Fixpoint: drop what needs a definition nothing the header may include provides.
  const published = new Map<string, Set<Item>>();
  for (const [m, list] of items) published.set(m, new Set(list));
  const publishedTypes = (m: string) => new Set([...(published.get(m) ?? [])].filter(i => i.kind === 'type').map(i => i.key));
  const typeSets = new Map<string, Set<string>>();
  for (const m of published.keys()) typeSets.set(m, publishedTypes(m));
  /** The functions and objects a module's public header declares, by name. */
  const publishedNames = (m: string) => {
    const out = new Set<string>();
    for (const i of published.get(m) ?? []) {
      if (i.kind === 'global') out.add(i.key);
      else if (i.kind === 'function' || i.kind === 'inline') { const n = input.functionNames.get(i.key); if (n) out.add(n); }
    }
    return out;
  };
  const nameSets = new Map<string, Set<string>>();
  for (const m of published.keys()) nameSets.set(m, publishedNames(m));
  /** Where module `m`'s public header gets the declaration of a function, object or macro. */
  const declarationSource = (m: string, name: string): { self: true } | { include: string } | undefined => {
    if (nameSets.get(m)?.has(name)) return { self: true };
    for (const file of oracle.declarers(name)) {
      const owner = graph.moduleOfPath(file);
      if (owner === undefined) {
        if (file !== input.globalsPath && !file.startsWith('globals/')) return { include: file };
        continue;
      }
      if (graph.publicIncludeAllowed(m, owner) && nameSets.get(owner)?.has(name)) return { include: graph.publicHeaderOf(owner) };
    }
    return undefined;
  };
  /** Where module `m`'s public header gets `name` from: itself, a header to include, or nowhere. */
  const source = (m: string, name: string): { self: true } | { include: string } | undefined => {
    if (typeSets.get(m)?.has(name)) return { self: true };
    const owned = input.typeOwnerMap.get(name);
    const definers = [...new Set([...(owned ? [owned] : []), ...oracle.definers(name)])];
    // Defined by no header of the tree: the SDK's, the compiler's or d2_platform.h's.
    if (definers.length === 0) return oracle.isStruct(name) ? undefined : { include: input.platformHeader };
    for (const file of definers) {
      const owner = graph.moduleOfPath(file);
      if (owner === undefined) {
        if (file !== input.globalsPath && !file.startsWith('globals/')) return { include: file };
        continue;
      }
      if (graph.publicIncludeAllowed(m, owner) && typeSets.get(owner)?.has(name)) return { include: graph.publicHeaderOf(owner) };
    }
    return undefined;
  };
  const withheldBy = new Map<Item, string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [m, set] of published) {
      for (const item of [...set]) {
        const missing = item.needs.find(n => source(m, n) === undefined)
          ?? item.symbols.find(n => declarationSource(m, n) === undefined);
        if (missing === undefined) continue;
        set.delete(item);
        withheldBy.set(item, missing);
        changed = true;
      }
      typeSets.set(m, publishedTypes(m));
      nameSets.set(m, publishedNames(m));
    }
  }

  const plans = new Map<string, PublicHeaderPlan>();
  for (const [m, list] of items) {
    const set = published.get(m)!;
    const kept = list.filter(i => set.has(i));
    const path = graph.publicHeaderOf(m);
    const includes = new Set<string>();
    const forwards = new Set<string>();
    const typedefs: string[] = [];
    for (const item of kept) {
      for (const n of item.needs) {
        const s = source(m, n);
        if (s && 'include' in s && s.include !== path) includes.add(s.include);
      }
      for (const n of item.symbols) {
        const s = declarationSource(m, n);
        if (s && 'include' in s && s.include !== path) includes.add(s.include);
      }
      // Every struct it spells, its own included: a definition further down may point at it.
      for (const s of item.structs) if (!oracle.isTemplate(s)) forwards.add(s);
      for (const t of item.typedefs) if (!typedefs.includes(t)) typedefs.push(t);
    }
    includes.delete(input.platformHeader);
    // A type another header defines for it is not forward-declared: the include pass
    // reads a file's own declaration as the answer and would drop the include.
    for (const item of kept) {
      for (const n of item.needs) {
        const s = source(m, n);
        if (s && 'include' in s) forwards.delete(n);
      }
    }
    const L: string[] = [
      BANNER,
      '',
      `// Public interface of ${m}: what other modules of the tree use from it - the functions`,
      '// and globals they reference and the types they reach. Ours, not original: the original',
      '// public headers are not in the evidence.',
      '',
      '#pragma once',
      ...gateLines(m),
      '',
      '#include <cstdint>',
      '#include <cstddef>',
      `#include "${input.platformHeader}"`,
      ...[...includes].sort().map(h => `#include "${h}"`),
    ];
    if (forwards.size > 0) {
      L.push('', '// Forward declarations');
      for (const f of [...forwards].sort()) L.push(`${oracle.keyOf(f)} ${f};`);
    }
    if (typedefs.length > 0) {
      L.push('');
      for (const t of typedefs.sort()) L.push(typedefBlocks.get(t)!);
    }
    const types = orderTypes(kept.filter(i => i.kind === 'type'));
    if (types.length > 0) {
      L.push('', '// Data types');
      for (const t of types) {
        const guard = definedGuard(t.key);
        L.push(`#ifndef ${guard}`, `#define ${guard}`, t.text.replace(/\n+$/, ''), `#endif // ${guard}`);
      }
    }
    const scoped = (kind: Item['kind'], title: string, guard?: (i: Item) => string) => {
      const group = kept.filter(i => i.kind === kind)
        .sort((a, b) => (a.namespace ?? '').localeCompare(b.namespace ?? '') || a.key.localeCompare(b.key));
      if (group.length === 0) return;
      L.push('', title);
      let ns: string | undefined;
      for (const i of group) {
        if (i.namespace !== ns) {
          if (ns) L.push(`} // namespace ${ns}`);
          if (i.namespace) L.push(`namespace ${i.namespace} {`);
          ns = i.namespace;
        }
        if (guard) L.push(`#ifndef ${guard(i)}`, `#define ${guard(i)}`, i.text.replace(/\n+$/, ''), `#endif // ${guard(i)}`);
        else L.push(i.text);
      }
      if (ns) L.push(`} // namespace ${ns}`);
    };
    scoped('function', '// Functions');
    scoped('global', '// Globals');
    scoped('inline', '// Inline functions: the module compiled these into each caller', i => inlineGuard(i.key));
    L.push('');
    plans.set(m, {
      module: m,
      path,
      content: L.join('\n'),
      types: types.map(t => t.key),
      functions: kept.filter(i => i.kind === 'function').map(i => i.key),
      globals: kept.filter(i => i.kind === 'global').map(i => i.key),
      inlines: kept.filter(i => i.kind === 'inline').map(i => i.key),
      withheld: list.filter(i => !set.has(i)).map(i => ({ kind: i.kind, key: i.key, needs: withheldBy.get(i) ?? '' })),
      includes: [...includes].sort(),
    });
  }
  return plans;
}

/** Types in an order where each follows what it needs defined; otherwise by name. */
function orderTypes(types: Item[]): Item[] {
  const byName = new Map(types.map(t => [t.key, t]));
  const out: Item[] = [];
  const state = new Map<string, 'busy' | 'done'>();
  const visit = (t: Item) => {
    if (state.has(t.key)) return;
    state.set(t.key, 'busy');
    for (const n of [...t.needs].sort()) {
      const dep = byName.get(n);
      if (dep) visit(dep);
    }
    state.set(t.key, 'done');
    out.push(t);
  };
  for (const t of [...types].sort((a, b) => a.key.localeCompare(b.key))) visit(t);
  return out;
}
