import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { switchChainPlugin, type SwitchChainOptions } from '../builtins/switch-chain.js';
import type { BranchLayoutEvidence, EqualityTest } from '../builtins/branch-layout/evidence.js';

/**
 * One statement per line; a line may open with `[offsets]` and `<MNEM REG delta k at>` per
 * equality token on it (`-` for no delta). VC8 lays this switch's bodies out in reverse
 * source order, so `[n]` is written in source order and stored as offset 0x200 - n: a lower
 * `[n]` is a case written earlier.
 */
function fixture(lines: string[]): { code: string; ev: BranchLayoutEvidence } {
  const text: string[] = [];
  const ev = { lines: new Map<number, number[]>(), ifs: new Map<number, number>(), tests: new Map<number, EqualityTest[]>() };
  lines.forEach((raw, i) => {
    let l = raw;
    const n = i + 1;
    const m = l.match(/^\s*\[([0-9a-fx, ]*)\]\s?/);
    if (m) {
      const offs = m[1].split(/[ ,]+/).filter(Boolean).map(n => 0x200 - Number(n));
      if (offs.length) ev.lines.set(n, offs);
      l = l.slice(m[0].length);
    }
    for (;;) {
      const t = l.match(/^<(\w+) (\w+) (-?\w+|-) (\w+) (\w+)>\s?/);
      if (!t) break;
      const list = ev.tests.get(n) ?? [];
      list.push({
        op: '==', mnemonic: t[1], reg: t[2],
        ...(t[3] !== '-' ? { delta: Number(t[3]) } : {}),
        k: Number(t[4]), size: 4, at: Number(t[5]),
      });
      ev.tests.set(n, list);
      l = l.slice(t[0].length);
    }
    text.push(l);
  });
  return { code: text.join('\n'), ev };
}

function flat(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function run(lines: string[], opts: Partial<SwitchChainOptions> = {}): { out: string; sites: string[] } {
  const { code, ev } = fixture(lines);
  const sites: string[] = [];
  const t = switchChainPlugin.createTransformer({
    branchLayout: ev,
    onSite: e => sites.push(e.why ? `${e.rule}:${e.why}` : e.rule),
    ...opts,
  });
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

describe('switchChainPlugin', () => {
  it('writes an else-if chain counted down by SUB as a switch', () => {
    const { out, sites } = run([
      'void f(int v) {',
      '<SUB EAX 1 1 0x10> if (v == 1) {',
      '[0x30] A();',
      '}',
      '<SUB EAX 3 4 0x15> else if (v == 4) {',
      '[0x40] B();',
      '}',
      'else {',
      '[0x50] C();',
      '}',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['switch']);
    assert.ok(out.includes('switch (v) { case 1: { A(); break; } case 4: { B(); break; } default: { C(); } }'), out);
  });

  it('takes consecutive leaving ifs and keeps what follows after the switch', () => {
    const { out, sites } = run([
      'int f(int v) {',
      '<SUB ECX 0 0 0x10> if (v == 0) {',
      '[0x40] return 0;',
      '}',
      '<SUB ECX 1 1 0x15> if (v == 1) {',
      '[0x50] return A();',
      '}',
      '<SUB ECX 1 2 0x1a> if (v == 2) {',
      '[0x20] B();',
      '}',
      '[0x60] return 3;',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['switch']);
    // Bodies in the original's order: case 2's code comes first.
    assert.ok(out.includes('switch (v) { case 2: { B(); break; } case 0: { return 0; } case 1: { return A(); } } return 3;'), out);
  });

  it('reads `!v` as case 0 and a DEC as a subtraction of one', () => {
    const { out } = run([
      'void f(int v) {',
      '<SUB EDX 0 0 0x10> if (!v) {',
      '[0x30] A();',
      '}',
      '<DEC EDX 1 1 0x14> else if (v == 1) {',
      '[0x40] B();',
      '}',
      '}',
    ]);
    assert.ok(out.includes('switch (v) { case 0: { A(); break; } case 1: { B(); break; } }'), out);
  });

  it('writes a single case the original subtracts and branches on', () => {
    const { out, sites } = run([
      'void f(int v) {',
      '<SUB EAX 6 6 0x10> if (v == 6) {',
      '[0x20] A();',
      '}',
      'else {',
      '[0x30] B();',
      '}',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['switch']);
    assert.ok(out.includes('switch (v) { case 6: { A(); break; } default: { B(); } }'), out);
  });

  it('leaves an if-chain the original compiles with CMP, the arm code between the compares', () => {
    const { out, sites } = run([
      'void f(int v) {',
      '<CMP EAX - 1 0x10> if (v == 1) {',
      '[0x30] A();',
      '}',
      '<CMP EAX - 4 0x25> else if (v == 4) {',
      '[0x40] B();',
      '}',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['left:compare']);
    assert.ok(!out.includes('switch'), out);
  });

  it('leaves a chain whose subtractions do not add up to the case values', () => {
    // The tail of a longer run: the test for 1 was made elsewhere.
    const { out, sites } = run([
      'void f(int v) {',
      '<SUB EAX 3 4 0x15> if (v == 4) {',
      '[0x30] A();',
      '}',
      '<SUB EAX 1 5 0x1a> else if (v == 5) {',
      '[0x40] B();',
      '}',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['left:sum']);
    assert.ok(!out.includes('switch'), out);
  });

  it('leaves a chain whose tests use two registers', () => {
    const { out } = run([
      'void f(int v) {',
      '<SUB EAX 1 1 0x10> if (v == 1) {',
      '[0x30] A();',
      '}',
      '<SUB ECX 1 2 0x15> else if (v == 2) {',
      '[0x40] B();',
      '}',
      '}',
    ]);
    assert.ok(!out.includes('switch'), out);
  });

  it('leaves a chain whose body breaks out of an enclosing loop', () => {
    const { out, sites } = run([
      'void f(int v) {',
      'while (g()) {',
      '<SUB ECX 0 0 0x10> if (v == 0) {',
      '[0x40] return;',
      '}',
      '<SUB ECX 1 1 0x15> if (v == 1) break;',
      '<SUB ECX 1 2 0x1a> if (v == 2) {',
      '[0x20] B();',
      '}',
      '}',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['left:break']);
    assert.ok(!out.includes('switch'), out);
  });

  it('does not join consecutive ifs when an earlier body falls through', () => {
    const { out, sites } = run([
      'void f(int v) {',
      '<SUB EAX 1 1 0x10> if (v == 1) {',
      '[0x30] v = 2;',
      '}',
      '<SUB EAX 1 2 0x15> if (v == 2) {',
      '[0x40] B();',
      '}',
      '}',
    ]);
    // After `v = 2` control reaches the second test again: not a switch.
    assert.ok(!out.includes('switch'), out);
    assert.deepStrictEqual(sites, ['left:fallthrough']);
  });

  it('takes `if (v != K) { leave }` as the last case, the rest of the block its arm', () => {
    const { out, sites } = run([
      'int f(int v) {',
      '<SUB EAX 0 0 0x10> if (!v) {',
      '[0x30] A();',
      '[0x34] return 1;',
      '}',
      '<SUB EAX 1 1 0x15> if (v != 1) {',
      '[0x50] return 0;',
      '}',
      '[0x40] B();',
      '[0x44] return 1;',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['switch']);
    assert.ok(out.includes('switch (v) { case 0: { A(); return 1; } case 1: { B(); return 1; } default: { return 0; } }'), out);
  });

  it('takes `if (v != K) X else Y` as K: Y, default: X', () => {
    const { out } = run([
      'void f(int v) {',
      '<SUB EAX 0 0 0x10> if (v == 0) {',
      '[0x30] A();',
      '}',
      '<SUB EAX 2 2 0x15> else if (v != 2) {',
      '[0x50] C();',
      '}',
      'else {',
      '[0x40] B();',
      '}',
      '}',
    ]);
    assert.ok(out.includes('switch (v) { case 0: { A(); break; } case 2: { B(); break; } default: { C(); } }'), out);
  });

  it('leaves a case-0 test whose run goes on in a test printed elsewhere', () => {
    // sub eax,0; je; sub eax,1; je: the second test is printed inside another statement.
    const { out, sites } = run([
      'int f(int v) {',
      '<SUB EAX 0 0 0x10> if (!v) {',
      '[0x30] return 1;',
      '}',
      '<SUB EAX 1 1 0x15> g(v == 1);',
      '[0x24] return 0;',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['left:partial']);
    assert.ok(!out.includes('switch'), out);
  });

  it('takes a guard whose arm falls through: the other values run it, then what follows', () => {
    const { out } = run([
      'void f(int v) {',
      '<SUB EAX 0 0 0x10> if (!v) {',
      '[0x30] return;',
      '}',
      '<SUB EAX 1 1 0x15> if (v != 1) {',
      '[0x1a] A();',
      '}',
      '[0x20] B();',
      '}',
    ]);
    assert.ok(out.includes('switch (v) { default: { A(); } case 1: { B(); break; } case 0: { return; } }'), out);
  });

  it('leaves a chain on a call result or with a non-constant label', () => {
    const a = run([
      'void f(int v) {',
      '<SUB EAX 1 1 0x10> if (g() == 1) {',
      '[0x30] A();',
      '}',
      '<SUB EAX 1 2 0x15> else if (g() == 2) {',
      '[0x40] B();',
      '}',
      '}',
    ]);
    assert.ok(!a.out.includes('switch'), a.out);
    const b = run([
      'void f(int v, int w) {',
      '<SUB EAX 1 1 0x10> if (v == w) {',
      '[0x30] A();',
      '}',
      '}',
    ]);
    assert.ok(!b.out.includes('switch'), b.out);
  });

  it('accepts an enumerator label only when it is one', () => {
    const lines = [
      'void f(int v) {',
      '<SUB EAX 2 2 0x10> if (v == MODE_TWO) {',
      '[0x30] A();',
      '}',
      '}',
    ];
    assert.ok(!run(lines).out.includes('switch'));
    assert.ok(run(lines, { enumConstants: ['MODE_TWO'] }).out.includes('switch (v) { case MODE_TWO: { A(); break; } }'));
  });

  it('leaves a chain under a relational test of the same variable', () => {
    const { out, sites } = run([
      'void f(int v) {',
      '[0x8] if (v < 10) {',
      '<SUB EAX 1 1 0x10> if (v == 1) {',
      '[0x30] A();',
      '}',
      '<SUB EAX 2 3 0x15> else if (v == 3) {',
      '[0x40] B();',
      '}',
      '}',
      '}',
    ]);
    assert.ok(sites.includes('left:split'), sites.join());
    assert.ok(!out.includes('switch'), out);
  });

  it('gives two values one case where both fall out to the same code', () => {
    // ERRORMANAGER_ServiceControlHandler (00406410): sub eax,1; je; sub eax,3; je; sub eax,1; jne.
    const { out, sites } = run([
      'void f(int v) {',
      '<SUB EAX 1 1 0x6> if (v != 1) {',
      '<SUB EAX 3 4 0xb> if (v == 4) {',
      '[0x40] A();',
      '[0x44] return;',
      '}',
      '<SUB EAX 1 5 0x10> if (v != 5) {',
      '[0x50] return;',
      '}',
      '}',
      '[0x20] B();',
      '[0x24] C();',
      '}',
    ]);
    // The inner block alone is part of the run and is left; the whole decision is taken.
    assert.deepStrictEqual(sites, ['left:partial', 'switch']);
    assert.ok(out.includes('switch (v) { case 1: case 5: { B(); C(); break; } case 4: { A(); return; } default: { return; } }'), out);
  });

  it('writes cases that run into each other where each falls into the next', () => {
    // BITBUF_AndBuffers (00410b90): the bytes left over, 3, 2 then 1, copied by falling through.
    const { out, sites } = run([
      'void f(int v) {',
      '<SUB ECX 1 1 0x74> if (v != 1) {',
      '<SUB ECX 1 2 0x79> if (v != 2) {',
      '<SUB ECX 1 3 0x7e> if (v != 3) {',
      '[0x83] return;',
      '}',
      '[0x80] C();',
      '}',
      '[0x90] B();',
      '}',
      '[0xa0] A();',
      '}',
    ]);
    assert.ok(out.includes('switch (v) { case 3: { C(); } case 2: { B(); } case 1: { A(); break; } default: { return; } }'), out + sites.join());
  });

  it('leaves two cases running into one', () => {
    const { out, sites } = run([
      'void f(int v) {',
      '<SUB ECX 1 1 0x10> if (v == 1) {',
      '[0x20] A();',
      '}',
      '<SUB ECX 1 2 0x15> else if (v == 2) {',
      '[0x30] B();',
      '}',
      'else {',
      '[0x40] return;',
      '}',
      '[0x50] C();',
      '}',
    ]);
    // Both cases fall out to C(); C stays after the switch and each case breaks.
    assert.ok(sites.includes('switch'), sites.join());
    assert.ok(out.includes('switch (v) { case 1: { A(); break; } case 2: { B(); break; } default: { return; } } C();'), out);
  });

  it('leaves a fragment of a run when the rest is tested outside it', () => {
    const { out, sites } = run([
      'void f(int v) {',
      '[0x4] g();',
      '{',
      '<SUB EAX 3 4 0xb> if (v == 4) {',
      '[0x40] return;',
      '}',
      '}',
      '<SUB EAX 1 1 0x6> h(v != 1);',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['left:partial']);
    assert.ok(!out.includes('switch'), out);
  });

  it('reads source order off the reverse layout (BuildKurast, 0067f190, matching)', () => {
    // sub eax,0x4f; je +0x28; sub eax,1; je +0x21; sub eax,1; jne; +0x1a: the bodies of
    // 0x51, 0x50, 0x4f in rising addresses; the source wrote 0x4f, 0x50, 0x51.
    const code = [
      'void f(int v) {',
      'if (v == 0x4f) {',
      'A();',
      '}',
      'else if (v == 0x50) {',
      'B();',
      '}',
      'else if (v == 0x51) {',
      'C();',
      '}',
      '}',
    ].join('\n');
    const t = (k: number, at: number, delta: number): EqualityTest => ({ op: '==', mnemonic: 'SUB', reg: 'EAX', delta, k, size: 4, at });
    const ev: BranchLayoutEvidence = {
      lines: new Map([[3, [0x28]], [6, [0x21]], [9, [0x1a]]]),
      ifs: new Map(),
      tests: new Map([[2, [t(0x4f, 0xa, 0x4f)]], [5, [t(0x50, 0x10, 1)]], [8, [t(0x51, 0x15, 1)]]]),
    };
    const out = flat(emit(switchChainPlugin.createTransformer({ branchLayout: ev })(parse(code)) as AnyNode));
    assert.ok(out.includes('switch (v) { case 0x4f: { A(); break; } case 0x50: { B(); break; } case 0x51: { C(); break; } }'), out);
  });

  it('leaves a pointer operand (a merged local typed as a pointer)', () => {
    // SUnitInactive: `D2ObjectsTxt* pObjTxtLine` also holds eUnitType; a switch on it is ill-formed.
    const { out, sites } = run([
      'void f(int n) {',
      'D2ObjectsTxt* p;',
      '<SUB EAX 0 0 0x10> if (p == 0) {',
      '[0x30] A();',
      '}',
      '<SUB EAX 2 2 0x15> else if (p == 2) {',
      '[0x40] B();',
      '}',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['left:type']);
    assert.ok(!out.includes('switch'), out);
  });

  it('takes typedef and enum operands, leaves floats and unknown types', () => {
    const lines = (decl: string, v: string) => [
      'void f() {',
      decl,
      `<SUB EAX 1 1 0x10> if (${v} == 1) {`,
      '[0x30] A();',
      '}',
      '}',
    ];
    assert.ok(run(lines('MyCount c;', 'c'), { typedefTargets: { MyCount: 'unsigned int' } }).out.includes('switch (c)'));
    assert.ok(run(lines('eD2UnitType t;', 't'), { enumTypes: ['eD2UnitType'] }).out.includes('switch (t)'));
    assert.ok(run(lines('uint32_t u;', 'u')).out.includes('switch (u)'));
    assert.ok(!run(lines('float x;', 'x')).out.includes('switch'));
    assert.ok(!run(lines('Opaque o;', 'o')).out.includes('switch'));
    assert.ok(!run(lines('int a;', 'g')).out.includes('switch'));
    assert.ok(run(lines('int a;', 'g'), { varTypes: { g: 'int' } }).out.includes('switch (g)'));
    assert.ok(run(lines('int a;', 'q->n'), { fieldTypes: { n: 'BYTE' } }).out.includes('switch (q->n)'));
    assert.ok(!run(lines('int a;', 'q->m')).out.includes('switch'));
  });

  it('takes a short local in every spelling the parser prints (AITHINK_Fn1_ClawViper 005f1b60)', () => {
    // `if (nStateType) { if (nStateType != 2) <blue> else <red> }` over `SUB EAX,0; SUB EAX,2`.
    const lines = (decl: string) => [
      'void f() {',
      decl,
      '<SUB EAX 0 0 0x10> if (nStateType != 0) {',
      '<SUB EAX 2 2 0x15> if (nStateType != 2) {',
      '[0x30] A();',
      '}',
      'else {',
      '[0x20] B();',
      '}',
      '}',
      '}',
    ];
    for (const decl of ['short nStateType;', 'short int nStateType;', 'unsigned short nStateType;', 'long nStateType;', 'signed int nStateType;']) {
      const { out, sites } = run(lines(decl));
      assert.ok(out.includes('switch (nStateType)'), `${decl}: ${out}`);
      assert.ok(!sites.includes('left:type'), `${decl}: ${sites}`);
    }
    assert.ok(run(lines('float nStateType;')).sites.includes('left:type'));
  });

  it("types a field by its aggregate's own declaration, and a namespaced global by its name", () => {
    const lines = (decl: string, v: string) => [
      'void f() {',
      decl,
      `<SUB EAX 1 1 0x10> if (${v} == 1) {`,
      '[0x30] A();',
      '}',
      '}',
    ];
    // GetDirection 00620100: eUnitType is declared with different types in different
    // aggregates, so the field name alone does not say; the unit struct's own field does.
    const structFields = { D2UnitStrc: { eUnitType: 'D2C_UnitTypes' }, Other: { eUnitType: 'float' } };
    const enumTypes = ['D2C_UnitTypes'];
    assert.ok(run(lines('D2UnitStrc* p;', 'p->eUnitType'), { structFields, enumTypes }).out.includes('switch (p->eUnitType)'));
    assert.ok(run(lines('struct D2UnitStrc u;', 'u.eUnitType'), { structFields, enumTypes }).out.includes('switch (u.eUnitType)'));
    assert.ok(!run(lines('Other* o;', 'o->eUnitType'), { structFields, enumTypes }).out.includes('switch'));
    assert.ok(!run(lines('D2UnitStrc** pp;', '(*pp)->eUnitType'), { structFields, enumTypes }).out.includes('switch'));
    assert.ok(!run(lines('D2UnitStrc u;', 'u->eUnitType'), { structFields, enumTypes }).out.includes('switch'));
    // AUTOMAP_SetupPosition 00457520: MiniMapType is spelled with its namespace.
    assert.ok(run(lines('int a;', 'D2Client::UI::Automap::MiniMapType'), { varTypes: { MiniMapType: 'uint32_t' } }).out.includes('switch (D2Client::UI::Automap::MiniMapType)'));
    assert.ok(!run(lines('int a;', 'D2Client::UI::Automap::MiniMapType')).out.includes('switch'));
  });

  it('takes `v != A && v != B` as one test: the two constants share a case', () => {
    // ITEMMODE_IsSkillUsableCheck (0055c4d0, matching as the switch): sub eax,2; je; sub eax,5; je.
    const { out, sites } = run([
      'int f(int v) {',
      '<SUB EAX 2 2 0x10> <SUB EAX 5 7 0x15> if (v != 2 && v != 7) {',
      '[0x40] return 1;',
      '}',
      '[0x30] return 0;',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['switch']);
    assert.ok(out.includes('switch (v) { case 2: case 7: { return 0; } default: { return 1; } }'), out);
  });

  it('takes `v == A || v == B || v == C` as one case of three constants', () => {
    const { out, sites } = run([
      'void f(int v) {',
      '<SUB EAX 1 1 0x10> <SUB EAX 3 4 0x15> <SUB EAX 2 6 0x1a> if (v == 1 || (v == 4 || v == 6)) {',
      '[0x30] A();',
      '}',
      'else {',
      '[0x40] B();',
      '}',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['switch']);
    assert.ok(out.includes('switch (v) { case 1: case 4: case 6: { A(); break; } default: { B(); } }'), out);
  });

  it('joins a chained test with single tests on the same countdown', () => {
    const { out, sites } = run([
      'void f(int v) {',
      '<SUB EAX 0 0 0x10> if (!v) {',
      '[0x30] return;',
      '}',
      '<SUB EAX 2 2 0x15> <SUB EAX 1 3 0x1a> if (v == 2 || v == 3) {',
      '[0x40] A();',
      '}',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['switch']);
    assert.ok(out.includes('switch (v) { case 0: { return; } case 2: case 3: { A(); break; } }'), out);
  });

  it('leaves a chain of mixed senses, two variables or a repeated constant', () => {
    const mixed = run([
      'void f(int v) {',
      '<SUB EAX 2 2 0x10> <SUB EAX 5 7 0x15> if (v != 2 || v == 7) {',
      '[0x30] A();',
      '}',
      '}',
    ]);
    assert.ok(!mixed.out.includes('switch'), mixed.out);
    const andEq = run([
      'void f(int v) {',
      '<SUB EAX 2 2 0x10> <SUB EAX 5 7 0x15> if (v == 2 && v == 7) {',
      '[0x30] A();',
      '}',
      '}',
    ]);
    assert.ok(!andEq.out.includes('switch'), andEq.out);
    const two = run([
      'void f(int v, int w) {',
      '<SUB EAX 2 2 0x10> <SUB EAX 5 7 0x15> if (v == 2 || w == 7) {',
      '[0x30] A();',
      '}',
      '}',
    ]);
    assert.ok(!two.out.includes('switch'), two.out);
    const again = run([
      'void f(int v) {',
      '<SUB EAX 2 2 0x10> <SUB EAX 0 2 0x15> if (v == 2 || v == 2) {',
      '[0x30] A();',
      '}',
      '}',
    ]);
    assert.ok(!again.out.includes('switch'), again.out);
  });

  it('leaves a chained test the original compiles with CMP, or with a token missing', () => {
    const cmp = run([
      'void f(int v) {',
      '<CMP EAX - 2 0x10> <CMP EAX - 7 0x15> if (v == 2 || v == 7) {',
      '[0x30] A();',
      '}',
      '}',
    ]);
    // One if: a compare run of one decision is `||`, not a switch.
    assert.deepStrictEqual(cmp.sites, ['left:sum']);
    assert.ok(!cmp.out.includes('switch'), cmp.out);
    const short = run([
      'void f(int v) {',
      '<SUB EAX 2 2 0x10> if (v == 2 || v == 7) {',
      '[0x30] A();',
      '}',
      '}',
    ]);
    assert.ok(!short.out.includes('switch'), short.out);
    const wrong = run([
      'void f(int v) {',
      '<SUB EAX 2 2 0x10> <SUB EAX 5 7 0x15> if (v == 2 || v == 8) {',
      '[0x30] A();',
      '}',
      '}',
    ]);
    assert.ok(!wrong.out.includes('switch'), wrong.out);
  });

  it('leaves a chained operand that is not a plain read', () => {
    const { out } = run([
      'void f(int v) {',
      '<SUB EAX 2 2 0x10> <SUB EAX 5 7 0x15> if (g() == 2 || g() == 7) {',
      '[0x30] A();',
      '}',
      '}',
    ]);
    assert.ok(!out.includes('switch'), out);
  });

  it('counts a SUB of a register by the constant it reaches, with stores scheduled between', () => {
    // UNITMODE_SendWalkToPosition 00480ef0: `sub eax, 0`, three moves, `je`, `sub eax, ebx` (EBX = 1).
    const lines = [
      'void f(int v) {',
      '<SUB EAX 0 0 0x10> if (v != 0) {',
      '<SUB EAX - 1 0x20> if (v == 1) {',
      '[0x30] A();',
      '}',
      '}',
      'else {',
      '[0x20] B();',
      '}',
      '}',
    ];
    const { out, sites } = run(lines);
    // The inner test alone is part of a run: left, then taken with the outer one.
    assert.deepStrictEqual(sites, ['left:partial', 'switch']);
    assert.ok(out.includes('switch (v) { case 0:'), out);
    assert.ok(out.includes('case 1:'), out);
  });

  it('leaves a SUB of a register that starts a run, or one too far from the last', () => {
    assert.deepStrictEqual(run([
      'void f(int v) {',
      '<SUB EAX - 1 0x10> if (v == 1) {',
      '[0x30] A();',
      '}',
      '}',
    ]).sites, ['left:compare']);
    assert.ok(!run([
      'void f(int v) {',
      '<SUB EAX 0 0 0x10> if (v != 0) {',
      '<SUB EAX - 1 0x40> if (v == 1) {',
      '[0x30] A();',
      '}',
      '}',
      'else {',
      '[0x20] B();',
      '}',
      '}',
    ]).sites.includes('switch'));
  });

  it('writes ifs tested by one straight compare run as a switch', () => {
    // Skills_CltDoFunc_Mon_BaalTaunt_AnimCycle 004e2630: cmp 6; je; cmp 0x16; je; cmp 0x1e; jne.
    const lines = [
      'int f(int v) {',
      '<CMP ECX - 6 23> if (v != 6) {',
      '<CMP ECX - 22 28> if (v == 22) {',
      '[0x30] A();',
      'return 1;',
      '}',
      '<CMP ECX - 30 33> if (v == 30) {',
      '[0x20] B();',
      'return 1;',
      '}',
      '}',
      'else {',
      '[0x10] C();',
      '}',
      'return 1;',
      '}',
    ];
    const { out, sites } = run(lines);
    assert.deepStrictEqual(sites, ['left:partial', 'switch']);
    assert.ok(out.includes('switch (v)'), out);
    assert.ok(out.includes('case 6:') && out.includes('case 22:') && out.includes('case 30:'), out);
  });

  it('leaves compares with code between them, and a compare run of one if', () => {
    const spread = run([
      'void f(int v) {',
      '<CMP ECX - 6 0x10> if (v == 6) {',
      '[0x30] A();',
      '}',
      '<CMP ECX - 22 0x40> else if (v == 22) {',
      '[0x40] B();',
      '}',
      '}',
    ]);
    assert.ok(!spread.sites.includes('switch'), spread.out);
    const one = run([
      'void f(int v) {',
      '<CMP ECX - 6 0x10> <CMP ECX - 22 0x15> if (v == 6 || v == 22) {',
      '[0x30] A();',
      '}',
      '}',
    ]);
    assert.ok(!one.sites.includes('switch'), one.out);
  });

  it('changes nothing without evidence', () => {
    const { code } = fixture([
      'void f(int v) {',
      'if (v == 1) {',
      'A();',
      '}',
      '}',
    ]);
    const t = switchChainPlugin.createTransformer({});
    assert.ok(!flat(emit(t(parse(code)) as AnyNode)).includes('switch'));
  });

  it('is idempotent', () => {
    const { code, ev } = fixture([
      'void f(int v) {',
      '<SUB EAX 1 1 0x10> if (v == 1) {',
      '[0x30] A();',
      '}',
      '<SUB EAX 3 4 0x15> else if (v == 4) {',
      '[0x40] B();',
      '}',
      '}',
    ]);
    const t = switchChainPlugin.createTransformer({ branchLayout: ev });
    const once = t(parse(code));
    assert.strictEqual(flat(emit(t(once) as AnyNode)), flat(emit(once as AnyNode)));
  });
});
