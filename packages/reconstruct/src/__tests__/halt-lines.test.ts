import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseHaltLines, haltLinesBatches, haltLinesScript } from '../extract/halt-lines.js';

describe('halt-lines extraction', () => {
  it('parses the ways into each halt and the probe return addresses', () => {
    const out = parseHaltLines([
      '00598e20\t42:37:186/30,195/6c\t',
      '0048cff0\t71:66:cf5/5f,cf1/-\t48cffd',
      '00403070\t\t40307d',
      '0065c730\t2e:23:81/14,-/-,af/3\t',
      'garbage line',
      '',
    ].join('\n'));
    assert.deepStrictEqual(out.get('00598e20'), {
      halts: [{ at: 0x42, ip: 0x37, paths: [{ line: 0x186, guard: 0x30 }, { line: 0x195, guard: 0x6c }] }],
    });
    assert.deepStrictEqual(out.get('0048cff0'), {
      halts: [{ at: 0x71, ip: 0x66, paths: [{ line: 0xcf5, guard: 0x5f }, { line: 0xcf1, guard: null }] }],
      probeReturns: [0x48cffd],
    });
    assert.deepStrictEqual(out.get('00403070'), { halts: [], probeReturns: [0x40307d] });
    assert.deepStrictEqual(out.get('0065c730')?.halts[0].paths[1], { line: null, guard: null });
    assert.strictEqual(out.size, 4);
  });

  it('batches functions that print a halt or a code-sized constant store', () => {
    const batches = haltLinesBatches([
      { address: '0x00401000', decompiled: 'void f(void) { ERROR_UnrecoverableInternalError_Halt("",a,b); }' },
      { address: '00402000', decompiled: 'void f(void) { local_8 = 0x440ded; }' },
      { address: '00403000', decompiled: 'void f(void) { p = (T *)0x5c12fd; }' },
      { address: '00404000', decompiled: 'void f(void) { n = 0x10; }' },
    ]);
    assert.deepStrictEqual(batches, [['00401000', '00402000', '00403000']]);
    const script = haltLinesScript(batches[0]);
    assert.ok(script.includes('"00401000;00402000;00403000"'));
    assert.ok(script.includes('__alloca_probe') && script.includes('__SEH_prolog4'));
  });
});
