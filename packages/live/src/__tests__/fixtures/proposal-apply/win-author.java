boolean DRY=false; String TAG="community-proposal"; String GROUP="win ünï";
String J = """
[{"id":999001,"ops":[{"op":"rename_local","program":"win","function":"0x00401000","storage":"Stack[0x4]","expect":{"name":"param_1"},"name":"p\\u00c4"},{"op":"set_global_type","program":"win","address":"0x007a0000","expect":{"type":"char[4] \\"q\\" \\\\ \\u007f \\t","size":4},"type":"char[4]"}]}]
""";
com.google.gson.JsonArray props = com.google.gson.JsonParser.parseString(J).getAsJsonArray();
ghidra.program.model.data.DataTypeManager dtm = currentProgram.getDataTypeManager();
ghidra.program.model.listing.Listing L = currentProgram.getListing();
ghidra.program.model.symbol.SourceType U = ghidra.program.model.symbol.SourceType.USER_DEFINED;
ghidra.program.model.data.DataTypeManager BI = ghidra.program.model.data.BuiltInDataTypeManager.getDataTypeManager();
java.util.Map<String, ghidra.program.model.data.DataType> pend = new java.util.HashMap<>();
java.util.function.Function<String, ghidra.program.model.data.DataType> base = n0 -> {
 String n = n0.trim(); if (pend.containsKey(n)) return pend.get(n);
 if (n.startsWith("/")) { int i = n.lastIndexOf('/'); ghidra.program.model.data.CategoryPath cp = new ghidra.program.model.data.CategoryPath(i == 0 ? "/" : n.substring(0, i));
  ghidra.program.model.data.DataType d = dtm.getDataType(cp, n.substring(i + 1)); if (d != null) return d;
  if (i == 0) { d = BI.getDataType(cp, n.substring(1)); if (d != null) return d; }
  throw new RuntimeException("no type at path " + n); }
 ghidra.program.model.data.DataType d = dtm.getDataType(new ghidra.program.model.data.CategoryPath("/"), n); if (d != null) return d;
 d = BI.getDataType(new ghidra.program.model.data.CategoryPath("/"), n); if (d != null) return d;
 java.util.List<ghidra.program.model.data.DataType> l = new java.util.ArrayList<>(); dtm.findDataTypes(n, l); if (l.size() == 1) return l.get(0);
 // copies of one typedef in several header categories (the Mac program has uint32_t and size_t more than once): same-size typedefs, the shallowest category wins
 if (l.size() > 1) { boolean same = true; for (ghidra.program.model.data.DataType x : l) same &= x instanceof ghidra.program.model.data.TypeDef && x.getLength() == l.get(0).getLength();
  if (same) { l.sort(java.util.Comparator.comparingInt(x -> x.getCategoryPath().getPath().length())); return l.get(0); } }
 throw new RuntimeException((l.size() > 1 ? "ambiguous " : "no type ") + n); };
java.util.function.Function<String, ghidra.program.model.data.DataType> type = s0 -> {
 String s = s0.trim(); java.util.List<Integer> dims = new java.util.ArrayList<>();
 while (s.endsWith("]")) { int i = s.lastIndexOf('['); dims.add(0, Integer.decode(s.substring(i + 1, s.length() - 1).trim())); s = s.substring(0, i).trim(); }
 int st = 0; while (s.endsWith("*")) { st++; s = s.substring(0, s.length() - 1).trim(); }
 ghidra.program.model.data.DataType d = base.apply(s);
 for (int k = 0; k < st; k++) d = new ghidra.program.model.data.PointerDataType(d, dtm); // default size: an explicit 4 spells the type "T *32"
 for (int k = dims.size() - 1; k >= 0; k--) d = new ghidra.program.model.data.ArrayDataType(d, dims.get(k), d.getLength(), dtm);
 return d; };
// Proposal ops (redivivus.app): each proposal is all-or-nothing; every expect is checked before any op of it is written.
java.util.function.Function<String, String> norm = s0 -> { String s = s0.trim().replaceAll(":\\d+$", ""); java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?i)^stack\\[(-?)0x([0-9a-f]+)\\]$").matcher(s);
 if (m.find()) return "Stack[" + m.group(1) + "0x" + m.group(2).replaceFirst("^0+(?=.)", "").toLowerCase() + "]"; if (s.toLowerCase().startsWith("hash:")) return "HASH:" + s.substring(5).toLowerCase(); return s.toUpperCase(); };
// "T *32" is Ghidra's spelling of a pointer with its size pinned; the same type as "T *"
java.util.function.Function<String, String> nsig = s -> s.trim().replaceAll("\\*32\\b", "*").replaceAll("\\s+", " ").replaceAll("\\s*([(),*])\\s*", "$1");
java.util.function.Function<String, String> nconv = s -> s == null ? "" : s.trim().toLowerCase().replaceFirst("^_+", "");
java.util.function.BiFunction<com.google.gson.JsonObject, String, String> js = (o, k) -> (o.has(k) && !o.get(k).isJsonNull()) ? o.get(k).getAsString() : null;
java.util.function.Function<String, ghidra.program.model.listing.Function> fnAt = a -> { ghidra.program.model.listing.Function f = getFunctionAt(toAddr(a)); if (f == null) throw new RuntimeException("no function at " + a); return f; };
// Like the checker: of the variables at a storage, the one whose name, or type, the proposer saw; an undefinedN of the same size stands for what the decompiler resolves it to.
java.util.function.Function<Object[], ghidra.program.model.listing.Variable> varAt = q -> { ghidra.program.model.listing.Function f = (ghidra.program.model.listing.Function) q[0]; String st = (String) q[1]; String en = (String) q[2], et = (String) q[3];
 java.util.List<ghidra.program.model.listing.Variable> at = new java.util.ArrayList<>(); for (ghidra.program.model.listing.Variable v : f.getAllVariables()) if (norm.apply(v.getVariableStorage().toString()).equals(st)) at.add(v);
 if (at.isEmpty()) throw new RuntimeException("nothing at " + st + " in " + f.getName());
 java.util.List<ghidra.program.model.listing.Variable> hit = new java.util.ArrayList<>();
 if (en != null) { for (ghidra.program.model.listing.Variable v : at) if (v.getName().equals(en)) hit.add(v); }
 else { for (ghidra.program.model.listing.Variable v : at) if (nsig.apply(v.getDataType().getDisplayName()).equals(nsig.apply(et))) hit.add(v);
  if (hit.isEmpty()) { int len = type.apply(et).getLength(); for (ghidra.program.model.listing.Variable v : at) if (v.getDataType().getName().startsWith("undefined") && v.getLength() == len) hit.add(v); } }
 if (hit.size() != 1) { String have = ""; for (ghidra.program.model.listing.Variable v : at) have += v.getName() + ":" + v.getDataType().getDisplayName() + " "; throw new RuntimeException((hit.isEmpty() ? "expect not found" : "ambiguous") + " at " + st + ", has " + have.trim()); }
 return hit.get(0); };
// "ret NAME(type a, type b)" -> [ret, name, [type, name]...]
java.util.function.Function<String, java.util.List<String[]>> psig = sig -> { int o = sig.indexOf('('), c = sig.lastIndexOf(')'); java.util.List<String[]> r = new java.util.ArrayList<>();
 String head = sig.substring(0, o).trim(); java.util.regex.Matcher m = java.util.regex.Pattern.compile("([A-Za-z_][A-Za-z0-9_:]*)\\s*$").matcher(head); if (!m.find()) throw new RuntimeException("no name in " + sig);
 r.add(new String[]{head.substring(0, m.start()).trim().replaceAll("\\b__\\w+\\s*$", "").trim(), m.group(1)}); String in = sig.substring(o + 1, c).trim();
 if (!in.isEmpty() && !in.equals("void")) for (String p : in.split(",")) { p = p.trim(); if (p.equals("...")) continue; java.util.regex.Matcher pm = java.util.regex.Pattern.compile("^(.*?[\\s*])([A-Za-z_][A-Za-z0-9_]*)$").matcher(p); if (!pm.find()) throw new RuntimeException("parameter without a name: " + p); r.add(new String[]{pm.group(1).trim(), pm.group(2)}); }
 return r; };
String[] ORDER = {"rename_function", "rename_global", "set_global_type", "struct_field", "set_prototype", "retype_local", "rename_local", "delete_label"};
java.util.Set<String> fset = new java.util.TreeSet<>();
for (com.google.gson.JsonElement pe : props) for (com.google.gson.JsonElement oe : pe.getAsJsonObject().getAsJsonArray("ops")) { com.google.gson.JsonObject o = oe.getAsJsonObject(); String a = js.apply(o, "function"); if (a == null && !o.get("op").getAsString().contains("global") && o.has("address")) a = js.apply(o, "address"); if (a != null && getFunctionAt(toAddr(a)) != null) fset.add(toAddr(a).toString()); }
ghidra.app.decompiler.DecompInterface di = new ghidra.app.decompiler.DecompInterface(); di.openProgram(currentProgram);
java.util.function.Function<String, java.util.Set<String>> regs = a -> { java.util.Set<String> r = new java.util.TreeSet<>(); try { ghidra.app.decompiler.DecompileResults res = di.decompileFunction(getFunctionAt(toAddr(a)), 60, monitor); if (res.getDecompiledFunction() == null) { r.add("DECOMPFAIL"); return r; } java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\b(in_|unaff_|extraout_)\\w+").matcher(res.getDecompiledFunction().getC()); while (m.find()) r.add(m.group()); } catch (Exception x) { r.add("ERR"); } return r; };
java.util.Map<String, java.util.Set<String>> before = new java.util.TreeMap<>(); if (!DRY) for (String a : fset) before.put(a, regs.apply(a));
// a vc8form tag's dh is a hash of its function's decompile: an applied op that changes that decompile (a prototype change, also in the callers) leaves the tag stale until it is re-measured
java.util.function.Function<String, java.util.List<String>> vtags = a -> { java.util.List<String> r = new java.util.ArrayList<>(); ghidra.program.model.listing.Function f = getFunctionAt(toAddr(a)); if (f != null) for (ghidra.program.model.listing.FunctionTag t : f.getTags()) if (t.getName().startsWith("vc8form:")) r.add(t.getName()); java.util.Collections.sort(r); return r; };
java.util.function.Function<String, java.util.Set<String>> vcallers = a -> { java.util.Set<String> r = new java.util.TreeSet<>(); ghidra.program.model.listing.Function f = getFunctionAt(toAddr(a)); if (f != null) for (ghidra.program.model.listing.Function c : f.getCallingFunctions(monitor)) r.add(c.getEntryPoint().toString()); return r; };
java.util.function.Function<String, String> vtext = a -> { try { ghidra.app.decompiler.DecompileResults res = di.decompileFunction(getFunctionAt(toAddr(a)), 60, monitor); return res.getDecompiledFunction() == null ? "DECOMPFAIL" : res.getDecompiledFunction().getC().replaceAll("\\s+", " ").trim(); } catch (Exception x) { return "ERR " + x.getMessage(); } };
java.util.function.Function<String, String> vname = a -> getFunctionAt(toAddr(a)).getName();
java.util.Set<String> vproto = new java.util.TreeSet<>(); for (com.google.gson.JsonElement pe : props) for (com.google.gson.JsonElement oe : pe.getAsJsonObject().getAsJsonArray("ops")) { com.google.gson.JsonObject o = oe.getAsJsonObject(); if (o.get("op").getAsString().equals("set_prototype") && getFunctionAt(toAddr(js.apply(o, "address"))) != null) vproto.add(toAddr(js.apply(o, "address")).toString()); }
java.util.Set<String> vset = new java.util.TreeSet<>(); for (String a : fset) if (!vtags.apply(a).isEmpty()) vset.add(a); for (String p : vproto) for (String c : vcallers.apply(p)) if (!vtags.apply(c).isEmpty()) vset.add(c);
java.util.Map<String, String> vbefore = new java.util.TreeMap<>(); for (String a : vset) { if (DRY) println("VC8FORM-WATCH " + a + " " + vname.apply(a) + " " + vtags.apply(a)); else vbefore.put(a, vtext.apply(a)); }
java.util.Map<String, String> plates = new java.util.TreeMap<>(); for (String a : fset) { String p = L.getComment(ghidra.program.model.listing.CodeUnit.PLATE_COMMENT, toAddr(a)); plates.put(a, p == null ? "" : p); }
int okP = 0, skipP = 0, nOps = 0;
// one top-level transaction per proposal: a sub-transaction ended with false aborts its whole outer transaction, so nesting would drop every proposal of the run
int tx = -1;
try {
for (com.google.gson.JsonElement pe : props) { com.google.gson.JsonObject P = pe.getAsJsonObject(); int id = P.get("id").getAsInt(); java.util.List<com.google.gson.JsonObject> ops = new java.util.ArrayList<>();
 for (String k : ORDER) for (com.google.gson.JsonElement oe : P.getAsJsonArray("ops")) if (oe.getAsJsonObject().get("op").getAsString().equals(k)) ops.add(oe.getAsJsonObject());
 String why = null; java.util.Set<com.google.gson.JsonObject> done = new java.util.HashSet<>();
 // check every expect first
 for (com.google.gson.JsonObject o : ops) { if (why != null) break; String op = o.get("op").getAsString(); com.google.gson.JsonObject ex = o.getAsJsonObject("expect");
  try {
   if (op.equals("rename_function")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address")); if (!f.getName().equals(js.apply(ex, "name"))) why = op + " name is " + f.getName(); }
   else if (op.equals("rename_global")) { ghidra.program.model.symbol.Symbol s = getSymbolAt(toAddr(js.apply(o, "address"))); if (s == null || !s.getName().equals(js.apply(ex, "name"))) why = op + " name is " + (s == null ? "none" : s.getName()); }
   else if (op.equals("delete_label")) { ghidra.program.model.symbol.Symbol s = getSymbolAt(toAddr(js.apply(o, "address"))); if (s == null || !s.getName().equals(js.apply(ex, "name"))) why = op + " name is " + (s == null ? "none" : s.getName()); }
   else if (op.equals("set_global_type")) { ghidra.program.model.listing.Data d = getDataAt(toAddr(js.apply(o, "address"))); String t = d == null ? "none" : d.getDataType().getDisplayName(); if (!nsig.apply(t).equals(nsig.apply(js.apply(ex, "type")))) why = op + " type is " + t; type.apply(js.apply(o, "type")); }
   else if (op.equals("struct_field")) { ghidra.program.model.data.DataType sd = base.apply(js.apply(o, "typePath")); if (!(sd instanceof ghidra.program.model.data.Structure)) throw new RuntimeException("not a structure"); ghidra.program.model.data.DataTypeComponent c = ((ghidra.program.model.data.Structure) sd).getComponentAt(o.get("offset").getAsInt());
    if (c == null || c.getOffset() != o.get("offset").getAsInt()) why = op + " no field at offset"; else { if (ex.has("name") && !String.valueOf(c.getFieldName()).equals(js.apply(ex, "name"))) why = op + " field is " + c.getFieldName(); if (ex.has("type") && !nsig.apply(c.getDataType().getDisplayName()).equals(nsig.apply(js.apply(ex, "type")))) why = op + " field type is " + c.getDataType().getDisplayName(); if (o.has("type") && type.apply(js.apply(o, "type")).getLength() > c.getLength() && c.getLength() > 0) { /* growth checked at write */ } } }
   else if (op.equals("set_prototype")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address")); String cur = f.getSignature().getPrototypeString();
    if (!nsig.apply(cur).equals(nsig.apply(js.apply(ex, "signature")))) why = op + " signature is " + cur; else if (!nconv.apply(f.getCallingConventionName()).equals(nconv.apply(js.apply(ex, "callingConvention")))) why = op + " convention is " + f.getCallingConventionName();
    java.util.List<String[]> s = psig.apply(js.apply(o, "signature")); type.apply(s.get(0)[0]); for (int i = 1; i < s.size(); i++) type.apply(s.get(i)[0]); }
   else { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "function")); String st = norm.apply(js.apply(o, "storage"));
    try { varAt.apply(new Object[]{f, st, js.apply(ex, "name"), js.apply(ex, "type")}); if (op.equals("retype_local")) type.apply(js.apply(o, "type")); }
    catch (Exception x) { boolean already = false; // an earlier proposal of the same round already made exactly this change
     for (ghidra.program.model.listing.Variable v : f.getAllVariables()) { if (!norm.apply(v.getVariableStorage().toString()).equals(st)) continue;
      if (op.equals("retype_local") && nsig.apply(v.getDataType().getDisplayName()).equals(nsig.apply(type.apply(js.apply(o, "type")).getDisplayName()))) already = true;
      if (op.equals("rename_local") && v.getName().equals(js.apply(o, "name"))) already = true; }
     if (!already) throw x; done.add(o); } }
  } catch (Exception x) { why = op + ": " + x.getMessage(); } }
 if (why != null) { println("SKIP " + id + " " + why); skipP++; continue; }
 if (DRY) { println("OK " + id + " " + ops.size() + " ops"); okP++; nOps += ops.size(); continue; }
 int sub = currentProgram.startTransaction("p" + id); boolean good = false; String err = null;
 try { for (com.google.gson.JsonObject o : ops) { if (done.contains(o)) continue; String op = o.get("op").getAsString();
   if (op.equals("rename_function")) fnAt.apply(js.apply(o, "address")).setName(js.apply(o, "name"), U);
   else if (op.equals("rename_global")) getSymbolAt(toAddr(js.apply(o, "address"))).setName(js.apply(o, "name"), U);
   else if (op.equals("delete_label")) { ghidra.program.model.symbol.Symbol s = getSymbolAt(toAddr(js.apply(o, "address"))); if (!s.delete()) throw new RuntimeException("label not deleted"); }
   else if (op.equals("set_global_type")) { ghidra.program.model.address.Address a = toAddr(js.apply(o, "address")); ghidra.program.model.data.DataType dt = type.apply(js.apply(o, "type")); L.clearCodeUnits(a, a.add(Math.max(dt.getLength(), getDataAt(a).getLength()) - 1), false); L.createData(a, dt); }
   else if (op.equals("struct_field")) { ghidra.program.model.data.Structure sd = (ghidra.program.model.data.Structure) base.apply(js.apply(o, "typePath")); int off = o.get("offset").getAsInt(); ghidra.program.model.data.DataTypeComponent c = sd.getComponentAt(off);
    ghidra.program.model.data.DataType dt = o.has("type") ? type.apply(js.apply(o, "type")) : c.getDataType(); String nm = o.has("name") ? js.apply(o, "name") : c.getFieldName();
    // a larger type takes the undefined bytes after the field, and replaceAtOffset refuses when a defined field is in the way
    // a larger type takes the free bytes after the field (undefined, or an explicit _pad field), and past the end it grows the structure
    int end = off + dt.getLength();
    if (dt.getLength() > c.getLength()) { java.util.List<Integer> clear = new java.util.ArrayList<>();
     for (ghidra.program.model.data.DataTypeComponent n : sd.getDefinedComponents()) { if (n.getOffset() < off + c.getLength() || n.getOffset() >= end) continue;
      if (n.getFieldName() == null || !n.getFieldName().startsWith("_pad")) throw new RuntimeException("struct_field grows over " + n.getFieldName() + " at " + n.getOffset());
      if (n.getOffset() + n.getLength() > end) throw new RuntimeException("struct_field ends inside " + n.getFieldName()); clear.add(n.getOffset()); }
     for (int co : clear) sd.clearAtOffset(co);
     if (end > sd.getLength()) sd.growStructure(end - sd.getLength()); }
    sd.replaceAtOffset(off, dt, dt.getLength(), nm, c.getComment()); }
   else if (op.equals("set_prototype")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address")); java.util.List<String[]> s = psig.apply(js.apply(o, "signature")); ghidra.program.model.data.DataType rdt = type.apply(s.get(0)[0]);
    boolean custom = f.hasCustomVariableStorage(); java.util.List<ghidra.program.model.listing.Parameter> ps = new java.util.ArrayList<>();
    if (custom && f.getParameterCount() != s.size() - 1) throw new RuntimeException("custom storage and the parameter count changes");
    // custom storage follows the parameter's name when the new names are the old ones reordered, else its position
    java.util.Map<String, ghidra.program.model.listing.VariableStorage> byName = new java.util.HashMap<>(); if (custom) for (ghidra.program.model.listing.Parameter op0 : f.getParameters()) byName.put(op0.getName(), op0.getVariableStorage());
    boolean perm = custom && byName.size() == s.size() - 1; if (perm) for (int i = 1; i < s.size(); i++) perm &= byName.containsKey(s.get(i)[1]);
    for (int i = 1; i < s.size(); i++) { ghidra.program.model.data.DataType pdt = type.apply(s.get(i)[0]); ghidra.program.model.listing.VariableStorage vs = ghidra.program.model.listing.VariableStorage.UNASSIGNED_STORAGE;
     if (custom) { vs = perm ? byName.get(s.get(i)[1]) : f.getParameter(i - 1).getVariableStorage(); if (vs.size() != pdt.getLength()) throw new RuntimeException("custom storage size change on parameter " + i); }
     ps.add(new ghidra.program.model.listing.ParameterImpl(s.get(i)[1], pdt, vs, currentProgram, U)); }
    ghidra.program.model.listing.ReturnParameterImpl ret;
    if (custom && !(rdt instanceof ghidra.program.model.data.VoidDataType) && rdt.getLength() > 0) { String rn = rdt.getLength() == 1 ? "AL" : rdt.getLength() == 2 ? "AX" : "EAX"; ret = new ghidra.program.model.listing.ReturnParameterImpl(rdt, new ghidra.program.model.listing.VariableStorage(currentProgram, currentProgram.getRegister(rn)), currentProgram); }
    else ret = new ghidra.program.model.listing.ReturnParameterImpl(rdt, currentProgram);
    String conv = js.apply(o, "callingConvention"); if (conv == null || nconv.apply(conv).equals("unknown") || custom) conv = f.getCallingConventionName();
    f.updateFunction(conv, ret, ps, custom ? ghidra.program.model.listing.Function.FunctionUpdateType.CUSTOM_STORAGE : ghidra.program.model.listing.Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, U); if (js.apply(o, "signature").contains("...")) f.setVarArgs(true); }
   else { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "function")); com.google.gson.JsonObject ex = o.getAsJsonObject("expect"); ghidra.program.model.listing.Variable v = varAt.apply(new Object[]{f, norm.apply(js.apply(o, "storage")), js.apply(ex, "name"), js.apply(ex, "type")});
    if (op.equals("retype_local")) { ghidra.program.model.data.DataType dt = type.apply(js.apply(o, "type")); if (dt.getLength() != v.getLength() && f.hasCustomVariableStorage() && v instanceof ghidra.program.model.listing.Parameter) throw new RuntimeException("size change on custom storage parameter"); v.setDataType(dt, true, true, U); }
    else v.setName(js.apply(o, "name"), U); }
   String a = js.apply(o, "function") != null ? js.apply(o, "function") : js.apply(o, "address"); ghidra.program.model.listing.Function tf = a == null ? null : getFunctionAt(toAddr(a)); if (tf != null) tf.addTag(TAG); }
  good = true;
 } catch (Exception x) { err = x.getMessage(); } finally { currentProgram.endTransaction(sub, good); }
 if (good) { println("APPLIED " + id + " " + ops.size() + " ops"); okP++; nOps += ops.size(); } else { println("FAILED " + id + " " + err); skipP++; }
}
int restored = 0;
for (java.util.Map.Entry<String, String> pe : plates.entrySet()) { String now = L.getComment(ghidra.program.model.listing.CodeUnit.PLATE_COMMENT, toAddr(pe.getKey())); if (now == null) now = "";
 if (!now.equals(pe.getValue())) { if (!DRY) { int ptx = currentProgram.startTransaction("restore plate"); L.setComment(toAddr(pe.getKey()), ghidra.program.model.listing.CodeUnit.PLATE_COMMENT, pe.getValue().isEmpty() ? null : pe.getValue()); currentProgram.endTransaction(ptx, true); } restored++; } }
println("SUMMARY " + GROUP + " proposals ok=" + okP + " skipped=" + skipP + " ops=" + nOps + " fns=" + fset.size() + " platesRestored=" + restored + (DRY ? " DRY" : ""));
} finally { }
if (!DRY) { int nNew = 0; for (String a : fset) { java.util.Set<String> nw = new java.util.TreeSet<>(regs.apply(a)); nw.removeAll(before.get(a)); if (!nw.isEmpty()) { nNew++; println("NEWREG " + a + " " + getFunctionAt(toAddr(a)).getName() + " " + nw); } } println("REGCHECK functions-with-new-register-symbols=" + nNew + " of " + fset.size()); }
if (!DRY) { int nStale = 0; for (String a : vset) { if (vtext.apply(a).equals(vbefore.get(a))) continue; nStale++; for (String t : vtags.apply(a)) println("VC8FORM-STALE " + a + " " + vname.apply(a) + " " + t); } println("VC8FORMCHECK functions-with-stale-dh=" + nStale + " of " + vset.size() + (nStale > 0 ? ": re-measure their dh in this batch (codegen with GHIDRA_VC8FORM_HASHES, then scripts/vc8form-rehash.ts or a measured tag)" : "")); }
di.dispose();
