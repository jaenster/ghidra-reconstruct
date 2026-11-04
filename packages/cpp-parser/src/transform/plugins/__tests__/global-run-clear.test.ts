/**
 * TEXT_InitTextDisplaySettings (0049d440) clears 0x9f bytes from DialogHandle: a run of
 * separate globals in the image. A cut-down layout of that run, with the gaps it has.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createGlobalRunClearTransformer, globalRunMembers } from '../builtins/global-run-clear.js';

const RUN = {
  globalAddresses: { DialogHandle: 0x7bf1b0, gpTextMessageLogHead: 0x7bf1b4, gbTextScrollBoxAnimating: 0x7bf1bc, ScreenMessagesMaybe: 0x7bf1e4, gpTextScrollBoxBuffer: 0x7bf24b, gpOverHeadStrc: 0x7bf250, gnTail: 0x7bf1c0, gaWide: 0x7c0000 },
  globalSizes: { DialogHandle: 4, gpTextMessageLogHead: 4, gbTextScrollBoxAnimating: 4, ScreenMessagesMaybe: 6, gpTextScrollBoxBuffer: 4, gpOverHeadStrc: 4, gnTail: 4, gaWide: 16 },
  globalElementSizes: { gaWide: 4 },
  globalNamespaces: { DialogHandle: ['D2Client', 'UI', 'Dialog'] },
};

function run(code: string, extra: Record<string, unknown> = {}) {
  const refusals: string[] = [];
  const out = emit(createGlobalRunClearTransformer({ ...RUN, ...extra, onRefusal: (r: string) => refusals.push(r) })(parse(code)) as AnyNode).trim();
  return { out, refusals };
}

describe('global-run-clear', () => {
  it('clears every object of the run, in address order, by name', () => {
    const { out } = run(`void f() { memset(&D2Client::UI::Dialog::DialogHandle, 0, 0x9f); g(); }`);
    const clears = out.split('\n').map(l => l.trim()).filter(l => l.startsWith('memset'));
    assert.deepStrictEqual(clears, [
      'memset(&D2Client::UI::Dialog::DialogHandle, 0, sizeof(D2Client::UI::Dialog::DialogHandle));',
      'memset(&gpTextMessageLogHead, 0, sizeof(gpTextMessageLogHead));',
      'memset(&gbTextScrollBoxAnimating, 0, sizeof(gbTextScrollBoxAnimating));',
      'memset(&gnTail, 0, sizeof(gnTail));',
      'memset(&ScreenMessagesMaybe, 0, sizeof(ScreenMessagesMaybe));',
      'memset(&gpTextScrollBoxBuffer, 0, sizeof(gpTextScrollBoxBuffer));',
    ]);
    assert.ok(out.includes('g();'), out);
    // 0x7bf24b + 4 is the span's end; gpOverHeadStrc at 0x7bf250 is past it.
    assert.ok(!out.includes('gpOverHeadStrc'), out);
  });

  it('clears only the covered bytes of an object the span ends inside', () => {
    const { out } = run(`void f() { memset(&DialogHandle, 0, 0x9d); }`);
    assert.ok(out.includes('memset((char*)&gpTextScrollBoxBuffer, 0, 2);'), out);
  });

  it('gives each object the bytes of it a span covers', () => {
    const m = globalRunMembers(0x7bf1b6, 8, RUN.globalAddresses, RUN.globalSizes)!;
    assert.deepStrictEqual(m.map(x => [x.name, x.from, x.length]), [['gpTextMessageLogHead', 2, 2], ['gbTextScrollBoxAnimating', 0, 2]]);
  });

  it('leaves a memset that stays inside its object', () => {
    const { out } = run(`void f() { memset(&ScreenMessagesMaybe, 0, 6); memset(gaWide, 0, 0x10); }`);
    assert.ok(out.includes('memset(&ScreenMessagesMaybe, 0, 6)') && out.includes('memset(gaWide, 0, 0x10)'), out);
  });

  it('leaves an object\'s own memset when a label inside it clamps its extent', () => {
    // GFX_InitCelDataCache: memset(&D2GfxMemoryStrc_0089db60, 0, 0x50) over its own 0x50
    // bytes; lpCriticalSection_0089db90 is a label 0x30 into it.
    const { out } = run(`void f() { memset(&D2GfxMemoryStrc_0089db60, 0, 0x50); }`, {
      globalAddresses: { D2GfxMemoryStrc_0089db60: 0x89db60, lpCriticalSection_0089db90: 0x89db90 },
      globalSizes: { D2GfxMemoryStrc_0089db60: 0x30, lpCriticalSection_0089db90: 0x50 },
      globalDeclaredSizes: { D2GfxMemoryStrc_0089db60: 0x50, lpCriticalSection_0089db90: 0x50 },
    });
    assert.ok(out.includes('memset(&D2GfxMemoryStrc_0089db60, 0, 0x50)'), out);
    assert.ok(!out.includes('lpCriticalSection'), out);
  });

  it('leaves a memset through a pointer global', () => {
    const { out } = run(`void f() { memset(gpTextMessageLogHead, 0, 0x7bc); }`);
    assert.ok(out.includes('memset(gpTextMessageLogHead, 0, 0x7bc)'), out);
  });

  it('leaves a run with a label inside an object', () => {
    // A label 2 bytes into ScreenMessagesMaybe names no object of its own.
    const { out, refusals } = run(`void f() { memset(&DialogHandle, 0, 0x9f); }`, {
      globalAddresses: { ...RUN.globalAddresses, ScreenMessagesMaybe_nCount: 0x7bf1e6 },
      globalSizes: { ...RUN.globalSizes, ScreenMessagesMaybe_nCount: 2 },
    });
    assert.ok(out.includes('memset(&DialogHandle, 0, 0x9f)'), out);
    assert.ok(refusals.some(r => r.includes('overlap')), refusals.join('\n'));
  });

  it('leaves a run with another function\'s static in it', () => {
    const { out, refusals } = run(`void f() { memset(&DialogHandle, 0, 0x9f); }`, { unreachable: ['gnTail'] });
    assert.ok(out.includes('memset(&DialogHandle, 0, 0x9f)'), out);
    assert.ok(refusals.some(r => r.includes('gnTail')), refusals.join('\n'));
  });
});
