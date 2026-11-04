import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { guardNullNestPlugin } from '../builtins/guard-null-nest.js';
import { traverseAST } from '../../../ast/visitor.js';
import { NodeKind } from '../../../ast/kinds.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = guardNullNestPlugin.createTransformer({ onSite: (e: { name: string }) => sites.push(e.name) } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

const PRELUDE = [
  'struct Ai { int nCmd; };',
  'struct Mon { Ai* pAi; };',
  'struct Unit { int eType; Mon* pMon; };',
  'struct Txt { short ex; int flags; };',
  'Txt gTbl[4] = {{1, 5}, {-1, 6}, {3, 7}, {0, 8}};',
  'Txt gTbl2[2] = {{0, 11}, {0, 12}};',
  'int gSize = 4; int gSize2 = 2;',
].join('\n');

// GetAiCmd, 0058ee80, as printed.
const aiCmd = [
  'int f(Unit* pUnit) {',
  '  if (!(pUnit && pUnit->eType == 1 && pUnit->pMon)) {',
  '    return 0;',
  '  }',
  '  Ai* pAi = pUnit->pMon->pAi;',
  '  if (!pAi) {',
  '    return 0;',
  '  }',
  '  return pAi->nCmd;',
  '}',
].join('\n');

// GetSomeMonsterStatFlag, 0046c140: a range test and a nested record getter.
const statFlag = [
  'int g(int nId) {',
  '  if (!(nId >= 0 && nId < gSize)) {',
  '    return 0;',
  '  }',
  '  int nEx = (int)gTbl[nId].ex;',
  '  Txt* pEx = nEx >= 0 && nEx < gSize2 ? gTbl2 + nEx : nullptr;',
  '  if (!pEx) {',
  '    return 0;',
  '  }',
  '  return pEx->flags;',
  '}',
].join('\n');

describe('guard-null-nest', () => {
  it('sets the tested pointer to null and nests the definition under the guard', () => {
    const { out, sites } = run(aiCmd);
    assert.deepStrictEqual(sites, ['pAi']);
    assert.ok(out.includes('Ai* pAi = nullptr; if (pUnit && pUnit->eType == 1 && pUnit->pMon) { pAi = pUnit->pMon->pAi; } if (!pAi) { return 0; } return pAi->nCmd;'), out);
  });

  // Nulled from the head on, p must not be read before its new value: here the
  // definition reads the old one, and the guard's path would see null instead.
  it('leaves a definition that reads the variable it sets', () => {
    const code = [
      'int h(Unit* pUnit, Ai* pAi) {',
      '  if (!(pUnit && pUnit->eType == 1)) {',
      '    return 0;',
      '  }',
      '  pAi = pAi->pNext;',
      '  if (!pAi) {',
      '    return 0;',
      '  }',
      '  return pAi->nCmd;',
      '}',
    ].join('\n');
    const { sites } = run(code);
    assert.deepStrictEqual(sites, []);
  });

  // The pipeline holds a pointer constant as the identifier `nullptr` (GetAiCmd as the
  // generator hands it over), not a literal node.
  it('takes `nullptr` held as an identifier for the constant', () => {
    const ast = parse(aiCmd.replace(/return 0;/g, 'return nullptr;'));
    for (const n of traverseAST(ast)) {
      if (n.kind === NodeKind.ReturnStmt && (n as unknown as { value?: { kind: string } }).value?.kind === NodeKind.NullptrLiteral) {
        (n as unknown as { value: unknown }).value = { kind: NodeKind.Identifier, name: 'nullptr', leadingTrivia: [], trailingTrivia: [] };
      }
    }
    const sites: string[] = [];
    const t = guardNullNestPlugin.createTransformer({ onSite: (e: { name: string }) => sites.push(e.name) } as never);
    t(ast);
    assert.deepStrictEqual(sites, ['pAi']);
  });

  it('moves the statements before the definition into the nest', () => {
    const { out, sites } = run(statFlag);
    assert.deepStrictEqual(sites, ['pEx']);
    assert.ok(out.includes('Txt* pEx = nullptr; if (nId >= 0 && nId < gSize) { int nEx = (int)gTbl[nId].ex; pEx = nEx >= 0 && nEx < gSize2 ? gTbl2 + nEx : nullptr; } if (!pEx)'), out);
  });

  it('leaves a chain headed by a null test of a variable (branch-layout propagate)', () => {
    const code = aiCmd.replace('!(pUnit && pUnit->eType == 1 && pUnit->pMon)', '!pUnit');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('leaves guards returning different values', () => {
    const code = aiCmd.replace('  if (!pAi) {\n    return 0;', '  if (!pAi) {\n    return -1;');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('leaves a declaration that is named after the nest', () => {
    const code = statFlag.replace('return pEx->flags;', 'return pEx->flags + nEx;');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('leaves statements between that can leave', () => {
    const code = aiCmd.replace('  Ai* pAi =', '  if (pUnit->eType == 9) return 7;\n  Ai* pAi =');
    assert.deepStrictEqual(run(code).sites, []);
  });

  it('leaves a simple first guard (its copy is already inline)', () => {
    assert.deepStrictEqual(run(aiCmd.replace('!(pUnit && pUnit->eType == 1 && pUnit->pMon)', 'pUnit->eType != 1')).sites, []);
  });

  it('leaves a definition that calls (a call result is tested on its own)', () => {
    assert.deepStrictEqual(run(aiCmd.replace('pUnit->pMon->pAi;', '(Ai*)(long)Next(1);').replace('struct', 'struct')).sites.length, 0);
  });

  it('leaves a rest with a switch or another copy of K (GetAiArgument)', () => {
    const sw = aiCmd.replace('  return pAi->nCmd;', '  switch (pAi->nCmd) { case 1: return 5; }\n  return 0;');
    assert.deepStrictEqual(run(sw).sites, []);
    const more = aiCmd.replace('  return pAi->nCmd;', '  if (pAi->nCmd > 3) return 0;\n  return pAi->nCmd;');
    assert.deepStrictEqual(run(more).sites, []);
  });

  it('computes what the printed form computes (compiled)', { skip: !hasNativeGpp() }, () => {
    const a = run(aiCmd).out, b = run(statFlag).out;
    const prelude = [
      PRELUDE,
      aiCmd.replace('int f(', 'int f0('), a.replace('int f(', 'int f1('),
      statFlag.replace('int g(', 'int g0('), b.replace('int g(', 'int g1('),
    ].join('\n');
    const r = compileAndRun(prelude, [
      'Ai ai = {42}; Mon m0 = {&ai}; Mon m1 = {nullptr};',
      'Unit us[5] = {{1, &m0}, {2, &m0}, {1, &m1}, {1, nullptr}, {0, nullptr}};',
      'printf("%d/%d\\n", f0(nullptr), f1(nullptr));',
      'for (int k = 0; k < 5; k++) printf("%d/%d\\n", f0(&us[k]), f1(&us[k]));',
      'for (int k = -2; k < 6; k++) printf("%d/%d\\n", g0(k), g1(k));',
    ].join('\n'));
    for (const row of r.trim().split('\n')) {
      const [x, y] = row.split('/');
      assert.strictEqual(x, y, r);
    }
  });
});
