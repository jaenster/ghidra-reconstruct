import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { nestCallPlugin, type CallOrderEvidence, type CallSiteFact, type NestCallOptions } from '../builtins/nest-call.js';

/**
 * A function one statement per line; a line may be tagged with the calls the original
 * prints there: `[Name@at<prev,pushes,slots ...] text`, slots dot-separated, `?` unknown,
 * `-` none, prev empty when no CALL comes straight before.
 */
function fixture(lines: string[]): { code: string; ev: CallOrderEvidence } {
  const text: string[] = [];
  const ev = new Map<number, CallSiteFact[]>();
  lines.forEach((l, i) => {
    const m = l.match(/^\s*\[([^\]]*)\]\s?(.*)$/);
    if (!m) { text.push(l); return; }
    const facts: CallSiteFact[] = [];
    for (const f of m[1].trim().split(/\s+/).filter(Boolean)) {
      const p = f.match(/^([\w:]+)@(0x[0-9a-f]+)<(0x[0-9a-f]+)?,(\d+),(.+)$/);
      if (!p) throw new Error(`bad fact ${f}`);
      facts.push({
        name: p[1], at: Number(p[2]), prev: p[3] ? Number(p[3]) : null, pushes: Number(p[4]),
        slots: p[5] === '?' ? null : p[5] === '-' ? [] : p[5].split('.').map(Number),
      });
    }
    ev.set(i + 1, facts);
    text.push(m[2]);
  });
  return { code: text.join('\n'), ev: { lines: ev } };
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const TYPES: Partial<NestCallOptions> = {
  functionReturnTypes: {
    GetGamePointer: 'Game *', GetPlayerData: 'PlayerData *', DRAW_text0: 'int', Rand: 'int', Narrow: 'short',
    GetHitClass: 'int', GetCastSound: 'int', GetRoom: 'Room *', BetterRoom: 'Room *',
  },
  globalTypes: { WindowSizeX: 'int', TextHeight: 'int', gCounter: 'int', gnPanelOffsetX: 'int' },
};

function run(lines: string[], opts: Partial<NestCallOptions> = {}): { out: string; sites: number[] } {
  const { code, ev } = fixture(lines);
  const sites: number[] = [];
  const t = nestCallPlugin.createTransformer({ callOrder: ev, onSite: e => sites.push(e.temps), ...TYPES, ...opts });
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

// Q04_ActiveFilter, 00592fb0: `push code; mov ecx, edi; call GetGamePointer; ...; call HasQuestItem`.
const quest = (pushes: number, after: string[] = []) => [
  'int f(Unit *pUnit) {',
  '  Game *pGame;',
  '  int r;',
  '[GetGamePointer@0x56<,1,0] pGame = GetGamePointer(pUnit);',
  `[HasQuestItem@0x5f<0x56,${pushes},0.0.1] r = HasQuestItem(pGame, pUnit, 0x20736b62);`,
  ...after,
  '  return r;',
  '}',
];

describe('nestCallPlugin', () => {
  it('nests a temporary the original evaluated after the arguments right of it', () => {
    const { out, sites } = run(quest(0));
    assert.deepStrictEqual(sites, [1]);
    assert.ok(out.includes('r = HasQuestItem(GetGamePointer(pUnit), pUnit, 0x20736b62);'), out);
    assert.ok(!out.includes('pGame'), out);
  });

  it('leaves the temporary where the original called it before every push', () => {
    const { out, sites } = run(quest(1));
    assert.deepStrictEqual(sites, []);
    assert.ok(out.includes('pGame = GetGamePointer(pUnit); r = HasQuestItem(pGame, pUnit, 0x20736b62);'), out);
  });

  // Skills_SrvDoFunc_034_ChargeUpStackMelee, 005d3490: the decompiler breaks the line after
  // `sDamage.wResultFlags =`, so the outer call's fact sits on the line below the statement's.
  it('finds the outer call on a continuation line of its statement', () => {
    const { out, sites } = run([
      'int f(Unit *pUnit, Dmg *pDamage) {',
      '  int nToHit;',
      '  int nHitFlags;',
      '  nHitFlags = 0;',
      '[Rand@0xa8<0x95,3,1.1] nToHit = Rand(pUnit, 3);',
      '  pDamage->wResultFlags =',
      '[HitCheck@0xb6<0xa8,1,0.0.1.1] HitCheck(pUnit, pDamage, nToHit, nHitFlags);',
      '  return 0;',
      '}',
    ]);
    assert.deepStrictEqual(sites, [2]);
    assert.ok(out.includes('pDamage->wResultFlags = HitCheck(pUnit, pDamage, Rand(pUnit, 3), 0);'), out);
  });


  // Skills_CltDoFunc_Bar_DoubleSwing_Sound 004c7d50: `push 0; push 0; push 4; call GetHitClass;
  // push eax..; call UNITSND_GetSkillCastSound; call SOUND_PlaySound` with every other
  // argument in a register: the chain nests whole.
  const chain = (pushes: number) => [
    'int f(Unit *pUnit) {',
    '  int nHitClass;',
    '  int nSound;',
    '  int nMode;',
    '  nMode = 4;',
    `[GetHitClass@0x19<,${pushes},0] nHitClass = GetHitClass(pUnit);`,
    '[GetCastSound@0x22<0x19,0,0.0] nSound = GetCastSound(pUnit, nHitClass);',
    '[PlaySound@0x2b<0x22,0,0.0.1.1.1] PlaySound(nSound, pUnit, nMode, 0, 0);',
    '  return 0;',
    '}',
  ];

  it('nests a chain of temporaries, each read by the call after it', () => {
    const { out, sites } = run(chain(3));
    assert.deepStrictEqual(sites, [3]);
    assert.ok(out.includes('PlaySound(GetCastSound(pUnit, GetHitClass(pUnit)), pUnit, 4, 0, 0);'), out);
  });

  it('leaves a chain whose innermost call the original made before the pushes', () => {
    const { out, sites } = run(chain(0));
    assert.deepStrictEqual(sites, []);
    assert.ok(out.includes('nHitClass = GetHitClass(pUnit);'), out);
  });

  // Skills_SrvDoFunc_091_SpawnMinionAtCoords 005cbe00: the temporary is the statement's target too.
  it('nests a temporary the statement then assigns', () => {
    const { out, sites } = run([
      'int f(Unit *pUnit, int nX, int nY) {',
      '[GetRoom@0x30<,3,1] Room* pRoom = GetRoom(pUnit);',
      '[BetterRoom@0x3a<0x30,1,1.1.1] pRoom = BetterRoom(pRoom, nX, nY);',
      '  return pRoom != 0;',
      '}',
    ]);
    assert.deepStrictEqual(sites, [1]);
    assert.ok(out.includes('pRoom = BetterRoom(GetRoom(pUnit), nX, nY);'), out);
  });

  // UI_DrawPartyMemberClass 0049a3d0: `x = gnPanelOffsetX + 0x24` is evaluated among the pushes.
  it('nests an arithmetic temporary over a global', () => {
    const { out, sites } = run([
      'void f(int nScreenY, int nColor, int nId) {',
      '  int nY = nScreenY - gnPanelOffsetY;',
      '  int nX = gnPanelOffsetX + 0x24;',
      '[GetPlayerData@0x10<,4,1] PlayerData* p = GetPlayerData(nId);',
      '[DRAW@0x1a<0x10,1,1.1.1.1] DRAW(p, nX, nY, nColor);',
      '}',
    ], { globalTypes: { gnPanelOffsetX: 'int', gnPanelOffsetY: 'int' }, writeEffects: { GetPlayerData: {} } });
    assert.deepStrictEqual(sites, [3]);
    assert.ok(out.includes('DRAW(GetPlayerData(nId), gnPanelOffsetX + 0x24, nScreenY - gnPanelOffsetY, nColor);'), out);
  });

  it('leaves an arithmetic temporary over a global the call may write', () => {
    const { sites } = run([
      'void f(int nScreenY, int nColor, int nId) {',
      '  int nX = gnPanelOffsetX + 0x24;',
      '[GetPlayerData@0x10<,3,1] PlayerData* p = GetPlayerData(nId);',
      '[DRAW@0x1a<0x10,1,1.1.1] DRAW(p, nX, nColor);',
      '}',
    ], { globalTypes: { gnPanelOffsetX: 'int' }, writeEffects: { GetPlayerData: { globals: ['gnPanelOffsetX'] } } });
    assert.deepStrictEqual(sites, [1]);
  });

  it('changes nothing without facts', () => {
    const { code } = fixture(quest(0));
    const out = flat(emit(nestCallPlugin.createTransformer({ ...TYPES })(parse(code)) as AnyNode));
    assert.ok(out.includes('pGame = GetGamePointer(pUnit);'), out);
  });

  it('is idempotent', () => {
    const { code, ev } = fixture(quest(0));
    const t = nestCallPlugin.createTransformer({ callOrder: ev, ...TYPES });
    const once = t(parse(code));
    assert.strictEqual(flat(emit(t(once) as AnyNode)), flat(emit(once as AnyNode)));
  });

  it('leaves a temporary read again later', () => {
    const { sites } = run(quest(0, ['  Use(pGame);']));
    assert.deepStrictEqual(sites, []);
  });

  it('nests when the next mention reassigns it on every path', () => {
    const { out, sites } = run(quest(0, ['  if (r) { Other(); }', '  pGame = 0;', '  Use(pGame);']));
    assert.deepStrictEqual(sites, [1]);
    assert.ok(out.includes('Game* pGame;'), out);
  });

  it('leaves a temporary whose reassignment only one branch makes', () => {
    const { sites } = run(quest(0, ['  if (r) { pGame = 0; }', '  Use(pGame);']));
    assert.deepStrictEqual(sites, []);
  });

  const loop = (body: string[], after: string[] = []) => [
    'void f(Unit *pUnit) {',
    '  Game *pGame;',
    '  while (pUnit) {',
    ...body,
    '  }',
    ...after,
    '}',
  ];
  const site = [
    '[GetGamePointer@0x56<,1,0] pGame = GetGamePointer(pUnit);',
    '[HasQuestItem@0x5f<0x56,0,0.0.1] HasQuestItem(pGame, pUnit, 5);',
  ];

  it('nests inside a loop when every path writes the temporary again before reading it', () => {
    const { out, sites } = run(loop([...site, '    pGame = 0;', '    Use(pGame);']));
    assert.deepStrictEqual(sites, [1]);
    assert.ok(out.includes('HasQuestItem(GetGamePointer(pUnit), pUnit, 5);'), out);
  });

  it('leaves a site inside a loop whose next round reads the temporary first', () => {
    const { sites } = run(loop(['    if (pGame) { Use(pGame); }', ...site]));
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a site inside a loop when the temporary is read after the loop', () => {
    const { sites } = run(loop(site, ['  Use(pGame);']));
    assert.deepStrictEqual(sites, []);
  });

  it('nests in a function with labels when no path reads the value', () => {
    const { sites } = run([
      'void f(Unit *pUnit) {',
      '  Game *pGame;',
      'again:',
      '  Other();',
      ...site,
      '  pGame = 0;',
      '  if (pUnit) goto again;',
      '  Use(pGame);',
      '}',
    ]);
    assert.deepStrictEqual(sites, [1]);
  });

  it('leaves it when a goto leads to a read of the value', () => {
    const { sites } = run([
      'void f(Unit *pUnit) {',
      '  Game *pGame;',
      '  pGame = 0;',
      'again:',
      '  Use(pGame);',
      ...site,
      '  if (pUnit) goto again;',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves it when a case falls through to a read of the value', () => {
    const { sites } = run([
      'void f(Unit *pUnit, int n) {',
      '  Game *pGame;',
      '  switch (n) {',
      '  case 1:',
      '    Other();',
      ...site,
      '  case 2:',
      '    Use(pGame);',
      '    break;',
      '  }',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('nests in a case that breaks before any read', () => {
    const { sites } = run([
      'void f(Unit *pUnit, int n) {',
      '  Game *pGame;',
      '  switch (n) {',
      '  case 1:',
      '    Other();',
      ...site,
      '    break;',
      '  case 2:',
      '    pGame = 0;',
      '    Use(pGame);',
      '    break;',
      '  }',
      '}',
    ]);
    assert.deepStrictEqual(sites, [1]);
  });

  it('nests a temporary declared with the call as its value', () => {
    const { out, sites } = run([
      'int f(Unit *pUnit) {',
      '[GetGamePointer@0x56<,1,0] Game *pGame = GetGamePointer(pUnit);',
      '[HasQuestItem@0x5f<0x56,0,0.0.1] return HasQuestItem(pGame, pUnit, 0x20736b62);',
      '}',
    ]);
    assert.deepStrictEqual(sites, [1]);
    assert.ok(out.includes('return HasQuestItem(GetGamePointer(pUnit), pUnit, 0x20736b62);'), out);
    assert.ok(!out.includes('pGame'), out);
  });

  it('keeps a bare declaration for a declared temporary written again later', () => {
    const { out, sites } = run([
      'int f(Unit *pUnit) {',
      '[GetGamePointer@0x56<,1,0] Game *pGame = GetGamePointer(pUnit);',
      '[HasQuestItem@0x5f<0x56,0,0.0.1] HasQuestItem(pGame, pUnit, 0x20736b62);',
      '  pGame = 0;',
      '  return Use(pGame);',
      '}',
    ]);
    assert.deepStrictEqual(sites, [1]);
    assert.ok(out.includes('Game* pGame; HasQuestItem(GetGamePointer(pUnit), pUnit, 0x20736b62);'), out);
  });

  it('reads a field of the same name as no mention of the temporary', () => {
    const { out, sites } = run(quest(0, ['  Use(pQuest->pGame);']));
    assert.deepStrictEqual(sites, [1]);
    assert.ok(!out.includes('Game* pGame'), out);
    assert.ok(out.includes('Use(pQuest->pGame);'), out);
  });

  it('leaves a const or static temporary in its declaration', () => {
    for (const decl of ['Game *const pGame', 'static Game *pGame']) {
      const { sites } = run([
        'int f(Unit *pUnit) {',
        `[GetGamePointer@0x56<,1,0] ${decl} = GetGamePointer(pUnit);`,
        '[HasQuestItem@0x5f<0x56,0,0.0.1] return HasQuestItem(pGame, pUnit, 0x20736b62);',
        '}',
      ]);
      assert.deepStrictEqual(sites, [], decl);
    }
  });

  it('leaves it when an argument right of it calls something', () => {
    const { sites } = run([
      'int f(Unit *pUnit) {',
      '  Game *pGame;',
      '[GetGamePointer@0x56<,1,0] pGame = GetGamePointer(pUnit);',
      '[HasQuestItem@0x5f<0x56,0,0.0.1 Rand@0x40<,0,-] return HasQuestItem(pGame, pUnit, Rand());',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves it when the callee returns another type than the temporary holds', () => {
    const { sites } = run([
      'int f(Unit *pUnit) {',
      '  int n;',
      '[Narrow@0x56<,1,0] n = Narrow(pUnit);',
      '[Take@0x5f<0x56,0,0.0.1] return Take(n, pUnit, 5);',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  // UNITSND_GetSkillCastSound returns `int`, the temporary and SOUND_PlaySound's parameter
  // are `eD2Sounds` (`uint32_t`): int -> uint32_t -> uint32_t stores the bits int -> uint32_t does.
  describe('a temporary that differs from its call in sign only', () => {
    const sound = (param: string, use = 'nSoundId') => [
      'int f(Unit *pUnit) {',
      '  eD2Sounds nSoundId;',
      '[GetSound@0x56<,1,0] nSoundId = GetSound(pUnit);',
      `[Play@0x5f<0x56,0,0.0.1] return Play(${use}, pUnit, 5);`,
      '}',
    ];
    const opts = (param: string): Partial<NestCallOptions> => ({
      functionReturnTypes: { ...TYPES.functionReturnTypes, GetSound: 'int', Play: 'int' },
      functionParamTypes: { Play: [param, 'Unit *', 'int'] },
      typedefTargets: { eD2Sounds: 'uint32_t', uint32_t: 'unsigned int', int64_t: 'long long' },
    });

    it('nests it into a 32-bit integer parameter', () => {
      const { out, sites } = run(sound('eD2Sounds'), opts('eD2Sounds'));
      assert.deepStrictEqual(sites, [1]);
      assert.ok(out.includes('return Play(GetSound(pUnit), pUnit, 5);'), out);
    });

    it('leaves it for a 64-bit parameter, where the sign decides the extension', () => {
      const { sites } = run(sound('int64_t'), opts('int64_t'));
      assert.deepStrictEqual(sites, []);
    });

    it('leaves it for a floating parameter', () => {
      const { sites } = run(sound('double'), opts('double'));
      assert.deepStrictEqual(sites, []);
    });

    it('leaves it when the argument computes with the temporary', () => {
      const { sites } = run(sound('eD2Sounds', 'nSoundId / 2'), opts('eD2Sounds'));
      assert.deepStrictEqual(sites, []);
    });

    it('leaves it without the callee\'s parameter types', () => {
      const o = opts('eD2Sounds');
      delete o.functionParamTypes;
      const { sites } = run(sound('eD2Sounds'), o);
      assert.deepStrictEqual(sites, []);
    });
  });

  it('keeps an explicit cast with the call', () => {
    const { out, sites } = run([
      'int f(Unit *pUnit) {',
      '  int n;',
      '[Narrow@0x56<,1,0] n = (int)Narrow(pUnit);',
      '[Take@0x5f<0x56,0,0.0.1] return Take(n, pUnit, 5);',
      '}',
    ]);
    assert.deepStrictEqual(sites, [1]);
    assert.ok(out.includes('return Take((int)Narrow(pUnit), pUnit, 5);'), out);
  });

  it('leaves it when no argument right of it is pushed: the forms compile alike', () => {
    const { sites } = run([
      'int f(Unit *pUnit) {',
      '  Game *pGame;',
      '[GetGamePointer@0x56<,0,0] pGame = GetGamePointer(pUnit);',
      '[Take@0x5f<0x56,0,0.0] return Take(pUnit, pGame);',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves it when the call is not the one straight before', () => {
    const { sites } = run([
      'int f(Unit *pUnit) {',
      '  Game *pGame;',
      '[GetGamePointer@0x56<,1,0] pGame = GetGamePointer(pUnit);',
      '[HasQuestItem@0x5f<0x50,0,0.0.1] return HasQuestItem(pGame, pUnit, 5);',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  // AUTOMAP_DrawGamePassword, 00459e90: push 0; push 4; push [offset]; call DRAW_text0; ... call DRAW_text.
  // VC8 reads TextHeight and WindowSizeX after calling DRAW_text0, GCC may read them first.
  it('leaves a run when a global read stands beside the call', () => {
    const { out, sites } = run([
      'void f(wchar_t *wsz) {',
      '  int bCenter;',
      '  int dwColor;',
      '  int nY;',
      '  int nWidth;',
      '  bCenter = 0;',
      '  dwColor = 4;',
      '  nY = TextHeight;',
      '[DRAW_text0@0xb6<0xa0,3,0] nWidth = DRAW_text0(wsz);',
      '[DRAW_text@0xcb<0xb6,0,0.0.1.1.1] DRAW_text(wsz, WindowSizeX - nWidth - 0x10, nY, dwColor, bCenter);',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
    assert.ok(out.includes('nWidth = DRAW_text0(wsz);'), out);
  });

  it('nests a run of constants and the call beside parameters', () => {
    const { out, sites } = run([
      'void f(wchar_t *wsz, int nX) {',
      '  int bCenter;',
      '  int dwColor;',
      '  int nWidth;',
      '  bCenter = 0;',
      '  dwColor = 4;',
      '[DRAW_text0@0xb6<0xa0,3,0] nWidth = DRAW_text0(wsz);',
      '[DRAW_text@0xcb<0xb6,0,0.0.1.1.1] DRAW_text(wsz, nX - nWidth - 0x10, nX, dwColor, bCenter);',
      '}',
    ]);
    assert.deepStrictEqual(sites, [3]);
    assert.ok(out.includes('DRAW_text(wsz, nX - DRAW_text0(wsz) - 0x10, nX, 4, 0);'), out);
  });

  it('leaves a call beside a field read through a pointer', () => {
    const { sites } = run(quest(0).map(l => l.replace('HasQuestItem(pGame, pUnit, 0x20736b62)', 'HasQuestItem(pGame, pUnit, pUnit->nId)')));
    assert.deepStrictEqual(sites, []);
  });

  describe('with the callees\' write effects', () => {
    const field = (effects: NestCallOptions['writeEffects'], arg = 'pUnit->nId') =>
      run(quest(0).map(l => l.replace('HasQuestItem(pGame, pUnit, 0x20736b62)', `HasQuestItem(pGame, pUnit, ${arg})`)),
        { writeEffects: effects, globalTypes: { ...TYPES.globalTypes, gCount_1_: 'int' } });

    it('nests beside a field read when the call writes nothing', () => {
      const { out, sites } = field({ GetGamePointer: {} });
      assert.deepStrictEqual(sites, [1]);
      assert.ok(out.includes('r = HasQuestItem(GetGamePointer(pUnit), pUnit, pUnit->nId);'), out);
    });

    it('leaves a field read beside a call that writes memory or a global', () => {
      assert.deepStrictEqual(field({ GetGamePointer: { memory: true } }).sites, []);
      assert.deepStrictEqual(field({ GetGamePointer: { params: [0] } }).sites, []);
      assert.deepStrictEqual(field({ GetGamePointer: { globals: ['gOther'] } }).sites, []);
    });

    it('nests beside a global the call does not write, and leaves the one it writes', () => {
      assert.deepStrictEqual(field({ GetGamePointer: { globals: ['WindowSizeX'] } }, 'gCounter').sites, [1]);
      assert.deepStrictEqual(field({ GetGamePointer: { globals: ['gCounter'] } }, 'gCounter').sites, []);
      assert.deepStrictEqual(field({ GetGamePointer: { memory: true } }, 'gCounter').sites, []);
      // A table the emitter split keeps its name as a prefix of each piece.
      assert.deepStrictEqual(field({ GetGamePointer: { globals: ['gCount'] } }, 'gCount_1_').sites, []);
    });

    it('leaves it when the callee has no summary, or an unknown one', () => {
      assert.deepStrictEqual(field({}).sites, []);
      assert.deepStrictEqual(field({ GetGamePointer: { unknown: true } }).sites, []);
    });

    describe('typed regions', () => {
      const aggregates = {
        layouts: {
          Unit: [
            { name: 'nId', offset: 0, size: 4, type: 'int' },
            { name: 'pStats', offset: 4, size: 4, type: 'Stats *' },
            { name: 'tSeed', offset: 8, size: 8, type: 'Seed' },
            { name: 'pMix', offset: 16, size: 4, type: 'Mix *' },
            { name: 'wszName', offset: 20, size: 16, type: 'ushort[8]' },
          ],
          Seed: [{ name: 'nLow', offset: 0, size: 4, type: 'uint' }, { name: 'nHigh', offset: 4, size: 4, type: 'uint' }],
          Stats: [{ name: 'nLevel', offset: 0, size: 2, type: 'short' }, { name: 'nFlee', offset: 2, size: 2, type: 'short' }],
          Mix: [{ name: 'a', offset: 0, size: 4, type: 'int' }, { name: 'b', offset: 0, size: 4, type: 'Seed *' }],
        },
        sizes: { Unit: 36, Seed: 8, Stats: 4, Mix: 4 },
        unions: ['Mix'],
      };
      /** The quest fixture with `arg` as the last argument and `pre` lines above the inner call. */
      const typed = (effects: NestCallOptions['writeEffects'], arg: string, pre: string[] = [], opts: Partial<NestCallOptions> = {}) => {
        const lines = quest(0).map(l => l.replace('HasQuestItem(pGame, pUnit, 0x20736b62)', `HasQuestItem(pGame, pUnit, ${arg})`));
        const at = lines.findIndex(l => l.includes('GetGamePointer@'));
        lines.splice(at, 0, ...pre);
        return run(lines, { writeEffects: effects, aggregates, ...opts });
      };
      const seed = { GetGamePointer: { memory: true as const, regions: ['Seed'] } };

      // UNITSND_PlayFleeSound: the roll stores only its seed; the line is a sounds record.
      it('nests beside a read of a region the call cannot write', () => {
        const { out, sites } = typed(seed, 'pUnit->pStats->nFlee');
        assert.deepStrictEqual(sites, [1]);
        assert.ok(out.includes('r = HasQuestItem(GetGamePointer(pUnit), pUnit, pUnit->pStats->nFlee);'), out);
        assert.deepStrictEqual(typed(seed, 'pUnit->nId').sites, [1]);
      });

      it('leaves a read of the region, or of an aggregate holding it at that field', () => {
        assert.deepStrictEqual(typed(seed, 'pUnit->tSeed.nLow').sites, []);
        assert.deepStrictEqual(typed({ GetGamePointer: { memory: true, regions: ['Unit.nId'] } }, 'pUnit->nId').sites, []);
        assert.deepStrictEqual(typed({ GetGamePointer: { memory: true, regions: ['Unit'] } }, 'pUnit->nId').sites, []);
      });

      it('tells fields of one aggregate apart by offset, and a union\'s members not at all', () => {
        assert.deepStrictEqual(typed({ GetGamePointer: { memory: true, regions: ['Unit.pStats'] } }, 'pUnit->nId').sites, [1]);
        assert.deepStrictEqual(typed({ GetGamePointer: { memory: true, regions: ['Mix.a'] } }, 'pUnit->pMix->b').sites, []);
      });

      // CheckClientTimeouts: GetControlUnit writes pClient->pPlayer, GetCharName reads szCharName.
      it('reads a parameter write\'s regions', () => {
        assert.deepStrictEqual(typed({ GetGamePointer: { params: [0], paramRegions: { 0: ['Unit.pStats'] } } }, 'pUnit->nId').sites, [1]);
        assert.deepStrictEqual(typed({ GetGamePointer: { params: [0], paramRegions: { 0: ['Unit.nId'] } } }, 'pUnit->nId').sites, []);
        assert.deepStrictEqual(typed({ GetGamePointer: { params: [0] } }, 'pUnit->nId').sites, []);
      });

      // TXT_AllocTxt_levels 0061c540: `WSTRING_PutWideCharIntoBuffer(&pTxt[i].wszLevelWarp[0],
      // STRTABLE_GetStringByKey(..), n)`; the original pushes n before the inner call.
      it('takes an array member as its address, which no call can change', () => {
        const any = { GetGamePointer: { memory: true as const } };
        const { out, sites } = typed(any, '(int)pUnit->wszName');
        assert.deepStrictEqual(sites, [1]);
        assert.ok(out.includes('r = HasQuestItem(GetGamePointer(pUnit), pUnit, (int)pUnit->wszName);'), out);
        // An element of it is a read of memory the call may write.
        assert.deepStrictEqual(typed(any, 'pUnit->wszName[0]').sites, []);
        assert.deepStrictEqual(typed(any, 'pUnit->wszName', [], { aggregates: undefined }).sites, []);
      });

      it('leaves an untyped write, an untyped read, or no aggregates', () => {
        assert.deepStrictEqual(typed({ GetGamePointer: { memory: true } }, 'pUnit->nId').sites, []);
        assert.deepStrictEqual(typed(seed, '*(int *)pUnit').sites, []);
        assert.deepStrictEqual(typed(seed, 'pUnit->nId', [], { aggregates: undefined }).sites, []);
        // A memory write may still be any global.
        assert.deepStrictEqual(typed(seed, 'gCounter').sites, []);
      });

      it('distrusts a pointer a cast converted into its variable', () => {
        const pre = ['  Stats *pS;', '  pS = (Stats *)pUnit->nId;'];
        assert.deepStrictEqual(typed(seed, 'pS->nFlee', pre).sites, []);
        assert.deepStrictEqual(typed({ GetGamePointer: {} }, 'pS->nFlee', pre).sites, [1]);
        const plain = ['  Stats *pS;', '  pS = pUnit->pStats;'];
        assert.deepStrictEqual(typed(seed, 'pS->nFlee', plain).sites, [1]);
      });

      // SandMaggotAi_CastDelayedSkill: `nMonStatsPtr = (int)pAiParam->pMonStats;` then
      // `*(short *)(nMonStatsPtr + 0x170)`.
      it('reads an integer holding a typed pointer as that aggregate, within its size', () => {
        const pre = ['  int nStats;', '  nStats = (int)pUnit->pStats;'];
        assert.deepStrictEqual(typed(seed, '*(short *)(nStats + 2)', pre).sites, [1]);
        assert.deepStrictEqual(typed({ GetGamePointer: { memory: true, regions: ['Stats.nLevel'] } }, '*(short *)(nStats + 2)', pre).sites, []);
        // Past the end, assigned twice, read before the assignment, or assigned in a branch;
        // each nests beside a call that writes nothing.
        const refused: [string, string[]][] = [
          ['*(short *)(nStats + 4)', pre],
          ['*(short *)(nStats + 2)', [...pre, '  nStats = (int)pUnit->pMix;']],
          ['*(short *)(nStats + 2)', ['  int nStats;', '  gCounter = nStats;', '  nStats = (int)pUnit->pStats;']],
          ['*(short *)(nStats + 2)', ['  int nStats;', '  if (gCounter) {', '  nStats = (int)pUnit->pStats;', '  }']],
        ];
        for (const [arg, lines] of refused) {
          assert.deepStrictEqual(typed(seed, arg, lines).sites, [], arg + ' ' + lines.join(' '));
          assert.deepStrictEqual(typed({ GetGamePointer: {} }, arg, lines).sites, [1], arg + ' ' + lines.join(' '));
        }
      });
    });

    it('counts the calls inside the nested call\'s arguments', () => {
      const { sites } = run(quest(0).map(l => l
        .replace('pGame = GetGamePointer(pUnit);', 'pGame = GetGamePointer(Rand());')
        .replace('HasQuestItem(pGame, pUnit, 0x20736b62)', 'HasQuestItem(pGame, pUnit, pUnit->nId)')),
      { writeEffects: { GetGamePointer: {}, Rand: { globals: ['gSeed'] } } });
      assert.deepStrictEqual(sites, []);
    });
  });

  it('nests beside an enumerator and a local array', () => {
    const { out, sites } = run(quest(0).map(l => l.replace('HasQuestItem(pGame, pUnit, 0x20736b62)', 'HasQuestItem(pGame, pUnit, QUEST_A)')),
      { enumConstants: ['QUEST_A'] });
    assert.deepStrictEqual(sites, [1]);
    assert.ok(out.includes('r = HasQuestItem(GetGamePointer(pUnit), pUnit, QUEST_A);'), out);
  });

  it('leaves a call assigned through a global pointer', () => {
    const { sites } = run([
      'void f(Unit *pUnit) {',
      '  Game *pGame;',
      '[GetGamePointer@0x56<,1,0] pGame = GetGamePointer(pUnit);',
      '[HasQuestItem@0x5f<0x56,0,0.0.1] gpOut->n = HasQuestItem(pGame, pUnit, 5);',
      '}',
    ], { globalTypes: { ...TYPES.globalTypes, gpOut: 'Out *' } });
    assert.deepStrictEqual(sites, []);
  });

  it('leaves two calls in one argument list: GCC may call them in either order', () => {
    // H(G(), F(a), 7): push 7; push a; call F; push eax; call G; push eax; call H.
    const { out, sites } = run([
      'int f(int a) {',
      '  int x;',
      '  int y;',
      '[F@0x10<,2,1] x = F(a);',
      '[G@0x18<0x10,1,-] y = G();',
      '[H@0x20<0x18,1,1.1.1] return H(y, x, 7);',
      '}',
    ], { functionReturnTypes: { F: 'int', G: 'int' } });
    assert.deepStrictEqual(sites, []);
    assert.ok(out.includes('x = F(a); y = G(); return H(y, x, 7);'), out);
  });

  describe('two calls in one argument list', () => {
    // H(G(), F(a), 7): push 7; push a; call F; push eax; call G; push eax; call H.
    const two = [
      'int f(int a) {',
      '  int x;',
      '  int y;',
      '[F@0x10<,2,1] x = F(a);',
      '[G@0x18<0x10,1,-] y = G();',
      '[H@0x20<0x18,1,1.1.1] return H(y, x, 7);',
      '}',
    ];
    const types = { F: 'int', G: 'int' };

    // UnusedDebug(.., GetXPosFromDynamicPathUnit(pItem), GetYPosFromDynamicPathUnit(pItem), ..).
    it('nests two getters that write nothing, whatever they read', () => {
      const { out, sites } = run(two, { functionReturnTypes: types,
        writeEffects: { F: { reads: { memory: true, params: [0] } }, G: { reads: { unknown: true } } } });
      assert.deepStrictEqual(sites, [2]);
      assert.ok(out.includes('return H(G(), F(a), 7);'), out);
    });

    it('leaves two calls that write what the other reads', () => {
      const w = (writeEffects: NestCallOptions['writeEffects']) => run(two, { functionReturnTypes: types, writeEffects }).sites;
      assert.deepStrictEqual(w({ F: { params: [0], reads: { params: [0] } }, G: { reads: { memory: true } } }), []);
      assert.deepStrictEqual(w({ F: { globals: ['gSeed'], reads: {} }, G: { globals: ['gSeed'], reads: {} } }), []);
      assert.deepStrictEqual(w({ F: { globals: ['gSeed'], reads: {} }, G: { reads: { globals: ['gSeed'] } } }), []);
    });

    it('nests two calls whose writes and reads are apart', () => {
      const { sites } = run(two, { functionReturnTypes: types,
        writeEffects: { F: { globals: ['gA'], reads: { globals: ['gA'] } }, G: { globals: ['gB'], reads: { globals: ['gB'] } } } });
      assert.deepStrictEqual(sites, [2]);
    });
  });

  it('nests the later of two calls when the earlier is the rightmost argument', () => {
    // H(7, G(), F(a)): push a; call F; push eax; call G; push eax; push 7; call H.
    const { out, sites } = run([
      'int f(int a) {',
      '  int x;',
      '  int y;',
      '[F@0x10<,1,1] x = F(a);',
      '[G@0x18<0x10,1,-] y = G();',
      '[H@0x20<0x18,2,1.1.1] return H(7, y, x);',
      '}',
    ], { functionReturnTypes: { F: 'int', G: 'int' } });
    assert.deepStrictEqual(sites, [1]);
    assert.ok(out.includes('x = F(a); return H(7, G(), x);'), out);
  });

  // DRAW_UI_HelpXpac, 00495410: UNICODE_FormatWideString(100, wszBuf4,
  // GetLocaleString(0x1067), CMD_GetKeyNameForCommand(0x22, 1)), a varargs callee.
  describe('a varargs callee', () => {
    const help = (fmtPushes: number) => [
      'void f() {',
      '  wchar_t *pStr;',
      '  wchar_t *pFormat;',
      '  wchar_t wszBuf[100];',
      '[GetKey@0x10<,0,0.0] pStr = GetKey(0x22, 1);',
      `[GetLocale@0x18<0x10,${fmtPushes},0] pFormat = GetLocale(0x1067);`,
      '[Format@0x20<0x18,3,?] Format(100, wszBuf, pFormat, pStr);',
      '  Show(wszBuf);',
      '[GetKey@0x30<,0,0.0] pStr = GetKey(0x25, 1);',
      '  Show(pStr);',
      '}',
    ];
    const opts: Partial<NestCallOptions> = {
      functionReturnTypes: { GetKey: 'wchar_t *', GetLocale: 'wchar_t *' },
      functionParamTypes: { Format: ['int', 'wchar_t *', 'wchar_t *'] },
      varArgFunctions: ['Format'],
    };

    it('counts one slot per argument and nests the format string', () => {
      const { out, sites } = run(help(1), opts);
      assert.deepStrictEqual(sites, [1]);
      assert.ok(out.includes('pStr = GetKey(0x22, 1); Format(100, wszBuf, GetLocale(0x1067), pStr);'), out);
    });

    it('leaves it when the pushes do not add up', () => {
      const { sites } = run(help(2), opts);
      assert.deepStrictEqual(sites, []);
    });

    it('leaves it unless the callee is known to take varargs', () => {
      const { sites } = run(help(1), { ...opts, varArgFunctions: [] });
      assert.deepStrictEqual(sites, []);
    });
  });

  // OOGUTIL_OpenCreateGameDialog, 00445ff0: SetText(pLabel, GetLocaleString(x), 5, 0, 0).
  describe('a narrow constant temporary', () => {
    const label = (value: string, use = 'bIndent') => [
      'void f(TextBox *pLabel) {',
      '  wchar_t *pwsz;',
      '  bool bIndent;',
      `  bIndent = ${value};`,
      '[GetLocale@0x18<,2,0] pwsz = GetLocale(0x148b);',
      `[SetText@0x20<0x18,0,0.0.1.1] SetText(pLabel, pwsz, 5, ${use});`,
      '}',
    ];
    const opts: Partial<NestCallOptions> = { functionReturnTypes: { GetLocale: 'wchar_t *' } };

    it('nests a constant the temporary holds unchanged', () => {
      const { out, sites } = run(label('false'), opts);
      assert.deepStrictEqual(sites, [2]);
      assert.ok(out.includes('SetText(pLabel, GetLocale(0x148b), 5, false);'), out);
    });

    it('nests it through a cast', () => {
      const { out, sites } = run(label('0', '(int)bIndent'), opts);
      assert.deepStrictEqual(sites, [2]);
      assert.ok(out.includes('SetText(pLabel, GetLocale(0x148b), 5, (int)0);'), out);
    });

    it('leaves a constant the temporary would change', () => {
      const { out, sites } = run(label('5'), opts);
      assert.deepStrictEqual(sites, [1]);
      assert.ok(out.includes('bIndent = 5;'), out);
    });

    it('leaves a constant the argument computes with', () => {
      const { out, sites } = run(label('1', 'bIndent + 1'), opts);
      assert.deepStrictEqual(sites, [1]);
      assert.ok(out.includes('bIndent = 1;'), out);
    });
  });

  it('nests a temporary whose declaration has an initializer, and keeps the call there', () => {
    const { out, sites } = run([
      'int f(Unit *pUnit) {',
      '  int n = Rand();',
      '  Game *pGame;',
      '  n = 7;',
      '[GetGamePointer@0x56<,1,0] pGame = GetGamePointer(pUnit);',
      '[HasQuestItem@0x5f<0x56,0,0.0.1] return HasQuestItem(pGame, pUnit, n);',
      '}',
    ]);
    assert.deepStrictEqual(sites, [2]);
    assert.ok(out.includes('int n = Rand();'), out);
    assert.ok(out.includes('return HasQuestItem(GetGamePointer(pUnit), pUnit, 7);'), out);
  });

  it('nests when an if writes it on both arms before any read', () => {
    const { sites } = run(quest(0, ['  if (r) { pGame = 0; } else { return 0; }', '  Use(pGame);']));
    assert.deepStrictEqual(sites, [1]);
  });

  it('leaves it when an if reads it on one arm', () => {
    const { sites } = run(quest(0, ['  if (r) { Use(pGame); }', '  pGame = 0;']));
    assert.deepStrictEqual(sites, []);
  });

  it('drops a global read that stands out of evaluation order from the run', () => {
    const { out, sites } = run([
      'void f(wchar_t *wsz) {',
      '  int nY;',
      '  int nWidth;',
      '  nY = TextHeight;',
      '[DRAW_text0@0xb6<0xa0,2,1] nWidth = DRAW_text0(wsz);',
      '[DRAW_text@0xcb<0xb6,2,1.1.1] DRAW_text(nY, nWidth, 5);',
      '}',
    ]);
    assert.deepStrictEqual(sites, [1]);
    assert.ok(out.includes('nY = TextHeight; DRAW_text(nY, DRAW_text0(wsz), 5);'), out);
  });

  it('nests only the later call when the earlier was called before the pushes', () => {
    // push a; call F; push 7; push x; call G; push eax; call H.
    const { out, sites } = run([
      'int f(int a) {',
      '  int x;',
      '  int y;',
      '[F@0x10<,1,1] x = F(a);',
      '[G@0x18<0x10,2,-] y = G();',
      '[H@0x20<0x18,1,1.1.1] return H(y, x, 7);',
      '}',
    ], { functionReturnTypes: { F: 'int', G: 'int' } });
    assert.deepStrictEqual(sites, [1]);
    assert.ok(out.includes('x = F(a); return H(G(), x, 7);'), out);
  });

  it('leaves a temporary whose address is taken', () => {
    const { sites } = run([
      'int f(Unit *pUnit) {',
      '  Game *pGame;',
      '  Keep(&pGame);',
      '[GetGamePointer@0x56<,1,0] pGame = GetGamePointer(pUnit);',
      '[HasQuestItem@0x5f<0x56,0,0.0.1] return HasQuestItem(pGame, pUnit, 5);',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a line two statements claim', () => {
    const { sites } = run([
      'int f(Unit *pUnit) {',
      '  Game *pGame;',
      '[GetGamePointer@0x56<,1,0] pGame = GetGamePointer(pUnit); Other();',
      '[HasQuestItem@0x5f<0x56,0,0.0.1] return HasQuestItem(pGame, pUnit, 5);',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  // Before and after must agree under GCC, whose argument order is not VC8's.
  it('computes the same through loops, cases and gotos (compiled)', { skip: !hasNativeGpp() }, () => {
    const lines = [
      'int f(int n, int k) {',
      '  int nWidth = 0;',
      '  int r = 0;',
      '  int t;',
      '  int i = 0;',
      '  while (i < n) {',
      '    r = r + 1;',
      '[DRAW_text0@0xb6<,3,0] nWidth = DRAW_text0(i);',
      '[DRAW_text@0xcb<0xb6,0,0.0.1.1.1] t = DRAW_text(i, nWidth, k, 4, 0);',
      '    nWidth = (r + t) & 7;',
      '    r = r + t + nWidth;',
      '    i = i + 1;',
      '  }',
      '  switch (k & 3) {',
      '  case 1: {',
      '    r = r * 3;',
      '[DRAW_text0@0xd6<,3,0] int nCase = DRAW_text0(r);',
      '[DRAW_text@0xdb<0xd6,0,0.0.1.1.1] t = DRAW_text(k, nCase, r, 4, 0);',
      '    r = r + t;',
      '    break;',
      '  }',
      '  case 2:',
      '    r = r - 1;',
      '  }',
      '  if (r < 100) goto out;',
      '  r = r / 2;',
      'out:',
      '  return r + nWidth;',
      '}',
    ];
    const { code } = fixture(lines);
    const { out, sites } = run(lines);
    assert.deepStrictEqual(sites, [1, 1]);
    const prelude = [
      'int calls = 0;',
      'int DRAW_text0(int w) { calls++; return w * 3 + calls; }',
      'int DRAW_text(int w, int x, int y, int c, int m) { return ((w * 31 + x) * 31 + y) * 31 + c * 7 + m + calls * 1000; }',
      code.replace('int f(', 'int before('),
      out.replace('int f(', 'int after('),
    ].join('\n');
    const r = compileAndRun(prelude, 'for (int n = 0; n < 4; n++) for (int k = -2; k < 6; k++) { calls = 0; int a = before(n, k); calls = 0; printf("%d %d\\n", a, after(n, k)); }');
    for (const row of r.trim().split('\n')) {
      const [a, b] = row.split(' ');
      assert.strictEqual(a, b, r);
    }
  });

  it('computes what the temporaries computed (compiled)', { skip: !hasNativeGpp() }, () => {
    const lines = [
      'int f(int wsz, int nX) {',
      '  int bCenter;',
      '  int dwColor;',
      '  int nWidth;',
      '  int *pStr;',
      '  int *pFormat;',
      '  int r;',
      '  int r2;',
      '  int r3;',
      '  bool bIndent;',
      '  bCenter = 0;',
      '  dwColor = 4;',
      '[DRAW_text0@0xb6<0xa0,3,0] nWidth = DRAW_text0(wsz);',
      '[DRAW_text@0xcb<0xb6,0,0.0.1.1.1] r = DRAW_text(wsz, nX - nWidth - 0x10, nX, dwColor, bCenter);',
      '[GetKey@0xd0<,0,0.0] pStr = GetKey(wsz, 1);',
      '[GetLocale@0xd8<0xd0,1,0] pFormat = GetLocale(nX);',
      '[Format@0xe0<0xd8,3,?] r2 = Format(100, nX, pFormat, pStr);',
      '  bIndent = true;',
      '[GetLocale@0xf0<,2,0] pFormat = GetLocale(r2);',
      '[Take@0xf8<0xf0,0,0.0.1.1] r3 = Take(nX, pFormat, 5, bIndent);',
      '  if (r3 & 1) { pFormat = 0; } else { return r + r2 + r3; }',
      '  return r + r2 * 3 + r3 * 7 + (pFormat == 0);',
      '}',
    ];
    const opts: Partial<NestCallOptions> = {
      functionReturnTypes: { ...TYPES.functionReturnTypes, GetKey: 'int *', GetLocale: 'int *' },
      functionParamTypes: { Format: ['int', 'int', 'int *'] },
      varArgFunctions: ['Format'],
    };
    const { code } = fixture(lines);
    const { out, sites } = run(lines, opts);
    assert.deepStrictEqual(sites.sort(), [1, 2, 3]);
    const prelude = [
      '#include <cstdarg>',
      'int TextHeight = 9, WindowSizeX = 640, calls = 0, cells[64];',
      'int DRAW_text0(int w) { calls++; return w * 3; }',
      'int DRAW_text(int w, int x, int y, int c, int m) { return ((w * 31 + x) * 31 + y) * 31 + c * 7 + m + calls * 1000; }',
      'int *GetKey(int w, int k) { calls = calls * 3 + 1; return &cells[(w + k + 8) & 31]; }',
      'int *GetLocale(int n) { calls = calls * 5 + 2; return &cells[32 + ((n + 64) & 31)]; }',
      'int Format(int n, int x, int *f, ...) { va_list a; va_start(a, f); int *k = va_arg(a, int *); va_end(a);',
      '  return n + x * 7 + (int)(f - cells) * 131 + (int)(k - cells) * 17 + calls; }',
      'int Take(int x, int *p, int n, bool b) { return x * 3 + (int)(p - cells) * 11 + n + b * 1000 + calls; }',
      code.replace('int f(', 'int before('),
      out.replace('int f(', 'int after('),
    ].join('\n');
    const r = compileAndRun(prelude, 'for (int w = -3; w < 4; w++) for (int x = -2; x < 3; x++) { calls = 0; int a = before(w, x); calls = 0; printf("%d %d\\n", a, after(w, x)); }');
    for (const row of r.trim().split('\n')) {
      const [a, b] = row.split(' ');
      assert.strictEqual(a, b, r);
    }
  });
  // A callee that writes the global a sibling argument reads: nested, GCC may read it on
  // either side of the call. The pass leaves that site and nests the safe one beside it.
  it('keeps a global read on the side of the call it was read on (compiled)', { skip: !hasNativeGpp() }, () => {
    const lines = [
      'int f(int a) {',
      '  int x;',
      '  int y;',
      '  int r;',
      '  int r2;',
      '[Bump@0x10<,2,1] x = Bump(a);',
      '[Take@0x18<0x10,2,1.1.1] r = Take(gCounter, x, a);',
      '[Bump@0x20<,2,1] y = Bump(a);',
      '[Take@0x28<0x20,2,1.1.1] r2 = Take(7, y, a);',
      '  return r * 1000 + r2;',
      '}',
    ];
    const opts: Partial<NestCallOptions> = {
      functionReturnTypes: { ...TYPES.functionReturnTypes, Bump: 'int' },
      writeEffects: { Bump: { globals: ['gCounter'] }, Take: {} },
    };
    const { code } = fixture(lines);
    const { out, sites } = run(lines, opts);
    assert.ok(out.includes('x = Bump(a); r = Take(gCounter, x, a);'), out);
    assert.ok(out.includes('r2 = Take(7, Bump(a), a);'), out);
    assert.deepStrictEqual(sites, [1]);
    const prelude = [
      'int gCounter = 0;',
      'int Bump(int a) { gCounter += 100; return a * 3; }',
      'int Take(int g, int x, int a) { return g * 7 + a * 3 + x; }',
      code.replace('int f(', 'int before('),
      out.replace('int f(', 'int after('),
    ].join('\n');
    const r = compileAndRun(prelude, 'for (int a = -2; a < 3; a++) { gCounter = 0; int b = before(a); gCounter = 0; printf("%d %d\\n", b, after(a)); }');
    for (const row of r.trim().split('\n')) {
      const [a, b] = row.split(' ');
      assert.strictEqual(a, b, r);
    }
  });
  // Two rolls of one seed nested side by side would swap under some argument order; two
  // getters would not. The pass keeps the first as temporaries and nests the second.
  it('rolls stay temporaries, getters nest (compiled)', { skip: !hasNativeGpp() }, () => {
    const lines = [
      'int f(int a) {',
      '  int x;',
      '  int y;',
      '  int u;',
      '  int v;',
      '  int r;',
      '  int r2;',
      '[Roll@0x10<,2,1] x = Roll(a);',
      '[Roll@0x18<0x10,1,1] y = Roll(a);',
      '[Play@0x20<0x18,1,1.1.1] r = Play(y, x, a);',
      '[GetX@0x30<,2,1] u = GetX(a);',
      '[GetY@0x38<0x30,2,1] v = GetY(a);',
      '[Play@0x40<0x38,1,1.1.1] r2 = Play(v, u, a);',
      '  return r * 7919 + r2;',
      '}',
    ];
    const opts: Partial<NestCallOptions> = {
      functionReturnTypes: { ...TYPES.functionReturnTypes, Roll: 'int', GetX: 'int', GetY: 'int' },
      writeEffects: {
        Roll: { globals: ['gSeed'], reads: { globals: ['gSeed'] } },
        GetX: { reads: { globals: ['gPos'] } }, GetY: { reads: { globals: ['gPos'] } },
        Play: { reads: {} },
      },
    };
    const { code } = fixture(lines);
    const { out, sites } = run(lines, opts);
    assert.ok(out.includes('x = Roll(a); y = Roll(a); r = Play(y, x, a);'), out);
    assert.ok(out.includes('r2 = Play(GetY(a), GetX(a), a);'), out);
    assert.deepStrictEqual(sites, [2]);
    const prelude = [
      'unsigned gSeed = 1; int gPos[2] = { 3, 5 };',
      'int Roll(int a) { gSeed = gSeed * 1103515245u + 12345u; return (int)(gSeed >> 16) % (a + 9); }',
      'int GetX(int a) { return gPos[0] + a; }',
      'int GetY(int a) { return gPos[1] - a; }',
      'int Play(int p, int q, int a) { return p * 131 + q * 17 + a; }',
      code.replace('int f(', 'int before('),
      out.replace('int f(', 'int after('),
    ].join('\n');
    const r = compileAndRun(prelude, 'for (int a = 0; a < 5; a++) { gSeed = 1; int b = before(a); gSeed = 1; printf("%d %d\\n", b, after(a)); }');
    for (const row of r.trim().split('\n')) {
      const [a, b] = row.split(' ');
      assert.strictEqual(a, b, r);
    }
  });
});
