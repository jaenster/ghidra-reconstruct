package ghidra.program.model.listing;

import ghidra.program.model.data.DataType;

public class ReturnParameterImpl {
  final DataType type; final VariableStorage vs;
  public ReturnParameterImpl(DataType type, VariableStorage vs, Program p) { this.type = type; this.vs = vs; }
  public ReturnParameterImpl(DataType type, Program p) { this(type, VariableStorage.UNASSIGNED_STORAGE, p); }
  public String toString() { return type + "@" + vs; }
}
