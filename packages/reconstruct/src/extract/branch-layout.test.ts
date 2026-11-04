import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseBranchLayout, parsePushes } from './branch-layout.js';

describe('parseBranchLayout - edges and return entries', () => {
  const row = ['004e1740', '27', '20:a;21:c', '20:a;23:12', '', '', 'c:d:POP/ESI.RET:f;1e:24:MOV/EAX.POP/ESI.RET:f12',
    '20.0:if:a:10:c:21:23;23.0:if:12:1e:14:24:26'].join('\t');

  it('reads each keyword jump with the lines its edges lead to', () => {
    const f = parseBranchLayout(row).get('004e1740')!;
    assert.deepStrictEqual(f.edges, [
      { line: 20, ord: 0, keyword: 'if', jcc: 0xa, target: 0x10, fall: 0xc, fallLines: [21], takenLines: [23] },
      { line: 23, ord: 0, keyword: 'if', jcc: 0x12, target: 0x1e, fall: 0x14, fallLines: [24], takenLines: [26] },
    ]);
  });

  it('reads the jump mnemonic where the row carries it', () => {
    const r = row.replace('23.0:if:12:1e:14:24:26', '23.0:if:12:1e:14:24:26:JNS');
    const f = parseBranchLayout(r).get('004e1740')!;
    assert.strictEqual(f.edges![1].cc, 'JNS');
    assert.strictEqual('cc' in f.edges![0], false);
  });

  it('reads how each return copy is entered', () => {
    const f = parseBranchLayout(row).get('004e1740')!;
    assert.deepStrictEqual(f.returns!.map(r => [r.start, r.fallsIn, r.jumpsIn]), [[0xc, true, []], [0x1e, true, [0x12]]]);
  });

  it('leaves both unset in a row from an older script', () => {
    const old = row.split('\t').slice(0, 7).map((c, i) => (i === 6 ? 'c:d:RET' : c)).join('\t');
    const f = parseBranchLayout(old).get('004e1740')!;
    assert.strictEqual(f.edges, undefined);
    assert.strictEqual(f.returns![0].jumpsIn, undefined);
  });
});

describe('branch-layout pushes', () => {
  // OOGUTIL_UpdateLevelRestrictionControls, 004451c0, as the daemon printed it.
  it('reads each push and the run it sits in', () => {
    assert.deepStrictEqual(parsePushes('81:4:-:-:0;9e:4:120:j:3;11e:5:120:f:3;-10:-1:-8:j:1'), [
      { at: 0x81, value: 4 },
      { at: 0x9e, value: 4, reach: 0x120, jumps: true, run: 3 },
      { at: 0x11e, value: 5, reach: 0x120, jumps: false, run: 3 },
      { at: -0x10, value: -1, reach: -8, jumps: true, run: 1 },
    ]);
  });

  it('takes the column after the edges, and leaves it out of older rows', () => {
    const row = ['004451c0', '3', '1:6', '', '', '', '', ''];
    assert.strictEqual(parseBranchLayout(row.join('\t')).get('004451c0')!.pushes, undefined);
    const facts = parseBranchLayout([...row, '9e:4:120:j:3'].join('\t')).get('004451c0')!;
    assert.deepStrictEqual(facts.pushes, [{ at: 0x9e, value: 4, reach: 0x120, jumps: true, run: 3 }]);
  });
});
