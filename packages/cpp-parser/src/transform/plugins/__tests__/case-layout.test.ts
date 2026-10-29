import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { caseLayoutPlugin } from '../builtins/case-layout.js';
import type { BranchLayoutEvidence } from '../builtins/branch-layout/evidence.js';

/** One statement per line, each tagged `[offsets] text`, `[if cb offsets] text` for an if line. */
function fixture(lines: string[]): { code: string; ev: BranchLayoutEvidence } {
  const text: string[] = [];
  const ev = { lines: new Map<number, number[]>(), ifs: new Map<number, number>() };
  lines.forEach((l, i) => {
    const m = l.match(/^\s*\[(if\s+)?([0-9a-fx, ]*)\]\s?(.*)$/);
    if (!m) { text.push(l); return; }
    const nums = m[2].split(/[ ,]+/).filter(Boolean).map(n => Number(n));
    if (m[1]) { ev.ifs.set(i + 1, nums[0]); ev.lines.set(i + 1, nums.slice(1)); } else if (nums.length) ev.lines.set(i + 1, nums);
    text.push(m[3]);
  });
  return { code: text.join('\n'), ev };
}

function flat(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function run(lines: string[]): { out: string; sites: string[] } {
  const { code, ev } = fixture(lines);
  const sites: string[] = [];
  const t = caseLayoutPlugin.createTransformer({
    branchLayout: ev,
    onSite: (e: { rule: string; why?: string }) => sites.push(e.why ? `${e.rule}: ${e.why}` : e.rule),
  });
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

// NET_D2GS_CLIENT_Handle0x50_QuestSpecial: the body of 0x24 is the first in the original.
const questSpecial = [
  'void f(P* p) {',
  '[0x0,0x13] switch (p->n) {',
  'case 1:',
  '[0x2c] A(p);',
  '[0x2c] return;',
  'case 2:',
  '[0x23] B(p);',
  '[0x27] return;',
  'case 3:',
  'case 6:',
  '[0x31] C(p);',
  '[0x31] return;',
  'case 0x24:',
  '[0x1a] D(p);',
  '[0x1e] return;',
  '}',
  '}',
];

describe('caseLayoutPlugin', () => {
  it('prints the case groups in the order of their bodies', () => {
    const { out, sites } = run(questSpecial);
    assert.deepStrictEqual(sites, ['order']);
    assert.ok(out.includes('case 0x24: D(p); return; case 2: B(p); return; case 1: A(p); return; case 3: case 6: C(p); return;'), out);
  });

  it('is idempotent and leaves a switch already in address order', () => {
    const { code, ev } = fixture(questSpecial);
    const t = caseLayoutPlugin.createTransformer({ branchLayout: ev });
    const once = t(parse(code));
    const sites: string[] = [];
    const again = caseLayoutPlugin.createTransformer({ branchLayout: ev, onSite: (e: { rule: string }) => sites.push(e.rule) })(once);
    assert.strictEqual(flat(emit(again as AnyNode)), flat(emit(once as AnyNode)));
    assert.deepStrictEqual(sites, []);
  });

  it('moves a group with the one it runs into, and gives a moved last group its break', () => {
    const { out } = run([
      'void f(int n) {',
      '[0x4,0x8] switch (n) {',
      'case 0:',
      '[0x30] A();',
      'case 1:',
      '[0x35] B();',
      'break;',
      'case 2:',
      '[0x10] C();',
      'break;',
      'case 3:',
      '[0x20] D();',
      '}',
      '[0x40] E();',
      '}',
    ]);
    assert.ok(out.includes('case 2: C(); break; case 3: D(); break; case 0: A(); case 1: B(); break; }'), out);
  });

  it('keeps an empty group behind the group before it', () => {
    const { out } = run([
      'void f(int n) {',
      '[0x4,0x8] switch (n) {',
      'case 0:',
      '[0x30] A();',
      'break;',
      'case 1:',
      'break;',
      'case 2:',
      '[0x10] C();',
      'break;',
      'default:',
      'goto out;',
      '}',
      '[0x40] E();',
      'out:',
      '[0x48] F();',
      '}',
    ]);
    assert.ok(out.includes('case 2: C(); break; default: goto out; case 0: A(); break; case 1: break; }'), out);
  });

  it('leaves a switch with a case body of unknown address', () => {
    const { out, sites } = run(questSpecial.map(l => l.replace('[0x23] B(p);', 'B(p);').replace('[0x27] return;', 'return;')));
    assert.deepStrictEqual(sites, ['left: a case body without an address']);
    assert.ok(out.includes('case 1: A(p); return; case 2:'), out);
  });

  it('leaves a group that runs into one laid out before it', () => {
    const { sites } = run([
      'void f(int n) {',
      '[0x4,0x8] switch (n) {',
      'case 0:',
      '[0x30] A();',
      'case 1:',
      '[0x10] B();',
      'break;',
      'case 2:',
      '[0x20] C();',
      'break;',
      '}',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['left: a case runs into one laid out before it']);
  });

  it('leaves a switch a pass built from ifs (its line is an if line)', () => {
    const { out, sites } = run(questSpecial.map(l => l.replace('[0x0,0x13] switch', '[if 0x13 0x0,0x13] switch')));
    assert.deepStrictEqual(sites, []);
    assert.ok(out.includes('case 1: A(p); return; case 2:'), out);
  });

  it('changes nothing without evidence', () => {
    const { code } = fixture(questSpecial);
    const out = flat(emit(caseLayoutPlugin.createTransformer({})(parse(code)) as AnyNode));
    assert.ok(out.includes('case 1: A(p); return; case 2:'), out);
  });
});
