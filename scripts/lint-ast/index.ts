/**
 * AST defect lint - runs the real transform pipeline, then checks the tree the emitter sees.
 *
 *   npx tsx scripts/lint-ast/index.ts [--limit N] [--check ID] [--json out.json] [--details]
 *
 * Replaces the regex suite in docs/tools/lint.py. Input is the extraction snapshot the
 * generator writes, so no Ghidra server round-trip is needed and this is safe to run while
 * a regen holds the session.
 *
 * Findings are reported against the TRANSFORMED AST, not the parsed one, because the
 * transformed tree is what becomes C++ - a defect the pipeline repairs is not a defect, and
 * a defect the pipeline introduces must show up here.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeKind } from '../../packages/cpp-parser/src/ast/kinds.js';
import type { ASTNode, FunctionDecl } from '../../packages/cpp-parser/src/ast/nodes.js';
import { findNodesByKind } from '../../packages/cpp-parser/src/ast/visitor.js';
import { parse } from '../../packages/cpp-parser/src/parser/index.js';
import { preprocessGhidraCode } from '../../packages/cpp-parser/src/ghidra.js';
import { defaultRegistry } from '../../packages/cpp-parser/src/transform/plugins/registry.js';
import { ALL_CHECKS, type Finding } from './checks.js';

const SNAPSHOT = join(
  process.env.HOME!,
  'code/ts/ghidra-reconstruct/project/.ghidra-mcp/codegen-snapshot/functions.ndjson',
);

function main() {
  const argv = process.argv.slice(2);
  const opt = (flag: string) => argv.find(a => a.startsWith(flag))?.split('=')[1];
  const limit = Number(opt('--limit') ?? 0);
  const only = opt('--check');
  const jsonOut = opt('--json');
  const details = argv.includes('--details');

  const checks = ALL_CHECKS.filter(c => !only || c.id === only);
  if (!checks.length) {
    console.error(`no such check: ${only}`);
    console.error(`available: ${ALL_CHECKS.map(c => c.id).join(', ')}`);
    process.exit(2);
  }

  const pipeline = defaultRegistry.createPipeline({ preset: 'full' } as any);
  const findings: Finding[] = [];
  let scanned = 0, parseFailed = 0, pipelineFailed = 0;

  for (const line of readFileSync(SNAPSHOT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    if (limit && scanned >= limit) break;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    const code: string = rec.decompiled || '';
    if (!code.trim()) continue;
    scanned++;

    let ast: ASTNode;
    try { ast = parse(preprocessGhidraCode(code)); }
    catch { parseFailed++; continue; }

    let out: any;
    try { out = pipeline.execute(ast as any, {} as any); }
    catch { pipelineFailed++; continue; }

    const fns = (findNodesByKind(out.ast, NodeKind.FunctionDecl) as FunctionDecl[])
      .filter(f => (f as any).body);
    if (!fns.length) continue;

    const ctx = { addr: String(rec.address), fnName: String(rec.name ?? '?') };
    for (const c of checks) {
      try { findings.push(...c.run(fns[0], ctx)); } catch { /* one bad tree is not fatal */ }
    }
  }

  console.log(`scanned ${scanned} functions  parse-failed ${parseFailed}  pipeline-failed ${pipelineFailed}`);
  console.log('');
  console.log('check                       found  what');
  for (const c of checks) {
    const n = findings.filter(f => f.check === c.id).length;
    console.log(`${c.id.padEnd(26)} ${String(n).padStart(6)}  ${c.blurb}`);
  }

  if (details) {
    for (const c of checks) {
      const rows = findings.filter(f => f.check === c.id);
      if (!rows.length) continue;
      console.log(`\n--- ${c.id} (${rows.length}) ---`);
      for (const r of rows.slice(0, 40)) {
        console.log(`  ${r.addr}  ${r.fn}  ${r.detail}`);
      }
      if (rows.length > 40) console.log(`  ... ${rows.length - 40} more`);
    }
  }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(findings, null, 2));
    console.log(`\nwrote ${jsonOut}`);
  }
}

main();
