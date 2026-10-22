/**
 * The template header (`Storm/H/stpl.h`): the registered class templates, the
 * key classes beside them, and a declaration of every member the program
 * carries for each instantiation.
 *
 * Every member of every instantiation is its own explicit specialization: the
 * primary template declares the member over its parameters, and the header
 * declares `template<> R TSHashTable<CELLIST, HASHKEY_NONE>::Ptr(...)` for each
 * address. A specialization has to be declared before the first use in every
 * translation unit, and the one header every user of a template-id includes is
 * the one that defines the template, so they are all declared here.
 *
 * A member with a receiver is a non-static member function (templates/members.ts).
 * The vtable slots stay `static` and keep the receiver as an explicit `pThis`:
 * the explicit vtable's slots are plain function pointers.
 */

import { NodeKind } from '@ghidra-mcp/cpp-parser';
import type { ASTNode, Identifier, TemplateType, TypeNode } from '@ghidra-mcp/cpp-parser';
import type { AnalyzedDataSymbol, ExtractedDataType, ExtractedFunction, ExtractedStruct, ReconstructOptions, StructField } from '../../types.js';
import { conventionKeyword } from '../calling-convention.js';
import { classHead, declaredParameters, emitFieldLines, emittedFunctionName, generateFunctionDeclaration, guardedFuncDefTypedef, returnSigType } from '../header.js';
import { globalDeclarator, globalEvidenceComment, sanitizeSymbolName } from '../globals-header.js';
import { namespaceResolution } from '../namespace-resolution.js';
import { orphanMarker } from './index.js';
import { parseTypeSpelling, templateIdOf, templateName } from './identity.js';
import { deriveFamilyLayouts, genericSpelling, VTABLE_MEMBER_TYPE, type FamilyLayout } from './layout.js';
import { classKeyOf, type TemplateFamily, type TemplateInstantiation, type TemplateRegistry } from './registry.js';
import { baseComponentOf, ownFields } from './bases.js';

export interface TemplateHeaderInput {
  registry: TemplateRegistry;
  dataTypes: readonly ExtractedDataType[];
  /** Every function in a registered class scope. */
  members: readonly ExtractedFunction[];
  /** Every datum in a registered class scope. */
  data: readonly AnalyzedDataSymbol[];
  /** The header's own non-template types, already rendered with its includes (generateHeader). */
  base: string;
  /** Headers that define a type the templates use by value but this header does not own. */
  ownerOf: (typeName: string) => string | undefined;
  options: ReconstructOptions;
}

/** The registered scope a symbol belongs to, as the tree spells it. */
function scopeOf(symbol: { address?: string; namespace?: string | null }): string | undefined {
  const resolved = namespaceResolution().of(symbol);
  return resolved.classScope ? resolved.segments[0] : undefined;
}

function addressValue(address: string): number {
  return parseInt(address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address, 16);
}

function templateHead(family: TemplateFamily): string {
  return `template<${family.params.map(p => (p.kind === 'int' ? `int ${p.name}` : `class ${p.name}`)).join(', ')}>`;
}

/** Families a layout holds BY VALUE, which must be defined before it. */
function valueDependencies(layout: FamilyLayout, registry: TemplateRegistry): string[] {
  const deps = new Set<string>();
  for (const f of layout.fields) {
    const id = templateIdOf(parseTypeSpelling(f.dataType));
    const name = id ? templateName(id) : undefined;
    if (name && name !== layout.family.name && registry.family(name)) deps.add(name);
  }
  return [...deps];
}

/** Families in definition order: each after every family it holds by value, else in project.json order. */
function definitionOrder(registry: TemplateRegistry, layouts: ReadonlyMap<string, FamilyLayout>): FamilyLayout[] {
  const out: FamilyLayout[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string): void => {
    const layout = layouts.get(name);
    if (!layout || state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') throw new Error(`[templates] ${name} holds itself by value`);
    state.set(name, 'visiting');
    for (const dep of valueDependencies(layout, registry)) visit(dep);
    state.set(name, 'done');
    out.push(layout);
  };
  for (const family of registry.families()) visit(family.name);
  return out;
}

/** Every plain type name a spelling mentions (not template names, not qualified members). */
function plainTypeNames(spelling: string, into: Set<string>): void {
  const type = parseTypeSpelling(spelling);
  const visit = (node: ASTNode | undefined): void => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === NodeKind.TypedefType) {
      const name = (node as unknown as { name: ASTNode }).name;
      if (name.kind === NodeKind.Identifier) into.add((name as Identifier).name);
      else visit(name);
      return;
    }
    if (node.kind === NodeKind.TemplateType) {
      for (const arg of (node as unknown as TemplateType).arguments) {
        if (arg.kind === NodeKind.TypeTemplateArg) visit((arg as unknown as { type: TypeNode }).type);
      }
      return;
    }
    if (node.kind === NodeKind.QualifiedId) {
      const q = node as unknown as { qualifier: ASTNode[]; name: ASTNode; isGlobal: boolean };
      // `::CELLIST` is the root-scope CELLIST.
      if (q.isGlobal && q.qualifier.length === 0 && q.name.kind === NodeKind.Identifier) into.add((q.name as Identifier).name);
      for (const part of q.qualifier) visit(part);
      return;
    }
    for (const key of ['pointee', 'elementType', 'referenced', 'type']) {
      visit((node as unknown as Record<string, ASTNode | undefined>)[key]);
    }
  };
  visit(type);
}

/** `static ` for a member that takes its receiver explicitly (templates/members.ts), else nothing. */
function memberStorage(registry: TemplateRegistry, func: ExtractedFunction): string {
  return registry.isInstanceMember(func.address) ? '' : 'static ';
}

interface MemberDecl {
  key: string;
  returnType: string;
  line: string;
}

/** The primary template's declaration of every member its instantiations carry. */
function genericMembers(
  family: TemplateFamily,
  members: readonly ExtractedFunction[],
  registry: TemplateRegistry,
  problems: string[],
  mentioned: Set<string>,
): string[] {
  const decls = new Map<string, MemberDecl>();
  for (const func of members) {
    const inst = registry.instantiation(scopeOf(func));
    if (!inst || inst.family !== family) continue;
    const ret = returnSigType(func.returnType);
    const returnType = genericSpelling(ret, inst);
    const params = declaredParameters(func).map(p => ({ type: genericSpelling(p.type, inst), name: p.name }));
    for (const s of [returnType, ...params.map(p => p.type)]) plainTypeNames(s, mentioned);
    const name = emittedFunctionName(func, ret);
    const key = `${name}(${params.map(p => p.type).join(',')}${func.hasVarArgs ? ',...' : ''})`;
    const convention = conventionKeyword(func.callingConvention);
    let list = params.map(p => `${p.type} ${p.name}`).join(', ');
    if (func.hasVarArgs) list = list ? `${list}, ...` : '...';
    const line = `    ${memberStorage(registry, func)}${returnType} ${convention ? `${convention} ` : ''}${name}(${list});`;
    const held = decls.get(key);
    if (!held) {
      decls.set(key, { key, returnType, line });
    } else if (held.returnType !== returnType) {
      problems.push(`${family.name}::${key} returns ${held.returnType} in one instantiation and ${returnType} in ${inst.ghidra}`);
    }
  }
  return [...decls.values()].map(d => d.line);
}

/** The primary template's static data members: one per datum name its instantiations carry. */
function genericData(
  family: TemplateFamily,
  data: readonly AnalyzedDataSymbol[],
  registry: TemplateRegistry,
  problems: string[],
): string[] {
  const decls = new Map<string, string>();
  for (const g of data) {
    const inst = registry.instantiation(scopeOf(g));
    if (!inst || inst.family !== family) continue;
    const name = sanitizeSymbolName(g.suggestedName || g.name);
    const declarator = globalDeclarator(g, name);
    // A datum's type never names the instantiation here (vftables, their meta
    // words); one that did would need its own respelling over the parameters.
    if (declarator.includes('<')) problems.push(`${inst.ghidra}::${name}: ${declarator} names a template`);
    const held = decls.get(name);
    if (held === undefined) decls.set(name, declarator);
    else if (held !== declarator) problems.push(`${family.name}::${name} is ${held} in one instantiation and ${declarator} in ${inst.ghidra}`);
  }
  return [...decls.values()].map(d => `    static ${d};`);
}

function renderPrimary(
  layout: FamilyLayout,
  members: readonly ExtractedFunction[],
  data: readonly AnalyzedDataSymbol[],
  registry: TemplateRegistry,
  problems: string[],
  mentioned: Set<string>,
): string {
  const { family } = layout;
  const all: StructField[] = layout.fields.map(f => ({
    name: f.name,
    dataType: f.dataType,
    offset: f.offset,
    size: 0,
    comment: f.comment ?? null,
  } as unknown as StructField));
  // The layout check (layout.ts) already holds the base to project.json's.
  const base = baseComponentOf(registry, all);
  const fields = ownFields(registry, all);
  const lines: string[] = [templateHead(family), `${family.key} ${family.name}${base ? ` : public ${base.type}` : ''} {`, 'public:'];
  if (layout.vtable) {
    lines.push(`    struct ${VTABLE_MEMBER_TYPE} {`);
    const hexWidth = Math.max(2, Math.max(...layout.vtable.map(s => s.offset)).toString(16).length);
    for (const slot of layout.vtable) {
      for (const s of [slot.returnType, ...slot.params]) plainTypeNames(s, mentioned);
      const off = `0x${slot.offset.toString(16).toUpperCase().padStart(hexWidth, '0')}`;
      const convention = conventionKeyword(slot.callingConvention);
      const comment = slot.comment ? ` // ${slot.comment.replace(/\s*\n\s*/g, ' ')}` : '';
      lines.push(`        /* ${off} */ ${slot.returnType} (${convention ? `${convention} ` : ''}*${slot.name})(${slot.params.join(', ')});${comment}`);
    }
    lines.push('    };');
    lines.push('');
  }
  for (const f of layout.fields) plainTypeNames(f.dataType, mentioned);
  emitFieldLines(fields, lines);
  const statics = [...genericData(family, data, registry, problems), ...genericMembers(family, members, registry, problems, mentioned)];
  if (statics.length > 0) {
    lines.push('');
    lines.push(...statics);
  }
  lines.push('};');
  return lines.join('\n');
}

/**
 * A key class (a non-template class the header defines, `HASHKEY_STRI`): its
 * Ghidra struct, with its members declared inside it.
 */
function renderKeyClass(
  registry: TemplateRegistry,
  struct: ExtractedStruct,
  members: readonly ExtractedFunction[],
  mentioned: Set<string>,
): string {
  const lines: string[] = classHead(struct.name);
  emitFieldLines(struct.fields, lines);
  for (const f of struct.fields) plainTypeNames(f.dataType, mentioned);
  const own = members.filter(f => scopeOf(f) === struct.name);
  const seen = new Set<string>();
  const decls: string[] = [];
  for (const func of own) {
    const ret = returnSigType(func.returnType);
    const params = declaredParameters(func);
    for (const s of [ret, ...params.map(p => p.type)]) plainTypeNames(s, mentioned);
    const name = emittedFunctionName(func, ret);
    let list = params.map(p => `${p.type} ${p.name}`).join(', ');
    if (func.hasVarArgs) list = list ? `${list}, ...` : '...';
    const key = `${name}(${list})`;
    if (seen.has(key)) continue;
    seen.add(key);
    const convention = conventionKeyword(func.callingConvention);
    decls.push(`    ${memberStorage(registry, func)}${ret} ${convention ? `${convention} ` : ''}${name}(${list});`);
  }
  if (decls.length > 0) {
    lines.push('');
    lines.push(...decls);
  }
  lines.push('};');
  return lines.join('\n');
}

export function generateTemplateHeader(input: TemplateHeaderInput): string {
  const { registry, dataTypes, options } = input;
  const members = [...input.members].sort((a, b) => addressValue(a.address) - addressValue(b.address));
  const data = [...input.data].sort((a, b) => addressValue(a.address) - addressValue(b.address));
  const layouts = deriveFamilyLayouts(registry, dataTypes);
  const problems: string[] = [];
  const mentioned = new Set<string>();

  const structs = new Map<string, ExtractedStruct>();
  for (const dt of dataTypes) if (dt.kind === 'STRUCTURE') structs.set(dt.name, dt as ExtractedStruct);

  const keyClasses = [...registry.keyClasses].sort().map(name => {
    const struct = structs.get(name);
    if (!struct) throw new Error(`[templates] key class ${name} has no struct in the program`);
    return renderKeyClass(registry, struct, members, mentioned);
  });
  const primaries = definitionOrder(registry, layouts).map(layout => renderPrimary(layout, members, data, registry, problems, mentioned));

  // The explicit specializations, instantiation by instantiation.
  const specializations: string[] = [];
  for (const inst of registry.instantiations()) {
    const own = members.filter(f => scopeOf(f) === inst.spelling);
    const ownData = data.filter(g => scopeOf(g) === inst.spelling);
    if (own.length === 0 && ownData.length === 0) continue;
    // The class each specialization is qualified by names its arguments.
    plainTypeNames(inst.spelling, mentioned);
    specializations.push(`// ${inst.spelling}`);
    for (const g of ownData) {
      const name = `${inst.spelling}::${sanitizeSymbolName(g.suggestedName || g.name)}`;
      specializations.push(`${globalEvidenceComment(g)}template<> ${globalDeclarator(g, name)};`);
    }
    for (const func of own) {
      for (const t of [returnSigType(func.returnType), ...declaredParameters(func).map(p => p.type)]) plainTypeNames(t, mentioned);
      specializations.push(generateFunctionDeclaration(func, options));
    }
    specializations.push('');
  }
  // The orphan copies: free functions, declared after the classes they sit in.
  const orphans = members.filter(f => registry.isOrphan(f.address));
  if (orphans.length > 0) {
    specializations.push('// COMDAT copies no member owns');
    for (const func of orphans) {
      for (const t of [returnSigType(func.returnType), ...declaredParameters(func).map(p => p.type)]) plainTypeNames(t, mentioned);
      specializations.push(orphanMarker(func)!);
      specializations.push(generateFunctionDeclaration(func, options));
    }
    specializations.push('');
  }
  if (problems.length > 0) {
    throw new Error(`[templates] the instantiations of a family disagree on a member; unify them in Ghidra:\n  ${problems.join('\n  ')}`);
  }

  // What the templates name without defining: element structs by pointer, and a
  // funcdef typedef or two in a signature.
  const params = new Set(registry.families().flatMap(f => f.params.map(p => p.name)));
  const kinds = new Map(dataTypes.map(dt => [dt.name, dt.kind]));
  const named = [...mentioned].sort().filter(name => !params.has(name) && !registry.keyClasses.has(name) && name !== VTABLE_MEMBER_TYPE);
  const includes = new Set<string>();
  for (const name of named) {
    const owner = kinds.get(name) === 'TYPEDEF' ? input.ownerOf(name) : undefined;
    if (owner) includes.add(owner);
  }
  // An argument a template holds by value has to be complete where the instantiation is.
  for (const inst of registry.instantiations()) {
    const layout = layouts.get(inst.family.name);
    if (!layout) continue;
    inst.args.forEach((arg, i) => {
      const param = inst.family.params[i].name;
      if (arg.kind !== 'type' || !layout.fields.some(f => f.dataType === param)) return;
      if (registry.keyClasses.has(arg.spelling) || registry.instantiation(arg.spelling)) return;
      const owner = input.ownerOf(arg.spelling);
      if (owner) includes.add(owner);
    });
  }
  const forward: string[] = [];
  const typedefs: string[] = [];
  for (const name of named) {
    const kind = kinds.get(name);
    // A class an included header defines needs no declaration of its own.
    const owner = input.ownerOf(name);
    if ((kind === 'STRUCTURE' || kind === 'UNION') && owner && includes.has(owner)) continue;
    if (kind === 'STRUCTURE') forward.push(`${classKeyOf(name)} ${name};`);
    else if (kind === 'UNION') forward.push(`union ${name};`);
    else if (kind === 'FUNCTION_DEFINITION') {
      const typedef = guardedFuncDefTypedef(name);
      if (typedef) typedefs.push(typedef);
    }
  }
  const out: string[] = [input.base.trimEnd(), ''];
  for (const inc of [...includes].sort()) out.push(`#include "${inc}"`);
  if (includes.size > 0) out.push('');
  out.push('// Class templates');
  for (const family of registry.families()) {
    if (!registry.instantiations().some(i => i.family === family)) continue;
    out.push(`${templateHead(family)} ${family.key} ${family.name};`);
  }
  out.push('');
  if (forward.length > 0) {
    out.push(...forward);
    out.push('');
  }
  for (const t of typedefs) out.push(t);
  if (typedefs.length > 0) out.push('');
  for (const k of keyClasses) {
    out.push(k);
    out.push('');
  }
  for (const p of primaries) {
    out.push(p);
    out.push('');
  }
  out.push('// Members, one explicit specialization per address');
  out.push('');
  out.push(...specializations);
  return out.join('\n').trimEnd() + '\n';
}

