/**
 * Unused locals: did Ghidra hand us one, or did a transform pass make it?
 *
 *   npx tsx scripts/unused-locals.ts [--limit N] [--pass NAME] [--json out.json]
 *
 * WHY THIS IS AN AST QUESTION AND NOT A TEXT ONE
 *
 * "Is this local ever READ" is a structural fact. Answering it by counting identifier
 * occurrences in source text gets it wrong in at least three ways, all of which a first
 * text-based attempt actually hit:
 *
 *   - `T x = expr;` is ONE textual mention but a declaration AND a use. `decl-init-merge`
 *     produces these constantly, so every merged declaration scored as a lost use.
 *   - A write is not a read. `x = 1;` with no subsequent read means the value is dead, but
 *     a mention count cannot tell a store from a load.
 *   - A warning has to be attributed to a function, and a text tool has to guess the span.
 *
 * The AST has none of those problems: a VariableDecl is a declaration, an Identifier in a
 * non-assignment-target position is a read, and a FunctionDecl already knows its own body.
 *
 * WHAT IT COMPARES
 *
 * For every function in the extraction snapshot, the raw Ghidra pseudo-C is parsed to an
 * AST, then the REAL pipeline (`defaultRegistry`, preset `full` - the same one the generator
 * runs) is executed over it with `trackSteps`, giving the AST after every pass.
 *
 *   carried     unread in Ghidra's AST and unread in ours. The decompiler produced a dead
 *               declaration and we faithfully carried it. Cosmetic.
 *
 *   introduced  READ in Ghidra's AST, unread in ours. A pass deleted the last read. Because
 *               every intermediate AST is kept, the pass that did it is named rather than
 *               guessed. This is the class that matters: a deleted read is a lost store, a
 *               lost call, or a lost branch, and nothing warns about it.
 *
 *   invented    declared in ours, not declared in Ghidra's. Usually legitimate -
 *               `phantom-local-synthesis` and `underscore-slot-local` exist because Ghidra
 *               emits identifiers it never declares - but one that is never read is worth
 *               a look.
 *
 * A pass that deliberately deletes code is still reported, because "deliberate" is a claim
 * about intent that the reader should check: `boilerplate-cleanup` removing the /GS stack
 * cookie is correct, and is separated out in the per-pass table so it cannot inflate the
 * interesting number.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeKind } from '../packages/cpp-parser/src/ast/kinds.js';
import type {
  ASTNode, FunctionDecl, VariableDecl, Identifier, AssignExpr,
} from '../packages/cpp-parser/src/ast/nodes.js';
import { findNodesByKind } from '../packages/cpp-parser/src/ast/visitor.js';
import { parse } from '../packages/cpp-parser/src/parser/index.js';
import { preprocessGhidraCode } from '../packages/cpp-parser/src/ghidra.js';
import { defaultRegistry } from '../packages/cpp-parser/src/transform/plugins/registry.js';

const SNAPSHOT = join(
  process.env.HOME!,
  'code/ts/ghidra-reconstruct/project/.ghidra-mcp/codegen-snapshot/functions.ndjson',
);

/**
 * A declarator's name, which is NOT the same shape before and after the pipeline.
 *
 * On the freshly parsed AST `VariableDecl.name` is a plain string. Somewhere in the 91
 * pipeline steps it is normalised into an `Identifier` NODE. Reading it as a string only
 * silently yields nothing on the transformed side, which makes every count come out zero -
 * so both shapes are handled here, in one place.
 */
function declName(d: any): string | null {
  const n = d?.name;
  if (typeof n === 'string') return n || null;
  if (n && typeof n === 'object' && typeof n.name === 'string') return n.name || null;
  return null;
}

/** Locals declared directly in a function body (not parameters). */
function declaredLocals(fn: ASTNode): Map<string, VariableDecl> {
  const out = new Map<string, VariableDecl>();
  for (const d of findNodesByKind(fn, NodeKind.VariableDecl) as VariableDecl[]) {
    const name = declName(d);
    if (name) out.set(name, d);
  }
  return out;
}

/**
 * Names READ in this subtree.
 *
 * Two kinds of Identifier are not reads and must be excluded, or everything looks used:
 *
 *   - the direct target of a plain assignment. `x = 1` writes x and reads nothing, while
 *     `x += 1`, `*x = 1` and `a[x] = 1` all genuinely read it.
 *   - a DECLARATOR's own name, once the pipeline has turned it into an Identifier node.
 *     Missing this makes every declaration count as a use of itself.
 *
 * An initializer is a read, which is what makes `T x = expr;` come out right.
 */
function readNames(node: ASTNode): Set<string> {
  const excluded = new Set<ASTNode>();

  for (const a of findNodesByKind(node, NodeKind.AssignExpr) as AssignExpr[]) {
    const op = (a as any).operator;
    const lhs = (a as any).left;
    if (lhs && lhs.kind === NodeKind.Identifier && (op === '=' || op === undefined)) {
      excluded.add(lhs);
    }
  }
  for (const d of findNodesByKind(node, NodeKind.VariableDecl) as any[]) {
    if (d?.name && typeof d.name === 'object' && d.name.kind === NodeKind.Identifier) {
      excluded.add(d.name);
    }
  }

  const reads = new Set<string>();
  for (const id of findNodesByKind(node, NodeKind.Identifier) as Identifier[]) {
    if (excluded.has(id)) continue;
    const name = (id as any).name;
    if (typeof name === 'string' && name) reads.add(name);
  }
  return reads;
}

/** Unread locals of a function: declared, and never appearing in a read position. */
function unreadLocals(fn: ASTNode): Set<string> {
  const decls = declaredLocals(fn);
  const reads = readNames(fn);
  const out = new Set<string>();
  for (const name of decls.keys()) if (!reads.has(name)) out.add(name);
  return out;
}

function functionsOf(ast: ASTNode): FunctionDecl[] {
  return (findNodesByKind(ast, NodeKind.FunctionDecl) as FunctionDecl[])
    .filter(f => (f as any).body);
}

function main() {
  const argv = process.argv.slice(2);
  const num = (flag: string, dflt: number) => {
    const a = argv.find(x => x.startsWith(flag));
    return a && a.includes('=') ? Number(a.split('=')[1]) : dflt;
  };
  const limit = num('--limit', 0);
  const jsonOut = argv.find(a => a.startsWith('--json'))?.split('=')[1];

  const pipeline = defaultRegistry.createPipeline({ preset: 'full' } as any);

  const carried: any[] = [];
  const introduced: any[] = [];
  const invented: any[] = [];
  const byPass = new Map<string, number>();
  let parsed = 0, parseFailed = 0, seen = 0;

  const lines = readFileSync(SNAPSHOT, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    if (limit && seen >= limit) break;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    const code: string = rec.decompiled || '';
    if (!code.trim()) continue;
    seen++;

    let before: ASTNode;
    try {
      before = parse(preprocessGhidraCode(code));
    } catch {
      parseFailed++;
      continue;
    }
    parsed++;

    let result: any;
    try {
      result = pipeline.execute(before as any, { trackSteps: true } as any);
    } catch {
      continue;
    }

    const fnsBefore = functionsOf(before);
    if (!fnsBefore.length) continue;
    const fnBefore = fnsBefore[0];
    const declsBefore = declaredLocals(fnBefore);
    const unreadBefore = unreadLocals(fnBefore);

    const fnsAfter = functionsOf(result.ast);
    if (!fnsAfter.length) continue;
    const fnAfter = fnsAfter[0];
    const declsAfter = declaredLocals(fnAfter);
    const unreadAfter = unreadLocals(fnAfter);

    for (const name of unreadAfter) {
      const where = { addr: rec.address, fn: rec.name, name };
      if (!declsBefore.has(name)) {
        invented.push(where);
      } else if (unreadBefore.has(name)) {
        carried.push(where);
      } else {
        // Read before, unread after: find the first step whose output lost the read.
        let culprit = '(unknown)';
        for (const step of result.steps || []) {
          const fns = functionsOf(step.ast);
          if (!fns.length) continue;
          if (unreadLocals(fns[0]).has(name)) { culprit = step.name; break; }
        }
        byPass.set(culprit, (byPass.get(culprit) || 0) + 1);
        introduced.push({ ...where, pass: culprit });
      }
    }
  }

  console.log(`snapshot functions scanned: ${seen}  parsed: ${parsed}  parse-failed: ${parseFailed}`);
  console.log('');
  console.log('verdict      count  what it means');
  console.log(`carried   ${String(carried.length).padStart(8)}  unread in Ghidra's AST too - faithful, cosmetic`);
  console.log(`introduced${String(introduced.length).padStart(8)}  READ in Ghidra, unread in ours - a pass deleted the last read`);
  console.log(`invented  ${String(invented.length).padStart(8)}  declared by us, not declared by Ghidra`);
  console.log('');

  if (byPass.size) {
    console.log('--- introduced, by the pass that removed the last read ---');
    for (const [pass, n] of [...byPass.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(6)}  ${pass}`);
    }
    console.log('');
    console.log('--- sample ---');
    for (const r of introduced.slice(0, 25)) {
      console.log(`  ${r.addr}  ${r.fn}  ${r.name}  <- ${r.pass}`);
    }
  }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ carried, introduced, invented }, null, 2));
    console.log(`\nwrote ${jsonOut}`);
  }
}

main();
