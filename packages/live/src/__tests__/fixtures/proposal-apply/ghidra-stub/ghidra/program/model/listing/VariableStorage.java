package ghidra.program.model.listing;

import ghidra.program.model.lang.Register;
import ghidra.util.exception.InvalidInputException;

/** Stub: storage in one register or one stack slot, or unassigned. */
public class VariableStorage {
  public static final VariableStorage UNASSIGNED_STORAGE = new VariableStorage();
  final Register reg; final Integer stack; final int len;
  private VariableStorage() { reg = null; stack = null; len = 0; }
  public VariableStorage(Program p, Register r) throws InvalidInputException { reg = r; stack = null; len = r.size; }
  public VariableStorage(Program p, int stackOffset, int size) throws InvalidInputException { reg = null; stack = stackOffset; len = size; }
  public int size() { return len; }
  public boolean isRegisterStorage() { return reg != null; }
  public boolean isStackStorage() { return stack != null; }
  public Register getRegister() { return reg; }
  public int getStackOffset() { return stack; }
  public String toString() { return reg != null ? reg.name : stack != null ? "Stack[0x" + Integer.toHexString(stack) + "]:" + len : "<UNASSIGNED>"; }
}
