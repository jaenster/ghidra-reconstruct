import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseFunctionFacts, selectFacts, FACT_KEYS, FUNCTION_FACTS_SCRIPT } from './function-facts.js';
import { parseRegisterStoreRow, printsConstantStore, REGISTER_STORES_JAVA } from './register-stores.js';

// MONSTER_SetMonStatsTxtAndType 004ae0a0: the null store is `xor eax, eax; mov [esi], eax`;
// SetTotalFrames 0064a2b0 stores -0x8000 as a word from AX.
const TEXT = 'void f(int *p)\n{\n  *(int *)(p + 0xc) = 0;\n  return;\n}\n';
const row = (k: string) => [
  'P\tGame.exe:1894',
  'F\t004ae0a0\tself\t1\t2\t1',
  `K\t004ae0a0\t${k}`,
  'D\t',
].join('\n');

describe('register stores', () => {
  it('parses a row', () => {
    assert.deepStrictEqual(parseRegisterStoreRow('pMonStatsTxt:4:0:r;nAiMode:2:8000:i'), [
      { name: 'pMonStatsTxt', size: 4, value: 0, register: true },
      { name: 'nAiMode', size: 2, value: 0x8000, register: false },
    ]);
  });

  it('drops a malformed row and one without a register store', () => {
    assert.deepStrictEqual(parseRegisterStoreRow('pX:3:0:r'), []);
    assert.deepStrictEqual(parseRegisterStoreRow('pX:4:0:q'), []);
    assert.deepStrictEqual(parseRegisterStoreRow('a.b:4:0:r'), []);
    assert.deepStrictEqual(parseRegisterStoreRow('pX:4:0:i;pY:1:ff:i'), []);
    assert.deepStrictEqual(parseRegisterStoreRow('pX:4:0:k'), []);
    assert.deepStrictEqual(parseRegisterStoreRow('pX:4:0:k;pY:4:1:r').map(r => r.register), [false, true]);
  });

  it('recognises the decompiles that assign a constant', () => {
    assert.ok(printsConstantStore(TEXT));
    assert.ok(printsConstantStore('  gnId = -1;\n'));
    assert.ok(printsConstantStore('  p->w = 0x7fff;\n'));
    assert.ok(printsConstantStore('    pDVar1->pMonStatsTxt = (D2MonStatsTxt *)0x0;\n'));
    assert.ok(!printsConstantStore('  if (x == 0) return;\n'));
    assert.ok(!printsConstantStore('  x = y;\n'));
  });

  it('attaches the row by name and value, with no text gate', () => {
    const r = parseFunctionFacts(row('pMonStatsTxt:4:0:r')).rows.get('004ae0a0')!;
    assert.strictEqual(r.storeRow, 'pMonStatsTxt:4:0:r');
    // The F row's text hash does not match TEXT: the row still attaches.
    assert.deepStrictEqual(selectFacts(TEXT, '004ae0a0', r, false).registerStores, [{ name: 'pMonStatsTxt', size: 4, value: 0, register: true }]);
    assert.strictEqual(selectFacts('void f(void)\n{\n  return;\n}\n', '004ae0a0', r, false).registerStores, undefined);
  });

  it('is a cached fact and part of the script', () => {
    assert.ok((FACT_KEYS as readonly string[]).includes('registerStores'));
    assert.ok(FUNCTION_FACTS_SCRIPT.includes(REGISTER_STORES_JAVA));
    assert.ok(FUNCTION_FACTS_SCRIPT.includes('out.append("K\\t")'));
    assert.ok(REGISTER_STORES_JAVA.includes('PcodeOp.STORE') && REGISTER_STORES_JAVA.includes('getRegister(1)'));
    assert.ok(REGISTER_STORES_JAVA.includes('khow = "k"') && REGISTER_STORES_JAVA.includes('getBaseRegister()'));
  });
});
