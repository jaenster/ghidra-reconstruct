import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { underscoreSlotLocalPlugin } from '../builtins/underscore-slot-local.js';
import type { AccessOrderEvidence, StoreFact } from '../builtins/access-order-evidence.js';

describe('underscoreSlotLocalPlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = underscoreSlotLocalPlugin.createTransformer({});
    return emit(transformer(ast) as AnyNode);
  }

  it('declares `_bResult` even when it only appears in `return _bResult;`', () => {
    // The regex predecessor misparsed `return _bResult;` as a declaration (type
    // `return`, name `_bResult`) and so never synthesized it. The AST sees a
    // ReturnStmt, so this is unambiguous.
    const out = transformCode('uint32_t f() { bool bResult; _bResult = 1; return _bResult; }');
    assert.ok(/\b_bResult\b/.test(out), out);
    assert.ok(/;\s*_bResult\s*;|_bResult;/.test(out.replace(/\n/g, ' ')), `expected a '_bResult;' decl in:\n${out}`);
  });

  it('types the synthesized local from the base local', () => {
    const out = transformCode('void f(uint16_t nSuffixId) { _nSuffixId = nSuffixId; }');
    assert.ok(/uint16_t\s+_nSuffixId\s*;/.test(out), `expected 'uint16_t _nSuffixId;' in:\n${out}`);
  });

  it('does NOT synthesize for `_DAT_*` globals', () => {
    const out = transformCode('void f() { _DAT_001234 = 5; }');
    assert.ok(!/\b\w+\s+_DAT_001234\s*;/.test(out), `must not declare a local for _DAT_001234 in:\n${out}`);
  });

  it('does NOT synthesize when there is no matching declared base', () => {
    const out = transformCode('void f(int nOther) { _mysteryThing = nOther; }');
    assert.ok(!/\b\w+\s+_mysteryThing\s*;/.test(out), `must not declare _mysteryThing in:\n${out}`);
  });

  it('renders a width alias as a reinterpret of the base slot, typed from the use', () => {
    // One stack slot holding a 2-byte struct AND a 4-byte pointer: Ghidra keeps one
    // variable and spells the wide access `_sPacket0x89`. A second declaration of the
    // narrow type makes every wide use a type error; the reinterpret is the machine's
    // own view, and it keeps `&sPacket0x89` aliasing the value written through it.
    const out = transformCode(
      'void f(D2GameStrc *pGame) { D2GSPacketClt0x89 sPacket0x89; _sPacket0x89 = pGame;'
      + ' if (_sPacket0x89->pQuestControl != 0) { pGame = _sPacket0x89; } }',
    );
    assert.ok(!/D2GSPacketClt0x89\s+_sPacket0x89\s*;/.test(out), `must not declare the alias:\n${out}`);
    assert.ok(!/\b_sPacket0x89\b/.test(out), `alias must be gone entirely:\n${out}`);
    assert.match(out, /\*\(D2GameStrc\*\*\)&sPacket0x89 = pGame;/);
    assert.match(out, /\(\*\(D2GameStrc\*\*\)&sPacket0x89\)->pQuestControl/);
  });

  it('gives a disagreeing site its own cast rather than one type for the slot', () => {
    // The slot is written 4 bytes wide (a spilled parameter) and read 2 bytes wide.
    // No single type is right for both, so each site carries the width it uses.
    const out = transformCode(
      'void f(D2ObjectOperateFnArg *pOperation) { int16_t nWaypointId; _nWaypointId = pOperation;'
      + ' h(1, &nWaypointId); k(pWaypoint, (uint16_t)_nWaypointId); }',
    );
    assert.match(out, /\*\(D2ObjectOperateFnArg\*\*\)&nWaypointId = pOperation;/);
    assert.match(out, /\(uint16_t\)\*\(uint16_t\*\)&nWaypointId/);
  });

  it('leaves a same-width alias as a synthesized declaration', () => {
    // `_bDone` is the slot reused at its own type - a second local is faithful, and
    // rewriting it to a reinterpret would be noise.
    const out = transformCode('void f(bool bFlag) { bool bDone; _bDone = bDone; g(_bDone); }');
    assert.match(out, /bool\s+_bDone\s*;/);
    assert.ok(!/\*\(bool\*\)&bDone/.test(out), `no reinterpret for a same-width alias:\n${out}`);
  });

  describe('integer alias wider than the base', () => {
    const returnTypes = {
      'D2Common::QuestRecord::GetQuestState': 'BOOL',
      'IsTown': 'bool',
      'GetByte': 'uint8_t',
      'GetMode': 'eD2PlayerMode',
      'Inner::GetCount': 'int',
    };
    function run(code: string, extra: Record<string, unknown> = {}): string {
      const ast = parse(code);
      const transformer = underscoreSlotLocalPlugin.createTransformer({ functionReturnTypes: returnTypes, ...extra });
      return emit(transformer(ast) as AnyNode);
    }

    it('declares the alias with the BOOL a call stores into it, not the base bool', () => {
      // A5Q6::SetCannotComplete: `bool bQuestState` is AL, `_bQuestState` is EAX.
      // As a bool, a GetQuestState result of 2 would compare equal to 1.
      const out = run('int f(D2BitBufferStrc *p) { bool bQuestState;'
        + ' _bQuestState = D2Common::QuestRecord::GetQuestState(p, 0x24, 0);'
        + ' if (_bQuestState == 1) { return 0; } return 1; }');
      assert.match(out, /\bBOOL\s+_bQuestState\s*;/);
      assert.match(out, /\bbool\s+bQuestState\s*;/);
      assert.ok(!/bool\s+_bQuestState/.test(out), out);
    });

    it('resolves an unqualified callee through the enclosing namespace', () => {
      const out = run('void f() { uint8_t nCount; _nCount = GetCount(); g(_nCount); }',
        { enclosingSegments: ['Inner'] });
      assert.match(out, /\bint\s+_nCount\s*;/);
    });

    it('takes the widest of several stores', () => {
      const out = run('void f(short s) { bool bX; _bX = s; _bX = (int)s; g(_bX); }');
      assert.match(out, /\bint\s+_bX\s*;/);
    });

    it('keeps the base type when the stored value is the same width', () => {
      const out = run('void f() { bool bTown; _bTown = IsTown(); g(_bTown); }');
      assert.match(out, /\bbool\s+_bTown\s*;/);
    });

    it('never narrows: a byte stored into a word slot keeps the word', () => {
      const out = run('void f() { uint16_t nId; _nId = GetByte(); g(_nId); }');
      assert.match(out, /\buint16_t\s+_nId\s*;/);
    });

    it('does not widen to an enum or from an untyped value', () => {
      const out = run('void f() { bool bMode; _bMode = GetMode(); _bMode = Unknown(); _bMode = 2; g(_bMode); }');
      assert.match(out, /\bbool\s+_bMode\s*;/);
    });

    it('ignores compound assignment, which is not the value the slot receives', () => {
      const out = run('void f(int n) { uint8_t nFlags; _nFlags = 0; _nFlags |= n; g(_nFlags); }');
      assert.match(out, /\buint8_t\s+_nFlags\s*;/);
    });

    it('widens through a typedef the tables resolve', () => {
      const out = run('void f(D2BOOL v) { bool bOk; _bOk = v; g(_bOk); }',
        { typedefTargets: { D2BOOL: 'int' } });
      assert.match(out, /\bD2BOOL\s+_bOk\s*;/);
    });
  });
  describe('alias width from the original store', () => {
    /** One statement per line; `[n]` tags each `=` of the line with an n-byte store. */
    function run(lines: string[]): string {
      const stores = new Map<number, StoreFact[]>();
      const text = lines.map((l, i) => {
        const m = l.match(/^\s*\[([\d,]+)\]\s?(.*)$/);
        if (!m) return l;
        stores.set(i + 1, m[1].split(',').map((n, ord) => ({ ord, at: null, size: Number(n), half: null })));
        return m[2];
      });
      const ev: AccessOrderEvidence = { args: new Map(), stores };
      const t = underscoreSlotLocalPlugin.createTransformer({ accessOrder: ev } as Record<string, unknown>);
      return emit(t(parse(text.join('\n'))) as AnyNode).replace(/\s+/g, ' ');
    }

    // RENDERER_D3D_BuildWallTileVerticesNoPerspective 006b87a0: the loop offset lives in the
    // dead slot of `byte nParam4`, `mov dword ptr [ebp + 0x18], 0` / `add dword ptr [ebp + 0x18], 0x14`.
    it('declares a copy in a narrow parameter slot at the width the original stores', () => {
      const out = run([
        'int f(uint8_t nParam4, int n) {',
        '[4] _nParam4 = 0;',
        'do {',
        'g(_nParam4);',
        '[4] _nParam4 = _nParam4 + 0x14;',
        '} while (n);',
        'return 0; }',
      ]);
      assert.match(out, /\bint _nParam4;/);
    });

    // Missiles_SrvHitFunc_BlockSelfHitByState 005aa180: `mov edi, 2` / `xor edi, edi` over `bool bResult` in DI.
    it('keeps a register copy that holds 2 out of a bool', () => {
      const out = run([
        'int f(int n) {',
        'bool bResult;',
        '[4] _bResult = 2;',
        'if (n) {',
        '[4] _bResult = 0;',
        '}',
        'return _bResult; }',
      ]);
      assert.match(out, /\bint _bResult;/);
    });

    it('ties a write to its own fact on a line of several', () => {
      const out = run([
        'int f(uint16_t nMask, int e) {',
        '[1,4] if (g(e) && (gb = 0, _nMask = 0, e == 3)) { h(_nMask); }',
        'return 0; }',
      ]);
      assert.match(out, /\bint _nMask;/);
    });

    it('keeps the base width when the original stores it that wide', () => {
      const out = run([
        'int f(int n) {',
        'uint8_t nFlags;',
        '[1] _nFlags = 0;',
        'g(_nFlags);',
        'return 0; }',
      ]);
      assert.match(out, /\buint8_t _nFlags;/);
    });

    it('keeps the base type when two stores disagree', () => {
      const out = run([
        'int f(int n) {',
        'uint8_t nFlags;',
        '[1] _nFlags = 0;',
        '[4] _nFlags = 1;',
        'g(_nFlags);',
        'return 0; }',
      ]);
      assert.match(out, /\buint8_t _nFlags;/);
    });

    it('changes nothing without the facts', () => {
      const t = underscoreSlotLocalPlugin.createTransformer({});
      const out = emit(t(parse('int f(uint8_t nParam4) { _nParam4 = 0; g(_nParam4); return 0; }')) as AnyNode);
      assert.match(out, /\buint8_t\s+_nParam4\s*;/);
    });
  });
});
