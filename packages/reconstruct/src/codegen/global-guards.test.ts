import { describe, it } from 'node:test';
import assert from 'node:assert';

import { globalGuardLine, globalGuardMacroLines, guardQualifiedName, hasDefinitionInitializer } from './global-guards.js';
import { generateStaticLocalsBlock, globalDefinition } from './globals-header.js';
import type { AnalyzedDataSymbol } from '../types.js';

function sym(name: string, extra: Partial<AnalyzedDataSymbol> = {}): AnalyzedDataSymbol {
  return { name, address: '0x007a0000', dataType: 'int', size: 4, isInitialized: false, xrefCount: 1, ...extra } as AnalyzedDataSymbol;
}

describe('global guards', () => {
  it('picks the macro by linkage and initializer', () => {
    assert.strictEqual(globalGuardLine('gA', 'Ns::gA', 'external', true), 'D2_GLOBAL_GUARD(gA, "Ns::gA");');
    assert.strictEqual(globalGuardLine('gA', 'gA', 'external', false), 'D2_GLOBAL_GUARD_BSS(gA, "gA");');
    assert.strictEqual(globalGuardLine('sT', 'f::sT', 'static', true), 'D2_STATIC_GUARD(sT, "f::sT");');
    assert.strictEqual(globalGuardLine('sT', 'f::sT', 'static', false), 'D2_STATIC_GUARD_BSS(sT, "f::sT");');
  });

  it('qualifies by scope', () => {
    assert.strictEqual(guardQualifiedName('D2Client::Draw', 'gX'), 'D2Client::Draw::gX');
    assert.strictEqual(guardQualifiedName(undefined, 'gX'), 'gX');
  });

  it('decides initialised exactly as the definition renders', () => {
    const bss = sym('gnBss');
    assert.strictEqual(hasDefinitionInitializer(bss), false);
    assert.ok(!globalDefinition(bss, 'gnBss').includes('='));
    const scalar = sym('gnScalar', { isInitialized: true, value: '0x5' });
    assert.strictEqual(hasDefinitionInitializer(scalar), true);
    assert.ok(globalDefinition(scalar, 'gnScalar').includes('='));
  });

  it('follows each function-local static with its guard, on the same line', () => {
    const block = generateStaticLocalsBlock(
      [sym('gnCount', { scope: 'static-local', ownerFunction: 'Tick' })], 'Tick', false, undefined, 'Ns::Tick',
    );
    assert.ok(block);
    const lines = block!.split('\n').map(l => l.trim()).filter(Boolean);
    assert.ok(lines.includes('static int gnCount; D2_STATIC_GUARD_BSS(gnCount, "Ns::Tick::gnCount");'), block!);
  });

  it('expands to nothing without the loud define', () => {
    const lines = globalGuardMacroLines();
    const elseAt = lines.indexOf('#else');
    assert.ok(elseAt > 0);
    for (const l of lines.slice(elseAt + 1, -1)) assert.match(l, /^#define D2_\w+_GUARD\w*\(ident, qname\)$/);
  });
});
