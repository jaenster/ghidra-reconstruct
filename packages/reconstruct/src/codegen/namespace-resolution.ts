/**
 * ONE namespace resolution for the whole program, keyed on ADDRESS.
 *
 * Ghidra models a symbol's home as `Module::Folder::File`, and every emission
 * path used to turn that path into an emitted namespace on its own:
 *
 *   - the function definition (impl.ts)        collapse + strip-last-type
 *   - its header declaration (header.ts)       collapse + strip-last-type
 *   - the `globals.h` extern block             strip-last-type + strip EVERY
 *                                              segment naming a forward-declared
 *                                              struct + collapse
 *   - the `globals.cpp` definition             nothing at all
 *   - a struct header's co-located extern      nothing at all (root scope)
 *
 * Five paths, three behaviours, and each disagreement is a symbol declared in one
 * namespace and defined in another — which no compiler diagnoses and no linker
 * can resolve. `D2Common::Item::ItemMods` was declared under the full path and
 * defined under `D2Common::ItemMods`; `D2Game::Quests::Quests::A1Q0` was the
 * reverse.
 *
 * So a namespace is resolved ONCE per symbol, from Ghidra's path, and held here
 * against that symbol's address. Emission paths ask for the resolved entity and
 * render it; none of them re-derives it, and none of them manipulates a
 * `"A::B::C"` string. Ghidra's path is split into segments at this boundary and
 * is never re-parsed after it.
 *
 * The rule itself is two segment-level operations:
 *
 *   1. drop a segment identical to the segment before it — `Quests::Quests` is
 *      the file `Quests.cpp` inside the folder namespace `Quests`, one C++
 *      namespace, not two;
 *   2. drop the LAST segment when it names a struct/union/enum, because
 *      `namespace Direct3D` beside `struct Direct3D` is a redeclaration. Only
 *      the last: an intermediate collision (`D2Common::Item::ItemMods`, where
 *      `Item` is also a struct) names a real enclosing namespace, and dropping
 *      it moves the definition to a sibling scope its own declaration cannot
 *      reach. That is the same "penultimate only" rule the reference side
 *      applies to a qualified name's qualifier list.
 *
 * Rule 2 has one exception, for DATA. A function the drop moves beside a
 * same-named sibling survives as an overload told apart by its `this` type; a
 * datum cannot. Ghidra hangs every class's RTTI records and its `vftable` under
 * the class namespace (`D2Client::ButtonImplementation::vftable`), so dropping
 * the class segment puts ten widget vftables into one `D2Client::vftable` and
 * the globals emitter keeps the first — every widget constructor then installs
 * the same table. A datum whose drop would merge it with a different datum
 * therefore keeps its class segment. The root-scope struct of that name is not
 * redeclared by a NESTED namespace, and the shadow the namespace casts over it
 * inside the enclosing scope is already root-qualified away
 * (`shadowedTypeNames`, fed from Ghidra's raw paths).
 */

/** A resolved namespace. Segments, never a joined string in flight. */
export interface ResolvedNamespace {
  /** Ghidra's `Module::Folder::File` path, split once, kept for provenance. */
  readonly ghidraSegments: readonly string[];
  /** The segments actually emitted. Empty means root scope. */
  readonly segments: readonly string[];
}

const ROOT: ResolvedNamespace = { ghidraSegments: [], segments: [] };

/**
 * The enclosing namespace of a ROOT-scope class's members. A nested class
 * (`D2Client::ButtonImplementation`) is emitted inside its module; a class Ghidra
 * homes at global scope, as its RTTI name is, would otherwise have to be a
 * namespace beside the global struct of the same name.
 */
export const ROOT_CLASS_SCOPE = 'Class';

/** A datum as the resolution sees it. */
export interface DataSymbol {
  address?: string;
  namespace?: string | null;
  name: string;
}

/** Rule 1: drop a segment identical to the one before it. */
function collapseSegments(segments: readonly string[]): string[] {
  const collapsed: string[] = [];
  for (const segment of segments) {
    if (collapsed.length > 0 && collapsed[collapsed.length - 1] === segment) continue;
    collapsed.push(segment);
  }
  return collapsed;
}

/** Render a resolved namespace. The ONLY place segments become text. */
export function renderNamespace(ns: ResolvedNamespace | undefined): string | undefined {
  if (!ns || ns.segments.length === 0) return undefined;
  return ns.segments.join('::');
}

export class NamespaceResolution {
  private readonly typeNames: ReadonlySet<string>;
  private readonly byAddr = new Map<string, ResolvedNamespace>();
  private readonly byPath = new Map<string, ResolvedNamespace>();
  /** Data that keeps its class segment, keyed `collapsedGhidraPath::name`. */
  private readonly keptByReference = new Map<string, ResolvedNamespace>();

  /** One-segment namespaces that name a type, homed under ROOT_CLASS_SCOPE. */
  private readonly rootClasses = new Set<string>();

  constructor(typeNames: ReadonlySet<string>) {
    this.typeNames = typeNames;
  }

  /** Resolve a Ghidra namespace path. Memoised on the path, so identical paths
   *  are one entity and cannot drift apart. */
  resolvePath(rawNamespace: string | null | undefined): ResolvedNamespace {
    if (!rawNamespace) return ROOT;
    const hit = this.byPath.get(rawNamespace);
    if (hit) return hit;

    // The one and only split of Ghidra's path.
    const ghidraSegments = rawNamespace.split('::').filter(s => s.length > 0);

    const collapsed = collapseSegments(ghidraSegments);
    const last = collapsed[collapsed.length - 1];
    if (collapsed.length === 1 && this.typeNames.has(last)) {
      // A root-scope class (`IgnoreList`, `TSHashTable<CELLIST,HASHKEY_NONE>`):
      // `namespace IgnoreList` beside the global `struct IgnoreList` is a
      // redeclaration, and dropping the segment would pour every class's
      // Constructor/Destructor/Draw into one global overload set. It gets the
      // enclosing scope a nested class already has, so it keeps its own.
      collapsed.unshift(ROOT_CLASS_SCOPE);
      this.rootClasses.add(last);
    } else if (collapsed.length > 1 && this.typeNames.has(last)) {
      collapsed.pop();
    }

    const resolved: ResolvedNamespace = { ghidraSegments, segments: collapsed };
    this.byPath.set(rawNamespace, resolved);
    return resolved;
  }

  /**
   * Give every datum whose type-segment drop would land it on another datum's
   * emitted name its class segment back (see the header). `nameOf` is the
   * emitted spelling the globals emitters key on. Returns the data re-homed.
   */
  keepClassSegmentsOfMergedData<T extends DataSymbol>(
    data: Iterable<T>,
    nameOf: (symbol: T) => string
  ): T[] {
    const byEmitted = new Map<string, { symbol: T; resolved: ResolvedNamespace }[]>();
    for (const symbol of data) {
      const resolved = this.of(symbol);
      const key = `${resolved.segments.join('::')}::${nameOf(symbol)}`;
      let group = byEmitted.get(key);
      if (!group) byEmitted.set(key, (group = []));
      group.push({ symbol, resolved });
    }

    const kept: T[] = [];
    for (const group of byEmitted.values()) {
      if (group.length < 2) continue;
      // Only a merge the DROP made: two data Ghidra already homes in the same
      // namespace under one name are that scope's own duplicate, not ours.
      const homes = new Set(group.map(m => collapseSegments(m.resolved.ghidraSegments).join('::')));
      if (homes.size < 2) continue;
      for (const { symbol, resolved } of group) {
        const full = collapseSegments(resolved.ghidraSegments);
        if (full.length === resolved.segments.length) continue;
        const segments = full;
        const own: ResolvedNamespace = { ghidraSegments: resolved.ghidraSegments, segments };
        if (symbol.address) this.byAddr.set(symbol.address, own);
        for (const name of new Set([symbol.name, nameOf(symbol)])) {
          if (name) this.keptByReference.set(`${full.join('::')}::${name}`, own);
        }
        kept.push(symbol);
      }
    }
    return kept;
  }

  /**
   * The resolution of a qualified REFERENCE `qualifier::name` — the class-kept
   * namespace when that datum kept its segment, otherwise the path's own.
   */
  resolveReference(qualifier: string, name: string): ResolvedNamespace {
    const resolved = this.resolvePath(qualifier);
    const full = collapseSegments(resolved.ghidraSegments);
    return this.keptByReference.get(`${full.join('::')}::${name}`) ?? resolved;
  }

  /**
   * Keep the type-named leaf of every Ghidra path whose drop would give two FUNCTIONS one
   * emitted qualified name and one signature.
   *
   * Rule 2 trusted that a function moved beside a same-named sibling stays apart as an
   * overload. Ghidra's D2Win control callbacks disproved it: v1531 types all of them
   * `BOOL Push(D2ControlMsg *)`, and `D2Win::Src::D2WinButton::Push`,
   * `D2Win::Src::D2WinList::Push`, ... (eleven Push/Key) all landed in `D2Win::Src` as one
   * function defined nine times - no TU sees it, the link does. The whole PATH keeps its
   * segment (every symbol homed there moves with it, so a file's functions stay in one
   * namespace), and the reference side keeps the qualifier for each of them. Returns the
   * Ghidra paths kept.
   */
  keepLeafOfCollidingFunctions(
    functions: Iterable<{ address?: string; namespace?: string | null; name?: string }>,
    signatureOf: (fn: { address?: string; namespace?: string | null; name?: string }) => string,
  ): string[] {
    const groups = new Map<string, { raw: string; dropped: boolean }[]>();
    const all: { address?: string; namespace?: string | null; name?: string }[] = [];
    for (const fn of functions) {
      if (!fn.name || !fn.namespace) continue;
      all.push(fn);
      const resolved = this.resolvePath(fn.namespace);
      const full = collapseSegments(resolved.ghidraSegments);
      const key = `${resolved.segments.join('::')}::${fn.name}(${signatureOf(fn)})`;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = []));
      group.push({ raw: fn.namespace, dropped: full.length > resolved.segments.length });
    }
    const keep = new Set<string>();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      if (new Set(group.map(m => m.raw)).size < 2) continue;
      for (const m of group) if (m.dropped) keep.add(m.raw);
    }
    if (keep.size === 0) return [];
    for (const raw of keep) {
      const resolved = this.resolvePath(raw);
      this.byPath.set(raw, { ghidraSegments: resolved.ghidraSegments, segments: collapseSegments(resolved.ghidraSegments) });
    }
    for (const fn of all) {
      if (!keep.has(fn.namespace!)) continue;
      const own = this.byPath.get(fn.namespace!)!;
      if (fn.address) this.byAddr.set(fn.address, own);
      this.keptByReference.set(`${own.segments.join('::')}::${fn.name}`, own);
    }
    return [...keep];
  }

  /** Root-scope classes the resolution homed under ROOT_CLASS_SCOPE (Ghidra spellings). */
  rootClassNames(): string[] {
    return [...this.rootClasses];
  }

  /** `Ns::Class::name` references that must keep their type-named qualifier. */
  keptReferenceNames(): string[] {
    return [...this.keptByReference.keys()];
  }

  /** Bind a symbol's address to its resolved namespace. */
  claim(address: string | undefined, rawNamespace: string | null | undefined): ResolvedNamespace {
    const resolved = this.resolvePath(rawNamespace);
    if (address) this.byAddr.set(address, resolved);
    return resolved;
  }

  /** The resolved namespace of the symbol AT this address — the identity the
   *  declaration side and the definition side must agree on. */
  byAddress(address: string | undefined): ResolvedNamespace | undefined {
    return address ? this.byAddr.get(address) : undefined;
  }

  /**
   * The resolved namespace for a symbol, preferring its address identity and
   * falling back to its path. A symbol reaching an emitter without an address is
   * a defect elsewhere, but resolving its path still gives the SAME entity the
   * other side got, because both memoise on the path.
   */
  of(symbol: { address?: string; namespace?: string | null }): ResolvedNamespace {
    return this.byAddress(symbol.address) ?? this.resolvePath(symbol.namespace);
  }

  render(symbol: { address?: string; namespace?: string | null }): string | undefined {
    return renderNamespace(this.of(symbol));
  }
}

/**
 * The resolution for the run in progress. Module state because the emitters are
 * free functions reached through several call chains; the point is that there is
 * exactly ONE, not how it is threaded.
 */
let current = new NamespaceResolution(new Set());

export function setNamespaceResolution(resolution: NamespaceResolution): void {
  current = resolution;
}

export function namespaceResolution(): NamespaceResolution {
  return current;
}

/**
 * Build the run's resolution and claim every function and global by address.
 * `data`, when given, is checked for data the type-segment drop would merge.
 */
export function buildNamespaceResolution<T extends DataSymbol>(
  typeNames: ReadonlySet<string>,
  symbols: Iterable<{ address?: string; namespace?: string | null }>,
  data?: { symbols: Iterable<T>; nameOf: (symbol: T) => string },
  functions?: {
    symbols: Iterable<{ address?: string; namespace?: string | null; name?: string }>;
    signatureOf: (fn: { address?: string; namespace?: string | null; name?: string }) => string;
  },
): NamespaceResolution {
  const resolution = new NamespaceResolution(typeNames);
  // Paths first: a kept leaf has to be in place before any symbol is bound to its path.
  if (functions) resolution.keepLeafOfCollidingFunctions(functions.symbols, functions.signatureOf);
  for (const s of symbols) resolution.claim(s.address, s.namespace);
  if (data) resolution.keepClassSegmentsOfMergedData(data.symbols, data.nameOf);
  setNamespaceResolution(resolution);
  return resolution;
}
