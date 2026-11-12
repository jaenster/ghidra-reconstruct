package ghidra.program.model.listing;

import ghidra.program.model.symbol.SourceType;
import java.util.List;

/** Stub: holds a parameter list and prints what updateFunction was given. */
public class Function {
  public enum FunctionUpdateType { CUSTOM_STORAGE, DYNAMIC_STORAGE_ALL_PARAMS }
  final boolean custom; final String conv; Parameter[] params;
  public Function(boolean custom, String conv, Parameter... params) { this.custom = custom; this.conv = conv; this.params = params; }
  public boolean hasCustomVariableStorage() { return custom; }
  public int getParameterCount() { return params.length; }
  public Parameter[] getParameters() { return params.clone(); }
  public Parameter getParameter(int i) { return params[i]; }
  public String getCallingConventionName() { return conv; }
  public void setVarArgs(boolean b) { System.out.println("varargs " + b); }
  public void updateFunction(String conv, ReturnParameterImpl ret, List<? extends Parameter> ps, FunctionUpdateType t, boolean force, SourceType src) {
    System.out.println("update " + conv + " " + t + " ret " + ret);
    for (Parameter p : ps) System.out.println("param " + p);
  }
}
