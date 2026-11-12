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
  // PETS_RecalculateAllPetLimits 00575900: the copy put back into the unit it was taken
  // from stores nothing once folded, at any depth, and goes instead of reading `pUnit = pUnit`.
  it('drops a copy back into the place the value came from', () => {
    const { out, sites } = run([
      'void f(Unit* pUnit, int b) {',
      '  Unit* pSaved;',
      '  pSaved = pUnit;',
      '  g(pSaved);',
      '  if (b) {',
      '    h(pSaved);',
      '    pUnit = pSaved;',
      '  }',
      '  pSaved = pUnit;',
      '  pUnit = pSaved;',
      '}',
    ], 'fold(pSaved)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(Unit* pUnit, int b) { g(pUnit); if (b) { h(pUnit); } }');
  });
  // NET_D2GS_CLIENT_Incoming0xAA 0045efa0: a member value copied back is dropped the same way.
  it('drops a member copied back', () => {
    const { out, sites } = run([
      'void f(S* p) {',
      '  int t = p->n;',
      '  g(t);',
      '  p->n = t;',
      '}',
    ], 'fold(t)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(S* p) { g(p->n); }');
  });
  it('keeps a copy back whose place is computed by a call', () => {
    const { out, sites } = run([
      'void f(S* p) {',
      '  int t = q()->n;',
      '  g(t);',
      '  q()->n = t;',
      '}',
    ], 'fold(t)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(S* p) { g(q()->n); q()->n = q()->n; }');
  });
  it('keeps a store of the value into another place', () => {
    const { out, sites } = run([
      'void f(Unit* pUnit, Unit* pOther) {',
      '  Unit* pSaved = pUnit;',
      '  g(pSaved);',
      '  pOther = pSaved;',
      '  h(pOther);',
      '}',
    ], 'fold(pSaved)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(Unit* pUnit, Unit* pOther) { g(pUnit); pOther = pUnit; h(pOther); }');
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
  it('drops a narrowing cast to the old type on a store whose value fits', () => {
    const { out, sites } = run([
      'void f(U* p) {',
      '  uint8_t t;',
      '  t = (uint8_t)(p->eUnitType & 0x7f);',
      '  Send(t);',
      '}',
    ], 'width(t,int)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(U* p) { int t; t = p->eUnitType & 0x7f; Send(t); }');
  });
  // MISSILE_SetPathFromTotalFrames_ForCatapultChargedBall 004cccc0: the original keeps the
  // whole frame count in EBX and pushes it to OverwriteDistanceAndMaxDistance's uint8_t.
  it('keeps a widening whose every read is a parameter of the old width', () => {
    const forms = [{ form: parseVc8Form('width(d,int)')!, tag: 'w' }];
    const sites: Vc8FormSite[] = [];
    const tu = applyVc8Forms(parse(['void f(int n) {', '  uint8_t d;', '  if (n > 0xff) {', '    d = 0xff;', '  } else {', '    d = (uint8_t)n;', '  }', '  Set(d);', '}'].join('\n')) as TranslationUnit,
      forms, s => sites.push(s), { functionParamTypes: { Set: ['uint8_t'] } });
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(flat(emit(tu as AnyNode)), 'void f(int n) { int d; if (n > 0xff) { d = 0xff; } else { d = n; } Set(d); }');
  });
  // OBJECT_DispatchShrineServerActivate 004bd5c0: a char code widened and read whole.
  it('refuses a widening read whole after a store the old type truncated', () => {
    const { sites } = run(['void f(T* p) {', '  uint8_t c;', '  c = p->cCode;', '  g((uint32_t)c);', '}'], 'width(c,int)');
    assert.strictEqual(sites[0].applied, false);
  });
  // SUNITNPC_ApplyScrollSkill 00576e40: its low byte stored through a cast address.
  it('keeps a same-width retype whose address is only cast', () => {
    const { out, sites } = run(['void f(U* p) {', '  eD2UnitType t;', '  *(uint8_t*)(char*)&t = (uint8_t)p->eUnitType;', '  Send((uint8_t)t);', '}'], 'width(t,int)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.ok(out.startsWith('void f(U* p) { int t;'), out);
  });
  it('refuses a retype whose address is used as its own pointer type', () => {
    const { sites } = run(['void f(U* p) {', '  eD2UnitType t;', '  Get(&t);', '  Send((uint8_t)t);', '}'], 'width(t,int)');
    assert.strictEqual(sites[0].applied, false);
  });
  it('refuses a width change whose address is taken', () => {
    const { sites } = run(['void f(U* p) {', '  uint8_t t;', '  *(uint8_t*)&t = 1;', '  Send(t);', '}'], 'width(t,int)');
    assert.strictEqual(sites[0].applied, false);
  });
  it('refuses to drop a narrowing cast whose value can exceed the old type', () => {
    const src = [
      'void f(int n) {',
      '  uint8_t d;',
      '  d = (uint8_t)n;',
      '  Set(d);',
      '}',
    ];
    const { out, sites } = run(src, 'width(d,int)');
    assert.strictEqual(sites[0].applied, false);
    assert.match(sites[0].why!, /can exceed uint8_t/);
    assert.strictEqual(out, flat(src.join(' ')));
  });
  it('refuses a store of an unknown value into a wider local', () => {
    const { sites } = run(['void f(U* p) {', '  uint8_t t;', '  t = (uint8_t)p->eUnitType;', '  Send(t);', '}'], 'width(t,int)');
    assert.strictEqual(sites[0].applied, false);
  });
  // MINIPANEL_ShowTooltip 0047f490: a flag stored as constants only.
  it('keeps a widening whose stores are constants of both types', () => {
    const { out, sites } = run([
      'void f(int c) {', '  bool b;', '  b = false;', '  if (c) {', '    b = true;', '  }', '  if (b && c != 0x39) {', '    g();', '  }', '}',
    ], 'width(b,int)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.ok(out.startsWith('void f(int c) { int b; b = false;'), out);
  });
  it('keeps a widening whose stores come from locals of the old type', () => {
    const { sites } = run(['int f(uint16_t a) {', '  uint16_t w;', '  w = a;', '  return w;', '}'], 'width(w,uint32_t)');
    assert.ok(sites[0].applied, sites[0].why);
  });
  // NET_MCP_CLIENT_ReadAndParsePacket 00449b70: `uVar1 & 0xffff` keeps what a short keeps.
  it('keeps a narrowing whose every read truncates to the new width', () => {
    const { out, sites } = run([
      'void f(char* b) {', '  uint32_t u;', '  u = Read(b);', '  if ((short)u != 0) {', '    Handle(b, u & 0xffff);', '  }', '}',
    ], 'width(u,short int)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, 'void f(char* b) { short int u; u = Read(b); if (u != 0) { Handle(b, u & 0xffff); } }');
  });
  it('keeps a narrowing whose read is a parameter of the new width', () => {
    const forms = [{ form: parseVc8Form('width(u,uint8_t)')!, tag: 'w' }];
    const sites: Vc8FormSite[] = [];
    const tu = applyVc8Forms(parse(['void f() {', '  uint32_t u;', '  u = Read();', '  Send(u);', '}'].join('\n')) as TranslationUnit,
      forms, s => sites.push(s), { functionParamTypes: { Send: ['uint8_t'] } });
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(flat(emit(tu as AnyNode)), 'void f() { uint8_t u; u = Read(); Send(u); }');
  });
  it('refuses a narrowing with a read that keeps more than the new width', () => {
    const { sites } = run(['int f() {', '  uint32_t u;', '  u = Read();', '  Send(u & 0xffff);', '  return u;', '}'], 'width(u,uint16_t)');
    assert.strictEqual(sites[0].applied, false);
    assert.match(sites[0].why!, /return u/);
  });
  // INPUT_ConfigMouseButtonHandler 004a6350: a short switched on as a WORD.
  it('keeps a same-width retype read only by equality with constants both hold', () => {
    const { sites } = run(['void f(M* p) {', '  short b;', '  b = *(short*)p;', '  switch (b) {', '  case 1:', '    g();', '    break;', '  case 2:', '    h();', '  }', '  if (b != 2) {', '    g();', '  }', '}'], 'width(b,uint16_t)');
    assert.ok(sites[0].applied, sites[0].why);
  });
  it('refuses a narrowing read by equality, which the wider old type decides on more bytes', () => {
    const { sites } = run(['void f() {', '  int b;', '  b = Read();', '  if (b == 1) {', '    g();', '  }', '}'], 'width(b,uint8_t)');
    assert.strictEqual(sites[0].applied, false);
  });
  // MISSILE_CreateSubWithSound 004ce850: small constants, but a 32-bit unsigned local
  // compared with a value that may be negative compares unsigned.
  it('refuses a signedness change a read depends on', () => {
    const { sites } = run(['void f(int k) {', '  uint32_t m;', '  m = 4;', '  if (k < m) {', '    g();', '  }', '}'], 'width(m,int)');
    assert.strictEqual(sites[0].applied, false);
    assert.match(sites[0].why!, /signedness/);
  });
  it('keeps a signedness change no read depends on', () => {
    const { sites } = run(['void f(S* s) {', '  uint32_t m;', '  m = 4;', '  if (1 < m) {', '    g(s, m);', '  }', '  h(m / 2);', '}'], 'width(m,int)');
    assert.ok(sites[0].applied, sites[0].why);
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
  it('negates by De Morgan, or with wrap as !(C)', () => {
    const src = ['void f(P* p) {', '  if (p && p->q) {', '    g();', '  } else {', '    h();', '  }', '}'];
    assert.strictEqual(run(src, 'arms(p && p->q)').out, 'void f(P* p) { if (!p || !p->q) { h(); } else { g(); } }');
    // NPCMENU_OpenNpcShop 004b3d40: `(p && p->q) == 0` with zero.
    assert.strictEqual(run(src, 'arms(p && p->q,wrap)', 'zero(p && p->q)').out, 'void f(P* p) { if ((p && p->q) == 0) { h(); } else { g(); } }');
  });
});

describe('vc8-form: tsel', () => {
  // SKILLASS_AddChargeUpStack 005d3320: the unit's type and GUID, a sentinel each without one.
  const SITE = [
    'int f(D2UnitStrc *pUnit, void *pPool, int nFrame) {',
    '  eD2UnitType eUnitType;',
    '  int nGuid;',
    '  if (!pUnit) {',
    '    nGuid = -1;',
    '    eUnitType = UNIT_COUNT;',
    '  } else {',
    '    nGuid = pUnit->nUnitGUID;',
    '    eUnitType = pUnit->eUnitType;',
    '  }',
    '  void *pStats = AllocStatList(pPool, 2, nFrame, eUnitType, nGuid);',
    '  return pStats != 0;',
    '}',
  ];
  // The enum is a typedef of uint32_t and UNIT_COUNT a constant several enums declare alike.
  const tables = {
    structFields: { D2UnitStrc: { nUnitGUID: 'int', eUnitType: 'eD2UnitType' } },
    typedefTargets: { eD2UnitType: 'uint32_t' },
    enumValues: { UNIT_COUNT: 6 },
  };
  const apply = (tag: string, withTables = true) => {
    const sites: Vc8FormSite[] = [];
    const tu = applyVc8Forms(parse(SITE.join('\n')) as TranslationUnit, [{ form: parseVc8Form(tag)!, tag }], s => sites.push(s), withTables ? tables : undefined);
    return { out: flat(emit(tu as AnyNode)), sites };
  };

  it('parses with an optional index', () => {
    assert.deepStrictEqual(parseVc8Form('tsel(!pUnit)'), { op: 'tsel', cond: '!pUnit', index: 1 });
    assert.deepStrictEqual(parseVc8Form('tsel(!pUnit,2)'), { op: 'tsel', cond: '!pUnit', index: 2 });
    assert.strictEqual(parseVc8Form('tsel()'), undefined);
  });

  it('writes the selects into the call and drops the if and the declarations', () => {
    const { out, sites } = apply('tsel(!pUnit)');
    assert.strictEqual(sites[0]?.applied, true, JSON.stringify(sites));
    assert.ok(out.includes('void* pStats = AllocStatList(pPool, 2, nFrame, !pUnit ? UNIT_COUNT : pUnit->eUnitType, !pUnit ? -1 : pUnit->nUnitGUID);'), out);
    assert.ok(!out.includes('eD2UnitType eUnitType;') && !out.includes('int nGuid;'), out);
  });

  it('refuses without the types of the values, or another if', () => {
    const untyped = apply('tsel(!pUnit)', false);
    assert.strictEqual(untyped.sites[0]?.applied, false);
    assert.ok(untyped.out.includes('if (!pUnit)'), untyped.out);
    assert.strictEqual(apply('tsel(!pUnit,2)').sites[0]?.applied, false);
  });
});

describe('vc8-form: shift', () => {
  it('parses the operand, the kind and the index', () => {
    assert.deepStrictEqual(parseVc8Form('shift(nHandle,sar)'), { op: 'shift', expr: 'nHandle', how: 'sar', index: 0 });
    assert.deepStrictEqual(parseVc8Form('shift(nSlot,shr,2)'), { op: 'shift', expr: 'nSlot', how: 'shr', index: 2 });
    assert.strictEqual(parseVc8Form('shift(nSlot,rol)'), undefined);
  });

  it('writes the high word of a signed handle arithmetically', () => {
    // DATAARRAY_GetSlot 006bccd0: `sar eax, 0x10`.
    const { out, sites } = run(['int f(int nHandle) { int nSlot = (int)(short int)((uint32_t)nHandle >> 0x10); return nSlot; }'], 'shift(nHandle,sar)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.ok(out.includes('(short int)(nHandle >> 0x10)'), out);
  });

  it('writes the half of an unsigned value arithmetically through an int cast, and back', () => {
    // WEATHER_SpawnSplash 00472da0: `sar eax, 0x10; movsx eax, ax`.
    const a = run(['void f(uint32_t nSlot) { short int n = (short int)(nSlot >> 0x10); g(n); }'], 'shift(nSlot,sar)');
    assert.ok(a.out.includes('(short int)((int)nSlot >> 0x10)'), a.out);
    const b = run(['void f(int x) { g((uint8_t)(x >> 8)); }'], 'shift(x,shr)');
    assert.ok(b.out.includes('(uint8_t)((uint32_t)x >> 8)'), b.out);
  });

  it('refuses a kept top bit, bool, an unknown or wide operand and a no-op', () => {
    const refused = (lines: string[], form: string) => { const { sites } = run(lines, form); return !sites[0].applied; };
    assert.ok(refused(['void f(int x) { g((uint16_t)((uint32_t)x >> 0x11)); }'], 'shift(x,sar)'));
    assert.ok(refused(['void f(int x) { g((bool)((uint32_t)x >> 0x1f)); }'], 'shift(x,sar)'));
    assert.ok(refused(['void f(int64_t x) { g((uint8_t)((uint32_t)x >> 8)); }'], 'shift(x,sar)'));
    assert.ok(refused(['void f() { g((uint8_t)((uint32_t)gx >> 8)); }'], 'shift(gx,sar)'));
    assert.ok(refused(['void f(int x) { g((uint8_t)(x >> 8)); }'], 'shift(x,sar)'));
    assert.ok(refused(['void f(int x) { g((uint8_t)(x >> 8)); h((uint8_t)(x >> 0x10)); }'], 'shift(x,shr)'));
  });
});

describe('vc8-form: boolflag', () => {
  // FINDTILE_Register 0060cfa0: `MOV EBX,1` / `XOR EBX,EBX` / `TEST EBX,EBX`.
  const FIND = [
    'void f(Node* p, int k) {',
    '  bool bFound = true;',
    '  while (p) {',
    '    if (!bFound) { g(1); }',
    '    if (p->k == k) { bFound = false; }',
    '    p = p->next;',
    '  }',
    '  if (bFound && k) { g(2); }',
    '}',
  ];
  it('declares the flag BOOL and stores 1 and 0', () => {
    const { out, sites } = run(FIND, 'boolflag(bFound)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.ok(out.includes('BOOL bFound = 1;'), out);
    assert.ok(out.includes('bFound = 0;'), out);
    assert.ok(out.includes('if (!bFound)'), out);
  });
  it('refuses a computed store, a read as a value, or a taken address', () => {
    for (const [from, to] of [['bFound = false;', 'bFound = k > 2;'], ['g(2);', 'g(bFound);'], ['g(2);', 'h(&bFound);']]) {
      const { out, sites } = run(FIND.map(l => l.replace(from, to)), 'boolflag(bFound)');
      assert.ok(!sites[0].applied, `${to}: ${out}`);
      assert.ok(out.includes('bool bFound'), out);
    }
  });
});

describe('vc8-form: retwiden', () => {
  // HandleMouseButtonEvent 0044c5e0: one MOVZX at the call instead of at the read.
  const KEY = [
    'void f() {',
    '  uint16_t wVirtualKey;',
    '  wVirtualKey = CMD_GetKeyForCommand(0x22, 1);',
    '  if (GetAsyncKeyState((uint32_t)wVirtualKey) >= 0) { g(); }',
    '}',
  ];
  it('declares it int32_t and narrows each stored value to its old type', () => {
    const { out, sites } = run(KEY, 'retwiden(wVirtualKey)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.ok(out.includes('int32_t wVirtualKey;'), out);
    assert.ok(out.includes('wVirtualKey = (uint16_t)CMD_GetKeyForCommand(0x22, 1);'), out);
  });
  it('refuses a local never stored from a call, a wide local, or one stepped in place', () => {
    for (const lines of [
      KEY.map(l => l.replace('CMD_GetKeyForCommand(0x22, 1)', '5')),
      KEY.map(l => l.replace('uint16_t wVirtualKey;', 'int wVirtualKey;')),
      KEY.map(l => l.replace('g();', 'wVirtualKey++;')),
    ]) {
      const { sites } = run(lines, 'retwiden(wVirtualKey)');
      assert.ok(!sites[0].applied, lines.join(' '));
    }
  });
});

describe('Golden: a tag recorded before seed-roll-step', () => {
  // AITHINK_Fn1_Arach 005f4510 as the 1150 generator printed its engaged-in-combat arm
  // (program v2071): the step is one call and DVar1 the uint32_t low word, the if nested
  // by branch-layout. Its tag names the condition as recorded, over DVar1.nSeedLow.
  const ARACH = [
    'void f(SGAMEDATA* pGame, D2UnitStrc* pUnit, D2MonStatsTxt* pMonStats, D2SeedStrc* pSeed, D2UnitStrc* pAttacker, int bEngagedInCombat) {',
    '  uint32_t DVar1;',
    '  if (bEngagedInCombat) {',
    '    DVar1 = D2_SeedRoll(pSeed);',
    '    if ((int)(DVar1 % 100) >= (int)pMonStats->aip[0][pGame->nDifficulty]) {',
    '      PlanNextAiMove(pGame, pUnit, 0xf);',
    '      return;',
    '    }',
    '',
    '    AI_ChangeModeAndTargetUnit(pGame, pUnit, 4, pAttacker);',
    '    return;',
    '  }',
    '  g();',
    '}',
  ];
  const TAG = 'nest((int)(DVar1.nSeedLow % 100) >= (int)pMonStats->aip[0][pGame->nDifficulty])';

  it('AITHINK_Fn1_Arach 005f4510: the nest applies, the mode change first again', () => {
    const { out, sites } = run(ARACH, TAG);
    assert.ok(sites[0].applied, sites[0].why);
    assert.ok(out.indexOf('AI_ChangeModeAndTargetUnit') < out.indexOf('PlanNextAiMove'), out);
    assert.ok(out.includes('if ((int)(DVar1 % 100) < (int)pMonStats->aip[0][pGame->nDifficulty])'), out);
  });

  it('leaves the member where the local still is the seed', () => {
    const { sites } = run(ARACH.map(l => l.replace('uint32_t DVar1;', 'D2SeedStrc DVar1;')), TAG);
    assert.ok(!sites[0].applied);
  });
});

describe('vc8-form: acc', () => {
  const twin = (name: string, field: string) => `static inline int ${name}(D2UnitStrc * pUnit) { if (pUnit) { return pUnit->${field}; } return (int)-1; }`;
  const tables = {
    structFields: { Args: { pTarget: 'D2UnitStrc *' }, D2UnitStrc: { eUnitType: 'eD2UnitType', nClassId: 'int', nUnitGUID: 'int', eAnimMode: 'uD2UnitMode' }, uD2UnitMode: { ePlayerMode: 'eD2PlayerAnimMode' } },
    enumValues: { UNIT_PLAYER: 0, UNIT_MONSTER: 1, UNIT_ITEM: 4, UNIT_COUNT: 6, Death: 0, Neutral: 1 },
    accessors: [
      { struct: 'D2UnitStrc', path: ['eUnitType'], call: 'GetTypeInline', dflt: 6n, definition: twin('GetTypeInline', 'eUnitType') },
      { struct: 'D2UnitStrc', path: ['nUnitGUID'], call: 'GetGUIDInline', dflt: -1n, definition: twin('GetGUIDInline', 'nUnitGUID') },
      { struct: 'D2UnitStrc', path: ['nClassId'], call: 'GetClassIdInline', dflt: -1n, definition: twin('GetClassIdInline', 'nClassId') },
      { struct: 'D2UnitStrc', path: ['eAnimMode', 'ePlayerMode'], call: 'GetAnimModeInline', dflt: 0n, definition: twin('GetAnimModeInline', 'eAnimMode.ePlayerMode') },
    ],
  };
  function acc(lines: string[], tag: string) {
    const sites: Vc8FormSite[] = [];
    const tu = applyVc8Forms(parse(lines.join('\n')) as TranslationUnit, [{ form: parseVc8Form(tag)!, tag }], s => sites.push(s), tables as never);
    return { out: flat(emit(tu as AnyNode)), site: sites[0] };
  }

  it('parses with an optional index', () => {
    assert.deepStrictEqual(parseVc8Form('acc(pUnit->eUnitType)'), { op: 'acc', expr: 'pUnit->eUnitType', index: 0 });
    assert.deepStrictEqual(parseVc8Form('acc(p->eAnimMode.ePlayerMode,2)'), { op: 'acc', expr: 'p->eAnimMode.ePlayerMode', index: 2 });
    assert.deepStrictEqual(parseVc8Form('acc(p->nUnitGUID,bare)'), { op: 'acc', expr: 'p->nUnitGUID', index: 0, bare: true });
    assert.deepStrictEqual(parseVc8Form('acc(p->nUnitGUID,2,bare)'), { op: 'acc', expr: 'p->nUnitGUID', index: 2, bare: true });
    assert.strictEqual(parseVc8Form('acc(p->nUnitGUID,x)'), undefined);
  });

  it('bare writes the read alone inside the printed ternary (0046bc70)', () => {
    const { out } = acc(['void f(D2UnitStrc* pUnit) { g = !pUnit ? -1 : pUnit->nUnitGUID; }'], 'acc(pUnit->nUnitGUID,bare)');
    assert.ok(out.includes('g = !pUnit ? -1 : GetGUIDInline(pUnit);'), out);
    const absorbed = acc(['void f(D2UnitStrc* pUnit) { g = !pUnit ? -1 : pUnit->nUnitGUID; }'], 'acc(pUnit->nUnitGUID)');
    assert.ok(absorbed.out.includes('g = GetGUIDInline(pUnit);'), absorbed.out);
  });

  it('writes a compared field as the twin call and reports the twin (005eb650)', () => {
    const { out, site } = acc([
      'int f(D2UnitStrc* pUnit2) {',
      '  if (!pUnit2) { return 0; }',
      '  if (pUnit2->eUnitType != UNIT_MONSTER) { return 0; }',
      '  return 1;',
      '}',
    ], 'acc(pUnit2->eUnitType)');
    assert.ok(site.applied, site.why);
    assert.ok(out.includes('if (GetTypeInline(pUnit2) != UNIT_MONSTER)'), out);
    assert.deepStrictEqual(site.prefix, [tables.accessors[0].definition]);
  });

  it('writes a field passed or stored as the call (0046bc70, 0058a500)', () => {
    const { out } = acc([
      'void f(D2UnitStrc* pUnit, Q* q) {',
      '  q->nGUID = pUnit->nUnitGUID;',
      '  g(pUnit->nClassId);',
      '}',
    ], 'acc(pUnit->nUnitGUID)');
    assert.ok(out.includes('q->nGUID = GetGUIDInline(pUnit);'), out);
    assert.ok(out.includes('g(pUnit->nClassId)'), 'the other read stays');
  });

  it('takes the null test in front of an equality with it (0058fad0, 00628220)', () => {
    const one = acc(['int f(Args* a) { return a->pTarget && a->pTarget->nClassId == 0x9b; }'], 'acc(a->pTarget->nClassId)');
    assert.ok(one.out.includes('return GetClassIdInline(a->pTarget) == 0x9b;'), one.out);
    const chained = acc(['int f(D2UnitStrc* pUnit, int k) { if (!(k && pUnit && pUnit->eUnitType == UNIT_ITEM && pUnit->pUnitData)) { return 0; } return 1; }'], 'acc(pUnit->eUnitType)');
    assert.ok(chained.out.includes('if (!(k && GetTypeInline(pUnit) == UNIT_ITEM && pUnit->pUnitData))'), chained.out);
    const or = acc(['int f(D2UnitStrc* pUnit) { return !pUnit || pUnit->eUnitType != UNIT_PLAYER; }'], 'acc(pUnit->eUnitType)');
    assert.ok(or.out.includes('return GetTypeInline(pUnit) != UNIT_PLAYER;'), or.out);
  });

  it('keeps the null test where the accessor constant would change the truth', () => {
    // GetTypeInline(nullptr) == UNIT_COUNT: `p && p->t == UNIT_COUNT` is false for null, the call true.
    const same = acc(['int f(D2UnitStrc* p) { return p && p->eUnitType == UNIT_COUNT; }'], 'acc(p->eUnitType)');
    assert.ok(same.out.includes('return p && GetTypeInline(p) == UNIT_COUNT;'), same.out);
    const ne = acc(['int f(D2UnitStrc* p) { return p && p->eUnitType != UNIT_ITEM; }'], 'acc(p->eUnitType)');
    assert.ok(ne.out.includes('return p && GetTypeInline(p) != UNIT_ITEM;'), ne.out);
  });

  it('writes the printed ternary with the accessor constant as the call (0063d2b0)', () => {
    const { out } = acc(['int f(D2UnitStrc* pUnit) { return (pUnit ? pUnit->eUnitType : UNIT_COUNT) == UNIT_ITEM; }'], 'acc(pUnit->eUnitType)');
    assert.ok(out.includes('return GetTypeInline(pUnit) == UNIT_ITEM;'), out);
  });

  it('reads a nested field through its accessor (00622d00)', () => {
    const { out } = acc(['int f(D2UnitStrc* pUnit) { switch (pUnit->eAnimMode.ePlayerMode) { case 2: return 1; } return 0; }'], 'acc(pUnit->eAnimMode.ePlayerMode)');
    assert.ok(out.includes('switch (GetAnimModeInline(pUnit))'), out);
  });

  it('refuses a pointer of another type, a computed pointer, and an unknown field', () => {
    const other = acc(['int f(Other* p) { return p->eUnitType; }'], 'acc(p->eUnitType)');
    assert.ok(!other.site.applied && /not a D2UnitStrc/.test(other.site.why!), other.site.why);
    const computed = acc(['int f(D2UnitStrc** pp) { return pp[0]->eUnitType; }'], 'acc(pp[0]->eUnitType)');
    assert.ok(!computed.site.applied, computed.out);
    const unknown = acc(['int f(D2UnitStrc* p) { return p->dwFlags; }'], 'acc(p->dwFlags)');
    assert.ok(!unknown.site.applied, unknown.out);
  });
});

describe('vc8-form: retvar', () => {
  // WEATHER_GetCurrentLevelWeatherFlags 00473770: the zero comes back from the register it was put in.
  const SITE = [
    'uint32_t __stdcall f() {',
    '  D2UnitStrc* pUnit = GetPlayerUnit_Net();',
    '  if (pUnit) {',
    '    uint8_t bCanHaveMud;',
    '    bCanHaveMud = LEVEL_CanHaveMud(GetLevel(pUnit));',
    '    return (uint32_t)(bCanHaveMud != 0);',
    '  }',
    '  return 0;',
    '}',
  ];
  it('parses', () => {
    assert.deepStrictEqual(parseVc8Form('retvar(pUnit,dwFlags)'), { op: 'retvar', cond: 'pUnit', name: 'dwFlags', index: 1 });
    assert.strictEqual(parseVc8Form('retvar(pUnit)'), undefined);
  });
  it('declares the result after the call and returns it once', () => {
    const { out, sites } = run(SITE, 'retvar(pUnit,dwFlags)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.ok(out.includes('D2UnitStrc* pUnit = GetPlayerUnit_Net(); uint32_t dwFlags = 0; if (pUnit) {'), out);
    assert.ok(out.includes('dwFlags = (uint32_t)(bCanHaveMud != 0); } return dwFlags; }'), out);
  });
  it('refuses an arm that returns elsewhere, a non-constant tail and a taken name', () => {
    const early = run(SITE.map(l => l.replace('uint8_t bCanHaveMud;', 'if (g) { return 2; }')), 'retvar(pUnit,dwFlags)');
    assert.ok(!early.sites[0].applied);
    const tail = run(SITE.map(l => l.replace('return 0;', 'return g;')), 'retvar(pUnit,dwFlags)');
    assert.ok(!tail.sites[0].applied);
    const taken = run(SITE, 'retvar(pUnit,bCanHaveMud)');
    assert.ok(!taken.sites[0].applied);
  });
});

describe('vc8-form: onecall', () => {
  // SUNITNPC_CloseNpcInteraction 00579130: the zero arm passes its value from a register.
  const SITE = [
    'void __fastcall f(SGAMEDATA* pGame, D2UnitStrc* pUnit, D2UnitStrc* pNpc) {',
    '  ClearInteractInfo(pUnit);',
    '  if (pNpc && pNpc->eUnitType == UNIT_MONSTER && pNpc->pUnitData.pUnitDataMonster) {',
    '    FreeSpecificAiForUnit(pGame, pUnit, pNpc->pUnitData.pUnitDataMonster->pMonsterAi);',
    '    return;',
    '  }',
    '  FreeSpecificAiForUnit(pGame, pUnit, nullptr);',
    '}',
  ];
  const tables = { functionParamTypes: { FreeSpecificAiForUnit: ['SGAMEDATA *', 'D2UnitStrc *', 'D2MonsterAiStrc *'] } };
  const one = (lines: string[], tag: string) => {
    const sites: Vc8FormSite[] = [];
    const tu = applyVc8Forms(parse(lines.join('\n')) as TranslationUnit, [{ form: parseVc8Form(tag)!, tag }], s => sites.push(s), tables as never);
    return { out: flat(emit(tu as AnyNode)), site: sites[0] };
  };
  const C = 'pNpc && pNpc->eUnitType == UNIT_MONSTER && pNpc->pUnitData.pUnitDataMonster';
  it('writes the two calls as one, the differing argument chosen ahead of it', () => {
    const { out, site } = one(SITE, `onecall(${C},pAi)`);
    assert.ok(site.applied, site.why);
    assert.ok(out.includes(`D2MonsterAiStrc* pAi; if (${C}) { pAi = pNpc->pUnitData.pUnitDataMonster->pMonsterAi; } else { pAi = nullptr; } FreeSpecificAiForUnit(pGame, pUnit, pAi); }`), out);
  });
  it('refuses calls differing in two arguments, an argument that calls, and an unknown parameter type', () => {
    const two = one(SITE.map(l => l.replace('(pGame, pUnit, nullptr)', '(pGame, pNpc, nullptr)')), `onecall(${C},pAi)`);
    assert.ok(!two.site.applied);
    const calls = one(SITE.map(l => l.replace('(pGame, pUnit, nullptr)', '(GetGame(), pUnit, nullptr)').replace('(pGame, pUnit, pNpc->', '(GetGame(), pUnit, pNpc->')), `onecall(${C},pAi)`);
    assert.ok(!calls.site.applied);
    const sites: Vc8FormSite[] = [];
    applyVc8Forms(parse(SITE.join('\n')) as TranslationUnit, [{ form: parseVc8Form(`onecall(${C},pAi)`)!, tag: 'x' }], s => sites.push(s));
    assert.ok(!sites[0].applied && /parameter type/.test(sites[0].why!));
  });
});

describe('vc8-form: roundup', () => {
  // TSGrowableArray<SGAMEDATA>::Reserve 00450e70 as the generator wraps it.
  const SITE = [
    'void dummy(TSGrowableArray<SGAMEDATA>* pThis, uint32_t nCount, int32_t bRound) {',
    '  uint32_t nNeeded = nCount + this->m_count;',
    '  if (nNeeded <= this->m_alloc) {',
    '    return;',
    '  }',
    '  if (bRound) {',
    '    uint32_t nGranularity;',
    '    nGranularity = this->m_chunk;',
    '    if (!nGranularity) {',
    '      nGranularity = this->CalcChunkSize(nNeeded);',
    '    }',
    '    if (nNeeded % nGranularity) {',
    '      nNeeded = nGranularity - nNeeded % nGranularity + nNeeded;',
    '    }',
    '  }',
    '  this->ReallocData(nNeeded);',
    '}',
  ];
  it('parses', () => {
    assert.deepStrictEqual(parseVc8Form('roundup(nNeeded)'), { op: 'roundup', name: 'nNeeded' });
    assert.deepStrictEqual(parseVc8Form('roundup(nNeeded,nCount)'), { op: 'roundup', name: 'nNeeded', param: 'nCount' });
    assert.strictEqual(parseVc8Form('roundup(a+b)'), undefined);
    assert.strictEqual(parseVc8Form('roundup(a,b,c)'), undefined);
  });
  it('the rounding is the helper, which the site reports as its prefix', () => {
    const { out, sites } = run(SITE, 'roundup(nNeeded)');
    assert.match(out, /if \(!nGranularity\) \{ nGranularity = this->CalcChunkSize\(nNeeded\); \} nNeeded = D2_RoundUp\(nNeeded, nGranularity\); \}/);
    assert.ok(sites[0].applied);
    assert.match(sites[0].prefix![0], /static inline uint32_t D2_RoundUp\(uint32_t n, uint32_t g\) \{/);
  });
  it('with P the sum is the parameter: 00450e70 as measured', () => {
    const { out, sites } = run(SITE, 'roundup(nNeeded,nCount)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, flat(`void dummy(TSGrowableArray<SGAMEDATA>* pThis, uint32_t nCount, int32_t bRound) {
      nCount = nCount + this->m_count;
      if (nCount <= this->m_alloc) { return; }
      if (bRound) {
        uint32_t nGranularity;
        nGranularity = this->m_chunk;
        if (!nGranularity) { nGranularity = this->CalcChunkSize(nCount); }
        nCount = D2_RoundUp(nCount, nGranularity);
      }
      this->ReallocData(nCount);
    }`));
  });
  it('refuses a parameter of another type (Storm\'s int32_t nAdditional)', () => {
    const { sites } = run(SITE.map(l => l.replace('uint32_t nCount', 'int32_t nCount')), 'roundup(nNeeded,nCount)');
    assert.ok(!sites[0].applied);
    assert.match(sites[0].why!, /nCount is int32_t/);
  });
  it('refuses a parameter read again, a signed granularity, and a rounding of another shape', () => {
    const again = run(SITE.map(l => l.replace('this->ReallocData(nNeeded);', 'this->ReallocData(nNeeded + nCount);')), 'roundup(nNeeded,nCount)');
    assert.match(again.sites[0].why!, /named 2 times/);
    const signed = run(SITE.map(l => l.replace('uint32_t nGranularity;', 'int nGranularity;')), 'roundup(nNeeded)');
    assert.match(signed.sites[0].why!, /nGranularity is not an unsigned 32-bit local/);
    const other = run(SITE.map(l => l.replace('nGranularity - nNeeded % nGranularity + nNeeded', 'nNeeded + nGranularity - nNeeded % nGranularity')), 'roundup(nNeeded)');
    assert.match(other.sites[0].why!, /0 round-up sites/);
  });
});

describe('vc8-form: swmerge', () => {
  // OBJECT_AddVisualOverlay 004bc8d0 as the generator prints it.
  const SITE = [
    'void f(D2UnitStrc* pUnit) {',
    '  uint32_t nObjectClassId = pUnit->nClassId;',
    '  if (nObjectClassId <= 0x18d) {',
    '    if (nObjectClassId != 0x18d) {',
    '      switch (nObjectClassId) {',
    '        case 0x98:',
    '          g(pUnit, 1);',
    '        return;',
    '        case 0x162:',
    '        case 0x163:',
    '        case 0x164:',
    '          break;',
    '        case 0x95:',
    '          if (pUnit->eMode != 1) {',
    '            return;',
    '          }',
    '        g(pUnit, 1);',
    '        return;',
    '        default:',
    '          return;',
    '      }',
    '    }',
    '  } else {',
    '    if (nObjectClassId < 0x195) {',
    '      return;',
    '    }',
    '    if (nObjectClassId > 0x197 && nObjectClassId != 0x1c7) {',
    '      return;',
    '    }',
    '  }',
    '  if (pUnit->eMode != 2) {',
    '    return;',
    '  }',
    '  g(pUnit, 2);',
    '}',
  ];
  it('parses', () => {
    assert.deepStrictEqual(parseVc8Form('swmerge(nObjectClassId)'), { op: 'swmerge', name: 'nObjectClassId', index: 1 });
    assert.strictEqual(parseVc8Form('swmerge(a->b)'), undefined);
  });
  it('004bc8d0: one switch, the boundary and the far values in the group that breaks', () => {
    const { out, sites } = run(SITE, 'swmerge(nObjectClassId)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.strictEqual(out, flat(`void f(D2UnitStrc* pUnit) {
      uint32_t nObjectClassId = pUnit->nClassId;
      switch (nObjectClassId) {
        case 0x98: g(pUnit, 1); return;
        case 0x162: case 0x163: case 0x164: case 0x18d: case 0x195: case 0x196: case 0x197: case 0x1c7: break;
        case 0x95: if (pUnit->eMode != 1) { return; } g(pUnit, 1); return;
        default: return;
      }
      if (pUnit->eMode != 2) { return; }
      g(pUnit, 2);
    }`));
  });
  it('the same values reach the same statements before and after', () => {
    // Model each path: which branch a value takes, as the two bodies decide it.
    const before = (x: number): string => {
      if (x <= 0x18d) {
        if (x === 0x18d) return 'rest';
        if (x === 0x98 || x === 0x95) return `case${x}`;
        if (x >= 0x162 && x <= 0x164) return 'rest';
        return 'leave';
      }
      if (x < 0x195) return 'leave';
      if (x > 0x197 && x !== 0x1c7) return 'leave';
      return 'rest';
    };
    const after = (x: number): string => {
      if (x === 0x98 || x === 0x95) return `case${x}`;
      if ([0x162, 0x163, 0x164, 0x18d, 0x195, 0x196, 0x197, 0x1c7].includes(x)) return 'rest';
      return 'leave';
    };
    for (let x = 0; x < 0x400; x++) assert.strictEqual(after(x), before(x), `value ${x.toString(16)}`);
  });
  it('a label above the bound would come alive: refused', () => {
    const { sites } = run(SITE.map(l => l.replace('case 0x162:', 'case 0x1c0:')), 'swmerge(nObjectClassId)');
    assert.match(sites[0].why!, /label 448 lies outside/);
  });
  it('a guard on something else, or one that leaves another way, is refused', () => {
    const other = run(SITE.map(l => l.replace('nObjectClassId > 0x197 && nObjectClassId != 0x1c7', 'nObjectClassId > 0x197 && pUnit->eMode')), 'swmerge(nObjectClassId)');
    assert.match(other.sites[0].why!, /reads more than nObjectClassId/);
    const leave = run(SITE.map((l, j) => (j === 24 ? '      return 0;' : l)), 'swmerge(nObjectClassId)');
    assert.ok(!leave.sites[0].applied);
  });
  it('a range too wide to list is refused', () => {
    const { sites } = run(SITE.map(l => l.replace('nObjectClassId > 0x197 && nObjectClassId != 0x1c7', 'nObjectClassId > 0x297 && nObjectClassId != 0x1c7')), 'swmerge(nObjectClassId)');
    assert.match(sites[0].why!, /too wide|more than 64/);
  });
});

describe('vc8-form: opas', () => {
  const PLUS = [
    'void dummy(Access* pGatewayAccess) {',
    '  int32_t nSelectedLine = GetSelectedLine();',
    '  if (nSelectedLine != -1) {',
    '    char* pszRealmName;',
    '    SetCurGateway(pGatewayAccess, nSelectedLine + 1);',
    '    pszRealmName = Realm(pGatewayAccess, nSelectedLine + 1);',
    '    Save(pszRealmName);',
    '  }',
    '}',
  ];
  const BYTE = [
    'void dummy(MonStats* pMonStatLine, Unit* pUnit) {',
    '  uint8_t byMinGrp = pMonStatLine->MinGrp;',
    '  uint8_t byMaxGrp = pMonStatLine->MaxGrp;',
    '  if (byMinGrp && byMaxGrp && byMaxGrp >= byMinGrp) {',
    '    if (!pUnit) { return; }',
    '    nMinionCount = RNG((uint32_t)(uint8_t)(byMinGrp - 1));',
    '    for (nMinionIdx = nMinionCount + (uint8_t)(byMinGrp - 1); nMinionIdx > 0; nMinionIdx--) { Spawn(); }',
    '  }',
    '}',
  ];
  const PAIR = [
    'void dummy(Path* pDynamicPath, int32_t nX, int32_t nY) {',
    '  DRLG_WorldToScreenNoShift(&nX, &nY);',
    '  pDynamicPath->nTargetX = (short int)(nX >> 0xb);',
    '  pDynamicPath->nTargetY = (short int)(nY >> 0xb);',
    '}',
  ];
  it('parses only named, literal, nonduplicated updates', () => {
    assert.deepStrictEqual(parseVc8Form('opas(nSelectedLine,+,1)'), { op: 'opas', updates: [{ name: 'nSelectedLine', operator: '+', constant: '1' }] });
    assert.deepStrictEqual(parseVc8Form('opas(nX,>>,0xb,nY,>>,0xb)'), { op: 'opas', updates: [
      { name: 'nX', operator: '>>', constant: '0xb' }, { name: 'nY', operator: '>>', constant: '0xb' },
    ] });
    assert.strictEqual(parseVc8Form('opas(nX,>>,0xb,nX,>>,0xb)'), undefined);
    assert.strictEqual(parseVc8Form('opas(nX,>>,f())'), undefined);
    assert.strictEqual(parseVc8Form('opas(nX,>>,0xb,@site)'), undefined);
  });
  it('updates a guarded int32 local once before two calls', () => {
    const plain = run(PLUS);
    const { out, sites } = run(PLUS, 'opas(nSelectedLine,+,1)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.notStrictEqual(out, plain.out);
    assert.match(out, /if \(nSelectedLine != -1\) \{ char\* pszRealmName; nSelectedLine \+= 1; SetCurGateway\(pGatewayAccess, nSelectedLine\); pszRealmName = Realm\(pGatewayAccess, nSelectedLine\);/);
  });
  it('narrows a guarded byte update before both uses', () => {
    const { out, sites } = run(BYTE, 'opas(byMinGrp,-,1)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.match(out, /byMinGrp -= 1; nMinionCount = RNG\(\(uint32_t\)\(uint8_t\)byMinGrp\); for \(nMinionIdx = nMinionCount \+ \(uint8_t\)byMinGrp;/);
  });
  it('writes paired shifts in order before either store', () => {
    const { out, sites } = run(PAIR, 'opas(nX,>>,0xb,nY,>>,0xb)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.match(out, /DRLG_WorldToScreenNoShift\(&nX, &nY\); nX >>= 0xb; nY >>= 0xb; pDynamicPath->nTargetX = \(short int\)nX; pDynamicPath->nTargetY = \(short int\)nY;/);
  });
  it('keeps untagged source and stale tagged source unchanged', () => {
    const untagged = run(PLUS);
    assert.deepStrictEqual(untagged.sites, []);
    const staleInput = PLUS.map(l => l.replace('pszRealmName = Realm(pGatewayAccess, nSelectedLine + 1);',
      'pszRealmName = Realm(pGatewayAccess, nSelectedLine + 2);'));
    const stalePlain = run(staleInput);
    const staleTagged = run(staleInput, 'opas(nSelectedLine,+,1)');
    assert.strictEqual(staleTagged.sites[0].applied, false);
    assert.strictEqual(staleTagged.out, stalePlain.out);
    const pairPlain = run(PAIR.map(l => l.replace('(&nX, &nY)', '(&nY, &nX)')));
    const pairStale = run(PAIR.map(l => l.replace('(&nX, &nY)', '(&nY, &nX)')), 'opas(nX,>>,0xb,nY,>>,0xb)');
    assert.strictEqual(pairStale.sites[0].applied, false);
    assert.strictEqual(pairStale.out, pairPlain.out);
  });
  it('refuses shadowed bindings, stale reads, impure operands and crossing a call', () => {
    const shadow = run(PLUS.map(l => l.replace('char* pszRealmName;', 'int32_t nSelectedLine = 0; char* pszRealmName;')), 'opas(nSelectedLine,+,1)');
    assert.match(shadow.sites[0].why!, /shadowed/);
    const stale = run(PLUS.map(l => l.replace('Save(pszRealmName);', 'Save(pszRealmName); Use(nSelectedLine);')), 'opas(nSelectedLine,+,1)');
    assert.match(stale.sites[0].why!, /read after/);
    const impure = run(PLUS.map(l => l.replace(/nSelectedLine \+ 1/g, 'nSelectedLine + Next()')), 'opas(nSelectedLine,+,1)');
    assert.match(impure.sites[0].why!, /0 adjacent/);
    const unsignedLiteral = run(PLUS.map(l => l.replace(/nSelectedLine \+ 1/g, 'nSelectedLine + 1U')), 'opas(nSelectedLine,+,1)');
    assert.match(unsignedLiteral.sites[0].why!, /0 adjacent/);
    const crossed = run(PLUS.map(l => l.replace('pszRealmName = Realm', 'Touch(); pszRealmName = Realm')), 'opas(nSelectedLine,+,1)');
    assert.match(crossed.sites[0].why!, /0 adjacent/);
    const siblingCall = run([
      'void dummy() {',
      '  int32_t v = Get();',
      '  if (v != -1) {',
      '    Use(Explode(), v + 1);',
      '    Use(v + 1);',
      '  }',
      '}',
    ], 'opas(v,+,1)');
    assert.match(siblingCall.sites[0].why!, /another effect/);
    const innerDeclaration = run([
      'void dummy() {',
      '  if (nSelectedLine != -1) {',
      '    int32_t nSelectedLine = GetSelectedLine();',
      '    SetCurGateway(nSelectedLine + 1);',
      '    Realm(nSelectedLine + 1);',
      '  }',
      '}',
    ], 'opas(nSelectedLine,+,1)');
    assert.match(innerDeclaration.sites[0].why!, /declared before its guard/);
    const conditionalUses = run([
      'void dummy(int c, int d) {',
      '  int32_t v = Get();',
      '  if (v != -1) {',
      '    if (c) Use(v + 1);',
      '    if (d) Use(v + 1);',
      '  }',
      '}',
    ], 'opas(v,+,1)');
    assert.match(conditionalUses.sites[0].why!, /not evaluated when their statements begin/);
  });
  it('refuses byte width, changed narrowing and an unproven guard', () => {
    const wide = run(BYTE.map(l => l.replace('uint8_t byMinGrp', 'uint16_t byMinGrp')), 'opas(byMinGrp,-,1)');
    assert.match(wide.sites[0].why!, /not an initialized uint8_t/);
    const cast = run(BYTE.map(l => l.replace(/\(uint8_t\)\(byMinGrp - 1\)/g, '(uint16_t)(byMinGrp - 1)')), 'opas(byMinGrp,-,1)');
    assert.match(cast.sites[0].why!, /0 adjacent/);
    const guard = run(BYTE.map(l => l.replace('if (byMinGrp && byMaxGrp && byMaxGrp >= byMinGrp)', 'if (byMaxGrp >= byMinGrp)')), 'opas(byMinGrp,-,1)');
    assert.match(guard.sites[0].why!, /nonzero guard/);
  });
  it('refuses a lone shift, reversed address call and extra control flow', () => {
    const lone = run(PAIR, 'opas(nX,>>,0xb)');
    assert.match(lone.sites[0].why!, /single opas/);
    const reverse = run(PAIR.map(l => l.replace('(&nX, &nY)', '(&nY, &nX)')), 'opas(nX,>>,0xb,nY,>>,0xb)');
    assert.match(reverse.sites[0].why!, /both addresses in order/);
    const branch = run(PAIR.map(l => l.replace('pDynamicPath->nTargetX', 'if (nX) return; pDynamicPath->nTargetX')), 'opas(nX,>>,0xb,nY,>>,0xb)');
    assert.match(branch.sites[0].why!, /one call and precede two stores/);
    const twoTargets = run(PAIR.map(l => l.replace('Path* pDynamicPath,', 'Path* pDynamicPath, Path* pOther,')
      .replace('pDynamicPath->nTargetY', 'pOther->nTargetY')), 'opas(nX,>>,0xb,nY,>>,0xb)');
    assert.match(twoTargets.sites[0].why!, /one pointer parameter/);
  });
});
