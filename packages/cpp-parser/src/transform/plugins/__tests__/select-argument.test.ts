import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { selectArgumentPlugin } from '../builtins/select-argument.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = selectArgumentPlugin.createTransformer({ onSite: (e: { variable: string }) => sites.push(e.variable) });
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

describe('selectArgumentPlugin', () => {
  // WriteCrashReportProcessInfo 00407a80.
  it('writes a negated test as the select on its operand, the first store first', () => {
    const { out, sites } = run([
      'void f(Report *pReport, int bIsAdmin) {',
      '  const char *sz;',
      '  sz = "TRUE";',
      '  if (!bIsAdmin) {',
      '    sz = "FALSE";',
      '  }',
      '  Printf(pReport, "%s", sz);',
      '}',
    ].join('\n'));
    assert.deepStrictEqual(sites, ['sz']);
    assert.ok(out.includes('Printf(pReport, "%s", bIsAdmin ? "TRUE" : "FALSE");'), out);
    assert.ok(!out.includes('const char *sz'), out);
  });

  it('takes any other test as printed, the guarded store first, and casts a literal for a char *', () => {
    const { out } = run([
      'void f(int n) {',
      '  char *sz;',
      '  sz = gszPath;',
      '  if (n < 5) {',
      '    sz = "Unknown";',
      '  }',
      '  Log(sz);',
      '}',
    ].join('\n'));
    assert.ok(out.includes('Log(n < 5 ? (char*)"Unknown" : gszPath);'), out);
  });

  it('leaves a local read again, a constant outside its type, a call in the statement, or a store in the test', () => {
    const base = (decl: string, a: string, b: string, use: string, cond = '!c', after = '') => run([
      'void f(int c, int *p) {', `  ${decl};`, `  v = ${a};`, `  if (${cond}) {`, `    v = ${b};`, '  }', `  ${use};`, after, '}',
    ].join('\n')).sites;
    assert.deepStrictEqual(base('int v', '1', '2', 'g(p[0], v)'), ['v']);
    assert.deepStrictEqual(base('int v', '1', '2', 'g(p[0], v)', '!c', 'h(v);'), []);
    assert.deepStrictEqual(base('uint8_t v', '1', '-1', 'g(p[0], v)'), []);
    assert.deepStrictEqual(base('int v', '1', '2', 'g(k(), v)'), []);
    assert.deepStrictEqual(base('int v', '1', '2', 'g(p[0], v)', '!(c = 3)'), []);
    assert.deepStrictEqual(base('int v', '1', '2', 'g(p[0], v + 1)'), []);
    assert.deepStrictEqual(base('int v', 'c', '2', 'g(p[0], v)'), []);
  });

  it('leaves a local still live on a loop path', () => {
    const { sites } = run([
      'void f(int c, int n) {',
      '  int v;',
      '  v = 0;',
      '  do {',
      '    g(v);',
      '    v = 1;',
      '    if (!c) {',
      '      v = 2;',
      '    }',
      '    g(v);',
      '  } while (--n);',
      '}',
    ].join('\n'));
    assert.deepStrictEqual(sites, []);
  });

  it('computes what the printed form computed', { skip: !hasNativeGpp() }, () => {
    const printed = [
      'int g(int a, int b) { return a * 1000 + b; }',
      'int p(int c, int k) { int v; v = 7; if (!c) { v = -3; } return g(k, v); }',
    ].join('\n');
    const { out } = run('int q(int c, int k) { int v; v = 7; if (!c) { v = -3; } return g(k, v); }');
    // A return is no call statement: the pass leaves it, so test the call statement form.
    assert.ok(out.includes('v = 7'), out);
    const call = run('void q(int c, int k, int *r) { int v; v = 7; if (!c) { v = -3; } *r = g(k, v); }').out;
    assert.ok(call.includes('*r = g(k, c ? 7 : -3);'), call);
    const res = compileAndRun(`#include <cstdio>\n${printed}\n${call}`,
      'int bad = 0; for (int c = -2; c <= 2; c++) { int r; q(c, 5, &r); if (r != p(c, 5)) bad++; } printf("%d\\n", bad);');
    assert.strictEqual(res.trim(), '0');
  });
});
