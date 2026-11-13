import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, emit, transformGhidraCode, NodeKind, findNodesByKind, type BinaryExpr } from '@ghidra-mcp/cpp-parser';
import { compareFingerprint } from '@ghidra-mcp/cpp-parser/transform/plugins/builtins/compare-form';

interface Golden {
  address: string; name: string; decompiled: string;
  rules: { left: string; right: string; width: number; native: string[] }[];
  types: Record<string, unknown>;
}
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/narrow-equality-golden.json', import.meta.url), 'utf8')) as { functions: Golden[] };
for (const g of fixtures.functions) {
  it(`${g.address} ${g.name}: keeps the native narrow equality under final types`, () => {
    const source = g.decompiled.replace(/^(?:\s*\/\*[\s\S]*?\*\/)*\s*/, '')
      .replace(new RegExp(`(?:\\w+::)+${g.name}\\s*\\(`), `${g.name}(`);
    const ast = parse(source);
    const comparisons = findNodesByKind(ast, NodeKind.BinaryExpr).map(n => n as BinaryExpr)
      .filter(b => ['==', '!=', '<', '<=', '>', '>='].includes(b.operator))
      .sort((a, b) => a.right.location!.start.offset - b.right.location!.start.offset);
    const sites = comparisons.map(b => ({ text: b.operator,
      fp: [compareFingerprint(b.left, 4), compareFingerprint(b.right, 4)], size: 4 }));
    const decisions: unknown[] = [];
    for (const rule of g.rules) {
      const selected = comparisons.map((b, ord) => ({ b, ord })).filter(({ b }) =>
        emit(b.left).replace(/\s/g, '') === rule.left && emit(b.right).replace(/\s/g, '') === rule.right);
      assert.equal(selected.length, rule.native.length, g.address);
      for (const [index, { b, ord }] of selected.entries()) {
        sites[ord].size = rule.width;
        decisions.push({ ord, text: b.operator, fp: sites[ord].fp, width: rule.width,
          address: rule.native[index], keep: true });
      }
    }
    const run = (withFacts: boolean) => transformGhidraCode(source, {
      preset: 'full', usePluginRegistry: true, tolerateErrors: false,
      pluginOptions: { pluginOptions: {
        'compare-form': { sites: withFacts ? sites : [], decisions: withFacts ? decisions : [] } as never,
        'compare-signedness': g.types as never,
      } },
    }).code;
    const before = run(false), after = run(true);
    assert.notEqual(after, before);
    for (const rule of g.rules) {
      const signed = rule.left === 'nEntryLocale' ? rule.right : rule.left;
      const expression = new RegExp(`\\(uint${rule.width * 8}_t\\)\\(?${signed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)?`, 'g');
      assert.equal((after.match(expression) ?? []).length, rule.native.length, after);
    }
  });
}
