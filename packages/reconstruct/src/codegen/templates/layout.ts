/**
 * The primary template's layout, derived from Ghidra's per-instantiation structs.
 *
 * Ghidra holds one struct per instantiation (`TSHashTable<CELLIST,HASHKEY_NONE>`,
 * `TSHashTable<SGAMEDATA,HASHKEY_NONE>`, ...). A class template has ONE layout, so
 * it is derived only when every instantiation of a family agrees on it: the same
 * members, in the same order, at the same offsets, whose types are the same once
 * each instantiation's arguments are replaced by the family's parameters. Where
 * they do not agree, Ghidra is missing a unification, and the run stops with the
 * list - the layout is never picked from one instantiation.
 *
 * Ghidra's own filler bytes (unnamed `undefined` components in the slack before
 * an aligned member or at the tail) are not members: `TSHashObject<T,HASHKEY_NONE>`
 * pads 21 to 24 with three of them, where `TSHashObject<T,HASHKEY_STRI>` has a
 * 4-byte key and none. The compiler lays the slack out itself; the layout check's
 * static asserts are what prove it lands where Ghidra has it.
 */

import type { ExtractedDataType, ExtractedFunctionDefinition, ExtractedStruct, StructField } from '../../types.js';
import { NodeKind } from '@ghidra-mcp/cpp-parser';
import type { ASTNode, Identifier, QualifiedId, TypeNode, TypedefType } from '@ghidra-mcp/cpp-parser';
import { parseTypeSpelling, spellType, substituteType, templateIdOf } from './identity.js';
import { returnSigType, sigType } from '../header.js';
import type { TemplateFamily, TemplateInstantiation, TemplateRegistry } from './registry.js';
import { baseComponentOf } from './bases.js';

/**
 * The member type a registered class's vtable struct is emitted under: the
 * extraction names a class's vtable `<Owner>Vtable` (modules/vtable-types.ts),
 * and inside the class the owner is implied.
 */
export const VTABLE_MEMBER_TYPE = 'Vtable';

export interface GenericField {
  name: string;
  /** Spelled over the family's parameters. */
  dataType: string;
  offset: number;
  comment?: string;
}

export interface GenericSlot {
  name: string;
  offset: number;
  returnType: string;
  params: string[];
  callingConvention?: string;
  comment?: string;
}

export interface FamilyLayout {
  family: TemplateFamily;
  /** The instantiations whose struct the layout was derived from. */
  from: TemplateInstantiation[];
  fields: GenericField[];
  /** The class's vtable, when its instantiations have one. */
  vtable?: GenericSlot[];
}

/** Each argument's spelling, mapped to the parameter it instantiates. */
export function parameterSubstitution(inst: TemplateInstantiation): Map<string, string> {
  const map = new Map<string, string>();
  inst.args.forEach((arg, i) => map.set(arg.spelling, inst.family.params[i].name));
  return map;
}

/**
 * A type spelled for one instantiation, respelled over its family's parameters.
 * A member type of the class itself (`TSHashTable<CELLIST, HASHKEY_NONE>::vtable *`)
 * loses the qualifier, because inside the template it is just `vtable *`.
 */
export function genericSpelling(spelling: string, inst: TemplateInstantiation): string {
  const type = parseTypeSpelling(spelling);
  if (!type) throw new Error(`[templates] ${inst.spelling}: cannot read the type ${spelling}`);
  return spellType(dropOwnQualifier(substituteType(type, parameterSubstitution(inst)), inst));
}

function dropOwnQualifier(type: TypeNode, inst: TemplateInstantiation): TypeNode {
  const t = type as TypeNode & { pointee?: TypeNode; name?: ASTNode };
  if (type.kind === NodeKind.PointerType && t.pointee) {
    return { ...t, pointee: dropOwnQualifier(t.pointee, inst) } as TypeNode;
  }
  if (type.kind !== NodeKind.TypedefType || t.name?.kind !== NodeKind.QualifiedId) return type;
  const q = t.name as unknown as QualifiedId;
  if (q.qualifier.length !== 1 || q.isGlobal) return type;
  const qualifier = q.qualifier[0] as unknown as ASTNode;
  if (qualifier.kind !== NodeKind.TemplateType) return type;
  const own = templateIdOf({ kind: NodeKind.TypedefType, name: qualifier } as unknown as TypedefType);
  if (!own || spellType({ kind: NodeKind.TypedefType, name: own } as unknown as TypeNode) !== ownGenericSpelling(inst)) return type;
  return { ...t, name: q.name as Identifier } as TypeNode;
}

/** `TSHashTable<T, TKey>`: the family over its own parameters. */
export function ownGenericSpelling(inst: TemplateInstantiation): string {
  return genericSpelling(inst.spelling, { ...inst, spelling: inst.spelling });
}

/** Ghidra's filler byte: an unnamed `undefined` component. The class template has none. */
export function isFiller(f: StructField): boolean {
  const t = (f.dataType ?? '').trim();
  return !f.name && /^undefined\d?$/.test(t);
}

/**
 * Derive every family's layout. Throws, listing each disagreement, when the
 * instantiations of a family do not agree.
 */
export function deriveFamilyLayouts(registry: TemplateRegistry, dataTypes: readonly ExtractedDataType[]): Map<string, FamilyLayout> {
  const structs = new Map<string, ExtractedStruct>();
  for (const dt of dataTypes) if (dt.kind === 'STRUCTURE') structs.set(dt.name, dt as ExtractedStruct);
  const funcDefs = new Map<string, ExtractedFunctionDefinition>();
  for (const dt of dataTypes) if (dt.kind === 'FUNCTION_DEFINITION') funcDefs.set(dt.name, dt as ExtractedFunctionDefinition);

  const byFamily = new Map<string, TemplateInstantiation[]>();
  for (const inst of registry.instantiations()) {
    if (!structs.has(inst.spelling)) continue;
    const list = byFamily.get(inst.family.name) ?? [];
    list.push(inst);
    byFamily.set(inst.family.name, list);
  }

  const problems: string[] = [];
  const layouts = new Map<string, FamilyLayout>();
  for (const [familyName, insts] of byFamily) {
    const family = insts[0].family;
    const shapes = insts.map(inst => ({
      inst,
      fields: structs.get(inst.spelling)!.fields.filter(f => !isFiller(f)).map(f => ({
        name: f.name ?? '',
        dataType: genericSpelling(f.dataType, inst),
        offset: f.offset,
        comment: f.comment ?? undefined,
      })),
    }));
    const ref = shapes[0];
    for (const other of shapes.slice(1)) {
      const a = ref.fields.map(f => `${f.name}@${f.offset}:${f.dataType}`);
      const b = other.fields.map(f => `${f.name}@${f.offset}:${f.dataType}`);
      if (a.join('|') !== b.join('|')) {
        problems.push(`${familyName}: ${ref.inst.ghidra} {${a.join(', ')}} vs ${other.inst.ghidra} {${b.join(', ')}}`);
      }
    }
    // The base project.json registers is the one Ghidra models: the first
    // member, `super_<Family>` at offset 0 (templates/bases.ts).
    const component = baseComponentOf(registry, ref.fields as unknown as StructField[]);
    if (family.base) {
      const first = ref.fields[0];
      const base = parseTypeSpelling(family.base);
      const baseSpelling = base ? spellType(base) : family.base;
      if (!component || component.type !== baseSpelling) {
        problems.push(`${familyName}: project.json gives the base ${baseSpelling}, the first member is ${first ? `${first.name}@${first.offset}: ${first.dataType}` : 'missing'}`);
      }
    } else if (component) {
      problems.push(`${familyName}: Ghidra models the base ${component.type} (${component.field.name}), project.json registers none`);
    }
    const fields = ref.fields.map((f, i) => ({
      ...f,
      comment: agreedComment(shapes.map(s => s.fields[i]?.comment)),
    }));
    const vtable = deriveVtable(insts, structs, funcDefs, problems);
    layouts.set(familyName, { family, from: insts, fields, vtable });
  }
  if (problems.length > 0) {
    throw new Error(`[templates] the instantiations of a family disagree on its layout; unify them in Ghidra:\n  ${problems.join('\n  ')}`);
  }
  return layouts;
}

/** One comment for a generic member: the one every instantiation that has one agrees on. */
function agreedComment(comments: Array<string | undefined>): string | undefined {
  const distinct = [...new Set(comments.filter((c): c is string => !!c && c.trim().length > 0))];
  return distinct.length === 1 ? distinct[0] : undefined;
}

/** The vtable struct of an instantiation, by the name the extraction gave it. */
export function vtableStructOf(inst: TemplateInstantiation, structs: ReadonlyMap<string, ExtractedStruct>): ExtractedStruct | undefined {
  return structs.get(`${inst.spelling}::${VTABLE_MEMBER_TYPE}`);
}

function deriveVtable(
  insts: TemplateInstantiation[],
  structs: ReadonlyMap<string, ExtractedStruct>,
  funcDefs: ReadonlyMap<string, ExtractedFunctionDefinition>,
  problems: string[],
): GenericSlot[] | undefined {
  const tables = insts.map(inst => ({ inst, table: vtableStructOf(inst, structs) }));
  const present = tables.filter(t => t.table);
  if (present.length === 0) return undefined;
  if (present.length !== tables.length) {
    problems.push(`${insts[0].family.name}: only ${present.map(t => t.inst.ghidra).join(', ')} have a vtable`);
    return undefined;
  }
  const shapes: GenericSlot[][] = [];
  for (const { inst, table } of present) {
    const slots: GenericSlot[] = [];
    for (const f of table!.fields) {
      const fd = funcDefs.get((f.dataType ?? '').replace(/\s*\*\s*$/, '').trim());
      if (!fd) {
        problems.push(`${inst.ghidra}::${VTABLE_MEMBER_TYPE}.${f.name}: ${f.dataType} is not a function definition`);
        return undefined;
      }
      slots.push({
        name: f.name ?? '',
        offset: f.offset,
        returnType: genericSpelling(returnSigType(fd.returnType), inst),
        params: fd.parameters.map(p => genericSpelling(sigType(p.dataType), inst)),
        callingConvention: fd.callingConvention,
        comment: f.comment ?? undefined,
      });
    }
    shapes.push(slots);
  }
  const spell = (s: GenericSlot[]) => s.map(x => `${x.name}@${x.offset}:${x.returnType}(${x.params.join(',')})${x.callingConvention ?? ''}`).join('|');
  for (const [i, other] of shapes.entries()) {
    if (i > 0 && spell(other) !== spell(shapes[0])) {
      problems.push(`${insts[0].family.name}::${VTABLE_MEMBER_TYPE}: ${present[0].inst.ghidra} {${spell(shapes[0])}} vs ${present[i].inst.ghidra} {${spell(other)}}`);
    }
  }
  return shapes[0].map((slot, i) => ({ ...slot, comment: agreedComment(shapes.map(s => s[i]?.comment)) }));
}
