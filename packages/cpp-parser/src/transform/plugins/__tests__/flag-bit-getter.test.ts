import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { flagBitGetterPlugin } from '../builtins/flag-bit-getter.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const and = (at: number) => ({ op: '!=', mnemonic: 'AND', reg: 'EAX', k: 0, size: 4, at });
const cmp = (at: number) => ({ op: '==', mnemonic: 'CMP', reg: '-', k: 12, size: 4, at });

function run(lines: string[], tests: Map<number, unknown[]>): { out: string; prefix: string[] } {
  const prefix: string[] = [];
  const t = flagBitGetterPlugin.createTransformer({
    branchLayout: { lines: new Map(), ifs: new Map(), tests } as never,
    onPrefix: d => prefix.push(d),
  } as never);
  return { out: flat(emit(t(parse(lines.join('\n'))) as AnyNode)), prefix };
}

// AI_ForEachFn09_FindOwnMinionCorpse 005dcda0.
const SRC = [
  'struct U { int eMode; unsigned int eUnitFlags; };',
  'int f(U * pOther) {',
  '  if (pOther && pOther->eMode == 12 && (pOther->eUnitFlags >> 1 & 1) != 0) {',
  '    return 1;',
  '  }',
  '  return 0;',
  '}',
];

describe('flag-bit-getter', () => {
  it('reads a bit the original ANDs through the getter', () => {
    const { out, prefix } = run(SRC, new Map([[3, [cmp(0x2b), and(0x39)]]]));
    assert.ok(out.includes('(FlagBit_U_eUnitFlags_1(pOther)) != 0') || out.includes('FlagBit_U_eUnitFlags_1(pOther) != 0'), out);
    assert.strictEqual(prefix.length, 1);
    assert.ok(flat(prefix[0]).includes('static inline uint32_t FlagBit_U_eUnitFlags_1(U * p) { if (!p) { return 0; } return p->eUnitFlags >> 1 & 1; }'), prefix[0]);
  });

  it('leaves a bit the original tests in memory', () => {
    const { out, prefix } = run(SRC, new Map([[3, [cmp(0x2b), { ...cmp(0x39), mnemonic: 'TEST' }]]]));
    assert.ok(out.includes('pOther->eUnitFlags >> 1 & 1'), out);
    assert.strictEqual(prefix.length, 0);
  });
});
