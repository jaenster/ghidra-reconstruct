/**
 * Class template instantiations in the cast passes' type environment.
 *
 * Those passes reason about a type as a base name plus indirection, and read
 * both from spellings ("D2UnitStrc *") and from parsed types. A template-id
 * (`TSHashTable<CELLIST, HASHKEY_NONE>`) and a member type of one
 * (`TSHashTable<CELLIST, HASHKEY_NONE>::Vtable`) are base names like any other:
 * the base is the parser's own spelling of the type, so a spelling read from
 * the model and a type read from a body agree.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { AnyNode, ASTNode, TypeNode } from '../../../ast/nodes.js';
import { emit } from '../../../emit/index.js';
import { parse } from '../../../parser/index.js';

/** Does this name node (a TypedefType's) carry a template-id anywhere in it? */
function namesTemplate(name: ASTNode | undefined): boolean {
  if (!name) return false;
  if (name.kind === NodeKind.TemplateType) return true;
  if (name.kind !== NodeKind.QualifiedId) return false;
  const q = name as unknown as { qualifier: ASTNode[]; name: ASTNode };
  return q.qualifier.some(p => p.kind === NodeKind.TemplateType) || q.name.kind === NodeKind.TemplateType;
}

/**
 * `::CELLIST` and `CELLIST` are one type; a root qualifier only escapes a
 * namespace of the same name. Dropped at every depth, so two spellings of one
 * type compare equal.
 */
function withoutRootQualifiers<N extends ASTNode>(node: N): N {
  if (!node || typeof node !== 'object') return node;
  if (node.kind === NodeKind.QualifiedId) {
    const q = node as unknown as { qualifier: ASTNode[]; name: ASTNode; isGlobal: boolean };
    if (q.isGlobal && q.qualifier.length === 0) return withoutRootQualifiers(q.name) as unknown as N;
    return { ...node, qualifier: q.qualifier.map(withoutRootQualifiers), name: withoutRootQualifiers(q.name) } as N;
  }
  const out = { ...node } as unknown as Record<string, unknown>;
  for (const key of ['name', 'pointee', 'type', 'elementType', 'referenced'] as const) {
    const child = out[key];
    if (child && typeof child === 'object') out[key] = withoutRootQualifiers(child as ASTNode);
  }
  if (node.kind === NodeKind.TemplateType) {
    out.arguments = (node as unknown as { arguments: ASTNode[] }).arguments.map(withoutRootQualifiers);
  }
  return out as unknown as N;
}

/** The base spelling of a TypedefType's name when it is a template-id or a member of one. */
export function templateBaseName(name: unknown): string | undefined {
  const n = name as ASTNode | undefined;
  return n && typeof n === 'object' && namesTemplate(n) ? emit(withoutRootQualifiers(n) as AnyNode) : undefined;
}

const PROBE = '__template_type_probe';
const parsed = new Map<string, TypeNode | null>();

/**
 * The type a template-id spelling denotes, or null when the spelling is not one
 * type naming a template. Memoised: the same handful of spellings recur in every body.
 */
export function templateTypeFromSpelling(spelling: string): TypeNode | null {
  const key = spelling.trim();
  const hit = parsed.get(key);
  if (hit !== undefined) return hit;
  let type: TypeNode | null = null;
  if (key.includes('<')) {
    try {
      const tu = parse(`typedef ${key} ${PROBE};`) as unknown as { declarations: Array<ASTNode & { name?: { name?: string }; type?: TypeNode }> };
      const [decl, ...rest] = tu.declarations;
      if (rest.length === 0 && decl?.kind === NodeKind.TypedefDecl && decl.name?.name === PROBE && decl.type) {
        let base: ASTNode = decl.type;
        while (base.kind === NodeKind.PointerType) base = (base as unknown as { pointee: ASTNode }).pointee;
        if (base.kind === NodeKind.TypedefType && namesTemplate((base as unknown as { name: ASTNode }).name)) type = decl.type;
      }
    } catch {
      type = null;
    }
  }
  parsed.set(key, type);
  return type;
}
