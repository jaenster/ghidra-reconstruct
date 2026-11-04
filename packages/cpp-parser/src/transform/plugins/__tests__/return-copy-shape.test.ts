import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { returnCopySplitPlugin, returnCopyJoinPlugin } from '../builtins/return-copy-shape.js';
import type { TransformPlugin } from '../types.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(plugin: TransformPlugin, code: string): { out: string; sites: number } {
  let sites = 0;
  const t = plugin.createTransformer({ onSite: () => { sites++; } } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

const PRELUDE = 'int g_log; void Set(int v) { g_log = g_log * 10 + v; } int Next(int v) { return v * 3; }';

// Q02_SequenceFilter, 005910f0, as printed.
const seq = [
  'int f(int nState, int bIntro) {',
  '  if (!nState && bIntro == 1) {',
  '    Set(1);',
  '  } else if (nState == 5 || bIntro == 0) {',
  '    if (nState) {',
  '      return Next(nState);',
  '    }',
  '    return 0;',
  '  }',
  '  return 1;',
  '}',
].join('\n');

// D2WINANIMIMAGE_TryAdvanceToPlaying, 00500340, as printed.
const anim = [
  'int g(int nState) {',
  '  if (nState == 3) {',
  '    Set(4);',
  '    return 1;',
  '  }',
  '  if (nState != 2 && nState != 4) {',
  '    return 1;',
  '  }',
  '  return 0;',
  '}',
].join('\n');

describe('return-copy-split', () => {
  it('writes the return into the arm that falls into it', () => {
    const { out, sites } = run(returnCopySplitPlugin, seq);
    assert.strictEqual(sites, 1);
    assert.ok(out.includes('if (!nState && bIntro == 1) { Set(1); return 1; } if (nState == 5 || bIntro == 0) {'), out);
    assert.ok(out.endsWith('return 0; } return 1; }'), out);
  });

  it('leaves an arm that ends in an if (its exits fall into the return)', () => {
    const code = seq.replace('    Set(1);', '    if (bIntro) Set(1);');
    assert.strictEqual(run(returnCopySplitPlugin, code).sites, 0);
  });

  it('leaves a non-constant return', () => {
    assert.strictEqual(run(returnCopySplitPlugin, seq.replace('  return 1;\n}', '  return g_log;\n}')).sites, 0);
  });

  it('leaves a plain else', () => {
    const code = seq.replace('} else if (nState == 5 || bIntro == 0) {', '} else {');
    assert.strictEqual(run(returnCopySplitPlugin, code).sites, 0);
  });
});

describe('return-copy-join', () => {
  it('joins the arm and the guard returning the same constant', () => {
    const { out, sites } = run(returnCopyJoinPlugin, anim);
    assert.strictEqual(sites, 1);
    assert.ok(out.includes('if (nState == 3) { Set(4); } else if (!(nState != 2 && nState != 4)) { return 0; } return 1; }'), out);
  });

  it('leaves a guard returning another value than the arm', () => {
    assert.strictEqual(run(returnCopyJoinPlugin, anim.replace('    Set(4);\n    return 1;', '    Set(4);\n    return 0;')).sites, 0);
  });

  it('leaves a longer rest (a run of guards)', () => {
    const code = anim.replace('  return 0;\n}', '  Set(9);\n  return 0;\n}');
    assert.strictEqual(run(returnCopyJoinPlugin, code).sites, 0);
  });

  it('computes what the printed form computes (compiled)', { skip: !hasNativeGpp() }, () => {
    const a = run(returnCopySplitPlugin, seq).out, b = run(returnCopyJoinPlugin, anim).out;
    const prelude = [
      PRELUDE,
      seq.replace('int f(', 'int f0('), a.replace('int f(', 'int f1('),
      anim.replace('int g(', 'int g0('), b.replace('int g(', 'int g1('),
    ].join('\n');
    const r = compileAndRun(prelude, [
      'for (int s = -1; s < 7; s++) for (int i = -1; i < 3; i++) {',
      '  g_log = 0; int x = f0(s, i); int lx = g_log; g_log = 0; int y = f1(s, i); int ly = g_log;',
      '  printf("%d,%d/%d,%d\\n", x, lx, y, ly);',
      '}',
      'for (int s = -1; s < 7; s++) {',
      '  g_log = 0; int x = g0(s); int lx = g_log; g_log = 0; int y = g1(s); int ly = g_log;',
      '  printf("%d,%d/%d,%d\\n", x, lx, y, ly);',
      '}',
    ].join('\n'));
    for (const row of r.trim().split('\n')) {
      const [x, y] = row.split('/');
      assert.strictEqual(x, y, r);
    }
  });
});
