/**
 * The proposal script renderer against what proposal_render.py rendered.
 *
 * fixtures/proposal-apply/*.java were written by the Python script (D2 workspace
 * docs/tools/ghidra-apply/proposal_render.py, before it was retired) from proposals.json: one
 * real proposal of every op kind it knew, plus one with non-ASCII, quotes, a backslash, a DEL and
 * an astral character. The port must give the same bytes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pyJsonDumps, readProposals, renderProposalScript, selectGroup, type RenderOptions } from '../proposal-apply/render.js';
import { PROPOSAL_APPLY_TEMPLATE } from '../proposal-apply/template.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'proposal-apply');
const rows = readProposals(join(FIX, 'proposals.json'));
const ch = (...codes: number[]) => String.fromCharCode(...codes);
/** The fixture's non-ASCII login, u-umlaut n i-umlaut. */
const LOGIN = `${ch(0xfc)}n${ch(0xef)}`;

const GOLDEN: Array<[string, RenderOptions]> = [
  ['win-all-dry.java', { program: 'win', author: '*', dry: true }],
  ['win-author.java', { program: 'win', author: LOGIN, dry: false }],
  ['mac-all-wet-tag.java', { program: 'mac', author: '*', dry: false, tag: 'applied-x' }],
  ['mac-part2.java', { program: 'mac', author: '*', dry: false, tag: 'community-proposal', chunk: [1, 2] }],
];

describe('proposal-render: the Python script\'s output, byte for byte', () => {
  for (const [file, opts] of GOLDEN) {
    it(file, () => {
      assert.strictEqual(renderProposalScript(rows, opts).text, readFileSync(join(FIX, file), 'utf8'));
    });
  }

  it('writes JSON as json.dumps does with ensure_ascii', () => {
    const s = `${ch(0xe9)}"\\\n\t${ch(0x7f, 0x01, 0xd83d, 0xde00)}`;
    assert.strictEqual(pyJsonDumps({ a: s, b: [1, -2, null, true], c: { d: 'x' } }),
      '{"a":"\\u00e9\\"\\\\\\n\\t\\u007f\\u0001\\ud83d\\ude00","b":[1,-2,null,true],"c":{"d":"x"}}');
  });

  it('selects by program, author (a login or {login}) and chunk', () => {
    const all = [
      { id: 1, author: 'ann', ops: [{ op: 'rename_function', program: 'win' }, { op: 'rename_function', program: 'mac' }] },
      { id: 2, author: { login: 'bob' }, ops: [{ op: 'rename_function', program: 'mac' }] },
      { id: 3, author: { login: 'ann' }, ops: [{ op: 'rename_function', program: 'win' }] },
    ];
    assert.deepStrictEqual(selectGroup(all, { program: 'win', author: '*', dry: true }).map((r) => r.id), [1, 3]);
    assert.deepStrictEqual(selectGroup(all, { program: 'mac', author: 'bob', dry: true }).map((r) => r.id), [2]);
    assert.deepStrictEqual(selectGroup(all, { program: 'win', author: 'ann', dry: true, chunk: [1, 1] }).map((r) => r.id), [3]);
    assert.deepStrictEqual(selectGroup(all, { program: 'win', author: '*', dry: true })[0].ops, [{ op: 'rename_function', program: 'win' }]);
  });

  it('never ends the Java text block: quotes in a value stay escaped', () => {
    const t = renderProposalScript([{ id: 1, author: 'a', ops: [{ op: 'rename_function', program: 'win', name: 'x"""y' }] }], { program: 'win', author: '*', dry: true }).text;
    assert.strictEqual(t.split('"""').length, 3);
    assert.ok(t.includes('"name":"x\\\\"\\\\"\\\\"y"'));
  });
});

describe('proposal-render: vc8form and linkage', () => {
  const ext = [
    { id: 7, author: 'ann', ops: [
      { op: 'vc8form', program: 'win', address: '0x004c54f0', expect: { tags: ['boolflag(bWeaponIsAmmo);ev=b081c3b042;bh=290-3af5fed2;dh=62ccd0ef'] }, tag: 'width(bWeaponIsAmmo,int);ev=0123456789;bh=290-3af5fed2;dh=62ccd0ef' },
      { op: 'linkage', program: 'win', address: '0x00460830', expect: { namespace: 'D2Client::Engine', tags: [] }, linkage: 'static;ev=0123456789;bh=96-1a2b3c4d;dh=5e6f7a8b', namespace: 'D2Client::UNIT::Player' },
    ] },
  ];

  it('adds their code only when the group holds one', () => {
    const plain = renderProposalScript(rows, { program: 'win', author: '*', dry: true }).text;
    assert.ok(!plain.includes('vc8form') && !plain.includes('__EXT_'));
    const t = renderProposalScript([...rows, ...ext], { program: 'win', author: '*', dry: false }).text;
    assert.ok(!t.includes('__EXT_'));
    assert.ok(t.includes('"rename_local", "delete_label", "linkage", "vc8form"};'));
    assert.ok(t.includes('else if (op.equals("vc8form")) { ghidra.program.model.listing.Function f = fnAt.apply(js.apply(o, "address")); java.util.Set<String> cur = tagsOf.apply(f, "vc8form");'));
    assert.ok(t.includes('f.addTag("vc8form:" + js.apply(o, "tag").trim());'));
    assert.ok(t.includes('f.setParentNamespace(nsAt.apply(js.apply(o, "namespace")));'));
    assert.ok(t.includes('"tag":"width(bWeaponIsAmmo,int);ev=0123456789;bh=290-3af5fed2;dh=62ccd0ef"'));
  });

  it('places each insert inside its chain', () => {
    const t = renderProposalScript(ext, { program: 'win', author: '*', dry: false }).text;
    const check = t.indexOf('// check every expect first');
    const apply = t.indexOf('int sub = currentProgram.startTransaction');
    const c = t.indexOf('else if (op.equals("vc8form"))', check);
    const a = t.indexOf('else if (op.equals("vc8form"))', apply);
    assert.ok(check > 0 && c > check && c < apply, 'the check sits in the expect loop');
    assert.ok(a > apply, 'the write sits in the transaction');
    assert.ok(t.indexOf('java.util.function.BiFunction<ghidra.program.model.listing.Function, String, java.util.Set<String>> tagsOf') < t.indexOf('String[] ORDER'));
  });

  it('has exactly the four markers, each once', () => {
    for (const m of ['__EXT_HELPERS__', '__EXT_ORDER__', '__EXT_CHECK__', '__EXT_APPLY__']) assert.strictEqual(PROPOSAL_APPLY_TEMPLATE.split(m).length, 2, m);
  });
});
