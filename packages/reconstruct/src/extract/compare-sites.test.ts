import { it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMPARE_SETTER_JAVA, COMPARE_SITES_SCRIPT } from './compare-sites.js';

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
