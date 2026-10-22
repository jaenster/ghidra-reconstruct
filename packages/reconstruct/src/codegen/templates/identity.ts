/**
 * A template-id as the parser reads it.
 *
 * Ghidra spells a class template instantiation the way the source did,
 * `TSHashTable<CELLIST,HASHKEY_NONE>`, in type names, namespace paths and
 * decompiled text. Every question the generator asks about one - which family,
 * which arguments, how C++ spells it, what it looks like with the arguments
 * replaced by the template's parameters - is answered on the parser's AST of
 * the spelling, never on its characters.
 */

import { NodeKind, emit, parse } from '@ghidra-mcp/cpp-parser';
import type {
  ASTNode,
  ExprTemplateArg,
  Identifier,
  PointerType,
  QualifiedId,
  TemplateArgument,
  TemplateType,
  TypeNode,
  TypeTemplateArg,
  TypedefType,
} from '@ghidra-mcp/cpp-parser';

const PROBE = '__template_type_probe';

/** The type a spelling denotes, or undefined when it is not one type. */
export function parseTypeSpelling(spelling: string): TypeNode | undefined {
  let tu: { declarations: ASTNode[] };
  try {
    tu = parse(`typedef ${spelling} ${PROBE};`) as unknown as { declarations: ASTNode[] };
  } catch {
    return undefined;
  }
  const [decl, ...rest] = tu.declarations as Array<ASTNode & { name?: Identifier; type?: TypeNode }>;
  if (rest.length > 0 || decl?.kind !== NodeKind.TypedefDecl || decl.name?.name !== PROBE) return undefined;
  return decl.type;
}

/** C++ spelling of a type node. */
export function spellType(type: TypeNode): string {
  return emit(type);
}

/** The template-id a type node IS (not one it merely contains). */
export function templateIdOf(type: TypeNode | undefined): TemplateType | undefined {
  if (!type) return undefined;
  if (type.kind === NodeKind.TemplateType) return type as TemplateType;
  if (type.kind === NodeKind.TypedefType) {
    const name = (type as TypedefType).name as unknown as ASTNode;
    if (name.kind === NodeKind.TemplateType) return name as unknown as TemplateType;
  }
  return undefined;
}

/** The unqualified template name of a template-id. */
export function templateName(id: TemplateType): string | undefined {
  return id.name.kind === NodeKind.Identifier ? (id.name as Identifier).name : undefined;
}

/** One argument of a template-id: a type, or an integer value. */
export type TemplateArgValue =
  | { kind: 'type'; spelling: string; type: TypeNode }
  | { kind: 'value'; spelling: string; value: number };

/** The arguments of a template-id, each spelled as C++ spells it. */
export function templateArguments(id: TemplateType): TemplateArgValue[] | undefined {
  const out: TemplateArgValue[] = [];
  for (const arg of id.arguments) {
    if (arg.kind === NodeKind.TypeTemplateArg) {
      const type = (arg as TypeTemplateArg).type;
      out.push({ kind: 'type', spelling: spellType(type), type });
      continue;
    }
    if (arg.kind === NodeKind.ExprTemplateArg) {
      const expr = (arg as ExprTemplateArg).expression;
      const value = integerValue(expr);
      if (value === undefined) return undefined;
      out.push({ kind: 'value', spelling: emit(expr), value });
      continue;
    }
    // A bare identifier argument parses as a type; anything else is not ours.
    return undefined;
  }
  return out;
}

/** The value of an integer literal, or of a negated one. */
function integerValue(expr: ASTNode): number | undefined {
  const node = expr as ASTNode & { value?: unknown; operator?: string; operand?: ASTNode; expression?: ASTNode };
  if (node.kind === NodeKind.ParenExpr && node.expression) return integerValue(node.expression);
  if (node.kind === NodeKind.UnaryExpr && node.operand) {
    const inner = integerValue(node.operand);
    if (inner === undefined) return undefined;
    if (node.operator === '-') return -inner;
    if (node.operator === '+') return inner;
    return undefined;
  }
  if (node.kind === NodeKind.IntegerLiteral && typeof node.value === 'bigint') return Number(node.value);
  return undefined;
}

/**
 * Replace, outermost first, every subtree of `type` whose C++ spelling is a key
 * of `bySpelling` with the identifier the map gives. Type arguments and value
 * arguments alike: an argument `-572662307` is an expression, a `CELLIST *` a type.
 */
export function substituteType(type: TypeNode, bySpelling: ReadonlyMap<string, string>): TypeNode {
  const replacement = bySpelling.get(spellType(stripRootQualifiers(type)));
  if (replacement !== undefined) return typedefNamed(replacement, type);
  switch (type.kind) {
    case NodeKind.PointerType: {
      const p = type as PointerType;
      return { ...p, pointee: substituteType(p.pointee, bySpelling) } as PointerType;
    }
    case NodeKind.TypedefType: {
      const t = type as TypedefType;
      const id = templateIdOf(t);
      if (id) return { ...t, name: substituteTemplateId(id, bySpelling) as unknown as Identifier } as TypedefType;
      // A member type of an instantiation: `TSHashTable<CELLIST, HASHKEY_NONE>::vtable`.
      const name = t.name as unknown as ASTNode;
      if (name.kind !== NodeKind.QualifiedId) return t;
      const q = name as unknown as QualifiedId;
      const qualifier = q.qualifier.map(part =>
        (part as unknown as ASTNode).kind === NodeKind.TemplateType
          ? substituteTemplateId(part as unknown as TemplateType, bySpelling)
          : part);
      return { ...t, name: { ...q, qualifier } as unknown as Identifier } as TypedefType;
    }
    case NodeKind.TemplateType:
      return substituteTemplateId(type as TemplateType, bySpelling) as unknown as TypeNode;
    default: {
      // Arrays, references and qualified types hold their element under one of
      // these; anything else has no type inside it to substitute.
      const t = type as TypeNode & { elementType?: TypeNode; referenced?: TypeNode };
      if (t.elementType) return { ...t, elementType: substituteType(t.elementType, bySpelling) } as TypeNode;
      if (t.referenced) return { ...t, referenced: substituteType(t.referenced, bySpelling) } as TypeNode;
      if (type.kind === NodeKind.QualifiedType) {
        const q = type as TypeNode & { type: TypeNode };
        return { ...q, type: substituteType(q.type, bySpelling) } as TypeNode;
      }
      return type;
    }
  }
}

function substituteTemplateId(id: TemplateType, bySpelling: ReadonlyMap<string, string>): TemplateType {
  const args: TemplateArgument[] = id.arguments.map(arg => {
    if (arg.kind === NodeKind.TypeTemplateArg) {
      const a = arg as TypeTemplateArg;
      return { ...a, type: substituteType(a.type, bySpelling) } as TypeTemplateArg;
    }
    if (arg.kind === NodeKind.ExprTemplateArg) {
      const a = arg as ExprTemplateArg;
      const replacement = bySpelling.get(emit(a.expression));
      if (replacement === undefined) return a;
      const ident = { kind: NodeKind.Identifier, name: replacement, location: a.expression.location } as unknown as Identifier;
      return { ...a, expression: ident } as unknown as ExprTemplateArg;
    }
    return arg;
  });
  return { ...id, arguments: args };
}

function typedefNamed(name: string, like: ASTNode): TypeNode {
  const ident = { kind: NodeKind.Identifier, name, location: like.location } as unknown as Identifier;
  return { kind: NodeKind.TypedefType, name: ident, location: like.location } as unknown as TypedefType;
}

/** The spelling of every template-id inside a type, outermost first. */
export function templateIdsIn(type: TypeNode): string[] {
  const out: string[] = [];
  const visit = (node: ASTNode | undefined): void => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === NodeKind.TemplateType) {
      const id = node as unknown as TemplateType;
      out.push(spellType({ kind: NodeKind.TypedefType, name: id, location: id.location } as unknown as TypeNode));
      for (const arg of id.arguments) {
        if (arg.kind === NodeKind.TypeTemplateArg) visit((arg as TypeTemplateArg).type);
      }
      return;
    }
    for (const key of ['pointee', 'elementType', 'referenced', 'type', 'name'] as const) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') visit(child as ASTNode);
    }
    if (node.kind === NodeKind.QualifiedId) {
      for (const part of (node as unknown as QualifiedId).qualifier) visit(part as unknown as ASTNode);
    }
  };
  visit(type);
  return out;
}

/**
 * `::CELLIST` names the type `CELLIST` names; the root qualifier only escapes a
 * same-named namespace. Returns the type without it, for comparing spellings.
 */
export function withoutRootQualifier(type: TypeNode): TypeNode {
  if (type.kind !== NodeKind.TypedefType) return type;
  const name = (type as TypedefType).name as unknown as ASTNode;
  if (name.kind !== NodeKind.QualifiedId) return type;
  const q = name as unknown as QualifiedId;
  if (!q.isGlobal || q.qualifier.length > 0 || (q.name as unknown as ASTNode).kind !== NodeKind.Identifier) return type;
  return { ...type, name: q.name as Identifier } as TypedefType;
}

/**
 * A type spelling with every argument type a namespace shadows root-qualified:
 * inside `namespace Class::IgnoreList` the name `StringEntryNode` is the class
 * namespace `Class::StringEntryNode`, so `TSHashTable<StringEntryNode, HASHKEY_STRI>`
 * has to say `::StringEntryNode`. The template name itself is never shadowed (a
 * registered class has no namespace). Undefined when nothing changes.
 */
const rootQualified = new WeakMap<ReadonlySet<string>, Map<string, string | undefined>>();

export function rootQualifyTemplateArguments(spelling: string, shadowed: ReadonlySet<string>): string | undefined {
  let memo = rootQualified.get(shadowed);
  if (!memo) rootQualified.set(shadowed, (memo = new Map()));
  if (memo.has(spelling)) return memo.get(spelling);
  const out = rootQualifyTemplateArgumentsUncached(spelling, shadowed);
  memo.set(spelling, out);
  return out;
}

function rootQualifyTemplateArgumentsUncached(spelling: string, shadowed: ReadonlySet<string>): string | undefined {
  const type = parseTypeSpelling(spelling);
  if (!type || templateIdsIn(type).length === 0) return undefined;
  let changed = false;
  const qualify = (node: TypeNode): TypeNode => {
    switch (node.kind) {
      case NodeKind.PointerType: {
        const p = node as PointerType;
        return { ...p, pointee: qualify(p.pointee) } as PointerType;
      }
      case NodeKind.TypedefType: {
        const t = node as TypedefType;
        const name = t.name as unknown as ASTNode;
        if (name.kind === NodeKind.TemplateType) {
          return { ...t, name: qualifyArguments(name as unknown as TemplateType) as unknown as Identifier } as TypedefType;
        }
        if (name.kind === NodeKind.QualifiedId) {
          const q = name as unknown as QualifiedId;
          const qualifier = q.qualifier.map(part =>
            (part as unknown as ASTNode).kind === NodeKind.TemplateType ? qualifyArguments(part as unknown as TemplateType) : part);
          return { ...t, name: { ...q, qualifier } as unknown as Identifier } as TypedefType;
        }
        return t;
      }
      default:
        return node;
    }
  };
  const asArgument = (node: TypeNode): TypeNode => {
    let base: TypeNode = node;
    const stars: PointerType[] = [];
    while (base.kind === NodeKind.PointerType) { stars.push(base as PointerType); base = (base as PointerType).pointee; }
    if (base.kind === NodeKind.TypedefType) {
      const name = (base as TypedefType).name as unknown as ASTNode;
      if (name.kind === NodeKind.Identifier && shadowed.has((name as Identifier).name)) {
        changed = true;
        const global = { kind: NodeKind.QualifiedId, qualifier: [], name, isGlobal: true, location: name.location } as unknown as QualifiedId;
        base = { ...base, name: global as unknown as Identifier } as TypedefType;
        for (let i = stars.length - 1; i >= 0; i--) base = { ...stars[i], pointee: base } as PointerType;
        return base;
      }
    }
    return qualify(node);
  };
  const qualifyArguments = (id: TemplateType): TemplateType => ({
    ...id,
    arguments: id.arguments.map(arg => arg.kind === NodeKind.TypeTemplateArg
      ? { ...(arg as TypeTemplateArg), type: asArgument((arg as TypeTemplateArg).type) } as TypeTemplateArg
      : arg),
  });
  const out = qualify(type);
  return changed ? spellType(out) : undefined;
}

/** The type with every `::Name` root qualifier dropped, at any depth: the same type, in the spelling identities are compared in. */
export function stripRootQualifiers(type: TypeNode): TypeNode {
  const visit = (node: TypeNode): TypeNode => {
    const bare = withoutRootQualifier(node);
    switch (bare.kind) {
      case NodeKind.PointerType: {
        const p = bare as PointerType;
        return { ...p, pointee: visit(p.pointee) } as PointerType;
      }
      case NodeKind.TypedefType: {
        const t = bare as TypedefType;
        const name = t.name as unknown as ASTNode;
        if (name.kind === NodeKind.TemplateType) return { ...t, name: visitId(name as unknown as TemplateType) as unknown as Identifier } as TypedefType;
        if (name.kind === NodeKind.QualifiedId) {
          const q = name as unknown as QualifiedId;
          const qualifier = q.qualifier.map(part =>
            (part as unknown as ASTNode).kind === NodeKind.TemplateType ? visitId(part as unknown as TemplateType) : part);
          return { ...t, name: { ...q, qualifier } as unknown as Identifier } as TypedefType;
        }
        return t;
      }
      default:
        return bare;
    }
  };
  const visitId = (id: TemplateType): TemplateType => ({
    ...id,
    arguments: id.arguments.map(arg => arg.kind === NodeKind.TypeTemplateArg
      ? { ...(arg as TypeTemplateArg), type: visit((arg as TypeTemplateArg).type) } as TypeTemplateArg
      : arg),
  });
  return visit(type);
}
