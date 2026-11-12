/**
 * Runs the set_prototype branch of a rendered proposal script against the stub Ghidra classes.
 * The test splices the rendered text over the markers. args: signature, then the function's
 * current parameters as type:name@REG.
 */
public class Harness {
  public static void main(String[] args) {
    ghidra.program.model.listing.Program currentProgram = new ghidra.program.model.listing.Program();
    ghidra.program.model.symbol.SourceType U = ghidra.program.model.symbol.SourceType.USER_DEFINED;
    java.util.function.Function<String, ghidra.program.model.data.DataType> type = s -> s.trim().equals("void") ? new ghidra.program.model.data.VoidDataType()
      : new ghidra.program.model.data.DataType(s.trim(), s.trim().endsWith("*") ? 4 : s.trim().equals("char") ? 1 : s.trim().equals("short") ? 2 : 4);
    ghidra.program.model.listing.Parameter[] cur = new ghidra.program.model.listing.Parameter[args.length - 1];
    for (int i = 1; i < args.length; i++) { String[] tn = args[i].split("[:@]");
      cur[i - 1] = new ghidra.program.model.listing.ParameterImpl(tn[1], type.apply(tn[0]), new ghidra.program.model.listing.VariableStorage(currentProgram, currentProgram.getRegister(tn[2])), currentProgram, U); }
    ghidra.program.model.listing.Function fn = new ghidra.program.model.listing.Function(true, "__fastcall", cur);
    java.util.function.Function<String, ghidra.program.model.listing.Function> fnAt = a -> fn;
    /*NCONV*/
    /*PSIG*/
    java.util.Map<String, String> o = new java.util.HashMap<>(); o.put("address", "0x00401000"); o.put("signature", args[0]);
    java.util.function.BiFunction<java.util.Map<String, String>, String, String> js = (m, k) -> m.get(k);
    String op = "set_prototype";
    if (op.isEmpty()) { }
    /*SET_PROTOTYPE*/
  }
}
