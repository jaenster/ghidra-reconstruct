/**
 * "Which of these ~20,000 names appear in this file?" — answered in one pass.
 *
 * The include-dependency feedback in `generateFilesForFunctions` asks, for every
 * generated .cpp, whether each of ~15k function names and ~5k type names occurs
 * in its text. Done as one `String.includes` per name that is ~19M scans of a
 * ~38 kB string per run, and it measured as the single largest self-time cost in
 * codegen (70.5s of 288s).
 *
 * This flips it around. Almost every needle is a C identifier, i.e. made only of
 * `[A-Za-z0-9_]`. Such a needle occurs in the text if and only if it occurs
 * inside one of the text's MAXIMAL identifier runs — a match can never straddle
 * a non-identifier character. So: split the text into its distinct identifier
 * runs once, then walk a trie of the needles from every offset of each run. The
 * predicate is exactly `text.includes(needle)`, including matches that fall in
 * the middle of a longer identifier; only the way it is computed changes.
 *
 * Needles that are not pure identifiers (a name with `::`, a space, a `*`) can
 * straddle those boundaries, so they keep the plain substring scan.
 */

interface TrieNode {
  children: Map<string, TrieNode>;
  /** Set when a needle ends here. */
  word?: string;
}

const IDENTIFIER_RUN = /[A-Za-z0-9_]+/g;
const PURE_IDENTIFIER = /^[A-Za-z0-9_]+$/;

export class NeedleIndex {
  private readonly root: TrieNode = { children: new Map() };
  private readonly others: string[] = [];
  private trieEmpty = true;

  constructor(needles: Iterable<string>) {
    const seen = new Set<string>();
    for (const needle of needles) {
      if (seen.has(needle)) continue;
      seen.add(needle);
      // `''.includes('')` is true for every text; nothing sane produces one, but
      // routing it to the substring path keeps the predicate honest if it does.
      if (needle.length > 0 && PURE_IDENTIFIER.test(needle)) {
        this.insert(needle);
        this.trieEmpty = false;
      } else {
        this.others.push(needle);
      }
    }
  }

  private insert(needle: string): void {
    let node = this.root;
    for (const ch of needle) {
      let next = node.children.get(ch);
      if (!next) {
        next = { children: new Map() };
        node.children.set(ch, next);
      }
      node = next;
    }
    node.word = needle;
  }

  /** Every registered needle for which `text.includes(needle)` holds. */
  matchesIn(text: string): Set<string> {
    const found = new Set<string>();

    if (!this.trieEmpty) {
      // Distinct runs only — a repeated identifier contributes nothing new.
      const runs = new Set(text.match(IDENTIFIER_RUN) ?? []);
      for (const run of runs) {
        for (let start = 0; start < run.length; start++) {
          let node: TrieNode | undefined = this.root;
          for (let i = start; i < run.length; i++) {
            node = node.children.get(run[i]);
            if (!node) break;
            if (node.word !== undefined) found.add(node.word);
          }
        }
      }
    }

    for (const needle of this.others) {
      if (text.includes(needle)) found.add(needle);
    }

    return found;
  }
}
