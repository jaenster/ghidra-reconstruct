/**
 * `own(V,T)` on the bodies as the generator hands them to the vc8 forms (v2094 snapshot,
 * codegen wrapper `dummy`). The form drops V's initializer as a dead copy of a register;
 * where something reads that value it must stay. Each fixture's golden is the whole
 * function after the form.
 *
 *  - 00561e70 ITEMMODE_ConsumeItemAndRemove and 0051dbf0 NET_SID_CLIENT_Send_0x46_NewsInfo
 *    as they arrive once dead-out-slot-store has already dropped the push's copy: what is
 *    left in the initializer is the 0 ITEM_SetServerSideFlag ORs into, and the timestamp
 *    NET_SID_CLIENT_Send sends.
 *  - 0047d3b0 UI_SLIDER_InitAutomapMode: SRegLoadValue leaves the slot alone when the key
 *    is missing, so the copy is what the range test reads.
 *  - 00576890 SUNITNPC_GetActCappedLevel: two early returns give the copy back.
 *  - 0053a620 SendAdjacentRoomUpdates: DRLGROOM_GetAdjacentRoomsList stores all of the
 *    slot before anything reads it, so the copy is dead and the form applies.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';

const OUT: Record<string, number> = { 'D2Common::DUNGEON::Dungeon::DRLGROOM_GetAdjacentRoomsList': 1 };
const tables: Vc8FormTables = {
  outParamWidth: (callee, index) => OUT[callee] === index ? 4 : null,
  typeSize: () => 4,
};

const fixture = (name: string) => new URL(`./fixtures/vc8-own/${name}`, import.meta.url);

function run(addr: string, form: string): { out: string; site: Vc8FormSite } {
  const sites: Vc8FormSite[] = [];
  const tu = applyVc8Forms(parse(readFileSync(fixture(`${addr}.c`), 'utf8')) as TranslationUnit,
    [{ form: parseVc8Form(form)!, tag: form }], s => sites.push(s), tables);
  return { out: emit(tu as AnyNode), site: sites[0] };
}

const targets: Array<[string, string, string, boolean, RegExp]> = [
  ['00561e70', 'ITEMMODE_ConsumeItemAndRemove', 'own(eItemFlags,uint32_t)', false, /uint32_t eItemFlags = 0;\s*D2Common::ITEMS::Items::ITEM_SetServerSideFlag\(&eItemFlags/],
  ['0051dbf0', 'NET_SID_CLIENT_Send_0x46_NewsInfo', 'own(dwTimestampPacket,uint32_t)', false, /uint32_t dwTimestampPacket = g_dwNewsTimestamp;\s*NET_SID_CLIENT_Send\(0x46, \(char\*\)&dwTimestampPacket, 4\);/],
  ['0047d3b0', 'UI_SLIDER_InitAutomapMode', 'own(nAutomapMode,uint32_t)', false, /uint32_t nAutomapMode = \(uint32_t\)pItem;/],
  ['00576890', 'SUNITNPC_GetActCappedLevel', 'own(nEffectiveLevel,int32_t)', false, /int32_t nEffectiveLevel = nLevel;/],
  ['0053a620', 'SendAdjacentRoomUpdates', 'own(pGameSave,::SGAMEDATA*)', true, /::SGAMEDATA\* pGameSave;\n/],
];

describe('vc8-form own: an initializer something reads is kept', () => {
  for (const [addr, name, form, applies, shape] of targets) {
    it(`${addr} ${name}`, () => {
      const { out, site } = run(addr, form);
      if (process.env.UPDATE_GOLDEN) writeFileSync(fixture(`${addr}.expected.c`), out);
      assert.strictEqual(out, readFileSync(fixture(`${addr}.expected.c`), 'utf8'));
      assert.strictEqual(site.applied, applies, site.why);
      if (!applies) assert.match(site.why ?? '', /initializer is read/);
      assert.match(out, shape);
    });
  }
});
