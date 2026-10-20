/**
 * One object per address: the primary label defines it, the others are aliases.
 *
 * Ghidra lets an address carry any number of labels, and `list_data_symbols`
 * returns every one of them with no word on which is primary. Emitted one global
 * per label, an address with four labels became four objects with four separate
 * storages - `?rInitialWindowRect@@3UtagRECT@@A`, `Ordinal_24`,
 * `rInitialWindowRect` and `lpRect_007c9160` at 007c9160 - and code that wrote one
 * read another's zeroes. At v1234, 127 addresses carried two or more labels;
 * `gaCrtLocaleCategoryTable` and `gaLocaleCategoryNames` were two copies of one
 * CRT table, and the zlib trees were defined twice, once under each name.
 *
 * Exactly one label per address is primary (`SymbolTable.getPrimarySymbol`); it
 * is the name the listing shows and the decompiler prints. Extraction records it
 * (`ExtractedGlobal.primary`, see `extract/globals.ts`). The fold here keeps that
 * record, hands it the other names as `aliases` (a comment at the definition),
 * and respells every reference by an alias - in other globals' initializers here,
 * in bodies through the `global-alias-resolve` pass.
 *
 * A snapshot taken before extraction learned the primary carries no flag. For
 * those the decompiler is the witness: it prints only the primary, so the one
 * label of the group that bodies reference is the primary. A group no body
 * references keeps its first label, in extraction order. A label spelled like a
 * type name is no evidence either way, since the type's own uses match it.
 */

import type { DataValue } from '../types.js';
import { collectReferencedNames } from './exclusion-closure.js';
import { sanitizeQualifiedReference } from './globals-header.js';

export interface AliasableGlobal {
  name: string;
  address: string;
  namespace?: string | null;
  platform?: string;
  suggestedName?: string;
  referencingFunctions?: string[];
  xrefCount?: number;
  initializedData?: DataValue;
  /** From extraction: true for the address's primary label, false for a secondary one. */
  primary?: boolean;
  /** Set by the fold: the other labels at this address, in extraction order. */
  aliases?: string[];
}

export type PrimaryEvidence = 'ghidra' | 'decompiler' | 'first';

export interface GlobalAliasFold<T extends AliasableGlobal> {
  /** The globals with each multi-label address reduced to its primary. */
  globals: T[];
  /** Reference spelling of a secondary label -> the primary's spelling. */
  referenceAliases: Record<string, string>;
  /** Addresses folded, by what decided the primary. */
  folded: Record<PrimaryEvidence, number>;
  /** Labels dropped as aliases. */
  aliasCount: number;
  /** Pointer initializers respelled. */
  initializerRespellings: number;
}

function normalizeAddress(address: string): string {
  const bare = address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
  return bare.replace(/^0x/i, '').toLowerCase();
}

/** `Ns::name` when the label lives in a namespace, else `name` - how a body spells it. */
export function referenceSpelling(g: { name: string; namespace?: string | null; suggestedName?: string }): string {
  const name = g.suggestedName || g.name;
  return g.namespace ? `${g.namespace}::${name}` : name;
}

/** The root symbol a member-path label (`a.b`, `a[3].b`, `a+4`) names, or undefined. */
function memberPathRoot(name: string): string | undefined {
  const m = /^([A-Za-z_]\w*)(?:\[\d+\])*(?:\.|\+\d+$|\[)/.exec(name);
  return m && m[1] !== name ? m[1] : undefined;
}

/** Every key a reference to `g` may be spelled with. */
function spellingsOf(g: AliasableGlobal): string[] {
  const out = new Set<string>();
  const raw = referenceSpelling(g);
  out.add(raw);
  out.add(sanitizeQualifiedReference(raw));
  if (g.namespace) {
    // Ghidra does not qualify a reference from inside the label's own namespace.
    out.add(g.suggestedName || g.name);
    out.add(sanitizeQualifiedReference(g.suggestedName || g.name));
  }
  return [...out];
}

/**
 * Reduce every address that carries several labels to its primary.
 *
 * `functions` is read only when some group has no extraction verdict; it is the
 * decompiler's evidence for which label is primary.
 */
export function foldGlobalAliases<T extends AliasableGlobal>(
  globals: T[],
  functions: Array<{ decompiled?: string; name?: string; namespace?: string | null }> = [],
  typeNames: ReadonlySet<string> = new Set(),
): GlobalAliasFold<T> {
  const folded: Record<PrimaryEvidence, number> = { ghidra: 0, decompiler: 0, first: 0 };
  const allNames = new Set(globals.map(g => g.suggestedName || g.name));

  // A label inside another global's span is a member path of it, not a label of
  // the same object; those are judged by address elsewhere and never folded here.
  const groups = new Map<string, T[]>();
  for (const g of globals) {
    const root = memberPathRoot(g.suggestedName || g.name);
    if (root && allNames.has(root)) continue;
    const key = `${g.platform ?? ''}@${normalizeAddress(g.address)}`;
    const list = groups.get(key);
    if (list) list.push(g); else groups.set(key, [g]);
  }
  const multi = [...groups.values()].filter(gs => gs.length > 1);
  if (multi.length === 0) {
    return { globals, referenceAliases: {}, folded, aliasCount: 0, initializerRespellings: 0 };
  }

  // The decompiler's evidence, read once and only when an extraction verdict is missing.
  let referenced: Set<string> | undefined;
  const isReferenced = (g: T): boolean => {
    if (!referenced) {
      const wanted = new Set<string>();
      // A label spelled like a type (`sockaddr_in` @00882b38) is matched by every
      // declaration of that type; such a token is no evidence about the label.
      for (const gs of multi) for (const m of gs) for (const s of spellingsOf(m)) if (!typeNames.has(s)) wanted.add(s);
      referenced = new Set<string>();
      for (const f of functions) {
        if (!f.decompiled) continue;
        for (const n of collectReferencedNames(f.decompiled)) if (wanted.has(n)) referenced.add(n);
      }
    }
    return spellingsOf(g).some(s => referenced!.has(s));
  };

  const primaryOf = new Map<T, T[]>(); // primary -> its secondaries
  const dropped = new Set<T>();
  for (const gs of multi) {
    let primary: T | undefined;
    let evidence: PrimaryEvidence;
    const flagged = gs.filter(g => g.primary === true);
    if (flagged.length === 1) {
      primary = flagged[0];
      evidence = 'ghidra';
    } else {
      const used = gs.filter(isReferenced);
      if (used.length === 1) {
        primary = used[0];
        evidence = 'decompiler';
      } else {
        primary = gs[0];
        evidence = 'first';
      }
    }
    folded[evidence]++;
    const secondaries = gs.filter(g => g !== primary);
    primaryOf.set(primary, secondaries);
    for (const s of secondaries) dropped.add(s);
  }

  // Alias spellings. A spelling that is also the spelling of a symbol that stays
  // (another address's label, or this address's primary) is that symbol's, not an alias.
  const kept = globals.filter(g => !dropped.has(g));
  // A type's or a function's spelling means that type or function wherever it is
  // written, so it is never made an alias either.
  const keptSpellings = new Set<string>(typeNames);
  for (const g of kept) for (const s of spellingsOf(g)) keptSpellings.add(s);
  for (const f of functions) {
    if (!f.name) continue;
    keptSpellings.add(f.name);
    if (f.namespace) keptSpellings.add(`${f.namespace}::${f.name}`);
  }
  const referenceAliases: Record<string, string> = {};
  const ambiguous = new Set<string>();
  for (const [primary, secondaries] of primaryOf) {
    const target = sanitizeQualifiedReference(referenceSpelling(primary));
    for (const s of secondaries) {
      for (const spelling of spellingsOf(s)) {
        if (keptSpellings.has(spelling)) continue;
        const prior = referenceAliases[spelling];
        if (prior !== undefined && prior !== target) ambiguous.add(spelling);
        referenceAliases[spelling] = target;
      }
    }
  }
  for (const a of ambiguous) delete referenceAliases[a];

  let aliasCount = 0;
  let initializerRespellings = 0;
  const out: T[] = [];
  for (const g of kept) {
    let next = g;
    const secondaries = primaryOf.get(g);
    if (secondaries) {
      aliasCount += secondaries.length;
      const refs = new Set(g.referencingFunctions ?? []);
      for (const s of secondaries) for (const r of s.referencingFunctions ?? []) refs.add(r);
      next = {
        ...g,
        aliases: secondaries.map(s => s.name),
        referencingFunctions: [...refs],
        xrefCount: Math.max(g.xrefCount ?? 0, ...secondaries.map(s => s.xrefCount ?? 0)),
      };
    }
    if (next.initializedData) {
      const counter = { n: 0 };
      const data = respellPointers(next.initializedData, referenceAliases, counter);
      if (counter.n > 0) {
        next = { ...next, initializedData: data };
        initializerRespellings += counter.n;
      }
    }
    out.push(next);
  }

  return { globals: out, referenceAliases, folded, aliasCount, initializerRespellings };
}

/**
 * A pointer datum names its target as a symbol path: `name`, `Ns::name`, or an
 * interior reference `name[3].field` / `name+4`. The root is respelled when it is
 * an alias; the path after it is the same object's and is kept.
 */
function respellPointerValue(value: string, aliases: Record<string, string>): string | undefined {
  const whole = aliases[value];
  if (whole !== undefined) return whole;
  for (let i = value.length - 1; i > 0; i--) {
    const c = value[i];
    if (c !== '.' && c !== '[' && c !== '+') continue;
    const target = aliases[value.slice(0, i)];
    if (target !== undefined) return target + value.slice(i);
  }
  return undefined;
}

function respellPointers(v: DataValue, aliases: Record<string, string>, counter: { n: number }): DataValue {
  if (v.kind === 'pointer' && typeof v.value === 'string') {
    const respelled = respellPointerValue(v.value, aliases);
    if (respelled === undefined) return v;
    counter.n++;
    return { ...v, value: respelled };
  }
  let changed = false;
  let elements = v.elements;
  if (elements) {
    const next = elements.map(e => respellPointers(e, aliases, counter));
    if (next.some((e, i) => e !== elements![i])) { elements = next; changed = true; }
  }
  let fields = v.fields;
  if (fields) {
    const next = fields.map(f => {
      const value = respellPointers(f.value, aliases, counter);
      return value === f.value ? f : { ...f, value };
    });
    if (next.some((f, i) => f !== fields![i])) { fields = next; changed = true; }
  }
  return changed ? { ...v, elements, fields } : v;
}

/** The one-line definition comment naming the other labels at this address. */
export function globalAliasComment(g: { aliases?: string[] }): string | undefined {
  if (!g.aliases || g.aliases.length === 0) return undefined;
  // A label is a Ghidra name and can hold anything; keep the line a line.
  const names = g.aliases.map(a => a.replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' '));
  return `// also labelled: ${names.join(', ')}`;
}

let currentReferenceAliases: Record<string, string> = {};

/** Set by stage 1; read by the body transform for `global-alias-resolve`. */
export function setGlobalReferenceAliases(aliases: Record<string, string>): void {
  currentReferenceAliases = aliases;
}

export function getGlobalReferenceAliases(): Record<string, string> {
  return currentReferenceAliases;
}
