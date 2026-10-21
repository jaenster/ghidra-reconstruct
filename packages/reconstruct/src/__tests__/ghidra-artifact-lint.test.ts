/**
 * The ghidra-artifact check: one positive per rule, one negative per row of the design's
 * "not artifacts" table, and the counted gate - over the allowlist fails, at it passes, and
 * the check never reaches the content-keyed baseline.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactGate, ghidraArtifact, parseSource, runChecks, treeFromFiles, type Finding,
} from '../lint/index.js';
import { main } from '../lint/cli.js';

function lint(files: Record<string, string>): Finding[] {
  const parsed = Object.entries(files).map(([p, src]) => parseSource(p, src));
  for (const f of parsed) assert.deepStrictEqual(f.parseErrors, [], `${f.path} did not parse`);
  const r = runChecks(treeFromFiles('/nonexistent', parsed), null, [ghidraArtifact]);
  assert.deepStrictEqual(r.errors, []);
  return r.findings;
}

const rules = (fs: Finding[]) => fs.map(f => `${f.subject}:${f.detail}`).sort();
const body = (s: string) => ({ 'a.cpp': `namespace D2Game {\nint f(int a, int* p) {\n${s}\n}\n}\n` });

describe('ghidra-artifact: each rule', () => {
  it('pseudo-op-call: sized and named pseudo-ops, builtin_*, cpuid_*, also namespace-qualified', () => {
    const fs = lint(body(
      'x = SUB41(a, 0) + CONCAT31(a, 1) + SBORROW4(a, 1) + CARRY4(a, a) + SCARRY2(a, a);\n' +
      'y = ZEXT48(a) + SEXT14(a) + ROUND(1.5) + ABS(a) + rdtsc();\n' +
      'builtin_strncpy(p, "ab", 2); cpuid_basic_info(0); LOCK(); UNLOCK(); swi(3); halt_baddata();\n' +
      'z = ns::SUB84(a, 4);\nreturn 0;'));
    assert.deepStrictEqual(rules(fs), [
      'pseudo-op-call:ABS', 'pseudo-op-call:CARRY4', 'pseudo-op-call:CONCAT31', 'pseudo-op-call:LOCK',
      'pseudo-op-call:ROUND', 'pseudo-op-call:SBORROW4', 'pseudo-op-call:SCARRY2', 'pseudo-op-call:SEXT14',
      'pseudo-op-call:SUB41', 'pseudo-op-call:SUB84', 'pseudo-op-call:UNLOCK', 'pseudo-op-call:ZEXT48',
      'pseudo-op-call:builtin_strncpy', 'pseudo-op-call:cpuid_basic_info', 'pseudo-op-call:halt_baddata',
      'pseudo-op-call:rdtsc', 'pseudo-op-call:swi',
    ]);
    assert.ok(fs.every(f => f.fn === 'D2Game::f' && f.file === 'a.cpp' && f.line! > 0));
  });

  it('pseudo-op-call: a name the tree really declares is a function, not notation', () => {
    const fs = lint({
      'r.h': 'int ROUND(double x);\nnamespace Util { int SUB41(int a, int b); }\n',
      'a.cpp': 'int f(int a) { return ROUND(a) + Util::SUB41(a, 0) + SUB42(a, 0); }\n',
    });
    assert.deepStrictEqual(rules(fs), ['pseudo-op-call:SUB42']);
  });

  it('pseudo-op-call: the platform header that defines them is exempt, as is support/', () => {
    const fs = lint({
      'd2_platform.h': 'static inline int SUB41(int a, int b) { return SUB41(a, b); }\n',
      'support/x.cpp': 'int g(int a) { return SUB41(a, 0) + extraout_EAX; }\n',
      'a.cpp': 'int f(int a) { return SUB41(a, 0); }\n',
    });
    assert.deepStrictEqual(rules(fs), ['pseudo-op-call:SUB41']);
    assert.strictEqual(fs[0].file, 'a.cpp');
  });

  it('pseudo-constant: FLOAT_UNKNOWN and -NAN, but not NAN alone', () => {
    const fs = lint(body('float x = FLOAT_UNKNOWN; float y = -NAN; float z = NAN;\nreturn 0;'));
    assert.deepStrictEqual(rules(fs), ['pseudo-constant:-NAN', 'pseudo-constant:FLOAT_UNKNOWN']);
  });

  it('frame-name: stack0x, in_stack_, in_register_ at declaration and use', () => {
    const fs = lint(body(
      'undefined3 in_stack_00000005;\nint in_register_00000004;\n' +
      'x = in_stack_00000005 + in_register_00000004 + *(int*)&stack0x0000000c;\nreturn 0;'));
    assert.deepStrictEqual(rules(fs), [
      'frame-name:in_register_00000004', 'frame-name:in_register_00000004',
      'frame-name:in_stack_00000005', 'frame-name:in_stack_00000005', 'frame-name:stack0x0000000c',
      'ghidra-type:undefined3',
    ]);
  });

  it('register-name: in_<REG>, extraout_*, unaff_*', () => {
    const fs = lint(body(
      'int extraout_EAX; int unaff_EBX;\nx = in_ECX + extraout_EAX + unaff_EBX + in_FS_OFFSET + extraout_var + unaff_retaddr;\nreturn 0;'));
    assert.deepStrictEqual(rules(fs), [
      'register-name:extraout_EAX', 'register-name:extraout_EAX', 'register-name:extraout_var',
      'register-name:in_ECX', 'register-name:in_FS_OFFSET',
      'register-name:unaff_EBX', 'register-name:unaff_EBX', 'register-name:unaff_retaddr',
    ]);
  });

  it('ghidra-type: unk*, undefinedN, int3/uint3 casts, float10, float2 - in bodies and in headers', () => {
    const fs = lint({
      's.h': 'struct S { undefined4 a; undefined b; };\n',
      'a.cpp': 'int f(int a) {\n  unkbyte10 z; unkfloat1 u; float10 w; float2 h;\n  return CONCAT31((int3)a, (uint3)a);\n}\n',
    });
    assert.deepStrictEqual(rules(fs), [
      'ghidra-type:float10', 'ghidra-type:float2', 'ghidra-type:int3', 'ghidra-type:uint3',
      'ghidra-type:undefined', 'ghidra-type:undefined4', 'ghidra-type:unkbyte10', 'ghidra-type:unkfloat1',
      'pseudo-op-call:CONCAT31',
    ]);
  });

  it('subpiece-member: x._N_M_ through dot and arrow', () => {
    const fs = lint(body('s._0_3_ = 1; x = p->_4_2_; y = s._field;\nreturn 0;'));
    assert.deepStrictEqual(rules(fs), ['subpiece-member:_0_3_', 'subpiece-member:_4_2_']);
  });

  it('warning-comment: block and line comments that begin with WARNING, nothing else', () => {
    const fs = lint(body(
      '/* WARNING: Subroutine does not return */\nexit(-1);\n// WARNING: Could not inline here\nx = 1;\n' +
      '/* see WARNING below */\ny = 2;\n// a WARNING in the middle\nreturn "WARNING: in a string" != 0;'));
    assert.deepStrictEqual(rules(fs), [
      'warning-comment:WARNING: Could not inline here', 'warning-comment:WARNING: Subroutine does not return',
    ]);
  });

  it('denormal-literal: a nonzero literal below FLT_MIN, not zero or an ordinary float', () => {
    const fs = lint(body('x = (uint8_t)(float)1.4013e-45; y = 3.58732e-43; z = 0.0; w = 1.5; v = 1e-30;\nreturn 0;'));
    assert.deepStrictEqual(rules(fs), ['denormal-literal:1.4013e-45', 'denormal-literal:3.58732e-43']);
  });
});

describe('ghidra-artifact: not artifacts', () => {
  it('Winsock in_addr, in6_addr, sockaddr_in', () => {
    assert.deepStrictEqual(lint(body('in_addr a4; in6_addr a6; sockaddr_in s; x = a4.s_addr + inet_addr(p);\nreturn 0;')), []);
  });
  it('SUBTILE_* and SUPERUNIQUE_BAAL_SUBJECT_n, also when called', () => {
    assert.deepStrictEqual(lint(body('x = SUBTILE_FLOOR + SUPERUNIQUE_BAAL_SUBJECT_1 + SUBTILE_Get(a) + SUB(a) + SUBx4(a);\nreturn 0;')), []);
  });
  it('names containing the words: nCarry, bCarry, bBorrow, bOverflow, nRoundUp', () => {
    assert.deepStrictEqual(lint(body('int nCarry = 0, bCarry = 0, bBorrow = 0, bOverflow = 0, nRoundUp = 0;\nx = nCarry + bBorrow + CARRY(a) + nRoundUp;\nreturn 0;')), []);
  });
  it('halt, halts, halted, halt_hook, switch*', () => {
    assert.deepStrictEqual(lint(body('halt(a); halt_hook(a); x = halts + halted + switchState;\nreturn 0;')), []);
  });
  it('GCC builtins with a leading __', () => {
    assert.deepStrictEqual(lint(body('void* r = __builtin_frame_address(0); p = (int*)__builtin_alloca(4); r = __builtin_return_address(0);\nreturn 0;')), []);
  });
  it('FloatToLong and LongToFloat', () => {
    assert.deepStrictEqual(lint(body('x = FloatToLong(1.5) + LongToFloat(a);\nreturn 0;')), []);
  });
  it('a hand-named unk_08 field', () => {
    assert.deepStrictEqual(lint({ 'w.h': 'struct W { int unk_08; };\n', 'a.cpp': 'int f(W* w) { return w->unk_08; }\n' }), []);
  });
  it('code as a variable or parameter name', () => {
    assert.deepStrictEqual(lint({ 'z.cpp': 'int inflate_code(int code) { int code2 = code; return code + code2; }\n' }), []);
  });
  it('D2_IsNaN and D2_Cpuid, the generator\'s own spellings', () => {
    assert.deepStrictEqual(lint(body('x = D2_IsNaN(1.0) + D2_Cpuid(0);\nreturn 0;')), []);
  });
  it('exit, _exit, ExitProcess, ExitThread', () => {
    assert.deepStrictEqual(lint(body('exit(-1); _exit(1); ExitProcess(0); ExitThread(0);\nreturn 0;')), []);
  });
  it('a call to a function the tree declares as a template, or as a member specialization', () => {
    assert.deepStrictEqual(lint({
      'r.h': 'template<class T> T ROUND(T v);\ntemplate<> int ABS<int>(int v) { return v < 0 ? -v : v; }\n',
      'a.cpp': 'int f(int a) { return ROUND(a) + ABS(a); }\n',
    }), []);
  });
  it('ABS_* and ROUND_* macro-style names and LOCKFILE are not the pseudo-op calls', () => {
    assert.deepStrictEqual(lint(body('x = ABS_MAX + ROUND_UP(a) + LOCKFILE(a) + LOCK_Get(a);\nreturn 0;')), []);
  });
});

describe('ghidra-artifact: the counted gate', () => {
  const fs = lint(body('x = SUB41(a, 0) + SUB42(a, 0) + extraout_EAX;\nreturn 0;'));

  it('fails a rule over its allowance and a rule absent from the allowlist', () => {
    const over = artifactGate(fs, { 'pseudo-op-call': 1, 'register-name': 1 });
    assert.strictEqual(over.ok, false);
    assert.deepStrictEqual(over.rows.filter(r => r.over).map(r => r.rule), ['pseudo-op-call']);
    const absent = artifactGate(fs, { 'pseudo-op-call': 2 });
    assert.strictEqual(absent.ok, false);
    assert.deepStrictEqual(absent.rows.filter(r => r.over).map(r => r.rule), ['register-name']);
  });

  it('passes at the allowance and marks slack where the count fell', () => {
    const at = artifactGate(fs, { 'pseudo-op-call': 2, 'register-name': 1, 'ghidra-type': 5 });
    assert.strictEqual(at.ok, true);
    assert.deepStrictEqual(at.rows.filter(r => r.slack).map(r => `${r.rule}:${r.count}`), ['ghidra-type:0']);
  });

  it('cli --fail-on exits 3 over the allowlist, 0 at it, and never baselines the check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ga-lint-'));
    const tree = join(dir, 'tree');
    mkdirSync(tree);
    writeFileSync(join(tree, 'a.cpp'), 'int f(int a) { return SUB41(a, 0) + SUB42(a, 0); }\n');
    const allow = join(dir, 'allow.json');
    const baseline = join(dir, 'baseline.json');
    const args = [tree, '--check', 'ghidra-artifact', '--fail-on', 'ghidra-artifact', '--no-layout',
      '--baseline', baseline, '--allowlist', allow, '--snapshot', join(dir, 'no-snapshot')];
    const log = console.log;
    console.log = () => {};
    try {
      writeFileSync(allow, JSON.stringify({ rules: { 'pseudo-op-call': 1 } }));
      assert.strictEqual(main(args), 3);
      writeFileSync(allow, JSON.stringify({ rules: { 'pseudo-op-call': 2 } }));
      assert.strictEqual(main(args), 0);
      assert.strictEqual(main([...args, '--update-baseline']), 0);
    } finally {
      console.log = log;
    }
    const saved = JSON.parse(readFileSync(baseline, 'utf8'));
    assert.ok(!('ghidra-artifact' in saved.checks), 'a counted check must never be written to the baseline');
  });

  it('a counted check stays out of the default run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ga-lint-'));
    writeFileSync(join(dir, 'a.cpp'), 'int f(int a) { return SUB41(a, 0); }\n');
    const out: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
    try {
      main([dir, '--no-layout', '--baseline', join(dir, 'b.json'), '--snapshot', join(dir, 'none')]);
    } finally {
      console.log = log;
    }
    assert.ok(!out.some(l => l.startsWith('ghidra-artifact')), out.join('\n'));
  });
});
