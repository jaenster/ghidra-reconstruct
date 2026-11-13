package ghidra.program.model.data;

/** Stub: a named type of a fixed byte length. */
public class DataType {
  public final String name; final int len;
  public DataType(String name, int len) { this.name = name; this.len = len; }
  public int getLength() { return len; }
  public String toString() { return name; }
}
