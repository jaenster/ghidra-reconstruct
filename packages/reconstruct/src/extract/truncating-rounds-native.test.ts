/** Exercise the actual Java proof on native bytes, plus invalidating changes. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TRUNCATING_ROUND_PROOF_JAVA } from './truncating-rounds.js';

type Instruction = [string, string, string | null, boolean, (number | null)?];
interface Window { conversion: string; expected: number; instructions: Instruction[] }
const native = JSON.parse(readFileSync(new URL('./fixtures/truncating-rounds-native.json', import.meta.url), 'utf8')) as { windows: Window[] };
const available = spawnSync('javac', ['-version']).status === 0 && spawnSync('java', ['-version']).status === 0;

it('proves 14 native windows with known PUSH writes and refuses control-word/flow clobbers', {
  skip: available ? false : 'javac/java unavailable',
}, () => {
  const cases = native.windows.map(w => ({ ...w, instructions: structuredClone(w.instructions) }));
  const sample = native.windows.find(w => w.conversion === '0061bdbe')!;
  const mutate = (label: string, change: (seq: Instruction[]) => void) => {
    const seq = structuredClone(sample.instructions);
    change(seq); cases.push({ conversion: label, instructions: seq, expected: 0 });
  };
  mutate('wrong RC', seq => { seq.find(i => i[1] === 'OR')![0] = '0d00080000'; });
  mutate('missing save', seq => { seq.shift(); });
  mutate('load another saved word', seq => { seq.find(i => i[1] === 'MOVZX')![0] = '0fb7450c'; });
  mutate('clobber EAX', seq => { seq.splice(seq.findIndex(i => i[1] === 'OR') + 1, 0, ['31c0', 'XOR', 'EAX', false]); });
  mutate('clobber EBP', seq => { seq.splice(2, 0, ['31ed', 'XOR', 'EBP', false]); });
  mutate('unknown write', seq => { seq.splice(2, 0, ['8901', 'MOV', null, false]); });
  mutate('stack write', seq => { seq.splice(2, 0, ['50', 'PUSH', 'EAX', false]); });
  mutate('alternate entry', seq => { seq[2][3] = true; });
  mutate('call', seq => { seq.splice(2, 0, ['e800000000', 'CALL', null, false]); });
  mutate('wrong control slot', seq => { seq.find(i => i[1] === 'FLDCW')![0] = 'd96df8'; });
  mutate('saved word overlap', seq => {
    seq.find(i => i[1] === 'MOV')![0] = '894508';
    seq.find(i => i[1] === 'FLDCW')![0] = 'd96d08';
  });
  mutate('prefix unsupported', seq => { seq[seq.length - 1][0] = '66' + seq[seq.length - 1][0]; });
  mutate('FPU arithmetic after forced RC', seq => {
    seq.splice(seq.findIndex(i => i[1] === 'FLDCW') + 1, 0, ['d8c1', 'FADD', null, false]);
  });
  mutate('saved word overlap across signed-offset boundary', seq => {
    seq[0][0] = 'd9bdffffff7f';
    seq.find(i => i[1] === 'MOVZX')![0] = '0fb785ffffff7f';
    seq.find(i => i[1] === 'MOV')![0] = '898500000080';
    seq.find(i => i[1] === 'FLDCW')![0] = 'd9ad00000080';
  });
  const pushSample = native.windows.find(w => w.conversion === '00606824')!;
  const pushCase = (label: string, change: (push: Instruction) => void, expected = 0) => {
    const seq = structuredClone(pushSample.instructions);
    change(seq.find(i => i[1] === 'PUSH')!);
    cases.push({ conversion: label, instructions: seq, expected });
  };
  pushCase('unknown PUSH destination', push => { push[4] = null; });
  pushCase('word-sized PUSH', push => { push[0] = '666a00'; });
  pushCase('memory PUSH not modeled', push => { push[0] = 'ff3500000000'; });
  pushCase('PUSHA not modeled', push => { push[0] = '60'; });
  pushCase('PUSH register known disjoint', push => { push[0] = '50'; }, 4);
  pushCase('PUSH imm32 known disjoint', push => { push[0] = '6800000000'; }, 4);
  // Saved word [EBP+14,EBP+16), forced-mode dword [EBP-8,EBP-4).
  // Enumerate byte offsets around both boundaries, independently checking each byte.
  for (let offset = -20; offset <= 20; offset++) {
    const touches = [0, 1, 2, 3].some(k => [-8, -7, -6, -5, 14, 15].includes(offset + k));
    pushCase(`PUSH write at EBP${offset < 0 ? '' : '+'}${offset}`, push => { push[4] = offset; }, touches ? 0 : 4);
  }

  const dir = mkdtempSync(join(tmpdir(), 'truncating-round-'));
  try {
    const lines = [
      'public class TruncatingRoundNativeCheck { public static void main(String[] args) {',
      TRUNCATING_ROUND_PROOF_JAVA,
      'TruncatingRoundProof proof = new TruncatingRoundProof();',
    ];
    for (const c of cases) {
      const expressions = c.instructions.map(([hex, mnemonic, dest, entry, stackWrite]) => {
        const bytes = (hex.match(/../g) ?? []).map(b => `(byte)0x${b}`).join(',');
        const boundary = /^(?:CALL|J\w+|RET)$/.test(mnemonic);
        return `new TruncatingRoundInstruction(new byte[]{${bytes}},${JSON.stringify(mnemonic)},${JSON.stringify(dest)},${entry},true,${boundary},${stackWrite ?? 'null'})`;
      });
      lines.push(`if (proof.width(java.util.Arrays.asList(${expressions.join(',')})) != ${c.expected}) throw new AssertionError(${JSON.stringify(c.conversion)});`);
    }
    lines.push(`System.out.println("${cases.length} native sequence cases passed"); } }`);
    const file = join(dir, 'TruncatingRoundNativeCheck.java');
    writeFileSync(file, lines.join('\n'));
    const compile = spawnSync('javac', ['-d', dir, file], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync('java', ['-cp', dir, 'TruncatingRoundNativeCheck'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(run.stdout.trim(), `${cases.length} native sequence cases passed`);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});
