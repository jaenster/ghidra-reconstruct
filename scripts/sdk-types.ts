/**
 * What the platform's SDK headers define, read off the headers themselves.
 *
 * `d2_platform.h` includes <windows.h>, <winsock2.h>, <mmsystem.h>, ... on Windows. A
 * Ghidra type whose name one of them already defines must not be emitted again: the tree
 * uses the SDK's, and a second `struct FPO_DATA {...}` beside winnt.h's
 * `typedef struct _FPO_DATA {...} FPO_DATA` is "using typedef-name after struct" in every
 * TU that sees both. Which names those are is a property of the headers, not of Ghidra's
 * category path (FPO_DATA is filed under /DbgHelp) or of a list.
 *
 * This compiles probes against the generated `d2_platform.h` with the target toolchain:
 *
 *   1. `using P = ::NAME;` for every type name in the snapshot: compiles iff the platform
 *      already declares NAME as a type (a typedef, or a struct/union/enum tag); an error
 *      that says NAME is not a type means the SDK declares it as something else.
 *   2. for each defined aggregate, `sizeof(::NAME)` and, per Ghidra field, its offset and
 *      size in the SDK's type, compiled to assembly and read back. A field the SDK's type
 *      lacks, or has as a bit-field, is recorded as such.
 *
 * and writes packages/reconstruct/src/codegen/sdk-types.generated.ts, which the generator
 * reads (platform-types.ts `isLibraryType`, and the layout report). Re-run it when the
 * platform header's includes change or Ghidra adds types:
 *
 *   npx tsx scripts/sdk-types.ts --snapshot <snapshot dir> [--cxx i686-w64-mingw32-g++]
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { generatePlatformHeader } from '../packages/reconstruct/src/codegen/platform-types.js';

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const snapshot = opt('--snapshot');
const cxx = opt('--cxx') ?? 'i686-w64-mingw32-g++';
const outFile = opt('--out') ?? new URL('../packages/reconstruct/src/codegen/sdk-types.generated.ts', import.meta.url).pathname;
if (!snapshot) { console.error('usage: sdk-types.ts --snapshot <dir> [--cxx <compiler>] [--out <file>]'); process.exit(2); }

interface Field { name: string | null; offset: number; size: number }
interface DataType { name: string; kind: string; size: number; fields?: Field[] }

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const types: DataType[] = readFileSync(join(snapshot, 'dataTypes.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const byName = new Map<string, DataType>();
for (const t of types) if (IDENT.test(t.name) && !byName.has(t.name)) byName.set(t.name, t);
const names = [...byName.keys()].sort();

const dir = mkdtempSync(join(tmpdir(), 'sdk-types-'));
// The tree's own platform header when given (the generator passes it options), else the default.
const platformFile = opt('--platform');
const platform = platformFile ? readFileSync(platformFile, 'utf8') : generatePlatformHeader();
writeFileSync(join(dir, 'd2_platform.h'), platform);
// The platform header ends by including the game's enums; the probe asks about the SDK.
writeFileSync(join(dir, 'd2_enums.h'), '');
const FLAGS = ['-std=c++17', '-fms-extensions', '-w', '-fmax-errors=0', '-I', dir];

function compile(file: string, extra: string[]): string {
  try {
    execFileSync(cxx, [...FLAGS, ...extra, file], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
    return '';
  } catch (e) {
    return String((e as { stderr?: Buffer }).stderr ?? '');
  }
}

/** Error messages by 1-based line of `file`. */
function errorsByLine(stderr: string, file: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of stderr.split('\n')) {
    const at = line.indexOf(`${file}:`);
    if (at < 0 || !line.includes(' error: ')) continue;
    const n = Number(line.slice(at + file.length + 1).split(':')[0]);
    if (Number.isInteger(n) && !out.has(n)) out.set(n, line.slice(line.indexOf(' error: ') + 8));
  }
  return out;
}

// 1. Which names the platform declares as types.
const HEAD = ['#include "d2_platform.h"', '#include <cstddef>'];
const probe1 = [...HEAD, ...names.map((n, i) => `using __sdk_probe_${i} = ::${n};`)];
writeFileSync(join(dir, 'p1.cpp'), probe1.join('\n') + '\n');
const e1 = errorsByLine(compile('p1.cpp', ['-fsyntax-only']), 'p1.cpp');
const defined: string[] = [];
const nonTypes: string[] = [];
names.forEach((n, i) => {
  const err = e1.get(i + HEAD.length + 1);
  if (err === undefined) defined.push(n);
  // "'::X' is not a type", "... does not name a type" vs not declared at all.
  else if (!/not been declared|was not declared|has not been declared/.test(err) && !/does not name a type/.test(err)) nonTypes.push(n);
});

// 1b. Where each defined name is declared: a conflicting typedef makes the compiler point
// at the previous declaration. Only a SYSTEM header's declaration is the SDK's; a name the
// platform header declares itself (`sockaddr_in`'s fallback, the generator's own types)
// is the platform header's business, decided where it is written.
const probeWhere = [...HEAD, ...defined.map((n, i) => `typedef struct __sdk_unique_${i} ${n};`)];
writeFileSync(join(dir, 'p1b.cpp'), probeWhere.join('\n') + '\n');
const whereOut = compile('p1b.cpp', ['-fsyntax-only']).split('\n');
const declaredIn = new Map<string, string>();
const kindOf = new Map<string, 'typedef' | 'tag'>();
for (let k = 0; k < whereOut.length; k++) {
  const m = /p1b\.cpp:(\d+):\d+: error: conflicting declaration/.exec(whereOut[k]);
  if (!m) continue;
  const name = defined[Number(m[1]) - HEAD.length - 1];
  // The note can be preceded by an "In file included from" chain; it ends at the next error.
  for (let q = k + 1; q < whereOut.length && !/ error: /.test(whereOut[q]); q++) {
    const note = /^([^\s:]+):\d+:\d+: note: previous declaration(.*)$/.exec(whereOut[q]);
    if (note) {
      declaredIn.set(name, note[1]);
      // "as 'typedef struct _FPO_DATA FPO_DATA'" vs "as 'struct IUnknown'": a typedef name has
      // no elaborated form (`struct FPO_DATA *` is an error), a tag does.
      // `typedef struct IUnknown IUnknown` names its own tag, so `struct IUnknown` is valid.
      const sameTag = new RegExp(`typedef (?:struct|union|class) ${name} ${name}\\b`).test(note[2]);
      kindOf.set(name, /typedef/.test(note[2]) && !sameTag ? 'typedef' : 'tag');
      break;
    }
  }
}
const isSystemHeader = (f: string | undefined) => !!f && f.startsWith('/') && !f.startsWith(dir);
const sdkDefined = defined.filter(n => isSystemHeader(declaredIn.get(n)));
const platformDefined = defined.filter(n => !isSystemHeader(declaredIn.get(n)));

// 2. The SDK's layout of each defined aggregate, at the fields Ghidra names.
type Probe = { line: string; label: string; type: string; field?: string; what: 'size' | 'off' | 'fsize' };
const probes: Probe[] = [];
sdkDefined.forEach((n, i) => {
  const t = byName.get(n)!;
  if (t.kind !== 'STRUCTURE' && t.kind !== 'UNION') return;
  probes.push({ type: n, what: 'size', label: `__sdk_sz_${i}`, line: `extern "C" const unsigned __sdk_sz_${i} = sizeof(::${n});` });
  (t.fields ?? []).forEach((f, j) => {
    if (!f.name || !IDENT.test(f.name)) return;
    probes.push({ type: n, field: f.name, what: 'off', label: `__sdk_of_${i}_${j}`, line: `extern "C" const unsigned __sdk_of_${i}_${j} = offsetof(::${n}, ${f.name});` });
    probes.push({ type: n, field: f.name, what: 'fsize', label: `__sdk_fs_${i}_${j}`, line: `extern "C" const unsigned __sdk_fs_${i}_${j} = sizeof(((::${n}*)nullptr)->${f.name});` });
  });
});
writeFileSync(join(dir, 'p2.cpp'), [...HEAD, ...probes.map(p => p.line)].join('\n') + '\n');
const e2 = errorsByLine(compile('p2.cpp', ['-fsyntax-only']), 'p2.cpp');
const failed = new Map<Probe, string>();
probes.forEach((p, k) => { const e = e2.get(k + HEAD.length + 1); if (e !== undefined) failed.set(p, e); });
const good = probes.filter(p => !failed.has(p));
writeFileSync(join(dir, 'p3.cpp'), [...HEAD, ...good.map(p => p.line)].join('\n') + '\n');
const asmErr = compile('p3.cpp', ['-S', '-O0', '-o', 'p3.s']);
if (asmErr) { console.error(asmErr.slice(0, 4000)); process.exit(1); }
const asm = readFileSync(join(dir, 'p3.s'), 'utf8').split('\n');
const values = new Map<string, number>();
for (let k = 0; k < asm.length; k++) {
  const m = /^_?(__sdk_\w+):$/.exec(asm[k].trim());
  if (!m) continue;
  // A zero-valued constant lands in .bss as `.space 4` (or `.zero 4`), anything else as `.long N`.
  const next = (asm[k + 1] ?? '').trim();
  const v = /^\.long\s+(\d+)$/.exec(next);
  if (v) values.set(m[1], Number(v[1]));
  else if (/^\.(space|zero)\s+4$/.test(next)) values.set(m[1], 0);
}

type FieldFact = [number, number] | 'missing' | 'bitfield';
const layouts: Record<string, { size: number; fields: Record<string, FieldFact> }> = {};
for (const p of probes) {
  const l = (layouts[p.type] ??= { size: -1, fields: {} });
  const err = failed.get(p);
  if (p.what === 'size') { l.size = err === undefined ? values.get(p.label) ?? -1 : -1; continue; }
  const f = p.field!;
  if (err !== undefined) {
    if (!(f in l.fields) || l.fields[f] !== 'bitfield') l.fields[f] = /bit-field/.test(err) ? 'bitfield' : 'missing';
    continue;
  }
  const v = values.get(p.label);
  if (v === undefined) continue;
  const cur = l.fields[f];
  const pair: [number, number] = Array.isArray(cur) ? cur : [-1, -1];
  if (p.what === 'off') pair[0] = v; else pair[1] = v;
  if (typeof cur !== 'string') l.fields[f] = pair;
}

const compilerVersion = execFileSync(cxx, ['--version'], { encoding: 'utf8' }).split('\n')[0];
const headerHash = createHash('sha256').update(platform).digest('hex').slice(0, 16);
const body = [
  '// GENERATED by scripts/sdk-types.ts - do not edit. Re-run it when the platform header',
  '// includes change or Ghidra adds type names.',
  `// compiler: ${compilerVersion}`,
  `// d2_platform.h sha256/16: ${headerHash}; snapshot: ${snapshot.split('/').pop()}`,
  '',
  '/** Every type name probed (the snapshot\'s), sorted: a name outside it is unknown. */',
  `export const SDK_PROBED_NAMES: readonly string[] = ${JSON.stringify(names)};`,
  '',
  '/** The probed names a system header the platform includes declares as types, with the header. */',
  `export const SDK_DEFINED_TYPES: Record<string, string> = ${JSON.stringify(Object.fromEntries(sdkDefined.map(n => [n, declaredIn.get(n)!.replace(/^.*\/include\//, '')])))};`,
  '',
  '/** The SDK-defined names that are typedef names, which have no elaborated (`struct X`) form; the rest are tags. */',
  `export const SDK_TYPEDEF_NAMES: readonly string[] = ${JSON.stringify(sdkDefined.filter(n => kindOf.get(n) === 'typedef'))};`,
  '',
  '/** The probed names d2_platform.h itself declares as types (not the SDK\'s). */',
  `export const PLATFORM_HEADER_DECLARED_TYPES: readonly string[] = ${JSON.stringify(platformDefined)};`,
  '',
  '/** The probed names the platform declares as something other than a type. */',
  `export const SDK_NON_TYPE_NAMES: readonly string[] = ${JSON.stringify(nonTypes)};`,
  '',
  '/** The SDK\'s layout of each defined aggregate: size, and [offset, size] per Ghidra field name. */',
  `export const SDK_LAYOUTS: Record<string, { size: number; fields: Record<string, [number, number] | 'missing' | 'bitfield'> }> = ${JSON.stringify(layouts)};`,
  '',
].join('\n');
writeFileSync(outFile, body);
console.log(`${names.length} names probed, ${sdkDefined.length} defined by the SDK, ${platformDefined.length} by d2_platform.h (${Object.keys(layouts).length} aggregates laid out), ${nonTypes.length} declared as non-types -> ${outFile}`);
