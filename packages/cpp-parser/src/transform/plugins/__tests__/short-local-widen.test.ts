import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { shortLocalWidenPlugin } from '../builtins/short-local-widen.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = shortLocalWidenPlugin.createTransformer({ onSite: (e: { variable: string }) => sites.push(e.variable) } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

const PRELUDE = 'struct Seq { short sequence; char mode; }; struct Slot { int nCount; };';

// TXT_AllocTxt_monseq, 00659c60, as printed.
const monseq = [
  'int f(Seq *pSeq, int n, Slot *pTbl) {',
  '  short nSeqId;',
  '  int i = 0;',
  '  do {',
  '    nSeqId = pSeq[i].sequence;',
  '    pTbl[nSeqId].nCount++;',
  '    i++;',
  '  } while (i < n);',
  '  return pTbl[nSeqId].nCount;',
  '}',
].join('\n');

describe('short-local-widen', () => {
  it('declares an index-only short int and casts its writes', () => {
    const { out, sites } = run(monseq);
    assert.deepStrictEqual(sites, ['nSeqId']);
    assert.ok(out.includes('int nSeqId;') && out.includes('nSeqId = (short int)pSeq[i].sequence;'), out);
  });

  it('leaves a short read any other way', () => {
    for (const use of ['return nSeqId < 3;', 'return g(nSeqId);', 'return nSeqId + 1;']) {
      assert.deepStrictEqual(run(monseq.replace('return pTbl[nSeqId].nCount;', use)).sites, [], use);
    }
  });

  it('leaves a short incremented, compound-assigned or addressed', () => {
    for (const w of ['nSeqId++;', 'nSeqId += 2;', 'short *p = &nSeqId;']) {
      assert.deepStrictEqual(run(monseq.replace('    i++;', `    i++;\n    ${w}`)).sites, [], w);
    }
  });

  it('indexes what the short indexed (compiled)', { skip: !hasNativeGpp() }, () => {
    const { out } = run(monseq);
    const prelude = [PRELUDE, monseq.replace('int f(', 'int before('), out.replace('int f(', 'int after(')].join('\n');
    const r = compileAndRun(prelude, [
      'Seq s[4] = {{1, 0}, {3, 0}, {1, 0}, {0, 0}};',
      'Slot a[4] = {}, b[4] = {};',
      'int x = before(s, 4, a), y = after(s, 4, b);',
      'printf("%d %d %d\\n", x == y, memcmp(a, b, sizeof a), x);',
    ].join('\n'));
    assert.strictEqual(r.trim(), '1 0 1');
  });
});
