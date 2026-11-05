import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { decidedBoolReturnPlugin } from '../builtins/decided-bool-return.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(src: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = decidedBoolReturnPlugin.createTransformer({ onSite: (e: { variable: string; value: boolean }) => sites.push(`${e.variable}=${e.value}`) });
  return { out: flat(emit(t(parse(src)) as AnyNode)), sites };
}

// D2FILE_CreateProcess 00516d8b, after early-return made the guard.
const SITE = [
  'bool f(char *szText) {',
  '  int bCreated = CreateProcessA(szText);',
  '  if (!bCreated) {',
  '    return bCreated != 0;',
  '  }',
  '  CloseHandle(a);',
  '  CloseHandle(b);',
  '  return bCreated != 0;',
  '}',
].join('\n');

describe('decided-bool-return', () => {
  it('writes the constant on the guard arm and after it', () => {
    const r = run(SITE);
    assert.deepStrictEqual(r.sites, ['bCreated=false', 'bCreated=true']);
    assert.ok(r.out.includes('if (!bCreated) { return false; } CloseHandle(a); CloseHandle(b); return true; }'), r.out);
  });

  it('takes `v == 0` and an arm that is the return itself', () => {
    const r = run(SITE.replace('if (!bCreated) {\n    return bCreated != 0;\n  }', 'if (bCreated == 0) return bCreated != 0;'));
    assert.deepStrictEqual(r.sites, ['bCreated=false', 'bCreated=true']);
    assert.ok(r.out.includes('return false;') && r.out.includes('return true; }'), r.out);
  });

  it('leaves a function that does not return bool', () => {
    assert.deepStrictEqual(run(SITE.replace('bool f', 'int f')).sites, []);
  });

  it('stops at a store to v between the guard and the return', () => {
    const r = run(SITE.replace('CloseHandle(b);', 'bCreated = g();'));
    assert.deepStrictEqual(r.sites, ['bCreated=false']);
    assert.ok(r.out.endsWith('return bCreated != 0; }'), r.out);
  });

  it('stops at a label between the guard and the return', () => {
    assert.deepStrictEqual(run(SITE.replace('CloseHandle(b);', 'L1: CloseHandle(b);')).sites, ['bCreated=false']);
  });

  it('leaves the after-return when the arm can fall through', () => {
    const r = run(SITE.replace('return bCreated != 0;\n  }', 'g();\n  }'));
    assert.deepStrictEqual(r.sites, []);
  });

  it('leaves the arm when it stores to v first', () => {
    const r = run(SITE.replace('if (!bCreated) {\n', 'if (!bCreated) {\n    bCreated = h();\n'));
    assert.deepStrictEqual(r.sites, ['bCreated=true']);
    assert.ok(r.out.includes('bCreated = h(); return bCreated != 0; }'), r.out);
  });

  it('leaves a variable whose address is taken', () => {
    assert.deepStrictEqual(run(SITE.replace('CloseHandle(a);', 'CloseHandle(&bCreated);')).sites, []);
  });

  it('leaves a global', () => {
    assert.deepStrictEqual(run(SITE.replace('int bCreated = CreateProcessA(szText);', 'gb = CreateProcessA(szText);').replace(/bCreated/g, 'gb')).sites, []);
  });
});
