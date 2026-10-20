import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse, NodeKind, type FunctionDecl } from '@ghidra-mcp/cpp-parser';
import { classifyGotos, countLabels, functionAddress, labelPrefix } from './census.js';

function fnOf(src: string): FunctionDecl {
  const tu = parse(src, { recover: true } as any) as any;
  const out: FunctionDecl[] = [];
  const visit = (d: any): void => {
    if (d?.kind === NodeKind.FunctionDecl && d.body) out.push(d);
    d?.declarations?.forEach(visit);
  };
  tu.declarations.forEach(visit);
  return out[0];
}

describe('goto census', () => {
  it('keys a function by its 1.14d comment, inside a namespace too', () => {
    const fn = fnOf(`namespace A {\n// 1.14d: 004CD540\nvoid f() { goto LAB_004cd678; LAB_004cd678: g(); }\n}`);
    assert.equal(functionAddress(fn), '004cd540');
  });

  it('names every Ghidra label family, and a generator copy before its family', () => {
    assert.equal(labelPrefix('LAB_0042afba'), 'LAB_');
    assert.equal(labelPrefix('switchD_0062d9ae_caseD_4'), 'switchD_caseD_');
    assert.equal(labelPrefix('switchD_0046b678'), 'switchD_');
    assert.equal(labelPrefix('joined_r0x004a3758'), 'joined_r0x');
    assert.equal(labelPrefix('code_r0x00412345'), 'code_r0x');
    assert.equal(labelPrefix('override_jmp_00412345_case_1'), 'override_jmp_');
    assert.equal(labelPrefix('joined_r0x004a3758__dup2'), 'dup');
    assert.equal(labelPrefix('returnFunctionAgain'), 'user');
  });

  it('counts gotos per target and the if (false) arms', () => {
    const fn = fnOf(`void f(int x) { if (false) { LAB_1: a(); } else { if (x) goto LAB_1; goto LAB_1; } }`);
    const c = countLabels(fn.body as any);
    assert.equal(c.gotos, 2);
    assert.equal(c.gotoTargets.get('LAB_1'), 2);
    assert.equal(c.ifFalse, 1);
    assert.deepEqual([...c.labelNames], ['LAB_1']);
  });

  it('classifies the arm crossing, the latch continue and the epilogue', () => {
    const rows = classifyGotos(fnOf(`
int f(int a, int b) {
  if (a) { b = 1; LAB_x: b = b << 8; } else { b = 2; if (b) goto LAB_x; }
  do { if (a) goto LAB_l; a = a - 1; LAB_l: ; } while (a);
  if (b == 3) goto LAB_r;
  b = 4;
LAB_r:
  return b;
}`));
    const by = Object.fromEntries(rows.map(r => [r.label, r.cls]));
    assert.equal(by.LAB_x, 'into-other-block');
    assert.equal(by.LAB_l, 'continue');
    assert.equal(by.LAB_r, 'exit-epilogue');
  });

  it('reports a goto whose label is gone as undefined-label, not as a class', () => {
    const rows = classifyGotos(fnOf(`void f() { goto LAB_gone; }`));
    assert.equal(rows[0].cls, 'undefined-label');
  });
});
