/**
 * Regression test: the two `_alloca` functions in Storm/Source/SSignature.cpp
 * are served from hand-supplied bodies, and those bodies bind the right buffers.
 *
 * Ghidra cannot decompile `SSignatureGenerate` (0041d590) or
 * `SSignatureVerifyStream_Finish` (0041d6d0). Both call `__alloca_probe_16`
 * (006869d0), which Ghidra replaces with its `alloca_probe` injection; the stack
 * spacebase then stops being trackable and the outgoing-argument PUSHes leak
 * into the body as stores to `&stack0xNNNNNNNN + <runtime>`. Those leaked names
 * are the six "was not declared in this scope" errors.
 *
 * The important half is not the errors. In `Finish`, Ghidra tracks the FIRST
 * alloca's shift and DROPS THE SECOND'S: it renders EBX - the second buffer -
 * as a bare `&stack0xffffffe0`, which is ESP *before either* allocation, i.e.
 * the saved registers and the return address. Any respelling of those six names
 * compiles and then memcpy()s the RSA payload over the frame. So the test that
 * matters is not "does it compile" but "does the second allocation's pointer
 * come from the second allocation".
 *
 * This asserts, on the override sources themselves:
 *   - no `stack0x` name survives,
 *   - each function declares exactly as many `__builtin_alloca` buffers as the
 *     binary has `CALL __alloca_probe_16` sites (2 and 3),
 *   - in `Finish`, the buffer handed to STORM_Memcpy / CryptRSA_Process /
 *     SSYSTEM_MemCompare is `pSig` - the SECOND allocation - and never the
 *     first. This is the exact inversion that made a spelling-only fix unsafe.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OverrideRegistry } from '../overrides/index.js';
import type { ProjectConfig } from '../config/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const overrideDir = path.join(repoRoot, 'overrides');

const FINISH = 'SSignatureVerifyStream_Finish.cpp';
const GENERATE = 'SSignatureGenerate.cpp';

function read(name: string): string {
  return fs.readFileSync(path.join(overrideDir, name), 'utf-8');
}

/** Strip `//` comments so assertions see code, not the provenance annotations. */
function code(src: string): string {
  return src
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('SSignature alloca overrides', () => {
  it('ships a body for each of the two undecompilable functions', () => {
    for (const f of [FINISH, GENERATE]) {
      assert.ok(fs.existsSync(path.join(overrideDir, f)), `missing override ${f}`);
    }
  });

  it('names no stack0x pseudo-symbol', () => {
    for (const f of [FINISH, GENERATE]) {
      assert.ok(!/stack0x[0-9a-f]/i.test(code(read(f))), `${f} still names a stack0x slot`);
    }
  });

  it('declares one alloca buffer per CALL __alloca_probe_16 in the binary', () => {
    // 0041d709, 0041d72e
    assert.strictEqual(code(read(FINISH)).match(/__builtin_alloca/g)?.length, 2);
    // 0041d5c2, 0041d5e8, 0041d620
    assert.strictEqual(code(read(GENERATE)).match(/__builtin_alloca/g)?.length, 3);
  });

  it('binds Finish\'s second allocation to the RSA buffer, not the hash', () => {
    const body = code(read(FINISH));

    // Declaration order must match allocation order: pHash (0041d70e MOV EDI,ESP)
    // before pSig (0041d735 MOV EBX,ESP).
    const iHash = body.indexOf('pHash   = (uint8_t*)__builtin_alloca');
    const iSig = body.indexOf('pSig = (uint8_t*)__builtin_alloca');
    assert.ok(iHash > -1 && iSig > -1, 'both buffers must be declared');
    assert.ok(iHash < iSig, 'pHash is allocated first (0041d70e before 0041d735)');

    // EBX == pSig is the operand of all three of these (0041d73f, 0041d767,
    // 0041d774). Ghidra put the first buffer's base there instead.
    for (const [call, arg] of [
      ['STORM_Memcpy', 'pSig'],
      ['CryptRSA_Process', 'pSig'],
    ] as const) {
      const m = new RegExp(`${call}\\(\\s*([A-Za-z_][A-Za-z0-9_]*)`).exec(body);
      assert.ok(m, `${call} not found`);
      assert.strictEqual(m![1], arg, `${call} must receive ${arg} (the second alloca)`);
    }

    // MemCompare(EBX, EDI, len) — pSig first, pHash second (0041d774/0041d773).
    assert.match(body, /SSYSTEM_MemCompare\(\s*\(int\*\)pSig,\s*\(D2QServerClientConnectionStrc\*\)pHash/);

    // Only Sha1_Finalize and the Memset touch pHash.
    assert.match(body, /SSYSTEM_Memset\(pHash,/);
    assert.match(body, /Sha1_Finalize\(\(int32_t\)pHash,/);
  });

  it('binds Generate\'s three allocations in allocation order', () => {
    const body = code(read(GENERATE));
    const order = ['pHash', 'pSig1', 'pSig2'].map(n =>
      body.indexOf(`${n} = (uint8_t*)__builtin_alloca`)
    );
    assert.ok(order.every(i => i > -1), 'all three buffers must be declared');
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order);

    // 0041d5f2 copies the hash into the first RSA buffer; 0041d62d copies that
    // into the second; 0041d662 compares the second against the hash; 0041d693
    // writes the FIRST RSA buffer into the caller's data. Getting 0041d693
    // wrong would emit a valid-looking but unverifiable signature.
    assert.match(body, /STORM_Memcpy\(pSig1, pHash, nKeySize\)/);
    assert.match(body, /STORM_Memcpy\(pSig2, pSig1, nKeySize\)/);
    assert.match(body, /SSYSTEM_MemCompare\(\(int\*\)pSig2,/);
    assert.match(body, /STORM_Memcpy\(pDataBytes \+ nMarkerOffset \+ 4, pSig1, nKeySize\)/);
  });
});

describe('OverrideRegistry serves them by address', () => {
  const config: ProjectConfig = {
    overrides: [
      { address: '0041d590', name: 'SSignatureGenerate', action: 'replace', sourceFile: `../overrides/${GENERATE}` },
      { address: '0041d6d0', name: 'SSignatureVerifyStream_Finish', action: 'replace', sourceFile: `../overrides/${FINISH}` },
    ],
  } as ProjectConfig;

  // sourceFile resolves against the project dir, which is `project/` beside the
  // tracked `overrides/` dir — project/ is gitignored, the bodies are not.
  const registry = new OverrideRegistry(config, path.join(repoRoot, 'project'));

  it('looks up both addresses however they are spelled', () => {
    for (const a of ['0041d590', '0x0041d590', '0041D590']) {
      assert.ok(registry.has(a), `not found: ${a}`);
    }
    assert.ok(registry.has('0041d6d0'));
    assert.ok(!registry.has('0041d5c2'));
  });

  it('loads the body from the tracked overrides directory', async () => {
    const applied = await registry.applyOverride('0041d6d0', '/* decompiled */');
    assert.ok(applied, 'override did not apply');
    assert.deepStrictEqual(applied!.warnings, []);
    assert.match(applied!.body, /__builtin_alloca/);
    assert.ok(!/stack0x[0-9a-f]/i.test(code(applied!.body)));
  });
});
