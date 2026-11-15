import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateFunctionImplementation } from '../codegen/impl.js';
import { setAggregateTypeNames } from '../codegen/platform-types.js';
import { compileAndRun, hasNativeGpp } from '@ghidra-mcp/cpp-parser/testing/native-cpp';

// Fresh c10da256/v2105 decompile/types plus manually native-attested branch context.
// This fixture is not an owning Ghidra extraction or a source-form tag.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/hireling-zero-register.json', import.meta.url), 'utf8'));
function emit(zero: boolean): string {
  const fn = structuredClone(fixture.fn);
  if (zero) fn.branchLayout.tests[0][1].delta = 0;
  setAggregateTypeNames(fixture.types);
  return generateFunctionImplementation(fn, undefined, fixture.options, {
    targetPointerSize: 4, targetLanguageId: 'x86:LE:32:default', funcPtrArgCasts: fixture.tables,
    _enumMemberValues: Object.fromEntries(fixture.types.map((t: {name: string; enumValues: Record<string, number>}) => [t.name, t.enumValues])),
  });
}

test('00493840: only the proven first SUB delta enables the complete native switch', () => {
  assert.equal(fixture.fn.branchLayout.tests[0][1].delta, undefined);
  assert.equal(emit(false), fixture.baseline);
  assert.equal(emit(true), fixture.candidate);
  assert.match(emit(true), /switch \(gnHireDisplayMode\) \{\s+case 1:/);
  assert.match(emit(true), /case 0:/);
});

test('00493840: generated switch preserves global writes and ordered calls for boundary and random inputs', { skip: !hasNativeGpp() }, () => {
  const enums = fixture.types.map((t: {name: string; enumValues: Record<string, number>}) =>
    `enum ${t.name} { ${Object.entries(t.enumValues).map(([name, value]) => `${name} = ${value}`).join(', ')} };`).join('\n');
  const baseline = emit(false).replace('UI_ToggleHirelingIconsVisibility()', 'baseline()');
  const candidate = emit(true).replace('UI_ToggleHirelingIconsVisibility()', 'candidate()');
  const result = compileAndRun(`
#include <stdint.h>
#include <stdio.h>
#define __stdcall
${enums}
uint32_t gnHireDisplayMode, gnHireIconHoverIndex, gameType;
struct State { uint32_t mode, hover, trace[12], count; };
uint32_t trace[12], traceCount;
namespace D2Client { namespace GAME { namespace Game {
eD2GSGameType CLIENT_GetD2GSGameType() {
  trace[traceCount++] = 1; trace[traceCount++] = gnHireDisplayMode; trace[traceCount++] = gnHireIconHoverIndex;
  return static_cast<eD2GSGameType>(gameType);
}
}} namespace UI { namespace ui {
uint32_t SetUIFlag(eD2UIvars flag, eD2UIvarsSetType kind, uint32_t value) {
  trace[traceCount++] = 2; trace[traceCount++] = flag; trace[traceCount++] = kind; trace[traceCount++] = value;
  trace[traceCount++] = gnHireDisplayMode; trace[traceCount++] = gnHireIconHoverIndex; return 0;
}
}}}
${baseline}
${candidate}
void reference() {
  const uint32_t mode = gnHireDisplayMode;
  if (mode == 0 || mode == 1) {
    const uint32_t type = D2Client::GAME::Game::CLIENT_GetD2GSGameType();
    if ((mode == 0 && type == GAMETYPE_SINGLEPLAYER) || (mode == 1 && type != GAMETYPE_SINGLEPLAYER)) {
      gnHireDisplayMode = 2; gnHireIconHoverIndex = 0;
      D2Client::UI::ui::SetUIFlag(UI_HIREICONS, UI_RESET, 0);
    } else {
      gnHireDisplayMode = mode == 0 ? 1 : 0;
      D2Client::UI::ui::SetUIFlag(UI_HIREICONS, UI_SET, 0);
    }
  } else {
    gnHireDisplayMode = 0;
    D2Client::UI::ui::SetUIFlag(UI_HIREICONS, UI_SET, 0);
  }
}
State run(void (*fn)(), uint32_t mode, uint32_t hover, uint32_t type) {
  gnHireDisplayMode = mode; gnHireIconHoverIndex = hover; gameType = type; traceCount = 0; fn();
  State s = {}; s.mode = gnHireDisplayMode; s.hover = gnHireIconHoverIndex; s.count = traceCount;
  for (uint32_t i = 0; i < traceCount; ++i) s.trace[i] = trace[i]; return s;
}
bool equal(const State& a, const State& b) {
  if (a.mode != b.mode || a.hover != b.hover || a.count != b.count) return false;
  for (uint32_t i = 0; i < a.count; ++i) if (a.trace[i] != b.trace[i]) return false; return true;
}
`, `
  const uint32_t modes[] = {0,1,2,3,0x7fffffff,0x80000000,0xfffffffe,0xffffffff};
  // Exercise every branch with valid enum members; the mode global covers all 32-bit patterns.
  const uint32_t types[] = {0,1,2,3,4,9,10};
  uint32_t seed = 0x493840, cases = 0;
  for (uint32_t i = 0; i < 65544; ++i) {
    seed = seed * 1664525u + 1013904223u;
    const uint32_t mode = i < 8 ? modes[i] : seed;
    for (uint32_t type : types) {
      State expected = run(reference, mode, seed ^ 0xa5a5a5a5u, type);
      if (!equal(expected, run(baseline, mode, seed ^ 0xa5a5a5a5u, type))) return 1;
      if (!equal(expected, run(candidate, mode, seed ^ 0xa5a5a5a5u, type))) return 2;
      ++cases;
    }
  }
  printf("%u\\n", cases); return 0;
`);
  assert.equal(result.trim(), '458808');
});
