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
 * what the descriptor says, or the run stops.
 */

import type { TemplatesConfig } from '../../config/schema.js';
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

export class TemplateRegistry {
  readonly header: string;
  readonly implPrefix: string;
  readonly keyClasses: ReadonlySet<string>;
  private readonly familyByName: ReadonlyMap<string, TemplateFamily>;
  private readonly bySpelling = new Map<string, TemplateInstantiation>();
  private readonly ordered: TemplateInstantiation[] = [];

  private readonly orphanNames: RegExp[];
  private readonly orphanAddresses = new Set<string>();

  private constructor(config: TemplatesConfig) {
    this.orphanNames = (config.orphans ?? []).map(glob =>
      new RegExp(`^${glob.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`));
    this.header = config.header;
    this.implPrefix = config.implPrefix ?? '';
    this.keyClasses = new Set(config.classes ?? []);
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

  /**
   * Record which functions of the registered classes are orphan copies: a name
   * matching project.json's `orphans`, in a registered class scope.
   */
  findOrphans(functions: Iterable<{ address: string; name: string; namespace?: string | null }>): void {
    this.orphanAddresses.clear();
    for (const f of functions) {
      if (this.isClassScope(f.namespace) && this.orphanNames.some(re => re.test(f.name))) this.orphanAddresses.add(f.address);
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

  /** Every descriptor of a registered family must agree with the instantiation it names. */
  private checkRtti(rttiNames: Iterable<string>): void {
    for (const raw of rttiNames) {
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
      const spelling = spellType(parseTypeSpelling(d.spelling)!);
      const inst = this.bySpelling.get(spelling);
      // A descriptor for an instantiation the allowlist leaves out is not checked.
      if (!inst) continue;
      if (inst.spelling !== spelling) {
        throw new Error(`[templates] RTTI ${raw} names ${spelling}, the model has ${inst.spelling}`);
      }
    }
  }
}

/** A demangled `.?AV?$Name@args@@` RTTI type descriptor name. */
export interface DemangledTemplate {
  key: 'class' | 'struct';
  family: string;
  args: Array<{ kind: 'type' | 'value'; spelling: string }>;
  /** `Name<args>`, the arguments spelled as C++ spells them. */
  spelling: string;
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
function readTemplateName(c: Cursor): { family: string; args: DemangledTemplate['args']; spelling: string } {
  expect(c, '?$');
  const family = readIdentifier(c);
  const args: DemangledTemplate['args'] = [];
  while (c.s[c.i] !== '@') args.push(readArgument(c));
  c.i++;
  return { family, args, spelling: `${family}<${args.map(a => a.spelling).join(',')}>` };
}

/** A qualified class name ending in `@`: `CELLIST@@`, or `?$T@args@@`. */
function readClassName(c: Cursor): string {
  const name = c.s.startsWith('?$', c.i) ? readTemplateName(c).spelling : readIdentifier(c);
  expect(c, '@');
  return name;
}

function readArgument(c: Cursor): DemangledTemplate['args'][number] {
  const ch = c.s[c.i];
  if (ch === 'U' || ch === 'V') {
    c.i++;
    return { kind: 'type', spelling: readClassName(c) };
  }
  if (c.s.startsWith('PAU', c.i) || c.s.startsWith('PAV', c.i)) {
    c.i += 3;
    return { kind: 'type', spelling: `${readClassName(c)}*` };
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
