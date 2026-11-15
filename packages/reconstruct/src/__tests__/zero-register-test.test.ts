import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { ZERO_REGISTER_TEST_JAVA, EQUALITY_TEST_DELTA_JAVA } from '../extract/zero-register-test.js';
import { parseBranchLayout } from '../extract/branch-layout.js';

const available = spawnSync('javac', ['-version'], { encoding: 'utf8' }).status === 0
  && spawnSync('java', ['-version'], { encoding: 'utf8' }).status === 0;

test('native zero-register extraction: execute the production Java fragments through a Ghidra API adapter', { skip: !available }, () => {
  const parent = resolve(tmpdir()), dir = mkdtempSync(join(parent, 'zero-register-java-'));
  try {
    const adapt = (code: string) => code
      .replace(/ghidra\.program\.model\.listing\.Instruction/g, 'Instruction')
      .replace(/ghidra\.program\.model\.lang\.Register/g, 'Register')
      .replace(/ghidra\.program\.model\.symbol\.Reference/g, 'Reference')
      .replace(/ghidra\.program\.model\.lang\.OperandType/g, 'OperandType');
    const template = readFileSync(new URL('./fixtures/ZeroRegisterHarness.java', import.meta.url), 'utf8');
    const source = template.replace('/* ZERO_REGISTER_TEST_JAVA */', adapt(ZERO_REGISTER_TEST_JAVA))
      .replace('/* EQUALITY_TEST_DELTA_JAVA */', adapt(EQUALITY_TEST_DELTA_JAVA));
    writeFileSync(join(dir, 'ZeroRegisterHarness.java'), source);
    const compile = spawnSync('javac', ['--release', '17', '-d', dir, join(dir, 'ZeroRegisterHarness.java')], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync('java', ['-cp', dir, 'ZeroRegisterHarness'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const results = JSON.parse(run.stdout) as Record<string, string>;
    assert.ok(Object.keys(results).length >= 44);
    assert.equal(results['hireling-00493848'], '0');
    // Exercise the real wire parser too: a zero delta must remain present, rather than become absent.
    const wire = `00493840\t62\t\t19:a\t19:==,SUB,EAX,${results['hireling-00493848']},0,4,8`;
    assert.deepEqual(parseBranchLayout(wire).get('00493840')?.tests, [[19, {
      op: '==', mnemonic: 'SUB', reg: 'EAX', delta: 0, k: 0, size: 4, at: 8,
    }]]);
  } finally {
    const child = relative(parent, resolve(dir));
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child) && child.startsWith('zero-register-java-'));
    rmSync(dir, { recursive: true, force: true });
  }
});
