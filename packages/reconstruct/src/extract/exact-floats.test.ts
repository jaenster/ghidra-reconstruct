/**
 * Ghidra values float data as rounded text; the bytes are exact. sinTable_f32
 * (00707800) and DOUBLE_006da6b0 are the two the data metric found wrong.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { applyExactFloatBytes, exactFloatSpelling, fetchExactFloatData, floatDataWidth } from './exact-floats.js';
import { fetchInitializedData } from './globals.js';
import type { GhidraConnection } from '../types.js';
import type { AnalyzedDataSymbol } from '../types.js';

function f32(...values: number[]): Uint8Array {
  const b = new Uint8Array(values.length * 4);
  const v = new DataView(b.buffer);
  values.forEach((x, i) => v.setFloat32(i * 4, x, true));
  return b;
}
function f64(...values: number[]): Uint8Array {
  const b = new Uint8Array(values.length * 8);
  const v = new DataView(b.buffer);
  values.forEach((x, i) => v.setFloat64(i * 8, x, true));
  return b;
}
const readC = (text: string, width: 4 | 8) => width === 4 ? Math.fround(Number.parseFloat(text)) : Number.parseFloat(text);

describe('exact float data', () => {
  it('reads the widths of float, double and their arrays only', () => {
    assert.strictEqual(floatDataWidth('float[512]'), 4);
    assert.strictEqual(floatDataWidth('double'), 8);
    assert.strictEqual(floatDataWidth('double[3][4]'), 8);
    assert.strictEqual(floatDataWidth('float10'), null);
    assert.strictEqual(floatDataWidth('D2CoordStrc'), null);
  });

  it('respells a sinTable element Ghidra rounded, keeps one that reads back', () => {
    const sin1 = Math.fround(Math.sin(2 * Math.PI / 512));
    const g = {
      name: 'sinTable_f32', address: '00707800', dataType: 'float[3]', size: 12, isInitialized: true,
      initializedData: { kind: 'array', elements: [
        { kind: 'scalar', value: '0.0' }, { kind: 'scalar', value: '0.01227154' }, { kind: 'scalar', value: '0.5' },
      ] },
    } as unknown as AnalyzedDataSymbol;
    // The rounded text is wrong in the float slot: the premise of the fix.
    assert.notStrictEqual(readC('0.01227154', 4), sin1);
    const n = applyExactFloatBytes(g, f32(0, sin1, 0.5));
    assert.strictEqual(n, 1);
    const els = g.initializedData!.elements!;
    assert.strictEqual(els[0].value, '0.0');
    assert.strictEqual(els[2].value, '0.5');
    assert.strictEqual(readC(els[1].value!, 4), sin1);
  });

  it('respells DOUBLE_006da6b0 in both the value and the scalar data', () => {
    const exact = Math.fround(0.05);
    const g = {
      name: 'DOUBLE_006da6b0', address: '006da6b0', dataType: 'double', size: 8, isInitialized: true,
      value: '0.0500000007450581', initializedData: { kind: 'scalar', value: '0.0500000007450581' },
    } as unknown as AnalyzedDataSymbol;
    assert.notStrictEqual(readC('0.0500000007450581', 8), exact);
    applyExactFloatBytes(g, f64(exact));
    assert.strictEqual(readC(g.value!, 8), exact);
    assert.strictEqual(g.initializedData!.value, g.value);
  });

  it('keeps an exact Ghidra spelling, also -2 and E-notation', () => {
    const g = { name: 'D', address: '1', dataType: 'double', size: 8, isInitialized: true, value: '9.5367431640625E-7' } as unknown as AnalyzedDataSymbol;
    assert.strictEqual(applyExactFloatBytes(g, f64(2 ** -20)), 0);
    const h = { name: 'D', address: '1', dataType: 'double', size: 8, isInitialized: true, value: '-2' } as unknown as AnalyzedDataSymbol;
    assert.strictEqual(applyExactFloatBytes(h, f64(-2)), 0);
  });

  it('spells -0.0, infinities, denormals and NaN payloads exactly', () => {
    assert.strictEqual(exactFloatSpelling(f64(-0), 0, 8), '-0.0');
    assert.strictEqual(exactFloatSpelling(f32(Infinity), 0, 4), '+Infinity');
    assert.strictEqual(exactFloatSpelling(f64(-Infinity), 0, 8), '-Infinity');
    const den = Math.fround(1.401298464324817e-45);
    assert.strictEqual(readC(exactFloatSpelling(f32(den), 0, 4), 4), den);
    const nan = new Uint8Array([0x01, 0x00, 0xc0, 0xff]); // -NaN, quiet, payload 0x400001
    assert.strictEqual(exactFloatSpelling(nan, 0, 4), '-__builtin_nanf("0x400001")');
    assert.strictEqual(exactFloatSpelling(f64(1024), 0, 8), '1024.0');
    // A -0.0 Ghidra printed as 0.0 is respelled: the sign bit is a different datum.
    const z = { name: 'Z', address: '1', dataType: 'float', size: 4, isInitialized: true, value: '0.0' } as unknown as AnalyzedDataSymbol;
    assert.strictEqual(applyExactFloatBytes(z, f32(-0)), 1);
    assert.strictEqual(z.value, '-0.0');
  });

  it('reads the bytes through read_memory, and a failed read changes nothing', async () => {
    const g = {
      name: 'DOUBLE_006da6b0', address: '006da6b0', dataType: 'double', size: 8, isInitialized: true, value: '0.05',
    } as unknown as AnalyzedDataSymbol;
    const other = { name: 'gnX', address: '00700000', dataType: 'int', size: 4, isInitialized: true, value: '5' } as unknown as AnalyzedDataSymbol;
    const asked: unknown[] = [];
    const conn = {
      async sendCommand<T>(command: string, params?: Record<string, unknown>): Promise<T> {
        asked.push({ command, ...params });
        return { bytes: Buffer.from(f64(Math.fround(0.05))).toString('base64'), length: 8 } as T;
      },
    };
    const r = await fetchExactFloatData(conn, [g, other]);
    assert.deepStrictEqual(asked, [{ command: 'read_memory', address: '006da6b0', length: 8 }]);
    assert.strictEqual(r.respelled, 1);
    assert.strictEqual(g.value, '0.05000000074505806');
    const failing = { async sendCommand<T>(): Promise<T> { throw new Error('down'); } };
    const h = { ...g, value: '0.05' } as AnalyzedDataSymbol;
    await fetchExactFloatData(failing, [h]);
    assert.strictEqual(h.value, '0.05');
  });

  it('is part of fetchInitializedData, which the extraction and the live model both read through', async () => {
    const g = {
      name: 'gdBytesToMegabytes', address: '006cccb0', dataType: 'double', size: 8, isInitialized: true,
      value: '9.536743E-7', scope: 'global',
    } as unknown as AnalyzedDataSymbol;
    const conn = {
      async sendCommand<T>(command: string): Promise<T> {
        if (command === 'read_memory') return { bytes: Buffer.from(f64(2 ** -20)).toString('base64'), length: 8 } as T;
        return { value: { kind: 'scalar', value: '9.536743E-7' } } as T;
      },
    } as unknown as GhidraConnection;
    await fetchInitializedData(conn, [g]);
    assert.strictEqual(Number.parseFloat(g.value!), 2 ** -20);
    assert.strictEqual(Number.parseFloat(g.initializedData!.value!), 2 ** -20);
  });
});
