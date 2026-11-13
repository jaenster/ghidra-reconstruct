/**
 * Local-Shadowed-Global Plugin
 *
 * Ghidra prints a root-scope global by its bare name, and leaves a parameter or local of
 * the same name as it is. The text then says one thing twice:
 *
 *     void __fastcall UpdateScaleFactor(int nScaleFactor) {
 *       nScaleFactor = nScaleFactor;        // global 007b57e4 = parameter
 *     }
 *
 * and C++ binds both to the parameter: the store writes the parameter and the global is
 * never set (006b1c10, 005090a0, D2GFX_Initialize's hInstance). Which token is the global
 * is in the decompiler's markup, not the text, so the reconstruct side records it per line
 * (extract/shadowed-globals.ts: the token's index among the line's tokens of that name, and
 * how many the line prints) and hands it here keyed by line of the parsed wrapper
 * (codegen/shadowed-globals-spec.ts). Each recorded token is respelled with the path that
 * reaches the global from any scope, `::nScaleFactor` (or `::Ns::name` for a namespaced
 * one), so no later pass and no lookup can take it for the local.
 *
 * Runs first: the passes after it see a global where Ghidra saw one, and the token count
 * is that of the text as parsed. A line whose identifiers of the name do not number what
 * the markup printed is left alone; so is a token that is not a reference (a member name,
 * a declaration's own name, a part of a qualified name).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Identifier, QualifiedId } from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

const placed = (n: ASTNode): boolean =>
  !!n.location && n.location.file !== '<generated>' && n.location.start.line > 0;

/** One global reference a parameter or local's name shadows, on a line of the parsed text. */
export interface ShadowedGlobalFact {
  name: string;
  /** Index among the line's tokens of this name. */
  ord: number;
  /** Tokens of this name the line prints. */
  total: number;
  /** The namespace path the global is emitted in; empty for root scope. */
  qualifier: readonly string[];
}

export interface LocalShadowedGlobalOptions extends PluginOptions {
  /** Parsed-text line -> the shadowed global references on it. */
  shadowedGlobals?: ReadonlyMap<number, readonly ShadowedGlobalFact[]>;
  /** Called per respelled reference. */
  onSite?: (site: { line: number; name: string; ord: number }) => void;
}

interface Occurrence { id: Identifier; reference: boolean }

const DECL_KINDS = new Set<string>([
  NodeKind.VariableDecl, NodeKind.ParameterDecl, NodeKind.FieldDecl, NodeKind.FunctionDecl,
]);

/** Every Identifier under root with whether its position is a plain reference, in no particular order. */
function identifiers(root: ASTNode): Occurrence[] {
  const out: Occurrence[] = [];
  const visit = (n: ASTNode, parent: ASTNode | undefined, key: string | undefined, inQualified: boolean) => {
    if (n.kind === NodeKind.Identifier) {
      const nonReference = inQualified
        || (parent?.kind === NodeKind.MemberExpr && key === 'member')
        || (parent !== undefined && DECL_KINDS.has(parent.kind) && key === 'name')
        || parent?.kind === NodeKind.LabelStmt || parent?.kind === NodeKind.GotoStmt;
      out.push({ id: n as Identifier, reference: !nonReference });
    }
    const q = inQualified || n.kind === NodeKind.QualifiedId;
    for (const k of Object.keys(n)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      const v = (n as unknown as Record<string, unknown>)[k];
      if (Array.isArray(v)) {
        for (const x of v) if (x && typeof x === 'object' && typeof (x as ASTNode).kind === 'string') visit(x as ASTNode, n, k, q);
      } else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') {
        visit(v as ASTNode, n, k, q);
      }
    }
  };
  visit(root, undefined, undefined, false);
  return out;
}

/** Where an Identifier stands in the parsed text: the transformer hands visitors copies, so identity does not survive. */
const at = (id: Identifier): string => `${id.location.start.line}:${id.location.start.column}:${id.name}`;

/** The Identifiers to respell, by position, against the qualifier each gets. */
function targets(root: ASTNode, facts: ReadonlyMap<number, readonly ShadowedGlobalFact[]>): Map<string, ShadowedGlobalFact & { line: number }> {
  const wanted = new Set<string>();
  for (const fs of facts.values()) for (const f of fs) wanted.add(f.name);
  const byLineName = new Map<string, Occurrence[]>();
  for (const o of identifiers(root)) {
    if (!wanted.has(o.id.name)) continue;
    if (!placed(o.id)) continue;
    const loc = o.id.location;
    const key = `${loc.start.line}\u0000${o.id.name}`;
    let list = byLineName.get(key);
    if (!list) byLineName.set(key, list = []);
    list.push(o);
  }
  const out = new Map<string, ShadowedGlobalFact & { line: number }>();
  for (const [line, fs] of facts) {
    for (const f of fs) {
      const list = byLineName.get(`${line}\u0000${f.name}`);
      if (!list || list.length !== f.total) continue;
      list.sort((a, b) => a.id.location.start.column - b.id.location.start.column);
      const o = list[f.ord];
      if (o && o.reference) out.set(at(o.id), { ...f, line });
    }
  }
  return out;
}

function createLocalShadowedGlobalTransformer(options: LocalShadowedGlobalOptions = {}): Transformer {
  const facts = options.shadowedGlobals;
  if (!facts || facts.size === 0) return (node: ASTNode) => node;
  return (root: ASTNode) => {
    const respell = targets(root, facts);
    if (respell.size === 0) return root;
    return createTransformer({
      visitNode(n: ASTNode): ASTNode | undefined {
        if (n.kind !== NodeKind.Identifier || !placed(n)) return undefined;
        const f = respell.get(at(n as Identifier));
        if (!f) return undefined;
        const id = n as Identifier;
        options.onSite?.({ line: f.line, name: f.name, ord: f.ord });
        // The parts are new nodes: marked generated, so no position-keyed pass (this one
        // included) takes them for the token they replace.
        const part = (name: string): Identifier =>
          ({ kind: NodeKind.Identifier, name, location: { ...id.location, file: '<generated>' }, leadingTrivia: [], trailingTrivia: [] }) as Identifier;
        return {
          kind: NodeKind.QualifiedId,
          qualifier: f.qualifier.map(part),
          name: part(id.name),
          isGlobal: true,
          location: id.location,
          leadingTrivia: id.leadingTrivia ?? [],
          trailingTrivia: id.trailingTrivia ?? [],
        } as QualifiedId;
      },
    })(root);
  };
}

import { createPlugin } from '../registry.js';

export const localShadowedGlobalPlugin: TransformPlugin = createPlugin(
  'local-shadowed-global',
  'Local Shadowed Global',
  'Respells a global reference a same-named parameter or local hides, from the decompiler markup, as ::name',
  (options?: PluginOptions) => createLocalShadowedGlobalTransformer(options as LocalShadowedGlobalOptions),
  {
    // Before every other pass: inlined-call-restore is 0.
    priority: -1,
    defaultEnabled: true,
    tags: ['correctness', 'cpp'],
    version: '1.0.0',
  }
);
