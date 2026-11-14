/**
 * The symbol index of one emitted tree: every name a function body can mention, bound to
 * what it denotes independently of its spelling.
 *
 * - functions by address (the `// 1.14d:` line before each definition, and the one after
 *   each header declaration), with their emitted qualified name, parameters and return type;
 * - globals by address, from `Source/globals/globals.addr.tsv`, which the generator writes
 *   because an `extern` declaration carries no address;
 * - struct and union fields by (type, offset), from the `/* 0xNN *\/` comment the header
 *   emits before each field;
 * - enum constants by (enum, value); type names by qualified name.
 *
 * It is built from the emitted text only, so the index of any committed tree can be rebuilt
 * from that commit: the old index for a stored body and the new one for the regen it lands in
 * come from the same function.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  scanCpp,
  scanHeader,
  signatureParts,
  typeRefFromText,
  type CppScan,
  type FunctionExtent,
  type HeaderStruct,
  type TypeRef,
} from './scan.js';

export const GLOBALS_INDEX_FILE = 'Source/globals/globals.addr.tsv';

/**
 * The suffix of a function's extern entry, `<name>_Extern` (codegen/header.ts
 * EXTERN_ENTRY_SUFFIX): a forwarder with the function's own parameters and no address,
 * defined beside a file-static function for hand-written callers. A name with it denotes
 * the function it forwards to, so a hand file's call through it follows that function.
 */
export const EXTERN_ENTRY_SUFFIX = '_Extern';

export interface FnInfo {
  address: string;
  /** Emitted qualified name, `D2Game::UNIT::SUnitDmg::DAMAGE_AwardKillExperience`. */
  qname: string;
  /** The file defining the body, when the tree defines it. */
  file?: string;
  /** The header declaring it, when one does. */
  header?: string;
  isStatic?: boolean;
  isInline?: boolean;
  params?: string[];
  /** Parameter type spellings, in order (scan.ts typeSpelling). */
  paramTypes?: string[];
  ret?: TypeRef;
  retText?: string;
  /**
   * Ghidra's storage of each parameter (`ECX:4`, `Stack[0x8]:4`), from the source map, when
   * the map's parameter names are the emitted ones: what identifies a parameter through a
   * re-order (params.ts).
   */
  storage?: string[];
}

/** What a source map says about one function's parameters (codegen/sourcemap.ts). */
export interface MappedParams { address: string; paramStorage?: Array<[string, string]> }

export interface GlobalInfo { address: string; qname: string; type?: TypeRef }

export type Resolved =
  | { k: 'fn'; a: string[]; x?: true }
  | { k: 'gl'; a: string }
  | { k: 'en'; e: string; v: string }
  | { k: 'ty'; q: string };

/** Read access to a tree, on disk or in memory. */
export interface TreeSource {
  /** Every file, relative to the tree root, `/`-separated. */
  list(): string[];
  read(rel: string): string | undefined;
}

export function diskTree(root: string, skipDirs: string[] = ['.git', 'asm_matching', 'build', 'metrics']): TreeSource {
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skipDirs.includes(r) && !skipDirs.includes(e.name)) walk(r);
      } else if (e.isFile()) files.push(r);
    }
  };
  walk('');
  return {
    list: () => files,
    read: rel => { try { return fs.readFileSync(path.join(root, rel), 'utf-8'); } catch { return undefined; } },
  };
}

export function memoryTree(files: Map<string, string>): TreeSource {
  return { list: () => [...files.keys()], read: rel => files.get(rel) };
}

const isCpp = (p: string) => p.endsWith('.cpp') || p.endsWith('.c');
const isHeader = (p: string) => p.endsWith('.h') || p.endsWith('.hpp') || p.endsWith('.inl');

export class SymbolIndex {
  readonly fnByAddr = new Map<string, FnInfo>();
  readonly fnByQname = new Map<string, string[]>();
  readonly glByAddr = new Map<string, GlobalInfo>();
  readonly glByQname = new Map<string, string>();
  readonly structs = new Map<string, HeaderStruct>();
  /** Field name -> the structs that have one by that name, with its offset. */
  readonly fieldOwners = new Map<string, Array<{ s: string; o: number }>>();
  readonly enumConsts = new Map<string, { e: string; v: string }>();
  /** (enum qname, value) -> constant qualified names. */
  readonly enumByValue = new Map<string, string[]>();
  /** Enum qname -> its constants' values by name. */
  readonly enums = new Map<string, Map<string, string>>();
  readonly types = new Set<string>();
  /** The scans the index was built from, by file: the ratchet reuses them for extents. */
  readonly scans = new Map<string, CppScan>();
  /** Every definition extent, by address (the first one when an address is defined twice). */
  readonly extents = new Map<string, { file: string; extent: FunctionExtent }>();
  /** The text of every file definitions were read from. */
  readonly texts = new Map<string, string>();

  static build(tree: TreeSource, onlyFiles?: (rel: string) => boolean): SymbolIndex {
    const ix = new SymbolIndex();
    const files = tree.list().filter(f => !onlyFiles || onlyFiles(f)).sort();
    for (const f of files) {
      if (!isCpp(f) && !isHeader(f)) continue;
      const text = tree.read(f);
      if (text === undefined) continue;
      if (isHeader(f)) ix.addHeader(f, text);
      // Headers can define bodies too (inline hosts), with the same leading marker.
      if (isCpp(f) || text.includes('// 1.14d: ')) ix.addDefinitions(f, text);
    }
    const g = tree.read(GLOBALS_INDEX_FILE);
    if (g) ix.addGlobalsTsv(g);
    // Parameter storage rides in the source maps beside the units.
    const maps: MappedParams[] = [];
    for (const f of files) {
      if (!f.endsWith('.map')) continue;
      const text = tree.read(f);
      if (!text || !text.includes('"paramStorage"')) continue;
      try {
        const m = JSON.parse(text) as { functions?: MappedParams[] };
        maps.push(...(m.functions ?? []));
      } catch { /* not a source map */ }
    }
    ix.addParamStorage(maps);
    return ix;
  }

  /**
   * Attach the parameter storage the source maps carry. A function gets it only when the
   * map's parameter names are exactly the ones its emitted signature has, so a storage list
   * never lands on parameters it was not written for.
   */
  addParamStorage(functions: Iterable<MappedParams>): void {
    for (const f of functions) {
      if (!f.paramStorage || !f.address) continue;
      const info = this.fnByAddr.get(f.address.toLowerCase().replace(/^0x/u, '').padStart(8, '0'));
      if (!info?.params || info.params.length !== f.paramStorage.length) continue;
      if (!f.paramStorage.every(([n], k) => n === info.params![k])) continue;
      info.storage = f.paramStorage.map(([, st]) => st);
    }
  }

  private addDefinitions(file: string, text: string): void {
    const scan = scanCpp(text);
    if (!scan) return;
    this.scans.set(file, scan);
    this.texts.set(file, text);
    for (const ext of scan.functions) {
      if (!this.extents.has(ext.address)) this.extents.set(ext.address, { file, extent: ext });
      const qname = [...ext.scope, ...ext.declarator].join('::');
      const parts = signatureParts(scan.tokens, ext.sigTokens[0], ext.sigTokens[1]);
      const prev = this.fnByAddr.get(ext.address);
      const info: FnInfo = {
        ...prev,
        address: ext.address,
        qname,
        file,
        isStatic: ext.isStatic,
        isInline: ext.isInline,
        params: parts?.params ?? prev?.params,
        paramTypes: parts?.types ?? prev?.paramTypes,
        ret: parts?.ret ?? prev?.ret,
        retText: parts?.retText ?? prev?.retText,
      };
      if (prev && prev.qname !== qname) this.unlinkFn(prev);
      this.fnByAddr.set(ext.address, info);
      this.linkFn(info);
    }
  }

  private linkFn(info: FnInfo): void {
    const l = this.fnByQname.get(info.qname) ?? [];
    if (!l.includes(info.address)) l.push(info.address);
    this.fnByQname.set(info.qname, l);
  }

  private unlinkFn(info: FnInfo): void {
    const l = this.fnByQname.get(info.qname);
    if (!l) return;
    const r = l.filter(a => a !== info.address);
    if (r.length) this.fnByQname.set(info.qname, r); else this.fnByQname.delete(info.qname);
  }

  private addHeader(file: string, text: string): void {
    const h = scanHeader(text);
    if (!h) return;
    for (const d of h.decls) {
      const qname = [...d.scope, ...d.name].join('::');
      const prev = this.fnByAddr.get(d.address);
      if (prev) {
        prev.header ??= file;
        prev.params ??= d.params;
        prev.paramTypes ??= d.types;
        prev.ret ??= d.ret;
        prev.retText ??= d.retText;
        continue;
      }
      const info: FnInfo = { address: d.address, qname, header: file, params: d.params, paramTypes: d.types, ret: d.ret, retText: d.retText };
      this.fnByAddr.set(d.address, info);
      this.linkFn(info);
    }
    for (const s of h.structs) {
      this.types.add(s.qname);
      if (this.structs.has(s.qname)) continue;
      this.structs.set(s.qname, s);
      for (const fd of s.fields) {
        const l = this.fieldOwners.get(fd.name) ?? [];
        l.push({ s: s.qname, o: fd.offset });
        this.fieldOwners.set(fd.name, l);
      }
    }
    for (const e of h.enums) {
      if (e.qname) {
        this.types.add(e.qname);
        const vals = this.enums.get(e.qname) ?? new Map<string, string>();
        for (const c of e.consts) if (!vals.has(c.name)) vals.set(c.name, c.value);
        this.enums.set(e.qname, vals);
      }
      for (const c of e.consts) {
        const key = { e: e.qname, v: c.value };
        let names: string[];
        if (e.ns) {
          // The generator's form: declared in `E_ns`, visible in the enum's scope only where a
          // `using` exports it (scan.ts HeaderEnum).
          names = [];
          if (e.exportAll || e.exported?.has(c.name)) names.push([...e.scope, c.name].join('::'));
          names.push([...e.ns, c.name].join('::'));
        } else {
          // An unscoped constant is visible in the enum's scope and as Enum::C.
          names = [[...e.scope, c.name].join('::')];
          if (e.qname) names.push(`${e.qname}::${c.name}`);
        }
        for (const n of names) if (!this.enumConsts.has(n)) this.enumConsts.set(n, key);
        const vk = `${e.qname}\0${c.value}`;
        const l = this.enumByValue.get(vk) ?? [];
        l.push(names[0]);
        this.enumByValue.set(vk, l);
      }
    }
    for (const t of h.typedefs) this.types.add(t);
  }

  addGlobalsTsv(text: string): void {
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [address, qname, type] = line.split('\t');
      if (!address || !qname) continue;
      const a = address.toLowerCase().replace(/^0x/u, '').padStart(8, '0');
      const info: GlobalInfo = { address: a, qname, type: type ? typeRefFromText(type) : undefined };
      this.glByAddr.set(a, info);
      if (!this.glByQname.has(qname)) this.glByQname.set(qname, a);
    }
  }

  /** What a qualified spelling denotes from inside `scope`, by C++ lookup order. */
  resolve(parts: string[], isGlobal: boolean, scope: string[]): Resolved | undefined {
    const prefixes: string[][] = [];
    if (isGlobal) prefixes.push([]);
    else for (let i = scope.length; i >= 0; i--) prefixes.push(scope.slice(0, i));
    for (const p of prefixes) {
      const q = [...p, ...parts].join('::');
      const fn = this.fnByQname.get(q);
      if (fn) return { k: 'fn', a: [...fn] };
      if (q.endsWith(EXTERN_ENTRY_SUFFIX)) {
        const target = this.fnByQname.get(q.slice(0, -EXTERN_ENTRY_SUFFIX.length));
        if (target && target.length === 1) return { k: 'fn', a: [...target], x: true };
      }
      const gl = this.glByQname.get(q);
      if (gl) return { k: 'gl', a: gl };
      const en = this.enumConsts.get(q);
      if (en) return { k: 'en', e: en.e, v: en.v };
      if (this.types.has(q)) return { k: 'ty', q };
    }
    return undefined;
  }

  /** The struct a type spelling names from `scope`, if it is one the index knows. */
  structOf(base: string, scope: string[]): HeaderStruct | undefined {
    for (let i = scope.length; i >= 0; i--) {
      const s = this.structs.get([...scope.slice(0, i), base].join('::'));
      if (s) return s;
    }
    return undefined;
  }

  qnameOf(r: Resolved): string | undefined {
    switch (r.k) {
      case 'fn': {
        const names = new Set(r.a.map(a => this.fnByAddr.get(a)?.qname));
        const q = names.size === 1 ? [...names][0] : undefined;
        return q && r.x ? `${q}${EXTERN_ENTRY_SUFFIX}` : q;
      }
      case 'gl': return this.glByAddr.get(r.a)?.qname;
      case 'en': {
        const l = this.enumByValue.get(`${r.e}\0${r.v}`);
        return l && l.length > 0 ? l[0] : undefined;
      }
      case 'ty': return this.types.has(r.q) ? r.q : undefined;
    }
  }
}

/** Two resolutions denote the same thing. */
export function sameResolved(a: Resolved | undefined, b: Resolved | undefined): boolean {
  if (!a || !b || a.k !== b.k) return false;
  switch (a.k) {
    case 'fn': {
      const bb = b as typeof a;
      return !!a.x === !!bb.x && a.a.length === bb.a.length && a.a.every(x => bb.a.includes(x));
    }
    case 'gl': return a.a === (b as typeof a).a;
    case 'en': return a.e === (b as typeof a).e && a.v === (b as typeof a).v;
    case 'ty': return a.q === (b as typeof a).q;
  }
}

/** The globals index the generator writes beside the tree: address, qualified name, type. */
export function formatGlobalsIndex(globals: Iterable<{ address: string; name: string; namespace?: string; dataType?: string; platform?: string }>): string {
  const rows: string[] = [];
  const seen = new Set<string>();
  for (const g of globals) {
    if (g.platform && g.platform !== 'windows') continue;
    const a = g.address.toLowerCase().replace(/^0x/u, '').padStart(8, '0');
    const q = g.namespace && g.namespace !== 'Global' ? `${g.namespace}::${g.name}` : g.name;
    const key = `${a}\t${q}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(`${a}\t${q}\t${(g.dataType ?? '').replace(/[\t\n]/gu, ' ')}`);
  }
  rows.sort();
  return `# address\tqualified name\ttype - the ratchet's global bindings (ratchet/symbol-index.ts)\n${rows.join('\n')}\n`;
}
