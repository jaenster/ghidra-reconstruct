import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseVc8FormTag, vc8FormSpec, vc8formBodyForm, vc8formBodyHash, vc8formHashRecord, vc8formLegacyBodyHash } from './vc8form-spec.js';
import { planRehash, rehashJava, rowsChecksum } from './vc8form-rehash.js';
import { applyVc8Forms, emit, parse, type TranslationUnit } from '@ghidra-mcp/cpp-parser';

const BODY = '\nvoid f(int a)\n\n{\n  g(a);\n  return;\n}\n';
const DH = vc8formBodyHash(BODY);
const tag = (form: string, size = 16, dh = DH) => ({ type: 'vc8form', data: `${form};ev=0123456789;bh=${size}-89abcdef;dh=${dh}` });

describe('vc8form-spec', () => {
  it('hashes the decompile with whitespace runs collapsed', () => {
    assert.strictEqual(vc8formBodyHash('a  b\n\tc'), vc8formBodyHash(' a b c '));
    assert.notStrictEqual(vc8formBodyHash('a b c'), vc8formBodyHash('a b d'));
  });

  it('reads the form and its evidence', () => {
    const t = parseVc8FormTag('seq(a.x,a.y);ev=0123456789;bh=16-89abcdef;dh=' + DH);
    assert.deepStrictEqual(t?.form, { op: 'seq', targets: ['a.x', 'a.y'] });
    assert.strictEqual(t?.size, 16);
    assert.strictEqual(t?.ev, '0123456789');
  });

  it('rejects a record without its evidence', () => {
    assert.strictEqual(parseVc8FormTag('seq(a.x,a.y)'), undefined);
    assert.strictEqual(parseVc8FormTag('seq(a.x,a.y);ev=01;bh=16-89abcdef;dh=' + DH), undefined);
    assert.strictEqual(parseVc8FormTag('nope(a);ev=0123456789;bh=16-89abcdef;dh=' + DH), undefined);
  });

  it('applies a current tag and leaves the other tags alone', () => {
    const spec = vc8FormSpec({ size: 16, decompiled: BODY, tags: [{ type: 'llm-named' }, tag('fold(t)')] });
    assert.deepStrictEqual(spec?.forms.map(f => f.form), [{ op: 'fold', name: 't' }]);
    assert.deepStrictEqual(spec?.stale, []);
  });

  it('holds back a tag whose function changed size or decompile', () => {
    const spec = vc8FormSpec({ size: 16, decompiled: BODY, tags: [tag('fold(t)', 20), tag('fold(u)', 16, '00000000')] });
    assert.deepStrictEqual(spec?.forms, []);
    assert.deepStrictEqual(spec?.stale.map(s => s.why), ['size 16, the tag measured 20', `decompile ${DH}, the tag measured 00000000`]);
  });

  it('orders the forms by op, not by the order Ghidra lists the tags', () => {
    const spec = vc8FormSpec({ size: 16, decompiled: BODY, tags: [tag('seq(b,a)'), tag('fold(t)'), tag('width(x,int)')] });
    assert.deepStrictEqual(spec?.forms.map(f => f.form.op), ['width', 'fold', 'seq']);
  });

  it('orders the shape forms: declarations, then control flow, then expressions, then moves', () => {
    const spec = vc8FormSpec({ size: 16, decompiled: BODY, tags: [tag('seq(b,a)'), tag('cmp(a < 4,lit)'), tag('dup(g(a))'), tag('nest(a)'), tag('split(v,int,w)')] });
    assert.deepStrictEqual(spec?.forms.map(f => f.form.op), ['split', 'dup', 'nest', 'cmp', 'seq']);
  });

  it('reads the ord field, and rejects one that is not a positive integer', () => {
    assert.strictEqual(parseVc8FormTag(`seq(a,b);ev=0123456789;bh=16-89abcdef;dh=${DH};ord=2`)?.order, 2);
    assert.strictEqual(parseVc8FormTag(`seq(a,b);ev=0123456789;bh=16-89abcdef;dh=${DH}`)?.order, undefined);
    for (const bad of ['0', '-1', 'x', '']) assert.strictEqual(parseVc8FormTag(`seq(a,b);ev=0123456789;bh=16-89abcdef;dh=${DH};ord=${bad}`), undefined, bad);
  });

  it('orders the tags of one op by ord before their text, after the ones without', () => {
    const o = (form: string, n: number) => ({ type: 'vc8form', data: tag(form).data + ';ord=' + n });
    const spec = vc8FormSpec({ size: 16, decompiled: BODY, tags: [o('seq(a,b)', 2), tag('fold(t)'), tag('seq(c,d)'), o('seq(x,y)', 1), tag('seq(b,a)')] });
    assert.deepStrictEqual(spec?.forms.map(f => f.tag.split(';')[0]), ['fold(t)', 'seq(b,a)', 'seq(c,d)', 'seq(x,y)', 'seq(a,b)']);
    // ord does not move a form across ops: width still goes before seq.
    const across = vc8FormSpec({ size: 16, decompiled: BODY, tags: [o('seq(a,b)', 1), o('width(x,int)', 2)] });
    assert.deepStrictEqual(across?.forms.map(f => f.form.op), ['width', 'seq']);
  });

  it('applies a second seq that rewrites what the first wrote, in ord order (DrawRect 0050c3a0)', () => {
    const src = [
      'void DrawRect(int w, int h, int l, int t) {',
      '  nXEnd = w + l;',
      '  nYEnd = h + t;',
      '  nXStart = (w >> 1) + l;',
      '  nYEnd_00 = (h >> 1) + t;',
      '  g(nXStart, nXEnd, nYEnd, nYEnd_00);',
      '}',
    ].join('\n');
    const body = (tags: Array<{ type: string; data: string }>) => {
      const spec = vc8FormSpec({ size: 16, decompiled: BODY, tags })!;
      const applied: boolean[] = [];
      const tu = applyVc8Forms(parse(src) as TranslationUnit, spec.forms, site => applied.push(site.applied));
      const out = emit(tu as never).replace(/\s+/g, ' ');
      return { order: [...out.matchAll(/(nXStart|nXEnd|nYEnd_00|nYEnd) =/g)].map(m => m[1]), applied };
    };
    const first = 'seq(nXStart,nYEnd,nXEnd)', second = 'seq(nXEnd,nYEnd_00,nYEnd)';
    // By text the second sorts first: it finds no run, and is refused.
    assert.deepStrictEqual(body([tag(first), tag(second)]), { order: ['nXStart', 'nYEnd', 'nXEnd', 'nYEnd_00'], applied: [false, true] });
    const withOrd = body([{ type: 'vc8form', data: tag(second).data + ';ord=2' }, { type: 'vc8form', data: tag(first).data + ';ord=1' }]);
    assert.deepStrictEqual(withOrd, { order: ['nXStart', 'nXEnd', 'nYEnd_00', 'nYEnd'], applied: [true, true] });
  });

  it('keeps the trailing ord when it rehashes a tag', () => {
    const d = 'x = A::f(y);';
    const rec = vc8formHashRecord({ address: '00000001', name: 'F', size: 16, decompiled: d, tags: [{ type: 'vc8form', data: `fold(t);ev=0123456789;bh=16-89abcdef;dh=${vc8formLegacyBodyHash(d)};ord=2` }] })!;
    const plan = planRehash(new Map([['00000001', rec]]));
    assert.strictEqual(plan.rows[0]!.new, `vc8form:fold(t);ev=0123456789;bh=16-89abcdef;dh=${vc8formBodyHash(d)};ord=2`);
  });

  it('has nothing to say about a function without vc8form tags', () => {
    assert.strictEqual(vc8FormSpec({ size: 16, decompiled: BODY, tags: [{ type: 'leaf' }] }), undefined);
  });

  it('drops the namespace a symbol is spelled with, and the line break its length moved', () => {
    const before = '  uVar1 = Fog::Src::D2QSSocket::ReadBytesFromSocket(D2Client::MCP::MCPD2QSSocket,szPacketBuf,0x400);\n  if (TotalCurrentChars\n      ) {';
    const after = '  uVar1 = Fog::Src::D2QSSocket::ReadBytesFromSocket\n                    (D2MCPClient::McpConnect::MCPD2QSSocket,szPacketBuf,0x400);\n  if (TotalCurrentChars) {';
    assert.strictEqual(vc8formBodyHash(before), vc8formBodyHash(after));
    assert.strictEqual(vc8formBodyForm('a = N::M::f(x);'), 'a = f ( x ) ;');
    assert.strictEqual(vc8formBodyForm('(D2Launch::CharSel::T *)p'), vc8formBodyForm('(D2Client::CharScreen::T *)p'));
  });

  it('still stales a tag on a rename, a constant, a cast or an order', () => {
    const h = vc8formBodyHash('a = N::f(x, 4);');
    for (const other of ['a = N::g(x, 4);', 'a = N::f(x, 5);', 'a = N::f((int)x, 4);', 'a = N::f(4, x);', 'b = N::f(x, 4);']) assert.notStrictEqual(vc8formBodyHash(other), h, other);
    // Tokens stay tokens: a qualifier is never glued to the name before it.
    assert.notStrictEqual(vc8formBodyHash('ab'), vc8formBodyHash('a b'));
  });

  it('keeps literals whole, and a qualifier inside one', () => {
    assert.notStrictEqual(vc8formBodyHash('f("A::b")'), vc8formBodyHash('f("b")'));
    assert.notStrictEqual(vc8formBodyHash("f('a  b')"), vc8formBodyHash("f('a b')"));
    assert.strictEqual(vc8formBodyForm('/* WARNING:  N::f   does not return */ x;'), '/* WARNING : f does not return */ x ;');
    // A quote inside a comment opens nothing.
    assert.strictEqual(vc8formBodyForm("/* it's */ N::x;"), "/* it ' s */ x ;");
  });

  it('names the whitespace-only hash of an old tag in the stale reason', () => {
    const body = 'void f(void)\n{\n  N::g();\n}';
    const spec = vc8FormSpec({ size: 16, decompiled: body, tags: [tag('fold(t)', 16, vc8formLegacyBodyHash(body))] });
    assert.match(spec!.stale[0]!.why, /whitespace-only hash, rehash it/);
  });

  it('rehashes a tag proven against the decompile now or before a pure namespace move', () => {
    const was = 'x = A::f(y);', now = 'x = B::C::f\n      (y);';
    const legacy = (d: string) => vc8formLegacyBodyHash(d);
    const rec = (address: string, d: string, tags: string[]) => vc8formHashRecord({ address, name: 'F' + address, size: 16, decompiled: d, tags: tags.map(data => ({ type: 'vc8form', data })) })!;
    const t = (dh: string) => `fold(t);ev=0123456789;bh=16-89abcdef;dh=${dh}`;
    const nowM = new Map([
      ['00000001', rec('00000001', now, [t(legacy(now))])],                       // current
      ['00000002', rec('00000002', now, [t(legacy(was))])],                       // moved
      ['00000003', rec('00000003', 'x = A::g(y);', [t(legacy(was))])],            // renamed: stale
      ['00000004', rec('00000004', now, [t(vc8formBodyHash(now))])],              // already new
    ]);
    const before = new Map([
      ['00000002', rec('00000002', was, [t(legacy(was))])],
      ['00000003', rec('00000003', was, [t(legacy(was))])],
    ]);
    const plan = planRehash(nowM, before);
    assert.deepStrictEqual(plan.rows.map(r => [r.address, r.reason]), [['00000001', 'current'], ['00000002', 'moved']]);
    assert.strictEqual(plan.rows[1]!.new, 'vc8form:' + t(vc8formBodyHash(now)));
    assert.deepStrictEqual(plan.stale.map(s => s.address), ['00000003']);
    assert.strictEqual(plan.kept, 1);
    assert.strictEqual(plan.checksum, rowsChecksum(plan.rows));
    const java = rehashJava(plan, 'tx');
    assert.ok(java.includes(plan.checksum) && java.includes('PRECHECK FAILED'));
  });
});
