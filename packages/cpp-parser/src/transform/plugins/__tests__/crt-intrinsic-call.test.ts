import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { crtIntrinsicCallPlugin } from '../builtins/crt-intrinsic-call.js';
import { typeNormalizePlugin } from '../builtins/type-normalize.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(src: string): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = crtIntrinsicCallPlugin.createTransformer({ onSite: e => sites.push(`${e.from}:${e.to}`) });
  return { out: flat(emit(t(parse(src)) as AnyNode)), sites };
}

describe('crt-intrinsic-call', () => {
  // SOUNDSMP_LinearToLogVolume 00516590: the original loads both operands and calls __CIpow.
  it('writes CRT_CIPow as pow of two doubles', () => {
    const r = run('float f(float a, float b) { long double v = CRT_CIPow((long double)a, (long double)b); return (float)v; }');
    assert.deepStrictEqual(r.sites, ['CRT_CIPow:pow']);
    assert.ok(r.out.includes('long double v = pow((double)a, (double)b);'), r.out);
  });

  it('drops a stacked long double/double cast to one double cast', () => {
    const r = run('void f(long double x) { x = CRT_CISin((long double)(double)x); }');
    assert.ok(r.out.includes('x = sin((double)x);'), r.out);
  });

  it('casts a compound operand as a whole', () => {
    const r = run('double f(float a, float b) { return __CIsqrt((long double)(a * a + b * b)); }');
    assert.ok(r.out.includes('return sqrt((double)(a * a + b * b));'), r.out);
    const r2 = run('double f(long double a, long double b) { return CRT_CILog10((a + b) / b); }');
    assert.ok(r2.out.includes('return log10((double)((a + b) / b));'), r2.out);
  });

  it('rewrites a helper nested in another', () => {
    const r = run('double f(long double a) { return CRT_CIPow((long double)10.0, CRT_CILog(a)); }');
    assert.ok(r.out.includes('return pow((double)10.0, (double)log((double)a));'), r.out);
  });

  it('drops the long double cast type-normalize writes for float10', () => {
    const norm = typeNormalizePlugin.createTransformer({});
    const t = crtIntrinsicCallPlugin.createTransformer({});
    const out = flat(emit(t(norm(parse('float f(float a, float b) { float10 v = CRT_CIPow((float10)a, (float10)b); return (float)v; }'))) as AnyNode));
    assert.ok(out.includes('long double v = pow((double)a, (double)b);'), out);
  });

  it('leaves other calls and a wrong arity alone', () => {
    const r = run('double f(double a) { return CRT_Pow(a) + CRT_CIPow(a); }');
    assert.deepStrictEqual(r.sites, []);
  });
});
