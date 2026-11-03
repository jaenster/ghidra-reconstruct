import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { inlinedStrcpyPlugin } from '../builtins/inlined-strcpy.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string): { out: string; sites: number } {
  let sites = 0;
  const t = inlinedStrcpyPlugin.createTransformer({ onSite: () => { sites++; } } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

// SOUND_LoadWavFile, 00514e10, as printed.
const wav = (after = '') => [
  'void f(char *szText, void *pEntry) {',
  '  char c;',
  '  int nOffset = (int)pEntry - (int)szText;',
  '  do {',
  '    c = *szText;',
  '    szText[nOffset] = c;',
  '    szText++;',
  "  } while (c != '\\0');",
  after,
  '}',
].join('\n');

describe('inlined-strcpy', () => {
  it('writes the offset loop as the strcpy call', () => {
    const { out, sites } = run(wav());
    assert.strictEqual(sites, 1);
    assert.ok(out.includes('strcpy((char*)pEntry, szText);'), out);
    assert.ok(!out.includes('nOffset') && !out.includes('do {'), out);
  });

  it('leaves the loop when the source pointer is read after it', () => {
    assert.strictEqual(run(wav('  *szText = 1;')).sites, 0);
  });

  it('leaves the loop when the byte is read after it', () => {
    assert.strictEqual(run(wav('  szText[-1] = c;')).sites, 0);
  });

  it('leaves the loop when the source moves between the offset and the loop', () => {
    const code = wav().replace('  do {', '  szText++;\n  do {');
    assert.strictEqual(run(code).sites, 0);
  });

  it('leaves a loop with two pointers: that loop is in the original source', () => {
    const code = [
      'void f(char *szDest, char *szSrc) {',
      '  char c;',
      '  do { c = *szSrc; *szDest = c; szSrc++; szDest++; } while (c != 0);',
      '}',
    ].join('\n');
    assert.strictEqual(run(code).sites, 0);
  });

  it('leaves a copy of a wider element', () => {
    const code = wav().replace('char *szText', 'short *szText').replace('char c;', 'short c;');
    assert.strictEqual(run(code).sites, 0);
  });

  it('keeps the declaration of an offset assigned again', () => {
    const code = wav('  nOffset = 3;\n  ((char *)pEntry)[0] = (char)nOffset;');
    const { out, sites } = run(code);
    assert.strictEqual(sites, 1);
    assert.ok(out.includes('int nOffset; strcpy((char*)pEntry, szText);'), out);
  });

  it('copies what the loop copies (compiled)', { skip: !hasNativeGpp() }, () => {
    const { out } = run(wav());
    const prelude = [wav().replace('void f(', 'void before('), out.replace('void f(', 'void after(')].join('\n');
    const r = compileAndRun(prelude, [
      'const char *s[] = {"", "a", "hello world"};',
      'for (int k = 0; k < 3; k++) {',
      '  char a[32], b[32]; char src[32]; memset(a, 7, 32); memset(b, 7, 32); strcpy(src, s[k]);',
      '  before(src, a); after(src, b);',
      '  printf("%d\\n", memcmp(a, b, 32));',
      '}',
    ].join('\n'));
    assert.strictEqual(r.trim(), '0\n0\n0');
  });
});
