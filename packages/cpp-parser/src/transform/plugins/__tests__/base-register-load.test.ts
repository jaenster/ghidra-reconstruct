import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { baseRegisterLoadPlugin, type BaseRegisterLoadOptions } from '../builtins/base-register-load.js';
import type { AccessOrderEvidence, ArgLoadFact } from '../builtins/access-order-evidence.js';

/**
 * One statement per line; a line may carry the original's argument loads:
 * `[Name/params p@REG ...] text`.
 */
function fixture(lines: string[]): { code: string; ev: AccessOrderEvidence } {
  const text: string[] = [];
  const args = new Map<number, ArgLoadFact[]>();
  lines.forEach((l, i) => {
    const m = l.match(/^\s*\[([^\]]*)\]\s?(.*)$/);
    if (!m) { text.push(l); return; }
    const [head, ...loads] = m[1].trim().split(/\s+/);
    const [name, params] = head.split('/');
    args.set(i + 1, [{
      name, at: 0x10, params: Number(params),
      loads: loads.map(x => { const [p, reg] = x.split('@'); return { param: Number(p), reg }; }),
    }]);
    text.push(m[2]);
  });
  return { code: text.join('\n'), ev: { args, stores: new Map() } };
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const PRELUDE = [
  'struct Bits { int nWord; };',
  'struct PlayerData { int nPad[4]; Bits *pQuestRecord[3]; };',
  'struct Game { unsigned char nDifficulty; };',
  'struct Unit { int nType; int nClassId; Unit *pNext; };',
].join('\n');

const TABLES: Partial<BaseRegisterLoadOptions> = {
  functionReturnTypes: { GetPlayerData: 'PlayerData *', GetQuestState: 'int', SetParam: 'void', Peek: 'int' },
  structFields: {
    PlayerData: { nPad: 'int [4]', pQuestRecord: 'Bits *[3]' },
    Game: { nDifficulty: 'unsigned char' },
    Unit: { nType: 'int', nClassId: 'int', pNext: 'Unit *' },
  },
};

function run(lines: string[], opts: Partial<BaseRegisterLoadOptions> = {}): { out: string; sites: string[] } {
  const { code, ev } = fixture(lines);
  const sites: string[] = [];
  const t = baseRegisterLoadPlugin.createTransformer({
    accessOrder: ev, onSite: e => sites.push(e.name + (e.folded ? '+' : '')), ...TABLES, ...opts,
  } as BaseRegisterLoadOptions);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

// Q32_PropagateCompleteToParty, 005887a0: `call GetPlayerData; movzx ecx, [edi + 0x6d];
// mov eax, [eax + ecx*4 + 0x10]; push 0xd; push 0x24; push eax; call GetQuestState`.
const quest = (reg: string, extra: string[] = []) => [
  'int f(Game *pGame, Unit *pUnit) {',
  '  PlayerData *pPlayerData;',
  '  int bDone;',
  '  pPlayerData = GetPlayerData(pUnit);',
  `[GetQuestState/3 0@${reg}] bDone = GetQuestState(pPlayerData->pQuestRecord[pGame->nDifficulty], 0x24, 0xd);`,
  ...extra,
  '  return bDone;',
  '}',
];

describe('baseRegisterLoadPlugin', () => {
  it('gives the argument a local and folds the call temporary into it', () => {
    const { out, sites } = run(quest('EAX'));
    assert.deepStrictEqual(sites, ['pQuestRecord+']);
    assert.ok(out.includes('Bits* pQuestRecord = GetPlayerData(pUnit)->pQuestRecord[pGame->nDifficulty]; bDone = GetQuestState(pQuestRecord, 0x24, 0xd);'), out);
    assert.ok(!out.includes('pPlayerData'), out);
  });

  it('leaves the argument when its base is read again', () => {
    const { sites } = run(quest('EAX', ['  bDone = bDone + pPlayerData->nPad[0];']));
    assert.deepStrictEqual(sites, []);
  });

  it('leaves the argument when a loop reads its base again', () => {
    const { sites } = run([
      'void f(Unit *pSkill, Unit *pTarget) {',
      '  while (pTarget) {',
      '[SetParam/2 1@EDX] SetParam(pSkill, pTarget->nClassId);',
      '  }',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a callee-saved base alone', () => {
    const { sites } = run(quest('ESI'));
    assert.deepStrictEqual(sites, []);
  });

  it('changes nothing without facts', () => {
    const { code } = fixture(quest('EAX'));
    const out = flat(emit(baseRegisterLoadPlugin.createTransformer({ ...TABLES })(parse(code)) as AnyNode));
    assert.ok(out.includes('GetQuestState(pPlayerData->pQuestRecord[pGame->nDifficulty]'), out);
  });

  it('hoists a field argument of a statement call', () => {
    const { out, sites } = run([
      'void f(Unit *pSkill, Unit *pTarget) {',
      '[SetParam/2 1@EDX] SetParam(pSkill, pTarget->nClassId);',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['nClassId']);
    assert.ok(out.includes('int nClassId = pTarget->nClassId; SetParam(pSkill, nClassId);'), out);
  });

  it('picks a name nothing else uses', () => {
    const { out } = run([
      'void f(Unit *pSkill, Unit *pTarget, int nClassId) {',
      '[SetParam/2 1@EDX] SetParam(pSkill, pTarget->nClassId);',
      '}',
    ]);
    assert.ok(out.includes('int nClassId2 = pTarget->nClassId; SetParam(pSkill, nClassId2);'), out);
  });

  it('leaves a local base it cannot fold', () => {
    const { sites } = run([
      'void f(Unit *pSkill, Unit *pUnit) {',
      '  Unit *pTarget;',
      '  pTarget = pUnit->pNext;',
      '[SetParam/2 1@EAX] SetParam(pSkill, pTarget->nClassId);',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('hoists out of an if condition', () => {
    const { out, sites } = run([
      'int f(Unit *pUnit) {',
      '[Peek/1 0@ECX] if (!Peek(pUnit->nType)) {',
      '    return 1;',
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['nType']);
    assert.ok(out.includes('int nType = pUnit->nType; if (!Peek(nType))'), out);
  });

  it('leaves a call under a short circuit', () => {
    const { sites } = run([
      'int f(Unit *pUnit) {',
      '[Peek/1 0@ECX] if (pUnit && Peek(pUnit->nType)) {',
      '    return 1;',
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a statement that makes another call', () => {
    const { sites } = run([
      'int f(Unit *pUnit) {',
      '[Peek/2 0@ECX] return Peek(pUnit->nType, Peek(0, 1));',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves the call when the parameter count disagrees', () => {
    const { sites } = run([
      'void f(Unit *pSkill, Unit *pTarget) {',
      '[SetParam/3 1@EDX] SetParam(pSkill, pTarget->nClassId);',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a block a label follows', () => {
    const { sites } = run([
      'void f(Unit *pSkill, Unit *pTarget) {',
      '  if (pSkill) goto done;',
      '[SetParam/2 1@EDX] SetParam(pSkill, pTarget->nClassId);',
      'done:',
      '  return;',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('is idempotent', () => {
    const { code, ev } = fixture(quest('EAX'));
    const t = baseRegisterLoadPlugin.createTransformer({ accessOrder: ev, ...TABLES } as BaseRegisterLoadOptions);
    const once = t(parse(code));
    assert.strictEqual(flat(emit(t(once) as AnyNode)), flat(emit(once as AnyNode)));
  });

  it('computes what the argument computed (compiled)', { skip: !hasNativeGpp() }, () => {
    const lines = quest('EAX');
    const { code } = fixture(lines);
    const { out } = run(lines);
    const prelude = [
      PRELUDE,
      'Bits gBits[3] = {{5}, {7}, {11}};',
      'PlayerData gPd;',
      'int calls = 0;',
      'PlayerData *GetPlayerData(Unit *u) { calls++; gPd.pQuestRecord[0] = &gBits[u->nType % 3]; gPd.pQuestRecord[1] = &gBits[(u->nType + 1) % 3]; gPd.pQuestRecord[2] = &gBits[2]; return &gPd; }',
      'int GetQuestState(Bits *b, int q, int s) { return b->nWord * 100 + q + s + calls * 1000; }',
      code.replace('int f(', 'int before('),
      out.replace('int f(', 'int after('),
    ].join('\n');
    const r = compileAndRun(prelude,
      'for (int k = 0; k < 6; k++) { Game g; g.nDifficulty = (unsigned char)(k % 3); Unit u; u.nType = k; calls = 0; int a = before(&g, &u); calls = 0; printf("%d %d\\n", a, after(&g, &u)); }');
    for (const row of r.trim().split('\n')) {
      const [a, b] = row.split(' ');
      assert.strictEqual(a, b, r);
    }
  });
});
