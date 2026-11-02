/**
 * A one- or two-byte local the original compares at four bytes against a constant was an
 * int (narrow-local-widen). PLRSKILLS_CheckSkillWhipAndLeap 004d8520 loads the skill row's
 * srvdofunc with `MOVSX EAX, word ptr [EAX+0x2e]` and compares `CMP EAX,0x43`; Ghidra's
 * two-byte `short sSrvDoFunc` compiles to MOVZX and `CMP AX,0x43`. The widening must keep
 * every value: the native check runs the narrow and the wide form over every short.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createCompareFormTransformer, type CompareFormDecision, type CompareFormOptions } from '../builtins/compare-form.js';
import { createNarrowLocalWidenTransformer } from '../builtins/narrow-local-widen.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

type Site = { text: string; fp: [string, string]; size?: number };
const dec = (d: Partial<CompareFormDecision> & { ord: number; text: string; fp: [string, string] }): CompareFormDecision =>
  ({ width: 4, address: '00401000', keep: true, ...d });

const TABLES = { structFields: { D2SkillsTxt: { srvdofunc: 'short', nFlags: 'uint8_t' } } };

function run(code: string, sites: Site[], decisions: CompareFormDecision[], opts: Record<string, unknown> = TABLES): string {
  const tagged = createCompareFormTransformer({ sites, decisions } as CompareFormOptions)(parse(code));
  return emit(createNarrowLocalWidenTransformer(opts)(tagged) as AnyNode).trim();
}

const WHIP = `void f(D2SkillsTxt *pSkillsTxt) {
  short sSrvDoFunc = pSkillsTxt->srvdofunc;
  if (sSrvDoFunc != 0x43) {
    if (sSrvDoFunc == 0x4c) {
      g(1);
    }
    return;
  }
  g(2);
}`;
const WHIP_SITES: Site[] = [{ text: '!=', fp: ['v:sSrvDoFunc', 'c:43'] }, { text: '==', fp: ['v:sSrvDoFunc', 'c:4c'] }];

describe('narrow-local-widen', () => {
  it('PLRSKILLS_CheckSkillWhipAndLeap: the short compared at four bytes is declared int32_t', () => {
    const out = run(WHIP, WHIP_SITES, WHIP_SITES.map((s, ord) => dec({ ord, ...s })));
    assert.match(out, /int32_t sSrvDoFunc = pSkillsTxt->srvdofunc;/);
  });

  it('keeps a local any tied compare makes at its own width', () => {
    const out = run(WHIP, WHIP_SITES, [dec({ ord: 0, ...WHIP_SITES[0] }), dec({ ord: 1, ...WHIP_SITES[1], width: 2 })]);
    assert.match(out, /short (int )?sSrvDoFunc/);
  });

  it('keeps a local compared only with another variable', () => {
    const code = 'void f(D2SkillsTxt *p, int n) { short s = p->srvdofunc; if (s != n) { g(1); } }';
    const sites: Site[] = [{ text: '!=', fp: ['v:s', 'v:n'] }];
    assert.match(run(code, sites, [dec({ ord: 0, ...sites[0] })]), /short (int )?s =/);
  });

  it('keeps a local that is modified in place or whose address is taken', () => {
    const sites: Site[] = [{ text: '!=', fp: ['v:s', 'c:43'] }];
    for (const use of ['s++;', '--s;', 's += 2;', 'h(&s);']) {
      const code = `void f(D2SkillsTxt *p) { short s = p->srvdofunc; ${use} if (s != 0x43) { g(1); } }`;
      assert.match(run(code, sites, [dec({ ord: 0, ...sites[0] })]), /short (int )?s =/, use);
    }
  });

  it('keeps a local assigned a value its type might not hold', () => {
    const sites: Site[] = [{ text: '==', fp: ['v:s', 'c:5'] }];
    for (const value of ['n', '0x12345', 'n & 0x1ffff']) {
      const code = `void f(int n) { short s; s = ${value}; if (s == 5) { g(1); } }`;
      assert.match(run(code, sites, [dec({ ord: 0, ...sites[0] })]), /short (int )?s;/, value);
    }
  });

  it('widens a byte assigned casts, masks and literals in range, against an enum constant', () => {
    const code = `void f(uint32_t n, D2SkillsTxt *p) {
  uint8_t by = (uint8_t)(n >> 8);
  if (by == UNIT_MONSTER) {
    by = p->nFlags & 0x1f;
  }
  if (by < 7) {
    by = 3;
  }
}`;
    const sites: Site[] = [{ text: '==', fp: ['v:by', 'c:1'] }, { text: '<', fp: ['v:by', 'c:7'] }];
    const out = run(code, sites, sites.map((s, ord) => dec({ ord, ...s })),
      { ...TABLES, enumConstantNames: ['UNIT_MONSTER'] });
    assert.match(out, /int32_t by = \(uint8_t\)\(n >> 8\);/);
  });

  it('leaves a static, a parameter and a shared declaration alone', () => {
    const sites: Site[] = [{ text: '!=', fp: ['v:s', 'c:43'] }];
    const statik = run('void f(D2SkillsTxt *p) { static short s; s = p->srvdofunc; if (s != 0x43) { g(1); } }', sites,
      [dec({ ord: 0, ...sites[0] })]);
    assert.match(statik, /static short (int )?s;/);
    const param = run('void f(short s) { if (s != 0x43) { g(1); } }', sites, [dec({ ord: 0, ...sites[0] })]);
    assert.match(param, /short (int )?s\)/);
    const shared = run('void f(D2SkillsTxt *p) { short s, t; s = p->srvdofunc; t = 1; if (s != 0x43) { g(t); } }', sites,
      [dec({ ord: 0, ...sites[0] })]);
    assert.match(shared, /short (int )?s, t;/);
  });

  it('computes what the narrow local computed, over every short', { skip: !hasNativeGpp() }, () => {
    const out = run(WHIP.replace('void f(D2SkillsTxt *pSkillsTxt)', 'int wide(D2SkillsTxt *pSkillsTxt)')
      .replace(/g\(1\);/, 'return 1;').replace(/g\(2\);/, 'return 2;').replace('return;', 'return 0;'),
      WHIP_SITES, WHIP_SITES.map((s, ord) => dec({ ord, ...s })));
    assert.match(out, /int32_t sSrvDoFunc/);
    const narrow = out.replace('int wide(', 'int narrow(').replace('int32_t sSrvDoFunc', 'short sSrvDoFunc');
    const res = compileAndRun(`struct D2SkillsTxt { short srvdofunc; };\n${out}\n${narrow}`,
      'int bad = 0; for (int v = -32768; v < 32768; v++) { D2SkillsTxt t; t.srvdofunc = (short)v; if (wide(&t) != narrow(&t)) bad++; } printf("%d\\n", bad);');
    assert.strictEqual(res.trim(), '0');
  });
});
