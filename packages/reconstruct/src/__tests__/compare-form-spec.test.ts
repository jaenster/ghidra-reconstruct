/**
 * Comparisons take the form their CMP/TEST and Jcc show (codegen/compare-form-spec.ts).
 *
 * Every row of the derivation is checked here, with the cases that must NOT match: a wrap
 * at either end of the machine's domain, an opcode the Jcc disagrees with on signedness, a
 * step larger than one. The rows come from the extraction script (extract/compare-sites.ts);
 * the InitLogFilePathPointers @0040eb90 rows are what the script printed for that function.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compareFormDecision, compareFormSpec, conditionCode } from '../codegen/compare-form-spec.js';
import {
  compareSiteRows, javaStringHash, parseCompareSiteOutput, compareSiteBatches, compareSitesScript,
  type CompareSite,
} from '../extract/compare-sites.js';
import { generateFunctionImplementation } from '../codegen/impl.js';
import type { ExtractedFunction, ReconstructOptions, ProjectConfig } from '../types.js';
import { OverrideRegistry } from '../overrides/index.js';
import os from 'node:os';

const INIT_LOG = [
  '0\t!=\tINT_NOTEQUAL\t4\t1\t0\tv:nCount\tc:0\t0040eb92\t0040eb94\tJBE\t0040eb92\tTEST\t4\tr\tz\t0\t1',
  '1\t<\tINT_LESS\t4\t0\t144f\tc:144f\tv:nByteOffset\t0040eba0\t0040eba6\tJNC\t0040eba0\tCMP\t4\tr\ti\t1450\t1',
  '2\t<\tINT_LESS\t4\t-1\t-\tv:nIndex\tv:nCount\t0040ebba\t0040ebbc\tJC\t0040ebba\tCMP\t4\tr\tr\t-\t1',
].join('\n');

const INIT_LOG_C = '\n/* @function InitLogFilePathPointers\n   @address Game.exe.ram:0040eb90\n   @date 2026.06.14\n   @calling __fastcall\n   @description Diablo 2 1.14d reverse team\n   https://blizzhackers.dev */\n\nvoid __fastcall Fog::Src::LogManager::InitLogFilePathPointers(byte **pPathPtrArray,uint32_t nCount)\n\n{\n  uint nIndex;\n  char (*pPathSlot) [260];\n  uint nByteOffset;\n  \n  nIndex = 0;\n  if (nCount != 0) {\n    pPathSlot = gLogFilePathArray;\n    nByteOffset = 0;\n    do {\n      if (0x144f < nByteOffset) {\n        return;\n      }\n      pPathPtrArray[nIndex] = (byte *)pPathSlot;\n      nIndex = nIndex + 1;\n      nByteOffset = nByteOffset + 0x104;\n      pPathSlot = pPathSlot + 1;\n    } while (nIndex < nCount);\n  }\n  return;\n}\n\n';

/** A site: `text` printed for `opcode`, a constant `k` on `constSide`, compared by `CMP ...,B; Jcc`. */
function site(p: Omit<Partial<CompareSite>, 'user'> & { text: string; opcode: string; user: string }): CompareSite {
  return {
    ord: 0, size: 4, constSide: 1, fp: ['v:x', 'c:0'], opAt: '00401000', width: 4, aKind: 'r', bKind: 'i', onPair: true,
    setter: { at: '00401000', mnemonic: 'CMP' },
    ...p,
    user: { at: '00401003', mnemonic: p.user },
  } as CompareSite;
}

const decide = (s: CompareSite) => {
  const o = compareFormDecision(s);
  return 'decision' in o ? o.decision : null;
};

describe('compare-sites extraction', () => {
  it('hashes text the way Java String.hashCode does', () => {
    assert.strictEqual(javaStringHash(INIT_LOG_C), 0x369abf35);
    assert.strictEqual(javaStringHash(''), 0);
  });
  it('parses the script output into per-function blocks', () => {
    const out = `F\t0040eb90\t369abf35\t715\n${INIT_LOG.split('\n').map(r => `S\t${r}`).join('\n')}\nF\t00401000\tfail\nF\t00402000\tnull\n`;
    const blocks = parseCompareSiteOutput(out);
    assert.deepStrictEqual([...blocks.keys()], ['0040eb90']);
    const b = blocks.get('0040eb90')!;
    assert.strictEqual(b.hash, 0x369abf35);
    assert.strictEqual(b.length, 715);
    assert.strictEqual(b.rows, INIT_LOG);
  });
  it('parses the rows, an op-less token included', () => {
    const rows = compareSiteRows(`${INIT_LOG}\n3\t==\t-`);
    assert.strictEqual(rows.length, 4);
    assert.deepStrictEqual(rows[1].fp, ['c:144f', 'v:nByteOffset']);
    assert.strictEqual(rows[1].k, 0x144fn);
    assert.strictEqual(rows[1].bValue, 0x1450n);
    assert.strictEqual(rows[1].user?.mnemonic, 'JNC');
    assert.strictEqual(rows[2].constSide, -1);
    assert.strictEqual(rows[3].opcode, undefined);
  });
  it('batches only bodies that print a comparison', () => {
    const b = compareSiteBatches([
      { address: '0x0040eb90', decompiled: 'if (a < b) {}' },
      { address: '00401000', decompiled: 'return a + b;' },
      { address: '00402000', decompiled: undefined },
    ]);
    assert.deepStrictEqual(b, [['0040eb90']]);
    assert.ok(compareSitesScript(b[0]).includes('String items = "0040eb90";'));
  });
});

describe('compare-form derivation', () => {
  it('reads condition codes, aliases included', () => {
    assert.strictEqual(conditionCode('JNC'), 'NC');
    assert.strictEqual(conditionCode('SETBE'), 'BE');
    assert.strictEqual(conditionCode('JMP'), undefined);
    assert.strictEqual(conditionCode('JNS'), undefined);
  });

  it('InitLogFilePathPointers: != 0 under JBE, the constant moved right and up, the loop kept', () => {
    const spec = compareFormSpec({ compareSites: INIT_LOG })!;
    assert.strictEqual(spec.sites.length, 3);
    const [a, b, c] = spec.decisions;
    assert.deepStrictEqual([a.op, a.swap, a.delta, a.unsigned], ['>', false, 0, true]);
    assert.deepStrictEqual([b.op, b.swap, b.delta], ['>=', true, 1]);
    assert.strictEqual(c.keep, true);
  });

  it('X rel k already in F: no change, or only the constant moved right', () => {
    assert.strictEqual(decide(site({ text: '<', opcode: 'INT_SLESS', k: 5n, bValue: 5n, user: 'JGE' }))?.keep, true);
    const d = decide(site({ text: '<', opcode: 'INT_SLESS', constSide: 0, k: 5n, bValue: 5n, user: 'JLE' }))!;
    assert.deepStrictEqual([d.op, d.swap, d.delta], ['>', true, 0]);
  });

  it('X < k -> X <= k-1, X <= k -> X < k+1, X > k -> X >= k+1, X >= k -> X > k-1', () => {
    let d = decide(site({ text: '<', opcode: 'INT_SLESS', k: 4n, bValue: 3n, user: 'JLE' }))!;
    assert.deepStrictEqual([d.op, d.delta, d.swap], ['<=', -1, false]);
    d = decide(site({ text: '<=', opcode: 'INT_LESSEQUAL', k: 4n, bValue: 5n, user: 'JNC' }))!;
    assert.deepStrictEqual([d.op, d.delta], ['<', 1]);
    // `0xb75 < n` is `n > 0xb75`; CMP n,0xb76; JL makes it `n >= 0xb76`.
    d = decide(site({ text: '<', opcode: 'INT_SLESS', constSide: 0, k: 0xb75n, bValue: 0xb76n, user: 'JL' }))!;
    assert.deepStrictEqual([d.op, d.delta, d.swap], ['>=', 1, true]);
    // `k <= n` is `n >= k`; CMP n,k-1; JA makes it `n > k-1`.
    d = decide(site({ text: '<=', opcode: 'INT_LESSEQUAL', constSide: 0, k: 8n, bValue: 7n, user: 'JA' }))!;
    assert.deepStrictEqual([d.op, d.delta, d.swap], ['>', -1, true]);
  });

  it('a signed -1 < n with TEST n,n; JL is n >= 0', () => {
    const d = decide(site({ text: '<', opcode: 'INT_SLESS', constSide: 0, k: 0xffffffffn, bKind: 'z', bValue: 0n, user: 'JL' }))!;
    assert.deepStrictEqual([d.op, d.delta, d.swap, d.signed], ['>=', 1, true, true]);
  });

  it('an ordered compare against a register Ghidra proved zero is decided as against 0', () => {
    // setitems: `-1 < set` from CMP AX,SI; JL with SI zeroed far above is `set >= 0`.
    let d = decide(site({ text: '<', opcode: 'INT_SLESS', size: 2, width: 2, constSide: 0, k: 0xffffn, bKind: 'r', user: 'JL' }))!;
    assert.deepStrictEqual([d.op, d.delta, d.swap, d.signed], ['>=', 1, true, true]);
    // pettype: `n < 1` from CMP EAX,EBX; SETLE is `n <= 0`.
    d = decide(site({ text: '<', opcode: 'INT_SLESS', k: 1n, bKind: 'r', user: 'SETLE' }))!;
    assert.deepStrictEqual([d.op, d.delta, d.swap], ['<=', -1, false]);
    // `0 < n` from CMP n,ESI; JLE: only swapped.
    d = decide(site({ text: '<', opcode: 'INT_SLESS', constSide: 0, k: 0n, bKind: 'r', user: 'JLE' }))!;
    assert.deepStrictEqual([d.op, d.delta, d.swap], ['>', 0, true]);
  });

  it('leaves a register holding another constant, and a Jcc that disagrees on signedness', () => {
    // superuniques: `0x1ff < n` against a register of 0x200 that VC8 shares with a store.
    assert.strictEqual(decide(site({ text: '<', opcode: 'INT_SLESS', constSide: 0, k: 0x1ffn, bKind: 'r', user: 'JL' })), null);
    assert.strictEqual(decide(site({ text: '<', opcode: 'INT_SLESS', constSide: 0, k: 0n, bKind: 'r', user: 'JBE' })), null);
  });

  it('never matches across a wrap of the machine domain', () => {
    // unsigned x < 0 against CMP x,0xffffffff: modulo 2^32 they are one apart, as integers not.
    assert.strictEqual(decide(site({ text: '<', opcode: 'INT_LESS', k: 0n, bValue: 0xffffffffn, user: 'JBE' })), null);
    // signed x <= 0x7fffffff against CMP x,0x80000000: the step wraps to INT_MIN.
    assert.strictEqual(decide(site({ text: '<=', opcode: 'INT_SLESSEQUAL', k: 0x7fffffffn, bValue: 0x80000000n, user: 'JL' })), null);
    // byte-wide: unsigned b < 0 against CMP b,0xff.
    assert.strictEqual(decide(site({ text: '<', opcode: 'INT_LESS', size: 1, width: 1, k: 0n, bValue: 0xffn, user: 'JBE' })), null);
    // byte-wide signed: c > 0x7f (impossible) against 0x80 (-128).
    assert.strictEqual(decide(site({ text: '<', opcode: 'INT_SLESS', size: 1, width: 1, constSide: 0, k: 0x7fn, bValue: 0x80n, user: 'JL' })), null);
  });

  it('a byte-wide step inside the domain matches', () => {
    const d = decide(site({ text: '<', opcode: 'INT_LESS', size: 1, width: 1, k: 0xf0n, bValue: 0xefn, user: 'JA' }))!;
    assert.deepStrictEqual([d.op, d.delta, d.width], ['<=', -1, 1]);
  });

  it('refuses an opcode the Jcc disagrees with, a larger step, and a width mismatch', () => {
    assert.strictEqual(decide(site({ text: '<', opcode: 'INT_LESS', k: 4n, bValue: 3n, user: 'JLE' })), null);
    assert.strictEqual(decide(site({ text: '<', opcode: 'INT_SLESS', k: 4n, bValue: 3n, user: 'JBE' })), null);
    assert.strictEqual(decide(site({ text: '<', opcode: 'INT_SLESS', k: 5n, bValue: 3n, user: 'JLE' })), null);
    assert.strictEqual(decide(site({ text: '<', opcode: 'INT_SLESS', k: 4n, bValue: 3n, width: 1, user: 'JLE' })), null);
  });

  it('refuses without the instruction pair, with a bit test, or an equality against a constant held in a register', () => {
    assert.strictEqual(decide(site({ text: '<', opcode: 'INT_SLESS', k: 4n, bValue: 3n, user: 'JLE', onPair: false })), null);
    assert.strictEqual(decide(site({ text: '!=', opcode: 'INT_NOTEQUAL', k: 0n, bKind: 'bit', user: 'JZ' })), null);
    assert.strictEqual(decide(site({ text: '==', opcode: 'INT_EQUAL', k: 1n, bKind: 'r', user: 'JZ' })), null);
    assert.strictEqual(decide(site({ text: '<', opcode: 'INT_SLESS', k: 0n, bKind: 'z', bValue: 0n, user: 'JNS' })), null);
  });

  it('X == 0 / X != 0 under JBE/JA become unsigned X <= 0 / X > 0; under JZ/JNZ they stay', () => {
    let d = decide(site({ text: '==', opcode: 'INT_EQUAL', k: 0n, bKind: 'z', bValue: 0n, user: 'JA' }))!;
    assert.deepStrictEqual([d.op, d.unsigned], ['<=', true]);
    d = decide(site({ text: '!=', opcode: 'INT_NOTEQUAL', size: 1, width: 1, k: 0n, bKind: 'z', bValue: 0n, user: 'JBE' }))!;
    assert.deepStrictEqual([d.op, d.unsigned, d.width], ['>', true, 1]);
    assert.strictEqual(decide(site({ text: '!=', opcode: 'INT_NOTEQUAL', k: 0n, bKind: 'z', bValue: 0n, user: 'JZ' }))?.keep, true);
    // A non-zero constant under JBE is not an equality the derivation knows.
    assert.strictEqual(decide(site({ text: '!=', opcode: 'INT_NOTEQUAL', k: 1n, bValue: 1n, user: 'JBE' })), null);
  });

  it('X == 0 / X != 0 under CMP X,1; JB/JAE become unsigned X < 1 / X >= 1', () => {
    // A2Q3: `cmp byte ptr [eax+0xd], 1; jb` printed `pDVar3->nStateFlag != 0`.
    let d = decide(site({ text: '!=', opcode: 'INT_NOTEQUAL', size: 1, width: 1, k: 0n, bValue: 1n, user: 'JC' }))!;
    assert.deepStrictEqual([d.op, d.delta, d.k, d.unsigned, d.swap], ['>=', 1, 0, true, false]);
    d = decide(site({ text: '==', opcode: 'INT_EQUAL', k: 0n, bValue: 1n, user: 'JNC' }))!;
    assert.deepStrictEqual([d.op, d.delta, d.unsigned], ['<', 1, true]);
    // The constant printed first: the operands swap.
    d = decide(site({ text: '==', opcode: 'INT_EQUAL', constSide: 0, fp: ['c:0', 'v:x'], k: 0n, bValue: 1n, user: 'JAE' }))!;
    assert.deepStrictEqual([d.op, d.swap, d.delta], ['<', true, 1]);
    // A signed JL/JGE against 1 also takes the negatives: not this equality.
    assert.strictEqual(decide(site({ text: '==', opcode: 'INT_EQUAL', k: 0n, bValue: 1n, user: 'JL' })), null);
    assert.strictEqual(decide(site({ text: '!=', opcode: 'INT_NOTEQUAL', k: 0n, bValue: 1n, user: 'JGE' })), null);
    // Only 0 against 1, and only under JB/JAE.
    assert.strictEqual(decide(site({ text: '==', opcode: 'INT_EQUAL', k: 0n, bValue: 2n, user: 'JC' })), null);
    assert.strictEqual(decide(site({ text: '==', opcode: 'INT_EQUAL', k: 1n, bValue: 2n, user: 'JC' })), null);
    assert.strictEqual(decide(site({ text: '==', opcode: 'INT_EQUAL', k: 0n, bValue: 1n, user: 'JBE' })), null);
    assert.strictEqual(decide(site({ text: '==', opcode: 'INT_EQUAL', k: 0n, bValue: 1n, user: 'JZ' })), null);
  });

  it('two variables: kept when rel is in F, mirrored when only MIR(rel) is', () => {
    const vv = { constSide: -1, k: undefined, fp: ['v:p', 'v:q'] as [string, string], bKind: 'r' };
    assert.strictEqual(decide(site({ ...vv, text: '<', opcode: 'INT_LESS', user: 'JC' }))?.keep, true);
    const d = decide(site({ ...vv, text: '<=', opcode: 'INT_SLESSEQUAL', user: 'JL' }))!;
    assert.deepStrictEqual([d.op, d.swap, d.delta], ['>=', true, 0]);
    // Equality does not say which side was the CMP's first: kept.
    assert.strictEqual(decide(site({ ...vv, text: '==', opcode: 'INT_EQUAL', user: 'JZ' }))?.keep, true);
    // `p < q` read by JLE is `q > p`; read by JB it is an unsigned flag on a signed op.
    assert.deepStrictEqual(decide(site({ ...vv, text: '<', opcode: 'INT_SLESS', user: 'JLE' }))?.op, '>');
    assert.strictEqual(decide(site({ ...vv, text: '<', opcode: 'INT_SLESS', user: 'JB' })), null);
    // A variable against an immediate the decompile did not print: not this pair.
    assert.strictEqual(decide(site({ ...vv, text: '<', opcode: 'INT_SLESS', user: 'JL', bKind: 'i', bValue: 3n })), null);
  });

  it('a site list with a gap in its ordinals is not used', () => {
    assert.strictEqual(compareFormSpec({ compareSites: INIT_LOG.split('\n').slice(1).join('\n') }), null);
    assert.strictEqual(compareFormSpec({}), null);
  });
});

describe('compare-form in codegen', () => {
  const options: ReconstructOptions = {
    outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
    generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false, promoteStaticGlobals: false,
  };
  const fn = (compareSites?: string): ExtractedFunction => ({
    name: 'InitLogFilePathPointers', address: '0040eb90',
    signature: 'void InitLogFilePathPointers(byte **pPathPtrArray, uint32_t nCount)', returnType: 'void',
    parameters: [
      { name: 'pPathPtrArray', dataType: 'byte **', size: 4, ordinal: 0, storage: 'ECX' },
      { name: 'nCount', dataType: 'uint32_t', size: 4, ordinal: 1, storage: 'EDX' },
    ],
    localVariables: [], callingConvention: '__fastcall', size: 64, isThunk: false, isExternal: false, hasVarArgs: false,
    decompiled: INIT_LOG_C, compareSites,
  } as ExtractedFunction);

  it('writes the forms the instructions show, and nothing without the rows', () => {
    const out = generateFunctionImplementation(fn(INIT_LOG), undefined, options);
    assert.match(out, /nByteOffset >= 0x1450/);
    assert.doesNotMatch(out, /0x144f/);
    assert.match(out, /nIndex < nCount/);
    // `nCount != 0` is now an unsigned `> 0` (the pipeline may print its negation).
    assert.match(out, /nCount (> 0|<= 0)/);
    const plain = generateFunctionImplementation(fn(), undefined, options);
    assert.match(plain, /0x144f < nByteOffset/);
  });

  it('leaves a function with a text patch as Ghidra printed it, so the patch still anchors', () => {
    const config = { overrides: [{ address: '0040eb90', action: 'patch',
      patches: [{ find: 'if (0x144f < nByteOffset) {', replace: 'if (0x144f < nByteOffset /* patched */) {' }] }] } as ProjectConfig;
    const overrides = new OverrideRegistry(config, os.tmpdir(), []);
    const out = generateFunctionImplementation(fn(INIT_LOG), undefined, options, { overrides } as never);
    assert.match(out, /0x144f < nByteOffset \/\* patched \*\//);
    assert.doesNotMatch(out, /0x1450/);
  });
});
