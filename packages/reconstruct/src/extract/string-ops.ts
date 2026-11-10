/**
 * The REP STOS/MOVS instructions of a function, with the registers they start from.
 *
 * VC8 compiles a constant-size zero fill of an array (`for (i = 0; i < 100; i++) a[i] = 0;`)
 * to `xor eax, eax; mov ecx, K; lea edi, [a]; rep stosd`, and a constant-size `memcpy` to
 * `mov ecx, K; rep movsd`. The decompiler prints either as the string instruction's own
 * loop over a pointer:
 *
 *   p = a;  for (n = K; n != 0; n = n + -1) { p[0] = 0; p[1] = 0; p = p + 2; }
 *
 * which VC8 compiles back to a pointer loop. The `rep-string-form` pass writes the loop as
 * the source the instructions came from, and only where this fact says the loop IS one
 * string instruction:
 *
 *   at      the instruction's offset from the function entry
 *   op      `stos` or `movs`
 *   unit    bytes per iteration: 4 (D), 2 (W), 1 (B)
 *   ecx     the immediate `mov ecx, K` set in the same block before it; absent otherwise
 *   eax     for STOS, the value EAX holds from the same block (`xor eax, eax`, `mov eax, imm`,
 *           `or eax, -1`); absent otherwise
 *   names   the variables the decompile prints on the instruction's p-code (the counter and
 *           the pointers): the tie to the printed loop
 *
 * The walk back stops at a block entry, a non-fallthrough instruction or a call, so a value
 * is only reported where nothing between can have changed it.
 *
 * Read-only: execute_script, no transaction. A failure leaves the field unset, which is also
 * what an older snapshot looks like; the pass then changes nothing.
 */

import type { GhidraConnection, ExtractedFunction } from '../types.js';

export interface StringOp {
  at: number;
  op: 'stos' | 'movs';
  unit: 1 | 2 | 4;
  ecx?: number;
  eax?: number;
  names: string[];
}

export type StringOpFacts = StringOp[];

/**
 * Java fragment, run per function inside a script that has `prog`, `fn`, `L` (the listing),
 * `rm` (the reference manager), `toks` (the flattened markup) and `base` (the entry offset)
 * in scope. Leaves the row in `rrow`: `at,mnemonic,ecx,eax,name|name;...`.
 */
export const STRING_OPS_JAVA = `
          StringBuilder rrow = new StringBuilder();
          {
            ghidra.program.model.lang.Register rEcx = prog.getRegister("ECX"), rEax = prog.getRegister("EAX");
            ghidra.program.model.listing.InstructionIterator rit = L.getInstructions(fn.getBody(), true);
            while (rit.hasNext()) {
              ghidra.program.model.listing.Instruction ri = rit.next();
              String rmn = ri.getMnemonicString();
              if (!(rmn.startsWith("STOS") || rmn.startsWith("MOVS")) || !rmn.contains(".REP")) continue;
              String ecx = "-", eax = "-";
              boolean needEcx = true, needEax = rmn.startsWith("STOS");
              ghidra.program.model.listing.Instruction q = ri;
              for (int s = 0; s < 32 && (needEcx || needEax); s++) {
                boolean entered = false;
                for (ghidra.program.model.symbol.Reference rf : rm.getReferencesTo(q.getAddress())) if (rf.getReferenceType().isFlow()) entered = true;
                if (entered) break;
                ghidra.program.model.listing.Instruction p = L.getInstructionBefore(q.getAddress());
                if (p == null || p.getFallThrough() == null || !p.getFallThrough().equals(q.getAddress()) || !p.getFlowType().isFallthrough()) break;
                boolean wEcx = false, wEax = false;
                for (Object ro : p.getResultObjects()) {
                  if (!(ro instanceof ghidra.program.model.lang.Register)) continue;
                  ghidra.program.model.lang.Register g = (ghidra.program.model.lang.Register) ro;
                  if (g.contains(rEcx) || rEcx.contains(g)) wEcx = true;
                  if (g.contains(rEax) || rEax.contains(g)) wEax = true;
                }
                String pm = p.getMnemonicString();
                ghidra.program.model.lang.Register p0 = p.getNumOperands() > 0 ? p.getRegister(0) : null;
                ghidra.program.model.scalar.Scalar p1 = p.getNumOperands() > 1 ? p.getScalar(1) : null;
                if (needEcx && wEcx) {
                  needEcx = false;
                  if (pm.equals("MOV") && rEcx.equals(p0) && p1 != null) ecx = Long.toHexString(p1.getUnsignedValue() & 0xffffffffL);
                }
                if (needEax && wEax) {
                  needEax = false;
                  if (rEax.equals(p0)) {
                    if ((pm.equals("XOR") || pm.equals("SUB")) && rEax.equals(p.getRegister(1))) eax = "0";
                    else if (pm.equals("MOV") && p1 != null) eax = Long.toHexString(p1.getUnsignedValue() & 0xffffffffL);
                    else if (pm.equals("OR") && p1 != null && p1.getSignedValue() == -1) eax = "ffffffff";
                  }
                }
                q = p;
              }
              java.util.LinkedHashSet<String> names = new java.util.LinkedHashSet<>();
              for (ghidra.app.decompiler.ClangNode n : toks) {
                if (!(n instanceof ghidra.app.decompiler.ClangVariableToken)) continue;
                ghidra.program.model.address.Address ta = n.getMinAddress();
                String tt = ((ghidra.app.decompiler.ClangVariableToken) n).getText();
                if (ta != null && ta.equals(ri.getAddress()) && tt != null && tt.matches("[A-Za-z_][A-Za-z0-9_]*")) names.add(tt);
              }
              rrow.append(rrow.length() > 0 ? ";" : "").append(Long.toHexString(ri.getAddress().getOffset() - base)).append(',')
                .append(rmn).append(',').append(ecx).append(',').append(eax).append(',').append(String.join("|", names));
            }
          }
`;

/** Java, no imports. `__ITEMS__` is `;`-separated function entries. */
export const STRING_OPS_SCRIPT = `
final ghidra.program.model.listing.Program prog = currentProgram;
ghidra.app.decompiler.DecompInterface di = new ghidra.app.decompiler.DecompInterface();
ghidra.app.decompiler.DecompileOptions o = new ghidra.app.decompiler.DecompileOptions();
o.setConventionPrint(true); o.setNoCastPrint(false);
o.setPRECommentIncluded(true); o.setPLATECommentIncluded(true); o.setPOSTCommentIncluded(true);
o.setEOLCommentIncluded(true); o.setWARNCommentIncluded(true); o.setHeadCommentIncluded(true);
o.setEliminateUnreachable(false);
try {
  java.lang.reflect.Field nf = ghidra.app.decompiler.DecompileOptions.class.getDeclaredField("namespaceStrategy");
  nf.setAccessible(true);
  nf.set(o, ghidra.app.decompiler.DecompileOptions.NamespaceStrategy.All);
} catch (Exception e) { }
di.setOptions(o);
di.openProgram(prog);
ghidra.program.model.listing.Listing L = prog.getListing();
ghidra.program.model.symbol.ReferenceManager rm = prog.getReferenceManager();
ghidra.program.model.listing.FunctionManager fm = prog.getFunctionManager();
StringBuilder sb = new StringBuilder();
for (String a : "__ITEMS__".split(";")) {
  if (a.length() == 0) continue;
  try {
    ghidra.program.model.listing.Function fn = fm.getFunctionAt(prog.getAddressFactory().getAddress(a));
    if (fn == null) continue;
    ghidra.app.decompiler.DecompileResults r = di.decompileFunction(fn, 60, monitor);
    if (r == null || r.getCCodeMarkup() == null) continue;
    java.util.List<ghidra.app.decompiler.ClangNode> toks = new java.util.ArrayList<>();
    r.getCCodeMarkup().flatten(toks);
    long base = fn.getEntryPoint().getOffset();
${STRING_OPS_JAVA}
    if (rrow.length() > 0) sb.append("R\\t").append(a).append('\\t').append(rrow).append('\\n');
  } catch (Exception e) { }
}
di.dispose();
println(sb.toString());
`;

const REP_LOOP = /for \((\w+) = [^;]+; \1 != 0; \1 = \1 \+ -1\)/;

/** Whether a decompile prints a string instruction's counted loop: the functions read. */
export function printsRepLoop(decompiled: string): boolean {
  return REP_LOOP.test(decompiled);
}

const UNIT: Record<string, 1 | 2 | 4> = { B: 1, W: 2, D: 4 };

/** One function's row (`at,mnemonic,ecx,eax,names;...`), parsed; malformed items are dropped. */
export function parseStringOpRow(row: string): StringOpFacts {
  const out: StringOpFacts = [];
  for (const item of row.split(';')) {
    const c = item.split(',');
    if (c.length !== 5) continue;
    const m = /^(STOS|MOVS)([BWD])\.REP$/.exec(c[1]);
    if (!m || !/^[0-9a-f]+$/i.test(c[0])) continue;
    const hex = (s: string) => (/^[0-9a-f]+$/i.test(s) ? Number.parseInt(s, 16) : undefined);
    const op: StringOp = {
      at: Number.parseInt(c[0], 16),
      op: m[1] === 'STOS' ? 'stos' : 'movs',
      unit: UNIT[m[2]],
      names: c[4] ? c[4].split('|') : [],
    };
    const ecx = hex(c[2]), eax = hex(c[3]);
    if (ecx !== undefined) op.ecx = ecx;
    if (eax !== undefined) op.eax = eax;
    out.push(op);
  }
  return out;
}

/** The standalone script's output: function entry -> its string ops. */
export function parseStringOps(output: string): Map<string, StringOpFacts> {
  const out = new Map<string, StringOpFacts>();
  for (const raw of output.split('\n')) {
    const c = raw.replace(/\r$/, '').split('\t');
    if (c[0] !== 'R' || c.length < 3) continue;
    const ops = parseStringOpRow(c[2]);
    if (ops.length > 0) out.set(normalize(c[1]), ops);
  }
  return out;
}

function normalize(a: string): string {
  return a.replace(/^0x/i, '').toLowerCase().padStart(8, '0');
}

/** Run the standalone script over every function that prints a counted loop. */
export async function extractStringOps(connection: GhidraConnection, functions: ExtractedFunction[], batchSize = 200): Promise<number> {
  const byAddr = new Map<string, ExtractedFunction>();
  for (const f of functions) if (f.decompiled && printsRepLoop(f.decompiled)) byAddr.set(normalize(f.address), f);
  const items = [...byAddr.keys()];
  let n = 0;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const result = await connection.sendCommand<{ success?: boolean; output?: string; error?: string }>(
      'execute_script',
      { language: 'java', readOnly: true, code: STRING_OPS_SCRIPT.replace('__ITEMS__', batch.join(';')), scriptTimeout: 900, _commandTimeout: 960000 },
    );
    if (result.success === false || typeof result.output !== 'string') throw new Error(result.error ?? 'no output');
    for (const [fn, ops] of parseStringOps(result.output)) {
      const f = byAddr.get(fn);
      if (f) { f.stringOps = ops; n++; }
    }
  }
  return n;
}
