import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseVc8FormTag, vc8FormSpec, vc8formBodyForm, vc8formBodyHash, vc8formHashRecord, vc8formLegacyBodyHash } from './vc8form-spec.js';
import { planRehash, rehashJava, rowsChecksum } from './vc8form-rehash.js';

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
