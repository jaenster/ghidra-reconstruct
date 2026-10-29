/**
 * Where each line of a function's decompile lies in the binary.
 *
 * VC8 lays an `if` out by its source shape: the arm the source wrote first comes first (an
 * `||` condition puts the else first), and a leaving then-arm outside a loop sits inline.
 * The decompiler does not order arms by address, and the generator's own guard flattening
 * reorders them again, so the shape we print can contradict the original's layout while
 * meaning the same thing. The `branch-layout` pass reads the original order from here:
 *
 *   lines   decompile line -> the code offsets (from the function entry) of the p-code ops
 *           its tokens print, comments excluded
 *   ifs     decompile line of an `if` keyword -> the offset of its conditional branch
 *           (the keyword token carries the CBRANCH's address)
 *
 * Lines are numbered as `DecompilerUtils.toLines` numbers them, which is the line order of
 * the decompile text the snapshot holds, provided the decompiler runs with the options the
 * daemon's batch_decompile uses (DecompilerPool.configureDecompileOptions, copied below).
 * `lineCount` lets the consumer reject a text from another version or with other options.
 *
 * Read-only: one execute_script per batch, no transaction. A failure leaves the field unset,
 * which is also what an older snapshot looks like; the pass then changes nothing.
 */

import type { GhidraConnection, ExtractedFunction } from '../types.js';

export interface BranchLayoutFacts {
  /** Number of lines the decompiler printed (the decompile text has the same count). */
  lineCount: number;
  /** [line, offsets] for every line that prints code, offsets ascending. */
  lines: [number, number[]][];
  /** [line, conditional-branch offset] per `if` keyword. */
  ifs: [number, number][];
}

/**
 * Java, no imports. `__ITEMS__` is `;`-separated function entries. The functions are
 * decompiled on a small thread pool, one decompiler per thread.
 */
export const BRANCH_LAYOUT_SCRIPT = `
String items = "__ITEMS__";
final ghidra.program.model.listing.Program prog = currentProgram;
final java.util.List<String> todo = new java.util.ArrayList<>();
for (String a : items.split(";")) if (a.length() > 0) todo.add(a);
final java.util.concurrent.ConcurrentLinkedQueue<String> queue = new java.util.concurrent.ConcurrentLinkedQueue<>(todo);
final java.util.concurrent.ConcurrentHashMap<String, String> rows = new java.util.concurrent.ConcurrentHashMap<>();
final ghidra.util.task.TaskMonitor mon = monitor;
int nThreads = Math.max(1, Math.min(__THREADS__, todo.size()));
java.util.List<Thread> threads = new java.util.ArrayList<>();
for (int ti = 0; ti < nThreads; ti++) {
  Thread th = new Thread(() -> {
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
    try {
      String a;
      while ((a = queue.poll()) != null) {
        try {
          ghidra.program.model.listing.Function fn = prog.getFunctionManager().getFunctionAt(prog.getAddressFactory().getAddress(a));
          if (fn == null || fn.isThunk() || fn.isExternal()) continue;
          ghidra.app.decompiler.DecompileResults r = di.decompileFunction(fn, __TIMEOUT__, mon);
          if (r == null || r.getCCodeMarkup() == null) continue;
          long base = fn.getEntryPoint().getOffset();
          StringBuilder ls = new StringBuilder(), is = new StringBuilder();
          int count = 0;
          for (ghidra.app.decompiler.ClangLine l : ghidra.app.decompiler.component.DecompilerUtils.toLines(r.getCCodeMarkup())) {
            count++;
            java.util.TreeSet<Long> offs = new java.util.TreeSet<>();
            for (ghidra.app.decompiler.ClangToken t : l.getAllTokens()) {
              if (t instanceof ghidra.app.decompiler.ClangCommentToken) continue;
              ghidra.program.model.address.Address x = t.getMinAddress();
              if (x == null) continue;
              long off = x.getOffset() - base;
              offs.add(off);
              if (t.getText().equals("if")) {
                is.append(is.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':').append(off < 0 ? "-" + Long.toHexString(-off) : Long.toHexString(off));
              }
            }
            if (offs.isEmpty()) continue;
            ls.append(ls.length() > 0 ? ";" : "").append(l.getLineNumber()).append(':');
            boolean first = true;
            for (Long off : offs) {
              if (!first) ls.append(',');
              ls.append(off < 0 ? "-" + Long.toHexString(-off) : Long.toHexString(off));
              first = false;
            }
          }
          rows.put(a, a + "\\t" + count + "\\t" + ls + "\\t" + is);
        } catch (Exception e) { }
      }
    } finally {
      di.dispose();
    }
  });
  th.start();
  threads.add(th);
}
for (Thread th : threads) th.join();
StringBuilder sb = new StringBuilder();
for (String a : todo) { String r = rows.get(a); if (r != null) sb.append(r).append('\\n'); }
println(sb.toString());
`;

/** The script for one batch of function entries. */
export function branchLayoutScript(batch: string[], threads = 8, timeout = 60): string {
  return BRANCH_LAYOUT_SCRIPT
    .replace('__ITEMS__', batch.join(';'))
    .replace('__THREADS__', String(threads))
    .replace('__TIMEOUT__', String(timeout));
}

/** Entries of every decompiled function that prints an `if`, in batches. */
export function branchLayoutBatches(functions: Pick<ExtractedFunction, 'address' | 'decompiled'>[], batchSize = 400): string[][] {
  const items: string[] = [];
  for (const f of functions) {
    if (f.decompiled && /\bif\s*\(/.test(f.decompiled)) items.push(normalize(f.address));
  }
  const out: string[][] = [];
  for (let i = 0; i < items.length; i += batchSize) out.push(items.slice(i, i + batchSize));
  return out;
}

function offset(s: string): number {
  return s.startsWith('-') ? -parseInt(s.slice(1), 16) : parseInt(s, 16);
}

/** Parse the script's rows: function entry -> facts. */
export function parseBranchLayout(output: string): Map<string, BranchLayoutFacts> {
  const out = new Map<string, BranchLayoutFacts>();
  for (const line of output.split('\n')) {
    const c = line.replace(/\r$/, '').split('\t');
    if (c.length < 4 || !/^[0-9a-fA-F]{8}$/.test(c[0])) continue;
    const lineCount = Number(c[1]);
    if (!Number.isInteger(lineCount)) continue;
    const lines: [number, number[]][] = [];
    for (const part of c[2] ? c[2].split(';') : []) {
      const i = part.indexOf(':');
      lines.push([Number(part.slice(0, i)), part.slice(i + 1).split(',').map(offset)]);
    }
    const ifs: [number, number][] = [];
    for (const part of c[3] ? c[3].split(';') : []) {
      const i = part.indexOf(':');
      ifs.push([Number(part.slice(0, i)), offset(part.slice(i + 1))]);
    }
    out.set(normalize(c[0]), { lineCount, lines, ifs });
  }
  return out;
}

function normalize(a: string): string {
  return a.replace(/^0x/i, '').toLowerCase().padStart(8, '0');
}

/** Run the script over every decompiled function that has an `if` and attach `branchLayout`. */
export async function extractBranchLayout(connection: GhidraConnection, functions: ExtractedFunction[]): Promise<number> {
  let n = 0;
  const byAddr = new Map(functions.map(f => [normalize(f.address), f]));
  for (const batch of branchLayoutBatches(functions)) {
    const result = await connection.sendCommand<{ success?: boolean; output?: string; error?: string }>(
      'execute_script',
      { language: 'java', code: branchLayoutScript(batch), scriptTimeout: 600, _commandTimeout: 660000 }
    );
    if (result.success === false || typeof result.output !== 'string') throw new Error(result.error ?? 'no output');
    for (const [fn, facts] of parseBranchLayout(result.output)) {
      const f = byAddr.get(fn);
      if (!f) continue;
      f.branchLayout = facts;
      n++;
    }
  }
  return n;
}
