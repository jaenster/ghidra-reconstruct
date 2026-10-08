/**
 * Route the Zig port pilot's judged findings.
 *
 *   npx tsx scripts/port-findings.ts [--work ~/.cache/d2fn/work/port] [--verify ~/.cache/d2fn/verify]
 *       [--out ~/code/re/diablo2/docs/data/port-findings-worklist.tsv]
 *
 * Reads every <batch>/out.json (worker output) and <batch>/verdicts.json (the Opus verdicts),
 * keeps CONFIRMED and MISSED rows and sends each to one of three places:
 *
 *   generator  a defect class of the emitter - the lint rule that covers it, or "no rule yet"
 *   ghidra     a change for the single Ghidra writer - a worklist row
 *   oneoff     nothing to change in the pipeline (a justified cast, a bundle gap, an overstated severity)
 *
 * Read-only: nothing here writes to Ghidra. The output is a proposal list; the writer decides.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface Verdict { id: string; verdict: string; evidence: string; class: string }
interface Row {
  id: string; verdict: string; cls: string; route: 'generator' | 'ghidra' | 'oneoff';
  lint: string; addr: string; program: string; target: string; what: string; evidence: string;
}

function arg(flag: string, dflt: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const workDir = arg('--work', join(homedir(), '.cache/d2fn/work/port'));
const verifyDir = arg('--verify', join(homedir(), '.cache/d2fn/verify'));
const outPath = arg('--out', join(homedir(), 'code/re/diablo2/docs/data/port-findings-worklist.tsv'));

/** Phrases a verifier uses when the defect is in our emitted C and Ghidra already has the truth. */
const GENERATOR_SIGNAL = /not a Ghidra fix|generator-wide|our C (drops|omits|feeds|emits|writes|passes|never|has|declares)|our tree|the rebuild|emitted as|emits '/i;
const GHIDRA_CLASSES = new Set(['wrong-struct', 'wrong-signature', 'wrong-global-type', 'misleading-name', 'wrong-callconv-ghidra']);
const ONEOFF_CLASSES = new Set(['bundle-missing-part', 'clean', 'decls', 'shared-tail', 'cast-pointer-arith', 'cast-width-sign', 'cast-fnptr', 'needs-union']);

/** Which lint check covers a class, given what the verifier wrote. */
function lintRule(cls: string, ev: string): string {
  const e = ev.toLowerCase();
  if (cls === 'scalar-global-indexed-as-array' || cls === 'scalar-as-array') {
    return /sprintf|stack|local|frame/.test(e) ? 'scalar-local-cursor' : 'scalar-extent-passed,indexed-scalar-global';
  }
  if (cls === 'split-frame') return 'scalar-local-cursor,oob-local-access';
  if (cls === 'split-table') return /merged run/.test(e) ? 'no rule yet (merged run: a label-inside-extent check)' : 'adjacent-scalar-run';
  if (cls === 'wrong-callconv') {
    if (/thiscall|vtable|vftable|external|downloaded/.test(e)) return 'callback-convention-dropped,escaped-method-convention-dropped';
    if (/storage|register|ebx|edi|esi|ecx|edx/.test(e)) return 'no rule yet (register storage dropped on both sides)';
    return 'no rule yet';
  }
  if (cls === 'dropped-store' || cls === 'varargs-as-fixed' || cls === 'lost-register') {
    return /sCallbackArgs|callback/i.test(ev) ? 'partial-argument-block' : 'no rule yet (hidden register argument)';
  }
  if (/raw .*address|unrelocated|0x74c498/.test(e)) return 'raw-address-argument';
  if (cls === 'wrong-global-type') return 'no rule yet';
  if (cls === 'dropped-value') return 'no rule yet';
  if (cls === 'missing-call') return 'no rule yet';
  return '';
}

function whatToChange(cls: string, kind: string, src: any, v: Verdict): string {
  if (kind === 'names' && src) return `rename ${src.kind} ${src.current} -> ${src.proposed} (${src.prog})`;
  if (kind === 'mac_fixes' && src) return `mac ${src.kind}: ${String(src.value).slice(0, 160)}`;
  const t: Record<string, string> = {
    'wrong-struct': 'retype the struct / parameter the verifier names',
    'wrong-signature': 'fix the return or parameter type in the signature',
    'wrong-global-type': 'retype the global and its data extent',
    'scalar-global-indexed-as-array': 'create the data extent (array / blob) at the symbol',
    'scalar-as-array': 'type the frame object as a buffer, not a scalar',
    'split-frame': 'merge the split frame variables into one object',
    'split-table': 'merge or relabel the table run',
    'wrong-callconv': 'set the calling convention / register storage',
    'missing-call': 'extend the function body past the call Ghidra treats as noreturn',
    'misleading-name': 'rename (proposal only; the house naming rules apply)',
  };
  return t[cls] ?? `${cls}: see evidence`;
}

const rows: Row[] = [];
for (const batch of readdirSync(verifyDir).sort()) {
  const vp = join(verifyDir, batch, 'verdicts.json');
  const op = join(workDir, batch, 'out.json');
  if (!existsSync(vp) || !existsSync(op)) continue;
  const verdicts: Verdict[] = JSON.parse(readFileSync(vp, 'utf8'));
  const out = JSON.parse(readFileSync(op, 'utf8'));
  const byAddr = new Map<string, any>();
  for (const f of out.functions) byAddr.set(String(f.addr).replace(/^0x/, '').padStart(8, '0'), f);
  for (const v of verdicts) {
    if (v.verdict !== 'CONFIRMED' && v.verdict !== 'MISSED') continue;
    const [, rawAddr, kind, idx] = v.id.split('/');
    const addr = (rawAddr ?? '').replace(/^0x/, '').padStart(8, '0');
    const fn = byAddr.get(addr);
    const list = kind === 'findings' ? fn?.findings : kind === 'names' ? fn?.names : kind === 'mac_fixes' ? fn?.mac_fixes : null;
    const src = list?.[Number(idx)];
    const cls = v.class;
    const ev = v.evidence.replace(/\s+/g, ' ').trim();

    let route: Row['route'];
    if (kind === 'names' || kind === 'mac_fixes' || cls.startsWith('mac')) route = 'ghidra';
    // The verifier reads Ghidra's storage as right and the tree's plain declaration as the gap.
    else if (cls === 'wrong-callconv' && !/"unknown"/.test(ev)) route = 'generator';
    else if (ONEOFF_CLASSES.has(cls) && !/real (fix|layout defect)|should be/i.test(ev)) route = 'oneoff';
    else if (cls === 'missing-call') route = 'ghidra';
    else if (GENERATOR_SIGNAL.test(ev) && !GHIDRA_CLASSES.has(cls)) route = 'generator';
    else if (GHIDRA_CLASSES.has(cls) || cls === 'split-table' || cls === 'scalar-global-indexed-as-array' || cls === 'wrong-callconv') route = 'ghidra';
    else route = 'generator';
    // A severity the verifier called overstated, or a no-op, changes nothing.
    if (route !== 'ghidra' && /no (runtime|behaviour) (effect|change)|behaviour-neutral/i.test(ev) && !lintRule(cls, ev)) route = 'oneoff';

    const hex = /0x[0-9a-f]{6,8}\b|\b00[0-9a-f]{6}\b/i.exec(ev)?.[0] ?? '';
    const program = kind === 'mac_fixes' || (kind === 'names' && src?.prog === 'mac') || cls.startsWith('mac') ? 'mac' : 'win';
    rows.push({
      id: v.id, verdict: v.verdict, cls, route,
      lint: route === 'oneoff' ? '' : lintRule(cls, ev),
      addr: kind === 'mac_fixes' ? String(src?.mac_addr ?? addr) : addr,
      program, target: hex, what: whatToChange(cls, kind, src, v), evidence: ev,
    });
  }
}

// Settled by reading the asm (2026-10-08): not a verdict row, so it is added here.
rows.push({
  id: 'asm/00408a60/halt-body', verdict: 'CONFIRMED', cls: 'missing-call', route: 'ghidra', lint: '',
  addr: '00408a60', program: 'win', target: '00408a82',
  what: 'extend ERROR_UnrecoverableInternalError_Halt past 00408a7c to 00408a8c (ADD ESP,0x14; POP EBP; JMP 0040f960); same for _AssertionFailure 00408a30 (to 00408a5c)',
  evidence: 'Halt returns: FOG_ErrorHandler ends in RET (00408a28) and so does ExitOrCrashCleanup (0040f95e); the callers\' _exit(-1) is reachable. Ghidra stops the body at the CALL (33 bytes) and shows the tail as a LES.',
});

const esc = (s: string) => s.replace(/[\t\n\r]+/g, ' ');
const header = ['addr', 'program', 'route', 'lint_rule', 'class', 'what_to_change', 'target', 'evidence', 'verdict_id', 'verdict'];
const tsv = [header.join('\t'), ...rows.map(r =>
  [r.addr, r.program, r.route, r.lint, r.cls, r.what, r.target, r.evidence, r.id, r.verdict].map(esc).join('\t'))].join('\n') + '\n';
writeFileSync(outPath, tsv);

// Summary: per class, rows by route and the lint coverage.
const byClass = new Map<string, { n: number; gen: number; gh: number; one: number; lint: Set<string> }>();
for (const r of rows) {
  const c = byClass.get(r.cls) ?? { n: 0, gen: 0, gh: 0, one: 0, lint: new Set<string>() };
  c.n++;
  if (r.route === 'generator') c.gen++; else if (r.route === 'ghidra') c.gh++; else c.one++;
  if (r.lint) c.lint.add(r.lint);
  byClass.set(r.cls, c);
}
console.log(`${rows.length} rows (${rows.filter(r => r.verdict === 'CONFIRMED').length} confirmed, ${rows.filter(r => r.verdict === 'MISSED').length} missed) -> ${outPath}`);
console.log('route totals: ' + ['generator', 'ghidra', 'oneoff'].map(k => `${k} ${rows.filter(r => r.route === k).length}`).join(', '));
console.log('|class|rows|generator|ghidra|one-off|lint rule|\n|-|-|-|-|-|-|');
for (const [cls, c] of [...byClass].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`|${cls}|${c.n}|${c.gen}|${c.gh}|${c.one}|${[...c.lint].join('; ') || '-'}|`);
}
