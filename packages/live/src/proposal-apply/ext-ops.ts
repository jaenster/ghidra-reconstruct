/**
 * The Java of the proposal ops the original template did not know, put into its __EXT_*__ markers
 * (template.ts) when a group holds one of them:
 *
 *   vc8form {address, expect:{tags}, tag, replace?}
 *       adds the function tag "vc8form:<tag>" and removes "vc8form:<r>" for each r of replace
 *   linkage {address, expect:{namespace, tags}, linkage?, namespace?}
 *       sets the function's one "vc8linkage:<linkage>" tag (every other vc8linkage tag goes) and
 *       moves it into the existing, non-class namespace `namespace`: the file the generator
 *       defines it in
 *
 * A function tag is "<type>:<data>" as ghidra-mcp's batch_tag_symbols writes it and the generator
 * reads it (vc8form-spec.ts, vc8-linkage.ts). expect is checked before anything of the proposal is
 * written, like every other op; an op whose result is already there (an earlier proposal of the
 * same round made exactly this change) is skipped, as retype_local and rename_local are.
 */

/** Ops that need the extension, in the order they are applied after the template's own. */
export const EXT_OPS = ['linkage', 'vc8form'] as const;

const HELPERS = String.raw`// vc8form / linkage: a function's tags of one type ("<type>:<data>"), by their data; and the namespace a path names
java.util.function.BiFunction<ghidra.program.model.listing.Function, String, java.util.Set<String>> tagsOf = (f, p) -> { java.util.Set<String> r = new java.util.TreeSet<>(); for (ghidra.program.model.listing.FunctionTag t : f.getTags()) if (t.getName().startsWith(p + ":")) r.add(t.getName().substring(p.length() + 1).trim()); return r; };
java.util.function.Function<com.google.gson.JsonArray, java.util.Set<String>> strs = a -> { java.util.Set<String> r = new java.util.TreeSet<>(); if (a != null) for (com.google.gson.JsonElement e : a) r.add(e.getAsString().trim()); return r; };
java.util.function.Function<ghidra.program.model.listing.Function, String> nsOf = f -> f.getParentNamespace() == null || f.getParentNamespace().isGlobal() ? "" : f.getParentNamespace().getName(true);
java.util.function.Function<String, ghidra.program.model.symbol.Namespace> nsAt = p -> { java.util.List<ghidra.program.model.symbol.Namespace> l = ghidra.app.util.NamespaceUtils.getNamespaceByPath(currentProgram, null, p); java.util.List<ghidra.program.model.symbol.Namespace> ok = new java.util.ArrayList<>();
 if (l != null) for (ghidra.program.model.symbol.Namespace n : l) if (!(n instanceof ghidra.program.model.listing.GhidraClass) && !(n instanceof ghidra.program.model.listing.Function)) ok.add(n);
 if (ok.size() != 1) throw new RuntimeException((ok.isEmpty() ? "no namespace " : "ambiguous namespace ") + p); return ok.get(0); };
// what a vc8form op leaves: the tags it expects, less replace, plus its tag
java.util.function.Function<com.google.gson.JsonObject, java.util.Set<String>> vc8formWant = o -> { java.util.Set<String> w = strs.apply(o.getAsJsonObject("expect").getAsJsonArray("tags")); if (o.has("replace")) w.removeAll(strs.apply(o.getAsJsonArray("replace"))); w.add(js.apply(o, "tag").trim()); return w; };
`;

const CHECK = String.raw`else if (op.equals("vc8form")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address")); java.util.Set<String> cur = tagsOf.apply(f, "vc8form");
    if (cur.equals(vc8formWant.apply(o))) done.add(o); else if (!cur.equals(strs.apply(ex.getAsJsonArray("tags")))) why = op + " tags are " + cur; }
   else if (op.equals("linkage")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address")); java.util.Set<String> cur = tagsOf.apply(f, "vc8linkage"); String ns = nsOf.apply(f);
    String wantNs = js.apply(o, "namespace") != null ? js.apply(o, "namespace") : js.apply(ex, "namespace"); java.util.Set<String> wantTags = js.apply(o, "linkage") != null ? new java.util.TreeSet<>(java.util.List.of(js.apply(o, "linkage").trim())) : strs.apply(ex.getAsJsonArray("tags"));
    if (js.apply(o, "namespace") != null) nsAt.apply(js.apply(o, "namespace"));
    if (ns.equals(wantNs) && cur.equals(wantTags)) done.add(o); else if (!ns.equals(js.apply(ex, "namespace"))) why = op + " namespace is " + ns; else if (!cur.equals(strs.apply(ex.getAsJsonArray("tags")))) why = op + " tags are " + cur; }
   `;

const APPLY = String.raw`else if (op.equals("vc8form")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address"));
    if (o.has("replace")) for (com.google.gson.JsonElement r : o.getAsJsonArray("replace")) for (ghidra.program.model.listing.FunctionTag t : new java.util.ArrayList<>(f.getTags())) if (t.getName().startsWith("vc8form:") && t.getName().substring(8).trim().equals(r.getAsString().trim())) f.removeTag(t.getName());
    f.addTag("vc8form:" + js.apply(o, "tag").trim()); }
   else if (op.equals("linkage")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address"));
    if (js.apply(o, "linkage") != null) { for (ghidra.program.model.listing.FunctionTag t : new java.util.ArrayList<>(f.getTags())) if (t.getName().startsWith("vc8linkage:")) f.removeTag(t.getName()); f.addTag("vc8linkage:" + js.apply(o, "linkage").trim()); }
    if (js.apply(o, "namespace") != null) f.setParentNamespace(nsAt.apply(js.apply(o, "namespace"))); }
   `;

/** The text each marker takes; empty when the group holds no op of the extension. */
export function extensionParts(ops: Array<{ op?: unknown }>): Record<'__EXT_HELPERS__' | '__EXT_ORDER__' | '__EXT_CHECK__' | '__EXT_APPLY__', string> {
  const needed = ops.some((o) => (EXT_OPS as readonly unknown[]).includes(o.op));
  if (!needed) return { __EXT_HELPERS__: '', __EXT_ORDER__: '', __EXT_CHECK__: '', __EXT_APPLY__: '' };
  return {
    __EXT_HELPERS__: HELPERS,
    __EXT_ORDER__: EXT_OPS.map((k) => `, "${k}"`).join(''),
    __EXT_CHECK__: CHECK,
    __EXT_APPLY__: APPLY,
  };
}
