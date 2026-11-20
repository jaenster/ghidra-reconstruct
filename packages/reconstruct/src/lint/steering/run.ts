/**
 * The two ways the steering lint runs.
 *
 * Tree: every hand-owned body (a ratchet record of kind `pin`) is checked, and tree-wide
 * counts of the steering spellings are taken. Pin findings are judged against a content-keyed
 * baseline (a new one fails); the counts may only fall.
 *
 * Patch: a diff against one function is applied to the tree, and only what the diff
 * introduces is reported - plus any edit to an anchor, a prototype, a header, or code outside
 * the target body.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeKind, getChildren, parse } from '@ghidra-mcp/cpp-parser';
import { RatchetStore, normalizeAddress } from '../../ratchet/store.js';
import { SymbolIndex, diskTree } from '../../ratchet/symbol-index.js';
import { definitionSignature, scanHeader, type HeaderDecl } from '../../ratchet/scan.js';
import { isGlobalsHeaderPath } from '../../codegen/globals-layout.js';
import { isDataHeaderPath, loadTree, type GlobalDecl } from '../tree.js';
import { lexBody, parseBody, typeMentions } from './body.js';
import {
  ANCHOR_CHECK_ID, ASM_SPELLINGS, CODEGEN_PRAGMAS, FORCEINLINE_SPELLINGS, NOINLINE_SPELLINGS,
  PROTOTYPE_CHECK_ID, lintBody, pragmaName, type SteerEnv, type SteerFinding,
} from './checks.js';
import {
  anchorsOn, applyHunks, extractDiff, findByAddress, isHeaderPath, lineAt, parseUnifiedDiff, signatureTokens,
} from './patch.js';
import { DEFAULT_VOCABULARY, buildVocabulary, readVocabularyFile, type Vocabulary } from './vocabulary.js';

export const OUTSIDE_BODY_CHECK_ID = 'outside-body';
export const STEERING_BASELINE_VERSION = 1;
export const DEFAULT_STEERING_BASELINE = resolve(dirname(fileURLToPath(import.meta.url)), 'steering-baseline.json');

/** Tree-wide counters: the spellings whose existing uses may only fall. */
export const COUNTER_IDS = ['noinline', 'forceinline', 'volatile', 'inline-asm', 'optimize-pragma', 'register-keyword'] as const;
export type CounterId = typeof COUNTER_IDS[number];

const SKIP = new Set(['.git', 'build', 'runs', 'metrics', 'cmake', 'node_modules', 'asm_matching', 'ratchet', 'thirdparty']);
const SOURCE_EXT = ['.cpp', '.c', '.h', '.hpp', '.inl'];

/** The tree's C++ files, tree-relative: everything outside build output, measurements and the VC8 bench. */
export function steeringPaths(root: string): string[] {
  const out: string[] = [];
  const rec = (dir: string, rel: string) => {
    for (const e of readdirSync(dir).sort()) {
      if (SKIP.has(e) || e.startsWith('.')) continue;
      const p = join(dir, e);
      const r = rel ? `${rel}/${e}` : e;
      if (statSync(p).isDirectory()) rec(p, r);
      else if (SOURCE_EXT.some(x => e.endsWith(x))) out.push(r);
    }
  };
  rec(root, '');
  return out;
}

export interface Counter {
  total: number;
  byFile: Record<string, number>;
}

/** Volatile-qualified fields a file's structs declare (the allowlisted Storm form). */
function volatileFieldCount(text: string): number {
  let n = 0;
  let tu: any;
  try {
    tu = parse(text, { recover: true });
  } catch {
    return 0;
  }
  const rec = (x: any, inStruct: boolean) => {
    if (!x || typeof x !== 'object' || typeof x.kind !== 'string') return;
    if (x.kind === NodeKind.FunctionDecl) return;
    const isStruct = x.kind === NodeKind.StructDecl || x.kind === NodeKind.ClassDecl || x.kind === NodeKind.UnionDecl;
    if (inStruct && (x.kind === NodeKind.FieldDecl || x.kind === NodeKind.VariableDecl) && typeMentions(x.type, 'volatile')) n++;
    for (const c of getChildren(x)) rec(c, inStruct || isStruct);
  };
  for (const d of tu.declarations ?? []) rec(d, false);
  return n;
}

export function countTree(root: string, paths: string[], vocab: Vocabulary): Record<CounterId, Counter> {
  const out = Object.fromEntries(COUNTER_IDS.map(id => [id, { total: 0, byFile: {} as Record<string, number> }])) as Record<CounterId, Counter>;
  const bump = (id: CounterId, file: string, k = 1) => {
    if (k <= 0) return;
    out[id].total += k;
    out[id].byFile[file] = (out[id].byFile[file] ?? 0) + k;
  };
  const noinline = new Set([...NOINLINE_SPELLINGS, ...(vocab.macroSpellings.get('noinline') ?? [])]);
  const forceinline = new Set([...FORCEINLINE_SPELLINGS, ...(vocab.macroSpellings.get('forceinline') ?? [])]);
  for (const p of paths) {
    // The header that defines the spellings (the macros, the platform shims) is not a use of them.
    if (vocab.isDefinitionHeader(p)) continue;
    const text = readFileSync(join(root, p), 'utf8');
    const { tokens, directives } = lexBody(text);
    let vol = 0;
    for (const t of tokens) {
      if (noinline.has(t.text)) bump('noinline', p);
      else if (forceinline.has(t.text)) bump('forceinline', p);
      else if (t.text === 'volatile') vol++;
      else if (ASM_SPELLINGS.includes(t.text)) bump('inline-asm', p);
      else if (t.text === 'register') bump('register-keyword', p);
    }
    if (vol && vocab.isVolatileFieldFile(p)) vol -= volatileFieldCount(text);
    bump('volatile', p, vol);
    for (const d of directives) {
      const name = pragmaName(d.text);
      if (name && CODEGEN_PRAGMAS.has(name)) bump('optimize-pragma', p);
    }
  }
  return out;
}

export interface PinFinding extends SteerFinding {
  address: string;
  fn: string;
  /** The tree file the body lives in. */
  file: string;
  /** Content key: never a line number. */
  key: string;
}

export interface SteeringBaseline {
  version: number;
  counters: Record<string, number>;
  pins: Record<string, string>;
}

function short(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

export function keyPinFindings(fs: Array<Omit<PinFinding, 'key'>>): PinFinding[] {
  const seen = new Map<string, number>();
  return [...fs]
    .sort((a, b) => a.address.localeCompare(b.address) || a.check.localeCompare(b.check) || a.line - b.line || a.subject.localeCompare(b.subject))
    .map(f => {
      const id = `${f.address}|${f.check}|${f.subject}|${short(f.sig)}`;
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      return { ...f, key: n ? `${id}#${n}` : id };
    });
}

export function loadSteeringBaseline(path: string): SteeringBaseline | null {
  if (!existsSync(path)) return null;
  try {
    const b = JSON.parse(readFileSync(path, 'utf8'));
    return b?.version === STEERING_BASELINE_VERSION ? b as SteeringBaseline : null;
  } catch {
    return null;
  }
}

export function saveSteeringBaseline(path: string, counters: Record<CounterId, Counter>, pins: PinFinding[]): void {
  const b: SteeringBaseline = {
    version: STEERING_BASELINE_VERSION,
    counters: Object.fromEntries(COUNTER_IDS.map(id => [id, counters[id].total])),
    pins: Object.fromEntries(pins.filter(p => !p.exempt).map(p => [p.key, `${p.fn} ${p.file}: ${p.detail}`]).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(path, JSON.stringify(b, null, 1) + '\n');
}

export interface TreeEnv {
  root: string;
  paths: string[];
  vocabulary: Vocabulary;
  index: SymbolIndex;
  globals: Map<string, GlobalDecl>;
  generated?: (name: string) => boolean;
  /** The ref `generated` reads, when the tree has it. */
  generatedRef?: string;
}

/** The branch holding pure generator output beside the hand-edited tree (docs/regen-workflow.md). */
export const DEFAULT_GENERATED_REF = 'source/regen';

/**
 * Whether the generator's own output at `ref` spells a name as code: git finds the files that
 * mention it, the lexer confirms it is a token there and not text in a comment or string.
 * Undefined when the tree has no such ref.
 */
export function generatedSpelling(root: string, ref: string): ((name: string) => boolean) | undefined {
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'ignore' });
  } catch {
    return undefined;
  }
  const memo = new Map<string, boolean>();
  return (name: string) => {
    const hit = memo.get(name);
    if (hit !== undefined) return hit;
    let found = false;
    try {
      const files = execFileSync('git', ['-C', root, 'grep', '-l', '-F', '-w', '-e', name, ref, '--', '*.h', '*.cpp'],
        { encoding: 'utf8', maxBuffer: 16 << 20 }).split('\n').filter(Boolean).slice(0, 5);
      for (const f of files) {
        const text = execFileSync('git', ['-C', root, 'show', f], { encoding: 'utf8', maxBuffer: 64 << 20 });
        if (lexBody(text).tokens.some(t => t.text === name)) { found = true; break; }
      }
    } catch { /* no match: git grep exits 1 */ }
    memo.set(name, found);
    return found;
  };
}

export function treeEnv(root: string, vocabularyPath = DEFAULT_VOCABULARY, generatedRef = DEFAULT_GENERATED_REF): TreeEnv {
  const paths = steeringPaths(root);
  const read = (rel: string) => { try { return readFileSync(join(root, rel), 'utf8'); } catch { return undefined; } };
  const vocabulary = buildVocabulary(readVocabularyFile(vocabularyPath), paths, read);
  const index = SymbolIndex.build(diskTree(root, ['.git', 'asm_matching', 'build', 'metrics', 'ratchet']));
  const globals = loadTree(root, { only: p => isGlobalsHeaderPath(p) || isDataHeaderPath(p) || p.endsWith('.globals.h') }).globals;
  const generated = generatedSpelling(root, generatedRef);
  return { root, paths, vocabulary, index, globals, generated, generatedRef: generated ? generatedRef : undefined };
}

const normType = (s: string | undefined) => (s ?? '').replace(/\s+/g, '').replace(/^::/, '').replace(/([<,(])::/g, '$1');

/** Ghidra's declaration of a function (its header's), or undefined for a file-static one. */
function headerDecl(env: TreeEnv, address: string, cache: Map<string, HeaderDecl[]>): HeaderDecl | undefined {
  const info = env.index.fnByAddr.get(address);
  if (!info?.header) return undefined;
  let decls = cache.get(info.header);
  if (!decls) {
    const text = readFileSync(join(env.root, info.header), 'utf8');
    decls = scanHeader(text)?.decls ?? [];
    cache.set(info.header, decls);
  }
  return decls.find(d => d.address === address);
}

/** A definition's prototype against Ghidra's declaration: return type, parameter types, count. */
export function prototypeDifference(defText: string, decl: HeaderDecl): string | null {
  const sig = definitionSignature(defText);
  if (!sig) return null;
  if (sig.types.length !== decl.types.length) return `${sig.types.length} parameter(s), the declaration has ${decl.types.length}`;
  for (let i = 0; i < sig.types.length; i++) {
    if (normType(sig.types[i]) !== normType(decl.types[i])) return `parameter ${i + 1} is \`${sig.types[i]}\`, the declaration says \`${decl.types[i]}\``;
  }
  if (normType(sig.retText) !== normType(decl.retText)) return `returns \`${sig.retText}\`, the declaration says \`${decl.retText}\``;
  return null;
}

/** The signature tokens of the generated definition at `address` in `file`, from the generated ref. */
function generatedSignature(env: TreeEnv, file: string, address: string, cache: Map<string, string | undefined>): string[] | undefined {
  if (!env.generatedRef) return undefined;
  if (!cache.has(file)) cache.set(file, readTreeFile(env.root, file, env.generatedRef));
  const text = cache.get(file);
  const ext = text ? findByAddress(text, address) : undefined;
  return text && ext ? signatureTokens(text, ext) : undefined;
}

export interface TreeResult {
  counters: Record<CounterId, Counter>;
  pins: PinFinding[];
  pinCount: number;
}

export function lintSteeringTree(env: TreeEnv): TreeResult {
  const counters = countTree(env.root, env.paths, env.vocabulary);
  const store = new RatchetStore(join(env.root, 'ratchet'));
  const records = store.list().filter(r => r.kind === 'pin');
  const raw: Array<Omit<PinFinding, 'key'>> = [];
  const hdrCache = new Map<string, HeaderDecl[]>();
  const sigCache = new Map<string, string | undefined>();
  for (const r of records) {
    for (const m of r.members) {
      const steerEnv: SteerEnv = {
        vocabulary: env.vocabulary, index: env.index, scope: m.scope, globals: env.globals, generated: env.generated,
        storedBindings: new Set(m.bindings.map(([i]) => i)),
      };
      const body = parseBody(m.text);
      const bodyStart = body.fn?.body?.location?.start?.offset ?? 0;
      const ownSig = lexBody(m.text.slice(0, bodyStart)).tokens.map(t => t.text);
      for (const f of lintBody(body, steerEnv)) {
        // An inlining attribute in the signature is the declaration's, Ghidra's and the
        // generator's: it is a finding only where the generated definition does not carry it.
        if (f.check === 'noinline' || f.check === 'forceinline') {
          const k = Number(f.sig.split('#')[1] ?? 0);
          const inSig = ownSig.filter(t => t === f.subject).length;
          const genSig = generatedSignature(env, m.file, m.address, sigCache)?.filter(t => t === f.subject).length ?? 0;
          if (k < inSig && k < genSig) continue;
        }
        raw.push({ ...f, address: m.address, fn: m.name, file: m.file });
      }
      if (m.address !== r.address) continue;
      if (!env.index.extents.has(m.address)) {
        raw.push({ check: ANCHOR_CHECK_ID, line: 1, subject: m.address, detail: `no definition in the tree carries the anchor \`// 1.14d: ${m.address}\``,
          sig: 'missing-anchor', address: m.address, fn: m.name, file: m.file });
      }
      // The prototype the tree compiles (a stored body's own may predate a Ghidra change the
      // ratchet carries over) against the declaration Ghidra owns.
      const ext = env.index.extents.get(m.address);
      const treeText = ext ? env.index.texts.get(ext.file)?.slice(ext.extent.start, ext.extent.end) : undefined;
      const decl = headerDecl(env, m.address, hdrCache);
      const diff = decl && treeText ? prototypeDifference(treeText, decl) : null;
      if (diff) {
        raw.push({ check: PROTOTYPE_CHECK_ID, line: 1, subject: m.name, detail: `the tree's definition differs from Ghidra's declaration: ${diff}`,
          sig: `proto:${diff}`, address: m.address, fn: m.name, file: m.file });
      }
    }
  }
  return { counters, pins: keyPinFindings(raw), pinCount: records.length };
}

export interface PatchResult {
  address: string;
  fn: string;
  file: string;
  introduced: SteerFinding[];
  structural: SteerFinding[];
}

function multisetMinus(after: SteerFinding[], before: SteerFinding[]): SteerFinding[] {
  const left = new Map<string, number>();
  const k = (f: SteerFinding) => `${f.check}\u0000${f.subject}\u0000${f.sig}`;
  for (const f of before) left.set(k(f), (left.get(k(f)) ?? 0) + 1);
  return after.filter(f => {
    const n = left.get(k(f)) ?? 0;
    if (n > 0) { left.set(k(f), n - 1); return false; }
    return true;
  });
}

export function readTreeFile(root: string, rel: string, base?: string): string | undefined {
  if (base) {
    try {
      return execFileSync('git', ['-C', root, 'show', `${base}:${rel}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
    } catch {
      return undefined;
    }
  }
  try { return readFileSync(join(root, rel), 'utf8'); } catch { return undefined; }
}

export function lintSteeringPatch(env: TreeEnv, patchText: string, address: string, base?: string): PatchResult | { error: string } {
  const addr = normalizeAddress(address);
  const files = parseUnifiedDiff(extractDiff(patchText));
  if (!files.length) return { error: 'no file diff found in the patch' };
  const structural: SteerFinding[] = [];
  let target: PatchResult | null = null;
  for (const fd of files) {
    const oldText = readTreeFile(env.root, fd.path, base);
    if (oldText === undefined) return { error: `${fd.path}: not in the tree${base ? ` at ${base}` : ''}` };
    const applied = applyHunks(oldText, fd.hunks);
    if ('error' in applied) return { error: `${fd.path}: ${applied.error}` };
    for (const h of fd.hunks) {
      for (const l of h.lines) {
        if (l.op === ' ') continue;
        for (const a of anchorsOn(l.text)) {
          structural.push({ check: ANCHOR_CHECK_ID, line: h.newStart, subject: a, detail: `${fd.path}: the patch ${l.op === '-' ? 'removes' : 'adds'} the anchor \`// 1.14d: ${a}\``, sig: `${l.op}${a}` });
        }
      }
    }
    if (isHeaderPath(fd.path)) {
      structural.push({ check: PROTOTYPE_CHECK_ID, line: fd.hunks[0]?.newStart ?? 1, subject: fd.path, detail: `${fd.path}: the patch edits a header; declarations are Ghidra's`, sig: `header:${fd.path}` });
      continue;
    }
    const before = findByAddress(oldText, addr);
    const after = findByAddress(applied.text, addr);
    if (!after) {
      for (const r of applied.ranges) {
        if (!r.hunk.lines.some(x => x.op !== ' ')) continue;
        structural.push({ check: OUTSIDE_BODY_CHECK_ID, line: r.start, subject: fd.path, detail: `${fd.path}:${r.start}: the patch changes code outside the target body`, sig: `outside:${fd.path}:${r.hunk.lines.filter(x => x.op !== ' ').map(x => x.op + x.text.trim()).join('|')}` });
      }
      continue;
    }
    if (!before) return { error: `${fd.path}: the anchor \`// 1.14d: ${addr}\` is only in the patched text` };
    const afterStart = lineAt(applied.text, after.markerStart);
    const afterEnd = lineAt(applied.text, after.end);
    for (const r of applied.ranges) {
      // Changed lines only: a hunk's context may run past the body.
      for (const [ln, text] of r.removed) {
        if (ln < afterStart || ln > afterEnd + 1) structural.push({ check: OUTSIDE_BODY_CHECK_ID, line: ln, subject: fd.path, detail: `${fd.path}:${ln}: the patch removes a line outside the target body`, sig: `outside-:${text.trim()}` });
      }
      for (const [ln, text] of r.added) {
        if (ln < afterStart || ln > afterEnd) structural.push({ check: OUTSIDE_BODY_CHECK_ID, line: ln, subject: fd.path, detail: `${fd.path}:${ln}: the patch adds a line outside the target body`, sig: `outside+:${text.trim()}` });
      }
    }
    if (signatureTokens(oldText, before).join(' ') !== signatureTokens(applied.text, after).join(' ')) {
      structural.push({ check: PROTOTYPE_CHECK_ID, line: lineAt(applied.text, after.start), subject: addr, detail: `the patch changes the prototype of ${addr}; prototypes are Ghidra's`, sig: `proto:${addr}` });
    }
    const scope = [...after.scope, ...after.declarator.slice(0, -1)];
    const steerEnv: SteerEnv = { vocabulary: env.vocabulary, index: env.index, scope, globals: env.globals, generated: env.generated };
    const oldBody = parseBody(oldText.slice(before.start, before.end), lineAt(oldText, before.start));
    const newBody = parseBody(applied.text.slice(after.start, after.end), lineAt(applied.text, after.start));
    const introduced = multisetMinus(lintBody(newBody, steerEnv), lintBody(oldBody, steerEnv))
      .map(f => ({ ...f, line: f.line + newBody.firstLine - 1 }));
    target = { address: addr, fn: [...after.scope, ...after.declarator].join('::'), file: fd.path, introduced, structural };
  }
  if (!target) return { error: `no file in the patch defines \`// 1.14d: ${addr}\`` };
  target.structural = structural;
  return target;
}

