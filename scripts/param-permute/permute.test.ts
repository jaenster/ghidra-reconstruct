import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareTu, coffFunctionSymbols } from './permute.js';

const fn = (st: string, sim = 1, fo = 0, fr = 0) => ({ st, sim, fo, fr, calls: [] as string[] });

describe('compareTu', () => {
  it('counts MATCH gained and lost and status steps', () => {
    const base = new Map([[1, fn('OUR+1', 0.9)], [2, fn('MATCH')], [3, fn('INSN_COUNT_MATCH', 0.8, 8, 4)], [4, fn('INSN_MATCH', 0.95)]]);
    const trial = new Map([[1, fn('MATCH')], [2, fn('INSN_MATCH', 0.99)], [3, fn('INSN_COUNT_MATCH', 0.85, 4, 4)], [4, fn('INSN_MATCH', 0.9)]]);
    assert.deepEqual(compareTu(base, trial), { gained: [1], lost: [2], better: [1, 3], worse: [2, 4] });
    assert.deepEqual(compareTu(base, null).lost, [2]);
  });
});

describe('coffFunctionSymbols', () => {
  it('reads defined function symbols, short and long names', () => {
    const long = '?LongFunctionName@NS@@YAHH@Z';
    const nsym = 3, symPtr = 20;
    const buf = Buffer.alloc(symPtr + nsym * 18 + 4 + long.length + 1);
    buf.writeUInt32LE(symPtr, 8); buf.writeUInt32LE(nsym, 12);
    const sym = (i: number, name: string | number, section: number, type: number) => {
      const o = symPtr + i * 18;
      if (typeof name === 'number') { buf.writeUInt32LE(0, o); buf.writeUInt32LE(name, o + 4); } else buf.write(name, o, 'latin1');
      buf.writeInt16LE(section, o + 12); buf.writeUInt16LE(type, o + 14);
    };
    sym(0, '_f', 1, 0x20);
    sym(1, '_data', 2, 0);
    sym(2, 4, 1, 0x20);
    const st = symPtr + nsym * 18;
    buf.writeUInt32LE(4 + long.length + 1, st); buf.write(long, st + 4, 'latin1');
    assert.deepEqual(coffFunctionSymbols(buf), ['_f', long]);
  });
});
