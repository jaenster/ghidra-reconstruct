/**
 * Structured exception handlers through the parser and emitter: the MSVC keywords and
 * the d2_platform.h macro spelling seh-lowering writes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../index.js';
import { emit } from '../../emit/index.js';
import type { AnyNode, SehTryStmt } from '../../ast/nodes.js';
import { NodeKind } from '../../ast/kinds.js';
import { findNodesByKind } from '../../ast/visitor.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('__try statements', () => {
  it('parses and re-emits __try/__except and __try/__finally', () => {
    const src = `void f(int* p) { __try { *p = 1; } __except (1) { p = 0; } __try { *p = 2; } __finally { p = 0; } }`;
    const out = flat(emit(parse(src) as AnyNode));
    assert.ok(out.includes('__try { *p = 1; } __except (1) { p = 0; }'), out);
    assert.ok(out.includes('__try { *p = 2; } __finally { p = 0; }'), out);
  });

  it('parses the D2_SEH macro spelling, a declaration first in the block included, and re-emits it unchanged', () => {
    const src = [
      'void f(int* p) {',
      '  D2_SEH_TRY',
      '    HANDLE h;',
      '    *p = 1;',
      '  D2_SEH_EXCEPT(EXCEPTION_EXECUTE_HANDLER)',
      '  D2_SEH_END',
      '  D2_SEH_TRY',
      '    *p = 2;',
      '  D2_SEH_FINALLY',
      '    p = 0;',
      '  D2_SEH_END',
      '  return;',
      '}',
      '',
    ].join('\n');
    const tu = parse(src);
    const seh = findNodesByKind(tu, NodeKind.SehTryStmt) as SehTryStmt[];
    assert.deepStrictEqual(seh.map(s => [s.handlerKind, s.macro, s.body.statements.length, s.handler.statements.length]),
      [['except', true, 2, 0], ['finally', true, 1, 1]]);
    assert.strictEqual(flat(emit(tu as AnyNode)), flat(src));
  });
});
