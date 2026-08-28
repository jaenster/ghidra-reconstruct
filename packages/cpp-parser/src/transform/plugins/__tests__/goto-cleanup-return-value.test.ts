/**
 * A `goto` whose target falls through to code that returns a value must never be
 * rewritten into a bare `return;`. The tail of a fallthrough label only reaches the
 * function's implicit return when it is at the tail of the function body AND the
 * function returns void.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { gotoCleanupPlugin } from '../builtins/goto-cleanup/index.js';

function transformCode(code: string): string {
  const ast = parse(code);
  const transformer = gotoCleanupPlugin.createTransformer();
  return emit(transformer(ast) as AnyNode).trim();
}

/** Bare `return;` — a `return` not followed by an expression. */
function hasBareReturn(src: string): boolean {
  return /\breturn\s*;/.test(src);
}

describe('goto-cleanup must not drop return values', () => {
  // Real Ghidra output for D2CMP::GfxHash::GFXHASH_CalcDirectionIndex @ 0060ab80.
  // LAB_0060ac37 sits at the end of the `else` block: falling off it continues to
  // `if (*pnParam == 0) ...` after the if/else, NOT to the end of the function.
  const GFXHASH_CALC_DIRECTION_INDEX = `
uint32_t GFXHASH_CalcDirectionIndex(int32_t nParam, uint *pnParam, byte *pbCelFileData)
{
  uint nDirFrameIdx;
  uint32_t dwDirectionMask;
  int32_t nDirFrameTable;
  int nType;

  nDirFrameIdx = 0;
  *pnParam = 0;
  if (*(int *)(nParam + 8) == 0) {
    *pnParam = 8;
    if (((*(int *)(nParam + 0x10) == 0) || (*(int *)(nParam + 0x10) == 0x11)) ||
       ((*(byte *)(nParam + 0x44) & 2) != 0)) {
      *pnParam = 1;
    }
    if ((*pbCelFileData & 1) == 0) {
      dwDirectionMask = *(uint32_t *)(pbCelFileData + 0x14);
      nDirFrameTable = *(int32_t *)(nParam + 0x40);
      goto LAB_0060ac37;
    }
  }
  else {
    if (*(int *)(nParam + 8) == 1) {
      if ((*pbCelFileData & 1) != 0) {
        return 0;
      }
      *pnParam = (-(uint)(*(int *)(pbCelFileData + 0x14) != 8) & 0xfffffffd) + 4;
      dwDirectionMask = *(uint32_t *)(pbCelFileData + 0x14);
      nDirFrameTable = *(int32_t *)(nParam + 0x40);
    }
    else {
      *pnParam = 1;
      nType = *(int *)(nParam + 8);
      if (nType == 2) goto LAB_0060aba4;
      if ((nType != 6) || ((*(byte *)(nParam + 4) & 2) == 0)) {
        if (nType == 4) goto LAB_0060abc7;
        if (nType != 3) goto LAB_0060aba4;
      }
      if (nType == 4) {
LAB_0060abc7:
        return *(uint *)(nParam + 0x40) / *pnParam;
      }
      if ((*pbCelFileData & 1) != 0) goto LAB_0060aba4;
      dwDirectionMask = *(uint32_t *)(pbCelFileData + 0x14);
      nDirFrameTable = *(int32_t *)(nParam + 0x40);
    }
LAB_0060ac37:
    nDirFrameIdx = CELCMP_GetDirectionFrameTableIndex(nDirFrameTable, dwDirectionMask)
    ;
  }
  if (*pnParam == 0) {
    return 0;
  }
LAB_0060aba4:
  return nDirFrameIdx / *pnParam;
}
`;

  it('GFXHASH_CalcDirectionIndex: keeps the value-returning tail reachable', () => {
    const out = transformCode(GFXHASH_CALC_DIRECTION_INDEX);
    assert.ok(
      !hasBareReturn(out),
      `emitted a bare 'return;' in a uint32_t function:\n${out}`,
    );
    assert.ok(
      out.includes('return nDirFrameIdx / *pnParam;'),
      `lost the function's real return expression:\n${out}`,
    );
    // The inlined path must still reach the shared tail rather than exiting.
    assert.ok(
      out.includes('if (*pnParam == 0)'),
      `the goto path no longer reaches the shared tail:\n${out}`,
    );
  });

  it('does not fabricate a return for a label at the end of an if-branch', () => {
    const out = transformCode(`
int f(int a, int *p) {
  int r;
  r = 0;
  if (a == 0) {
    if (*p) goto LAB_1;
  }
  else {
    r = 1;
LAB_1:
    r = r + *p;
  }
  return r * 2;
}
`);
    assert.ok(!hasBareReturn(out), `bare 'return;' in an int function:\n${out}`);
    assert.ok(out.includes('return r * 2;'), `lost the tail return:\n${out}`);
  });

  it('still fabricates the implicit return at the tail of a void function', () => {
    const out = transformCode(`
void g(int a, int *p) {
  if (a == 0) {
    if (*p) goto LAB_1;
    *p = 1;
    return;
  }
  *p = 2;
LAB_1:
  *p = *p + 1;
}
`);
    assert.ok(!out.includes('goto'), `goto survived in a void function:\n${out}`);
  });

  it('does not fabricate a return at the tail of a non-void function', () => {
    const out = transformCode(`
int h(int a, int *p) {
  if (a == 0) {
    if (*p) goto LAB_1;
    *p = 1;
    return 7;
  }
  *p = 2;
LAB_1:
  *p = *p + 1;
}
`);
    assert.ok(!hasBareReturn(out), `bare 'return;' in an int function:\n${out}`);
  });
});
