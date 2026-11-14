import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';
import { COMPILER_FENCE_SUPPORT_LINES } from '../builtins/artifact-support.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const tables: Vc8FormTables = {
  structFields: { Node: { next: 'Node*', prev: 'Node*', payload: 'unsigned*' } },
  structLayouts: { Node: [
    { name: 'next', type: 'Node*', offset: 0, size: 4 },
    { name: 'prev', type: 'Node*', offset: 4, size: 4 },
    { name: 'payload', type: 'unsigned*', offset: 8, size: 4 },
  ] },
};
const code = `unsigned f(Node* p, unsigned v) {
  p->next = 0;
  p->prev = 0;
  if (p->payload) { p->value = (*p->payload += v); }
  return p->value;
}`;
const tag = 'fence(p->next,p->prev)';
function run(source = code, text = tag, facts = tables) {
  const form = parseVc8Form(text); assert.ok(form, text);
  const sites: Vc8FormSite[] = [], input = parse(source) as TranslationUnit;
  const before = emit(input as AnyNode);
  const out = applyVc8Forms(input, [{ form, tag: text }], s => sites.push(s), facts);
  return { before, out: emit(out as AnyNode), site: sites[0] };
}

it('parses exact store anchors and an optional explicit occurrence', () => {
  assert.deepEqual(parseVc8Form(tag), { op: 'fence', targets: ['p->next', 'p->prev'] });
  assert.deepEqual(parseVc8Form('fence(p -> next,p -> prev,@2)'), { op: 'fence', targets: ['p -> next', 'p -> prev'], index: 2 });
  for (const bad of ['fence()', 'fence(p->next)', 'fence(p->next,p->next)', 'fence(p->next,p->prev,2)',
    'fence(p->next,p->prev,@0)', 'fence(p->next,p->prev,@-1)', 'fence(p->next,p->prev,@1.5)',
    'fence(p->next,p->prev,@9007199254740992)', 'fence(get()->next,p->prev)', 'fence(p->a.next,p->prev)']) {
    assert.equal(parseVc8Form(bad), undefined, bad);
  }
});

it('inserts only the compiler boundary, for either pointer width', () => {
  for (const width of [4, 8]) {
    const facts = { ...tables, structLayouts: { Node: tables.structLayouts!.Node.map((f, i) => ({ ...f, offset: i * width, size: width })) } };
    const result = run(code, tag, facts);
    assert.ok(result.site.applied, result.site.why);
    assert.equal(result.out.replace(/\s*D2_COMPILER_FENCE\(\);/, ''), result.before.replace(/\n\s*if/, '\n  if'));
    assert.match(result.out, /p->prev = 0;\s*D2_COMPILER_FENCE\(\);\s*if \(p->payload\)/);
  }
});

it('does not add a second fence when reapplied', () => {
  const first = run(); assert.ok(first.site.applied);
  const second = run(first.out);
  assert.equal(second.site.applied, false);
  assert.equal(second.out, first.out);
});

it('requires an occurrence for repeated anchors and changes just that run', () => {
  const twice = code.replace('  return', '  p->next = 0; p->prev = 0; if (p->payload) { p->value++; }\n  return');
  assert.equal(run(twice).site.applied, false);
  for (const n of [1, 2]) {
    const result = run(twice, `fence(p->next,p->prev,@${n})`);
    assert.ok(result.site.applied, result.site.why);
    assert.equal((result.out.match(/D2_COMPILER_FENCE/g) ?? []).length, 1);
    const segments = result.out.split('p->prev = 0;');
    assert.equal(segments[n].trimStart().startsWith('D2_COMPILER_FENCE'), true);
  }
  assert.equal(run(twice, 'fence(p->next,p->prev,@3)').site.applied, false);
});

for (const condition of ['!p->payload', 'p->payload == 0', '0 != p->payload', 'p->payload != nullptr']) {
  it(`accepts the direct null test ${condition}`, () => assert.ok(run(code.replace('if (p->payload)', `if (${condition})`)).site.applied));
}

const badCases: Array<[string, string, Vc8FormTables?]> = [
  ['nonzero store', code.replace('p->next = 0', 'p->next = (Node*)1')],
  ['compound store', code.replace('p->next = 0', 'p->next += 0')],
  ['class conversion of zero', code.replace('p->next = 0', 'p->next = (Maker)0')],
  ['class conversion in test', code.replace('if (p->payload)', 'if (p->payload == (Maker)0)')],
  ['call between stores', code.replace('p->prev = 0', 'touch(p); p->prev = 0')],
  ['label between stores', code.replace('p->prev = 0', 'skip: p->prev = 0')],
  ['call between stores and test', code.replace('if (p->payload)', 'touch(p); if (p->payload)')],
  ['condition has another effect', code.replace('if (p->payload)', 'if (touch(p), p->payload)')],
  ['tests a cleared field', code.replace('if (p->payload)', 'if (p->next)')],
  ['pointer alias test', code.replace('if (p->payload)', 'if (q->payload)')],
  ['shadowed pointer', code.replace('  return', '  { Node* p; }\n  return')],
  ['volatile pointer', code.replace('Node* p', 'Node* volatile p')],
  ['unknown layout', code, { ...tables, structLayouts: {} }],
  ['union owner', code, { ...tables, unionNames: ['Node'] }],
  ['overlapping fields', code, { ...tables, structLayouts: { Node: tables.structLayouts!.Node.map(f => ({ ...f, offset: 0 })) } }],
  ['bitfield metadata', code, { ...tables, structLayouts: { Node: tables.structLayouts!.Node.map(f => ({ ...f, bitSize: 1 })) } }],
  ['integer field', code, { ...tables, structFields: { Node: { ...tables.structFields!.Node, prev: 'unsigned' } } }],
  ['volatile field', code, { ...tables, structFields: { Node: { ...tables.structFields!.Node, prev: 'Node* volatile' } } }],
];
for (const [name, source, facts] of badCases) it(`refuses ${name} without changing the function`, () => {
  const result = run(source, tag, facts);
  assert.equal(result.site.applied, false, name);
  assert.equal(result.out, result.before, name);
});

it('preserves return values and complete linked-object states with optimized native code', { skip: !hasNativeGpp() }, () => {
  const after = run(); assert.ok(after.site.applied, after.site.why);
  const prelude = [
    ...COMPILER_FENCE_SUPPORT_LINES,
    'struct Node { Node* next; Node* prev; unsigned* payload; unsigned value; };',
    `namespace ref { ${code} }`, `namespace candidate { ${after.out} }`,
  ].join('\n');
  const body = `
    unsigned cases = 0;
    for (unsigned v = 0; v < 65536; ++v) for (int mode = 0; mode < 4; ++mode) {
      unsigned ra = v ^ 0xffffffffu, ca = ra;
      Node r = {}, c = {}, ro = {}, co = {};
      r.next = &ro; c.next = &co; r.prev = &r; c.prev = &c;
      r.value = c.value = v * 0x1020301u; ro.value = co.value = ~v;
      r.payload = mode == 0 ? 0 : mode == 1 ? &ra : mode == 2 ? &r.value : &ro.value;
      c.payload = mode == 0 ? 0 : mode == 1 ? &ca : mode == 2 ? &c.value : &co.value;
      if (ref::f(&r, v * 0x10405u) != candidate::f(&c, v * 0x10405u)) return 1;
      if (r.next || c.next || r.prev || c.prev || r.value != c.value || ro.value != co.value || ra != ca) return 2;
      if (r.payload != (mode == 0 ? 0 : mode == 1 ? &ra : mode == 2 ? &r.value : &ro.value)) return 3;
      if (c.payload != (mode == 0 ? 0 : mode == 1 ? &ca : mode == 2 ? &c.value : &co.value)) return 4;
      ++cases;
    }
    printf("%u\\n", cases);`;
  assert.equal(compileAndRun(prelude, body, { optimize: true }).trim(), '262144');
});
