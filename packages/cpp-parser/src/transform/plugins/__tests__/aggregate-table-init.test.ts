import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { aggregateTableInitPlugin } from '../builtins/aggregate-table-init.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const native = { skip: !hasNativeGpp() };

const f = (name: string, offset: number, size: number, type: string, bitSize?: number) =>
  ({ name, offset, size, type, ...(bitSize !== undefined ? { bitSize } : {}) });

// D2BinFieldInputStrc, packed: 20 bytes, no padding.
const tables = {
  structLayouts: {
    D2Row: [
      f('szName', 0, 4, 'char *'), f('eType', 4, 4, 'eT'), f('nSize', 8, 4, 'size_t'),
      f('nOffset', 0xc, 4, 'int'), f('fpLinker', 0x10, 4, 'void *'),
    ],
    D2Gap: [f('a', 0, 4, 'int'), f('b', 8, 4, 'int')],
    D2Union: [f('a', 0, 4, 'int'), f('b', 0, 4, 'int')],
    D2Bits: [f('a', 0, 4, 'int'), f('flag', 4, 4, 'int:1', 1)],
    D2Nested: [f('a', 0, 4, 'int'), f('aw', 4, 8, 'int[2]')],
    D2Byte: [f('c', 0, 1, 'uint8_t'), f('s', 1, 1, 'char')],
  },
  aggregateSizes: { D2Row: 20, D2Gap: 12, D2Union: 4, D2Bits: 8, D2Nested: 12, D2Byte: 2 },
  typedefTargets: { D2RowAlias: 'D2Row' },
  enumValues: { FT_END: 0, FT_ASCII: 1, FT_INT: 5, FT_LINK: 0x14 },
  functionNames: ['Linker', 'Sink'],
};

function rewrite(code: string, extra: Record<string, unknown> = {}): string {
  const ast = parse(code);
  return emit(aggregateTableInitPlugin.createTransformer({ ...tables, ...extra })(ast) as AnyNode);
}
const flat = (s: string) => s.replace(/\s+/g, ' ');

const ROW = (t: string, i: number, name: string, type: string, size: string, off: string, link: string) =>
  `${t}[${i}].szName = "${name}"; ${t}[${i}].eType = ${type}; ${t}[${i}].nSize = ${size}; `
  + `${t}[${i}].nOffset = ${off}; ${t}[${i}].fpLinker = ${link};`;

// TXT_LoadCharTemplateTxt's shape: one store hoisted out of its row, a link read
// through a pointer, a function as linker, and a store after the table escapes.
const LOADER = `void Load(int nCount) {
  D2Row t[3];
  t[1].fpLinker = &gpData->pLink;
  ${ROW('t', 0, 'name', 'FT_ASCII', '0x1e', '0', '0')}
  t[1].szName = "class"; t[1].eType = FT_LINK; t[1].nSize = 0; t[1].nOffset = 0x1f;
  ${ROW('t', 2, 'end', 'FT_END', '0', '0', '(void*)Linker')}
  Sink(t, nCount);
  t[0].nSize = 5;
  Sink(t, nCount);
}`;

describe('aggregateTableInitPlugin', () => {
  it('turns a field table into one initialiser in element and member order', () => {
    const out = rewrite(LOADER);
    assert.match(flat(out), /D2Row t\[3\] = \{ \{"name", FT_ASCII, 0x1e, 0, 0\}, \{"class", FT_LINK, 0, 0x1f, &gpData->pLink\}, \{"end", FT_END, 0, 0, \(void\*\)Linker\} \};/);
    assert.ok(!/t\[1\]\.fpLinker =/.test(out), out);
    assert.ok(!/D2Row t\[3\];/.test(out), out);
    // The store after the escape stays.
    assert.match(flat(out), /Sink\(t, nCount\); t\[0\]\.nSize = 5; Sink\(t, nCount\);/);
    // One row per line.
    assert.match(out, /= \{\n\s+\{"name"/);
  });

  it('resolves the element through a typedef and keeps the last of two stores', () => {
    const out = rewrite(`void f() { D2RowAlias t[2]; t[0].nSize = 7; ${ROW('t', 0, 'a', 'FT_INT', '3', '4', '0')} ${ROW('t', 1, 'end', 'FT_END', '0', '0', '0')} Sink(t, 2); }`);
    assert.match(flat(out), /D2RowAlias t\[2\] = \{ \{"a", FT_INT, 3, 4, 0\}, \{"end", FT_END, 0, 0, 0\} \};/);
  });

  it('keeps unrelated statements in place between the stores', () => {
    const out = rewrite(`void f() { D2Row t[2]; int n; ${ROW('t', 0, 'a', 'FT_INT', '3', '4', '0')} n = 4; gCount = 1; ${ROW('t', 1, 'end', 'FT_END', '0', '0', '0')} Sink(t, n); }`);
    assert.match(flat(out), /int n; D2Row t\[2\] = \{.*\}; n = 4; gCount = 1; Sink\(t, n\);/);
  });

  it('refuses when a member of some element is never stored', () => {
    const out = rewrite(`void f() { D2Row t[2]; ${ROW('t', 0, 'a', 'FT_INT', '3', '4', '0')} t[1].szName = "end"; t[1].eType = FT_END; t[1].nSize = 0; t[1].nOffset = 0; Sink(t, 2); }`);
    assert.match(out, /D2Row t\[2\];/);
  });

  it('refuses when the table escapes before it is complete', () => {
    const out = rewrite(`void f() { D2Row t[2]; ${ROW('t', 0, 'a', 'FT_INT', '3', '4', '0')} Sink(t, 1); ${ROW('t', 1, 'end', 'FT_END', '0', '0', '0')} Sink(t, 2); }`);
    assert.match(out, /D2Row t\[2\];/);
  });

  it('refuses a constant the member cannot hold, which a braced initialiser rejects', () => {
    const out = rewrite(`void f() { D2Row t[2]; ${ROW('t', 0, 'a', 'FT_INT', '-1', '4', '0')} ${ROW('t', 1, 'end', 'FT_END', '0', '0', '0')} Sink(t, 2); }`);
    assert.match(out, /D2Row t\[2\];/);
    const signed = rewrite(`void f() { D2Row t[2]; ${ROW('t', 0, 'a', 'FT_INT', '0', '-1', '0')} ${ROW('t', 1, 'end', 'FT_END', '0', '0', '0')} Sink(t, 2); }`);
    assert.match(flat(signed), /\{"a", FT_INT, 0, -1, 0\}/);
  });

  it('refuses a value that reads a local or calls', () => {
    const local = rewrite(`void f(int n) { D2Row t[2]; ${ROW('t', 0, 'a', 'FT_INT', 'n', '4', '0')} ${ROW('t', 1, 'end', 'FT_END', '0', '0', '0')} Sink(t, 2); }`);
    assert.match(local, /D2Row t\[2\];/);
    const call = rewrite(`void f() { D2Row t[2]; ${ROW('t', 0, 'a', 'FT_INT', 'g()', '4', '0')} ${ROW('t', 1, 'end', 'FT_END', '0', '0', '0')} Sink(t, 2); }`);
    assert.match(call, /D2Row t\[2\];/);
    const global = rewrite(`void f() { D2Row t[2]; ${ROW('t', 0, 'a', 'FT_INT', 'gnSize', '4', '0')} ${ROW('t', 1, 'end', 'FT_END', '0', '0', '0')} Sink(t, 2); }`);
    assert.match(global, /D2Row t\[2\];/);
  });

  it('refuses a pointer read when a call before its store could move the pointer', () => {
    const out = rewrite(`void f() { D2Row t[2]; ${ROW('t', 0, 'a', 'FT_INT', '0', '4', '0')} Reload(); ${ROW('t', 1, 'end', 'FT_END', '0', '0', '&gpData->pLink')} Sink(t, 2); }`);
    assert.match(out, /D2Row t\[2\];/);
    const after = rewrite(`void f() { D2Row t[2]; ${ROW('t', 0, 'a', 'FT_INT', '0', '4', '&gpData->pLink')} Reload(); ${ROW('t', 1, 'end', 'FT_END', '0', '0', '0')} Sink(t, 2); }`);
    assert.match(flat(after), /D2Row t\[2\] = \{.*\}; Reload\(\);/);
  });

  it('accepts the address of a local declared before the run, refuses one declared inside it', () => {
    const before = rewrite(`void f() { void *pLink; D2Row t[2]; ${ROW('t', 0, 'a', 'FT_INT', '0', '4', '&pLink')} ${ROW('t', 1, 'end', 'FT_END', '0', '0', '0')} Sink(t, 2); }`);
    assert.match(flat(before), /D2Row t\[2\] = \{ \{"a", FT_INT, 0, 4, &pLink\}/);
    const inside = rewrite(`void f() { D2Row t[2]; ${ROW('t', 0, 'a', 'FT_INT', '0', '4', '0')} void *pLink; ${ROW('t', 1, 'end', 'FT_END', '0', '0', '&pLink')} Sink(t, 2); }`);
    assert.match(inside, /D2Row t\[2\];/);
  });

  it('refuses an element that is not a plain gap-free record', () => {
    for (const [ty, stores] of [
      ['D2Gap', 't[0].a = 1; t[0].b = 2; t[1].a = 3; t[1].b = 4;'],
      ['D2Union', 't[0].a = 1; t[0].b = 2; t[1].a = 3; t[1].b = 4;'],
      ['D2Bits', 't[0].a = 1; t[0].flag = 1; t[1].a = 3; t[1].flag = 0;'],
      ['D2Nested', 't[0].a = 1; t[0].aw[0] = 2; t[0].aw[1] = 2; t[1].a = 3; t[1].aw[0] = 4; t[1].aw[1] = 4;'],
    ]) {
      const out = rewrite(`void f() { ${ty} t[2]; ${stores} g(t); }`);
      assert.match(out, new RegExp(`${ty} t\\[2\\];`), ty);
    }
  });

  it('checks byte members against their own range', () => {
    const ok = rewrite('void f() { D2Byte t[2]; t[0].c = 0xff; t[0].s = -1; t[1].c = 0; t[1].s = 0x7f; g(t); }');
    assert.match(flat(ok), /D2Byte t\[2\] = \{ \{0xff, -1\}, \{0, 0x7f\} \};/);
    const wide = rewrite('void f() { D2Byte t[2]; t[0].c = 0x100; t[0].s = 0; t[1].c = 0; t[1].s = 0; g(t); }');
    assert.match(wide, /D2Byte t\[2\];/);
    const neg = rewrite('void f() { D2Byte t[2]; t[0].c = 0; t[0].s = 0x80; t[1].c = 0; t[1].s = 0; g(t); }');
    assert.match(neg, /D2Byte t\[2\];/);
  });

  it('refuses a single-element array', () => {
    const out = rewrite(`void f() { D2Row t[1]; ${ROW('t', 0, 'a', 'FT_INT', '0', '4', '0')} Sink(t, 1); }`);
    assert.match(out, /D2Row t\[1\];/);
  });

  it('refuses when a goto from before the run lands after it', () => {
    const out = rewrite(`void f(int c) { D2Row t[2]; if (c) goto L; ${ROW('t', 0, 'a', 'FT_INT', '0', '4', '0')} ${ROW('t', 1, 'end', 'FT_END', '0', '0', '0')} L: Sink(t, 2); }`);
    assert.match(out, /D2Row t\[2\];/);
  });

  it('allows a goto that stays after the declaration', () => {
    const out = rewrite(`void f(int c) { D2Row t[2]; ${ROW('t', 0, 'a', 'FT_INT', '0', '4', '0')} ${ROW('t', 1, 'end', 'FT_END', '0', '0', '0')} if (c) goto L; Sink(t, 2); L: return; }`);
    assert.match(flat(out), /D2Row t\[2\] = \{/);
  });

  it('refuses when a case label of an enclosing switch follows the run', () => {
    const out = rewrite(`void f(int c) { D2Row t[2]; switch (c) { case 1: ${ROW('t', 0, 'a', 'FT_INT', '0', '4', '0')} ${ROW('t', 1, 'end', 'FT_END', '0', '0', '0')} Sink(t, 2); case 2: break; } }`);
    assert.match(out, /D2Row t\[2\];/);
  });

  it('refuses when a use lies outside the block of the run', () => {
    const out = rewrite(`void f(int c) { D2Row t[2]; if (c) { ${ROW('t', 0, 'a', 'FT_INT', '0', '4', '0')} ${ROW('t', 1, 'end', 'FT_END', '0', '0', '0')} } Sink(t, 2); }`);
    assert.match(out, /D2Row t\[2\];/);
  });

  it('without layouts changes nothing', () => {
    const out = rewrite(LOADER, { structLayouts: {} });
    assert.match(out, /D2Row t\[3\];/);
  });
});

describe('aggregateTableInitPlugin: compiled, every byte of every row', () => {
  const PRELUDE = [
    'enum eT { FT_END = 0, FT_ASCII = 1, FT_INT = 5, FT_LINK = 0x14 };',
    '#pragma pack(push, 1)',
    'struct D2Row { char *szName; eT eType; size_t nSize; int nOffset; void *fpLinker; };',
    'struct D2Byte { uint8_t c; char s; };',
    '#pragma pack(pop)',
    'struct Data { void *pLink; void *pOther; };',
    'Data gData; Data gAlt; Data *gpData = &gData; int gCount;',
    'int Linker(int) { return 0; }',
    'void Reload() { gpData = &gAlt; }',
    'static char gOut[8192]; static size_t gLen;',
    // Strings by content (two spellings of a literal need not share an address),
    // everything else as raw bytes.
    'void Sink(D2Row *t, int n) {',
    '  for (int i = 0; i < n; i++) {',
    '    gLen += sprintf(gOut + gLen, "%s|", t[i].szName);',
    '    const unsigned char *p = (const unsigned char *)&t[i] + sizeof(char *);',
    '    for (size_t b = 0; b < sizeof(D2Row) - sizeof(char *); b++) gLen += sprintf(gOut + gLen, "%02x", p[b]);',
    '    gLen += sprintf(gOut + gLen, ";");',
    '  }',
    '  gLen += sprintf(gOut + gLen, "\\n");',
    '}',
    'void g(D2Byte *t) { for (int i = 0; i < 2; i++) gLen += sprintf(gOut + gLen, "%02x%02x;", t[i].c, (unsigned char)t[i].s); }',
    // Garbage where the table will sit, so an unwritten member cannot pass by luck.
    'void Dirty() { volatile unsigned char a[4096]; for (int i = 0; i < 4096; i++) a[i] = (unsigned char)(0xa5 ^ i); }',
  ].join('\n');

  const compare = (code: string, call: string) => {
    const lowered = rewrite(code);
    assert.ok(lowered.includes('= {'), lowered);
    const prelude = [PRELUDE, `namespace ref { ${code} }`, `namespace low { ${lowered} }`].join('\n');
    const body = [
      'static char a[8192], b[8192];',
      `gLen = 0; gpData = &gData; Dirty(); ref::${call}; memcpy(a, gOut, gLen + 1);`,
      `gLen = 0; gpData = &gData; Dirty(); low::${call}; memcpy(b, gOut, gLen + 1);`,
      'printf("%d\\n%s", strcmp(a, b) != 0, a);',
    ].join('\n');
    const out = compileAndRun(prelude, body);
    assert.strictEqual(out.split('\n')[0], '0', `${lowered}\n${out}`);
    return out;
  };

  it('the loader table, with a hoisted store, a pointer-read link and a later store', native, () => {
    const out = compare(LOADER, 'Load(3)');
    assert.match(out, /name\|.*class\|.*end\|/);
  });

  it('a link read before a call that moves the pointer', native, () => {
    compare(`void f() { D2Row t[2]; ${ROW('t', 0, 'a', 'FT_INT', '0', '4', '&gpData->pLink')} Reload(); ${ROW('t', 1, 'end', 'FT_END', '0x3b', '-1', '&gpData->pOther')} Sink(t, 2); }`.replace('&gpData->pOther', '&gData.pOther'), 'f()');
  });

  it('two interleaved tables', native, () => {
    compare(`void f() { D2Row t[2]; D2Row u[2]; u[1].nSize = 9; ${ROW('t', 0, 'a', 'FT_INT', '1', '2', '(void*)Linker')} ${ROW('u', 0, 'x', 'FT_LINK', '3', '4', '&gData.pLink')}
      ${ROW('t', 1, 'end', 'FT_END', '0', '0', '0')} u[1].szName = "end"; u[1].eType = FT_END; u[1].nOffset = 0; u[1].fpLinker = 0; Sink(t, 2); Sink(u, 2); }`, 'f()');
  });

  it('byte members at the edges of their range', native, () => {
    compare('void f() { D2Byte t[2]; t[1].s = 0x7f; t[0].c = 0xff; t[0].s = -1; t[1].c = 0; g(t); }', 'f()');
  });
});
