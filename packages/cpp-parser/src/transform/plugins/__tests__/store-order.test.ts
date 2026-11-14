import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { storeOrderPlugin, type StoreOrderOptions } from '../builtins/store-order.js';
import type { AccessOrderEvidence, StoreFact } from '../builtins/access-order-evidence.js';

/** One statement per line; `[@at]` or `[@at/8h]` tags the line's store. */
function fixture(lines: string[]): { code: string; ev: AccessOrderEvidence } {
  const text: string[] = [];
  const stores = new Map<number, StoreFact[]>();
  lines.forEach((l, i) => {
    const m = l.match(/^\s*\[@(0x[0-9a-f]+|\?)(?:\/(\d+)([hl]))?\]\s?(.*)$/);
    if (!m) { text.push(l); return; }
    stores.set(i + 1, [{
      ord: 0, at: m[1] === '?' ? null : Number(m[1]), size: m[2] ? Number(m[2]) : 4, half: (m[3] as 'h' | 'l') ?? null,
    }]);
    text.push(m[4]);
  });
  return { code: text.join('\n'), ev: { args: new Map(), stores } };
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const PRELUDE = [
  'struct Node { int nId; Node *pPrev; Node *pNext; };',
  'struct Seed { unsigned int nLow; unsigned int nHigh; };',
  'struct Gfx { void *pDC6; int nFrame; int nDir; };',
].join('\n');

const TABLES: Partial<StoreOrderOptions> = {
  structFields: {
    Node: { nId: 'int', pPrev: 'Node *', pNext: 'Node *' },
    Seed: { nLow: 'unsigned int', nHigh: 'unsigned int' },
    Gfx: { pDC6: 'void *', nFrame: 'int', nDir: 'int' },
  },
  structLayouts: {
    Node: [{ name: 'nId', offset: 0, size: 4, type: 'int' }, { name: 'pPrev', offset: 4, size: 4, type: 'Node *' }, { name: 'pNext', offset: 8, size: 4, type: 'Node *' }],
    Seed: [{ name: 'nLow', offset: 0, size: 4, type: 'uint' }, { name: 'nHigh', offset: 4, size: 4, type: 'uint' }],
    Gfx: [{ name: 'pDC6', offset: 0, size: 4, type: 'void *' }, { name: 'nFrame', offset: 4, size: 4, type: 'int' }, { name: 'nDir', offset: 8, size: 4, type: 'int' }],
  },
  globalTypes: { gA: 'int', gB: 'int', gC: 'int' },
};

function run(lines: string[], opts: Partial<StoreOrderOptions> = {}): { out: string; sites: string[] } {
  const { code, ev } = fixture(lines);
  const sites: string[] = [];
  const t = storeOrderPlugin.createTransformer({
    accessOrder: ev, onSite: e => sites.push(`${e.kind}${e.count}`), ...TABLES, ...opts,
  } as StoreOrderOptions);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

describe('storeOrderPlugin', () => {
  // GLSUBTILE_RemoveNodeFromHead, 0050ef80: `mov [eax + 0xc], esi; mov [eax + 0x10], esi`.
  it('writes two fields of one object in the original order', () => {
    const { out, sites } = run([
      'Node *f(Node *p) {',
      '[@0x1e] p->pNext = 0;',
      '[@0x1b] p->pPrev = 0;',
      '  return p;',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['order2']);
    assert.ok(out.includes('p->pPrev = 0; p->pNext = 0;'), out);
  });

  it('leaves the same field written twice', () => {
    const { sites } = run([
      'void f(Node *p, Node *q) {',
      '[@0x1e] p->pNext = q;',
      '[@0x1b] p->pNext = 0;',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves stores through two pointers that may meet', () => {
    const { sites } = run([
      'void f(Node *p, Node *q) {',
      '[@0x1e] p->pNext = 0;',
      '[@0x1b] q->pPrev = 0;',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a store whose value the other overwrites', () => {
    const { sites } = run([
      'void f(Node *p) {',
      '[@0x1e] p->pNext = p->pPrev;',
      '[@0x1b] p->pPrev = 0;',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('reorders globals and local fields', () => {
    const { out } = run([
      'void f(int a, int b, int c) {',
      '  Gfx g;',
      '[@0x2b] gB = b;',
      '[@0x30] gC = c;',
      '[@0x25] gA = a;',
      '  Use(&g);',
      '}',
    ]);
    assert.ok(out.includes('gA = a; gB = b; gC = c;'), out);
  });

  // CLIENT_BossDeath_Andariel, 0046ba50: the fields of an argument block, its address passed on.
  it('orders the fields of a local whose address is taken', () => {
    const { out, sites } = run([
      'void f(void *pDC6, int nFrame) {',
      '  Gfx g;',
      '[@0x20] g.nFrame = nFrame;',
      '[@0x1a] g.pDC6 = pDC6;',
      '  Use(&g);',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['order2']);
    assert.ok(out.includes('g.pDC6 = pDC6; g.nFrame = nFrame;'), out);
  });

  // uncompress, 006c79c0: one loaded value among parameters keeps the store order.
  it('orders one loaded value among parameters before the address is taken', () => {
    const { out, sites } = run([
      'void f(Node *pNext, int *pLen) {',
      '  Node s;',
      '[@0x24] s.nId = *pLen;',
      '[@0x17] s.pNext = pNext;',
      '  Use(&s);',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['order2']);
    assert.ok(out.includes('s.pNext = pNext; s.nId = *pLen;'), out);
  });

  it('orders constant stores into a local before its address is taken', () => {
    const { out, sites } = run([
      'void f(Node *pMapStrc, int n) {',
      '  Node mapCoords;',
      '[@0x20] mapCoords.pPrev = 0;',
      '[@0x16] mapCoords.nId = n;',
      '  Use(&mapCoords);',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['order2']);
    assert.ok(out.includes('mapCoords.nId = n; mapCoords.pPrev = 0;'), out);
  });

  // NET_D2GS_CLIENT_Incoming0x0D_UNITCHANGE_XY, 0045ccc0: VC8 loads wX, then wY, and stores
  // msg.nItemId (from wY) before msg.nSkillId; the source that matches has nSkillId first.
  it('leaves loaded values stored into a local before its address is taken', () => {
    const { sites } = run([
      'void f(Node *pBytes) {',
      '  Node msg;',
      '[@0x1f] msg.nId = pBytes->nId;',
      '[@0x17] msg.pPrev = pBytes->pNext;',
      '  Use(&msg);',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  // AddAct124SecondaryBorder, 006752a0: `&pData->x` reads pData, it does not take its address,
  // so pData stays a plain local beside the fields of the escaped block.
  it('orders fields of an escaped local beside field addresses through a local pointer', () => {
    const { out, sites } = run([
      'void f(Node *pLevel, Node *pData) {',
      '  Gfx g;',
      '  Use(&g);',
      '[@0x26] g.nFrame = (int)&pData->pNext;',
      '[@0x35] g.nDir = (int)&pData->pPrev;',
      '[@0x32] g.pDC6 = pLevel;',
      '  Use(&g);',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['order3']);
    assert.ok(out.includes('g.nFrame = (int)&pData->pNext; g.pDC6 = pLevel; g.nDir = (int)&pData->pPrev;'), out);
  });

  it('leaves a field address read through the pointer field the other store writes', () => {
    const { sites } = run([
      'void f(Node *pLevel) {',
      '  Node n;',
      '  Use(&n);',
      '[@0x26] n.nId = (int)&n.pPrev->pNext;',
      '[@0x20] n.pPrev = pLevel;',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves fields of a local read beside a pointer once its address is out', () => {
    const { sites } = run([
      'void f(Node *pMapStrc) {',
      '  Node mapCoords;',
      '  Use(&mapCoords);',
      '[@0x20] mapCoords.pPrev = pMapStrc->pNext;',
      '[@0x16] mapCoords.nId = pMapStrc->nId;',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves them in a loop that takes the address later', () => {
    const { sites } = run([
      'void f(Node *pMapStrc, int n) {',
      '  Node mapCoords;',
      '  while (n) {',
      '[@0x20] mapCoords.pPrev = pMapStrc->pNext;',
      '[@0x16] mapCoords.nId = pMapStrc->nId;',
      '    Use(&mapCoords);',
      '  }',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves them in a function with a goto', () => {
    const { sites } = run([
      'void f(Node *pMapStrc, int n) {',
      '  Node mapCoords;',
      'again:',
      '[@0x20] mapCoords.pPrev = pMapStrc->pNext;',
      '[@0x16] mapCoords.nId = pMapStrc->nId;',
      '  Use(&mapCoords);',
      '  if (n) goto again;',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  // NET_D2GS_SERVER_Send_0x0C_UNITCHANGE, 0053b430: the packet id field shares its name with the
  // parameter, and `&aPacket.nPacketId` takes the address of the field, not of the parameter.
  it('does not take a member name under & for a variable of that name', () => {
    const { out, sites } = run([
      'void f(int nId, Node *pNext) {',
      '  Node aPacket;',
      '[@0x20] aPacket.pNext = pNext;',
      '[@0x1a] aPacket.nId = nId;',
      '  Use(&aPacket.nId);',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['order2']);
    assert.ok(out.includes('aPacket.nId = nId; aPacket.pNext = pNext;'), out);
  });

  it('leaves scalar locals where they are', () => {
    const { sites } = run([
      'int f(int a, int b) {',
      '  int x;',
      '  int y;',
      '[@0x20] x = a + 1;',
      '[@0x1a] y = b + 1;',
      '  return Use2(x, y);',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a global store beside one through a pointer', () => {
    const { sites } = run([
      'void f(Node *p, int a) {',
      '[@0x2b] p->nId = a;',
      '[@0x25] gA = a;',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a run with an unknown store', () => {
    const { sites } = run([
      'void f(int a, int b) {',
      '[@0x2b] gB = b;',
      '[@?] gA = a;',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a store whose value is a call', () => {
    const { sites } = run([
      'void f(int a) {',
      '[@0x2b] gB = Get();',
      '[@0x25] gA = a;',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  // RollRandomSeed, 0045c370: `mov [ecx + 4], edx; mov [ecx], eax`.
  it('writes an 8-byte copy high half first where the original did', () => {
    const { out, sites } = run([
      'unsigned int f(Seed *pSeed) {',
      '  Seed s;',
      '  s = Next(*pSeed);',
      '[@0x15/8h] *pSeed = s;',
      '  return s.nLow;',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['split2']);
    assert.ok(out.includes('pSeed->nHigh = s.nHigh; pSeed->nLow = s.nLow;'), out);
  });

  it('leaves an 8-byte copy written low half first', () => {
    const { sites } = run([
      'void f(Seed *pSeed, Seed s) {',
      '[@0x15/8l] *pSeed = s;',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('changes nothing without facts', () => {
    const { code } = fixture(['void f(Node *p) {', '[@0x1e] p->pNext = 0;', '[@0x1b] p->pPrev = 0;', '}']);
    const out = flat(emit(storeOrderPlugin.createTransformer({ ...TABLES })(parse(code)) as AnyNode));
    assert.ok(out.includes('p->pNext = 0; p->pPrev = 0;'), out);
  });

  it('stores what the original stored (compiled)', { skip: !hasNativeGpp() }, () => {
    const lines = [
      'unsigned int f(Seed *pSeed, Node *p, int a, int b) {',
      '  Seed s;',
      '  s.nLow = pSeed->nLow * 3u + 1u;',
      '  s.nHigh = pSeed->nHigh ^ 0x55u;',
      '[@0x15/8h] *pSeed = s;',
      '[@0x1e] p->pNext = p->pPrev;',
      '[@0x1b] p->nId = a;',
      '[@0x2b] gB = b;',
      '[@0x25] gA = a + b;',
      '  return s.nLow + (unsigned int)gA * 7u + (unsigned int)gB;',
      '}',
    ];
    const { code } = fixture(lines);
    const { out, sites } = run(lines);
    assert.deepStrictEqual(sites, ['split2', 'order4']);
    const prelude = [
      PRELUDE, 'int gA, gB, gC;',
      code.replace('unsigned int f(', 'unsigned int before('),
      out.replace('unsigned int f(', 'unsigned int after('),
    ].join('\n');
    const r = compileAndRun(prelude, [
      'for (int k = 0; k < 5; k++) {',
      '  Node n1 = {k, 0, 0}, n2 = {k, &n1, 0}; Seed s1 = {(unsigned)k, 9u}, s2 = s1;',
      '  unsigned int x = before(&s1, &n2, k, 2 * k); int a1 = gA, b1 = gB;',
      '  Node m2 = {k, &n1, 0};',
      '  unsigned int y = after(&s2, &m2, k, 2 * k);',
      '  printf("%u/%u/%u/%d/%d/%p/%d %u/%u/%u/%d/%d/%p/%d\\n", x, s1.nLow, s1.nHigh, a1, b1, (void*)n2.pNext, n2.nId, y, s2.nLow, s2.nHigh, gA, gB, (void*)m2.pNext, m2.nId);',
      '}',
    ].join('\n'));
    for (const row of r.trim().split('\n')) {
      const [a, b] = row.split(' ');
      assert.strictEqual(a, b, r);
    }
  });
});
