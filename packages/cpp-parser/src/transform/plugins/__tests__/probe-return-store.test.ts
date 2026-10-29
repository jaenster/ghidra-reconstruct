import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { probeReturnStorePlugin } from '../builtins/probe-return-store.js';

function run(code: string, returnAddresses: number[] = [0x454add]): { out: string; sites: { value: number; kept?: string }[] } {
  const sites: { value: number; kept?: string }[] = [];
  const t = probeReturnStorePlugin.createTransformer({ returnAddresses, onSite: (e: { value: number; kept?: string }) => sites.push(e) } as never);
  return { out: emit(t(parse(code)) as AnyNode).trim(), sites };
}

describe('probe-return-store - the stack probe return address is not a store of the source', () => {
  it('drops the store into a local nothing reads', () => {
    const { out, sites } = run(`void f(int a) {
  uint32_t nNameColor;
  nNameColor = 0x454add;
  g(a);
}`);
    assert.ok(!out.includes('0x454add'), out);
    assert.ok(out.includes('uint32_t nNameColor;'), out);
    assert.deepStrictEqual(sites, [{ value: 0x454add }]);
  });

  it('turns an initialiser into a bare declaration', () => {
    const { out } = run(`void f() {
  uint32_t dwSehHandlerAddr = 0x517c3f;
  g();
}`, [0x517c3f]);
    assert.ok(out.includes('uint32_t dwSehHandlerAddr;'), out);
    assert.ok(!out.includes('0x517c3f'), out);
  });

  it('drops it when both arms overwrite the local before reading it', () => {
    const { out } = run(`int f(int a, T *t) {
  T *pAffixTable;
  pAffixTable = (T *)0x454add;
  if (a) {
    pAffixTable = t->pSuffix;
  } else {
    pAffixTable = t->pPrefix;
  }
  return pAffixTable->n;
}`);
    assert.ok(!out.includes('0x454add'), out);
  });

  it('drops a store into part of a local spelled nowhere else', () => {
    const { out } = run(`void f() {
  S aFrames[0x80];
  aFrames[0x7f].a14[3] = 0x454add;
  g(1);
}`);
    assert.ok(!out.includes('0x454add'), out);
  });

  it('keeps a store whose value may be read', () => {
    for (const body of [
      // one arm only overwrites it
      `  T *p;\n  p = (T *)0x454add;\n  if (a) {\n    p = q;\n  }\n  use(p);`,
      // its address escapes
      `  int n;\n  n = 0x454add;\n  h(&n);`,
      // a loop could carry it round
      `  int n;\n  while (a) {\n    n = 0x454add;\n    use(n);\n  }`,
    ]) {
      const { out, sites } = run(`void f(int a, T *q) {\n${body}\n}`);
      assert.ok(out.includes('0x454add'), out);
      assert.ok(sites[0]?.kept, JSON.stringify(sites));
    }
  });

  it('leaves other constants, globals and parameters alone', () => {
    const code = `void f(int a) {
  int n;
  n = 0x454ade;
  gGlobal = 0x454add;
  a = 0x454add;
  g(n, a);
}`;
    const { out, sites } = run(code);
    assert.strictEqual(out, emit(parse(code) as AnyNode).trim());
    assert.deepStrictEqual(sites, []);
  });
});
