/**
 * TEB-Field-Access Plugin
 *
 * Ghidra's PE loader maps the thread environment block as a memory block of its
 * own and labels each field (`ProcessEnvironmentBlock`, `LastErrorValue`,
 * `FlsData`), so code that reads `fs:[0x30]` decompiles to a read of a global.
 * There is one TEB per thread and the program owns none of it: emitted as a
 * global, the read returns the zero the definition stored, and
 * DEBUG_EnumerateModulesViaPEB walks the loader list of a null PEB.
 *
 * Each reference to such a label becomes the field of the running thread's
 * block, at the label's offset, with the label's type:
 *
 *     ProcessEnvironmentBlock  ->  (*(void **)((char *)NtCurrentTeb() + 0x30))
 *
 * An array field decays to a pointer to its first element, as the array would.
 *
 * A parameter or local of the field's name means that declaration by every bare
 * occurrence, so the name is dropped for the whole body. Member names,
 * declaration names and the tail of a qualified name `X::name` are never
 * rewritten; `::name` is.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Identifier,
  QualifiedId,
  MemberExpr,
  VariableDecl,
  ParameterDecl,
  FieldDecl,
  FunctionDecl,
  ExprStmt,
  AssignExpr,
  ParenExpr,
  Expression,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { parse } from '../../../parser/index.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface TebField {
  /** The field's C type, e.g. `void *` or `uint32_t`. */
  type: string;
  /** Byte offset from the start of the block. */
  offset: number;
  /** Element count when the field is an array. */
  count?: number;
}

export interface TebFieldAccessOptions extends PluginOptions {
  /** Emitted label name -> the field it stands for. */
  tebFields?: Record<string, TebField>;
}

/** The expression a reference to `field` is written as. */
export function tebFieldExpression(field: TebField): string {
  const at = `((char *)NtCurrentTeb() + 0x${field.offset.toString(16)})`;
  const type = field.type.trim();
  const pointer = /\*$/.test(type) ? `${type}*` : `${type} *`;
  return field.count !== undefined ? `((${pointer})${at})` : `(*(${pointer})${at})`;
}

function parseExpression(text: string): Expression {
  const fn = parse(`void __teb() { __teb_x = ${text}; }`).declarations[0] as FunctionDecl;
  const s = fn.body!.statements[0] as ExprStmt;
  if (s.kind !== NodeKind.ExprStmt) throw new Error(`teb-field-access: not an expression: ${text}`);
  return (s.expression as AssignExpr).right;
}

function declaredInBody(root: ASTNode): Set<string> {
  const names = new Set<string>();
  const add = (n: ASTNode | undefined) => {
    if (n && n.kind === NodeKind.Identifier) names.add((n as Identifier).name);
  };
  for (const d of findNodesByKind(root, NodeKind.ParameterDecl)) add((d as ParameterDecl).name);
  for (const d of findNodesByKind(root, NodeKind.VariableDecl)) add((d as VariableDecl).name);
  return names;
}

function withTrivia(expr: Expression, like: ASTNode): Expression {
  return {
    ...(expr as ParenExpr),
    leadingTrivia: like.leadingTrivia ?? [],
    trailingTrivia: like.trailingTrivia ?? [],
  } as unknown as Expression;
}

function rewrite(fields: Map<string, string>): Transformer {
  // A fresh tree per site: later passes may rewrite one site's nodes in place.
  const expressionFor = (name: string): Expression | undefined => {
    const text = fields.get(name);
    return text === undefined ? undefined : parseExpression(text);
  };
  /** Each rewrite, against the Identifier it replaced: a parent that is no reference puts it back. */
  const builtFrom = new WeakMap<ASTNode, Identifier>();
  const restore = (child: ASTNode | undefined): Identifier | undefined =>
    child ? builtFrom.get(child) : undefined;

  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind === NodeKind.QualifiedId) {
        const q = n as QualifiedId;
        const back = restore(q.name);
        const qualifierBack = q.qualifier.map(p => restore(p) ?? p);
        const changed = !!back || qualifierBack.some((p, i) => p !== q.qualifier[i]);
        const base = changed
          ? updateNode(q, { name: back ?? q.name, qualifier: qualifierBack } as Partial<QualifiedId>) as QualifiedId
          : q;
        // `::Field` is the root-scope label; `X::Field` is something else's.
        if (base.isGlobal && base.qualifier.length === 0 && base.name.kind === NodeKind.Identifier) {
          const e = expressionFor((base.name as Identifier).name);
          if (e) return withTrivia(e, base);
        }
        return changed ? base : undefined;
      }
      if (n.kind !== NodeKind.Identifier) return undefined;
      const id = n as Identifier;
      const e = expressionFor(id.name);
      if (!e) return undefined;
      const built = withTrivia(e, id);
      builtFrom.set(built, id);
      return built;
    },
    visitMemberExpr(node: MemberExpr) {
      const back = restore(node.member);
      return back ? updateNode(node, { member: back } as Partial<MemberExpr>) : undefined;
    },
    visitVariableDecl(node: VariableDecl) {
      const back = restore(node.name);
      return back ? updateNode(node, { name: back } as Partial<VariableDecl>) : undefined;
    },
    visitParameterDecl(node: ParameterDecl) {
      const back = restore(node.name);
      return back ? updateNode(node, { name: back } as Partial<ParameterDecl>) : undefined;
    },
    visitFieldDecl(node: FieldDecl) {
      const back = restore(node.name);
      return back ? updateNode(node, { name: back } as Partial<FieldDecl>) : undefined;
    },
  });
}

function createTebFieldAccessTransformer(options: TebFieldAccessOptions = {}): Transformer {
  const configured = Object.entries(options.tebFields ?? {});
  if (configured.length === 0) return (node: ASTNode) => node;
  return (root: ASTNode) => {
    const declared = declaredInBody(root);
    const live = new Map<string, string>();
    for (const [name, field] of configured) {
      if (declared.has(name)) continue;
      live.set(name, tebFieldExpression(field));
    }
    if (live.size === 0) return root;
    return rewrite(live)(root);
  };
}

import { createPlugin } from '../registry.js';

export const tebFieldAccessPlugin: TransformPlugin = createPlugin(
  'teb-field-access',
  'TEB Field Access',
  "Writes a reference to a label in Ghidra's thread environment block as that field of NtCurrentTeb()",
  (options?: PluginOptions) =>
    createTebFieldAccessTransformer(options as TebFieldAccessOptions),
  {
    // With the alias respelling: before every pass that keys a table on a global's name.
    priority: 20,
    defaultEnabled: true,
    tags: ['cleanup', 'cpp'],
    version: '1.0.0',
  }
);
