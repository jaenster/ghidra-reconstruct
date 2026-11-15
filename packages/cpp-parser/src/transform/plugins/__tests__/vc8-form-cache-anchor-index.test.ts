import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
function run(source: string, ...forms: string[]) {
  const sites: Vc8FormSite[] = [];
  const parsed = forms.map(s => { const form = parseVc8Form(s); assert.ok(form, s); return { form, tag: s }; });
  const out = emit(applyVc8Forms(parse(source), parsed, s => sites.push(s)));
  return { out: flat(out), sites };
}
const body = `void f(int value) {
  int maximum;
  value = Calc(1);
  maximum = Max(1);
  Consume(Current(1) + value * 256, maximum);
  value = Calc(2);
  maximum = Max(2);
  Consume(Current(2) + value * 256, maximum);
}`;

describe('vc8-form cache: repeated anchor selection', () => {
  it('parses the explicit bounded read count and positive anchor index', () => {
    assert.deepEqual(parseVc8Form('cache(value * 256,gain,int,@maximum,1,2)'), {
      op: 'cache', expr: 'value * 256', name: 'gain', type: 'int', anchor: 'maximum', count: 1, anchorIndex: 2,
    });
    for (const suffix of ['0', '-1', '1.5', '9007199254740992', '', '2,3']) {
      assert.equal(parseVc8Form(`cache(value * 256,gain,int,@maximum,1,${suffix})`), undefined, suffix);
    }
    assert.equal(parseVc8Form('cache(value,gain,int,@,1,2)'), undefined);
    assert.equal(parseVc8Form('cache(value,gain,int,@call,1,2)'), undefined);
    assert.equal(parseVc8Form('cache(value,gain,int,@maximum,0,2)'), undefined);
    assert.equal(parseVc8Form('cache(value,gain,int,@maximum,9007199254740992,2)'), undefined);
  });

  it('leaves the legacy first-anchor spelling unchanged', () => {
    const legacy = run(body, 'cache(value * 256,gain,int,@maximum,1)');
    const indexed = run(body, 'cache(value * 256,gain,int,@maximum,1,1)');
    assert.ok(legacy.sites[0].applied, legacy.sites[0].why);
    assert.ok(indexed.sites[0].applied, indexed.sites[0].why);
    assert.equal(legacy.out, indexed.out);
  });

  it('selects the second lifetime without crossing the earlier write to value', () => {
    const { out, sites } = run(body, 'cache(value * 256,mana,int,@maximum,1,2)');
    assert.ok(sites[0].applied, sites[0].why);
    assert.match(out, /value = Calc\(1\); maximum = Max\(1\); Consume\(Current\(1\) \+ value \* 256, maximum\);/);
    assert.match(out, /value = Calc\(2\); int mana = value \* 256; maximum = Max\(2\); Consume\(Current\(2\) \+ mana, maximum\);/);
  });

  it('stages both lifetimes independently in their original call order', () => {
    const { out, sites } = run(body,
      'cache(value * 256,life,int,@maximum,1,1)',
      'cache(value * 256,mana,int,@maximum,1,2)');
    assert.ok(sites.every(s => s.applied), JSON.stringify(sites));
    assert.match(out, /Calc\(1\); int life = value \* 256; maximum = Max\(1\); Consume\(Current\(1\) \+ life, maximum\);/);
    assert.match(out, /Calc\(2\); int mana = value \* 256; maximum = Max\(2\); Consume\(Current\(2\) \+ mana, maximum\);/);
  });

  it('refuses an absent anchor ordinal without changing the function', () => {
    const { out, sites } = run(body, 'cache(value * 256,gain,int,@maximum,1,3)');
    assert.equal(sites[0].applied, false);
    assert.match(sites[0].why!, /no anchor #3/);
    assert.equal(out, flat(emit(parse(body))));
  });

  it('refuses anchors spread across scopes instead of counting shadowed names', () => {
    const source = 'void f(int value, bool b) { int maximum = 0; Use(value); if (b) { int maximum = 1; Consume(value * 256, maximum); } }';
    const { out, sites } = run(source, 'cache(value * 256,gain,int,@maximum,1,2)');
    assert.equal(sites[0].applied, false);
    assert.match(sites[0].why!, /occurs in 2 blocks/);
    assert.equal(out, flat(emit(parse(source))));
  });

  it('retains the write barrier from the chosen anchor to its read', () => {
    const source = body.replace('maximum = Max(2);', 'maximum = Max(2); value = Changed();');
    const { out, sites } = run(source, 'cache(value * 256,gain,int,@maximum,1,2)');
    assert.equal(sites[0].applied, false);
    assert.match(sites[0].why!, /changes before its last read/);
    assert.equal(out, flat(emit(parse(source))));
  });

  it('retains the exact read count and fresh-name checks', () => {
    const over = run(body, 'cache(value * 256,gain,int,@maximum,2,2)');
    assert.equal(over.sites[0].applied, false);
    const used = run(body, 'cache(value * 256,maximum,int,@maximum,1,2)');
    assert.equal(used.sites[0].applied, false);
    assert.match(used.sites[0].why!, /exists/);
  });
});
