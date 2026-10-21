/**
 * How control enters each label of a function's decompile, read from the instructions.
 *
 * The goto structurer's copy policy (copy-policy.ts, rule E6) may copy a short tail back to
 * each jump site only with evidence that MSVC cross-jumped it, and part of that evidence is
 * in the binary, not the pseudo-C: whether a jump into the label comes from a HIGHER address
 * (the tail was laid out before one of its sites - A1), and whether the label's first
 * instruction consumes something each site set up separately (a Jcc reading flags, a CALL
 * reading arguments pushed just before each jump - A3). Extraction records, per label:
 *
 *   address     the label's address
 *   fallIn      the instruction before it falls through into it
 *   back        flow references from higher addresses
 *   condFwd     conditional flow references from lower addresses
 *   uncondFwd   unconditional flow references from lower addresses
 *   computed    computed references (switch tables)
 *   first       the mnemonic of the label's first instruction
 *   pushedArgs  every way in (fallthrough and each jump) is preceded by a PUSH
 *   symbol      the name Ghidra gives the label's address, where the decompile could not
 *               print it: a JOINED block is always printed `joined_r0x<addr>`, so a name
 *               put there (`case_TIME` @00429e3b in zlib's inflate) never reaches the
 *               pseudo-C. The name is read at the label's address, or at the start of the
 *               basic block holding it (the case's own first instruction, 00429e38).
 *
 * Read-only: one execute_script per batch, no transaction. A failure leaves the field unset,
 * which is also what an older snapshot looks like; the policy then has no A1/A3 evidence.
 * The same script fills a frozen snapshot copy for replays (scripts/label-flow.ts).
 */

import type { GhidraConnection, ExtractedFunction, LabelFlow } from '../types.js';

/** Labels a decompile defines: `NAME:` alone on a line (case labels and `default:` excluded). */
export function labelsOf(decompiled: string): string[] {
  const out = new Set<string>();
  const re = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*):[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(decompiled))) {
    if (m[1] === 'default' || m[1] === 'public' || m[1] === 'private' || m[1] === 'protected') continue;
    out.add(m[1]);
  }
  return [...out];
}

/**
 * The script body (Java, runs inside GhidraScript.run()); `__ITEMS__` is replaced by
 * `fnAddr:label;...`. A label resolves to a symbol of that name inside the function's body
 * (a `switchD_X_caseD_N` label to symbol `caseD_N` in namespace `switchD_X`); failing that,
 * `LAB_<addr>`, `joined_r0x<addr>` and `code_r0x<addr>` carry their address in the name.
 */
export const LABEL_FLOW_SCRIPT = `
String items = "__ITEMS__";
boolean compact = __COMPACT__;
int idx = -1;
ghidra.program.model.listing.Listing L = currentProgram.getListing();
ghidra.program.model.symbol.SymbolTable st = currentProgram.getSymbolTable();
ghidra.program.model.symbol.ReferenceManager rm = currentProgram.getReferenceManager();
StringBuilder sb = new StringBuilder();
for (String it : items.split(";")) {
  if (it.length() == 0) continue;
  idx++;
  String[] a = it.split(":");
  ghidra.program.model.listing.Function f = getFunctionAt(toAddr(a[0]));
  ghidra.program.model.address.Address A = null;
  String nm = a[1]; String ns = null;
  int k = nm.indexOf("_caseD_");
  if (nm.startsWith("switchD_") && k > 0) { ns = nm.substring(0, k); nm = nm.substring(k + 1); }
  if (f != null) {
    for (ghidra.program.model.symbol.Symbol s : st.getSymbols(nm)) {
      if (f.getBody().contains(s.getAddress()) && (ns == null || s.getParentNamespace().getName().equals(ns))) A = s.getAddress();
    }
  }
  if (A == null) {
    String n = a[1]; int r = n.lastIndexOf("r0x");
    try {
      if (n.startsWith("LAB_")) A = toAddr(n.substring(4));
      else if (r >= 0) A = toAddr(n.substring(r + 3));
    } catch (Exception e) { A = null; }
  }
  if (A == null) { sb.append(compact ? String.valueOf(idx) : it).append("\\tnull\\n"); continue; }
  ghidra.program.model.listing.Instruction at = L.getInstructionAt(A);
  ghidra.program.model.listing.Instruction p = L.getInstructionBefore(A);
  boolean fall = p != null && p.getFallThrough() != null && p.getFallThrough().equals(A);
  boolean pushed = !fall || p.getMnemonicString().equals("PUSH");
  int back = 0, cf = 0, uf = 0, comp = 0;
  for (ghidra.program.model.symbol.Reference r : rm.getReferencesTo(A)) {
    ghidra.program.model.symbol.RefType t = r.getReferenceType();
    if (!t.isFlow() || t.isCall()) continue;
    if (t.isComputed()) { comp++; pushed = false; continue; }
    if (r.getFromAddress().compareTo(A) > 0) back++; else if (t.isConditional()) cf++; else uf++;
    ghidra.program.model.listing.Instruction q = L.getInstructionBefore(r.getFromAddress());
    if (q == null || !q.getMnemonicString().equals("PUSH")) pushed = false;
  }
  String as = A.toString();
  String sym = "-";
  if (f != null && (a[1].startsWith("joined_r0x") || a[1].startsWith("code_r0x"))) {
    ghidra.program.model.symbol.Symbol ps = st.getPrimarySymbol(A);
    if (ps == null || ps.getSource() == ghidra.program.model.symbol.SourceType.DEFAULT) {
      ghidra.program.model.block.CodeBlock cb = new ghidra.program.model.block.BasicBlockModel(currentProgram).getFirstCodeBlockContaining(A, monitor);
      ps = cb == null ? null : st.getPrimarySymbol(cb.getFirstStartAddress());
    }
    if (ps != null && ps.getSource() != ghidra.program.model.symbol.SourceType.DEFAULT
        && ps.getSymbolType() == ghidra.program.model.symbol.SymbolType.LABEL
        && f.getBody().contains(ps.getAddress()) && ps.getName().matches("[A-Za-z_][A-Za-z0-9_]*")) sym = ps.getName();
  }
  sb.append(compact ? String.valueOf(idx) : it).append('\\t').append(compact && a[1].endsWith(as) ? "=" : as).append('\\t').append(fall ? 1 : 0).append('\\t').append(back)
    .append('\\t').append(cf).append('\\t').append(uf).append('\\t').append(comp)
    .append('\\t').append(at == null ? "-" : at.getMnemonicString()).append('\\t').append(pushed ? 1 : 0)
    .append('\\t').append(sym).append('\\n');
}
println(sb.toString());
`;

/** `fnAddr:label` items for every label of every decompiled function, in batches. */
export function labelFlowItems(functions: Pick<ExtractedFunction, 'address' | 'decompiled'>[], batchSize = 600): string[][] {
  const items: string[] = [];
  for (const f of functions) {
    if (!f.decompiled) continue;
    for (const l of labelsOf(f.decompiled)) items.push(`${normalize(f.address)}:${l}`);
  }
  const out: string[][] = [];
  for (let i = 0; i < items.length; i += batchSize) out.push(items.slice(i, i + batchSize));
  return out;
}

/** The script for one batch. */
export function labelFlowScript(batch: string[], compact = false): string {
  return LABEL_FLOW_SCRIPT.replace('__ITEMS__', batch.join(';')).replace('__COMPACT__', String(compact));
}

/**
 * Parse the script's rows: function address -> label -> flow. A compact run (rows keyed by
 * the item's index in `batch`, `=` for an address the label's name already spells) needs
 * the batch it ran on.
 */
export function parseLabelFlow(output: string, batch?: string[]): Map<string, Record<string, LabelFlow>> {
  const out = new Map<string, Record<string, LabelFlow>>();
  for (const line of output.split('\n')) {
    const c = line.trim().split('\t');
    if (c.length < 9) continue;
    let [item, address] = c;
    const [, , fall, back, cf, uf, comp, first, pushed, symbol] = c;
    if (batch && /^\d+$/.test(item)) item = batch[Number(item)];
    if (!item) continue;
    if (address === '=') address = item.slice(item.length - 8);
    const i = item.indexOf(':');
    if (i < 0) continue;
    const fn = normalize(item.slice(0, i)), label = item.slice(i + 1);
    let rec = out.get(fn);
    if (!rec) { rec = {}; out.set(fn, rec); }
    rec[label] = {
      address: normalize(address), fallIn: fall === '1', back: Number(back), condFwd: Number(cf),
      uncondFwd: Number(uf), computed: Number(comp), first, pushedArgs: pushed === '1',
      ...(symbol && symbol !== '-' ? { symbol } : {}),
    };
  }
  return out;
}

function normalize(a: string): string {
  return a.replace(/^0x/i, '').toLowerCase().padStart(8, '0');
}

/** Run the script over every decompiled function and attach `labelFlow`. */
export async function extractLabelFlow(connection: GhidraConnection, functions: ExtractedFunction[]): Promise<number> {
  let n = 0;
  const byAddr = new Map(functions.map(f => [normalize(f.address), f]));
  for (const batch of labelFlowItems(functions)) {
    const result = await connection.sendCommand<{ success?: boolean; output?: string; error?: string }>(
      'execute_script',
      { language: 'java', code: labelFlowScript(batch), scriptTimeout: 300, _commandTimeout: 360000 }
    );
    if (result.success === false || typeof result.output !== 'string') throw new Error(result.error ?? 'no output');
    for (const [fn, rec] of parseLabelFlow(result.output)) {
      const f = byAddr.get(fn);
      if (!f) continue;
      f.labelFlow = { ...(f.labelFlow ?? {}), ...rec };
      n += Object.keys(rec).length;
    }
  }
  return n;
}
