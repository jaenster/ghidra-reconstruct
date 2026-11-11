/**
 * The references to a global that the decompile prints under the name of one of the
 * function's own parameters or locals, per decompile line.
 *
 * Ghidra prints a root-scope global by its bare name, and it does not rename a parameter
 * or local that carries the same name. In
 *
 *     void __fastcall UpdateScaleFactor(int nScaleFactor) { nScaleFactor = nScaleFactor; }
 *
 * (006b1c10, before the global was renamed) the left side is the global at 007b57e4 and
 * the right side the parameter; the text alone cannot tell them apart, and C++ binds both
 * to the parameter. The markup can: the global's token carries a HighGlobal. So the row
 * records, for every token whose text is the name of one of the function's own symbols,
 * which of them are a global's:
 *
 *   lineCount \t line:name,ord,total,address|...;line:...
 *
 * `ord` is the token's index among the line's tokens of that text, `total` how many the
 * line prints (any token kind, comments left out), `address` the global's in hex. The
 * consumer checks `total` against its own count, so a line it reads differently is left
 * alone rather than respelled at the wrong place. Lines are the lines of the snapshot's
 * decompile text (`ClangLine.getLineNumber`, as extract/call-divides.ts).
 *
 * Read-only: part of the per-function facts script (function-facts.ts), no transaction. A
 * failure leaves the field unset, which is also what an older snapshot looks like; the
 * pass then changes nothing.
 */

export interface ShadowedGlobalRef {
  /** The name the decompile prints, the global's and one of the function's own symbols'. */
  name: string;
  /** Index among the line's tokens of this text. */
  ord: number;
  /** Tokens of this text on the line. */
  total: number;
  /** The global's address, 8 lower-case hex digits. */
  address: string;
}

export interface ShadowedGlobalFacts {
  lineCount: number;
  /** Decompile line -> the global references on it that a parameter or local's name shadows. */
  lines: [number, ShadowedGlobalRef[]][];
}

/** Java fragment declared before the line loop of the facts script, with `r` in scope. */
export const SHADOWED_GLOBALS_DECL_JAVA = `
          StringBuilder nrow = new StringBuilder();
          java.util.Set<String> nOwn = new java.util.HashSet<>();
          if (r.getHighFunction() != null) {
            java.util.Iterator<ghidra.program.model.pcode.HighSymbol> nit = r.getHighFunction().getLocalSymbolMap().getSymbols();
            while (nit.hasNext()) nOwn.add(nit.next().getName());
          }
`;

/** Java fragment declared at the start of each line of the line loop. */
export const SHADOWED_GLOBALS_LINE_DECL_JAVA = `
            java.util.Map<String, Integer> nSeen = null;
            java.util.List<String[]> nSites = null;
`;

/** Java fragment run per token of a line (comments already skipped), with `t` in scope. */
export const SHADOWED_GLOBALS_TOKEN_JAVA = `
              if (!nOwn.isEmpty() && nOwn.contains(t.getText())) {
                if (nSeen == null) { nSeen = new java.util.HashMap<>(); nSites = new java.util.ArrayList<>(); }
                int nk = nSeen.getOrDefault(t.getText(), 0);
                nSeen.put(t.getText(), nk + 1);
                if (t instanceof ghidra.app.decompiler.ClangVariableToken) {
                  ghidra.program.model.pcode.HighVariable nhv = ((ghidra.app.decompiler.ClangVariableToken) t).getHighVariable();
                  if (nhv instanceof ghidra.program.model.pcode.HighGlobal) {
                    ghidra.program.model.pcode.HighSymbol nhs = nhv.getSymbol();
                    ghidra.program.model.address.Address na = nhs != null && nhs.getStorage() != null ? nhs.getStorage().getMinAddress() : null;
                    if (na == null && nhv.getRepresentative() != null) na = nhv.getRepresentative().getAddress();
                    if (na != null && na.isMemoryAddress())
                      nSites.add(new String[] { t.getText(), Integer.toString(nk), Long.toHexString(na.getOffset()) });
                  }
                }
              }
`;

/** Java fragment run once per line after its tokens. */
export const SHADOWED_GLOBALS_LINE_JAVA = `
            if (nSites != null && !nSites.isEmpty()) {
              StringBuilder none = new StringBuilder();
              for (String[] ns : nSites) none.append(none.length() > 0 ? "|" : "").append(ns[0]).append(',').append(ns[1]).append(',').append(nSeen.get(ns[0])).append(',').append(ns[2]);
              nrow.append(nrow.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':').append(none);
            }
`;

/** An `N` row's fields after the entry, parsed; null when malformed or empty. */
export function parseShadowedGlobalRow(row: string): ShadowedGlobalFacts | null {
  const c = row.replace(/\r$/, '').split('\t');
  if (c.length !== 2 || !/^\d+$/.test(c[0]) || !c[1]) return null;
  const lines: [number, ShadowedGlobalRef[]][] = [];
  for (const part of c[1].split(';')) {
    const m = /^(\d+):(.+)$/.exec(part);
    if (!m) return null;
    const refs: ShadowedGlobalRef[] = [];
    for (const s of m[2].split('|')) {
      const r = /^([A-Za-z_]\w*),(\d+),(\d+),([0-9a-f]{1,8})$/.exec(s);
      if (!r) return null;
      const ord = Number(r[2]), total = Number(r[3]);
      if (ord >= total) return null;
      refs.push({ name: r[1], ord, total, address: r[4].padStart(8, '0') });
    }
    lines.push([Number(m[1]), refs]);
  }
  return { lineCount: Number(c[0]), lines };
}
