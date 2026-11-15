import java.util.*;

/** Small Ghidra API adapter. The two extraction fragments are inserted unchanged by the test. */
public class ZeroRegisterHarness {
  static final class Register {
    final String name;
    final int bits;
    final Register base;
    Register(String name, int bits, Register base) { this.name = name; this.bits = bits; this.base = base; }
    String getName() { return name; }
    int getBitLength() { return bits; }
    Register getBaseRegister() { return base == null ? this : base; }
  }
  static final Register EAX = new Register("EAX", 32, null), ESI = new Register("ESI", 32, null),
    EDI = new Register("EDI", 32, null), ESP = new Register("ESP", 32, null),
    AX = new Register("AX", 16, EAX), SI = new Register("SI", 16, ESI),
    AL = new Register("AL", 8, EAX), RAX = new Register("RAX", 64, null),
    R8D = new Register("R8D", 32, null);
  record Address(long value) { long getOffset() { return value; } }
  record Scalar(long value) { long getValue() { return value; } long getSignedValue() { return value; } }
  record Memory(Register register) {}
  static final class OperandType {
    static boolean isScalar(int type) { return type == 1; }
    static boolean isRegister(int type) { return type == 2; }
  }
  record FlowType(boolean call, boolean jump, boolean terminal) {
    boolean isCall() { return call; } boolean isJump() { return jump; } boolean isTerminal() { return terminal; }
    boolean isFlow() { return call || jump || terminal; }
  }
  record Reference(FlowType type) { FlowType getReferenceType() { return type; } }
  static final FlowType NORMAL = new FlowType(false, false, false), CALL = new FlowType(true, false, false),
    JUMP = new FlowType(false, true, false), TERMINAL = new FlowType(false, false, true);
  static final class Instruction {
    final String mnemonic;
    final Object[] operands, results;
    Address address, fall;
    FlowType flow = NORMAL;
    Instruction(String mnemonic, Object[] operands, Object... results) {
      this.mnemonic = mnemonic; this.operands = operands; this.results = results;
    }
    String getMnemonicString() { return mnemonic; }
    int getNumOperands() { return operands.length; }
    Object[] getResultObjects() { return results; }
    Address getAddress() { return address; }
    Address getFallThrough() { return fall; }
    FlowType getFlowType() { return flow; }
    // Return the address register for a memory operand too: operand-kind guards must reject it.
    Register getRegister(int n) { return operands[n] instanceof Register r ? r : operands[n] instanceof Memory m ? m.register : null; }
    int getOperandType(int n) { return operands[n] instanceof Scalar ? 1 : operands[n] instanceof Register ? 2 : 3; }
    Scalar getScalar(int n) { return operands[n] instanceof Scalar s ? s : null; }
  }
  static Instruction write(String m, Register dst, Object src) { return new Instruction(m, new Object[] {dst, src}, dst); }
  static Instruction unary(String m, Register dst) { return new Instruction(m, new Object[] {dst}, dst); }
  static Instruction nop() { return new Instruction("NOP", new Object[] {}); }
  static Instruction zero() { return write("XOR", ESI, ESI); }
  static Instruction sub() { return write("SUB", EAX, ESI); }
  static final class Listing {
    final TreeMap<Long, Instruction> instructions = new TreeMap<>();
    Instruction getInstructionBefore(Address at) { var e = instructions.lowerEntry(at.value); return e == null ? null : e.getValue(); }
  }
  static final class ReferenceManager {
    final Map<Long, List<Reference>> refs = new HashMap<>();
    Iterable<Reference> getReferencesTo(Address at) { return refs.getOrDefault(at.value, List.of()); }
  }
  static final class Program {
    final Listing listing = new Listing();
    final ReferenceManager references = new ReferenceManager();
    Listing getListing() { return listing; } ReferenceManager getReferenceManager() { return references; }
    Program(Instruction... instructions) {
      long at = 0;
      for (Instruction in : instructions) {
        in.address = new Address(at); in.fall = new Address(++at); listing.instructions.put(in.address.value, in);
      }
    }
    Program ref(int index, FlowType type) { references.refs.put((long) index, List.of(new Reference(type))); return this; }
    Instruction last() { return listing.instructions.lastEntry().getValue(); }
  }
  record Body(long start, long end) { boolean contains(Address at) { return at.value >= start && at.value < end; } }
  record Function(Body body, Address entry) {
    Function(Body body) { this(body, new Address(body.start)); }
    Body getBody() { return body; } Address getEntryPoint() { return entry; }
  }
  static String delta(Program prog, Function fn, Instruction in) {
    /* ZERO_REGISTER_TEST_JAVA */
    String m = in.getMnemonicString(), d = "-";
    /* EQUALITY_TEST_DELTA_JAVA */
    return d;
  }
  static final LinkedHashMap<String, String> results = new LinkedHashMap<>();
  static void check(String name, String expected, Program prog) { check(name, expected, prog, new Function(new Body(0, 1000))); }
  static void check(String name, String expected, Program prog, Function fn) {
    String got = delta(prog, fn, prog.last());
    if (!expected.equals(got)) throw new AssertionError(name + ": expected " + expected + ", got " + got);
    results.put(name, got);
  }
  public static void main(String[] args) {
    check("xor", "0", new Program(zero(), sub()));
    check("sub-self", "0", new Program(write("SUB", ESI, ESI), sub()));
    check("mov-zero", "0", new Program(write("MOV", ESI, new Scalar(0)), sub()));
    check("add-zero", "0", new Program(zero(), write("ADD", EAX, ESI)));
    check("neutral-instructions", "0", new Program(zero(), nop(), write("MOV", EDI, new Scalar(9)), sub()));
    check("flow-into-zero", "0", new Program(zero(), sub()).ref(0, JUMP));
    check("data-reference", "0", new Program(zero(), nop(), sub()).ref(1, NORMAL));
    check("nonzero", "-", new Program(write("MOV", ESI, new Scalar(1)), sub()));
    check("unknown-copy", "-", new Program(write("MOV", ESI, EDI), sub()));
    check("unknown-memory", "-", new Program(write("MOV", ESI, new Memory(EDI)), sub()));
    check("partial-clobber", "-", new Program(zero(), write("MOV", SI, new Scalar(1)), sub()));
    check("partial-zero", "-", new Program(write("XOR", SI, SI), sub()));
    check("mismatched-xor", "-", new Program(write("XOR", ESI, EDI), sub()));
    check("full-clobber", "-", new Program(zero(), write("INC", ESI, ESI), sub()));
    check("implicit-clobber", "-", new Program(zero(), new Instruction("OTHER", new Object[] {}, ESI), sub()));
    check("exchange-clobber", "-", new Program(zero(), new Instruction("XCHG", new Object[] {EDI, ESI}, EDI, ESI), sub()));
    for (var entry : Map.of("call", CALL, "jump", JUMP, "terminal", TERMINAL).entrySet()) {
      Instruction barrier = nop(); barrier.flow = entry.getValue();
      check(entry.getKey(), "-", new Program(zero(), barrier, sub()));
    }
    Program gap = new Program(zero(), sub()); gap.listing.instructions.firstEntry().getValue().fall = new Address(7);
    check("gap", "-", gap);
    Program noFall = new Program(zero(), sub()); noFall.listing.instructions.firstEntry().getValue().fall = null;
    check("no-fallthrough", "-", noFall);
    check("flow-into-test", "-", new Program(zero(), sub()).ref(1, JUMP));
    check("flow-into-middle", "-", new Program(zero(), nop(), sub()).ref(1, JUMP));
    check("outside-body", "-", new Program(zero(), sub()), new Function(new Body(1, 10)));
    check("entry-inside-body", "-", new Program(zero(), sub()), new Function(new Body(0, 10), new Address(1)));
    check("no-definition", "-", new Program(nop(), sub()));
    check("no-predecessor", "-", new Program(sub()));
    for (int n : new int[] {15, 16}) {
      List<Instruction> run = new ArrayList<>(); run.add(zero());
      for (int i = 1; i < n; i++) run.add(nop()); run.add(sub());
      check("window-" + n, "0", new Program(run.toArray(Instruction[]::new)));
    }
    List<Instruction> far = new ArrayList<>(); far.add(zero());
    for (int i = 0; i < 16; i++) far.add(nop()); far.add(sub());
    check("outside-window", "-", new Program(far.toArray(Instruction[]::new)));
    check("stack-register", "-", new Program(write("XOR", ESP, ESP), write("SUB", EAX, ESP)));
    check("64-bit-register", "-", new Program(write("XOR", RAX, RAX), write("SUB", EAX, RAX)));
    check("other-architecture-register", "-", new Program(write("XOR", R8D, R8D), write("SUB", EAX, R8D)));
    check("16-bit-source", "-", new Program(zero(), write("SUB", EAX, SI)));
    check("8-bit-source", "-", new Program(write("XOR", EAX, EAX), write("SUB", EDI, AL)));
    check("16-bit-destination", "-", new Program(zero(), write("SUB", AX, ESI)));
    check("memory-source", "-", new Program(zero(), write("SUB", EAX, new Memory(ESI))));
    check("memory-destination", "-", new Program(zero(), new Instruction("SUB", new Object[] {new Memory(EAX), ESI})));
    check("immediate-sub", "7", new Program(write("SUB", EAX, new Scalar(7))));
    check("immediate-add", "-7", new Program(write("ADD", EAX, new Scalar(7))));
    check("signed-immediate-sub", "-2", new Program(write("SUB", EAX, new Scalar(-2))));
    check("signed-immediate-add", "2", new Program(write("ADD", EAX, new Scalar(-2))));
    check("dec", "1", new Program(unary("DEC", EAX)));
    check("inc", "-1", new Program(unary("INC", EAX)));
    check("unrelated-test", "-", new Program(zero(), write("CMP", EAX, ESI)));
    // 00493840: MOV EAX,[gnHireDisplayMode]; PUSH ESI; XOR ESI,ESI; SUB EAX,ESI.
    Program hireling = new Program(write("MOV", EAX, new Memory(null)), new Instruction("PUSH", new Object[] {ESI}, ESP), zero(), sub());
    long[] addresses = {0, 5, 6, 8}; int[] sizes = {5, 1, 2, 2};
    List<Instruction> nativePrefix = new ArrayList<>(hireling.listing.instructions.values()); hireling.listing.instructions.clear();
    for (int i = 0; i < nativePrefix.size(); i++) {
      Instruction in = nativePrefix.get(i); in.address = new Address(addresses[i]); in.fall = new Address(addresses[i] + sizes[i]);
      hireling.listing.instructions.put(addresses[i], in);
    }
    check("hireling-00493848", "0", hireling);
    System.out.print("{"); boolean first = true;
    for (var entry : results.entrySet()) {
      if (!first) System.out.print(","); first = false;
      System.out.print("\"" + entry.getKey() + "\":\"" + entry.getValue() + "\"");
    }
    System.out.println("}");
  }
}
