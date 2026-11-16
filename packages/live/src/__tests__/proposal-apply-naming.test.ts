/**
 * The proposal ops a naming pass needs (redivivus issue #33): add_tag, add_comment, set_namespace,
 * funcdef_param and funcdef_return. Where they land in the rendered script, the hold on structural
 * proposals, and, when a Ghidra install is found (GHIDRA_INSTALL_DIR or ~/Applications/ghidra_*),
 * that the rendered script compiles against Ghidra the way execute_script wraps it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderProposalScript, selectGroup, type ProposalRow } from '../proposal-apply/render.js';
import { PROPOSAL_APPLY_TEMPLATE } from '../proposal-apply/template.js';
import { EXT_OPS, extensionParts } from '../proposal-apply/ext-ops.js';

const TAG = { op: 'add_tag', program: 'win', address: '0x00412240', expect: { tags: ['llm-named'] }, tag: 'blizzard-name:SMemDestroy' };
const COMMENT = { op: 'add_comment', program: 'win', address: '0x00412240', expect: { comment: '' }, text: '@blizzard SMemDestroy (SMEM.CPP)' };
const MOVE = { op: 'set_namespace', program: 'win', address: '0x00418a10', expect: { namespace: 'Storm::Source::SSComp' }, namespace: 'Storm::Source::SLog', reason: 'Its assert names SLOG.CPP.' };
const PARAM = { op: 'funcdef_param', program: 'win', typePath: '/Diablo2/Items/fpProperties', ordinal: 0, expect: { name: 'param_1', type: 'undefined4' }, name: 'nState', type: 'int' };
const RET = { op: 'funcdef_return', program: 'win', typePath: 'fpProperties', expect: { type: 'uint' }, type: 'BOOL' };
const RENAME = { op: 'rename_function', program: 'win', address: '0x00412240', expect: { name: 'HSHEAP' }, name: 'SMEM_DestroyHeap', evidence: 'Named after its leak-report tag; the 1997 source calls it SMemDestroy.' };

const naming: ProposalRow[] = [{ id: 11, author: 'ann', ops: [TAG, COMMENT, PARAM, RET, RENAME] }];
const structural: ProposalRow[] = [{ id: 12, author: 'ann', ops: [MOVE] }];

describe('proposal-render: tags, comments, files and funcdefs', () => {
  it('renders each op in the expect loop and in the transaction', () => {
    const t = renderProposalScript(naming, { program: 'win', author: '*', dry: false }).text;
    assert.ok(!t.includes('__EXT_'));
    const check = t.indexOf('// check every expect first');
    const apply = t.indexOf('int sub = currentProgram.startTransaction');
    for (const op of ['add_tag', 'add_comment', 'funcdef_param', 'funcdef_return', 'set_namespace']) {
      const c = t.indexOf(`else if (op.equals("${op}"))`, check);
      const a = t.indexOf(`else if (op.equals("${op}"))`, apply);
      assert.ok(c > check && c < apply, `${op}: check in the expect loop`);
      assert.ok(a > apply, `${op}: write in the transaction`);
    }
    assert.ok(t.includes(`"delete_label"${EXT_OPS.map((k) => `, "${k}"`).join('')}};`));
    assert.ok(t.includes('.addTag(js.apply(o, "tag").trim());'));
    assert.ok(t.includes('f.setComment(c); platePend.put(f.getEntryPoint().toString(), c);'));
    assert.ok(t.includes('fd.setArguments(next);'));
    assert.ok(t.includes('.setReturnType(type.apply(js.apply(o, "type")));'));
    // the rename over a chosen name needs nothing new: its evidence rides along in the JSON
    assert.ok(t.includes('"evidence":"Named after its leak-report tag; the 1997 source calls it SMemDestroy."'));
  });

  it('keeps an added comment past the plate restore only once its proposal commits', () => {
    const t = renderProposalScript(naming, { program: 'win', author: '*', dry: false }).text;
    const begin = t.indexOf('java.util.Set<com.google.gson.JsonObject> done = new java.util.HashSet<>(); platePend.clear();');
    const committed = t.indexOf('if (good) { plates.putAll(platePend); println("APPLIED "');
    const restore = t.indexOf('int restored = 0;');
    assert.ok(begin > 0 && committed > begin && restore > committed);
    assert.ok(t.indexOf('java.util.Map<String, String> platePend') < t.indexOf('java.util.Map<String, String> plates ='));
  });

  it('leaves the template alone when the group holds none of them', () => {
    const t = renderProposalScript([{ id: 1, author: 'a', ops: [{ op: 'rename_function', program: 'win', address: '0x00401000', expect: { name: 'FUN_00401000' }, name: 'X_Y' }] }], { program: 'win', author: '*', dry: true }).text;
    assert.ok(!t.includes('platePend') && !t.includes('__EXT_') && t.includes('new java.util.HashSet<>();\n') && t.includes('if (good) { println("APPLIED "'));
    for (const m of ['__EXT_BEGIN__', '__EXT_COMMITTED__']) assert.strictEqual(PROPOSAL_APPLY_TEMPLATE.split(m).length, 2, m);
    assert.deepStrictEqual(Object.keys(extensionParts([])).sort(), ['__EXT_APPLY__', '__EXT_BEGIN__', '__EXT_CHECK__', '__EXT_COMMITTED__', '__EXT_HELPERS__', '__EXT_ORDER__']);
  });

  it('holds a structural proposal back, whole, unless asked', () => {
    const both = [...naming, ...structural];
    const r = renderProposalScript(both, { program: 'win', author: '*', dry: false });
    assert.deepStrictEqual(r.held, [12]);
    assert.strictEqual(r.proposals, 1);
    assert.ok(!r.text.includes('"set_namespace","program"'));
    const s = renderProposalScript(both, { program: 'win', author: '*', dry: false, structural: true });
    assert.deepStrictEqual(s.held, []);
    assert.strictEqual(s.proposals, 2);
    assert.ok(s.text.includes('setParentNamespace(nsAt.apply(js.apply(o, "namespace")));'));
    assert.deepStrictEqual(selectGroup(both, { program: 'win', author: '*', dry: true }).map((x) => x.id), [11]);
  });
});

/** A Ghidra install to compile against, or undefined. */
function ghidraHome(): string | undefined {
  const env = process.env.GHIDRA_INSTALL_DIR;
  if (env && existsSync(join(env, 'Ghidra'))) return env;
  const apps = join(homedir(), 'Applications');
  if (!existsSync(apps)) return undefined;
  const found = readdirSync(apps).filter((d) => /^ghidra_\d/.test(d)).sort().reverse();
  return found.length ? join(apps, found[0]) : undefined;
}

function jars(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) jars(p, out); else if (p.endsWith('.jar')) out.push(p);
  }
  return out;
}

const home = ghidraHome();
const hasJdk = spawnSync('javac', ['-version']).status === 0;

describe('proposal-render: the script compiles against Ghidra', { skip: (!home || !hasJdk) && 'no Ghidra install or no javac' }, () => {
  it('with every new op, dry and wet', () => {
    const g = join(home!, 'Ghidra');
    const cp = [...jars(join(g, 'Framework')), ...jars(join(g, 'Features', 'Base', 'lib')), ...jars(join(g, 'Features', 'Decompiler', 'lib'))].join(':');
    const dir = mkdtempSync(join(tmpdir(), 'proposal-compile-'));
    try {
      for (const dry of [true, false]) {
        const body = renderProposalScript([...naming, ...structural], { program: 'win', author: '*', dry, structural: true }).text;
        const name = `ProposalScript${dry ? 'Dry' : 'Wet'}`;
        // execute_script's wrapper (ghidra-mcp AnalysisOps)
        const src = `import ghidra.app.script.GhidraScript;\nimport ghidra.program.model.address.*;\nimport ghidra.program.model.data.*;\nimport ghidra.program.model.listing.*;\nimport ghidra.program.model.mem.*;\nimport ghidra.program.model.pcode.*;\nimport ghidra.program.model.symbol.*;\nimport ghidra.program.model.scalar.*;\nimport ghidra.util.task.TaskMonitor;\nimport java.util.*;\npublic class ${name} extends GhidraScript {\n    @Override\n    protected void run() throws Exception {\n${body}\n    }\n}\n`;
        writeFileSync(join(dir, `${name}.java`), src);
        const r = spawnSync('javac', ['-nowarn', '-proc:none', '-cp', cp, '-d', dir, join(dir, `${name}.java`)], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
