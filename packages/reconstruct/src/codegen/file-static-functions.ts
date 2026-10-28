/**
 * Functions the original compiled with internal linkage.
 *
 * VC8 gives a static function a register convention of its own - arguments in EAX,
 * EBX, ESI, EDI, the rest on the stack - when every call to it is in the same
 * translation unit. Ghidra records such a function with custom parameter storage in
 * registers its declared convention never passes arguments in. A function declared
 * extern in a header cannot be given that convention, so the rebuild has to declare
 * it `static` for a compiler to make the same choice.
 *
 * A function is selected when all of these hold:
 *
 *  - one of its parameters is stored in EAX, EBX, ESI or EDI, or in ECX/EDX when its
 *    convention is neither fastcall (ECX, EDX) nor thiscall (ECX);
 *  - every reference to it - a call, its name used as a value, its address as a
 *    literal, a thunk forwarding to it - is in a function of its own emitted unit;
 *  - no data initializer names it (a function table, a vtable, a callback slot);
 *  - no foreign source names it: source outside the generated tree (hand-written
 *    files built beside it, a binder that imports by address) counts as another unit;
 *  - at least one other function of that unit calls it: VC8 drops a static that
 *    nothing calls;
 *  - it is a plain free function: not a method, not a template member, not a thunk,
 *    library or platform-guarded function, and no other symbol shares its name, so
 *    every mention of the name is a mention of it.
 *
 * References are read from every function Ghidra has, including the ones codegen
 * excludes: a caller in excluded code is a caller in another translation unit.
 */

import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

import { Lexer, TokenKind } from '@ghidra-mcp/cpp-parser';
import type { DataValue, ExtractedFunction } from '../types.js';
import { decompiledFunctionName } from './impl.js';

/** The general-purpose registers a parameter piece can name, by full register. */
const REGISTER_FAMILY: Record<string, string> = {
  EAX: 'EAX', AX: 'EAX', AL: 'EAX', AH: 'EAX',
  EBX: 'EBX', BX: 'EBX', BL: 'EBX', BH: 'EBX',
  ECX: 'ECX', CX: 'ECX', CL: 'ECX', CH: 'ECX',
  EDX: 'EDX', DX: 'EDX', DL: 'EDX', DH: 'EDX',
  ESI: 'ESI', SI: 'ESI',
  EDI: 'EDI', DI: 'EDI',
};

/** Registers a declared convention passes arguments in. */
function conventionRegisters(callingConvention: string): Set<string> | undefined {
  const cc = callingConvention.toLowerCase();
  if (cc.includes('fastcall')) return new Set(['ECX', 'EDX']);
  if (cc.includes('thiscall')) return new Set(['ECX']);
  if (cc.includes('stdcall') || cc.includes('cdecl')) return new Set();
  return undefined;
}

/**
 * The registers this function's parameters are stored in that its declared
 * convention does not pass arguments in, or [] when there are none. A convention
 * Ghidra could not name gives nothing to compare against, so it gives [].
 */
export function foreignParameterRegisters(func: Pick<ExtractedFunction, 'callingConvention' | 'parameters'>): string[] {
  const allowed = conventionRegisters(func.callingConvention ?? '');
  if (!allowed) return [];
  const out = new Set<string>();
  for (const p of func.parameters ?? []) {
    for (const piece of (p.storage ?? '').split(',')) {
      const reg = REGISTER_FAMILY[piece.trim().replace(/:\d+$/, '').toUpperCase()];
      if (reg && !allowed.has(reg)) out.add(reg);
    }
  }
  return [...out].sort();
}

export interface FileStaticInputs {
  /** Every function Ghidra has, including the ones codegen does not emit. */
  allFunctions: ReadonlyArray<ExtractedFunction>;
  /** The translation unit each EMITTED function is defined in, keyed by address. */
  unitOf: ReadonlyMap<string, string>;
  /** Every data symbol Ghidra has, including the ones the emitters filter. */
  globals: ReadonlyArray<{ name?: string; suggestedName?: string; initializedData?: DataValue }>;
  /** Free functions that must keep external linkage (methods, template members). */
  keepExtern?: (func: ExtractedFunction) => boolean;
  /** Code emitted for a function besides its decompile: an override's body or patches. */
  extraReferenceText?: (func: ExtractedFunction) => string | undefined;
  /**
   * Source outside the generated tree. Every identifier in it (comments and strings
   * aside) is a reference by name; every integer literal plus `addressBase` is a
   * reference by address.
   */
  foreignSources?: ReadonlyArray<ForeignSource>;
}

export interface ForeignSource {
  /** Where the text came from, for messages. */
  path: string;
  text: string;
  /** Added to each integer literal to give an address; absent: literals are not addresses. */
  addressBase?: number;
}

/** File extensions read from a foreign-reference directory. */
const FOREIGN_SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.inl', '.s', '.S', '.asm']);

/**
 * Read the files a `foreignReferences` entry names: a file as given, a directory
 * recursively (C, C++ and assembly sources), in sorted order. A path is absolute,
 * `~/`-relative, or relative to `baseDir`. A path that does not exist is an error.
 */
export function readForeignSources(
  entries: ReadonlyArray<{ path: string; addressBase?: string | number }>,
  baseDir: string,
): ForeignSource[] {
  const out: ForeignSource[] = [];
  for (const entry of entries) {
    const raw = entry.path.startsWith('~/') ? nodePath.join(nodeOs.homedir(), entry.path.slice(2)) : entry.path;
    const root = nodePath.resolve(baseDir, raw);
    const base = entry.addressBase === undefined ? undefined
      : typeof entry.addressBase === 'number' ? entry.addressBase
      : Number.parseInt(entry.addressBase, /^0[xX]/.test(entry.addressBase) ? 16 : 10);
    if (base !== undefined && !Number.isFinite(base)) {
      throw new Error(`foreignReferences: addressBase ${entry.addressBase} of ${entry.path} is not a number`);
    }
    const files: string[] = [];
    const walk = (p: string): void => {
      const st = nodeFs.statSync(p);
      if (st.isDirectory()) {
        for (const name of nodeFs.readdirSync(p).sort()) {
          const child = nodePath.join(p, name);
          if (nodeFs.statSync(child).isDirectory() || FOREIGN_SOURCE_EXTENSIONS.has(nodePath.extname(name))) walk(child);
        }
      } else {
        files.push(p);
      }
    };
    if (!nodeFs.existsSync(root)) throw new Error(`foreignReferences: ${root} does not exist`);
    walk(root);
    for (const f of files) out.push({ path: f, text: nodeFs.readFileSync(f, 'utf-8'), addressBase: base });
  }
  return out;
}

/**
 * The source names an Itanium-mangled symbol (`_ZN8D2Client9DoThingEv`) carries,
 * as length-prefixed runs. Parameter type names come out too, which only keeps more
 * extern.
 */
function mangledSourceNames(symbol: string): string[] {
  const m = /^_+Z/.exec(symbol);
  if (!m) return [];
  const names: string[] = [];
  let i = m[0].length;
  while (i < symbol.length) {
    const digits = /^\d+/.exec(symbol.slice(i));
    if (!digits) { i++; continue; }
    const len = Number(digits[0]);
    const start = i + digits[0].length;
    if (len > 0 && start + len <= symbol.length) {
      names.push(symbol.slice(start, start + len));
      i = start + len;
    } else {
      i = start;
    }
  }
  return names;
}

export type FileStaticRefusal =
  | 'not a free function'
  | 'name shared with another symbol'
  | 'referenced from another unit'
  | 'referenced from excluded code'
  | 'named by a data initializer'
  | 'named by foreign source'
  | 'no caller in its unit';

export interface FileStaticSelection {
  /** address -> the unit it is static in, and the functions of that unit naming it. */
  selected: Map<string, { unit: string; referrers: Set<string> }>;
  /** Candidates (foreign register storage) kept extern, per reason. */
  refused: Map<FileStaticRefusal, string[]>;
  /** Functions with parameter storage in a register their convention does not use. */
  candidates: number;
}

const addressKey = (address: string): string =>
  (address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address)
    .toLowerCase().replace(/^0x/, '').padStart(8, '0');

const GHIDRA_DEFAULT_LABEL = /^(?:FUN|LAB|SUB|thunk_FUN)_([0-9a-fA-F]{8})$/;

/** Every function-pointer value an initializer tree holds: symbol names and raw addresses. */
function initializerValues(dv: DataValue | undefined, out: string[]): void {
  if (!dv) return;
  if ((dv.kind === 'pointer' || dv.kind === 'scalar') && dv.value) out.push(dv.value);
  if (dv.elements) for (const e of dv.elements) initializerValues(e, out);
  if (dv.fields) for (const f of dv.fields) initializerValues(f.value, out);
}

/**
 * Every name a body references (the last segment of a qualified chain) and every
 * integer literal in it, each with whether a call follows it.
 */
function scanReferences(
  text: string,
  onName: (name: string, call: boolean) => void,
  onInteger: (value: number, call: boolean) => void,
): void {
  let tokens: Array<{ kind: TokenKind; text: string }>;
  try {
    tokens = new Lexer(text, { preserveTrivia: false }).tokenize();
  } catch {
    // A body the lexer refuses is read as bare words: a name inside a comment or a
    // string then counts as a reference too, which only keeps more extern.
    tokens = [];
    for (const m of text.matchAll(/[A-Za-z_]\w*|0[xX][0-9a-fA-F]+|\d+|::|\(|[^\sA-Za-z_\d]/g)) {
      const t = m[0];
      const kind = /^[A-Za-z_]/.test(t) ? TokenKind.Identifier
        : /^\d/.test(t) ? TokenKind.IntegerLiteral
        : t === '::' ? TokenKind.ColonColon
        : t === '(' ? TokenKind.LeftParen
        : TokenKind.Semicolon;
      tokens.push({ kind, text: t });
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const call = tokens[i + 1]?.kind === TokenKind.LeftParen;
    if (t.kind === TokenKind.Identifier) {
      if (tokens[i + 1]?.kind !== TokenKind.ColonColon) onName(t.text, call);
    } else if (t.kind === TokenKind.IntegerLiteral) {
      const v = Number.parseInt(t.text.replace(/[uUlL]+$/, ''), /^0[xX]/.test(t.text) ? 16 : 10);
      if (Number.isFinite(v) && v > 0) onInteger(v, call);
    }
  }
}

export function selectFileStaticFunctions(inputs: FileStaticInputs): FileStaticSelection {
  const refused = new Map<FileStaticRefusal, string[]>();
  const refuse = (reason: FileStaticRefusal, func: ExtractedFunction): void => {
    const list = refused.get(reason);
    if (list) list.push(func.name); else refused.set(reason, [func.name]);
  };

  const nameCount = new Map<string, number>();
  const bump = (n: string | undefined): void => {
    if (n) nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
  };
  for (const f of inputs.allFunctions) bump(f.name);
  for (const g of inputs.globals) {
    bump(g.name);
    if (g.suggestedName && g.suggestedName !== g.name) bump(g.suggestedName);
  }

  // Candidates, and the spellings a reference to each can take.
  const candidates = new Map<string, ExtractedFunction>();   // address key -> function
  const byName = new Map<string, string>();                  // spelling -> address key
  let candidateCount = 0;
  for (const func of inputs.allFunctions) {
    if (func.isExternal || func.isThunk) continue;
    if (foreignParameterRegisters(func).length === 0) continue;
    candidateCount++;
    const key = addressKey(func.address);
    if (!inputs.unitOf.has(key)) continue;      // not emitted: nothing to declare
    if (func.isLibrary || func.ifdef || func.platform || func.parentClass ||
        func.name.includes('@') || func.name.startsWith('operator') || func.name.startsWith('~') ||
        inputs.keepExtern?.(func)) {
      refuse('not a free function', func);
      continue;
    }
    if ((nameCount.get(func.name) ?? 0) > 1) {
      refuse('name shared with another symbol', func);
      continue;
    }
    candidates.set(key, func);
    byName.set(func.name, key);
    // The decompiler's own spelling, where a rename has not reached it yet.
    const alias = decompiledFunctionName(func.decompiled)?.split('::').pop();
    if (alias && alias !== func.name && !nameCount.has(alias)) byName.set(alias, key);
  }

  // Who references each candidate, by unit (undefined: a function codegen does not emit).
  const referrers = new Map<string, Array<{ from: string; unit: string | undefined; call: boolean }>>();
  const note = (target: string, from: string, call: boolean): void => {
    if (target === from) return;
    let list = referrers.get(target);
    if (!list) referrers.set(target, (list = []));
    list.push({ from, unit: inputs.unitOf.get(from), call });
  };

  if (candidates.size > 0) {
    for (const func of inputs.allFunctions) {
      if (func.isExternal) continue;
      const from = addressKey(func.address);
      if (func.isThunk) {
        // A thunk's decompile is its target's body; its one reference is the target.
        const target = func.thunkTarget && !func.thunkTarget.isExternal ? addressKey(func.thunkTarget.address) : undefined;
        if (target && candidates.has(target)) note(target, from, true);
        continue;
      }
      for (const text of [func.decompiled, inputs.extraReferenceText?.(func)]) {
        if (!text) continue;
        scanReferences(text, (name, call) => {
          let target = byName.get(name);
          if (!target) {
            const m = GHIDRA_DEFAULT_LABEL.exec(name);
            if (m && candidates.has(m[1].toLowerCase())) target = m[1].toLowerCase();
          }
          if (target) note(target, from, call);
        }, (value, call) => {
          const k = value.toString(16).padStart(8, '0');
          if (candidates.has(k)) note(k, from, call);
        });
      }
    }
  }

  // Data that names a candidate, by symbol or by address.
  const dataReferenced = new Set<string>();
  if (candidates.size > 0) {
    for (const g of inputs.globals) {
      const values: string[] = [];
      initializerValues(g.initializedData, values);
      for (const v of values) {
        const last = v.split('::').pop()!;
        let target = byName.get(last);
        if (!target && /^(0x)?[0-9a-fA-F]{6,8}$/.test(v)) {
          const k = addressKey(v);
          if (candidates.has(k)) target = k;
        }
        if (target) dataReferenced.add(target);
      }
    }
  }

  // Foreign source that names a candidate, by symbol or by address.
  const foreignReferenced = new Set<string>();
  if (candidates.size > 0) {
    for (const src of inputs.foreignSources ?? []) {
      const byNameOrLabel = (name: string): void => {
        const target = byName.get(name) ?? GHIDRA_DEFAULT_LABEL.exec(name)?.[1].toLowerCase();
        if (target && candidates.has(target)) foreignReferenced.add(target);
      };
      scanReferences(src.text, name => {
        byNameOrLabel(name);
        for (const part of mangledSourceNames(name)) byNameOrLabel(part);
      }, value => {
        if (src.addressBase === undefined) return;
        const k = (value + src.addressBase).toString(16).padStart(8, '0');
        if (candidates.has(k)) foreignReferenced.add(k);
      });
    }
  }

  const selected = new Map<string, { unit: string; referrers: Set<string> }>();
  for (const [key, func] of candidates) {
    const unit = inputs.unitOf.get(key)!;
    const refs = referrers.get(key) ?? [];
    if (dataReferenced.has(key)) { refuse('named by a data initializer', func); continue; }
    if (foreignReferenced.has(key)) { refuse('named by foreign source', func); continue; }
    if (refs.some(r => r.unit === undefined)) { refuse('referenced from excluded code', func); continue; }
    if (refs.some(r => r.unit !== unit)) { refuse('referenced from another unit', func); continue; }
    if (!refs.some(r => r.call)) { refuse('no caller in its unit', func); continue; }
    selected.set(key, { unit, referrers: new Set(refs.map(r => r.from)) });
  }
  return { selected, refused, candidates: candidateCount };
}

/** Address key used by the selection, for lookups from the emitters. */
export function fileStaticKey(address: string): string {
  return addressKey(address);
}
