/**
 * Exclusion closure
 *
 * Ghidra's `compiler` / `CRT` / `_Wrappers` namespaces hold the statically-linked
 * MSVC runtime, and the pipeline drops them: extraction never lists them and
 * codegen filters whatever survives, so no file is emitted for them. That is
 * right for library code nobody calls, and wrong the moment kept game code calls
 * INTO one of them — the call site survives, the body does not, and the symbol is
 * undefined at link. `PKWARE_explode` @`006b01b0` is 373 bytes of real
 * decompressor in `Game.exe`; it was reachable from `Storm` and it was dropped.
 *
 * So exclusion is narrowed here from "everything in that namespace" to
 * "everything in that namespace that nothing kept references". A function the
 * kept code names, that has a real body in the binary, is emitted rather than
 * merely declared, and its own callees are followed to a fixpoint.
 *
 * The set is a graph, not a list. Two questions decide membership and they are
 * kept apart on purpose:
 *
 *  - **reachability** — does kept code, transitively, name it? Answered from the
 *    decompiled bodies, LEXED rather than matched: a `::`-qualified name in a
 *    comment or a string literal is not a reference. This is deliberately
 *    over-approximate; it decides only what is worth decompiling.
 *  - **emission** — is a body the right answer, or does the platform layer
 *    already supply one? `compiler::memset` is reachable and has a body, and
 *    emitting MSVC's `rep stosd` under the name `memset` would collide with the
 *    C library that already defines it. Answered from the emitter's own tables,
 *    with no text involved.
 */

import { Lexer, TokenKind } from '@ghidra-mcp/cpp-parser';
import { EXCLUDED_SYMBOL_DECLS, resolveCrtInclude } from './crt-mapping.js';

/** The part of a function record the closure needs. Structural, so tests need no fixtures. */
export interface ExclusionCandidate {
  name: string;
  address: string;
  namespace?: string;
  size: number;
  isThunk: boolean;
  isExternal: boolean;
  decompiled?: string;
}

/**
 * The spelling Ghidra's C emitter gives a symbol name.
 *
 * Ghidra's own names are not C identifiers — `FID_conflict:___CxxFrameHandler3`
 * carries a colon and `` `eh_vector_constructor_iterator' `` a backtick and an
 * apostrophe — and the decompiler replaces every character that cannot appear in
 * an identifier with `_` before printing them. Both the call site in a kept body
 * and the definition this closure emits go through that same rewrite, so it is
 * the only spelling on which the two can be matched.
 */
export function emittedSpelling(ghidraName: string): string {
  return ghidraName.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * A function whose bytes are in the binary, as opposed to a name the loader
 * resolves.
 *
 * A thunk is excluded even though it has an address: decompiling one returns the
 * TARGET's body under the thunk's name, so emitting it would define the wrong
 * function. An external has no bytes at all.
 */
export function hasRealBody(candidate: ExclusionCandidate): boolean {
  return !candidate.isThunk && !candidate.isExternal && candidate.size > 0;
}

/**
 * Every name a decompiled body references, qualified names joined back up.
 *
 * Lexed, not matched. The lexer classifies string literals and comments as
 * something other than an identifier, so `"compiler::PKWARE_explode"` inside a
 * message string cannot be mistaken for a call — which a text search over the
 * same body cannot distinguish.
 *
 * Both spellings are recorded for a qualified name (`compiler::PKWARE_explode`
 * and `PKWARE_explode`) because Ghidra qualifies a cross-namespace reference and
 * does not qualify a same-namespace one; the index decides which of the two it
 * is willing to resolve.
 */
export function collectReferencedNames(body: string): Set<string> {
  const names = new Set<string>();
  let tokens;
  try {
    tokens = new Lexer(body, { preserveTrivia: false }).tokenize();
  } catch {
    // A body the lexer refuses is a body whose references cannot be read. It is
    // reported by returning nothing rather than by guessing at the text.
    return names;
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== TokenKind.Identifier) continue;
    // Walk the whole `a::b::c` chain so the LAST segment is the symbol and the
    // segments before it are its namespace path.
    let end = i;
    const segments = [tokens[i].text];
    while (
      tokens[end + 1]?.kind === TokenKind.ColonColon &&
      tokens[end + 2]?.kind === TokenKind.Identifier
    ) {
      segments.push(tokens[end + 2].text);
      end += 2;
    }
    names.add(segments[segments.length - 1]);
    if (segments.length > 1) names.add(segments.join('::'));
    i = end;
  }
  return names;
}

/**
 * Candidates keyed by the spelling a referencing body would use for them.
 *
 * Only the QUALIFIED spelling is indexed. Ghidra writes
 * `compiler::PKWARE_explode` at every call site outside `compiler`, so the
 * qualified name is what kept code actually says; indexing the bare name as well
 * would let any body that happens to declare a local called `memset` drag the
 * MSVC one in.
 */
export function indexCandidatesBySpelling<T extends ExclusionCandidate>(
  candidates: Iterable<T>,
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const candidate of candidates) {
    if (!hasRealBody(candidate)) continue;
    if (!candidate.namespace) continue;
    const key = `${candidate.namespace}::${emittedSpelling(candidate.name)}`;
    const list = index.get(key);
    if (list) list.push(candidate);
    else index.set(key, [candidate]);
  }
  return index;
}

/**
 * The candidates a set of bodies references and that are not admitted yet.
 *
 * One step of the fixpoint. The caller owns the loop because closing the set
 * needs the next frontier's bodies, and fetching those is I/O.
 */
export function nextClosureFrontier<T extends ExclusionCandidate>(
  bodies: Iterable<string | undefined>,
  index: ReadonlyMap<string, T[]>,
  admittedAddresses: ReadonlySet<string>,
): T[] {
  const frontier: T[] = [];
  const seen = new Set<string>(admittedAddresses);
  for (const body of bodies) {
    if (!body) continue;
    for (const name of collectReferencedNames(body)) {
      const candidates = index.get(name);
      if (!candidates) continue;
      for (const candidate of candidates) {
        if (seen.has(candidate.address)) continue;
        seen.add(candidate.address);
        frontier.push(candidate);
      }
    }
  }
  return frontier;
}

/**
 * A body a kept body might reference at all.
 *
 * Cheap enough to run over every decompiled body in the program, so the lexer —
 * which is not — only sees the bodies that could possibly contribute. A body
 * with no excluded-namespace prefix in its text cannot name an excluded symbol,
 * because Ghidra qualifies every cross-namespace reference.
 */
export function mayReferenceNamespaces(body: string, namespaces: Iterable<string>): boolean {
  for (const ns of namespaces) {
    if (body.includes(`${ns}::`)) return true;
  }
  return false;
}

/**
 * Names the platform layer already DEFINES, so a second definition would collide.
 *
 * Registered by the platform-header generator, which owns the tables that decide
 * it. Held here rather than imported so that `extract/` can use the reachability
 * half of this module without pulling codegen in behind it.
 */
let platformDefinedNames: ReadonlySet<string> = new Set<string>();

export function setPlatformDefinedNames(names: ReadonlySet<string>): void {
  platformDefinedNames = names;
}

/**
 * Names the platform layer declares at ROOT scope.
 *
 * Where a body goes is not a free choice: it has to define the symbol the CALL
 * SITES already bind to, and that is decided by the declaration they see.
 * `d2_platform.h` writes `extern "C" uint32_t FID_conflict____CxxFrameHandler3(…)`
 * at root, so a definition of the same name inside `namespace compiler` is a
 * different symbol and leaves the original just as undefined as before. The
 * `_Wrappers` entries are declared inside `namespace _Wrappers` and keep it.
 */
let platformRootDeclaredNames: ReadonlySet<string> = new Set<string>();

export function setPlatformRootDeclaredNames(names: ReadonlySet<string>): void {
  platformRootDeclaredNames = names;
}

/**
 * Whether this body must be emitted at root scope rather than in its namespace.
 *
 * True exactly when the platform layer already declares the bare name — the
 * declaration the call sites resolve against. A name the platform layer says
 * nothing about (`PKWARE_explode`) keeps Ghidra's namespace, which is also where
 * the hand-written layer declares it.
 */
export function emitsAtRootScope(candidate: ExclusionCandidate): boolean {
  return platformRootDeclaredNames.has(emittedSpelling(candidate.name));
}

/** A declaration text that carries a body — an inline forwarder, a template. */
function declIsDefinition(decl: string): boolean {
  return decl.includes('{');
}

/**
 * Whether something other than this closure already supplies a definition.
 *
 * Three suppliers, and each one is a table in this repository rather than a
 * judgement:
 *
 *  - an `EXCLUDED_SYMBOL_DECLS` entry whose text carries a body. Those forward to
 *    a real entry point (`__strnicmp` -> `_strnicmp`); a decompiled MSVC body
 *    under the same name would be a second definition of it. An entry with no
 *    body only ever DECLARED the symbol, which is the gap this closure closes.
 *  - a name the platform header defines itself — the `static inline` forwarders
 *    and the `#define _fclose fclose` macro aliases.
 *  - a name that resolves to a C library or Win32 entry point. The linker
 *    supplies those, and `compiler::memset` is one of them.
 */
export function platformProvidesDefinition(names: Iterable<string>): boolean {
  const spellings = [...names];
  for (const decl of EXCLUDED_SYMBOL_DECLS) {
    if (spellings.includes(decl.emitted) && declIsDefinition(decl.decl)) return true;
  }
  for (const spelling of spellings) {
    if (platformDefinedNames.has(spelling)) return true;
    if (resolveCrtInclude(spelling)) return true;
  }
  return false;
}

/** Every spelling one candidate answers to, bare and namespace-qualified. */
export function candidateSpellings(candidate: ExclusionCandidate): string[] {
  const bare = emittedSpelling(candidate.name);
  return candidate.namespace ? [bare, `${candidate.namespace}::${bare}`] : [bare];
}

export interface EmissionSelection<T extends ExclusionCandidate = ExclusionCandidate> {
  /** Admitted: a body is emitted for these. */
  emit: T[];
  /** Reachable with a body, but something else already defines the name. */
  alreadyDefined: T[];
  /** Dropped as a duplicate of an admitted candidate under the same name. */
  duplicates: T[];
}

/**
 * Which of the reachable candidates actually get a body.
 *
 * Duplicates are real and have to be resolved here. Ghidra carries THREE
 * functions called `FID_conflict:___CxxFrameHandler3`, at `0068333c`, `00683372`
 * and `006833a8` — the FunctionID matcher gave one name to three copies the
 * linker never folded. They print as one identifier, so emitting all three is
 * three definitions of one symbol. The first by address wins and the rest are
 * reported, because a duplicate whose body DIFFERS is a naming defect in Ghidra
 * and the report is what makes it visible.
 */
export function selectExclusionEmissions<T extends ExclusionCandidate>(
  candidates: Iterable<T>,
): EmissionSelection<T> {
  const emit: T[] = [];
  const alreadyDefined: T[] = [];
  const duplicates: T[] = [];
  const claimed = new Map<string, T>();

  const ordered = [...candidates].sort((a, b) => a.address.localeCompare(b.address));
  for (const candidate of ordered) {
    if (!hasRealBody(candidate) || !candidate.decompiled) continue;
    const spellings = candidateSpellings(candidate);
    if (platformProvidesDefinition(spellings)) {
      alreadyDefined.push(candidate);
      continue;
    }
    const key = spellings[spellings.length - 1];
    if (claimed.has(key)) {
      duplicates.push(candidate);
      continue;
    }
    claimed.set(key, candidate);
    emit.push(candidate);
  }
  return { emit, alreadyDefined, duplicates };
}
