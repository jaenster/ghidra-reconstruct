import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { strlenDifferencePlugin, type StrlenDifferenceOptions } from '../builtins/strlen-difference.js';
import { transformGhidraCode } from '../../../index.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(code: string, rows: string[] = [], options: StrlenDifferenceOptions = {}): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = strlenDifferencePlugin.createTransformer({
    ...options,
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

describe('strlen-difference proof boundaries', () => {
  const scan = (result: string, declaration = 'char *p = s;') => P +
    ` int f(char *s) { ${declaration} p = p + strlen(p) + 1; ${result} }`;
  for (const type of ['bool', 'short', 'unsigned short', 'char', 'long long', 'double']) {
    it(`keeps ${type} casts whose subtraction is not a full-word length`, () => {
      assert.deepStrictEqual(run(scan(`return (${type})p - (${type})(s + 1);`)).sites, []);
    });
  }
  it('requires matching casts on both operands and keeps their declared result type', () => {
    assert.deepStrictEqual(run(scan('return (int)p - (unsigned)(s + 1);')).sites, []);
    assert.deepStrictEqual(run(scan('return (int)p - (short)(int)(s + 1);')).sites, []);
    const { out, sites } = run(scan('return (uintptr_t)p - (uintptr_t)(s + 1);'));
    assert.strictEqual(sites.length, 1);
    assert.ok(out.includes('(uintptr_t)strlen(s)'), out);
  });
  it('resolves actual typedefs before built-in alias spellings', () => {
    assert.deepStrictEqual(run('typedef bool BOOL; ' + scan('return (BOOL)p - (BOOL)(s + 1);')).sites, []);
    assert.deepStrictEqual(run(scan('return (Narrow)p - (Narrow)(s + 1);'), [], { typedefTargets: { Narrow: 'short' } }).sites, []);
    const { sites } = run('typedef unsigned int Length; ' + scan('return (Length)p - (Length)(s + 1);'));
    assert.strictEqual(sites.length, 1);
  });
  for (const declaration of ['char *volatile p = s;', 'volatile char *p = s;']) {
    it(`keeps observable accesses in ${declaration}`, () => {
      assert.deepStrictEqual(run(scan('return (intptr_t)p - (intptr_t)(s + 1);', declaration)).sites, []);
    });
  }
  it('keeps a volatile base binding, including one hidden behind a typedef', () => {
    const source = scan('return (intptr_t)p - (intptr_t)(s + 1);');
    assert.deepStrictEqual(run(source.replace('f(char *s)', 'f(char *volatile s)')).sites, []);
    assert.deepStrictEqual(run(('typedef char *volatile String; ' + source).replace('f(char *s)', 'f(String s)')).sites, []);
  });
  for (const result of [
    'return (s[0] = 0, (intptr_t)p - (intptr_t)(s + 1));',
    'return (Fill(s), (intptr_t)p - (intptr_t)(s + 1));',
    'Show((Fill(s), (intptr_t)p - (intptr_t)(s + 1)));',
    'Show((intptr_t)p - (intptr_t)(s + 1) + Mutate(s));',
    'return (intptr_t)p - (intptr_t)(s++ + 1);',
  ]) {
    it(`keeps the scan before a possibly mutating consumer: ${result}`, () => {
      assert.deepStrictEqual(run('int Mutate(char *); ' + scan(result)).sites, []);
    });
  }
  it('keeps class conversions and overloaded operators out of the purity proof', () => {
    const source = 'struct Unknown { operator int(); }; Unknown x; ' + scan('return x + ((intptr_t)p - (intptr_t)(s + 1));');
    assert.deepStrictEqual(run(source).sites, []);
    const convert = 'struct Convert { Convert(int); }; void Consume(Convert, int); ' + scan('Consume(0, (intptr_t)p - (intptr_t)(s + 1));');
    assert.deepStrictEqual(run(convert).sites, []);
  });
  it('does not trust a shadowed function name or duplicate local name', () => {
    assert.deepStrictEqual(run(scan('Show((intptr_t)p - (intptr_t)(s + 1));').replace('char *p = s;', 'int Show; char *p = s;')).sites, []);
    assert.deepStrictEqual(run(scan('return (intptr_t)p - (intptr_t)(s + 1);').replace('char *p = s;', 'int p; { char *p; } char *p = s;')).sites, []);
  });
  it('keeps the Boolean-cast and volatile-pointer scans through the full pipeline', () => {
    for (const code of [scan('return (bool)p - (bool)(s + 1);'), scan('return (intptr_t)p - (intptr_t)(s + 1);', 'char *volatile p = s;')]) {
      const out = flat(transformGhidraCode(code, { preset: 'full', usePluginRegistry: true, tolerateErrors: false }).code);
      assert.ok(out.includes('strlen(p)'), out);
    }
  });
  it('preserves compiled results for guarded and cancelled scans', { skip: !hasNativeGpp() }, () => {
    const cases = [
      'intptr_t f(char *s) { char *p=s; p=p+strlen(p)+1; return (intptr_t)p-(intptr_t)(s+1); }',
      'uintptr_t f(char *s) { char *p=s; p=p+strlen(p)+1; return (uintptr_t)p-(uintptr_t)(s+1); }',
      'int f(char *s) { char *p=s; p=p+strlen(p)+1; return (bool)p-(bool)(s+1); }',
      'int f(char *s) { char *p=s; p=p+strlen(p)+1; return (short)(intptr_t)p-(short)(intptr_t)(s+1); }',
      'intptr_t f(char *s) { char *p=s; p=p+strlen(p)+1; return (s[0]=0,(intptr_t)p-(intptr_t)(s+1)); }',
      'intptr_t f(char *s) { char *volatile p=s; p=p+strlen(p)+1; return (intptr_t)p-(intptr_t)(s+1); }',
      'int f(char *s) { struct Frame { char name[128]; }; Frame frame; memcpy(frame.name,s,strlen(s)+1); char *p=frame.name; p=p+strlen(p)+1; return p!=frame.name+1; }',
    ];
    let prelude = '';
    const checks: string[] = [];
    for (const [i, code] of cases.entries()) {
      prelude += code.replace('f(', `before${i}(`) + '\n' + run(code).out.replace('f(', `after${i}(`) + '\n';
      checks.push(`for(unsigned k=0;k<128;++k)a[k]=b[k]=k<len?'A':0; errors += before${i}(a)!=after${i}(b);`);
    }
    const result = compileAndRun(prelude, 'unsigned errors=0; char a[128], b[128]; for(unsigned len=0;len<127;++len){' +
      checks.join('\n') + '} printf("%u\\n",errors);', { optimize: true });
    assert.strictEqual(result.trim(), '0');
  });
});

describe('strlen-difference char-array members', () => {
  const member = (base: string, prelude: string, parameter: string) => P + prelude +
    ` int f(${parameter}) { char *p = ${base}; p = p + strlen(p) + 1; return (intptr_t)p - (intptr_t)(${base} + 1); }`;
  it('cancels known struct and local-frame array addresses', () => {
    const { out, sites } = run(member('entry->name', 'struct Entry { char name[8]; };', 'Entry *entry'));
    assert.strictEqual(sites.length, 1);
    assert.ok(out.includes('(intptr_t)strlen(entry->name)'), out);
    assert.strictEqual(run(member('frame.name', 'struct Frame { char name[8]; };', 'Frame frame')).sites.length, 1);
    assert.strictEqual(run(P + ' int f() { struct Frame { char name[8]; }; Frame frame; char *p = frame.name; p = p + strlen(p) + 1; if (p != frame.name + 1) return 1; return 0; }').sites.length, 1);
  });
  it('uses exact aggregate fields supplied to a body-only wrapper', () => {
    const { out, sites } = run(member('entry->name', '', ''), [], {
      enclosingVarTypes: { entry: 'Entry *' }, structFields: { Entry: { name: 'char[8]' } },
    });
    assert.strictEqual(sites.length, 1);
    assert.ok(out.includes('strlen(entry->name)'), out);
  });
  for (const field of ['char *name;', 'volatile char name[8];']) {
    it(`declines the unsupported member declaration ${field}`, () => {
      assert.deepStrictEqual(run(member('entry->name', `struct Entry { ${field} };`, 'Entry *entry')).sites, []);
    });
  }
  it('requires the exact owner, operator and matching base', () => {
    assert.deepStrictEqual(run(member('entry->name', '', 'Entry *entry')).sites, []);
    assert.deepStrictEqual(run(member('entry.name', 'struct Entry { char name[8]; };', 'Entry *entry')).sites, []);
    assert.deepStrictEqual(run(member('entry->name', 'struct Entry { char name[8]; };', 'volatile Entry *entry')).sites, []);
    assert.deepStrictEqual(run(member('entry->name', 'struct Entry { char name[8]; char other[8]; };', 'Entry *entry').replace('(entry->name + 1)', '(entry->other + 1)')).sites, []);
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
