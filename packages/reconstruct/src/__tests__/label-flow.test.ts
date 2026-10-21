/**
 * Label flow (extract/label-flow.ts): the per-label instruction facts the copy policy's E6
 * rule reads. The script's rows, full and compact, parse back to the same records.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { labelsOf, labelFlowItems, labelFlowScript, parseLabelFlow } from '../extract/label-flow.js';

const DECOMP = `
void f(void)
{
  if (x) goto LAB_00401059;
  switch (y) {
  case 1:
switchD_00401020_caseD_1:
    g();
  default:
    break;
  }
LAB_00401059:
joined_r0x00401070:
  return;
}`;

describe('label flow', () => {
  it('finds every label a decompile defines, never a case or default', () => {
    assert.deepEqual(labelsOf(DECOMP).sort(), ['LAB_00401059', 'joined_r0x00401070', 'switchD_00401020_caseD_1']);
  });

  it('batches items as fnAddr:label', () => {
    const b = labelFlowItems([{ address: '0x401020', decompiled: DECOMP }], 2);
    assert.equal(b.length, 2);
    assert.equal(b[0][0].split(':')[0], '00401020');
    assert.ok(labelFlowScript(b[0], true).includes('boolean compact = true;'));
    assert.ok(!labelFlowScript(b[0]).includes('__ITEMS__'));
  });

  it('parses full and compact rows to the same record', () => {
    const batch = ['00401020:LAB_00401059', '00401020:switchD_00401020_caseD_1', '00401020:ERROR'];
    const full = parseLabelFlow([
      '00401020:LAB_00401059\t00401059\t1\t2\t0\t1\t0\tJZ\t0',
      '00401020:switchD_00401020_caseD_1\t0040103c\t0\t0\t0\t0\t1\tCALL\t1',
      '00401020:ERROR\tnull',
    ].join('\n'));
    const compact = parseLabelFlow(['0\t=\t1\t2\t0\t1\t0\tJZ\t0', '1\t0040103c\t0\t0\t0\t0\t1\tCALL\t1', '2\tnull'].join('\n'), batch);
    assert.deepEqual(compact, full);
    const rec = full.get('00401020')!;
    assert.deepEqual(rec.LAB_00401059, { address: '00401059', fallIn: true, back: 2, condFwd: 0, uncondFwd: 1, computed: 0, first: 'JZ', pushedArgs: false });
    assert.equal(rec.switchD_00401020_caseD_1.address, '0040103c');
    assert.equal(rec.ERROR, undefined, 'an unresolved label has no record');
  });

  it('resolves a manual switch override target through its override namespace and reads its name', () => {
    const script = labelFlowScript(['0057edd0:override_jmp_0057ee01_case_1']);
    // `case_1` in namespace `jmp_0057ee01`, never the override's own label as the name.
    // The row's address and name are illustrative: no user label exists there at v1531.
    assert.ok(script.includes('nm.startsWith("override_jmp_")'));
    assert.ok(script.includes('a[1].startsWith("override_jmp_")'));
    assert.ok(script.includes('!ps.getParentNamespace().getName().startsWith("jmp_")'));
    const rec = parseLabelFlow('0057edd0:override_jmp_0057ee01_case_1\t0057ee10\t1\t0\t1\t0\t0\tMOV\t0\tcheck_anim_mode').get('0057edd0')!;
    assert.equal(rec.override_jmp_0057ee01_case_1.address, '0057ee10');
    assert.equal(rec.override_jmp_0057ee01_case_1.symbol, 'check_anim_mode');
  });

  it('reads the name Ghidra gives a joined block (the tenth column, `-` for none)', () => {
    // execute_script on Game.exe v1455, inflate @00429bb0 (read-only).
    const rec = parseLabelFlow([
      '00429bb0:joined_r0x00429e3b\t00429e3b\t1\t0\t0\t0\t0\tJNC\t0\tcase_TIME',
      '00429bb0:case_EXLEN\t00429f29\t1\t0\t0\t0\t1\tTEST\t0\t-',
    ].join('\n')).get('00429bb0')!;
    assert.equal(rec.joined_r0x00429e3b.symbol, 'case_TIME');
    assert.equal('symbol' in rec.case_EXLEN, false);
    assert.match(labelFlowScript(['00429bb0:joined_r0x00429e3b']), /getFirstCodeBlockContaining/);
  });
});

