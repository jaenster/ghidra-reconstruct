import { it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMPARE_SETTER_JAVA, COMPARE_SITES_SCRIPT, COMPARE_USE_JAVA, compareSiteRows } from './compare-sites.js';
import { FUNCTION_FACTS_SCRIPT } from './function-facts.js';

it('uses the exact flags-setter helper in both extraction paths', () => {
  for (const script of [COMPARE_SITES_SCRIPT, FUNCTION_FACTS_SCRIPT]) {
    assert.ok(script.includes(COMPARE_SETTER_JAVA));
    assert.equal(script.match(/compareSetter\.find\(user, L, rm, passive\)/g)?.length, 1);
  }
});

// Exercise the exact script helper. Only the Ghidra package qualifiers are removed so
// that its listing/reference interfaces can be supplied by these small Java stubs.
const helper = COMPARE_SETTER_JAVA.replace(/ghidra\.program\.model\.(?:listing|symbol)\./g, '');
const harness = `
import java.util.*;
public class CompareSetterHarness {
  static class Address {
    final int n;
    Address(int n) { this.n = n; }
    public boolean equals(Object o) { return o instanceof Address && ((Address)o).n == n; }
    public int hashCode() { return n; }
  }
  static class Instruction {
    final Address address; final String mnemonic; Address fallThrough;
    Instruction(int n, String m) { address = new Address(n); mnemonic = m; fallThrough = new Address(n+4); }
    Address getAddress() { return address; }
    Address getFallThrough() { return fallThrough; }
    String getMnemonicString() { return mnemonic; }
    FlowType getFlowType() { return new FlowType(mnemonic); }
  }
  static class FlowType {
    final String name; FlowType(String name) { this.name=name; }
    boolean isConditional() { return Arrays.asList("JL", "JLE", "JNE", "JGE").contains(name); }
    boolean isJump() { return isConditional() || name.equals("JMP"); }
  }
  static class Listing {
    final List<Instruction> items = new ArrayList<Instruction>();
    Listing(String... ms) {
      for (int i=0; i<ms.length; i++) {
        Instruction ins = new Instruction(100+4*i, ms[i]);
        if (ms[i].equals("JMP")) ins.fallThrough = null;
        items.add(ins);
      }
    }
    Instruction getInstructionBefore(Address a) {
      int i=(a.n-100)/4; return i>0 && i<items.size() ? items.get(i-1) : null;
    }
    Instruction last() { return items.get(items.size()-1); }
  }
  static class ReferenceType { final boolean flow; ReferenceType(boolean f) { flow=f; } boolean isFlow() { return flow; } }
  static class Reference { final ReferenceType type; Reference(boolean flow) { type=new ReferenceType(flow); } ReferenceType getReferenceType() { return type; } }
  static class ReferenceManager {
    final Map<Address,Reference[]> refs = new HashMap<Address,Reference[]>();
    Reference[] getReferencesTo(Address a) { Reference[] r=refs.get(a); return r==null ? new Reference[0] : r; }
    ReferenceManager at(Instruction i, boolean flow) { refs.put(i.address, new Reference[]{new Reference(flow)}); return this; }
  }
  static void expect(Instruction actual, Instruction wanted, String label) {
    if (actual != wanted) throw new AssertionError(label);
  }
  public static void main(String[] args) {
    ${helper}
    Set<String> passive = new HashSet<String>(Arrays.asList("MOV", "LEA", "PUSH", "POP", "MOVZX", "MOVSX", "NOP"));
    Listing a = new Listing("CMP", "JL", "JLE");
    expect(compareSetter.find(a.last(), a, new ReferenceManager(), passive), a.items.get(0), "00664b39 CMP feeds both JL and JLE");
    Listing b = new Listing("TEST", "JNE", "MOV", "JGE");
    expect(compareSetter.find(b.last(), b, new ReferenceManager(), passive), b.items.get(0), "neutral instruction after first branch");
    expect(compareSetter.find(a.last(), a, new ReferenceManager().at(a.last(), true), passive), null, "another flow enters the last branch");
    expect(compareSetter.find(a.last(), a, new ReferenceManager().at(a.items.get(1), true), passive), null, "another flow enters the first branch");
    expect(compareSetter.find(a.last(), a, new ReferenceManager().at(a.items.get(1), false), passive), a.items.get(0), "a data reference does not enter control flow");
    for (String clobber : new String[]{"ADD", "CALL", "JMP", "SETL"}) {
      Listing c = new Listing("CMP", clobber, "JLE");
      expect(compareSetter.find(c.last(), c, new ReferenceManager(), passive), null, "stops at "+clobber);
    }
    Listing gap = new Listing("CMP", "MOV", "JLE"); gap.items.get(1).fallThrough = null;
    expect(compareSetter.find(gap.last(), gap, new ReferenceManager(), passive), null, "no contiguous fall-through");
    Listing limit = new Listing("CMP", "MOV", "MOV", "MOV", "MOV", "MOV", "MOV", "MOV", "MOV", "MOV", "JLE");
    expect(compareSetter.find(limit.last(), limit, new ReferenceManager(), passive), null, "bounded walk");
    System.out.println("11 cases passed");
  }
}
`;

it('finds a shared flags setter without crossing another entry or a clobber', { skip: spawnSync('javac', ['-version']).status !== 0 && 'no javac on PATH' }, () => {
  assert.ok(COMPARE_SITES_SCRIPT.includes(COMPARE_SETTER_JAVA));
  const dir = mkdtempSync(join(tmpdir(), 'compare-setter-'));
  try {
    writeFileSync(join(dir, 'CompareSetterHarness.java'), harness);
    const compile = spawnSync('javac', ['-nowarn', '-d', dir, join(dir, 'CompareSetterHarness.java')], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync('java', ['-cp', dir, 'CompareSetterHarness'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), '11 cases passed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('uses the exact flags-use helper in both extraction paths', () => {
  for (const script of [COMPARE_SITES_SCRIPT, FUNCTION_FACTS_SCRIPT]) {
    assert.ok(script.includes(COMPARE_USE_JAVA));
    assert.equal(script.match(/compareUse\.of\(op, compareUse\.branches\(op\), L, passive\)/g)?.length, 1);
  }
});

// The listings are the VC8 compiles of the source forms the column tells apart.
const useHelper = COMPARE_USE_JAVA.replace(/ghidra\.program\.model\.(?:listing|pcode|address)\./g, '');
const useHarness = `
import java.util.*;
public class CompareUseHarness {
  static class Address {
    final int n;
    Address(int n) { this.n = n; }
    public boolean equals(Object o) { return o instanceof Address && ((Address)o).n == n; }
    public int hashCode() { return n; }
  }
  static class FlowType {
    final String m; FlowType(String m) { this.m = m; }
    boolean isConditional() { return m.startsWith("J") && !m.equals("JMP"); }
    boolean isJump() { return m.startsWith("J"); }
    boolean isCall() { return m.equals("CALL"); }
    boolean isTerminal() { return m.equals("RET"); }
  }
  static class Instruction {
    final Address address; final String mnemonic; Address target;
    Instruction(int n, String m) { address = new Address(n); mnemonic = m; }
    Address getAddress() { return address; }
    String getMnemonicString() { return mnemonic; }
    Address getFallThrough() { return mnemonic.equals("JMP") || mnemonic.equals("RET") ? null : new Address(address.n + 1); }
    Address[] getFlows() { return target == null ? new Address[0] : new Address[]{target}; }
    FlowType getFlowType() { return new FlowType(mnemonic); }
  }
  static class Listing {
    final List<Instruction> items = new ArrayList<Instruction>();
    // "MNEMONIC" or "MNEMONIC>index": a jump to the instruction at that index.
    Listing(String... ms) {
      for (int i = 0; i < ms.length; i++) {
        String[] p = ms[i].split(">");
        Instruction ins = new Instruction(i, p[0]);
        if (p.length > 1) ins.target = new Address(Integer.parseInt(p[1]));
        items.add(ins);
      }
    }
    Instruction getInstructionAt(Address a) { return a.n >= 0 && a.n < items.size() ? items.get(a.n) : null; }
  }
  static class SequenceNumber { final Address t; SequenceNumber(Address t) { this.t = t; } Address getTarget() { return t; } }
  static class Varnode {
    final List<PcodeOp> uses = new ArrayList<PcodeOp>();
    Iterator<PcodeOp> getDescendants() { return uses.iterator(); }
  }
  static class PcodeOp {
    static final int CBRANCH = 1, BOOL_NEGATE = 2, BOOL_AND = 3, BOOL_OR = 4, COPY = 5, INT_ZEXT = 6, MULTIEQUAL = 7, INT_EQUAL = 8;
    final Address at; final String mnemonic; final int opcode; final Varnode out = new Varnode();
    PcodeOp(int n) { this(n, "INT_EQUAL", INT_EQUAL); }
    PcodeOp(int n, String m) { this(n, m, INT_EQUAL); }
    PcodeOp(int n, String m, int opcode) { at = new Address(n); mnemonic = m; this.opcode = opcode; }
    SequenceNumber getSeqnum() { return new SequenceNumber(at); }
    String getMnemonic() { return mnemonic; }
    int getOpcode() { return opcode; }
    Varnode getOutput() { return opcode == CBRANCH ? null : out; }
    PcodeOp then(PcodeOp d) { out.uses.add(d); return d; }
  }
  static int n = 0;
  static void expect(String actual, String wanted, String label) {
    if (!actual.equals(wanted)) throw new AssertionError(label + ": " + actual);
    n++;
  }
  public static void main(String[] args) {
    ${useHelper}
    Set<String> passive = new HashSet<String>(Arrays.asList("MOV", "LEA", "PUSH", "POP", "MOVZX", "MOVSX", "NOP"));
    // return a == 5: xor eax, eax; cmp; sete al
    expect(compareUse.of(new PcodeOp(1), false, new Listing("XOR", "CMP", "SETZ", "POP", "RET"), passive), "v\\ts\\t-\\t0", "setcc");
    // unsigned a < b: mov; cmp; sbb eax, eax
    expect(compareUse.of(new PcodeOp(1, "INT_LESS"), false, new Listing("MOV", "CMP", "SBB", "NEG", "RET"), passive), "v\\tc\\t-\\t0", "sbb");
    // !x: neg eax; sbb eax, eax; add eax, 1 (the op is x == 0 on NEG's carry)
    expect(compareUse.of(new PcodeOp(0), false, new Listing("NEG", "SBB", "ADD", "RET"), passive), "v\\tc\\t-\\t0", "neg sbb");
    expect(compareUse.of(new PcodeOp(0), true, new Listing("NEG", "JC>3", "MOV", "RET"), passive), "b\\tj\\tt\\t1", "neg jump");
    // r = 0; if (a == 5) r = 1; return r;
    expect(compareUse.of(new PcodeOp(1), false, new Listing("XOR", "CMP", "JNZ>4", "MOV", "POP", "RET"), passive), "v\\tj\\tt\\t1", "one arm");
    // the jump read where the op sits on it
    expect(compareUse.of(new PcodeOp(2), true, new Listing("XOR", "CMP", "JNZ>4", "MOV", "POP", "RET"), passive), "b\\tj\\tt\\t1", "op on the jump");
    // b = false; if (a == 0x13) b = true; ... joined: cmp; jmp L ... L: jnz (the bool threaded away)
    expect(compareUse.of(new PcodeOp(0), false, new Listing("CMP", "JMP>3", "CMP", "JNZ>6", "MOV", "RET", "RET"), passive), "v\\tj\\tr\\t1", "through a jmp");
    // if (a == 5) f(1); else f(0); cross-jumped: cmp; jnz L; push 1; jmp M; L: push 0; M: call
    expect(compareUse.of(new PcodeOp(0), false, new Listing("CMP", "JNZ>4", "PUSH", "JMP>5", "PUSH", "CALL"), passive), "v\\tj\\td\\t1", "two arms");
    // the op on a non-setter, a clobber before the reader, a jmp first
    expect(compareUse.of(new PcodeOp(0), false, new Listing("MOV", "CMP", "SETZ"), passive), "v\\t-\\t-\\t0", "no setter");
    expect(compareUse.of(new PcodeOp(0), false, new Listing("CMP", "ADD", "JNZ>4", "MOV", "RET"), passive), "v\\t-\\t-\\t0", "clobber");
    expect(compareUse.of(new PcodeOp(0), false, new Listing("JMP>1", "SETZ"), passive), "v\\t-\\t-\\t0", "jmp is no setter");
    // a fall-through that calls before it rejoins has no arm
    expect(compareUse.of(new PcodeOp(0), true, new Listing("TEST", "JZ>4", "PUSH", "CALL", "RET"), passive), "b\\tj\\t-\\t0", "call in the arm");
    // an inlined strcmp: one CMP, its JNZ reads Z, the SBB at the target reads the C of \`<\`
    expect(compareUse.of(new PcodeOp(0, "INT_LESS"), false, new Listing("CMP", "JNZ>3", "XOR", "SBB"), passive), "v\\t-\\t-\\t0", "reader of other flags");
    expect(compareUse.of(new PcodeOp(1, "INT_SLESS"), false, new Listing("XOR", "CMP", "JGE>4", "MOV", "RET"), passive), "v\\tj\\tt\\t1", "signed jump");
    expect(compareUse.of(new PcodeOp(1, "INT_LESS"), false, new Listing("XOR", "CMP", "SETZ"), passive), "v\\t-\\t-\\t0", "setcc of other flags");
    // the decompiler's side: a branch condition through && reaches the CBRANCH; a joined value does not
    PcodeOp cond = new PcodeOp(0);
    cond.then(new PcodeOp(0, "BOOL_AND", PcodeOp.BOOL_AND)).then(new PcodeOp(0, "CBRANCH", PcodeOp.CBRANCH));
    if (!compareUse.branches(cond)) throw new AssertionError("through &&");
    PcodeOp joined = new PcodeOp(0);
    joined.then(new PcodeOp(0, "MULTIEQUAL", PcodeOp.MULTIEQUAL)).then(new PcodeOp(0, "CBRANCH", PcodeOp.CBRANCH));
    if (compareUse.branches(joined)) throw new AssertionError("through a join");
    n += 2;
    System.out.println(n + " cases passed");
  }
}
`;

it('classifies how the compiled code reads a comparison\'s flags', { skip: spawnSync('javac', ['-version']).status !== 0 && 'no javac on PATH' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'compare-use-'));
  try {
    writeFileSync(join(dir, 'CompareUseHarness.java'), useHarness);
    const compile = spawnSync('javac', ['-nowarn', '-d', dir, join(dir, 'CompareUseHarness.java')], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync('java', ['-cp', dir, 'CompareUseHarness'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), '17 cases passed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('parses the flags-use columns and leaves rows of an older script without them', () => {
  const base = ['0', '==', 'INT_EQUAL', '4', '1', '5', 'v:n', 'c:5', '00400000', '00400004', 'JNZ', '00400000', 'CMP', '4', 'm', 'i', '5', '1'];
  const [withUse] = compareSiteRows([...base, 'v', 'j', 't', '1'].join('\t'));
  assert.deepStrictEqual([withUse.pos, withUse.use, withUse.arm, withUse.armLength], ['v', 'j', 't', 1]);
  const [old] = compareSiteRows(base.join('\t'));
  assert.equal(old.pos, undefined);
  assert.equal(old.use, undefined);
});
