/**
 * Declaration macros: the generator's guard lines, `D2_GLOBAL_GUARD(name, "Ns::name");`,
 * sit between namespace-scope definitions where C++ has no expression to parse them as.
 * Without a rule for them the lint's recovering parse dropped each one as an error and
 * every definition after a guard was at risk of going with it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse, DECLARATION_MACROS } from '../index.js';
import { emit } from '../../emit/index.js';
import { NodeKind } from '../../ast/kinds.js';
import { findNodesByKind } from '../../ast/visitor.js';
import type { AnyNode } from '../../ast/nodes.js';

const SRC = [
  'namespace D2Client {',
  'uint16_t gnMonsterHealthBarValue[256];',
  'D2_GLOBAL_GUARD(gnMonsterHealthBarValue, "D2Client::gnMonsterHealthBarValue");',
  'int gnBss;',
  'D2_GLOBAL_GUARD_BSS(gnBss, "D2Client::gnBss");',
  '}',
  'static int gnFileLocal;',
  'D2_STATIC_GUARD_BSS(gnFileLocal, "gnFileLocal");',
  'void Draw() {',
  '    static int gaTable[2];',
  '    D2_STATIC_GUARD(gaTable, "Draw::gaTable");',
  '    gaTable[0] = 1;',
  '}',
].join('\n');

describe('declaration macros', () => {
  it('parses a guard at namespace scope as a MacroDecl, keeping its neighbours', () => {
    const tu = parse(SRC) as AnyNode;
    const macros = findNodesByKind(tu, NodeKind.MacroDecl) as any[];
    assert.deepStrictEqual(macros.map(m => m.call.callee.name),
      ['D2_GLOBAL_GUARD', 'D2_GLOBAL_GUARD_BSS', 'D2_STATIC_GUARD_BSS']);
    const vars = (findNodesByKind(tu, NodeKind.VariableDecl) as any[]).map(v => v.name?.name);
    for (const n of ['gnMonsterHealthBarValue', 'gnBss', 'gnFileLocal', 'gaTable']) assert.ok(vars.includes(n), n);
  });

  it('prints back the same and is stable under a second parse', () => {
    const once = emit(parse(SRC) as AnyNode);
    assert.ok(once.includes('D2_GLOBAL_GUARD(gnMonsterHealthBarValue, "D2Client::gnMonsterHealthBarValue");'), once);
    assert.strictEqual(emit(parse(once) as AnyNode), once);
  });

  it('only for the known names: any other call at namespace scope is still an error', () => {
    assert.ok(DECLARATION_MACROS.has('D2_GLOBAL_GUARD'));
    assert.throws(() => parse('namespace N {\nint a;\nSOME_MACRO(a);\n}\n'));
  });
});
