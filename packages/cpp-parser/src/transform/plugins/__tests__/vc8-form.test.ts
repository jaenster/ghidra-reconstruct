import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(lines: string[], ...forms: string[]): { out: string; sites: Vc8FormSite[] } {
  const sites: Vc8FormSite[] = [];
  const parsed = forms.map(f => {
    const form = parseVc8Form(f);
    assert.ok(form, `parses: ${f}`);
    return { form: form!, tag: f };
  });
  const tu = applyVc8Forms(parse(lines.join('\n')) as TranslationUnit, parsed, s => sites.push(s));
  return { out: flat(emit(tu as AnyNode)), sites };
}

describe('vc8-form: parsing', () => {
  it('reads each op and its arguments', () => {
    assert.deepStrictEqual(parseVc8Form('seq(a.x,a.y)'), { op: 'seq', targets: ['a.x', 'a.y'] });
    assert.deepStrictEqual(parseVc8Form('cache(p->q[f(a, b)],n,T*,@x)'), { op: 'cache', expr: 'p->q[f(a, b)]', name: 'n', type: 'T*', anchor: 'x' });
    assert.deepStrictEqual(parseVc8Form('cache(g,p)'), { op: 'cache', expr: 'g', name: 'p' });
    assert.deepStrictEqual(parseVc8Form('guards(2)'), { op: 'guards', split: 2, index: 1 });
    assert.deepStrictEqual(parseVc8Form('own(v,DWORD,nBytes)'), { op: 'own', name: 'v', type: 'DWORD', rename: 'nBytes' });
  });
  it('rejects an unknown op or a wrong arity', () => {
    assert.strictEqual(parseVc8Form('swap(a,b)'), undefined);
    assert.strictEqual(parseVc8Form('fold(a,b)'), undefined);
    assert.strictEqual(parseVc8Form('seq(a)'), undefined);
    assert.strictEqual(parseVc8Form('guards(x)'), undefined);
  });
});

describe('vc8-form: seq', () => {
  // NET_D2GS_SERVER_Send_0x0C_UNITCHANGE 0053b430: the packet's stores in field order.
  const SITE = [
    'void f(Client* c, uint8_t id, uint8_t t, uint32_t g, uint8_t m, uint8_t h) {',
    '  Pkt a;',
    '  a.nPacketId = id;',
    '  a.dwUnitGUID = g;',
    '  a.nUnitType = t;',
    '  a.nHitClass = h;',
    '  a.nMessageType = m;',
    '  Send(&a.nPacketId, 9, c);',
    '}',
  ];
  it('writes the run in the listed order', () => {
    const { out, sites } = run(SITE, 'seq(a.nPacketId,a.nUnitType,a.dwUnitGUID,a.nMessageType,a.nHitClass)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.ok(out.includes('a.nPacketId = id; a.nUnitType = t; a.dwUnitGUID = g; a.nMessageType = m; a.nHitClass = h; Send'), out);
  });
  it('moves a declaration past an independent store', () => {
    const { out, sites } = run([
      'void f(R* r, L* l, S s) {',
      '  S* pSeed = &r->sSeed;',
      '  l->sSeed = s;',
      '  Init(pSeed);',
      '}',
    ], 'seq(l->sSeed,pSeed)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.ok(out.includes('l->sSeed = s; S* pSeed = &r->sSeed;'), out);
  });
  // BaalCrabAi_ResetInfernoAndReattach 005fcf30: the declarations already list them in
  // order, the stores in the loop do not.
  it('takes the run out of order, not one already in order', () => {
    const { out, sites } = run([
      'void f(C* c) {',
      '  int a1 = 0;',
      '  int a2 = 0;',
      '  if (c) {',
      '    a2 = c->n[2];',
      '    a1 = c->n[1];',
      '  }',
      '  g(a1, a2);',
      '}',
    ], 'seq(a1,a2)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.ok(out.includes('if (c) { a1 = c->n[1]; a2 = c->n[2]; }'), out);
  });
  // ExecuteHit 00663e00: a declaration without an initializer stores nothing.
  it('leaves bare declarations alone', () => {
    const { out, sites } = run([
      'void f(P* p) {',
      '  uint32_t wY;',
      '  uint32_t wX;',
      '  wY = p->y;',
      '  wX = p->x;',
      '  g(wX, wY);',
      '}',
    ], 'seq(wX,wY)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.ok(out.includes('uint32_t wY; uint32_t wX; wX = p->x; wY = p->y;'), out);
  });
  it('refuses when two runs are out of order', () => {
    const { sites } = run(['void f(P* p) {', '  b = 1;', '  a = 2;', '  g();', '  b = 3;', '  a = 4;', '}'], 'seq(a,b)');
    assert.strictEqual(sites[0].applied, false);
  });
  it('refuses when a statement reads what another stores', () => {
    const { sites } = run(['void f(int b) {', '  int a;', '  a = b;', '  c = a;', '}'], 'seq(c,a)');
    assert.strictEqual(sites[0].applied, false);
  });
  it('refuses a store through memory beside a call', () => {
    const { sites } = run(['void f(P* p) {', '  p->x = 1;', '  y = g();', '}'], 'seq(y,p->x)');
    assert.strictEqual(sites[0].applied, false);
  });
  it('refuses a run that is not adjacent', () => {
    const { sites } = run(['void f(P* p) {', '  a = 1;', '  g();', '  b = 2;', '}'], 'seq(b,a)');
    assert.strictEqual(sites[0].applied, false);
  });
});

describe('vc8-form: fold', () => {
  // Q23_SetGuardianQuestComplete 005bc140: the difficulty written straight into the argument.
  it('writes a single-use temporary into its use', () => {
    const { out, sites } = run([
      'void f(Game* pGame, Unit* pUnit) {',
      '  uint32_t nDifficulty = (uint32_t)pGame->nDifficulty;',
      '  SetClientStatus(GetClient(pUnit, 0xcc), 3, nDifficulty);',
      '}',
    ], 'fold(nDifficulty)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(Game* pGame, Unit* pUnit) { SetClientStatus(GetClient(pUnit, 0xcc), 3, (uint32_t)pGame->nDifficulty); }');
  });
  // AI_SetClearFlags 005ef1f0: `*p` of a stored `&X` is X, per store, and the declaration goes.
  it('folds an address temporary per store', () => {
    const { out, sites } = run([
      'void f(A* a, uint32_t n, int b) {',
      '  int* p;',
      '  if (b) {',
      '    p = &a->g->d;',
      '    *p |= n;',
      '    return;',
      '  }',
      '  p = &a->g->d;',
      '  *p &= ~n;',
      '}',
    ], 'fold(p)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(A* a, uint32_t n, int b) { if (b) { a->g->d |= n; return; } a->g->d &= ~n; }');
  });
  it('refuses when a name the value reads changes before the use', () => {
    const { sites } = run(['void f(int b) {', '  int t = b;', '  b = 2;', '  g(t);', '}'], 'fold(t)');
    assert.strictEqual(sites[0].applied, false);
  });
  it('refuses when the address is taken', () => {
    const { sites } = run(['void f(int b) {', '  int t = b;', '  g(&t);', '}'], 'fold(t)');
    assert.strictEqual(sites[0].applied, false);
  });
});

describe('vc8-form: cache', () => {
  // Q33_KillAnyaMonsterTimer 00589540: the quest-specific pointer in a local of its own.
  it('hoists a new local before the first statement that reads it', () => {
    const { out, sites } = run([
      'void f(Q* q) {',
      '  Unit* u = Find(q->pGame, 1, q->pSpec.pA5Q3->nGUID);',
      '  g(u);',
      '}',
    ], 'cache(q->pSpec.pA5Q3,pA5Q3Data,D2QuestDataA5Q3Strc*)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.ok(out.startsWith('void f(Q* q) { D2QuestDataA5Q3Strc* pA5Q3Data = q->pSpec.pA5Q3; Unit* u = Find(q->pGame, 1, pA5Q3Data->nGUID);'), out);
  });
  it('places the local at an anchor', () => {
    const { out, sites } = run([
      'int f(Q* q, U* u) {',
      '  int n = !u ? -1 : u->id;',
      '  int* r = q->pSpec.pA5Q2->an;',
      '  return n + *r;',
      '}',
    ], 'cache(q->pSpec.pA5Q2,pA5Q2,D2QuestDataA5Q2Strc*,@n)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.ok(out.includes('{ D2QuestDataA5Q2Strc* pA5Q2 = q->pSpec.pA5Q2; int n = !u ? -1 : u->id; int* r = pA5Q2->an;'), out);
  });
  // FreeDialogStrc 004b8020: the list head read through the local that already holds the global.
  it('reads an existing local after its store', () => {
    const { out, sites } = run([
      'void f() {',
      '  D* c;',
      '  c = gpD;',
      '  n = 0;',
      '  s = gpD->pSub;',
      '  Free(c);',
      '  gpD = c->pPrev;',
      '  h(gpD);',
      '}',
    ], 'cache(gpD,c)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.ok(out.includes('s = c->pSub; Free(c); gpD = c->pPrev; h(gpD);'), out);
  });
  // Q12_OnHoradricStaffAssembled 0059b660: read once at the top, used only in the else arm.
  it('places the local before the if an anchor tests', () => {
    const { out, sites } = run([
      'void f(Q* q) {',
      '  if (q->b != 0) {',
      '    g(q);',
      '  } else {',
      '    h(q->pSpec.pA2Q4, q);',
      '  }',
      '}',
    ], "cache(q->pSpec.pA2Q4,pQuestData,D2QuestDataA2Q4Strc*,@q->b != 0)");
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(Q* q) { D2QuestDataA2Q4Strc* pQuestData = q->pSpec.pA2Q4; if (q->b != 0) { g(q); } else { h(pQuestData, q); } }');
  });
  // OBJECT_DispatchShrineClientFunc 004bd650: the entry's address materialised once.
  it('caches an address and reads the members through it', () => {
    const { out, sites } = run([
      'void f(U* u, S* s) {',
      '  if (!aTable[s->nCode].fp) {',
      '    return;',
      '  }',
      '  aTable[s->nCode].fp(u, s);',
      '}',
    ], 'cache(&aTable[s->nCode],pEntry,Entry*)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(U* u, S* s) { Entry* pEntry = &aTable[s->nCode]; if (!pEntry->fp) { return; } pEntry->fp(u, s); }');
  });
  // OBJOP_A5Q3_RescueAnyaFromPortal 0058abc0: read first in the arm, the later reads re-read.
  it('moves only the first k reads from the anchor on', () => {
    const { out, sites } = run([
      'void f(O* o) {',
      '  g(o->pA);',
      '  G* pGame;',
      '  pGame = o->pGame;',
      '  h(o->pA);',
      '  if (pGame) {',
      '    k(o->pA);',
      '  }',
      '}',
    ], 'cache(o->pA,pAttacker,U*,@pGame,1)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(O* o) { g(o->pA); G* pGame; U* pAttacker = o->pA; pGame = o->pGame; h(pAttacker); if (pGame) { k(o->pA); } }');
  });
  it('refuses when the expression is stored between', () => {
    const { sites } = run(['void f(P* p) {', '  a = p->x;', '  p->x = 2;', '  b = p->x;', '}'], 'cache(p->x,t,int)');
    assert.strictEqual(sites[0].applied, false);
  });
});

describe('vc8-form: own', () => {
  // ITEMMODE_ConsumeItemAndRemove 00561e70: a flags local Ghidra merged with a parameter copy.
  it('declares the merged local apart, at its first store', () => {
    const { out, sites } = run([
      'void f(Game* pGame, Unit* pUnit) {',
      '  Game* eFlags = pGame;',
      '  Client* c = GetClient(pUnit);',
      '  eFlags = 0;',
      '  SetFlag((uint32_t*)&eFlags, 0x20, 1);',
      '  Send(c, (eItemFlag)eFlags);',
      '}',
    ], 'own(eFlags,uint32_t)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(Game* pGame, Unit* pUnit) { Client* c = GetClient(pUnit); uint32_t eFlags = 0; SetFlag(&eFlags, 0x20, 1); Send(c, (eItemFlag)eFlags); }');
  });
  // BNDOWNLOAD_WriteFileWithTimestamp 0051e440: the out slot of WriteFile, named apart.
  it('renames and keeps the declaration when no store follows', () => {
    const { out, sites } = run([
      'void f(LPCSTR pThis, HANDLE h) {',
      '  LPCSTR szCopy = pThis;',
      '  WriteFile(h, (LPDWORD)&szCopy);',
      '}',
    ], 'own(szCopy,DWORD,nBytesWritten)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(LPCSTR pThis, HANDLE h) { DWORD nBytesWritten; WriteFile(h, &nBytesWritten); }');
  });
  it('refuses an initializer with effects', () => {
    const { sites } = run(['void f() {', '  int v = g();', '  v = 0;', '}'], 'own(v,int)');
    assert.strictEqual(sites[0].applied, false);
  });
});

describe('vc8-form: guards and merge-guards', () => {
  // ITEMEVENT_ApplyHitDamage 005cad40: the null tests and the type test return apart.
  it('splits a negated conjunction after K conditions', () => {
    const { out, sites } = run([
      'int f(U* pUnit, U* pTarget) {',
      '  if (!(pUnit && pTarget && (pTarget->t == 0 || pTarget->t == 1))) {',
      '    return 0;',
      '  }',
      '  return 1;',
      '}',
    ], 'guards(2)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'int f(U* pUnit, U* pTarget) { if (!pUnit || !pTarget) { return 0; } if (pTarget->t != 0 && pTarget->t != 1) { return 0; } return 1; }');
  });
  it('merges two adjacent guards of one value', () => {
    const { out, sites } = run([
      'int f(U* a, U* b) {',
      '  if (!a) {',
      '    return 0;',
      '  }',
      '  if (!b) {',
      '    return 0;',
      '  }',
      '  return 1;',
      '}',
    ], 'merge-guards()');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'int f(U* a, U* b) { if (!a || !b) { return 0; } return 1; }');
  });
  it('refuses guards that return different values', () => {
    const { sites } = run(['int f(int a, int b) {', '  if (a) { return 0; }', '  if (b) { return 1; }', '  return 2;', '}'], 'merge-guards(1)');
    assert.strictEqual(sites[0].applied, false);
  });
});

describe('vc8-form: retval', () => {
  // GetPathCount 005a6290: the follow-wall path type goes straight into the return register.
  it('returns the stored value from the arm that falls through to the return', () => {
    const { out, sites } = run([
      'int f(int t) {',
      '  switch (t) {',
      '    case 1:',
      '      g();',
      '    t = 15;',
      '  }',
      '  return t;',
      '}',
    ], 'retval(t,15)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.ok(out.includes('g(); return 15; } return t; }'), out);
  });
  it('refuses when the arm does not end the construct before the return', () => {
    const { sites } = run(['int f(int t) {', '  if (t) {', '    t = 15;', '  }', '  g();', '  return t;', '}'], 'retval(t,15)');
    assert.strictEqual(sites[0].applied, false);
  });
});

describe('vc8-form: width', () => {
  // NET_MCP_CLIENT_ReadAndParsePacket 00449b70: the read size is a WORD local.
  it('declares the local at the width and drops the casts it makes redundant', () => {
    const { out, sites } = run([
      'void f(char* b) {',
      '  size_t nSize = Read(b, 0x400);',
      '  if ((short int)nSize) {',
      '    Handle(b, (uint16_t)nSize);',
      '  }',
      '}',
    ], 'width(nSize,uint16_t)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(char* b) { uint16_t nSize = Read(b, 0x400); if (nSize) { Handle(b, nSize); } }');
  });
  // SUNITNPC_ApplyScrollSkill 00576e40: the unit type held in a 32-bit local.
  it('drops a narrowing cast to the old type on a store', () => {
    const { out, sites } = run([
      'void f(U* p) {',
      '  uint8_t t;',
      '  t = (uint8_t)p->eUnitType;',
      '  Send(t);',
      '}',
    ], 'width(t,int)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(U* p) { int t; t = p->eUnitType; Send(t); }');
  });
});

describe('vc8-form: arms', () => {
  it('negates the condition and swaps the arms', () => {
    const { out, sites } = run(['void f(int a) {', '  if (a == 3) {', '    g();', '  } else {', '    h();', '  }', '}'], 'arms(a == 3)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(int a) { if (a != 3) { h(); } else { g(); } }');
  });
  it('changes nothing when the condition is not there', () => {
    const src = ['void f(int a) {', '  if (a == 3) {', '    g();', '  } else {', '    h();', '  }', '}'];
    const { out, sites } = run(src, 'arms(a == 4)');
    assert.strictEqual(sites[0].applied, false);
    assert.strictEqual(out, flat(src.join('\n')));
  });
});
