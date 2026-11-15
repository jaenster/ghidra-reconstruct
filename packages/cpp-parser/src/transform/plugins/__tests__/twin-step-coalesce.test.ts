import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { twinStepCoalescePlugin } from '../builtins/twin-step-coalesce.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = twinStepCoalescePlugin.createTransformer({ onSite: (e: { variable: string; into: string }) => sites.push(`${e.variable}->${e.into}`) } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

const PRELUDE = 'unsigned Len(const char* p) { unsigned n = 0; while (p[n]) n++; return n; }';

// Name, BNGatewayAccess 005180a0, as printed.
const name = [
  'const char* f(const char* pEntry) {',
  '  unsigned nLen;',
  '  const char* szZone;',
  '  if (*pEntry != 0) {',
  '    nLen = Len(pEntry);',
  '    szZone = pEntry + nLen + 1;',
  '    pEntry = pEntry + nLen + 1;',
  '    if (*szZone != 0) {',
  '      nLen = Len(pEntry);',
  '      return pEntry + nLen + 1;',
  '    }',
  '  }',
  '  return pEntry;',
  '}',
].join('\n');

describe('twin-step-coalesce', () => {
  it('folds the twin into the stepped pointer', () => {
    const { out, sites } = run(name);
    assert.deepStrictEqual(sites, ['szZone->pEntry']);
    assert.ok(out.includes('pEntry = pEntry + nLen + 1; if (*pEntry != 0)'), out);
    assert.ok(!out.includes('szZone'), out);
  });

  it('leaves a twin read after the pointer moves again', () => {
    const code = name.replace('      return pEntry + nLen + 1;', '      pEntry = pEntry + nLen + 1;\n      return szZone;');
    const { out, sites } = run(code);
    assert.deepStrictEqual(sites, []);
    assert.ok(out.includes('szZone = pEntry + nLen + 1; pEntry = pEntry + nLen + 1;'), out);
  });

  // TRANSTBL_UnicodeToSingleByte 006c77f0: the twin's name also lives an unrelated life.
  it('rewrites one life of a name Ghidra reuses', () => {
    const code = [
      'int h(const unsigned short* pThis, int n) {',
      '  const unsigned short* pEntry;',
      '  int r = 0;',
      '  unsigned short c = *pThis;',
      '  while (c != 0 && n != 0) {',
      '    pEntry = pThis + 3;',
      '    r += *pEntry;',
      '    pEntry = pThis + 1;',
      '    pThis = pThis + 1;',
      '    n--;',
      '    c = *pEntry;',
      '  }',
      '  return r;',
      '}',
    ].join('\n');
    const { out, sites } = run(code);
    assert.deepStrictEqual(sites, ['pEntry->pThis']);
    assert.ok(out.includes('pThis = pThis + 1; n--; c = *pThis;'), out);
    assert.ok(out.includes('pEntry = pThis + 3; r += *pEntry;'), out);
  });

  it('computes the same values natively', { skip: !hasNativeGpp() }, () => {
    const main = 'const char s[] = "ab\\0cde\\0f\\0"; printf("%d %d %d\\n", (int)(f(s) - s), (int)(f(s + 3) - s), (int)(f(s + 8) - s));';
    assert.strictEqual(compileAndRun(`${PRELUDE}\n${run(name).out}`, main), compileAndRun(`${PRELUDE}\n${name}`, main));
  });
});
