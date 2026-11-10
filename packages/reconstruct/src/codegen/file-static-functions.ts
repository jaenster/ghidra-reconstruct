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
 *    convention is neither fastcall (ECX, EDX) nor thiscall (ECX), or in EDX when
 *    it is a fastcall with no parameter in ECX: declared extern, the rebuild would
 *    pass that parameter in ECX;
 *  - every reference to it - a call, its name used as a value, its address as a
 *    literal, a thunk forwarding to it - is in a function of its own emitted unit;
 *  - no data initializer names it (a function table, a vtable, a callback slot);
 *  - no foreign source names it: source outside the generated tree (hand-written
 *    files built beside it, a binder that imports by address) counts as another unit;
 *  - at least one other function of that unit calls it: VC8 drops a static that
 *    nothing calls. A function nothing references at all still had a caller: VC8
 *    emits a static's copy, in its own convention, for a call it then inlined. Where
 *    the decompiler printed such a call as the body (`inlinedCalls`, see
 *    inlined-calls.ts), the function is selected with those sites as its callers and
 *    defined `inline`, so the restored calls are inlined again;
 *  - it is a plain free function: not a method, not a template member, not a thunk,
 *    library or platform-guarded function, and no other symbol shares its name, so
 *    every mention of the name is a mention of it;
 *  - it is not a header inline (inline-hosts.ts): every TU that calls one defines it.
 *
 * Hand-written source that only needs to CALL such a function calls its extern entry
 * instead, `<name>_Extern`: a forwarder the unit defines beside the static and the
 * unit header declares (`externEntries`). A foreign call by that name does not keep
 * the function extern, so the static keeps its own name, its own register
 * convention and every call its unit makes. Any other foreign mention of the
 * function itself - its own name, its address (a binder that imports by address),
 * its name taken as a value (a patch that redirects calls to it) - still keeps it
 * extern: none of those can be satisfied by a second function. The entry is emitted
 * whenever foreign source calls it, whether the function ended up static or not, so
 * hand-written code that adopts the entry never depends on the selection.
 *
 * References are read from every function Ghidra has, including the ones codegen
 * excludes: a caller in excluded code is a caller in another translation unit.
 */

import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { Lexer, TokenKind } from '@ghidra-mcp/cpp-parser';
import type { DataValue, ExtractedFunction } from '../types.js';
import { decompiledFunctionName } from './impl.js';
import { EXTERN_ENTRY_SUFFIX } from './header.js';
import { abiConvention } from './calling-convention.js';
import { isInlineHost } from './inline-hosts.js';

export { EXTERN_ENTRY_SUFFIX };

/** The general-purpose registers a parameter piece can name, by full register. */
const REGISTER_FAMILY: Record<string, string> = {
  EAX: 'EAX', AX: 'EAX', AL: 'EAX', AH: 'EAX',
  EBX: 'EBX', BX: 'EBX', BL: 'EBX', BH: 'EBX',
  ECX: 'ECX', CX: 'ECX', CL: 'ECX', CH: 'ECX',
  EDX: 'EDX', DX: 'EDX', DL: 'EDX', DH: 'EDX',
  ESI: 'ESI', SI: 'ESI',
  EDI: 'EDI', DI: 'EDI',
};

/** A prototype model the program defines itself: a stock name, `_`, and what it changes. */
const PROGRAM_MODEL = /^(?:__cdecl|__stdcall|__fastcall|__thiscall)_[A-Za-z0-9_]+$/;

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
 * convention does not pass arguments in, or [] when there are none. A fastcall
 * passes its second argument in EDX only after its first in ECX: one with a
 * parameter in EDX and none in ECX (`init_block`, 0042b9e0) has VC8's own
 * convention for a static function, and EDX counts as foreign. A convention
 * Ghidra could not name gives nothing to compare against, so it gives [].
 *
 * A program-defined model (`__stdcall_edxsafe`, `__stdcall_ecxedxsafe`) whose storage is the
 * fastcall placement is compared as the `__fastcall` it is spelled (calling-convention.ts):
 * its name's base says nothing about where the arguments travel. ITEMMODE_GetAlternateBodyLoc
 * 0055f240 (`__stdcall_edxsafe`, its argument in ECX: `lea eax, [ecx-4]`) and
 * _oldSaveGameLoadingPart8_part1_part1 00533a70 (`__stdcall_ecxedxsafe`, CX and EDX) enter
 * with only fastcall's registers; made static, VC8 moved the argument to EAX.
 */
export function foreignParameterRegisters(func: Pick<ExtractedFunction, 'callingConvention' | 'parameters'> & { hasVarArgs?: boolean }): string[] {
  const named = func.callingConvention ?? '';
  const spelled = PROGRAM_MODEL.test(named)
    ? abiConvention({ callingConvention: named, parameters: func.parameters, hasVarArgs: func.hasVarArgs })
    : undefined;
  const allowed = conventionRegisters(spelled === '__fastcall' ? spelled : named);
  if (!allowed) return [];
  const used = new Set<string>();
  for (const p of func.parameters ?? []) {
    for (const piece of (p.storage ?? '').split(',')) {
      const reg = REGISTER_FAMILY[piece.trim().replace(/:\d+$/, '').toUpperCase()];
      if (reg) used.add(reg);
    }
  }
  if (allowed.has('EDX') && !used.has('ECX')) allowed.delete('EDX');
  return [...used].filter(r => !allowed.has(r)).sort();
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
  /**
   * The functions of its unit that hold an inlined copy of each candidate nothing
   * references, by the candidate's address key (inlined-calls.ts).
   */
  inlinedCalls?: (unreferenced: ReadonlyArray<{ key: string; func: ExtractedFunction; unit: string }>) => ReadonlyMap<string, ReadonlySet<string>>;
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
 * Files in a foreign-reference directory that the regen itself writes, not a person:
 * ghidra_version.cpp carries the Ghidra version the tree was generated from, and the
 * live daemon's merge into source/modified changes it on every publish. Read as an
 * input, it made each publish look like a commit to the foreign sources and queued a
 * full rebuild that re-emitted nothing. It defines no name the generator looks up.
 */
const REGEN_WRITTEN_FILES = new Set(['ghidra_version.cpp']);

function isForeignSource(rel: string): boolean {
  return FOREIGN_SOURCE_EXTENSIONS.has(nodePath.extname(rel)) && !REGEN_WRITTEN_FILES.has(nodePath.basename(rel));
}

/**
 * The committed source blobs under `object` (a tree or a blob at HEAD), sorted by
 * path. The fingerprint is made of these ids, not of the tree id, so a commit that
 * changes only a regen-written file leaves it unchanged.
 */
function foreignBlobs(loc: { top: string; sub: string }, object: string): Array<{ id: string; path: string }> {
  const blobs: Array<{ id: string; path: string }> = [];
  const type = git(loc.top, ['cat-file', '-t', object]).trim();
  if (type === 'blob') {
    blobs.push({ id: object, path: loc.sub });
  } else {
    for (const rec of git(loc.top, ['ls-tree', '-r', '-z', object]).split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      const [, kind, id] = rec.slice(0, tab).split(' ');
      const rel = rec.slice(tab + 1);
      if (kind !== 'blob' || !isForeignSource(rel)) continue;
      blobs.push({ id, path: loc.sub === '.' ? rel : `${loc.sub}/${rel}` });
    }
  }
  blobs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return blobs;
}

function blobsDigest(blobs: ReadonlyArray<{ id: string; path: string }>): string {
  const h = createHash('sha256');
  for (const b of blobs) h.update(`${b.path}\u0000${b.id}\u0000`);
  return h.digest('hex');
}

type ForeignEntry = { path: string; addressBase?: string | number };

/** The directory or file an entry names, and its address base. */
function resolveForeignEntry(entry: ForeignEntry, baseDir: string): { root: string; base: number | undefined } {
  const raw = entry.path.startsWith('~/') ? nodePath.join(nodeOs.homedir(), entry.path.slice(2)) : entry.path;
  const root = nodePath.resolve(baseDir, raw);
  const base = entry.addressBase === undefined ? undefined
    : typeof entry.addressBase === 'number' ? entry.addressBase
    : Number.parseInt(entry.addressBase, /^0[xX]/.test(entry.addressBase) ? 16 : 10);
  if (base !== undefined && !Number.isFinite(base)) {
    throw new Error(`foreignReferences: addressBase ${entry.addressBase} of ${entry.path} is not a number`);
  }
  return { root, base };
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8', input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * The git work tree holding `root`, and `root` relative to it, or null when it is
 * in none. Only the directory has to exist: the committed tree is what is read.
 */
function gitLocation(root: string): { top: string; sub: string } | null {
  let probe = root;
  while (!nodeFs.existsSync(probe) || !nodeFs.statSync(probe).isDirectory()) {
    const up = nodePath.dirname(probe);
    if (up === probe) return null;
    probe = up;
  }
  let top: string;
  try {
    top = git(probe, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return null;
  }
  // realpath both sides: /tmp and /private/tmp, a symlinked home.
  const realRoot = nodeFs.existsSync(root) ? nodeFs.realpathSync(root) : nodePath.join(nodeFs.realpathSync(probe), nodePath.relative(probe, root));
  const sub = nodePath.relative(nodeFs.realpathSync(top), realRoot).split(nodePath.sep).join('/');
  return { top, sub: sub === '' ? '.' : sub };
}

/**
 * The object a committed path names at HEAD (a tree for a directory, a blob for a
 * file): a content hash of everything under it, unchanged by commits elsewhere.
 */
function headObject(loc: { top: string; sub: string }, what: string): string {
  try {
    return git(loc.top, ['rev-parse', '--verify', '--quiet', `HEAD:${loc.sub === '.' ? '' : loc.sub}`]).trim();
  } catch {
    throw new Error(`foreignReferences: ${what} is not committed at HEAD of ${loc.top}`);
  }
}

/**
 * Read the files a `foreignReferences` entry names: a file as given, a directory
 * recursively (C, C++ and assembly sources), in sorted order. A path is absolute,
 * `~/`-relative, or relative to `baseDir`. A path that does not exist is an error.
 *
 * Inside a git work tree the COMMITTED files are read - `HEAD`, not the working
 * tree - so an edit in progress beside the tree never reaches a generation, and a
 * batch regen and the live daemon read the same input. `foreignSourcesFingerprint`
 * names that input.
 */
export function readForeignSources(entries: ReadonlyArray<ForeignEntry>, baseDir: string): ForeignSource[] {
  return readForeignSourcesAt(entries, baseDir).sources;
}

/**
 * `readForeignSources`, plus the fingerprint of exactly what was read: each
 * committed object is resolved once and read by its id, so a commit landing
 * meanwhile cannot make the two disagree.
 */
export function readForeignSourcesAt(
  entries: ReadonlyArray<ForeignEntry>,
  baseDir: string,
): { sources: ForeignSource[]; fingerprint: string } {
  const out: ForeignSource[] = [];
  const h = createHash('sha256');
  for (const entry of entries) {
    const { root, base } = resolveForeignEntry(entry, baseDir);
    h.update(`${root}\u0000${base ?? ''}\u0000`);
    const loc = gitLocation(root);
    if (loc) {
      const blobs = foreignBlobs(loc, headObject(loc, root));
      h.update(`git:${blobsDigest(blobs)}\u0000`);
      if (blobs.length === 0) continue;
      const raw = execFileSync('git', ['-C', loc.top, 'cat-file', '--batch'], {
        input: blobs.map(b => b.id).join('\n') + '\n', maxBuffer: 1 << 30,
      });
      let at = 0;
      for (const b of blobs) {
        const nl = raw.indexOf(0x0a, at);
        const size = Number(raw.subarray(at, nl).toString('utf-8').split(' ')[2]);
        out.push({ path: nodePath.join(loc.top, b.path), text: raw.subarray(nl + 1, nl + 1 + size).toString('utf-8'), addressBase: base });
        at = nl + 1 + size + 1;
      }
      continue;
    }
    const files: string[] = [];
    const walk = (p: string): void => {
      const st = nodeFs.statSync(p);
      if (st.isDirectory()) {
        for (const name of nodeFs.readdirSync(p).sort()) {
          const child = nodePath.join(p, name);
          if (nodeFs.statSync(child).isDirectory() || isForeignSource(name)) walk(child);
        }
      } else {
        files.push(p);
      }
    };
    if (!nodeFs.existsSync(root)) throw new Error(`foreignReferences: ${root} does not exist`);
    walk(root);
    for (const f of files) {
      const text = nodeFs.readFileSync(f, 'utf-8');
      h.update(`${f}\u0000${text}\u0000`);
      out.push({ path: f, text, addressBase: base });
    }
  }
  return { sources: out, fingerprint: h.digest('hex').slice(0, 16) };
}

/**
 * One hash naming exactly what `readForeignSources` would read now: per entry, the
 * path and blob id of each committed source file at HEAD (a blob id is already a
 * content hash), or the contents of the files outside git. A commit that leaves those files alone - the
 * live daemon's own merge into the tree that holds them - leaves it unchanged.
 * Equal to the fingerprint `readForeignSourcesAt` returns for the same commit.
 */
export function foreignSourcesFingerprint(entries: ReadonlyArray<ForeignEntry>, baseDir: string): string {
  const h = createHash('sha256');
  for (const entry of entries) {
    const { root, base } = resolveForeignEntry(entry, baseDir);
    h.update(`${root}\u0000${base ?? ''}\u0000`);
    const loc = gitLocation(root);
    if (loc) {
      h.update(`git:${blobsDigest(foreignBlobs(loc, headObject(loc, root)))}\u0000`);
    } else {
      for (const src of readForeignSources([entry], baseDir)) h.update(`${src.path}\u0000${src.text}\u0000`);
    }
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * The source names an Itanium-mangled symbol (`_ZN8D2Client9DoThingEv`) carries,
 * as length-prefixed runs. Parameter type names come out too, which only keeps more
 * extern.
 */
export function mangledSourceNames(symbol: string): string[] {
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
  | 'no caller in its unit'
  | 'a header inline';

export interface FileStaticSelection {
  /**
   * address -> the unit it is static in, and the functions of that unit naming it;
   * `inline` when those are inlined calls the rebuild writes back.
   */
  selected: Map<string, { unit: string; referrers: Set<string>; inline?: boolean }>;
  /** Candidates (foreign register storage) kept extern, per reason. */
  refused: Map<FileStaticRefusal, string[]>;
  /** Functions with parameter storage in a register their convention does not use. */
  candidates: number;
  /**
   * Functions foreign source calls through their extern entry (`<name>_Extern`),
   * by address key: the unit defines the entry, its header declares it.
   */
  externEntries: Set<string>;
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
export function scanReferences(
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
    // Every TU that calls a header inline defines it (inline-hosts.ts): none can own it.
    if (isInlineHost(func)) {
      refuse('a header inline', func);
      continue;
    }
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
  // Foreign calls through an extern entry, by the entry's name; any emitted function
  // can have one, not only a candidate. A name shared with another symbol is skipped:
  // the call could mean either.
  const externEntries = new Set<string>();
  const entryOf = new Map<string, string>();       // `<name>_Extern` -> address key
  if (inputs.foreignSources?.length) {
    for (const func of inputs.allFunctions) {
      if (func.isExternal || func.isThunk || func.hasVarArgs) continue;
      // A header inline is extern and defined in every TU that calls it: hand-written
      // code calls it by its own name.
      if (isInlineHost(func)) continue;
      if (func.isLibrary || func.ifdef || func.platform || func.parentClass ||
          func.name.includes('@') || func.name.startsWith('operator') || func.name.startsWith('~') ||
          inputs.keepExtern?.(func)) continue;
      const key = addressKey(func.address);
      if (!inputs.unitOf.has(key) || (nameCount.get(func.name) ?? 0) > 1) continue;
      const entry = func.name + EXTERN_ENTRY_SUFFIX;
      if (!nameCount.has(entry)) entryOf.set(entry, key);
    }
  }
  const entryValueUse = new Set<string>();
  if (candidates.size > 0 || entryOf.size > 0) {
    for (const src of inputs.foreignSources ?? []) {
      const byNameOrLabel = (name: string, call: boolean): void => {
        const entry = entryOf.get(name);
        if (entry) (call ? externEntries : entryValueUse).add(entry);
        const target = byName.get(name) ?? GHIDRA_DEFAULT_LABEL.exec(name)?.[1].toLowerCase();
        if (target && candidates.has(target)) foreignReferenced.add(target);
      };
      scanReferences(src.text, (name, call) => {
        byNameOrLabel(name, call);
        for (const part of mangledSourceNames(name)) byNameOrLabel(part, false);
      }, value => {
        if (src.addressBase === undefined) return;
        const k = (value + src.addressBase).toString(16).padStart(8, '0');
        if (candidates.has(k)) foreignReferenced.add(k);
      });
    }
  }

  const selected = new Map<string, { unit: string; referrers: Set<string>; inline?: boolean }>();
  const unreferenced: Array<{ key: string; func: ExtractedFunction; unit: string }> = [];
  for (const [key, func] of candidates) {
    const unit = inputs.unitOf.get(key)!;
    const refs = referrers.get(key) ?? [];
    if (dataReferenced.has(key)) { refuse('named by a data initializer', func); continue; }
    if (foreignReferenced.has(key)) { refuse('named by foreign source', func); continue; }
    if (refs.some(r => r.unit === undefined)) { refuse('referenced from excluded code', func); continue; }
    if (refs.some(r => r.unit !== unit)) { refuse('referenced from another unit', func); continue; }
    if (refs.length === 0 && inputs.inlinedCalls) { unreferenced.push({ key, func, unit }); continue; }
    if (!refs.some(r => r.call)) { refuse('no caller in its unit', func); continue; }
    selected.set(key, { unit, referrers: new Set(refs.map(r => r.from)) });
  }
  if (unreferenced.length > 0) {
    const sites = inputs.inlinedCalls!(unreferenced);
    for (const { key, func, unit } of unreferenced) {
      const from = [...(sites.get(key) ?? [])].filter(f => f !== key && inputs.unitOf.get(f) === unit);
      if (from.length === 0) { refuse('no caller in its unit', func); continue; }
      selected.set(key, { unit, referrers: new Set(from), inline: true });
    }
  }
  // An entry whose address foreign code takes is not a call through it: a patch that
  // redirects calls to that address would miss every call the unit makes.
  for (const k of entryValueUse) externEntries.delete(k);
  return { selected, refused, candidates: candidateCount, externEntries };
}

/** Address key used by the selection, for lookups from the emitters. */
export function fileStaticKey(address: string): string {
  return addressKey(address);
}
