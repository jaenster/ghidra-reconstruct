/**
 * Plate-comment template that reached the emitted tree.
 *
 * The generator drops a plate's template lines (codegen/plate-comment.ts): the batch_rename
 * `@function/@address/@date/@params` header, the 1.14d reverse team banner, link and editor
 * block, and `@sourcefile-basis`. This check asks every comment in the tree whether one got
 * through anyway - a new template shape the rules do not know, a pre/EOL comment that never
 * passes the plate filter, or a hand edit. The tree is meant to be published, so the gate is
 * zero: a finding is never baselined, it is fixed in the generator or in Ghidra.
 *
 * It reads comments as the parser keeps them (trivia on the node they precede or follow),
 * line by line, never the source text, so a string literal cannot match.
 */

import { TriviaKind, getChildren } from '@ghidra-mcp/cpp-parser';
import type { Check, Finding } from '../context.js';
import type { SourceFile } from '../tree.js';

export const PLATE_TEMPLATE_CHECK_ID = 'plate-template-comment';

interface MarkerRule {
  id: string;
  test(line: string): boolean;
}

/** `  name: ECX:4 (type)`, `  name: Stack[0x4]:2 (type)`, `  name: EDX:4,EAX:4 (type)`. */
const STORAGE = String.raw`(E?[A-Z]{2}|[A-Z]L|Stack\[-?0x[0-9a-fA-F]+\]):\d+`;
const PARAMS_LINE = new RegExp(String.raw`^\s+[A-Za-z_]\w*\s*:\s*${STORAGE}(,${STORAGE})*\s*\(.*\)\s*$`);

/** One rule per template shape, matched against one comment line with its opener removed. */
export const PLATE_TEMPLATE_MARKERS: readonly MarkerRule[] = [
  { id: 'reverse-team-banner', test: l => /Diablo 2 1\.14d reverse team/i.test(l) },
  { id: 'template-tag', test: l => /(^|[\s|])@(function|address|date|calling|params|description|author)\b/i.test(l) },
  { id: 'sourcefile-basis', test: l => /@sourcefile-basis\b/i.test(l) || /\bnot from D2R\b/.test(l) },
  { id: 'blizzhackers-link', test: l => /blizzhackers\.dev/i.test(l) },
  {
    id: 'editor-block',
    test: l => /^(Last editor|Author)\s*:/i.test(l) ||
      /^Address\s*:\s*Game(\.exe)?\.(ram:)?(0x)?[0-9A-Fa-f]{6,8}\s*$/.test(l) ||
      /^Date\s*:\s*\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}\s*$/.test(l),
  },
  {
    id: 'params-block',
    test: l => PARAMS_LINE.test(l),
  },
];

/** A comment's lines without `//`, `/*`, `*\/` or a leading `*`; indentation after the opener kept. */
function commentLines(text: string): string[] {
  let t = text;
  if (t.startsWith('//')) return [t.slice(2).replace(/^ /, '')];
  if (t.startsWith('/*')) t = t.slice(2);
  if (t.endsWith('*/')) t = t.slice(0, -2);
  return t.split('\n').map(l => l.replace(/^\s*\*(?!\/)\s?/, '').replace(/^ /, ''));
}

export const plateTemplateComment: Check = {
  id: PLATE_TEMPLATE_CHECK_ID,
  blurb: 'plate-comment template (reverse-team banner, @date/@params, @sourcefile-basis, editor block) - must be 0',
  run(ctx) {
    const out: Finding[] = [];
    for (const file of ctx.tree.files as SourceFile[]) {
      const seen = new Set<object>();
      const stack: any[] = [file.tu];
      while (stack.length) {
        const n = stack.pop();
        if (!n || typeof n !== 'object') continue;
        for (const t of [...(n.leadingTrivia ?? []), ...(n.trailingTrivia ?? [])]) {
          if (seen.has(t)) continue;
          seen.add(t);
          if (t.kind !== TriviaKind.LineComment && t.kind !== TriviaKind.BlockComment) continue;
          const lines = commentLines(t.text);
          const start = t.location?.start?.line ?? 0;
          lines.forEach((l, i) => {
            const rule = PLATE_TEMPLATE_MARKERS.find(r => r.test(l));
            if (!rule) return;
            const what = l.trim().slice(0, 80);
            out.push({
              check: PLATE_TEMPLATE_CHECK_ID, file: file.path, line: start + i,
              subject: rule.id, detail: what, sig: `${rule.id} ${what}`,
            });
          });
        }
        for (const k of getChildren(n)) if (k) stack.push(k);
      }
    }
    return out;
  },
};
