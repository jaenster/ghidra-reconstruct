/**
 * The generator fingerprint covers every input the generator reads besides the
 * model and the foreign sources: its compiled code, the override bodies it ships,
 * project.json with the override sources it names, and the output switches in the
 * environment. Before, only the compiled code counted: a changed override body or
 * project.json reused every unit emitted under the old one.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generatorFingerprint, checkBuild } from '../build-fingerprint.js';

function layout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-inputs-'));
  const repo = path.join(root, 'repo');
  const project = path.join(repo, 'project');
  fs.mkdirSync(path.join(repo, 'packages', 'reconstruct', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'packages', 'reconstruct', 'dist', 'index.js'), 'export {};\n');
  fs.mkdirSync(path.join(repo, 'overrides'));
  fs.writeFileSync(path.join(repo, 'overrides', 'registry.json'), '{"overrides":[]}\n');
  fs.writeFileSync(path.join(repo, 'overrides', 'GuardStack.cpp'), 'return 0;\n');
  fs.writeFileSync(path.join(repo, 'overrides', 'SSignatureGenerate.cpp'), 'return 1;\n');
  fs.mkdirSync(project);
  const config = { modules: [{ name: 'D2Common' }], overrides: [{ address: '0x401000', sourceFile: '../overrides/SSignatureGenerate.cpp' }] };
  fs.writeFileSync(path.join(project, 'project.json'), JSON.stringify(config));
  return { repo, project, fp: (env: NodeJS.ProcessEnv = {}) => generatorFingerprint(repo, project, env) };
}

test('a changed built-in override body is a new generator', async () => {
  const { repo, fp } = layout();
  const before = await fp();
  fs.writeFileSync(path.join(repo, 'overrides', 'GuardStack.cpp'), 'return 2;\n');
  assert.notEqual(await fp(), before);
  assert.equal(checkBuild(before, await fp()).reusable, false);
});

test('an edit to project.json is a new generator', async () => {
  const { project, fp } = layout();
  const before = await fp();
  const file = path.join(project, 'project.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf-8'));
  config.modules.push({ name: 'D2Game' });
  fs.writeFileSync(file, JSON.stringify(config));
  assert.notEqual(await fp(), before);
});

test('an override source project.json names counts by content', async () => {
  const { repo, fp } = layout();
  const before = await fp();
  fs.writeFileSync(path.join(repo, 'overrides', 'SSignatureGenerate.cpp'), 'return 3;\n');
  assert.notEqual(await fp(), before);
});

test('an output switch in the environment is part of the generator', async () => {
  const { fp } = layout();
  assert.notEqual(await fp({ RECON_ARTIFACT_LOWERING: 'strict' }), await fp({}));
  assert.notEqual(await fp({ GHIDRA_BRANCH_LAYOUT_SEARCH: '0' }), await fp({}));
  // A switch that only writes a report changes nothing.
  assert.equal(await fp({ GHIDRA_BRANCH_LAYOUT_SCORE: '/tmp/x' }), await fp({}));
});

test('files the generator writes or never reads change nothing', async () => {
  const { project, repo, fp } = layout();
  const before = await fp();
  fs.writeFileSync(path.join(project, 'parser-errors.log'), '# Parse errors\nsomething\n');
  fs.mkdirSync(path.join(project, '.ghidra-mcp'));
  fs.writeFileSync(path.join(project, '.ghidra-mcp', 'buildinfo.json'), '{}');
  fs.writeFileSync(path.join(repo, 'README.md'), 'docs\n');
  assert.equal(await fp(), before);
});
