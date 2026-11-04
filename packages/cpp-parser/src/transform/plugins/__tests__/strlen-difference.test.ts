import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { strlenDifferencePlugin } from '../builtins/strlen-difference.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string, rows: string[] = []): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = strlenDifferencePlugin.createTransformer({
    compareSites: rows.join('\n'),
    onSite: (e: { pointer: string; form: string }) => sites.push(`${e.pointer}:${e.form}`),
  } as never);
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

const P = 'unsigned strlen(const char *); void Fill(char *); void Show(int);';
// CHATDLG_UpdateChannelOkButtonState 0043e660, row 2 as extracted.
const row2 = ['2', '!=', 'INT_NOTEQUAL', '4', '-1', '-', 'v:pcCur', 'e', '0043e69b', '0043e69e', 'JC', '0043e69b', 'CMP', '4', 'r', 'i', '1', '1'].join('\t');
const chat = P + ' void f() { char szText[32]; int b = 0; Fill(szText); char *pcCur; pcCur = szText; pcCur = pcCur + strlen(pcCur) + 1; if (pcCur != szText + 1) { b = 1; } Show(b); }';

describe('strlen-difference', () => {
  it('cancels the difference, spelled as the CMP with 1 (CHATDLG_UpdateChannelOkButtonState)', () => {
    const { out, sites } = run(chat, [row2]);
    assert.deepStrictEqual(sites, ['pcCur:one']);
    assert.ok(out.includes('char* pcCur; if (strlen(szText) >= 1) { b = 1; }'), out);
  });

  it('writes the zero spelling without a row', () => {
    const { out } = run(chat.replace('!=', '=='));
    assert.ok(out.includes('if (strlen(szText) == 0) {'), out);
  });

  it('cancels a length difference', () => {
    const { out, sites } = run(P + ' int f(char *s) { char *p = s; p = p + strlen(p) + 1; return (int)p - (int)(s + 1); }');
    assert.deepStrictEqual(sites, ['p:zero']);
    assert.ok(out.includes('char* p; return (int)strlen(s);'), out);
  });

  it('leaves a pointer read again later', () => {
    const { sites } = run(P + ' char *f(char *s) { char *p = s; p = p + strlen(p) + 1; if (p != s + 1) { Show(1); } return p; }');
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a use that is not the next statement', () => {
    const { sites } = run(P + ' void f(char *s) { char *p = s; p = p + strlen(p) + 1; Fill(s); if (p != s + 1) { Show(1); } }');
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a pointer compared against another string', () => {
    const { sites } = run(P + ' void f(char *s, char *t) { char *p = s; p = p + strlen(p) + 1; if (p != t + 1) { Show(1); } }');
    assert.deepStrictEqual(sites, []);
  });
});

describe('strlen-difference with a reused pointer', () => {
  it('cancels a scan whose pointer is reassigned before its next read (COMCALLBACK)', () => {
    const { out, sites } = run(P + ' void f(char *a, char *b) { char *p; p = a; p = p + strlen(p) + 1; if (p != a + 1) { p = b; p = p + strlen(p) + 1; Show((int)p - (int)(b + 1)); } }');
    assert.deepStrictEqual(sites, ['p:zero', 'p:zero']);
    assert.ok(out.includes('if (strlen(a) != 0) { Show((int)strlen(b)); }'), out);
  });

  it('leaves a scan whose end reaches a later read on another path', () => {
    const { sites } = run(P + ' int f(char *a, int k) { char *p; p = a; p = p + strlen(p) + 1; if (p != a + 1) { Show(1); } return (int)p; }');
    assert.deepStrictEqual(sites, []);
  });
});
