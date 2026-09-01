import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { underscoreSlotLocalPlugin } from '../builtins/underscore-slot-local.js';

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
});
