package ghidra.program.model.listing;

import ghidra.program.model.data.DataType;
import ghidra.program.model.symbol.SourceType;

public class ParameterImpl implements Parameter {
  final String name; final DataType type; final VariableStorage vs;
  public ParameterImpl(String name, DataType type, VariableStorage vs, Program p, SourceType src) { this.name = name; this.type = type; this.vs = vs; }
  public String getName() { return name; }
  public VariableStorage getVariableStorage() { return vs; }
  public String toString() { return type + " " + name + "@" + vs; }
}
