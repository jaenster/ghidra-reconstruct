#!/usr/bin/env node
// Scan the reconstructed C++ output for datatype "holes": fields whose Ghidra
// type is wrong. Signals, in priority order:
//   B) scalar field sliced into sub-bytes  (foo.nSeed._1_2_)  -> packed/byteswapped/mistyped
//   C) array/char[] field read as dwords   (foo.szPath._44_4_) -> oversized array hiding real fields
//   A) struct layout holes                 (undefinedN fields, field_0xNN, _padN)
// Output: a ranked markdown report. Read-only; fixes go back into Ghidra.

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, 'output');
const OUT = join(import.meta.dirname, 'type-holes-report.md');

// ---- collect files -------------------------------------------------------
function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.cpp') || e.name.endsWith('.h')) acc.push(p);
  }
  return acc;
}
const files = walk(ROOT);
const headers = files.filter((f) => f.endsWith('.h'));
const sources = files.filter((f) => f.endsWith('.cpp'));

// ---- parse struct bodies -> field index ---------------------------------
// field index: fieldName -> [{struct, type, off, array, file}]
const fieldIndex = new Map();
// struct -> {file, fields:[{off,type,name,array}], holes:[...]}
const structs = new Map();

const SCALAR = /^(u?int(8|16|32|64)?_t|u?int|u?short|u?char|u?long|byte|word|dword|qword|BOOL|BYTE|WORD|DWORD|char|short|int|long|undefined[0-9]?)\b/;
const HOLE_TYPE = /^undefined[0-9]?$/;
const HOLE_NAME = /^(field_?0x[0-9a-fA-F]+|field[0-9]+_0x[0-9a-fA-F]+|_pad[0-9]*)/;

const fieldLine = /^\s*(?:\/\*\s*0x([0-9a-fA-F]+)\s*\*\/\s*)?([A-Za-z_][\w:<>\* ]*?)\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*;/;

for (const f of headers) {
  const txt = readFileSync(f, 'utf8');
  const lines = txt.split('\n');
  let cur = null;
  for (const line of lines) {
    const open = line.match(/^struct ([A-Za-z_]\w*)\s*\{/);
    if (open) { cur = { name: open[1], file: f, fields: [] }; structs.set(cur.name, cur); continue; }
    if (cur && /^\};/.test(line)) { cur = null; continue; }
    if (!cur) continue;
    const m = line.match(fieldLine);
    if (!m) continue;
    const off = m[1] !== undefined ? parseInt(m[1], 16) : null;
    const type = m[2].trim();
    const name = m[3];
    const array = m[4] || null;
    const rec = { struct: cur.name, type, off, name, array, file: f };
    cur.fields.push(rec);
    if (!fieldIndex.has(name)) fieldIndex.set(name, []);
    fieldIndex.get(name).push(rec);
  }
}

// per-struct layout holes
for (const s of structs.values()) {
  s.holes = s.fields.filter(
    (fl) => HOLE_TYPE.test(fl.type.replace(/\s*\*+$/, '')) || HOLE_NAME.test(fl.name),
  );
}

// ---- scan sources for slices --------------------------------------------
// slice access:  <ident>._<off>_<sz>_
const sliceRe = /([A-Za-z_]\w*)\._(\d+)_(\d+)_/g;
// base.field._N_M_  (base = the variable/instance, field = sliced member)
const baseSliceRe = /([A-Za-z_]\w*)(->|\.)([A-Za-z_]\w*)\._(\d+)_(\d+)_/g;
// slices keyed by field name
const slices = new Map(); // field -> {count, sizes:Set, offs:Set, files:Set, samples:[]}

// per-base instance slices: base -> {fields:Map(field->{slices,count}), files, kind}
const LOCAL_PREFIX = /^(local_|param_|[piudfbcs]?[iaul]?Stack|in_|unaff_|extraout_|this$)/;
const bases = new Map();

for (const f of sources) {
  const txt = readFileSync(f, 'utf8');
  const rel = relative(ROOT, f);
  let m;
  while ((m = sliceRe.exec(txt))) {
    const [, field, off, sz] = m;
    if (!slices.has(field)) slices.set(field, { field, count: 0, key: new Set(), files: new Set() });
    const e = slices.get(field);
    e.count++;
    e.key.add(`_${off}_${sz}_`);
    e.files.add(rel);
  }
  while ((m = baseSliceRe.exec(txt))) {
    const [, base, op, field, off, sz] = m;
    if (!bases.has(base)) bases.set(base, { base, fields: new Map(), files: new Set(), count: 0, arrow: false });
    const b = bases.get(base);
    b.count++;
    b.files.add(rel);
    if (op === '->') b.arrow = true;
    if (!b.fields.has(field)) b.fields.set(field, new Set());
    b.fields.get(field).add(`_${off}_${sz}_`);
  }
}
// classify base kind: local (stack var) vs instance/global (named — actionable)
for (const b of bases.values()) {
  b.kind = b.arrow ? 'ptr' : LOCAL_PREFIX.test(b.base) ? 'local' : 'named';
}

// declared-size of a scalar type (bytes), for out-of-bounds slice detection
const sizeOf = (t) => {
  const b = t.replace(/\s*\*+$/, '').trim();
  if (/\*/.test(t)) return 4;
  if (/^(undefined1|u?char|byte|bool|BOOL|BYTE|s?int8_t|int8|uint8)$/i.test(b)) return 1;
  if (/^(undefined2|u?short|word|WORD|s?int16_t|int16|uint16|wchar_t|WCHAR)$/i.test(b)) return 2;
  if (/^(undefined4|u?int|u?long|dword|DWORD|s?int32_t|int32|uint32|float|BOOL)$/i.test(b)) return 4;
  if (/^(undefined8|u?int64_t|int64|uint64|qword|QWORD|double|__int64)$/i.test(b)) return 8;
  return 0; // unknown
};
// largest (off+sz) touched by any slice
const sliceReach = (keys) => Math.max(...keys.map((k) => { const [, o, s] = k.split('_'); return +o + +s; }));

// classify each sliced field
const classified = [];
for (const e of slices.values()) {
  const defs = fieldIndex.get(e.field) || [];
  // pick best def: prefer one whose array-ness matches the access span
  const scalarDefs = defs.filter((d) => !d.array && SCALAR.test(d.type));
  const arrayDefs = defs.filter((d) => d.array);
  let kind, type, owners;
  const maxSliceByte = Math.max(...[...e.key].map((k) => +k.split('_')[1]));
  if (arrayDefs.length && maxSliceByte > 0) {
    kind = 'array-as-fields'; // oversized array hiding fields (szArchivePath case)
    type = arrayDefs[0].type + (arrayDefs[0].array || '');
    owners = [...new Set(arrayDefs.map((d) => d.struct))];
  } else if (scalarDefs.length) {
    kind = 'scalar-sliced'; // packed/byteswapped/mistyped scalar
    type = scalarDefs[0].type;
    owners = [...new Set(scalarDefs.map((d) => d.struct))];
  } else if (defs.length) {
    kind = 'other-field';
    type = defs[0].type + (defs[0].array || '');
    owners = [...new Set(defs.map((d) => d.struct))];
  } else {
    kind = 'unresolved'; // a local var typed too wide, not a struct field we indexed
    type = '?';
    owners = [];
  }
  // out-of-bounds: a slice reaches past the declared scalar size => type is provably too small
  const dsz = kind === 'scalar-sliced' ? sizeOf(type) : 0;
  const reach = sliceReach([...e.key]);
  const oob = dsz > 0 && reach > dsz;
  classified.push({ ...e, kind, type, owners, slices: [...e.key].sort(), maxSliceByte, dsz, reach, oob });
}

// ---- emit report ---------------------------------------------------------
const byCount = (a, b) => b.count - a.count;
const arrayFields = classified.filter((c) => c.kind === 'array-as-fields').sort(byCount);
const oobFields = classified.filter((c) => c.oob).sort(byCount);
const scalarFields = classified.filter((c) => c.kind === 'scalar-sliced' && !c.oob).sort(byCount);
const otherFields = classified.filter((c) => c.kind === 'other-field').sort(byCount);
const unresolved = classified.filter((c) => c.kind === 'unresolved').sort(byCount);
const holeStructs = [...structs.values()].filter((s) => s.holes.length).sort((a, b) => b.holes.length - a.holes.length);

const L = [];
L.push('# Datatype holes — reconstructed Game.exe 1.14d');
L.push('');
L.push(`Scanned ${sources.length} .cpp + ${headers.length} .h files; indexed ${structs.size} struct bodies, ${fieldIndex.size} distinct field names.`);
L.push('Fixes go back into **Ghidra** (this output is regenerated). Each entry names the datatype/field to fix.');
L.push('');

L.push('## B0. PROVABLY WRONG — slice reaches past the declared field size');
L.push('A `short` read at byte 3, a `byte` read at offset 2, etc. Cannot be a bitfield or byteswap — the field type is simply too small. Fix these first.');
L.push('');
L.push('|count|field|declared type (size)|reach|owner struct(s)|slices|');
L.push('|-|-|-|-|-|-|');
for (const c of oobFields.slice(0, 80))
  L.push(`|${c.count}|\`${c.field}\`|\`${c.type}\` (${c.dsz})|${c.reach}|${c.owners.join(', ') || '—'}|${c.slices.join(' ')}|`);
L.push('');

L.push('## B. Scalar fields sliced into sub-bytes (mistyped / packed / byteswapped)');
L.push('A scalar read as `._off_sz_` means the field is decomposed below its width — the type is wrong, or it is a packed/bitfield, or byteswap code. Highest-confidence type holes.');
L.push('');
L.push('|count|field|declared type|owner struct(s)|slices|');
L.push('|-|-|-|-|-|');
for (const c of scalarFields.slice(0, 60))
  L.push(`|${c.count}|\`${c.field}\`|\`${c.type}\`|${c.owners.join(', ') || '—'}|${c.slices.join(' ')}|`);
L.push('');

L.push('## C. Array/char[] fields read as dwords (oversized array hiding real fields)');
L.push('Like `D2ArchiveStrc.szArchivePath._44_4_`: a `char[N]` overlaying real pointer/count fields. The array is too long; split it.');
L.push('');
L.push('|count|field|declared type|owner struct(s)|byte offsets read|');
L.push('|-|-|-|-|-|');
for (const c of arrayFields.slice(0, 60))
  L.push(`|${c.count}|\`${c.field}\`|\`${c.type}\`|${c.owners.join(', ') || '—'}|${c.slices.join(' ')}|`);
L.push('');

L.push('## D. Sliced fields that did NOT resolve to an indexed struct field');
L.push('Mostly locals/params typed too wide (e.g. `int` holding a packed struct). Field name + slices hint at the real type.');
L.push('');
L.push('|count|name|slices|files|');
L.push('|-|-|-|-|');
for (const c of unresolved.slice(0, 40))
  L.push(`|${c.count}|\`${c.field}\`|${c.slices.join(' ')}|${[...c.files].slice(0, 2).join(', ')}|`);
L.push('');

L.push('## A. Struct layout holes (undefinedN fields, field_0xNN, _pad)');
L.push('Structs with admitted gaps — unnamed/untyped fields still in the layout.');
L.push('');
L.push('|holes|struct|hole fields (offset:type name)|');
L.push('|-|-|-|');
for (const s of holeStructs.slice(0, 60)) {
  const h = s.holes.slice(0, 8).map((f) => `0x${(f.off ?? 0).toString(16)}:${f.type} ${f.name}`).join('; ');
  L.push(`|${s.holes.length}|${s.name}|${h}${s.holes.length > 8 ? ' …' : ''}|`);
}
L.push('');

L.push('## Totals');
L.push(`- scalar-sliced fields: ${scalarFields.length}`);
L.push(`- array-as-fields: ${arrayFields.length}`);
L.push(`- other resolved sliced fields: ${otherFields.length}`);
L.push(`- unresolved sliced names: ${unresolved.length}`);
L.push(`- structs with layout holes: ${holeStructs.length}`);

writeFileSync(OUT, L.join('\n'));
console.log(`wrote ${OUT}`);
// per-variable worklist: named instances (locals w/ semantic names + globals) sorted by count
const namedBases = [...bases.values()].filter((b) => b.kind === 'named').sort((a, b) => b.count - a.count);
{
  const wl = ['# Local/instance typing worklist', '', 'Each `base` is a stack var or global instance sliced as `._N_M_` (dot access). Retype the var (or fix the field) so members render. Excludes `local_*`/stack-temp names and `->` (already-typed) accesses.', '', '|count|base|sliced members (field: slices)|files|', '|-|-|-|-|'];
  for (const b of namedBases) {
    const flds = [...b.fields].map(([f, s]) => `${f}: ${[...s].sort().join(' ')}`).join('; ');
    wl.push(`|${b.count}|\`${b.base}\`|${flds}|${[...b.files].slice(0, 2).join(', ')}|`);
  }
  writeFileSync(join(import.meta.dirname, 'local-typing-worklist.md'), wl.join('\n'));
}
console.log(`PROVABLY-WRONG(oob)=${oobFields.length} scalar-sliced=${scalarFields.length} array-as-fields=${arrayFields.length} unresolved=${unresolved.length} hole-structs=${holeStructs.length}`);
console.log(`named-instance bases (worklist)=${namedBases.length} -> local-typing-worklist.md`);
console.log('\nTop 25 local/instance typing targets:');
for (const b of namedBases.slice(0, 25)) console.log(`  ${String(b.count).padStart(3)}  ${b.base}  {${[...b.fields.keys()].join(',')}}  ${[...b.files][0]}`);
console.log('\nTop 30 PROVABLY WRONG (slice past field size):');
for (const c of oobFields.slice(0, 30)) console.log(`  ${String(c.count).padStart(3)}  ${c.field}  [${c.type}=${c.dsz}b reach=${c.reach}]  ${c.owners.join(',')||'?'}  ${c.slices.join(' ')}`);
console.log('\nTop 10 array-as-fields:');
for (const c of arrayFields.slice(0, 10)) console.log(`  ${String(c.count).padStart(3)}  ${c.field}  [${c.type}]  ${c.owners.join(',')||'?'}  ${c.slices.join(' ')}`);

// ---- cast-hell scan ------------------------------------------------------
// A scalar var that the code keeps casting to a pointer and indexing
//   ((D2UnitStrc**)nParam2)[4]   <- nParam2 is really a struct ptr; [4] is a field
//   ((int32_t*)pAnimState)[0x98] <- pAnimState typed too narrow
// is a variable whose Ghidra type is wrong. The fix is to retype the VAR (in
// Ghidra), after which the cast disappears and [N] becomes a named field access.
// We group by (function, var) so each row is one retype action, and we rank
// named-struct/enum targets (TIER 1, near-certain) above primitive ones.

// What counts as a "named" cast target (vs a bare primitive that may be legit):
const NAMED_TYPE = /(Strc|Txt|^e?D2|^[eu][A-Z]|Manager|Context|List|Node|Info|Data|Cache|Buffer|Path|Room|Unit|Game|Skills?|Stat)/;
const PRIMITIVE = /^(u?int(8|16|32|64)?_t|u?int|u?short|u?char|byte|short|char|int|long|void|undefined[0-9]?|BYTE|WORD|DWORD|BOOL|float|double)$/;
// a cast applied to a plain identifier, optionally followed by [index]
const castRe = /\(\(\s*([A-Za-z_][\w:]*?)\s*(\*+)\s*\)([A-Za-z_]\w*)\)(?:\[(0x[0-9a-fA-F]+|\d+)\])?/g;
// recognise the start of a function body so we can attribute each cast
const fnDefRe = /^[A-Za-z_][\w:<>\* ,&]*\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/;

const castGroups = new Map(); // key=`${file}::${fn}::${var}` -> {fn,var,file,types:Map(type->count),offs:Set,count}
for (const f of sources) {
  const rel = relative(ROOT, f);
  const lines = readFileSync(f, 'utf8').split('\n');
  let fn = '(file scope)';
  for (const line of lines) {
    const fd = line.match(fnDefRe);
    if (fd && !/\b(if|for|while|switch|return|else)\b/.test(line)) fn = fd[1];
    let m;
    while ((m = castRe.exec(line))) {
      const [, base, stars, varName, idx] = m;
      const type = base + stars; // e.g. "D2UnitStrc**"
      if (PRIMITIVE.test(base) && stars.length === 1 && idx === undefined) continue; // bare (int*)x deref — too noisy
      const key = `${rel}::${fn}::${varName}`;
      if (!castGroups.has(key)) castGroups.set(key, { fn, var: varName, file: rel, types: new Map(), offs: new Set(), count: 0 });
      const g = castGroups.get(key);
      g.count++;
      g.types.set(type, (g.types.get(type) || 0) + 1);
      if (idx !== undefined) g.offs.add(idx);
    }
  }
}
const castRows = [...castGroups.values()].map((g) => {
  const types = [...g.types.entries()].sort((a, b) => b[1] - a[1]);
  const named = types.some(([t]) => NAMED_TYPE.test(t));
  return { ...g, types, named };
});
const tier1 = castRows.filter((r) => r.named).sort((a, b) => b.count - a.count);
const tier2 = castRows.filter((r) => !r.named).sort((a, b) => b.count - a.count);

{
  const C = [];
  C.push('# Cast-hell worklist — variables retyped on every use');
  C.push('');
  C.push('Each row is a `(function, var)` the code keeps casting+indexing. Retype the **variable in Ghidra** to the cast-to type; the cast then vanishes and `[N]` becomes a named field. TIER 1 = cast target is a named struct/enum (near-certain). TIER 2 = primitive widen/narrow (likelier-legit, lower priority).');
  C.push('');
  C.push('## TIER 1 — cast to a named struct/enum type');
  C.push('|count|function|var|cast-to (×n)|offsets|file|');
  C.push('|-|-|-|-|-|-|');
  for (const r of tier1.slice(0, 120)) {
    const t = r.types.filter(([ty]) => NAMED_TYPE.test(ty)).map(([ty, n]) => `\`${ty}\`×${n}`).join(' ');
    C.push(`|${r.count}|${r.fn}|\`${r.var}\`|${t}|${[...r.offs].sort().join(' ') || '—'}|${r.file}|`);
  }
  C.push('');
  C.push('## TIER 2 — cast to a primitive pointer (pointer-named vars first)');
  C.push('|count|function|var|cast-to (×n)|offsets|file|');
  C.push('|-|-|-|-|-|-|');
  const t2 = tier2.sort((a, b) => (/^p/.test(b.var) - /^p/.test(a.var)) || (b.count - a.count));
  for (const r of t2.slice(0, 2000)) {
    const t = r.types.map(([ty, n]) => `\`${ty}\`×${n}`).join(' ');
    C.push(`|${r.count}|${r.fn}|\`${r.var}\`|${t}|${[...r.offs].sort().join(' ') || '—'}|${r.file}|`);
  }
  writeFileSync(join(import.meta.dirname, 'cast-hell-worklist.md'), C.join('\n'));
}
console.log(`\ncast-hell: TIER1(named)=${tier1.length} groups, TIER2(primitive)=${tier2.length} groups -> cast-hell-worklist.md`);
console.log('Top 20 TIER-1 cast-hell targets:');
for (const r of tier1.slice(0, 20)) {
  const t = r.types.filter(([ty]) => NAMED_TYPE.test(ty)).map(([ty, n]) => `${ty}×${n}`).join(',');
  console.log(`  ${String(r.count).padStart(3)}  ${r.fn}(${r.var})  ${t}  [${[...r.offs].sort().join(' ')}]  ${r.file}`);
}

// ---- enum-value-cast scan -------------------------------------------------
// A var the code keeps casting to a named enum value: `(eD2UnitType)var`.
// The var should BE that enum. Single-paren, no '*', no index — distinct from
// the pointer cast-hell above. Retyping makes `(eEnum)n == CONST` read as
// `eX == CONST`. Recurring casts only (a one-off cast is often legit).
const enumCastRe = /\(\s*(eD2[A-Za-z]\w*)\s*\)\s*([A-Za-z_]\w*)/g;
const enumGroups = new Map(); // key=file::fn::var -> {fn,var,file,enums:Map,count}
for (const f of sources) {
  const rel = relative(ROOT, f);
  const lines = readFileSync(f, 'utf8').split('\n');
  let fn = '(file scope)';
  for (const line of lines) {
    const fd = line.match(fnDefRe);
    if (fd && !/\b(if|for|while|switch|return|else)\b/.test(line)) fn = fd[1];
    let m;
    while ((m = enumCastRe.exec(line))) {
      const [full, en, varName] = m;
      if (line[m.index + full.length] === '(') continue; // cast of a call result, not a var
      const key = `${rel}::${fn}::${varName}`;
      if (!enumGroups.has(key)) enumGroups.set(key, { fn, var: varName, file: rel, enums: new Map(), count: 0 });
      const g = enumGroups.get(key);
      g.count++;
      g.enums.set(en, (g.enums.get(en) || 0) + 1);
    }
  }
}
const enumRows = [...enumGroups.values()]
  .map((g) => ({ ...g, enums: [...g.enums.entries()].sort((a, b) => b[1] - a[1]) }))
  .filter((r) => r.count >= 2)
  .sort((a, b) => b.count - a.count);
{
  const E = ['# Enum-recovery worklist — variables cast to an enum on every use', '',
    'Each row is a `(function, var)` cast to a named `eD2*` enum value (not a pointer). Retype the **variable in Ghidra** to that enum; the `(eEnum)` casts vanish and comparisons read as `eX == CONST`. Single-instance casts excluded (often legit).', '',
    '|count|function|var|enum (×n)|file|', '|-|-|-|-|-|'];
  for (const r of enumRows.slice(0, 800)) {
    const t = r.enums.map(([e, n]) => `\`${e}\`×${n}`).join(' ');
    E.push(`|${r.count}|${r.fn}|\`${r.var}\`|${t}|${r.file}|`);
  }
  writeFileSync(join(import.meta.dirname, 'enum-recovery-worklist.md'), E.join('\n'));
}
console.log(`enum-recovery: ${enumRows.length} groups (count>=2) -> enum-recovery-worklist.md`);
