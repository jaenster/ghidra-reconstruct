/**
 * The proposal script renderer against what proposal_render.py rendered.
 *
 * fixtures/proposal-apply/*.java were written by the Python script (D2 workspace
 * docs/tools/ghidra-apply/proposal_render.py, before it was retired) from proposals.json: one
 * real proposal of every op kind it knew, plus one with non-ASCII, quotes, a backslash, a DEL and
 * an astral character. The port gave the same bytes; since then set_prototype keeps custom storage
 * by name on a pure reorder, the one place the goldens differ from the Python script's.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
    assert.ok(!plain.includes('op.equals("vc8form")') && !plain.includes('"vc8form"}') && !plain.includes('__EXT_'));
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

/**
 * The set_prototype branch as rendered, compiled with the stub Ghidra classes in
 * fixtures/proposal-apply/ghidra-stub and run: what updateFunction is given for each parameter.
 */
function runSetPrototype(signature: string, current: string[]): string[] {
  const t = renderProposalScript([{ id: 1, author: 'a', ops: [{ op: 'set_prototype', program: 'win', address: '0x00401000', signature }] }], { program: 'win', author: '*', dry: false }).text;
  const apply = t.indexOf('int sub = currentProgram.startTransaction');
  const start = t.indexOf('   else if (op.equals("set_prototype"))', apply);
  const block = t.slice(start, t.indexOf('\n   else ', start + 1));
  const stmt = (head: string, end: string) => { const i = t.indexOf(head); assert.ok(i > 0, head); return t.slice(i, t.indexOf(end, i) + end.length); };
  assert.ok(apply > 0 && start > apply && block.includes('updateFunction'), 'the apply-side set_prototype branch');
  const dir = mkdtempSync(join(tmpdir(), 'proposal-apply-'));
  try {
    cpSync(join(FIX, 'ghidra-stub'), dir, { recursive: true });
    const h = readFileSync(join(dir, 'Harness.java'), 'utf8')
      .replace('/*NCONV*/', stmt('java.util.function.Function<String, String> nconv =', ';\n'))
      .replace('/*PSIG*/', stmt('java.util.function.Function<String, java.util.List<String[]>> psig =', 'return r; };\n'))
      .replace('/*SET_PROTOTYPE*/', block.trimStart());
    writeFileSync(join(dir, 'Harness.java'), h);
    const files = ['Harness.java', ...['lang/Register', 'symbol/SourceType', 'data/DataType', 'data/VoidDataType', 'listing/Program', 'listing/VariableStorage', 'listing/Parameter', 'listing/ParameterImpl', 'listing/ReturnParameterImpl', 'listing/Function'].map((f) => `ghidra/program/model/${f}.java`)];
    execFileSync('javac', ['-nowarn', '-d', dir, ...files.map((f) => join(dir, f))], { cwd: dir, stdio: 'pipe' });
    return execFileSync('java', ['-cp', dir, 'Harness', signature, ...current], { encoding: 'utf8' }).trim().split('\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hasJdk = spawnSync('javac', ['-version']).status === 0;

describe('proposal-render: set_prototype on custom storage, run against stub Ghidra', { skip: !hasJdk && 'no javac on PATH' }, () => {
  const fn = ['Unit *:pUnit@ECX', 'int:nSkill@EDX'];

  it('a pure reorder keeps each parameter on its own register', () => {
    assert.deepStrictEqual(runSetPrototype('int SKILLS_Use(int nSkill, Unit * pUnit)', fn), [
      'update __fastcall CUSTOM_STORAGE ret int@EAX',
      'param int nSkill@EDX',
      'param Unit * pUnit@ECX',
    ]);
  });

  it('a rename keeps storage by position', () => {
    assert.deepStrictEqual(runSetPrototype('int SKILLS_Use(Unit * pOwner, int nSkill)', fn), [
      'update __fastcall CUSTOM_STORAGE ret int@EAX',
      'param Unit * pOwner@ECX',
      'param int nSkill@EDX',
    ]);
  });
});

/**
 * The vc8form stale check as rendered, run in fixtures/proposal-apply/VcHarness.java: the watched
 * functions are the tagged ones an op touches plus the tagged callers of a set_prototype target;
 * a watched function whose decompile the applied ops changed has every vc8form tag reported.
 */
function runVc8formCheck(changed: string[]): string[] {
  const t = renderProposalScript([{ id: 1, author: 'a', ops: [{ op: 'set_prototype', program: 'win', address: '0x00401000', signature: 'int Target(int nX, int nY)' }] }], { program: 'win', author: '*', dry: false }).text;
  const line = (head: string) => { const i = t.indexOf(head); assert.ok(i > 0, head); return t.slice(i, t.indexOf('\n', i) + 1); };
  const dir = mkdtempSync(join(tmpdir(), 'proposal-vc8form-'));
  try {
    const h = readFileSync(join(FIX, 'VcHarness.java'), 'utf8')
      .replace('/*WATCH*/', line('java.util.Set<String> vset =') + line('java.util.Map<String, String> vbefore ='))
      .replace('/*CHECK*/', line('if (!DRY) { int nStale = 0;'));
    writeFileSync(join(dir, 'VcHarness.java'), h);
    execFileSync('javac', ['-nowarn', '-d', dir, join(dir, 'VcHarness.java')], { cwd: dir, stdio: 'pipe' });
    return execFileSync('java', ['-cp', dir, 'VcHarness', ...changed], { encoding: 'utf8' }).trim().split('\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('proposal-render: vc8form tags whose decompile an applied op changed', { skip: !hasJdk && 'no javac on PATH' }, () => {
  it('reports every tag of a changed tagged function and of a changed tagged caller of a prototype target', () => {
    assert.deepStrictEqual(runVc8formCheck(['00401000', '00402000', '00403000', '00404000', '00406000', 'ws:00405000']), [
      'VC8FORM-STALE 00402000 TaggedEdited vc8form:fold(nListCount);ev=0123456789;bh=96-1a2b3c4d;dh=5e6f7a8b',
      'VC8FORM-STALE 00403000 Caller vc8form:seq(nY,nX);ev=0123456789;bh=40-00aa11bb;dh=0badf00d',
      'VC8FORM-STALE 00403000 Caller vc8form:width(b,int);ev=0123456789;bh=40-00aa11bb;dh=0badf00d',
      'VC8FORMCHECK functions-with-stale-dh=2 of 3: re-measure their dh in this batch (codegen with GHIDRA_VC8FORM_HASHES, then scripts/vc8form-rehash.ts or a measured tag)',
    ]);
  });

  it('reports nothing when no watched decompile changed', () => {
    assert.deepStrictEqual(runVc8formCheck(['00401000', '00406000']), ['VC8FORMCHECK functions-with-stale-dh=0 of 3']);
  });

  it('a dry run names the watched functions instead', () => {
    const t = renderProposalScript([{ id: 1, author: 'a', ops: [{ op: 'set_prototype', program: 'win', address: '0x00401000', signature: 'int Target(int nX)' }] }], { program: 'win', author: '*', dry: true }).text;
    assert.ok(t.includes('if (DRY) println("VC8FORM-WATCH " + a'));
    assert.ok(t.indexOf('java.util.Map<String, String> vbefore =') < t.indexOf('int sub = currentProgram.startTransaction'), 'the decompile is read before any op is applied');
  });
});
