import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseVc8FormTag, vc8FormSpec, vc8formBodyHash } from './vc8form-spec.js';

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
    assert.deepStrictEqual(spec?.forms.map(f => f.form.op), ['split', 'nest', 'dup', 'cmp', 'seq']);
  });

  it('has nothing to say about a function without vc8form tags', () => {
    assert.strictEqual(vc8FormSpec({ size: 16, decompiled: BODY, tags: [{ type: 'leaf' }] }), undefined);
  });
});
