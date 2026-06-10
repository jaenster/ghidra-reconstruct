/**
 * Tests for Comma-Expand Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { commaExpandPlugin } from '../builtins/comma-expand.js';

describe('commaExpandPlugin', () => {
  function tx(code: string): string {
    const ast = parse(code);
    return emit(commaExpandPlugin.createTransformer({})(ast) as AnyNode).trim();
  }

  it('1a: splits a bare comma statement into separate statements', () => {
    const out = tx(`void f() { (a(), b(), c()); }`);
    assert.ok(/a\(\);\s*b\(\);\s*c\(\);/.test(out), out);
    assert.ok(!out.includes(','), out);
  });

  it('1b: hoists comma side effects out of a return', () => {
    const out = tx(`int f() { return (x = 1, x + 2); }`);
    assert.ok(/x = 1;\s*return x \+ 2;/.test(out), out);
  });

  it('1c: hoists comma side effects out of an assignment RHS', () => {
    const out = tx(`void f() { y = (x = 1, x + 2); }`);
    assert.ok(/x = 1;\s*y = x \+ 2;/.test(out), out);
  });

  it('1d: hoists a whole-condition comma out of an if', () => {
    const out = tx(`void f() { if ((x = g(), x)) { use(x); } }`);
    assert.ok(/x = g\(\);\s*if \(x\)/.test(out), out);
  });

  it('2: splits an OR-guard early-exit with comma side effects (the pGame case)', () => {
    const out = tx(`void* f(G* pGame) {
      if (!pGame || pGame->eType != 1 ||
          (pMon = (M*)pGame->pAi, !pMon) ||
          (pCur = pMon->list[4], !pCur)) {
        return nullptr;
      }
      return pCur;
    }`);
    // each operand becomes its own guard, assignments hoisted before their test
    assert.ok(/if \(!pGame\)\s*return nullptr;/.test(out), out);
    assert.ok(/if \(pGame->eType != 1\)\s*return nullptr;/.test(out), out);
    assert.ok(/pMon = \(M\s*\*\)pGame->pAi;\s*if \(!pMon\)\s*return nullptr;/.test(out), out);
    assert.ok(/pCur = pMon->list\[4\];\s*if \(!pCur\)\s*return nullptr;/.test(out), out);
    // no comma operator and no original combined condition left
    assert.ok(!out.includes('||'), out);
  });

  it('2: leaves a plain OR-guard (no comma side effects) untouched', () => {
    const out = tx(`int f(int a, int b) { if (a || b) return 1; return 0; }`);
    assert.ok(out.includes('if (a || b)'), out);
  });

  it('3: restructures a while with a comma side effect in its condition (the packet case)', () => {
    const out = tx(`void f() {
      while (pSize && (nRes = GetSize(p, pSize, &n), nRes)) {
        consume();
      }
    }`);
    assert.ok(/while \(true\)/.test(out), out);
    assert.ok(/if \(!pSize\)\s*break;/.test(out), out);
    assert.ok(/nRes = GetSize\(p, pSize, &n\);\s*if \(!nRes\)\s*break;/.test(out), out);
    assert.ok(out.includes('consume();'), out);
  });

  it('3: leaves a plain while (no comma) untouched', () => {
    const out = tx(`void f() { while (a && b) { step(); } }`);
    assert.ok(/while \(a && b\)/.test(out), out);
  });
});
