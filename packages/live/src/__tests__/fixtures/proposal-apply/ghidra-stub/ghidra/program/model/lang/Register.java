package ghidra.program.model.lang;

/** Stub: a register with the name and byte size Ghidra's x86 language gives it. */
public class Register {
  public final String name; public final int size;
  public Register(String name) { this.name = name; this.size = name.matches("[ABCD]L|[ABCD]H") ? 1 : name.length() == 2 ? 2 : 4; }
  public String toString() { return name; }
}
