/**
 * TXT_ParseDataAndPutIntoStructure's switch reads its case index through the jump
 * table's last byte: MSVC addresses the 1-based byte table at 0x6be0d8 as 0x6be0d7.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createBiasedTableIndexTransformer } from '../builtins/biased-table-index.js';

const TABLES = {
  globalAddresses: { TXT_ParseFieldTypeJumpTable: 0x6be0b8, TXT_ParseFieldTypeCaseIndex: 0x6be0d8 },
  globalSizes: { TXT_ParseFieldTypeJumpTable: 32, TXT_ParseFieldTypeCaseIndex: 26 },
  globalElementSizes: { TXT_ParseFieldTypeJumpTable: 4, TXT_ParseFieldTypeCaseIndex: 1 },
  enumValues: { FIELDTYPE_LINKER_UNK: 24, FIELDTYPE_ASCII2: 7 },
};

function transform(code: string): string {
  return emit(createBiasedTableIndexTransformer(TABLES)(parse(code)) as AnyNode).trim();
}

describe('biased-table-index', () => {
  it('the raw v1103 switch expression indexes the case table, 1-based', () => {
    const out = transform(`void f(D2BinFieldInputStrc *p, int i) {
      switch(*(undefined1 *)((int)Fog::Src::Excel::Excel::TXT_ParseFieldTypeJumpTable + p[i].eType + (FIELDTYPE_LINKER_UNK|FIELDTYPE_ASCII2))) { case 0: break; } }`);
    assert.match(out, /switch \(Fog::Src::Excel::Excel::TXT_ParseFieldTypeCaseIndex\[p\[i\]\.eType - 1\]\)/, out);
    assert.ok(!out.includes('JumpTable'), out);
  });

  it('reads the same byte as the machine for every field type (the 1.14d bytes)', () => {
    // 0x6be0b8..0x6be0f1 as read from Game.exe: 8 case pointers, then the index table.
    const mem = new Uint8Array(32 + 26);
    const index = [0, 1, 1, 1, 1, 1, 0, 1, 2, 3, 4, 3, 4, 3, 4, 3, 3, 3, 5, 5, 5, 6, 7, 7, 7, 1];
    mem.set(index, 32);
    for (let eType = 1; eType <= 26; eType++) {
      const machine = mem[0 + eType + (24 | 7)];          // [EDX + 0x6be0d7]
      const rebuilt = mem.subarray(32)[eType - 1];          // CaseIndex[eType - 1]
      assert.strictEqual(rebuilt, machine, `eType ${eType}`);
    }
  });

  it('an address inside the symbol, or a wider read, is left alone', () => {
    for (const src of [
      'int f(int i) { return *(byte *)((int)TXT_ParseFieldTypeJumpTable + i + 4); }',
      'int f(int i) { return *(int *)((int)TXT_ParseFieldTypeJumpTable + i + 31); }',
    ]) assert.ok(!transform(src).includes('CaseIndex'), src);
  });
});
