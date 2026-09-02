/**
 * An enum is emitted at the width Ghidra models it at.
 *
 * The defect this pins: `eCollisionFlags` is a 2-byte enum (17 members, 0..32768)
 * and the tree spelled it `typedef int eCollisionFlags;`. `D2RoomCollisionGridStrc`
 * holds `eCollisionFlags aMap[1]` at offset 0x24 and the disassembly indexes it
 * `MOVZX EAX, word ptr [ECX+ESI*0x2]` - a 4-byte stride reads the wrong element
 * on every access and nothing reports it. `D2IniConfigStrc` is the same story
 * from 0x1EE on.
 *
 * Every fixture here is the real Ghidra record, sizes taken from the live
 * program (1.14d Game.exe, /windows/lod/): eCollisionFlags is 2 with
 * alignment 2, eD2PlayerClassID is 1, eD2PlayerStatus is 2, eD2MonsterAnimMode
 * is 4.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { ExtractedEnum, ExtractedStruct } from '../types.js';
import {
  enumUnderlyingType,
  enumUnderlyingFor,
  enumTypedefLine,
  setKnownEnumWidths,
  clearKnownEnumWidths,
} from '../codegen/enum-width.js';
import { generateEnumDeclaration, generateStructDeclaration } from '../codegen/header.js';

const COLLISION_FLAGS: ExtractedEnum = {
  name: 'eCollisionFlags',
  category: '/Diablo2/COLLISION',
  size: 2,
  kind: 'ENUM',
  values: [
    { name: 'COLBIT_NONE', value: 0 },
    { name: 'COLBIT_WALL', value: 1 },
    { name: 'COLBIT_4000', value: 16384 },
    { name: 'COLBIT_DEAD', value: 32768 },
  ],
};

const MONSTER_ANIM_MODE: ExtractedEnum = {
  name: 'eD2MonsterAnimMode',
  category: '/Diablo2/UNIT/MODE',
  size: 4,
  kind: 'ENUM',
  values: [
    { name: 'MONSTER_MODE_DEATH', value: 0 },
    { name: 'MONSTER_MODE_NEUTRAL', value: 1 },
  ],
};

const PLAYER_CLASS_ID: ExtractedEnum = {
  name: 'eD2PlayerClassID',
  category: '/Diablo2/UNIT',
  size: 1,
  kind: 'ENUM',
  values: [
    { name: 'PCLASS_AMAZON', value: 0 },
    { name: 'PCLASS_ASSASSIN', value: 7 },
  ],
};

describe('enum width follows the size Ghidra models', () => {
  beforeEach(() => clearKnownEnumWidths());

  it('a 2-byte enum gets a 2-byte underlying type', () => {
    assert.strictEqual(enumUnderlyingType(COLLISION_FLAGS), 'uint16_t');
  });

  it('picks UNSIGNED at 2 bytes because 32768 does not fit int16_t', () => {
    const max = Math.max(...COLLISION_FLAGS.values.map(v => Number(v.value)));
    assert.ok(max > 32767, 'fixture must carry the member that forces unsigned');
    assert.ok(COLLISION_FLAGS.values.every(v => Number(v.value) >= 0));
    assert.strictEqual(enumUnderlyingType(COLLISION_FLAGS), 'uint16_t');
  });

  it('picks a SIGNED underlying type when a member is negative', () => {
    const signed: ExtractedEnum = {
      ...COLLISION_FLAGS,
      name: 'eSignedTwoByte',
      values: [{ name: 'A', value: -1 }, { name: 'B', value: 1 }],
    };
    assert.strictEqual(enumUnderlyingType(signed), 'int16_t');
  });

  it('a 1-byte enum gets a 1-byte underlying type', () => {
    assert.strictEqual(enumUnderlyingType(PLAYER_CLASS_ID), 'uint8_t');
  });

  it('a 4-byte enum is UNCHANGED - still plain int', () => {
    assert.strictEqual(enumUnderlyingType(MONSTER_ANIM_MODE), 'int');
  });

  it('an enum with no size keeps int rather than guessing from its members', () => {
    // Narrowing a genuinely 4-byte enum because its largest member happens to
    // fit in 16 bits is the failure this guards.
    const noSize = { values: COLLISION_FLAGS.values };
    assert.strictEqual(enumUnderlyingType(noSize), 'int');
  });

  it('an odd size Ghidra can model but C++ has no integer for keeps int', () => {
    assert.strictEqual(enumUnderlyingType({ size: 3, values: [] }), 'int');
  });
});

describe('the enum declaration carries the width', () => {
  beforeEach(() => clearKnownEnumWidths());

  it('emits typedef uint16_t for the 2-byte eCollisionFlags', () => {
    const out = generateEnumDeclaration(COLLISION_FLAGS);
    assert.ok(
      out.includes('typedef uint16_t eCollisionFlags;'),
      `expected a 2-byte typedef, got:\n${out}`
    );
    assert.ok(!out.includes('typedef int eCollisionFlags;'));
  });

  it('still emits typedef int for a 4-byte enum', () => {
    const out = generateEnumDeclaration(MONSTER_ANIM_MODE);
    assert.ok(out.includes('typedef int eD2MonsterAnimMode;'), out);
  });

  it('keeps the member constants, typed by the enum name', () => {
    const out = generateEnumDeclaration(COLLISION_FLAGS);
    assert.ok(out.includes('constexpr eCollisionFlags COLBIT_DEAD = 32768;'), out);
  });
});

describe('the registry keeps every spelling of one name identical', () => {
  beforeEach(() => clearKnownEnumWidths());

  it('a forward declaration by NAME matches the definition', () => {
    setKnownEnumWidths([COLLISION_FLAGS, MONSTER_ANIM_MODE]);
    assert.strictEqual(enumTypedefLine('eCollisionFlags'), 'typedef uint16_t eCollisionFlags;');
    assert.strictEqual(enumTypedefLine('eD2MonsterAnimMode'), 'typedef int eD2MonsterAnimMode;');
  });

  it('an unregistered name falls back to int', () => {
    setKnownEnumWidths([COLLISION_FLAGS]);
    assert.strictEqual(enumTypedefLine('eSomethingElse'), 'typedef int eSomethingElse;');
  });

  it('two categories that AGREE on the width both get it', () => {
    // Ghidra really does carry eCollisionFlags twice: /Diablo2/COLLISION and
    // /_Source/Collision, both 2 bytes.
    setKnownEnumWidths([
      COLLISION_FLAGS,
      { ...COLLISION_FLAGS, category: '/_Source/Collision' },
    ]);
    assert.strictEqual(enumUnderlyingFor('eCollisionFlags'), 'uint16_t');
  });

  it('two categories that DISAGREE keep int rather than pick one', () => {
    // eD2ServerIncomingStatus is 1 byte under /Diablo2/NETWORK/D2GS and 4 under /.
    const one: ExtractedEnum = {
      name: 'eD2ServerIncomingStatus', category: '/Diablo2/NETWORK/D2GS',
      size: 1, kind: 'ENUM', values: [{ name: 'A', value: 0 }],
    };
    const four: ExtractedEnum = { ...one, category: '/', size: 4 };
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (m: string) => { warnings.push(String(m)); };
    try {
      setKnownEnumWidths([one, four]);
    } finally {
      console.warn = realWarn;
    }
    assert.strictEqual(enumUnderlyingFor('eD2ServerIncomingStatus'), 'int');
    assert.ok(warnings.some(w => w.includes('eD2ServerIncomingStatus')), warnings.join('\n'));
  });

  it('the registry beats the record handed in, so definition and forward decl agree', () => {
    const one: ExtractedEnum = {
      name: 'eD2ServerIncomingStatus', category: '/Diablo2/NETWORK/D2GS',
      size: 1, kind: 'ENUM', values: [{ name: 'A', value: 0 }],
    };
    const four: ExtractedEnum = { ...one, category: '/', size: 4 };
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      setKnownEnumWidths([one, four]);
    } finally {
      console.warn = realWarn;
    }
    assert.strictEqual(enumTypedefLine('eD2ServerIncomingStatus', one), 'typedef int eD2ServerIncomingStatus;');
    assert.ok(generateEnumDeclaration(one).includes('typedef int eD2ServerIncomingStatus;'));
  });
});

describe('a struct field of a narrow enum lands at the right offset', () => {
  beforeEach(() => clearKnownEnumWidths());

  // The real tail of D2IniConfigStrc, from the field that exposes the defect.
  const INI_CONFIG_TAIL: ExtractedStruct = {
    name: 'D2IniConfigTailStrc',
    category: '/Diablo2/APP',
    size: 8,
    kind: 'STRUCTURE',
    fields: [
      { name: 'nCTEMP_MaybePlayerClass', dataType: 'char', offset: 0, size: 1 },
      { name: 'eCTEMP_eD2PlayerClassID', dataType: 'eD2PlayerClassID', offset: 1, size: 1 },
      { name: 'eCTEMP_eD2PlayerStatus', dataType: 'eD2PlayerStatus', offset: 2, size: 2 },
      { name: 'bNOMONSTERS', dataType: 'bool', offset: 4, size: 1 },
    ],
  };

  it('sizeof the emitted field types reproduces Ghidra offsets', () => {
    const playerStatus: ExtractedEnum = {
      name: 'eD2PlayerStatus', category: '/Diablo2/UNIT', size: 2, kind: 'ENUM',
      values: [{ name: 'PSTATUS_A', value: 1 }, { name: 'PSTATUS_B', value: 128 }],
    };
    setKnownEnumWidths([PLAYER_CLASS_ID, playerStatus]);

    const WIDTH: Record<string, number> = {
      char: 1, bool: 1, int: 4, uint8_t: 1, int8_t: 1, uint16_t: 2, int16_t: 2,
    };
    let cursor = 0;
    for (const f of INI_CONFIG_TAIL.fields) {
      assert.strictEqual(
        cursor, f.offset,
        `${f.name} should sit at 0x${f.offset.toString(16)}, the emitted types put it at 0x${cursor.toString(16)}`
      );
      const spelled = /^e[A-Z]/.test(f.dataType) ? enumUnderlyingFor(f.dataType) : f.dataType;
      const w = WIDTH[spelled];
      assert.ok(w !== undefined, `no width known for emitted type ${spelled}`);
      cursor += w;
    }
  });

  it('the emitted struct declares the enum fields, offsets annotated', () => {
    setKnownEnumWidths([PLAYER_CLASS_ID]);
    const out = generateStructDeclaration(INI_CONFIG_TAIL);
    assert.ok(out.includes('eD2PlayerClassID'), out);
    assert.ok(/0x01.*eCTEMP_eD2PlayerClassID/.test(out), out);
  });
});

describe('the eCollisionFlags array that the disassembly strides by 2', () => {
  beforeEach(() => clearKnownEnumWidths());

  const COLLISION_GRID: ExtractedStruct = {
    name: 'D2RoomCollisionGridStrc',
    category: '/Diablo2/DRLG',
    size: 0x26,
    kind: 'STRUCTURE',
    fields: [
      { name: 'sCoords', dataType: 'D2DrlgRoomCoordsStrc', offset: 0x00, size: 32 },
      { name: 'pMapStart', dataType: 'eCollisionFlags *', offset: 0x20, size: 4 },
      { name: 'aMap', dataType: 'eCollisionFlags[1]', offset: 0x24, size: 2 },
    ],
  };

  it('aMap is a 2-byte element, matching MOVZX word ptr [ECX+ESI*0x2]', () => {
    setKnownEnumWidths([COLLISION_FLAGS]);
    const aMap = COLLISION_GRID.fields.find(f => f.name === 'aMap')!;
    assert.strictEqual(aMap.size, 2, 'Ghidra models one element of aMap as 2 bytes');
    // Emitted element width must equal the stride the machine code uses.
    assert.strictEqual(enumUnderlyingFor('eCollisionFlags'), 'uint16_t');
  });

  it('the struct emits aMap through the narrowed enum', () => {
    setKnownEnumWidths([COLLISION_FLAGS]);
    const out = generateStructDeclaration(COLLISION_GRID);
    assert.ok(/aMap/.test(out), out);
    assert.ok(out.includes('eCollisionFlags'), out);
  });
});
