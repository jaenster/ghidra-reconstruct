/**
 * The registered class templates: which Ghidra namespaces and types are
 * instantiations of a class template the tree defines for real.
 *
 * The families, their parameter kinds and their class keys come from
 * project.json's `templates` section; the binary keeps only class names and
 * argument values, so the PARAMETER NAMES there are ours. Every instantiation
 * is found in the model (a namespace or type spelled `Family<args>`), and each
 * one the binary carries an RTTI type descriptor for (`.?AV?$TSHashTable@...`)
 * is checked against it: the class key, the family and every argument must be
 * what the descriptor says, or the run stops. The class key of every class an
 * argument names is the descriptor's too, and the tree declares the class with
 * it (classKeyOf).
 */

import type { TemplatesConfig } from '../../config/schema.js';
import type { BaseModel } from './bases.js';
import type { MemberModel } from './members.js';
import { parseTypeSpelling, spellType, stripRootQualifiers, templateArguments, templateIdOf, templateIdsIn, templateName, type TemplateArgValue } from './identity.js';

export interface TemplateParam {
  name: string;
  kind: 'type' | 'int';
}

export interface TemplateFamily {
  name: string;
  key: 'class' | 'struct';
  params: TemplateParam[];
  /** The base class, spelled over the family's own parameters. */
  base?: string;
}

export interface TemplateInstantiation {
  /** As Ghidra spells it: `TSHashTable<CELLIST,HASHKEY_NONE>`. */
  ghidra: string;
  /** As the tree spells it: `TSHashTable<CELLIST, HASHKEY_NONE>`. */
  spelling: string;
  family: TemplateFamily;
  args: TemplateArgValue[];
  /** The element class the instantiation is ultimately over: `CELLIST`. */
  element: string;
}

/** The Ghidra function tag that marks a COMDAT copy no member owns. */
export const ORPHAN_COPY_TAG = 'ORPHAN_COPY';

export class TemplateRegistry {
  readonly header: string;
  readonly implPrefix: string;
  readonly keyClasses: ReadonlySet<string>;
  private readonly keyClassKeys: ReadonlyMap<string, ClassKey>;
  /** The class key of every class a registered family's descriptor names as an argument. */
  private readonly argumentClassKeys = new Map<string, ClassKey>();
  private readonly familyByName: ReadonlyMap<string, TemplateFamily>;
  private readonly bySpelling = new Map<string, TemplateInstantiation>();
  private readonly ordered: TemplateInstantiation[] = [];

  private readonly orphanAddresses = new Set<string>();

  private constructor(config: TemplatesConfig) {
    this.header = config.header;
    this.implPrefix = config.implPrefix ?? '';
    this.keyClassKeys = new Map(Object.entries(config.classes ?? {}).map(([name, c]) => [name, c.key]));
    this.keyClasses = new Set(this.keyClassKeys.keys());
    const families = new Map<string, TemplateFamily>();
    for (const [name, f] of Object.entries(config.families)) {
      families.set(name, { name, key: f.key, params: f.params.map(p => ({ name: p.name, kind: p.kind })), base: f.base });
    }
    this.familyByName = families;
  }

  /**
   * Register every instantiation among `spellings` (Ghidra names of namespaces,
   * types and field types), then check them against the RTTI descriptors.
   */
  static build(config: TemplatesConfig, spellings: Iterable<string>, rttiNames: Iterable<string> = []): TemplateRegistry {
    const registry = new TemplateRegistry(config);
    // The allowlist is compared in the tree's spelling, so Ghidra's and ours both match.
    const allow = config.instantiations
      ? new Set(config.instantiations.map(s => {
          const t = parseTypeSpelling(s);
          if (!t) throw new Error(`[templates] instantiations: ${s} is not a type`);
          return spellType(t);
        }))
      : undefined;
    for (const s of [...new Set(spellings)].sort()) {
      const t = s.includes('<') ? parseTypeSpelling(s) : undefined;
      if (!t || (allow && !allow.has(spellType(t)))) continue;
      registry.register(s, allow);
    }
    registry.checkRtti(rttiNames);
    return registry;
  }

  family(name: string): TemplateFamily | undefined {
    return this.familyByName.get(name);
  }

  families(): TemplateFamily[] {
    return [...this.familyByName.values()];
  }

  /** The instantiation a spelling names, in Ghidra's or the tree's spelling. */
  instantiation(spelling: string | null | undefined): TemplateInstantiation | undefined {
    return spelling ? this.bySpelling.get(spelling) : undefined;
  }

  /** Every registered instantiation, in a stable order. */
  instantiations(): readonly TemplateInstantiation[] {
    return this.ordered;
  }

  /** A namespace whose symbols are members of a class the template header defines. */
  isClassScope(namespace: string | null | undefined): boolean {
    if (!namespace) return false;
    return this.bySpelling.has(namespace) || this.keyClasses.has(namespace);
  }

  private placement: ReadonlyMap<string, string> = new Map();
  private baseInfo: BaseModel | undefined;

  /** Record the model's base relations (templates/bases.ts). */
  setBases(model: BaseModel): void {
    this.baseInfo = model;
  }

  /** The model's base relations, once recorded. */
  bases(): BaseModel | undefined {
    return this.baseInfo;
  }

  private memberInfo: MemberModel | undefined;

  /** Record which members are non-static (templates/members.ts). */
  setMembers(model: MemberModel): void {
    this.memberInfo = model;
  }

  /** The non-static members, once recorded. */
  members(): MemberModel | undefined {
    return this.memberInfo;
  }

  /** A non-static member function: declared without its receiver, which its body calls `this`. */
  isInstanceMember(address: string | undefined): boolean {
    return !!address && !!this.memberInfo?.instanceAddresses.has(address);
  }

  /** A member name that is a base-class component (`super_TSHashTable`), which the tree declares as a base. */
  isBaseComponent(name: string | null | undefined): boolean {
    return !!name && !!this.baseInfo?.componentNames.includes(name);
  }

  /**
   * Record which functions are orphan copies: Ghidra tags each one ORPHAN_COPY.
   * Every tagged function sits in a registered class or in the element class an
   * instantiation is over (`CELLIST::Destructor_Unreferenced`); a tag anywhere
   * else stops the run.
   */
  findOrphans(functions: Iterable<{ address: string; name: string; namespace?: string | null; tags?: ReadonlyArray<{ type: string }> }>): void {
    this.orphanAddresses.clear();
    const elements = new Set(this.ordered.map(inst => inst.element));
    const stray: string[] = [];
    for (const f of functions) {
      if (!f.tags?.some(t => t.type === ORPHAN_COPY_TAG)) continue;
      if (this.isClassScope(f.namespace) || (f.namespace && elements.has(f.namespace))) this.orphanAddresses.add(f.address);
      else stray.push(`${f.address} ${f.namespace ? `${f.namespace}::` : ''}${f.name}`);
    }
    if (stray.length > 0) {
      throw new Error(`[templates] tagged ${ORPHAN_COPY_TAG} outside every registered class and element: ${stray.join(', ')}`);
    }
  }

  /** A COMDAT copy no member owns: emitted as a free function, not a member. */
  isOrphan(address: string | undefined): boolean {
    return !!address && this.orphanAddresses.has(address);
  }

  /** Record where each member is defined (templates/placement.ts). */
  setPlacement(placement: ReadonlyMap<string, string>): void {
    this.placement = placement;
  }

  /** The unit that defines the member at this address. */
  unitOf(address: string): string | undefined {
    return this.placement.get(address);
  }

  private readonly treeTypeCache = new Map<string, boolean>();

  /**
   * Is this a type the tree can spell as written: every template-id in it, at any
   * depth (an argument, the qualifier of a member type), a registered instantiation
   * in the tree's own spelling.
   */
  isTreeType(spelling: string): boolean {
    const hit = this.treeTypeCache.get(spelling);
    if (hit !== undefined) return hit;
    const parsed = parseTypeSpelling(spelling);
    const type = parsed ? stripRootQualifiers(parsed) : undefined;
    let ok = !!type;
    if (type) {
      const ids = templateIdsIn(type);
      ok = ids.length > 0 && ids.every(id => this.bySpelling.get(id)?.spelling === id);
    }
    this.treeTypeCache.set(spelling, ok);
    return ok;
  }

  /**
   * The class key the tree declares a plain class name with: project.json's for a
   * key class, else the RTTI descriptors' for a class they name as a template
   * argument. Undefined for any other name.
   */
  classKey(name: string): ClassKey | undefined {
    return this.keyClassKeys.get(name) ?? this.argumentClassKeys.get(name);
  }

  /** The tree's spelling of a registered class scope. */
  scopeSpelling(namespace: string): string | undefined {
    return this.bySpelling.get(namespace)?.spelling ?? (this.keyClasses.has(namespace) ? namespace : undefined);
  }

  private register(ghidra: string, allow: ReadonlySet<string> | undefined): TemplateInstantiation | undefined {
    if (!ghidra.includes('<')) return undefined;
    const type = parseTypeSpelling(ghidra);
    const id = templateIdOf(type);
    if (!type || !id) return undefined;
    const familyName = templateName(id);
    const family = familyName ? this.familyByName.get(familyName) : undefined;
    if (!family) return undefined;
    const spelling = spellType(type);
    const known = this.bySpelling.get(spelling);
    if (known) {
      // First reached as another instantiation's argument; keep Ghidra's own spelling.
      if (ghidra !== spelling) {
        known.ghidra = ghidra;
        this.bySpelling.set(ghidra, known);
      }
      return known;
    }
    if (allow && !allow.has(spelling)) {
      throw new Error(`[templates] ${ghidra} is used by a registered instantiation but is not registered itself`);
    }
    const args = templateArguments(id);
    if (!args || args.length !== family.params.length) {
      throw new Error(`[templates] ${ghidra}: ${family.name} takes ${family.params.length} argument(s) (${family.params.map(p => p.kind).join(', ')})`);
    }
    args.forEach((arg, i) => {
      const kind = family.params[i].kind === 'int' ? 'value' : 'type';
      if (arg.kind !== kind) {
        throw new Error(`[templates] ${ghidra}: argument ${i + 1} (${arg.spelling}) is not ${family.params[i].kind === 'int' ? 'an integer' : 'a type'}`);
      }
    });
    // An argument that is itself an instantiation of a registered family is
    // registered with it, or the two spellings would be treated differently.
    let element: string | undefined;
    for (const [i, arg] of args.entries()) {
      if (arg.kind !== 'type') continue;
      const nested = this.register(arg.spelling, allow);
      if (nested && i === 0) element = nested.element;
    }
    const first = args[0];
    element ??= first.kind === 'type' ? first.spelling : family.name;
    const inst: TemplateInstantiation = { ghidra, spelling, family, args, element };
    this.bySpelling.set(ghidra, inst);
    this.bySpelling.set(spelling, inst);
    this.ordered.push(inst);
    return inst;
  }

  /**
   * Every descriptor of a registered family must agree with the instantiation it
   * names, and every class its arguments name must have one class key: the one
   * project.json gives a family or key class, and the one any other descriptor of
   * that class (`.?AVCCritSect@@`) records.
   */
  private checkRtti(rttiNames: Iterable<string>): void {
    const names = [...rttiNames];
    const seen = new Map<string, { key: ClassKey; raw: string }>();
    const record = (name: string, key: ClassKey, raw: string): void => {
      const held = seen.get(name);
      if (held && held.key !== key) {
        throw new Error(`[templates] RTTI ${raw}: ${name} is a ${key}, RTTI ${held.raw} says ${held.key}`);
      }
      seen.set(name, { key, raw });
      const id = name.includes('<') ? templateIdOf(parseTypeSpelling(name)) : undefined;
      const familyName = id ? templateName(id) : undefined;
      const family = familyName ? this.familyByName.get(familyName) : undefined;
      const configured = id ? family?.key : this.keyClassKeys.get(name);
      if (configured !== undefined && configured !== key) {
        throw new Error(`[templates] RTTI ${raw}: ${family?.name ?? name} is a ${key}, project.json says ${configured}`);
      }
      if (!id && configured === undefined) this.argumentClassKeys.set(name, key);
    };
    const visitArguments = (args: DemangledTemplate['args'], raw: string): void => {
      for (const a of args) {
        if (a.kind !== 'type' || !a.classKey || !a.className) continue;
        record(a.className, a.classKey, raw);
        if (a.nested) visitArguments(a.nested, raw);
      }
    };
    for (const raw of names) {
      const d = demangleRttiTemplate(raw);
      if (!d) continue;
      const family = this.familyByName.get(d.family);
      if (!family) continue;
      if (d.key !== family.key) {
        throw new Error(`[templates] RTTI ${raw}: ${d.family} is a ${d.key}, project.json says ${family.key}`);
      }
      if (d.args.length !== family.params.length) {
        throw new Error(`[templates] RTTI ${raw}: ${d.args.length} argument(s), project.json gives ${d.family} ${family.params.length}`);
      }
      d.args.forEach((a, i) => {
        if ((a.kind === 'value') !== (family.params[i].kind === 'int')) {
          throw new Error(`[templates] RTTI ${raw}: argument ${i + 1} kind disagrees with ${family.params[i].name}`);
        }
      });
      visitArguments(d.args, raw);
      const spelling = spellType(parseTypeSpelling(d.spelling)!);
      const inst = this.bySpelling.get(spelling);
      // A descriptor for an instantiation the allowlist leaves out is not checked.
      if (!inst) continue;
      if (inst.spelling !== spelling) {
        throw new Error(`[templates] RTTI ${raw} names ${spelling}, the model has ${inst.spelling}`);
      }
    }
    // A class's own descriptor, and a key class nothing names as an argument.
    for (const raw of names) {
      const plain = demangleRttiClass(raw);
      if (plain && (seen.has(plain.name) || this.keyClassKeys.has(plain.name))) record(plain.name, plain.key, raw);
    }
  }
}

export type ClassKey = 'class' | 'struct';

/** A demangled `.?AV?$Name@args@@` RTTI type descriptor name. */
export interface DemangledTemplate {
  key: ClassKey;
  family: string;
  args: DemangledArgument[];
  /** `Name<args>`, the arguments spelled as C++ spells them. */
  spelling: string;
}

export interface DemangledArgument {
  kind: 'type' | 'value';
  spelling: string;
  /** A class argument, or a pointer to one: the class's name and the key its code records (`U` struct, `V` class). */
  className?: string;
  classKey?: ClassKey;
  /** The arguments of a class argument that is itself a template-id. */
  nested?: DemangledArgument[];
}

/** A demangled `.?AVName@@` / `.?AUName@@` descriptor of a plain, unqualified class. */
export function demangleRttiClass(raw: string): { key: ClassKey; name: string } | undefined {
  const m = /^\.\?A([UV])([A-Za-z_]\w*)@@$/.exec(raw);
  return m ? { key: m[1] === 'U' ? 'struct' : 'class', name: m[2] } : undefined;
}

/**
 * Demangle the MSVC type descriptor name of a class template instantiation.
 * Covers what Storm's descriptors use: class and struct arguments (`U`/`V`),
 * pointers to them (`PAU`/`PAV`), nested template-ids and integer values
 * (`$0A@` is 0, `$0BA@` 16, `$0?CCCCCCCD@` -0x22222223). Anything else is not
 * a descriptor this check reads, and gives undefined.
 */
export function demangleRttiTemplate(raw: string): DemangledTemplate | undefined {
  const m = /^\.\?A([UV])(\?\$.*)$/.exec(raw);
  if (!m) return undefined;
  const cursor = { s: m[2], i: 0 };
  try {
    const t = readTemplateName(cursor);
    if (cursor.s[cursor.i] !== '@' || cursor.i + 1 !== cursor.s.length) return undefined;
    return { key: m[1] === 'U' ? 'struct' : 'class', family: t.family, args: t.args, spelling: t.spelling };
  } catch {
    return undefined;
  }
}

interface Cursor { s: string; i: number }

function expect(c: Cursor, text: string): void {
  if (!c.s.startsWith(text, c.i)) throw new Error(`expected ${text}`);
  c.i += text.length;
}

function readIdentifier(c: Cursor): string {
  const end = c.s.indexOf('@', c.i);
  if (end < 0) throw new Error('unterminated name');
  const id = c.s.slice(c.i, end);
  c.i = end + 1;
  if (!/^[A-Za-z_]\w*$/.test(id)) throw new Error(`bad name ${id}`);
  return id;
}

/** `?$Name@<args>@` */
function readTemplateName(c: Cursor): { family: string; args: DemangledArgument[]; spelling: string } {
  expect(c, '?$');
  const family = readIdentifier(c);
  const args: DemangledArgument[] = [];
  while (c.s[c.i] !== '@') args.push(readArgument(c));
  c.i++;
  return { family, args, spelling: `${family}<${args.map(a => a.spelling).join(',')}>` };
}

/** A qualified class name ending in `@`: `CELLIST@@`, or `?$T@args@@`. */
function readClassName(c: Cursor): { name: string; nested?: DemangledArgument[] } {
  const t = c.s.startsWith('?$', c.i) ? readTemplateName(c) : undefined;
  const name = t ? t.spelling : readIdentifier(c);
  expect(c, '@');
  return { name, nested: t?.args };
}

function readArgument(c: Cursor): DemangledArgument {
  const ch = c.s[c.i];
  if (ch === 'U' || ch === 'V') {
    c.i++;
    const { name, nested } = readClassName(c);
    return { kind: 'type', spelling: name, className: name, classKey: ch === 'U' ? 'struct' : 'class', ...(nested && { nested }) };
  }
  if (c.s.startsWith('PAU', c.i) || c.s.startsWith('PAV', c.i)) {
    const classKey: ClassKey = c.s[c.i + 2] === 'U' ? 'struct' : 'class';
    c.i += 3;
    const { name, nested } = readClassName(c);
    return { kind: 'type', spelling: `${name}*`, className: name, classKey, ...(nested && { nested }) };
  }
  if (c.s.startsWith('$0', c.i)) {
    c.i += 2;
    let negative = false;
    if (c.s[c.i] === '?') { negative = true; c.i++; }
    let value: number;
    const d = c.s[c.i];
    if (d >= '0' && d <= '9') {
      value = d.charCodeAt(0) - 47;
      c.i++;
    } else {
      value = 0;
      while (c.s[c.i] !== '@') {
        const code = c.s.charCodeAt(c.i) - 65;
        if (code < 0 || code > 15) throw new Error('bad number');
        value = value * 16 + code;
        c.i++;
      }
      c.i++;
    }
    return { kind: 'value', spelling: String(negative ? -value : value) };
  }
  throw new Error(`unsupported argument at ${c.s.slice(c.i)}`);
}

/**
 * The registry of the run in progress, or undefined when the project registers
 * no templates. Module state for the same reason as the namespace resolution:
 * the emitters are free functions reached through many call chains.
 */
let current: TemplateRegistry | undefined;

export function setTemplateRegistry(registry: TemplateRegistry | undefined): void {
  current = registry;
}

export function templateRegistry(): TemplateRegistry | undefined {
  return current;
}

/**
 * The class key a declaration of the plain class `name` is written with, here
 * and in every other header: what the run's registry knows (classKey), else
 * `struct`, the key every other Ghidra structure is emitted with.
 */
export function classKeyOf(name: string): ClassKey {
  return current?.classKey(name) ?? 'struct';
}
