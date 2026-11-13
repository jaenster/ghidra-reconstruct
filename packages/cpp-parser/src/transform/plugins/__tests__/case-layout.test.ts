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
  // UI_GoldDialogConfirmCallback 00454080: goto-cleanup put `return 1;` where the default's
  // `goto switchD_004540b1_caseD_5` was, so that group prints no address of its own; the jump
  // table sends 0/1 to 0x38, 2 to 0x5f, 3 to 0x76, 4 to 0x66 and the bound check to 0x9d.
  const goldDialog = [
    'int f(void) {',
    '[0x31] switch (gnGoldDialogTransactionType) {',
    'case 0:',
    'case 1:',
    '[0x38] A();',
    '[0x59] return 1;',
    'case 2:',
    '[0x5f] B();',
    '[0x8b] goto play_confirm_sound;',
    'case eThree:',
    '[0x7f] nButtonId = 0x14;',
    'break;',
    'case 4:',
    '[0x6f] nButtonId = 0x13;',
    'break;',
    'default:',
    'return 1;',
    '}',
    '[0x86] C(nButtonId);',
    'play_confirm_sound:',
    '[0x98] D();',
    '[0x9d] return 1;',
    '}',
  ];
  const goldTable = [{
    at: 0x31, labelled: false, fallback: 0x9d, bound: 4,
    entries: [0x38, 0x38, 0x5f, 0x76, 0x66, 0x9d].map((target, value) => ({ value, target })),
  }];

  it('takes a group without an address from the jump table (UI_GoldDialogConfirmCallback 00454080)', () => {
    const { code, ev } = fixture(goldDialog);
    const sites: string[] = [];
    const t = caseLayoutPlugin.createTransformer({
      branchLayout: ev, jumpTables: goldTable, enumValues: { eThree: 3 },
      onSite: (e: { rule: string; why?: string }) => sites.push(e.why ? `${e.rule}: ${e.why}` : e.rule),
    });
    const out = flat(emit(t(parse(code)) as AnyNode));
    assert.deepStrictEqual(sites, ['order']);
    assert.ok(out.includes('case 2: B(); goto play_confirm_sound; case 4: nButtonId = 0x13; break; case eThree: nButtonId = 0x14; break; default: return 1; }'), out);
  });

  it('reads an unlabelled table less the smallest case (ITEM_ApplyQualityAndAffixes 00557450)', () => {
    // `dec eax; cmp eax, 8; ja; jmp [table + eax*4]`: entry i is case i + 1.
    const lines = ['void f(int q) {', '[0x12b] switch (q) {'];
    for (let v = 1; v <= 9; v++) lines.push(`case ${v}:`, `Q${v}();`, 'break;');
    lines.push('default:', 'R();', '}', '}');
    const targets = [0x132, 0x168, 0x17a, 0x22d, 0x421, 0x1ba, 0x276, 0x367, 0x3b1, 0x5cf];
    const { code, ev } = fixture(lines);
    const sites: string[] = [];
    const out = flat(emit(caseLayoutPlugin.createTransformer({
      branchLayout: ev,
      jumpTables: [{ at: 0x12b, labelled: false, fallback: 0x5cf, bound: 8, entries: targets.map((target, value) => ({ value, target })) }],
      onSite: (e: { rule: string; why?: string }) => sites.push(e.why ? `${e.rule}: ${e.why}` : e.rule),
    })(parse(code)) as AnyNode));
    assert.deepStrictEqual(sites, ['order']);
    const order = [...out.matchAll(/case (\d+):|default:/g)].map(m => m[1] ?? 'default');
    assert.deepStrictEqual(order, ['1', '2', '3', '6', '4', '7', '8', '9', '5', 'default']);
  });

  it('keeps the empty groups before any code first and orders the rest (Q38_Callback00_NpcActivate 005984c0)', () => {
    const { out, sites } = run([
      'void f(int n) {',
      '[0x4a] switch (n) {',
      'case 0xaf:',
      'case 0xc6:',
      'case 0xca:',
      'break;',
      'default:',
      '[0x9d] return;',
      'case 0xb0:',
      '[0x6a] c = 1;',
      'break;',
      'case 0xb1:',
      '[0x63] c = 3;',
      'break;',
      'case 0xc7:',
      '[0x51] c = 2;',
      'break;',
      '}',
      '[0x6f] g(c);',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['order']);
    assert.ok(out.includes('case 0xaf: case 0xc6: case 0xca: break; default: return; case 0xc7: c = 2; break; case 0xb1: c = 3; break; case 0xb0: c = 1; break; }'), out);
  });

  it('reads character labels off a labelled table (D2WINEDITBOX_HandleKeyRelease 004ff050)', () => {
    const { code, ev } = fixture([
      'int f(int c) {',
      '[0xf4] switch (c) {',
      "case '\\b':", 'A();', 'break;',
      "case '\\t':", 'B();', 'break;',
      "case '\\r':", 'C();', 'break;',
      '}',
      'return 0;',
      '}',
    ]);
    const sites: string[] = [];
    const out = flat(emit(caseLayoutPlugin.createTransformer({
      branchLayout: ev,
      jumpTables: [{ at: 0xf4, labelled: true, fallback: 0x16e, bound: 104, entries: [
        { value: 8, target: 0x294 }, { value: 9, target: 0x3b3 }, { value: 13, target: 0x33d },
      ] }],
      onSite: (e: { rule: string; why?: string }) => sites.push(e.why ? `${e.rule}: ${e.why}` : e.rule),
    })(parse(code)) as AnyNode));
    assert.deepStrictEqual(sites, ['order']);
    assert.ok(out.includes("case '\\b': A(); break; case '\\r': C(); break; case '\\t': B(); break;"), out);
  });

  it('leaves that switch without the jump table, or with a label the table cannot place', () => {
    assert.deepStrictEqual(run(goldDialog).sites, ['left: a case body without an address']);
    const { code, ev } = fixture(goldDialog.map(l => l === 'default:' ? 'case 9:' : l));
    const sites: string[] = [];
    caseLayoutPlugin.createTransformer({
      branchLayout: ev, jumpTables: goldTable, enumValues: { eThree: 3 },
      onSite: (e: { rule: string; why?: string }) => sites.push(e.why ? `${e.rule}: ${e.why}` : e.rule),
    })(parse(code));
    assert.deepStrictEqual(sites, ['left: a case body without an address']);
  });

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
