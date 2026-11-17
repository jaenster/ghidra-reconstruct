package ghidra.program.model.lang;

import ghidra.program.model.address.Address;

/** Stub: the x86 general registers by family and size; ESI and EDI have no byte part. */
public class Language {
  public Register getRegister(Address a, int size) {
    String f = a.family;
    boolean abcd = f.matches("[ABCD]");
    if (size == 4) return new Register("E" + (abcd ? f + "X" : f));
    if (size == 2) return new Register(abcd ? f + "X" : f);
    if (size == 1 && abcd) return new Register(f + "L");
    return null;
  }
}
