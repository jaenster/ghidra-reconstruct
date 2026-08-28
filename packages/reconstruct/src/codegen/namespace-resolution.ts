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
 */

/** A resolved namespace. Segments, never a joined string in flight. */
export interface ResolvedNamespace {
  /** Ghidra's `Module::Folder::File` path, split once, kept for provenance. */
  readonly ghidraSegments: readonly string[];
  /** The segments actually emitted. Empty means root scope. */
  readonly segments: readonly string[];
}

const ROOT: ResolvedNamespace = { ghidraSegments: [], segments: [] };

/** Render a resolved namespace. The ONLY place segments become text. */
export function renderNamespace(ns: ResolvedNamespace | undefined): string | undefined {
  if (!ns || ns.segments.length === 0) return undefined;
  return ns.segments.join('::');
}

export class NamespaceResolution {
  private readonly typeNames: ReadonlySet<string>;
  private readonly byAddr = new Map<string, ResolvedNamespace>();
  private readonly byPath = new Map<string, ResolvedNamespace>();

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

    const collapsed: string[] = [];
    for (const segment of ghidraSegments) {
      if (collapsed.length > 0 && collapsed[collapsed.length - 1] === segment) continue;
      collapsed.push(segment);
    }
    if (collapsed.length > 1 && this.typeNames.has(collapsed[collapsed.length - 1])) {
      collapsed.pop();
    }

    const resolved: ResolvedNamespace = { ghidraSegments, segments: collapsed };
    this.byPath.set(rawNamespace, resolved);
    return resolved;
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
 */
export function buildNamespaceResolution(
  typeNames: ReadonlySet<string>,
  symbols: Iterable<{ address?: string; namespace?: string | null }>
): NamespaceResolution {
  const resolution = new NamespaceResolution(typeNames);
  for (const s of symbols) resolution.claim(s.address, s.namespace);
  setNamespaceResolution(resolution);
  return resolution;
}
