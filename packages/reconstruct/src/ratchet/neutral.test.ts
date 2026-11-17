import { describe, it } from 'node:test';
import assert from 'node:assert';

import { applyRecords, capture, type ApplyRow } from './ratchet.js';
import { SymbolIndex, memoryTree } from './symbol-index.js';

function tree(header: string, unit: string): SymbolIndex {
  return SymbolIndex.build(memoryTree(new Map([['Source/Z/Tune.h', header], ['Source/Z/Tune.cpp', unit]])));
}

function row(rows: ApplyRow[], address: string): ApplyRow {
  const r = rows.find(x => x.address === address);
  assert.ok(r, `no row for ${address}`);
  return r!;
}

const STRUCTS = `#pragma once
struct state_t {
    /* 0x00 */ int good_match;
    /* 0x04 */ int max_lazy;
};
struct stream_t {
    /* 0x00 */ struct state_t * state;
};
struct game_t {
    /* 0x00 */ int nTick;
};
`;

/** deflateTune's shape: arguments stored into fields, constants returned. */
const sig = (ret: string, a: string, b: string) => `${ret} __fastcall Tune(struct stream_t * pStream, ${a} nGood, ${b} nLazy)`;
/** UMOD_AddBaseDamageBonus's shape: a handler's unused first argument. */
const hsig = (a: string) => `void __fastcall Handler(${a} dwUnused, struct stream_t * pStream)`;

function sources(ret: string, a: string, b: string, h: string, fresh: boolean): [string, string] {
  const header = `${STRUCTS}namespace Z {\n${sig(ret, a, b)}; // 1.14d: 00427000\n${hsig(h)}; // 1.14d: 00427100\n}\n`;
  const tune = fresh
    ? `    struct state_t* s = pStream ? pStream->state : 0;\n    if (!s) {\n      return -2;\n    }\n\n    s->good_match = nGood;\n    s->max_lazy = nLazy;\n    return 0;\n`
    : `    if (pStream) {\n      struct state_t* s;\n      s = pStream->state;\n      if (s) {\n        s->good_match = nGood;\n        s->max_lazy = nLazy;\n        return 0;\n      }\n    }\n\n    return -2;\n`;
  const handler = fresh
    ? `    if (pStream && pStream->state) {\n      pStream->state->good_match = 1;\n    }\n`
    : `    if (pStream) {\n      if (pStream->state) {\n        pStream->state->good_match = 1;\n      }\n    }\n`;
  const unit = `#include "Tune.h"\nnamespace Z {\n\n// 1.14d: 00427000\n${sig(ret, a, b)} {\n${tune}}\n\n// 1.14d: 00427100\n${hsig(h)} {\n${handler}}\n\n} // namespace Z\n`;
  return [header, unit];
}

describe('ratchet: retypes the stored body cannot see', () => {
  const old = tree(...sources('uint32_t', 'uint32_t', 'uint32_t', 'uint32_t', false));
  const records = ['00427000', '00427100'].map(a => {
    const c = capture(old, a, 'match', 'ev0');
    assert.ok(c.record, c.error);
    return c.record!;
  });

  it('keeps a body whose return type and stored arguments changed only in sign', () => {
    const now = tree(...sources('int', 'int32_t', 'int32_t', 'uint32_t', true));
    const out = applyRecords(now, records);
    const r = row(out.rows, '00427000');
    assert.strictEqual(r.status, 'kept', r.detail);
    const text = out.changed.get('Source/Z/Tune.cpp')!;
    assert.ok(text.includes(`${sig('int', 'int32_t', 'int32_t')} {\n    if (pStream) {`), 'the stored body under the fresh signature');
  });

  it('keeps a body whose unused parameter became a pointer', () => {
    const now = tree(...sources('uint32_t', 'uint32_t', 'uint32_t', 'struct game_t *', true));
    const out = applyRecords(now, records);
    const r = row(out.rows, '00427100');
    assert.strictEqual(r.status, 'kept', r.detail);
  });

  it('still refuses a parameter the body stores and that became a pointer', () => {
    const now = tree(...sources('uint32_t', 'struct game_t *', 'uint32_t', 'uint32_t', true));
    const r = row(applyRecords(now, records).rows, '00427000');
    assert.strictEqual(r.status, 'unresolved');
    assert.match(r.detail, /parameter 1 retyped: uint32_t -> game_t \*/u);
  });

  it('still refuses a return retype when a return is not a constant', () => {
    const [h, u] = sources('uint32_t', 'uint32_t', 'uint32_t', 'uint32_t', false);
    const old2 = tree(h, u.replace('        return 0;', '        return nGood;'));
    const c = capture(old2, '00427000', 'match', 'ev0');
    assert.ok(c.record, c.error);
    const [h2, u2] = sources('int', 'uint32_t', 'uint32_t', 'uint32_t', true);
    const r = row(applyRecords(tree(h2, u2), [c.record!]).rows, '00427000');
    assert.strictEqual(r.status, 'unresolved');
    assert.match(r.detail, /returns int, was uint32_t/u);
  });

  it('still refuses a signedness retype of an argument the body compares', () => {
    const [h, u] = sources('uint32_t', 'uint32_t', 'uint32_t', 'uint32_t', false);
    const old2 = tree(h, u.replace('      if (s) {', '      if (s && nGood < 4) {'));
    const c = capture(old2, '00427000', 'match', 'ev0');
    assert.ok(c.record, c.error);
    const [h2, u2] = sources('uint32_t', 'int32_t', 'uint32_t', 'uint32_t', true);
    const r = row(applyRecords(tree(h2, u2), [c.record!]).rows, '00427000');
    assert.strictEqual(r.status, 'unresolved');
    assert.match(r.detail, /parameter 1 retyped: uint32_t -> int32_t/u);
  });
});
