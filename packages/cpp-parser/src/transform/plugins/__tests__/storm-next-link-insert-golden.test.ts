/**
 * The issue #259 LinkNode inserts as the generator hands them to storm-next-link (v2083 snapshot,
 * codegen wrapper `dummy`, the next word still Ghidra's `uint32_t` in the Storm copies). Each
 * fixture's golden is the whole function after the pass.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createStormNextLinkTransformer } from '../builtins/storm-next-link.js';

const items = ['SGAMEDATA', 'TSHashObjectChunk<SGAMEDATA,HASHKEY_NONE>', 'CELLIST', 'TSHashObjectChunk<CELLIST,HASHKEY_NONE>',
  'StringEntryNode', 'MappingEntryNode'];
const structFields: Record<string, Record<string, string>> = {
  StormLinkStrc: { pPrevLink: 'StormLinkStrc*', pNext: 'intptr_t' },
  StormLinkedListStrc: { nLinkOffset: 'int', link: 'StormLinkStrc' },
};
const structFieldOffsets: Record<string, Record<string, number>> = {
  StormLinkStrc: { pPrevLink: 0, pNext: 4 },
  StormLinkedListStrc: { nLinkOffset: 0, link: 4 },
};
const aggregateSizes: Record<string, number> = { StormLinkStrc: 8, StormLinkedListStrc: 12 };
for (const t of items) {
  const link = `TSLink<${t}>`;
  const list = `TSExplicitList<${t},${t.startsWith('TSHash') ? '16' : '-572662307'}>`;
  structFields[link] = { m_prevlink: `${link}*`, m_next: 'intptr_t' };
  structFields[list] = { m_linkoffset: 'int', m_terminator: link };
  structFieldOffsets[link] = { m_prevlink: 0, m_next: 4 };
  structFieldOffsets[list] = { m_linkoffset: 0, m_terminator: 4 };
  aggregateSizes[link] = 8;
  aggregateSizes[list] = 12;
}
const xf = createStormNextLinkTransformer({ structFields, structFieldOffsets, aggregateSizes });

const fixture = (name: string) => new URL(`./fixtures/storm-insert/${name}`, import.meta.url);
const run = (addr: string) => emit(xf(parse(readFileSync(fixture(`${addr}.c`), 'utf8'))) as AnyNode);

const targets: Array<[string, string]> = [
  ['00417a70', 'TSList_FILEREC_LinkNode'],
  ['00417b80', 'SFILE_InsertFileRecordIntoList2'],
  ['00417c70', 'SFILE_InsertFileRecordIntoList3'],
  ['00417d80', 'SFILE_InsertFileRecordIntoList4'],
  ['004184b0', 'SFILE_InsertFileRecordIntoList5'],
  ['0041c580', 'SSYSTEM_ListUnlinkAndInsert'],
  ['0041ed90', 'LINKEDLIST_MoveNode'],
  ['00420540', 'WND_InsertListNode'],
  ['00426b00', 'LINKEDLIST_LinkNode'],
  ['004502a0', 'TSExplicitList<SGAMEDATA>::LinkNode'],
  ['004508a0', 'TSExplicitList<TSHashObjectChunk<SGAMEDATA>>::LinkNode'],
  ['006024e0', 'TSExplicitList<CELLIST>::LinkNode'],
  ['00603fc0', 'TSExplicitList<TSHashObjectChunk<CELLIST>>::LinkNode'],
  ['0060e490', 'TSExplicitList<StringEntryNode>::LinkNode'],
  // Not in #259's table: the same template for MappingEntryNode.
  ['0060e890', 'TSExplicitList<MappingEntryNode>::LinkNode'],
];

describe('storm-next-link insert side on the #259 functions', () => {
  for (const [addr, name] of targets) {
    it(`${addr} ${name}`, () => {
      const out = run(addr);
      if (process.env.UPDATE_GOLDEN) writeFileSync(fixture(`${addr}.expected.c`), out);
      assert.strictEqual(out, readFileSync(fixture(`${addr}.expected.c`), 'utf8'));
      // One insert through the helper, and the flattened sign test and offset fallback are gone.
      assert.match(out, /\*\([^;]*\*\*\)D2_StormNextLink\([^;]*\) = [^;]*;/);
      assert.doesNotMatch(out, /\*\([^;]*\*\*\)\(\w+ \+ /);
    });
  }
});
