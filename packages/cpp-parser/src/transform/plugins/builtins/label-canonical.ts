/**
 * Label names are names, not structure (design step 11).
 *
 * The goto passes decide what to do with a label by what it is - where it sits, how control
 * reaches it - but several of them recognise Ghidra's own labels by their spelling (`LAB_`,
 * `switchD_.._caseD_`, isSimpleLabelName). Once a kept goto's label is named in Ghidra
 * (`done`, `case_6`, `inf_leave`), the decompile prints that name, and without this pair the
 * passes would treat a named label as untouchable and structure the function differently.
 *
 *   goto-label-canonical (priority 1)   every label the extraction located (labelFlow:
 *                                       its block address, and whether a computed jump -
 *                                       a switch table - enters it) is spelled as Ghidra
 *                                       would with no name: `LAB_<addr>`, or
 *                                       `switchD_<addr>_caseD_<addr>` for a case target
 *   goto-label-restore  (priority 985)  every label still standing gets its Ghidra name
 *                                       back (macro-safe, as label-macro-collision spells it)
 *
 * The names stay Ghidra's: nothing here invents one. A label without a located address (a
 * snapshot without the field, a label Ghidra prints with a namespace) is left as written.
 *
 * A JOINED block is the one label the decompiler prints under its default spelling even
 * when Ghidra has a name for it (`joined_r0x00429e3b` is `case_TIME` in zlib's inflate);
 * a manual switch override's target is another (`override_jmp_0057ee01_case_1`).
 * The extraction reads that name (labelFlow `symbol`); the passes see the default spelling
 * they always saw, and the restore gives the label the name - unless the function already
 * has a label of that name, or the name is itself one of Ghidra's default spellings (a
 * switch's `caseD_N`, which the extraction used to report as a name).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, LabelStmt, GotoStmt, Identifier } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { macroSafeLabel } from './label-macro-collision.js';

interface Flow { address?: string; computed?: number; symbol?: string }
export interface LabelCanonicalOptions extends PluginOptions { labelFlow?: Record<string, Flow> | null }

const DEFAULT = /^(LAB_[0-9a-f]{8}|switchD_\w+|caseD_\w+|joined_r0x[0-9a-f]{8}|code_r0x[0-9a-f]{8}|override_jmp_\w+)$/i;

/** name -> canonical spelling, for the labels Ghidra printed under a given name. */
export function canonicalLabels(flow: Record<string, Flow> | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!flow) return out;
  for (const [name, f] of Object.entries(flow)) {
    if (DEFAULT.test(name) || !f?.address || !/^[0-9a-f]{8}$/i.test(f.address)) continue;
    const a = f.address.toLowerCase();
    out.set(name, (f.computed ?? 0) > 0 ? `switchD_${a}_caseD_${a}` : `LAB_${a}`);
  }
  return out;
}

/** default spelling -> Ghidra's name, for the labels the decompile cannot print named. */
export function joinedLabelNames(flow: Record<string, Flow> | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!flow) return out;
  const taken = new Set(Object.keys(flow).filter(n => !DEFAULT.test(n)));
  for (const [name, f] of Object.entries(flow)) {
    if (!/^((joined|code)_r0x[0-9a-f]{8}|override_jmp_[0-9a-f]{8}_case_\w+)$/i.test(name) || !f?.symbol || !/^[A-Za-z_]\w*$/.test(f.symbol)) continue;
    // A switch's own case label (`caseD_5` in namespace `switchD_0041bf3a`) is a name
    // Ghidra's analysis made, not one anybody gave the block: the bare name has lost the
    // namespace that says which switch it belongs to, and the block-start fallback can
    // borrow it from a different address than the label's. Only a given name restores.
    if (DEFAULT.test(f.symbol)) continue;
    if (taken.has(f.symbol)) continue;
    taken.add(f.symbol);
    out.set(name, f.symbol);
  }
  return out;
}

function renamer(map: Map<string, string>): Transformer {
  const id = (i: Identifier): Identifier | null => { const n = map.get(i.name); return n ? updateNode(i, { name: n } as Partial<Identifier>) as Identifier : null; };
  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind === NodeKind.LabelStmt) { const r = id((n as LabelStmt).label); return r ? updateNode(n as LabelStmt, { label: r } as Partial<LabelStmt>) : undefined; }
      if (n.kind === NodeKind.GotoStmt) { const r = id((n as GotoStmt).label); return r ? updateNode(n as GotoStmt, { label: r } as Partial<GotoStmt>) : undefined; }
      return undefined;
    },
  });
}

export const gotoLabelCanonicalPlugin: TransformPlugin = {
  id: 'goto-label-canonical',
  name: 'Goto Label Canonical',
  description: "Spell Ghidra-named labels as Ghidra's default labels while the goto passes run",
  version: '1.0.0',
  defaultEnabled: true,
  priority: 1,
  tags: ['control-flow'],
  createTransformer: (o?: LabelCanonicalOptions) => renamer(canonicalLabels(o?.labelFlow)),
};

export const gotoLabelRestorePlugin: TransformPlugin = {
  id: 'goto-label-restore',
  name: 'Goto Label Restore',
  description: 'Give the labels left standing their Ghidra names back',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 985,
  tags: ['control-flow'],
  createTransformer: (o?: LabelCanonicalOptions) => {
    const back = new Map<string, string>();
    for (const [name, c] of canonicalLabels(o?.labelFlow)) back.set(c, macroSafeLabel(name));
    for (const [name, symbol] of joinedLabelNames(o?.labelFlow)) back.set(name, macroSafeLabel(symbol));
    return renamer(back);
  },
};
