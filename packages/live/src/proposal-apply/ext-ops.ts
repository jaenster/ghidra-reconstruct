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
 *   set_namespace {address, expect:{namespace}, namespace, reason}
 *       moves the function into the existing, non-class namespace `namespace`. Structural: a group
 *       that holds one is only rendered when the owner asks for it (render.ts, --structural)
 *   add_tag {address, expect:{tags}, tag}
 *       adds the function tag `tag` ("<type>:<data>"); expect.tags is every tag it has now
 *   add_comment {address, expect:{comment}, text}
 *       appends `text` as a line of its own to the function's plate comment
 *   funcdef_param {typePath, ordinal, expect:{name, type}, name?, type?}
 *       renames and/or retypes the ordinal-th parameter of a function definition type
 *   funcdef_return {typePath, expect:{type}, type}
 *       sets the return type of a function definition type
 *
 * A function tag is "<type>:<data>" as ghidra-mcp's batch_tag_symbols writes it and the generator
 * reads it (vc8form-spec.ts, vc8-linkage.ts). expect is checked before anything of the proposal is
 * written, like every other op; an op whose result is already there (an earlier proposal of the
 * same round made exactly this change) is skipped, as retype_local and rename_local are.
 */

/** Ops that need the extension, in the order they are applied after the template's own. */
export const EXT_OPS = ['linkage', 'vc8form', 'set_namespace', 'add_tag', 'add_comment', 'funcdef_return', 'funcdef_param'] as const;

/** Ops that move code between translation units: rendered only when the owner asks (render.ts). */
export const STRUCTURAL_OPS = ['set_namespace'] as const;

const HELPERS = String.raw`// vc8form / linkage: a function's tags of one type ("<type>:<data>"), by their data; and the namespace a path names
java.util.function.BiFunction<ghidra.program.model.listing.Function, String, java.util.Set<String>> tagsOf = (f, p) -> { java.util.Set<String> r = new java.util.TreeSet<>(); for (ghidra.program.model.listing.FunctionTag t : f.getTags()) if (t.getName().startsWith(p + ":")) r.add(t.getName().substring(p.length() + 1).trim()); return r; };
java.util.function.Function<com.google.gson.JsonArray, java.util.Set<String>> strs = a -> { java.util.Set<String> r = new java.util.TreeSet<>(); if (a != null) for (com.google.gson.JsonElement e : a) r.add(e.getAsString().trim()); return r; };
java.util.function.Function<ghidra.program.model.listing.Function, String> nsOf = f -> f.getParentNamespace() == null || f.getParentNamespace().isGlobal() ? "" : f.getParentNamespace().getName(true);
java.util.function.Function<String, ghidra.program.model.symbol.Namespace> nsAt = p -> { java.util.List<ghidra.program.model.symbol.Namespace> l = ghidra.app.util.NamespaceUtils.getNamespaceByPath(currentProgram, null, p); java.util.List<ghidra.program.model.symbol.Namespace> ok = new java.util.ArrayList<>();
 if (l != null) for (ghidra.program.model.symbol.Namespace n : l) if (!(n instanceof ghidra.program.model.listing.GhidraClass) && !(n instanceof ghidra.program.model.listing.Function)) ok.add(n);
 if (ok.size() != 1) throw new RuntimeException((ok.isEmpty() ? "no namespace " : "ambiguous namespace ") + p); return ok.get(0); };
// what a vc8form op leaves: the tags it expects, less replace, plus its tag
java.util.function.Function<com.google.gson.JsonObject, java.util.Set<String>> vc8formWant = o -> { java.util.Set<String> w = strs.apply(o.getAsJsonObject("expect").getAsJsonArray("tags")); if (o.has("replace")) w.removeAll(strs.apply(o.getAsJsonArray("replace"))); w.add(js.apply(o, "tag").trim()); return w; };
// add_tag: every tag of a function by its full name; add_comment: a plate comment as compared, and what it becomes
java.util.function.Function<ghidra.program.model.listing.Function, java.util.Set<String>> tagNames = f -> { java.util.Set<String> r = new java.util.TreeSet<>(); for (ghidra.program.model.listing.FunctionTag t : f.getTags()) r.add(t.getName().trim()); return r; };
java.util.function.Function<String, String> ncom = s -> s == null ? "" : s.replace("\r\n", "\n").replace('\r', '\n').trim();
java.util.function.BiFunction<String, String, String> comWant = (c, t) -> ncom.apply(c).isEmpty() ? t.trim() : ncom.apply(c) + "\n" + t.trim();
// a plate comment an add_comment wrote: kept past the run's plate restore once its proposal commits
java.util.Map<String, String> platePend = new java.util.TreeMap<>();
// funcdef_*: the function definition type at a path
java.util.function.Function<String, ghidra.program.model.data.FunctionDefinition> fdAt = p -> { ghidra.program.model.data.DataType d = base.apply(p); if (!(d instanceof ghidra.program.model.data.FunctionDefinition)) throw new RuntimeException(p + " is not a function definition"); return (ghidra.program.model.data.FunctionDefinition) d; };
`;

const CHECK = String.raw`else if (op.equals("vc8form")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address")); java.util.Set<String> cur = tagsOf.apply(f, "vc8form");
    if (cur.equals(vc8formWant.apply(o))) done.add(o); else if (!cur.equals(strs.apply(ex.getAsJsonArray("tags")))) why = op + " tags are " + cur; }
   else if (op.equals("linkage")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address")); java.util.Set<String> cur = tagsOf.apply(f, "vc8linkage"); String ns = nsOf.apply(f);
    String wantNs = js.apply(o, "namespace") != null ? js.apply(o, "namespace") : js.apply(ex, "namespace"); java.util.Set<String> wantTags = js.apply(o, "linkage") != null ? new java.util.TreeSet<>(java.util.List.of(js.apply(o, "linkage").trim())) : strs.apply(ex.getAsJsonArray("tags"));
    if (js.apply(o, "namespace") != null) nsAt.apply(js.apply(o, "namespace"));
    if (ns.equals(wantNs) && cur.equals(wantTags)) done.add(o); else if (!ns.equals(js.apply(ex, "namespace"))) why = op + " namespace is " + ns; else if (!cur.equals(strs.apply(ex.getAsJsonArray("tags")))) why = op + " tags are " + cur; }
   else if (op.equals("set_namespace")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address")); String ns = nsOf.apply(f); nsAt.apply(js.apply(o, "namespace"));
    if (ns.equals(js.apply(o, "namespace"))) done.add(o); else if (!ns.equals(js.apply(ex, "namespace"))) why = op + " namespace is " + ns; }
   else if (op.equals("add_tag")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address")); java.util.Set<String> cur = tagNames.apply(f); java.util.Set<String> want = strs.apply(ex.getAsJsonArray("tags")); want.add(js.apply(o, "tag").trim());
    if (cur.equals(want)) done.add(o); else if (!cur.equals(strs.apply(ex.getAsJsonArray("tags")))) why = op + " tags are " + cur; }
   else if (op.equals("add_comment")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address")); String cur = ncom.apply(f.getComment());
    if (cur.equals(comWant.apply(js.apply(ex, "comment"), js.apply(o, "text")))) done.add(o); else if (!cur.equals(ncom.apply(js.apply(ex, "comment")))) why = op + " comment is " + cur; }
   else if (op.equals("funcdef_param")) { ghidra.program.model.data.FunctionDefinition fd = fdAt.apply(js.apply(o, "typePath")); ghidra.program.model.data.ParameterDefinition[] args = fd.getArguments(); int k = o.get("ordinal").getAsInt();
    if (k >= args.length) why = op + " " + fd.getName() + " has " + args.length + " parameters"; else { ghidra.program.model.data.ParameterDefinition p = args[k]; String t = nsig.apply(p.getDataType().getDisplayName());
     String wn = js.apply(o, "name") != null ? js.apply(o, "name") : js.apply(ex, "name"); String wt = js.apply(o, "type") != null ? nsig.apply(type.apply(js.apply(o, "type")).getDisplayName()) : nsig.apply(js.apply(ex, "type"));
     if (p.getName().equals(wn) && t.equals(wt)) done.add(o); else if (!p.getName().equals(js.apply(ex, "name")) || !t.equals(nsig.apply(js.apply(ex, "type")))) why = op + " parameter " + k + " is " + p.getName() + ":" + p.getDataType().getDisplayName(); } }
   else if (op.equals("funcdef_return")) { ghidra.program.model.data.FunctionDefinition fd = fdAt.apply(js.apply(o, "typePath")); String t = nsig.apply(fd.getReturnType().getDisplayName());
    if (t.equals(nsig.apply(type.apply(js.apply(o, "type")).getDisplayName()))) done.add(o); else if (!t.equals(nsig.apply(js.apply(ex, "type")))) why = op + " returns " + fd.getReturnType().getDisplayName(); }
   `;

const APPLY = String.raw`else if (op.equals("vc8form")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address"));
    if (o.has("replace")) for (com.google.gson.JsonElement r : o.getAsJsonArray("replace")) for (ghidra.program.model.listing.FunctionTag t : new java.util.ArrayList<>(f.getTags())) if (t.getName().startsWith("vc8form:") && t.getName().substring(8).trim().equals(r.getAsString().trim())) f.removeTag(t.getName());
    f.addTag("vc8form:" + js.apply(o, "tag").trim()); }
   else if (op.equals("linkage")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address"));
    if (js.apply(o, "linkage") != null) { for (ghidra.program.model.listing.FunctionTag t : new java.util.ArrayList<>(f.getTags())) if (t.getName().startsWith("vc8linkage:")) f.removeTag(t.getName()); f.addTag("vc8linkage:" + js.apply(o, "linkage").trim()); }
    if (js.apply(o, "namespace") != null) f.setParentNamespace(nsAt.apply(js.apply(o, "namespace"))); }
   else if (op.equals("set_namespace")) fnAt.apply(js.apply(o, "address")).setParentNamespace(nsAt.apply(js.apply(o, "namespace")));
   else if (op.equals("add_tag")) fnAt.apply(js.apply(o, "address")).addTag(js.apply(o, "tag").trim());
   else if (op.equals("add_comment")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address")); String c = comWant.apply(f.getComment(), js.apply(o, "text")); f.setComment(c); platePend.put(f.getEntryPoint().toString(), c); }
   else if (op.equals("funcdef_param")) { ghidra.program.model.data.FunctionDefinition fd = fdAt.apply(js.apply(o, "typePath")); ghidra.program.model.data.ParameterDefinition[] args = fd.getArguments(); int k = o.get("ordinal").getAsInt();
    ghidra.program.model.data.ParameterDefinition[] next = new ghidra.program.model.data.ParameterDefinition[args.length];
    for (int i = 0; i < args.length; i++) { ghidra.program.model.data.ParameterDefinition p = args[i]; String nm = p.getName(); ghidra.program.model.data.DataType dt = p.getDataType();
     if (i == k) { if (js.apply(o, "name") != null) nm = js.apply(o, "name"); if (js.apply(o, "type") != null) dt = type.apply(js.apply(o, "type")); }
     next[i] = new ghidra.program.model.data.ParameterDefinitionImpl(nm, dt, p.getComment()); }
    fd.setArguments(next); }
   else if (op.equals("funcdef_return")) fdAt.apply(js.apply(o, "typePath")).setReturnType(type.apply(js.apply(o, "type")));
   `;

/** At the start of each proposal: no comment of an earlier one is pending. */
const BEGIN = ' platePend.clear();';

/** When a proposal commits: its comments are the plates the run's restore keeps. */
const COMMITTED = 'plates.putAll(platePend); ';

/** The text each marker takes; empty when the group holds no op of the extension. */
export type ExtMarker = '__EXT_HELPERS__' | '__EXT_ORDER__' | '__EXT_CHECK__' | '__EXT_APPLY__' | '__EXT_BEGIN__' | '__EXT_COMMITTED__';

export function extensionParts(ops: Array<{ op?: unknown }>): Record<ExtMarker, string> {
  const needed = ops.some((o) => (EXT_OPS as readonly unknown[]).includes(o.op));
  if (!needed) return { __EXT_HELPERS__: '', __EXT_ORDER__: '', __EXT_CHECK__: '', __EXT_APPLY__: '', __EXT_BEGIN__: '', __EXT_COMMITTED__: '' };
  return {
    __EXT_HELPERS__: HELPERS,
    __EXT_ORDER__: EXT_OPS.map((k) => `, "${k}"`).join(''),
    __EXT_CHECK__: CHECK,
    __EXT_APPLY__: APPLY,
    __EXT_BEGIN__: BEGIN,
    __EXT_COMMITTED__: COMMITTED,
  };
}
