import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const tables: Vc8FormTables = {
  structFields: {
    Arg: { nFlags: 'int', nMissile: 'eMissilesId', pOwner: 'Unit *' },
    Pkt: { nHeader: 'uint8_t', nCycle: 'int32_t', nTicks: 'int32_t', bEclipse: 'uint8_t' },
    Tables: { nMissiles: 'int' },
  },
  structLayouts: {
    Arg: [{ name: 'nFlags', offset: 0, size: 4, type: 'int' }, { name: 'nMissile', offset: 4, size: 4, type: 'eMissilesId' }, { name: 'pOwner', offset: 8, size: 4, type: 'Unit *' }],
    Pkt: [{ name: 'nHeader', offset: 0, size: 1, type: 'uint8_t' }, { name: 'nCycle', offset: 1, size: 4, type: 'int32_t' },
      { name: 'nTicks', offset: 5, size: 4, type: 'int32_t' }, { name: 'bEclipse', offset: 9, size: 1, type: 'uint8_t' }],
  },
  globalTypes: { 'Data::gpTables': 'Tables *', gpArg: 'Arg *' },
};

function run(source: string, tag: string, t: Vc8FormTables = tables): { out: string; site: Vc8FormSite } {
  const form = parseVc8Form(tag);
  assert.ok(form, `parses ${tag}`);
  const sites: Vc8FormSite[] = [];
  const tu = applyVc8Forms(parse(source) as TranslationUnit, [{ form, tag }], s => sites.push(s), t);
  return { out: flat(emit(tu as AnyNode)), site: sites[0]! };
}

function refuses(source: string, tag: string, t: Vc8FormTables = tables): void {
  const { out, site } = run(source, tag, t);
  assert.strictEqual(site.applied, false, out);
  assert.strictEqual(out, flat(emit(parse(source) as AnyNode)));
}

// Live Win Ghidra 0059a100 Q11_SendDarknessPacket (Redivivus #503): CMP AL,1; JNZ, then
// the header stores, then MOV [EBP-0xb],AL just before the send.
const darkness = 'int f(Client *c) { Pkt s; s.bEclipse = GetAct(c); if (s.bEclipse == 1) { s.nHeader = 83; s.nCycle = 5; s.nTicks = 0; Send(c, &s); } return 0; }';
const tagDark = 'sinkvia(s.bEclipse,uint8_t,nActNo)';
// Live Win Ghidra 004e2530 ScatterDoubleMissile (Redivivus #536): the second missile id is
// range-checked in a register; the field is written only on the path that fires it.
const scatter = 'int f(Unit *u, Txt *t) { Arg a; memset(&a, 0, 12); a.pOwner = u; Fire(u, &a); a.nMissile = (eMissilesId)t->miss[2]; if ((int)a.nMissile >= 0 && (int)a.nMissile < Data::gpTables->nMissiles) { Fire(u, &a); } return 1; }';
const tagScatter = 'sinkvia(a.nMissile,eMissilesId,nMissileB)';

describe('vc8-form sinkvia', () => {
  it('parses a member, a type and a fresh name', () => {
    assert.deepStrictEqual(parseVc8Form(tagDark), { op: 'sinkvia', object: 's', field: 'bEclipse', type: 'uint8_t', temp: 'nActNo' });
    for (const tag of ['sinkvia(s.bEclipse,uint8_t)', 'sinkvia(p->f,int,n)', 'sinkvia(s.f,int,int)', 'sinkvia(s.f,int,n,@1)']) {
      assert.strictEqual(parseVc8Form(tag), undefined, tag);
    }
  });

  it('stores after the literal header stores, inside the guard', () => {
    const { out, site } = run(darkness, tagDark);
    assert.ok(site.applied, site.why);
    assert.strictEqual(out, 'int f(Client* c) { Pkt s; uint8_t nActNo = GetAct(c); if (nActNo == 1) { s.nHeader = 83; s.nCycle = 5; s.nTicks = 0; s.bEclipse = nActNo; Send(c, &s); } return 0; }');
  });

  it('stores first in the arm when it starts with a call, reading a typed global of another struct', () => {
    const { out, site } = run(scatter, tagScatter);
    assert.ok(site.applied, site.why);
    assert.match(out, /eMissilesId nMissileB = \(eMissilesId\)t->miss\[2\]; if \(\(int\)nMissileB >= 0 && \(int\)nMissileB < Data::gpTables->nMissiles\) \{ a\.nMissile = nMissileB; Fire\(u, &a\); \} return 1;/);
  });

  it('refuses a type other than the field\'s, or a bit-field or missing facts', () => {
    refuses(darkness, 'sinkvia(s.bEclipse,int,nActNo)');
    refuses(darkness, tagDark, { ...tables, structLayouts: { Pkt: [{ name: 'bEclipse', offset: 9, size: 1, type: 'uint8_t', bitSize: 1 }] } });
    refuses(darkness, tagDark, { ...tables, structFields: {} });
    refuses(darkness, tagDark, { ...tables, unionNames: ['Pkt'] });
  });

  it('refuses when S is read or a call follows the if', () => {
    refuses(darkness.replace('return 0;', 'Log(); return 0;'), tagDark);
    refuses(darkness.replace('return 0;', 'return s.bEclipse;'), tagDark);
  });

  it('refuses an else, a call or store in the condition, or another read of S', () => {
    refuses(darkness.replace('Send(c, &s); }', 'Send(c, &s); } else { Idle(); }'), tagDark);
    refuses(darkness.replace('s.bEclipse == 1', 's.bEclipse == Want()'), tagDark);
    refuses(darkness.replace('s.bEclipse == 1', 's.bEclipse == s.nHeader'), tagDark);
  });

  it('refuses an escaped S whose condition reads memory that may alias it', () => {
    refuses(scatter.replace('Data::gpTables->nMissiles', 'gpArg->nFlags'), tagScatter);
    refuses(scatter.replace('Data::gpTables->nMissiles', 't->count'), tagScatter);
    refuses(scatter.replace('Data::gpTables->nMissiles', '*pLimit'), tagScatter);
  });

  it('accepts an unescaped S whose condition reads through a parameter', () => {
    const { site } = run(darkness.replace('s.bEclipse == 1', 's.bEclipse == c->nAct'), tagDark);
    assert.ok(site.applied, site.why);
  });

  it('refuses a taken name or a jump', () => {
    refuses(darkness.replace('Pkt s;', 'Pkt s; int nActNo = 0;'), tagDark);
    refuses(darkness.replace('return 0;', 'L: return 0;'), tagDark);
  });
});
