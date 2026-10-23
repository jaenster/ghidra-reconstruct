import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ExtractedDataType } from '../types.js';
import { buildAggregateLayouts } from './aggregate-layout.js';

function struct(name: string, size: number, fields: Array<[string, number, number]>, extra: object = {}): ExtractedDataType {
  return {
    name, category: '/t', size, kind: 'STRUCTURE',
    fields: fields.map(([dataType, offset, sz], i) => ({ name: `f${i}`, dataType, offset, size: sz })),
    ...extra,
  } as unknown as ExtractedDataType;
}

describe('buildAggregateLayouts', () => {
  it('aligns an unpacked struct like its widest member, at Ghidra\'s size', () => {
    // D2AutomapFileEntryStrc: eleven dwords, Ghidra alignment 1, natural layout reproduces it.
    const fields: Array<[string, number, number]> = [];
    for (let i = 0; i < 7; i++) fields.push(['int', i * 4, 4]);
    for (let i = 7; i < 11; i++) fields.push(['void *', i * 4, 4]);
    const out = buildAggregateLayouts([struct('Entry', 44, fields, { alignment: 1 })]);
    assert.deepStrictEqual(out.Entry, { size: 44, align: 4 });
  });

  it('gives a struct the emitter packs alignment 1', () => {
    const out = buildAggregateLayouts([
      struct('Hdr', 13, [['uint8_t', 0, 1], ['uint32_t', 1, 4], ['uint32_t', 5, 4], ['uint32_t', 9, 4]]),
    ]);
    assert.deepStrictEqual(out.Hdr, { size: 13, align: 1 });
  });

  it('follows nested aggregates and typedefs', () => {
    const out = buildAggregateLayouts([
      struct('Inner', 8, [['short', 0, 2], ['short', 2, 2], ['MyWord', 4, 4]]),
      struct('Outer', 16, [['Inner', 0, 8], ['Inner[1]', 8, 8]], { alignment: 4 }),
    ], { MyWord: 'uint32_t' });
    assert.deepStrictEqual(out.Inner, { size: 8, align: 4 });
    assert.deepStrictEqual(out.Outer, { size: 16, align: 4 });
  });

  it('leaves out what it cannot derive', () => {
    const out = buildAggregateLayouts([
      struct('Opaque', 8, [['HMYSTERY', 0, 4], ['int', 4, 4]], { alignment: 4 }),
      struct('Bits', 4, [['int:3', 0, 4]], { alignment: 4 }),
      struct('Empty', 4, []),
      struct('Twice', 4, [['int', 0, 4]]),
      struct('Twice', 8, [['int', 0, 4], ['int', 4, 4]]),
    ]);
    assert.deepStrictEqual(Object.keys(out), []);
  });

  it('sizes a union by Ghidra and aligns it like its widest member', () => {
    const out = buildAggregateLayouts([{
      name: 'U', category: '/t', size: 8, kind: 'UNION',
      fields: [{ name: 'a', dataType: 'double', offset: 0, size: 8 }, { name: 'b', dataType: 'char[8]', offset: 0, size: 8 }],
    } as unknown as ExtractedDataType]);
    assert.deepStrictEqual(out.U, { size: 8, align: 8 });
  });
});
