package ghidra.program.model.lang;

import ghidra.program.model.address.Address;

/** Stub: a register with the name and byte size Ghidra's x86 language gives it. */
public class Register {
  public final String name; public final int size;
  public Register(String name) { this.name = name; this.size = name.matches("[ABCD]L|[ABCD]H") ? 1 : name.length() == 2 ? 2 : 4; }
  /** EAX, AX, AL -> A; ESI, SI -> SI. */
  public Address getAddress() { String n = name.startsWith("E") && name.length() == 3 ? name.substring(1) : name; return new Address(n.matches("[ABCD][XLH]") ? n.substring(0, 1) : n); }
  public String toString() { return name; }
}
