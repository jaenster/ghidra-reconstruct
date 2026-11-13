package ghidra.program.model.listing;

import ghidra.program.model.lang.Register;

/** Stub: storage in one register, or unassigned. */
public class VariableStorage {
  public static final VariableStorage UNASSIGNED_STORAGE = new VariableStorage();
  final Register reg;
  private VariableStorage() { reg = null; }
  public VariableStorage(Program p, Register r) { reg = r; }
  public int size() { return reg == null ? 0 : reg.size; }
  public String toString() { return reg == null ? "<UNASSIGNED>" : reg.name; }
}
