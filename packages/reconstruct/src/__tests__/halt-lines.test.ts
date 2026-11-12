import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseHaltLines, haltLinesBatches, haltLinesScript } from '../extract/halt-lines.js';
import { functionFactsScript } from '../extract/function-facts.js';

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

  it('parses every branch into a PUSH beside the one that selects it', () => {
    // SUNITNPC_RollTradeListItemCode: 0x384 is jumped to from +0x30 and fallen into from +0xd6.
    // ARENA_ApplyScoreModifier: 0x7d is also a switch-table target, so no single guard.
    const out = parseHaltLines([
      '00576c90\tc5:ba:383/25/25,384/30/30+d6,389/19/19\t',
      '0053f630\t19:e:73/5/5+a,7d/-/59,6a0/-\t',
    ].join('\n'));
    assert.deepStrictEqual(out.get('00576c90')?.halts[0].paths, [
      { line: 0x383, guard: 0x25, guards: [0x25] }, { line: 0x384, guard: 0x30, guards: [0x30, 0xd6] }, { line: 0x389, guard: 0x19, guards: [0x19] },
    ]);
    assert.deepStrictEqual(out.get('0053f630')?.halts[0].paths, [
      { line: 0x73, guard: 0x5, guards: [0x5, 0xa] }, { line: 0x7d, guard: null, guards: [0x59] }, { line: 0x6a0, guard: null },
    ]);
    assert.ok(haltLinesScript(['00576c90']).includes('java.util.TreeSet<Long> gs'));
  });

  it('the extraction\'s facts script records each way\'s branch set, as the halt-lines script does', () => {
    // The extraction reads halt lines through the combined facts script, not haltLinesScript;
    // a way's branch set must reach the snapshot from there too.
    const script = functionFactsScript(['00576c90']);
    assert.ok(script.includes('java.util.TreeSet<Long> gs'));
    assert.ok(script.includes("if (guards.length() > 0) ways.append('/').append(guards);"));
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
