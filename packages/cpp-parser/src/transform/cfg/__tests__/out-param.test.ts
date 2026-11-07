/**
 * out-param: the bytes every returning path writes through a pointer parameter before it
 * reads through it, and the same for an argument that is not null.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import type { FunctionDecl, Statement } from '../../../ast/nodes.js';
import { outParamWidths, type OutParamContext } from '../out-param.js';

const SIZES: Record<string, number> = { char: 1, short: 2, int: 4, uint: 4, eD2Skills: 4 };

/** `pointee`: each parameter's pointee width, in order. */
function widths(code: string, pointee: (number | null)[], nonNull = false): Map<number, number> {
  const tu = parse(code) as unknown as { declarations: FunctionDecl[] };
  const f = tu.declarations.find(d => d.kind === NodeKind.FunctionDecl)!;
  const params = f.parameters.map(p => (p as unknown as { name: { name: string } }));
  const ctx: OutParamContext = {
    pointeeWidth: i => pointee[i],
    typeSize: s => SIZES[s.trim()] ?? (s.trim().endsWith('*') ? 4 : null),
    calleeOut: () => null,
    noreturn: new Set(),
  };
  return outParamWidths((f.body as unknown as { statements: Statement[] }).statements, params.map(p => p.name.name), ctx, { nonNull });
}

describe('out-param', () => {
  it('MONSTERTBLS_GetUpgradeDataByMonStatsId: a store guarded by the parameter\'s own null test', () => {
    const code = `int f(int n, eD2Skills *pSkill) {
      if (n >= 0) { if (pSkill) { *pSkill = 3; } return 1; }
      if (pSkill != 0) { *pSkill = 0; }
      return 0;
    }`;
    assert.strictEqual(widths(code, [null, 4]).get(1), undefined);
    assert.strictEqual(widths(code, [null, 4], true).get(1), 4);
  });

  it('a null branch that stores does not make the store certain', () => {
    const code = `int f(int *p) { if (!p) { g(); } else { h(); } return 0; }`;
    assert.strictEqual(widths(code, [4], true).get(0), undefined);
  });

  it('CUBE_PadItemCodeString: four byte stores at constant offsets write the word', () => {
    const code = `void f(char *a, char *p) {
      if (*a == 0) { p[0] = 32; p[1] = 32; p[2] = 32; } else { p[0] = *a; p[1] = 32; p[2] = 32; }
      p[3] = 32;
    }`;
    assert.strictEqual(widths(code, [1, 1]).get(1), 4);
  });

  it('a read of a byte not yet written is not an out-parameter of that width', () => {
    const code = `void f(char *p) { p[0] = 1; g(p[1]); p[1] = 2; }`;
    assert.strictEqual(widths(code, [1]).get(0), undefined);
  });

  it('a gap leaves the width at the bytes before it', () => {
    const code = `void f(char *p) { p[0] = 1; p[2] = 2; }`;
    assert.strictEqual(widths(code, [1]).get(0), 1);
  });
});
