/**
 * Runs the vc8form stale check of a rendered proposal script without Ghidra. The test splices
 * the rendered watch and check statements over the markers; the functions, their tags, callers
 * and decompile text are maps. args: the addresses whose decompile the "applied" ops change
 * (ws:<address> changes only its whitespace).
 */
public class VcHarness {
  static void println(String s) { System.out.println(s); }
  public static void main(String[] args) {
    boolean DRY = false;
    java.util.Map<String, String> names = java.util.Map.of("00401000", "Target", "00402000", "TaggedEdited", "00403000", "Caller", "00404000", "PlainCaller", "00405000", "TaggedUntouched", "00406000", "UntaggedEdited");
    java.util.Map<String, java.util.List<String>> tags = java.util.Map.of(
      "00402000", java.util.List.of("vc8form:fold(nListCount);ev=0123456789;bh=96-1a2b3c4d;dh=5e6f7a8b"),
      "00403000", java.util.List.of("vc8form:seq(nY,nX);ev=0123456789;bh=40-00aa11bb;dh=0badf00d", "vc8form:width(b,int);ev=0123456789;bh=40-00aa11bb;dh=0badf00d"),
      "00405000", java.util.List.of("vc8form:join(a);ev=0123456789;bh=12-01020304;dh=01020304"));
    java.util.Map<String, java.util.Set<String>> callers = java.util.Map.of("00401000", java.util.Set.of("00403000", "00404000"));
    java.util.Map<String, String> text = new java.util.HashMap<>();
    for (String a : names.keySet()) text.put(a, "void " + names.get(a) + "(void) { }");
    java.util.Set<String> fset = new java.util.TreeSet<>(java.util.List.of("00401000", "00402000", "00405000", "00406000"));
    java.util.Set<String> vproto = new java.util.TreeSet<>(java.util.List.of("00401000"));
    java.util.function.Function<String, java.util.List<String>> vtags = a -> tags.getOrDefault(a, java.util.List.of());
    java.util.function.Function<String, java.util.Set<String>> vcallers = a -> callers.getOrDefault(a, java.util.Set.of());
    java.util.function.Function<String, String> vtext = a -> text.get(a).replaceAll("\\s+", " ").trim();
    java.util.function.Function<String, String> vname = names::get;
    /*WATCH*/
    for (String a : args) { if (a.startsWith("ws:")) text.put(a.substring(3), text.get(a.substring(3)).replace(" { }", "\n{\n}\n")); else text.put(a, text.get(a) + " /* changed */"); }
    /*CHECK*/
  }
}
