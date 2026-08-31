/**
 * An external `__stdcall` import is declared under its UNDECORATED name.
 *
 * BINKW32.DLL and SMACKW32.DLL export decorated `__stdcall` names — the export
 * tables of both the 1.00 and the 1.07 binaries say `_BinkClose@4`,
 * `_SmackToBuffer@28`, underscore plus argument-byte count. Ghidra's symbol is
 * that decorated name and its C emitter flattens the `@` to `_`, so every body
 * prints `_BinkClose_4`.
 *
 * Declaring THAT identifier `__stdcall` decorates it a second time and the
 * object file asks for `_BinkClose_4@4`, which nothing exports — all fifteen
 * RAD symbols were undefined at link. The identifier has to be the undecorated
 * one so the convention supplies the single decoration the DLL really has.
 *
 * Both sides move together or the link error only changes shape, so what is
 * pinned here is the pair: the declaration carries the identifier, and every
 * reference spelling that is not it is in the rename set the AST pass applies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  EXCLUDED_SYMBOL_DECLS,
  EXTERNAL_IMPORT_REFERENCE_RENAMES,
  declaredIdentifier,
  undecoratedImportName,
} from '../codegen/crt-mapping.js';
import { generatePlatformHeader, platformDeclaredFunctionNames } from '../codegen/platform-types.js';

/** Exactly what the shipped DLLs export, read off their export tables. */
const RAD_EXPORTS: Record<string, string> = {
  _SmackOpen_12: 'SmackOpen',
  _SmackClose_4: 'SmackClose',
  _SmackDoFrame_4: 'SmackDoFrame',
  _SmackNextFrame_4: 'SmackNextFrame',
  _SmackWait_4: 'SmackWait',
  _SmackToBuffer_28: 'SmackToBuffer',
  _BinkOpen_8: 'BinkOpen',
  _BinkClose_4: 'BinkClose',
  _BinkDoFrame_4: 'BinkDoFrame',
  _BinkNextFrame_4: 'BinkNextFrame',
  _BinkWait_4: 'BinkWait',
  _BinkCopyToBuffer_28: 'BinkCopyToBuffer',
  _BinkSetSoundSystem_8: 'BinkSetSoundSystem',
  _BinkOpenDirectSound_4: 'BinkOpenDirectSound',
  _BinkDDSurfaceType_4: 'BinkDDSurfaceType',
};

describe('undecoratedImportName', () => {
  it('reads the name out of a flattened stdcall decoration', () => {
    for (const [spelling, name] of Object.entries(RAD_EXPORTS)) {
      assert.strictEqual(undecoratedImportName(spelling), name, spelling);
    }
  });

  it('cannot be trusted on shape alone, which is why the rename set is closed', () => {
    // Counted over the extraction's own bodies: stack slots, padding, Ghidra
    // type placeholders and a Glide DATA symbol. Several pass the shape test —
    // so this function is only ever asked about a name the declaration table
    // has already said is an external import.
    const lookAlikes = [
      '_iStack_10', '_Stack_20', '_pad_08', '_union_1226', '_struct_1227',
      '_local_8', '_bStack_14', '_uStack_2076', '_DAT_00000018',
      '_GLIDEDLL_grSstWinClose_4', '__alloca_probe_16',
    ];
    const passing = lookAlikes.filter(n => undecoratedImportName(n) !== undefined);
    assert.ok(passing.length > 0,
      'if none of these matched, the shape test would be evidence on its own');
    for (const n of lookAlikes) {
      assert.ok(!(n in EXTERNAL_IMPORT_REFERENCE_RENAMES),
        `${n} is not an import and must never be renamed`);
    }
  });

  it('returns nothing for a name carrying no stdcall decoration', () => {
    assert.strictEqual(undecoratedImportName('BinkClose'), undefined);
    assert.strictEqual(undecoratedImportName('ijlInit'), undefined);
    // No leading underscore: a Glide import slot is not a decorated import name.
    assert.strictEqual(undecoratedImportName('GLIDEDLL_grLfbLock_24'), undefined);
    // `@N` is a dword-aligned argument-byte count; 10 and 14 are not.
    assert.strictEqual(undecoratedImportName('_iStack_10'), undefined);
    assert.strictEqual(undecoratedImportName('_uStack_14'), undefined);
  });
});

describe('external stdcall imports are declared undecorated', () => {
  it('gives every RAD entry the name its DLL exports', () => {
    const byReference = new Map(EXCLUDED_SYMBOL_DECLS.map(d => [d.emitted, d]));
    for (const [spelling, name] of Object.entries(RAD_EXPORTS)) {
      const decl = byReference.get(spelling);
      assert.ok(decl, `${spelling} must still be declared`);
      assert.strictEqual(declaredIdentifier(decl!), name);
      assert.strictEqual(decl!.real, name, `${spelling}: real name and identifier must agree`);
    }
  });

  it('declares that identifier, and never the decorated spelling', () => {
    for (const d of EXCLUDED_SYMBOL_DECLS) {
      const identifier = declaredIdentifier(d);
      if (identifier === d.emitted) continue;
      const declared = d.decl.slice(0, d.decl.indexOf('('));
      assert.ok(declared.endsWith(` ${identifier}`) || declared.endsWith(`*${identifier}`),
        `${d.emitted}: declaration must name ${identifier}, got "${declared}"`);
      assert.ok(!new RegExp(`\\b${d.emitted}\\b`).test(d.decl),
        `${d.emitted}: the decorated spelling must not survive into the declaration`);
    }
  });

  it('leaves an import that exports undecorated alone', () => {
    // IJL11 is __stdcall but its export table carries bare `ijlInit`, and the
    // link resolves through a `name@N == name` alias in ijl11.def. Nothing to
    // undecorate, so nothing changes.
    for (const name of ['ijlInit', 'ijlFree', 'ijlWrite', 'DirectSoundCreate']) {
      const d = EXCLUDED_SYMBOL_DECLS.find(x => x.emitted === name);
      assert.ok(d, `${name} must still be declared`);
      assert.strictEqual(declaredIdentifier(d!), name);
      assert.ok(!(name in EXTERNAL_IMPORT_REFERENCE_RENAMES), `${name} must not be renamed`);
    }
  });

  it('leaves the CRT and _Wrappers entries alone', () => {
    for (const name of [
      '__strnicmp', '__vsnprintf', '__purecall', '__ftol2', 'CRT_Pow10',
      'FID_conflict____CxxFrameHandler3', '_Wrappers::accept', '_Wrappers::WSASetLastError',
    ]) {
      const d = EXCLUDED_SYMBOL_DECLS.find(x => x.emitted === name);
      assert.ok(d, `${name} must still be declared`);
      assert.strictEqual(declaredIdentifier(d!), name);
    }
  });

  it('renames exactly the fifteen decorated RAD references', () => {
    assert.deepStrictEqual(
      { ...EXTERNAL_IMPORT_REFERENCE_RENAMES },
      RAD_EXPORTS,
    );
  });

  it('never claims a name a Glide import slot owns', () => {
    // Every `GLIDEDLL_gr*` is a DATA symbol globals.h declares — an import slot
    // the game fills through GetProcAddress. A rename that swept one in would
    // turn its assignment into "assignment of function".
    for (const spelling of Object.keys(EXTERNAL_IMPORT_REFERENCE_RENAMES)) {
      assert.ok(!spelling.startsWith('GLIDEDLL_'), spelling);
    }
    for (const identifier of Object.values(EXTERNAL_IMPORT_REFERENCE_RENAMES)) {
      assert.ok(!identifier.startsWith('gr') && !identifier.startsWith('gu'), identifier);
    }
  });

  it('never collides with the PTR_ import-table global named after it', () => {
    // globals.h declares `extern void* PTR__BinkClose_4_006cc5cc;` — the IAT
    // SLOT, a different object from the import. Its name sanitizes as a whole,
    // so an exact-match rename cannot reach inside it.
    const iatSlot = 'PTR__BinkClose_4_006cc5cc';
    assert.ok(!(iatSlot in EXTERNAL_IMPORT_REFERENCE_RENAMES));
    assert.strictEqual(undecoratedImportName(iatSlot), undefined);
  });
});

describe('the platform header the tree includes', () => {
  it('declares the undecorated identifier', () => {
    const header = generatePlatformHeader();
    for (const [spelling, name] of Object.entries(RAD_EXPORTS)) {
      assert.match(header, new RegExp(`__stdcall [^\\n(]*\\b${name}\\(`), name);
      assert.ok(!new RegExp(`\\b${spelling}\\(`).test(header),
        `${spelling}: the decorated spelling must not be declared`);
    }
  });

  it('owns both spellings, so no pass declares one of them a second time', () => {
    const owned = platformDeclaredFunctionNames();
    for (const [spelling, name] of Object.entries(RAD_EXPORTS)) {
      assert.ok(owned.has(spelling), spelling);
      assert.ok(owned.has(name), name);
    }
  });
});
