/** Live decompile fixtures with manually attested facts; not live extractor output. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformGhidraCode } from '@ghidra-mcp/cpp-parser';
import type { TruncatingRoundFacts } from '../extract/truncating-rounds.js';

interface Golden { address: string; name: string; decompiled: string; facts: TruncatingRoundFacts; remaining: number }
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/truncating-round-golden.json', import.meta.url), 'utf8')) as { functions: Golden[] };
for (const g of fixtures.functions) {
  it(`${g.address} ${g.name}: removes only native-proven truncating conversions`, () => {
    const source = g.decompiled.replace(/^(?:\s*\/\*[\s\S]*?\*\/)*\s*/, '')
      // generateFunctionImplementation supplies the declaration from metadata;
      // these Ghidra custom storage conventions are not C++ parser keywords.
      .replace(/\b__(?:stdcall_edxsafe|fastcall_ecxsafe)\b/g, '')
      .replace(new RegExp(`(?:\\w+::)+${g.name}\\s*\\(`), `${g.name}(`);
    const run = (facts: boolean) => transformGhidraCode(source, {
      preset: 'full', usePluginRegistry: true, tolerateErrors: false,
      pluginOptions: facts ? { pluginOptions: { 'truncating-round-site': g.facts as never } } : undefined,
    }).code;
    assert.equal((run(false).match(/std::nearbyint\(/g) ?? []).length, g.facts.count);
    assert.equal((run(true).match(/std::nearbyint\(/g) ?? []).length, g.remaining);
  });
}
