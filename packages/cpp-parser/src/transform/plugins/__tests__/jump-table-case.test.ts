import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { jumpTableCasePlugin, type JumpTableFact } from '../builtins/jump-table-case.js';
import type { BranchLayoutEvidence } from '../builtins/branch-layout/evidence.js';

/** One statement per line, each tagged `[offsets] text`. */
function fixture(lines: string[]): { code: string; ev: BranchLayoutEvidence } {
  const text: string[] = [];
  const ev = { lines: new Map<number, number[]>(), ifs: new Map<number, number>() };
  lines.forEach((l, i) => {
    const m = l.match(/^\s*\[([0-9a-fx, ]*)\]\s?(.*)$/);
    if (!m) { text.push(l); return; }
    const nums = m[1].split(/[ ,]+/).filter(Boolean).map(n => Number(n));
    if (nums.length) ev.lines.set(i + 1, nums);
    text.push(m[2]);
  });
  return { code: text.join('\n'), ev };
}

function run(lines: string[], tables: JumpTableFact[] | undefined): { out: string; sites: string[] } {
  const { code, ev } = fixture(lines);
  const sites: string[] = [];
  const t = jumpTableCasePlugin.createTransformer({
    branchLayout: ev,
    jumpTables: tables,
    onSite: (e: { rule: string; value?: number; why?: string }) => sites.push(e.why ? `${e.rule}: ${e.why}` : `${e.rule} ${e.value}`),
  });
  return { out: emit(t(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim(), sites };
}

// GetUnitSizeX 00620510: `cmp ecx, 5; ja 0x64; jmp [ecx*4 + table]`, entry 5 at the trailing `return 0`.
const getUnitSizeX = [
  'int f(U* p) {',
  'if (!p) {',
  '[0x64] return 0;',
  '}',
  '[0xa,0x11] switch (p->t) {',
  'case UNIT_PLAYER:',
  '[0x18] return 2;',
  'case UNIT_MONSTER:',
  '[0x21] if (g(p)) { return 3; }',
  '[0x2b] break;',
  'case UNIT_OBJECT:',
  '[0x35] return 4;',
  'case UNIT_MISSILE:',
  '[0x4d] return 5;',
  'case UNIT_ITEM:',
  '[0x44] return 1;',
  '}',
  '[0x64,0x66] return 0;',
  '}',
];
const table = (over: Partial<JumpTableFact> = {}): JumpTableFact => ({
  at: 0x11, fallback: 0x64, bound: 5, labelled: true,
  entries: [[0, 0x18], [1, 0x21], [2, 0x35], [3, 0x4d], [4, 0x44], [5, 0x64]].map(([value, target]) => ({ value, target })),
  ...over,
});

describe('jump-table-case', () => {
  it('restores the last entry the decompiler folded into the return after the switch', () => {
    const { out, sites } = run(getUnitSizeX, [table()]);
    assert.ok(out.includes('case UNIT_ITEM: return 1; case 5: return 0; } return 0;'), out);
    assert.deepStrictEqual(sites, ['case 5']);
  });

  it('labels the default when the fallback is the default', () => {
    const lines = [
      'int f(int n) {',
      '[0x4,0x9] switch (n) {',
      'case 0:',
      '[0x10] return 7;',
      'case 1:',
      '[0x15] return 8;',
      'default:',
      '[0x20] return h(n);',
      '}',
      '}',
    ];
    const t: JumpTableFact = { at: 0x9, fallback: 0x20, bound: 2, labelled: true,
      entries: [{ value: 0, target: 0x10 }, { value: 1, target: 0x15 }, { value: 2, target: 0x20 }] };
    const { out } = run(lines, [t]);
    assert.ok(out.includes('case 2: default: return h(n);'), out);
  });

  it('changes nothing when the last entry has code of its own or there is no table', () => {
    const own = table({ entries: table().entries.map(e => (e.value === 5 ? { value: 5, target: 0x5a } : e)) });
    assert.ok(!run(getUnitSizeX, [own]).out.includes('case 5'));
    assert.ok(!run(getUnitSizeX, undefined).out.includes('case 5'));
    assert.ok(!run(getUnitSizeX, [table({ at: 0x40 })]).out.includes('case 5'));
  });

  it('leaves a switch whose labels do not match the table, or whose values are only indexes', () => {
    // Seven entries off the fallback for five printed cases: another pass reshaped it.
    const more = table({ entries: [...table().entries.slice(0, 5), { value: 6, target: 0x50 }, { value: 7, target: 0x64 }] });
    const r = run(getUnitSizeX, [more]);
    assert.ok(!r.out.includes('case 7'), r.out);
    assert.deepStrictEqual(r.sites, ['left: 5 case labels for 6 table entries']);
    const u = run(getUnitSizeX, [table({ labelled: false })]);
    assert.ok(!u.out.includes('case 5'), u.out);
    assert.deepStrictEqual(u.sites, ['left: the table has no case values']);
  });

  it('needs a constant return after the switch, at the fallback', () => {
    const computed = getUnitSizeX.map(l => (l === '[0x64,0x66] return 0;' ? '[0x64,0x66] return g(p);' : l));
    assert.deepStrictEqual(run(computed, [table()]).sites, ['left: the return after the switch computes its value']);
    const elsewhere = getUnitSizeX.map(l => (l === '[0x64,0x66] return 0;' ? '[0x70] return 0;' : l));
    assert.deepStrictEqual(run(elsewhere, [table()]).sites, ['left: the return after the switch is not the fallback']);
    const loop = ['int f(int n) {', 'for (;;) {', '[0x4,0x9] switch (n) {', 'case 0:', '[0x10] return 7;', '}', '}', '}'];
    const t: JumpTableFact = { at: 0x9, fallback: 0x20, labelled: true, entries: [{ value: 0, target: 0x10 }, { value: 1, target: 0x20 }] };
    assert.deepStrictEqual(run(loop, [t]).sites, ['left: what follows the switch is not a return']);
  });
});

describe('jump-table-case: a void function that ends in a short run after the switch', () => {
  // NET_MCP_CLIENT_HandleCharCreation 00435e10, cut down: entry 3 goes where the run after the switch starts.
  const lines = [
    'void f(int n) {',
    '[0x4,0x9] switch (n) {',
    'case 0:',
    '[0x10] g(1);',
    '[0x15] return;',
    'case 1:',
    'case 2:',
    '[0x20] g(2);',
    '[0x25] return;',
    '}',
    '[0x40] wId = 0x145c;',
    '[0x45] show(get(wId), 1);',
    '}',
  ];
  const t = (): JumpTableFact => ({
    at: 0x9, fallback: 0x40, bound: 3, labelled: true,
    entries: [[0, 0x10], [1, 0x20], [2, 0x20], [3, 0x40]].map(([value, target]) => ({ value, target })),
  });
  it('restores the entry with a copy of the run and a return', () => {
    const { out, sites } = run(lines, [t()]);
    assert.ok(out.includes('case 3: { wId = 0x145c; show(get(wId), 1); return; } } wId = 0x145c; show(get(wId), 1); }'), out);
    assert.deepStrictEqual(sites, ['case 3']);
  });
  it('leaves a run that does not start at the fallback', () => {
    const { sites } = run(lines, [{ ...t(), fallback: 0x30, entries: t().entries.map(e => e.value === 3 ? { ...e, target: 0x30 } : e) }]);
    assert.deepStrictEqual(sites, ['left: the code after the switch is not the fallback']);
  });
  it('leaves a function that returns a value', () => {
    const { sites } = run(lines.map(l => l.replace('void f', 'int f')), [t()]);
    assert.deepStrictEqual(sites, ['left: what follows the switch is not a return']);
  });
});
