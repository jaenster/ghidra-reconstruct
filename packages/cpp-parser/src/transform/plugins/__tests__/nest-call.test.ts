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
  },
  globalTypes: { WindowSizeX: 'int', TextHeight: 'int', gCounter: 'int' },
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

  it('leaves a site inside a loop when the temporary is mentioned again', () => {
    const { sites } = run([
      'void f(Unit *pUnit) {',
      '  Game *pGame;',
      '  while (pUnit) {',
      '[GetGamePointer@0x56<,1,0] pGame = GetGamePointer(pUnit);',
      '[HasQuestItem@0x5f<0x56,0,0.0.1] HasQuestItem(pGame, pUnit, 5);',
      '    pGame = 0;',
      '  }',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
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
  it('nests a run: constants, a global read and the call, in the order VC8 evaluates them', () => {
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
    assert.deepStrictEqual(sites, [4]);
    assert.ok(out.includes('DRAW_text(wsz, WindowSizeX - DRAW_text0(wsz) - 0x10, TextHeight, 4, 0);'), out);
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

  it('nests beside an argument that only reads memory', () => {
    const { out, sites } = run(quest(0).map(l => l.replace('HasQuestItem(pGame, pUnit, 0x20736b62)', 'HasQuestItem(pGame, pUnit, pUnit->nId)')));
    assert.deepStrictEqual(sites, [1]);
    assert.ok(out.includes('r = HasQuestItem(GetGamePointer(pUnit), pUnit, pUnit->nId);'), out);
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
});
