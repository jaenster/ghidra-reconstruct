/**
 * Duplicate Goto-Label Uniquify Plugin
 *
 * Ghidra's control-flow recovery sometimes emits the SAME address-labeled block
 * twice in one function — identical code, each copy reached by the gotos of its
 * own region. C++ rejects the second definition ("duplicate label"), and every
 * `goto` to that name is ambiguous.
 *
 * The 2nd and later copies are renamed `<LAB>__dup2`, `__dup3`, … and each
 * `goto` is retargeted to the copy it actually meant.
 *
 * ## Which copy a goto meant
 *
 * The text pass this replaces answered "the most recent PRECEDING definition",
 * and said so in its own header: *"at worst a forward goto picks an earlier copy
 * (control flow was already approximate)"*. For a tree whose endgame is a
 * runnable game that is not a safe default — it silently sends a jump to the
 * wrong block.
 *
 * The statement tree answers it properly. Ghidra duplicates a block per REGION,
 * and a region is a structured scope: the copy a goto meant is the copy that
 * shares the most enclosing scopes with it. So each goto is resolved to the
 * definition with the longest common structural PATH prefix — the deepest common
 * ancestor — and only where several copies tie on that (typically because the
 * goto and both copies sit in one flat block) does source position decide, and
 * then by NEARNESS, not by "preceding": a forward goto standing right before one
 * copy now reaches that copy instead of an earlier one in a different region.
 * A preceding definition still wins a distance tie, which is the backward-goto
 * case the old rule was built for, so those are unchanged.
 *
 * Only Ghidra's own label names (`LAB_`, `switchD_`, …) are touched.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, CompoundStmt, Statement, GotoStmt, LabelStmt,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { childStatements, withChildStatements } from './stmt-structure.js';

export interface DuplicateLabelUniquifyOptions extends PluginOptions {}

const isGhidraLabel = (n: string): boolean => /^(LAB|switchD|caseD|joined|code|UNRECOVERED)_/.test(n);

interface Site {
  /** Structural path from the function body: one child index per level. */
  path: number[];
  /** Position in a source-order walk of the statement tree. */
  order: number;
  name: string;
}

/** Number of leading path components two sites share. */
function commonPrefix(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** Source-order walk of the statement tree, recording every label and goto. */
function collect(root: Statement): { labels: Site[]; gotos: Site[] } {
  const labels: Site[] = [];
  const gotos: Site[] = [];
  let order = 0;
  const walk = (s: Statement, path: number[]): void => {
    if (s.kind === NodeKind.LabelStmt) {
      labels.push({ path, order: order++, name: (s as LabelStmt).label.name });
    } else if (s.kind === NodeKind.GotoStmt) {
      gotos.push({ path, order: order++, name: (s as GotoStmt).label.name });
    }
    const kids = childStatements(s);
    for (let i = 0; i < kids.length; i++) walk(kids[i], [...path, i]);
  };
  walk(root, []);
  return { labels, gotos };
}

/**
 * Rewrite the statement tree, taking each new name from `byPath`, which is keyed
 * by the same path the collecting walk produced.
 */
function rewrite(s: Statement, path: number[], byPath: Map<string, string>): Statement {
  const key = path.join('.');
  let out: Statement = s;
  const renamed = byPath.get(key);
  if (renamed !== undefined) {
    if (s.kind === NodeKind.LabelStmt) {
      out = updateNode(s as LabelStmt, { label: Expr.identifier(renamed) } as Partial<LabelStmt>);
    } else if (s.kind === NodeKind.GotoStmt) {
      out = updateNode(s as GotoStmt, { label: Expr.identifier(renamed) } as Partial<GotoStmt>);
    }
  }
  const kids = childStatements(out);
  if (kids.length === 0) return out;
  let changed = false;
  const newKids = kids.map((k, i) => {
    const nk = rewrite(k, [...path, i], byPath);
    if (nk !== k) changed = true;
    return nk;
  });
  return changed ? withChildStatements(out, newKids) : out;
}

function createDuplicateLabelUniquifyTransformer(_options: DuplicateLabelUniquifyOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;

      const { labels, gotos } = collect(node.body);
      if (labels.length === 0) return undefined;

      const byName = new Map<string, Site[]>();
      for (const l of labels) {
        if (!isGhidraLabel(l.name)) continue;
        const list = byName.get(l.name);
        if (list) list.push(l); else byName.set(l.name, [l]);
      }
      const dups = new Map<string, Site[]>();
      for (const [name, list] of byName) if (list.length >= 2) dups.set(name, list);
      if (dups.size === 0) return undefined;

      // Copy i (0-based, source order) keeps the name; the rest get `__dup<i+1>`.
      const nameOfCopy = (name: string, i: number) => (i === 0 ? name : `${name}__dup${i + 1}`);

      const byPath = new Map<string, string>();
      for (const [name, list] of dups) {
        for (let i = 1; i < list.length; i++) byPath.set(list[i].path.join('.'), nameOfCopy(name, i));
      }

      for (const g of gotos) {
        const list = dups.get(g.name);
        if (!list) continue;
        let bestIdx = 0;
        let bestShared = -1;
        let bestDistance = Infinity;
        let bestPreceding = false;
        for (let i = 0; i < list.length; i++) {
          const shared = commonPrefix(g.path, list[i].path);
          const distance = Math.abs(list[i].order - g.order);
          const preceding = list[i].order < g.order;
          const better =
            shared > bestShared ||
            (shared === bestShared &&
              (distance < bestDistance ||
                // A preceding copy wins a distance tie — the backward-goto case.
                (distance === bestDistance && preceding && !bestPreceding)));
          if (better) {
            bestIdx = i;
            bestShared = shared;
            bestDistance = distance;
            bestPreceding = preceding;
          }
        }
        const target = nameOfCopy(g.name, bestIdx);
        if (target !== g.name) byPath.set(g.path.join('.'), target);
      }

      const newBody = rewrite(node.body, [], byPath) as CompoundStmt;
      if (newBody === node.body) return undefined;
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const duplicateLabelUniquifyPlugin: TransformPlugin = {
  id: 'duplicate-label-uniquify',
  name: 'Duplicate Goto-Label Uniquify',
  description:
    'Renames the 2nd+ copy of a duplicated Ghidra label and retargets each goto to the copy that shares its innermost scope',
  version: '1.0.0',
  defaultEnabled: true,
  // Before goto-crosses-init (700), so that pass sees one label per name and can
  // split whatever a retargeted forward jump now crosses.
  priority: 690,
  tags: ['cleanup', 'control-flow', 'goto'],
  createTransformer: createDuplicateLabelUniquifyTransformer,
};
