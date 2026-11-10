/**
 * Mirror a reconstruction tree into the form Visual C++ 2005 compiles.
 *
 *   pnpm exec tsx packages/reconstruct/src/vc8/cli.ts <tree> <out-dir> [--quarantine <tsv>] [--serve]
 *
 *   <out-dir>            where the translation goes; `-` translates nothing up front
 *   --quarantine <tsv>   the oracle's quarantine.tsv: the functions whose bodies are blanked
 *   --serve              then translate single files on request, with the same per-tree state:
 *                        one JSON object per line on stdin, {"rel": "<path in tree>", "lines":
 *                        [<quarantined line>, ...]}, answered on stdout with {"text": <base64
 *                        of the translation>} or {"error": "<message>"}. With "at": [<line>,
 *                        ...] it answers instead {"functions": [{"line": <line of the body's
 *                        {>, "name": <name>} or null, ...]}: the function each line sits in,
 *                        in that translation, as quarantine.tsv records it. The source is
 *                        read from the tree at request time. Ends at end of input.
 *
 * Prints `vc8_translate: N written, K unchanged` after the mirror. Exit 1 when a file cannot
 * be translated, 2 on a usage error.
 */

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { loadQuarantine, loadTree, mirror, readSource } from './tree.js';
import { functionAt, translate } from './translate.js';

function usage(): never {
  process.stderr.write('usage: cli.ts <tree> <out-dir|-> [--quarantine <tsv>] [--serve]\n');
  process.exit(2);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const pos: string[] = [];
  let quarantinePath: string | undefined;
  let serve = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--quarantine') quarantinePath = argv[++i] ?? usage();
    else if (argv[i] === '--serve') serve = true;
    else if (argv[i].startsWith('--')) usage();
    else pos.push(argv[i]);
  }
  if (pos.length !== 2) usage();
  const root = resolve(pos[0]);
  const tree = loadTree(root);
  if (pos[1] !== '-') {
    try {
      const { written, kept } = mirror(tree, resolve(pos[1]), loadQuarantine(quarantinePath));
      process.stdout.write(`vc8_translate: ${written} written, ${kept} unchanged\n`);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }
  }
  if (!serve) return 0;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let reply: object;
    try {
      const req = JSON.parse(line) as { rel: string; lines?: number[]; at?: number[] };
      const text = translate(readSource(root, req.rel), req.rel, tree.state, req.lines ?? []);
      reply = req.at ? { functions: req.at.map(n => functionAt(text, n)) }
        : { text: Buffer.from(text, 'latin1').toString('base64') };
    } catch (e) {
      reply = { error: (e as Error).message };
    }
    process.stdout.write(JSON.stringify(reply) + '\n');
  }
  return 0;
}

main().then(code => process.exit(code), e => {
  process.stderr.write(`${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
