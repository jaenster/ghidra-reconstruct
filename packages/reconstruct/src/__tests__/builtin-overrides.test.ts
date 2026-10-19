/**
 * The overrides the repository ships are registered by the repository
 * (`overrides/registry.json`), not only by the gitignored `project/project.json`.
 *
 * Before, a run without that file - a fresh checkout, a worktree, the Linux container -
 * emitted the decompiler's own body for these functions: `stack0x` frame arithmetic for the
 * two SSignature functions, an `unaff_ECX` compare in GuardStack, an `unaff_retaddr` read in
 * GetInstructionPointer, an `unaff_EBX` comparand in AtomicExchange64. And an override whose
 * file was missing emitted an EMPTY body with a warning nobody read.
 *
 * The bodies themselves are compiled and run here, against what the binary does.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { compileAndRun, hasNativeGpp } from '@ghidra-mcp/cpp-parser/testing/native-cpp';
import {
  BUILTIN_OVERRIDES_DIR, OverrideRegistry, createOverrideRegistry, loadBuiltinOverrides,
} from '../overrides/index.js';
import { overrideAttributePrefix, resolveOverridePlaceholders } from '../codegen/impl.js';
import type { OverrideEntry, ProjectConfig } from '../config/schema.js';

const SHIPPED: Record<string, string> = {
  '0041d590': 'SSignatureGenerate',
  '0041d6d0': 'SSignatureVerifyStream_Finish',
  '00681a48': 'GuardStack',
  '00408090': 'GetInstructionPointer',
  '004107d0': 'AtomicExchange64',
};

const body = (name: string) => fs.readFileSync(path.join(BUILTIN_OVERRIDES_DIR, `${name}.cpp`), 'utf-8');
const entry = (address: string) => loadBuiltinOverrides().find(e => e.address === address)!;

describe('repository overrides: registration', () => {
  it('registers every shipped body by address, with its file resolved', () => {
    const entries = loadBuiltinOverrides();
    assert.deepStrictEqual(
      Object.fromEntries(entries.map(e => [e.address, e.name])), SHIPPED);
    for (const e of entries) {
      assert.ok(path.isAbsolute(e.sourceFile!), e.sourceFile);
      assert.ok(fs.existsSync(e.sourceFile!), `missing ${e.sourceFile}`);
    }
  });

  it('applies with no project config at all', async () => {
    const registry = createOverrideRegistry(undefined, os.tmpdir());
    assert.ok(registry, 'no registry without project.json: the shipped bodies are not applied');
    for (const address of Object.keys(SHIPPED)) assert.ok(registry!.has(address), address);
    const applied = await registry!.applyOverride('004107d0', '/* decompiled */');
    assert.match(applied!.body, /__atomic_compare_exchange_n/);
  });

  it('a project entry for the same address replaces the shipped one', () => {
    const config = { overrides: [{ address: '00681a48', action: 'patch', patches: [{ find: 'a', replace: 'b' }] }] } as ProjectConfig;
    const registry = new OverrideRegistry(config, os.tmpdir());
    assert.strictEqual(registry.get('00681a48')!.action, 'patch');
    assert.strictEqual(registry.get('00408090')!.action, 'replace');
  });

  it('an unreadable body is an error, not an empty function', async () => {
    const config = { overrides: [{ address: '00401000', action: 'replace', sourceFile: 'no-such-body.cpp' }] } as ProjectConfig;
    const registry = new OverrideRegistry(config, os.tmpdir(), []);
    await assert.rejects(registry.applyOverride('00401000', ''));
    await assert.rejects(resolveOverridePlaceholders('int f() {\n    // [OVERRIDE:REPLACE] no-such-body.cpp\n}', registry));
  });

  it('spells declared attributes in front of the definition, and refuses anything else', () => {
    assert.strictEqual(overrideAttributePrefix(entry('00408090')), '__attribute__((noinline)) ');
    assert.strictEqual(overrideAttributePrefix(entry('004107d0')), '');
    const bad = { address: '1', action: 'replace', sourceFile: 'x', attributes: ['noinline)) int x; ((a'] } as OverrideEntry;
    assert.throws(() => overrideAttributePrefix(bad));
  });

  it('no shipped body names a decompiler artifact', () => {
    for (const name of Object.values(SHIPPED)) {
      const code = body(name).split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
      assert.ok(!/\b(stack0x[0-9a-f]+|unaff_\w+|in_[A-Z]\w*|extraout_\w+|in_stack_\w+)\b/.test(code), name);
    }
  });
});

const native = { skip: !hasNativeGpp() };

describe('repository overrides: the bodies do what the binary does', native, () => {
  it('AtomicExchange64 reads the target atomically and leaves it unchanged', () => {
    const fn = `void AtomicExchange64(int64_t* pdwResult, int64_t* pllTarget) {\n${body('AtomicExchange64')}\n}`;
    const out = compileAndRun(fn, [
      // 0: the comparand stand-in matches, so the locked write puts back the same value.
      'const int64_t values[] = {0, 0x29a, -1, 0x123456789abcdefLL};',
      'for (int64_t v : values) {',
      '  int64_t target = v, result = 0x5555;',
      '  AtomicExchange64(&result, &target);',
      '  printf("%d", result == v && target == v);',
      '}',
    ].join('\n'));
    assert.strictEqual(out, '1111');
  });

  it('GetInstructionPointer returns an address inside its caller, inlined or not', () => {
    // The definition the generator emits: the attribute prefix, then the shipped body.
    const def = (prefix: string, name: string) =>
      `${prefix}static int32_t ${name}() {\n${body('GetInstructionPointer')}\n}`;
    const prelude = [
      def(overrideAttributePrefix(entry('00408090')), 'GetIp'),
      def('', 'GetIpInlinable'),
      'volatile int g_sink;',
      // Work after the call, so the call is not a tail jump.
      '__attribute__((noinline)) int32_t Caller() { int32_t r = GetIp(); g_sink++; return r; }',
      '__attribute__((noinline)) int32_t CallerInlinable() { int32_t r = GetIpInlinable(); g_sink++; return r; }',
      'static int inside(int32_t r, void* fn) { uint32_t a = (uint32_t)(uintptr_t)fn; return (uint32_t)r - a < 256u; }',
    ].join('\n');
    const out = compileAndRun(prelude,
      'printf("%d%d", inside(Caller(), (void*)&Caller), inside(CallerInlinable(), (void*)&CallerInlinable));',
      { optimize: true });
    // With the attribute: inside the caller. Without it the optimiser inlines the body and
    // it answers with the caller's OWN return address - which is why the attribute ships.
    assert.strictEqual(out, '10');
  });

  it('GuardStack returns and touches nothing', () => {
    const out = compileAndRun(`static void GuardStack() {\n${body('GuardStack')}\n}`,
      'int x = 7; GuardStack(); printf("%d", x);');
    assert.strictEqual(out, '7');
  });
});
