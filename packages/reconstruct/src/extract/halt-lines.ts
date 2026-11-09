/**
 * The line number each way into a halt pushes, read from the instructions.
 *
 * Every Blizzard assertion compiles to `push LINE; call GetInstructionPointer; push eax;
 * push ""; call ERROR_UnrecoverableInternalError_Halt`. MSVC tail-merges the halts of one
 * function: each failing branch pushes its own line and jumps to one shared
 * `call GetInstructionPointer`, and the branches may reach it at different stack depths.
 * The decompiler reads the line at one depth for all of them, so a path that arrives one
 * slot higher or lower prints whatever sits there instead: a CALL's return address
 * (`nLine = 0x40a10d`), a parameter, another local. The `halt-site-fold` pass puts each
 * path's own line back from here:
 *
 *   halts   per halt CALL: its offset from the entry, the offset of the shared
 *           `call GetInstructionPointer`, and per way in (fallthrough or jump):
 *             line    the immediate the PUSH right before it pushes; null when the
 *                     instruction before is not `push imm`
 *             guard   the offset of the conditional branch that chooses this way: the Jcc
 *                     the PUSH falls out of, or the Jcc that jumps to the PUSH; null when
 *                     neither
 *             guards  every conditional branch that leads to the PUSH (jumps to it, and the
 *                     Jcc it falls out of even when something else enters it too)
 *   probeReturns  the return address of each CALL to `__alloca_probe` or `__SEH_prolog4`.
 *           The probe runs on the frame it is allocating, so the CALL's return address lands
 *           in the slot that becomes the frame's top local, and the decompiler prints that as
 *           a store of the constant into the local. The source never wrote it; the
 *           `probe-return-store` pass drops the store from here.
 *
 * Read-only: one execute_script per batch, no transaction, no decompile. A failure leaves
 * the field unset, which is also what an older snapshot looks like; the pass then changes
 * nothing.
 */

import type { GhidraConnection, ExtractedFunction } from '../types.js';

export interface HaltPath {
  /** The line this way pushes, or null when it is not a `push imm` right before. */
  line: number | null;
  /** Offset of the conditional branch that selects this way; null when there is none. */
  guard: number | null;
  /**
   * Every conditional branch that leads to this way's PUSH: the jumps to it and the Jcc it
   * falls out of, even when other ways enter it too. A superset of `guard`; absent in
   * snapshots read before it was recorded.
   */
  guards?: number[];
}

export interface HaltSite {
  /** The halt CALL's offset from the function entry. */
  at: number;
  /** The `call GetInstructionPointer` the ways join at. */
  ip: number;
  /** Every way into `ip`: the fallthrough first, then the jumps by address. */
  paths: HaltPath[];
}

export interface HaltLineFacts {
  halts: HaltSite[];
  /** Absolute return addresses of the stack-probe CALLs; absent when there are none. */
  probeReturns?: number[];
}

export const HALT_NAME = 'ERROR_UnrecoverableInternalError_Halt';
export const IP_NAME = 'GetInstructionPointer';
export const PROBE_NAMES = ['_chkstk', '_SEH_prolog4', '__alloca_probe', '__SEH_prolog4'];

/** Java, no imports. `__ITEMS__` is `;`-separated function entries. */
export const HALT_LINES_SCRIPT = `
String items = "__ITEMS__";
ghidra.program.model.listing.Listing L = currentProgram.getListing();
ghidra.program.model.symbol.ReferenceManager rm = currentProgram.getReferenceManager();
ghidra.program.model.listing.FunctionManager fm = currentProgram.getFunctionManager();
StringBuilder sb = new StringBuilder();
for (String a : items.split(";")) {
  if (a.length() == 0) continue;
  ghidra.program.model.listing.Function f = fm.getFunctionAt(toAddr(a));
  if (f == null) continue;
  long base = f.getEntryPoint().getOffset();
  StringBuilder row = new StringBuilder();
  StringBuilder probes = new StringBuilder();
  ghidra.program.model.listing.InstructionIterator it = L.getInstructions(f.getBody(), true);
  while (it.hasNext()) {
    ghidra.program.model.listing.Instruction hc = it.next();
    if (!hc.getFlowType().isCall() || hc.getFlows().length != 1) continue;
    ghidra.program.model.listing.Function hf = fm.getFunctionAt(hc.getFlows()[0]);
    if (hf != null && hf.isThunk()) hf = hf.getThunkedFunction(true);
    if (hf != null && (${PROBE_NAMES.map(n => `hf.getName().equals("${n}")`).join(' || ')}) && hc.getFallThrough() != null) {
      probes.append(probes.length() > 0 ? "," : "").append(Long.toHexString(hc.getFallThrough().getOffset()));
      continue;
    }
    if (hf == null || !hf.getName().equals("${HALT_NAME}")) continue;
    // call GetInstructionPointer; push eax; push <str>; call Halt
    ghidra.program.model.listing.Instruction ps = L.getInstructionBefore(hc.getAddress());
    ghidra.program.model.listing.Instruction pe = ps == null ? null : L.getInstructionBefore(ps.getAddress());
    ghidra.program.model.listing.Instruction g = pe == null ? null : L.getInstructionBefore(pe.getAddress());
    if (g == null || !ps.getMnemonicString().equals("PUSH") || !pe.getMnemonicString().equals("PUSH")
        || !g.getFlowType().isCall() || g.getFlows().length != 1) continue;
    ghidra.program.model.listing.Function gf = fm.getFunctionAt(g.getFlows()[0]);
    if (gf != null && gf.isThunk()) gf = gf.getThunkedFunction(true);
    if (gf == null || !gf.getName().equals("${IP_NAME}")) continue;
    java.util.List<ghidra.program.model.listing.Instruction> pushers = new java.util.ArrayList<>();
    ghidra.program.model.listing.Instruction fp = L.getInstructionBefore(g.getAddress());
    if (fp != null && f.getBody().contains(fp.getAddress()) && fp.getFallThrough() != null
        && fp.getFallThrough().equals(g.getAddress())) pushers.add(fp);
    else pushers.add(null);
    java.util.List<ghidra.program.model.address.Address> jumps = new java.util.ArrayList<>();
    for (ghidra.program.model.symbol.Reference r : rm.getReferencesTo(g.getAddress())) {
      if (!r.getReferenceType().isJump() || !f.getBody().contains(r.getFromAddress())) continue;
      jumps.add(r.getFromAddress());
    }
    java.util.Collections.sort(jumps);
    for (ghidra.program.model.address.Address ja : jumps) {
      ghidra.program.model.listing.Instruction j = L.getInstructionAt(ja);
      ghidra.program.model.listing.Instruction jp = j == null || j.getFlowType().isConditional() ? null : L.getInstructionBefore(ja);
      pushers.add(jp != null && jp.getFallThrough() != null && jp.getFallThrough().equals(ja) ? jp : null);
    }
    StringBuilder ways = new StringBuilder();
    for (ghidra.program.model.listing.Instruction p : pushers) {
      String line = "-", guard = "-";
      StringBuilder guards = new StringBuilder();
      if (p != null && p.getMnemonicString().equals("PUSH") && p.getNumOperands() == 1
          && p.getScalar(0) != null && p.getRegister(0) == null) {
        line = Long.toHexString(p.getScalar(0).getUnsignedValue());
        ghidra.program.model.listing.Instruction c = null;
        for (ghidra.program.model.symbol.Reference r : rm.getReferencesTo(p.getAddress())) {
          if (!r.getReferenceType().isConditional() || !f.getBody().contains(r.getFromAddress())) continue;
          c = c == null ? L.getInstructionAt(r.getFromAddress()) : null;
          if (c == null) break;
        }
        if (c == null) {
          ghidra.program.model.listing.Instruction b = L.getInstructionBefore(p.getAddress());
          boolean entered = false;
          for (ghidra.program.model.symbol.Reference r : rm.getReferencesTo(p.getAddress())) if (r.getReferenceType().isFlow()) entered = true;
          if (!entered && b != null && b.getFlowType().isConditional() && b.getFallThrough() != null
              && b.getFallThrough().equals(p.getAddress())) c = b;
        }
        if (c != null) guard = Long.toHexString(c.getAddress().getOffset() - base);
        // Every conditional branch that leads to this PUSH: the jumps to it and the Jcc it
        // falls out of, whether or not other ways enter it too.
        java.util.TreeSet<Long> gs = new java.util.TreeSet<>();
        for (ghidra.program.model.symbol.Reference r : rm.getReferencesTo(p.getAddress())) {
          if (r.getReferenceType().isConditional() && f.getBody().contains(r.getFromAddress())) gs.add(r.getFromAddress().getOffset() - base);
        }
        ghidra.program.model.listing.Instruction fb = L.getInstructionBefore(p.getAddress());
        if (fb != null && fb.getFlowType().isConditional() && fb.getFallThrough() != null
            && fb.getFallThrough().equals(p.getAddress()) && f.getBody().contains(fb.getAddress())) gs.add(fb.getAddress().getOffset() - base);
        for (Long x : gs) guards.append(guards.length() > 0 ? "+" : "").append(Long.toHexString(x));
      }
      ways.append(ways.length() > 0 ? "," : "").append(line).append('/').append(guard);
      if (guards.length() > 0) ways.append('/').append(guards);
    }
    row.append(row.length() > 0 ? ";" : "").append(Long.toHexString(hc.getAddress().getOffset() - base))
      .append(':').append(Long.toHexString(g.getAddress().getOffset() - base)).append(':').append(ways);
  }
  if (row.length() > 0 || probes.length() > 0) sb.append(a).append('\\t').append(row).append('\\t').append(probes).append('\\n');
}
println(sb.toString());
`;

/** The script for one batch of function entries. */
export function haltLinesScript(batch: string[]): string {
  return HALT_LINES_SCRIPT.replace('__ITEMS__', batch.join(';'));
}

/** A store of a code-sized constant: what a probe's return address prints as. */
const CODE_CONSTANT_STORE = /=\s*(?:\([^;()]*\)\s*)?0x[0-9a-fA-F]{6,8}\s*;/;

/** Whether a decompile prints a halt or a code-sized constant store: the functions the script reads. */
export function printsHaltOrProbe(decompiled: string): boolean {
  return decompiled.includes(HALT_NAME) || CODE_CONSTANT_STORE.test(decompiled);
}

/** Entries of every decompiled function that prints a halt or a code-sized constant store, in batches. */
export function haltLinesBatches(functions: Pick<ExtractedFunction, 'address' | 'decompiled'>[], batchSize = 800): string[][] {
  const items: string[] = [];
  for (const f of functions) {
    if (f.decompiled && printsHaltOrProbe(f.decompiled)) {
      items.push(normalize(f.address));
    }
  }
  const out: string[][] = [];
  for (let i = 0; i < items.length; i += batchSize) out.push(items.slice(i, i + batchSize));
  return out;
}

/** Parse the script's rows: function entry -> facts. */
export function parseHaltLines(output: string): Map<string, HaltLineFacts> {
  const out = new Map<string, HaltLineFacts>();
  const hex = (s: string): number | null => (s === '-' ? null : parseInt(s, 16));
  for (const raw of output.split('\n')) {
    const c = raw.replace(/\r$/, '').split('\t');
    if (c.length < 2 || !/^[0-9a-fA-F]{8}$/.test(c[0])) continue;
    const halts: HaltSite[] = [];
    for (const part of c[1] ? c[1].split(';') : []) {
      const [at, ip, ways] = part.split(':');
      if (at === undefined || ip === undefined || ways === undefined) continue;
      const paths = ways.split(',').map(w => {
        const [line, guard, guards] = w.split('/');
        const path: HaltPath = { line: hex(line ?? '-'), guard: hex(guard ?? '-') };
        const all = (guards ?? '').split('+').filter(x => /^[0-9a-fA-F]+$/.test(x)).map(x => parseInt(x, 16));
        if (all.length > 0) path.guards = all;
        return path;
      });
      halts.push({ at: parseInt(at, 16), ip: parseInt(ip, 16), paths });
    }
    const probeReturns = (c[2] ?? '').split(',').filter(x => /^[0-9a-fA-F]+$/.test(x)).map(x => parseInt(x, 16));
    if (halts.length > 0 || probeReturns.length > 0) {
      out.set(normalize(c[0]), probeReturns.length > 0 ? { halts, probeReturns } : { halts });
    }
  }
  return out;
}

function normalize(a: string): string {
  return a.replace(/^0x/i, '').toLowerCase().padStart(8, '0');
}

/** Run the script over every function that prints a halt and attach `haltLines`. */
export async function extractHaltLines(connection: GhidraConnection, functions: ExtractedFunction[]): Promise<number> {
  let n = 0;
  const byAddr = new Map(functions.map(f => [normalize(f.address), f]));
  for (const batch of haltLinesBatches(functions)) {
    const result = await connection.sendCommand<{ success?: boolean; output?: string; error?: string }>(
      'execute_script',
      { language: 'java', code: haltLinesScript(batch), scriptTimeout: 300, _commandTimeout: 360000 }
    );
    if (result.success === false || typeof result.output !== 'string') throw new Error(result.error ?? 'no output');
    for (const [fn, facts] of parseHaltLines(result.output)) {
      const f = byAddr.get(fn);
      if (!f) continue;
      f.haltLines = facts;
      n++;
    }
  }
  return n;
}
