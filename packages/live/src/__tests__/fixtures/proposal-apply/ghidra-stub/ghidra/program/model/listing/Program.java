package ghidra.program.model.listing;

import ghidra.program.model.lang.Register;

public class Program {
  public Register getRegister(String name) { return new Register(name); }
}
