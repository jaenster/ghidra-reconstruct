import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { qualifiedNameCleanupPlugin } from '../builtins/qualified-name-cleanup.js';

describe('qualifiedNameCleanupPlugin', () => {
  function transformCode(code: string, options: Record<string, unknown> = {}): string {
    const ast = parse(code);
    const transformer = qualifiedNameCleanupPlugin.createTransformer(options);
    return emit(transformer(ast) as AnyNode);
  }

  it('collapses a namespace segment repeated back-to-back', () => {
    const out = transformCode(
      'void f() { D2Common::Drlg::Drlg::RollSeed(pLevel); }'
    );
    assert.ok(/D2Common::Drlg::RollSeed\(/.test(out), out);
    assert.ok(!/Drlg::Drlg/.test(out), out);
  });

  it('collapses only ADJACENT duplicates, leaving A::B::A alone', () => {
    const out = transformCode('void f() { Path::Room::Path::GetYPos(p); }');
    assert.ok(/Path::Room::Path::GetYPos/.test(out), out);
  });

  it('drops the VisualStudio / compiler CRT namespaces', () => {
    const out = transformCode(
      'void f() { VisualStudio::sprintf(szBuf, szFmt); compiler::memcpy(a, b, n); }'
    );
    assert.ok(/\bsprintf\(szBuf, szFmt\)/.test(out), out);
    assert.ok(/\bmemcpy\(a, b, n\)/.test(out), out);
    assert.ok(!/VisualStudio/.test(out), out);
    assert.ok(!/compiler::/.test(out), out);
  });

  it('drops a type-named qualifier that sits directly before the name', () => {
    // Ghidra hangs D2WinImage's members under a namespace named after the struct.
    const out = transformCode(
      'void f() { D2Client::Forms::D2WinImage::Draw(pImage); }',
      { typeQualifierNames: ['D2WinImage'] }
    );
    assert.ok(/D2Client::Forms::Draw\(pImage\)/.test(out), out);
    assert.ok(!/D2WinImage::/.test(out), out);
  });

  it('keeps an INTERMEDIATE type-named qualifier — it is a real namespace', () => {
    // `Item` is a struct AND the folder namespace of ItemMods. Dropping it points
    // the reference at D2Common::ItemMods, which nothing declares.
    const out = transformCode(
      'void f() { D2Common::Item::ItemMods::ITEMMOD_CanApplyAffix(p, n); }',
      { typeQualifierNames: ['Item'] }
    );
    assert.ok(/D2Common::Item::ItemMods::ITEMMOD_CanApplyAffix/.test(out), out);
  });

  it('keeps a SOLE type-named qualifier — that is a member reference', () => {
    const out = transformCode(
      'void f() { D2WinImage::Draw(pImage); }',
      { typeQualifierNames: ['D2WinImage'] }
    );
    assert.ok(/D2WinImage::Draw\(pImage\)/.test(out), out);
  });

  it('cannot reach a namespace DECLARATION, however the qualifier is spelled', () => {
    // The predecessor regex rewrote `namespace D2Common::Item::ItemMods {` itself,
    // because its penultimate-only guard looks for a following `::` and a
    // declaration is followed by ` {`. Every definition in the unit then landed in
    // a namespace its header never declared.
    const out = transformCode(
      'namespace D2Common { namespace Item { namespace ItemMods { void f() { Forms::D2WinImage::Draw(p); } } } }',
      { typeQualifierNames: ['Item', 'D2WinImage'] }
    );
    assert.ok(/namespace Item\b/.test(out), out);
    assert.ok(/namespace ItemMods\b/.test(out), out);
    assert.ok(/Forms::Draw\(p\)/.test(out), out);
  });

  describe('external stdcall import undecoration', () => {
    // The declaration table's own rule, handed in as a closed set: an import
    // whose Ghidra name is `_BinkClose@4` is declared `BinkClose` and
    // `__stdcall` puts the `@4` back, so the reference has to move with it.
    const importRenames = {
      _BinkClose_4: 'BinkClose',
      _BinkOpenDirectSound_4: 'BinkOpenDirectSound',
      _BinkSetSoundSystem_8: 'BinkSetSoundSystem',
      _SmackOpen_12: 'SmackOpen',
    };

    it('respells a call site onto the declared identifier', () => {
      const out = transformCode(
        'void f() { _BinkClose_4(gpBink); _SmackOpen_12(sz, 0xfe000, -1); }',
        { importRenames }
      );
      assert.ok(/\bBinkClose\(gpBink\)/.test(out), out);
      assert.ok(/\bSmackOpen\(sz/.test(out), out);
      assert.ok(!/_BinkClose_4|_SmackOpen_12/.test(out), out);
    });

    it('respells the reference that also carries the _exref suffix', () => {
      // `_BinkOpenDirectSound_4` NEVER appears bare in any body — only as
      // `_BinkOpenDirectSound_4_exref`. A pass that ran before the suffix came
      // off would miss it and leave one call site spelling the old name.
      const out = transformCode(
        'void f() { _BinkSetSoundSystem_8(_BinkOpenDirectSound_4_exref, 0); }',
        { importRenames }
      );
      assert.ok(/BinkSetSoundSystem\(BinkOpenDirectSound, 0\)/.test(out), out);
      assert.ok(!/_exref/.test(out), out);
    });

    it('renames nothing outside the set', () => {
      // Stack slots and a Glide import SLOT — the slot is data globals.h
      // declares, and renaming it turns its store into "assignment of function".
      const src = 'void f() { int _iStack_10; int _local_8; '
        + 'GLIDEDLL_grSstWinClose_4 = (void*)p; _GLIDEDLL_grSstWinClose_4(h); }';
      const out = transformCode(src, { importRenames });
      assert.ok(/_iStack_10/.test(out), out);
      assert.ok(/_local_8/.test(out), out);
      assert.ok(/GLIDEDLL_grSstWinClose_4 = /.test(out), out);
      assert.ok(/_GLIDEDLL_grSstWinClose_4\(h\)/.test(out), out);
    });

    it('leaves the same characters inside a string literal alone', () => {
      const out = transformCode(
        'void f() { Log("_BinkClose_4 failed"); }',
        { importRenames }
      );
      assert.ok(out.includes('"_BinkClose_4 failed"'), out);
    });

    it('is a no-op with no set', () => {
      const out = transformCode('void f() { _BinkClose_4(p); }');
      assert.ok(/_BinkClose_4\(p\)/.test(out), out);
    });
  });

  it('strips the _exref import-thunk suffix', () => {
    const out = transformCode('void f() { Fog_10021_exref(nMode); }');
    assert.ok(/\bFog_10021\(nMode\)/.test(out), out);
    assert.ok(!/_exref/.test(out), out);
  });

  it('leaves the same characters inside a string literal alone', () => {
    // The predecessor regexes ran over the emitted TEXT, so a message string that
    // happens to name a CRT namespace, a repeated qualifier or an _exref symbol
    // was rewritten mid-string. A StringLiteral is not a name node.
    const out = transformCode(
      'void f() { Log("VisualStudio::sprintf failed in Drlg::Drlg::RollSeed via Fog_10021_exref"); }'
    );
    assert.ok(
      out.includes('"VisualStudio::sprintf failed in Drlg::Drlg::RollSeed via Fog_10021_exref"'),
      out
    );
  });
});
