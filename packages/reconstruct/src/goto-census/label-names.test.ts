/**
 * Label names for kept gotos (design section 6): each rule on the shape it reads, the
 * names it must not produce (a decompiler temporary's name, a keyword, a counter where a
 * literal tells two apart), and uniqueness.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse, NodeKind } from '@ghidra-mcp/cpp-parser';
import { proposeName, uniquify, snake, type LabelContext } from './label-names.js';

type Any = any;
function tail(code: string): Any[] {
  const tu: Any = parse(`void f() { ${code} }`);
  const fn = tu.declarations.find((d: Any) => d.kind === NodeKind.FunctionDecl);
  return fn.body.statements;
}
const ctx = (label: string, code: string, extra: Partial<LabelContext> = {}): LabelContext =>
  ({ label, tail: tail(code), tailFalls: !/return|halt/.test(code), caseValues: [], ...extra });

describe('label names', () => {
  it('library and user labels', () => {
    assert.equal(proposeName(ctx('LAB_0042afba', 'x = 1; return;', { librarySourceLabel: 'inf_leave' })).name, 'inf_leave');
    assert.deepEqual(proposeName(ctx('returnFunctionAgain', 'x = 1;')).kind, 'user');
  });
  it('structural: case, loop follow, continue point, entry', () => {
    assert.equal(proposeName(ctx('switchD_1_caseD_2', 'x = 1;', { caseValues: ['0x1b'] })).name, 'case_0x1b');
    assert.equal(proposeName(ctx('switchD_1_caseD_2', 'x = 1;', { caseValues: ['default'] })).name, 'default_case');
    assert.equal(proposeName(ctx('LAB_1', 'x = 1;', { loopExitOf: 'nIndex' })).name, 'end_nIndex_loop');
    assert.equal(proposeName(ctx('LAB_1', 'x = 1;', { loopExitOf: null })).name, 'end_outer_loop');
    assert.equal(proposeName(ctx('LAB_1', 'i++;', { loopNextOf: 'i' })).name, 'next_i');
    assert.equal(proposeName(ctx('LAB_1', 'x = 1;', { resumeOf: 'pNode' })).name, 'resume_pNode');
  });
  it('semantic: error, cleanup, done', () => {
    assert.equal(proposeName(ctx('LAB_1', 'FOG_Free(p); return 0;')).name, 'error');
    assert.equal(proposeName(ctx('LAB_1', 'LeaveCriticalSection(&cs); return n;')).name, 'cleanup');
    assert.equal(proposeName(ctx('LAB_1', '*pOut = n; p->x = 2; return 1;')).name, 'done');
    // a call that releases nothing is not `done`: it is described
    assert.equal(proposeName(ctx('LAB_1', 'D2Game::AI::PlanNextAiMove(pGame, pUnit, 0x14); return;')).name, 'plan_next_ai_move');
  });
  it('descriptive: the first call, store or test, never a decompiler temporary', () => {
    assert.equal(proposeName(ctx('LAB_1', 'D2Client::Sound::SOUND_PlaySound(5, 0, 0, 0, 0); x = 1;')).name, 'play_sound');
    assert.equal(proposeName(ctx('LAB_1', 'pState->mode = 0x1d; y = 2;')).name, 'set_mode');
    assert.equal(proposeName(ctx('LAB_1', 'iVar1 = 3; nCount = 4; y();')).name, 'set_count');
    assert.equal(proposeName(ctx('LAB_1', 'pGame_00 = p; nCount = 4;')).name, 'set_game');
    assert.equal(proposeName(ctx('LAB_1', 'if (pUnit->dwType == 1) { x(); }')).name, 'check_type');
    assert.equal(proposeName(ctx('LAB_1', 'iVar1 = 3;')).kind, 'residual');
  });
  it('module tags go; a lone word keeps its verb', () => {
    assert.equal(snake('NET_D2GS_ConnectToServer'), 'connect_to_server');
    assert.equal(snake('DRAW_text'), 'draw_text');
    assert.equal(snake('nRadiusSq', true), 'radius_sq');
  });
  it('a second label of the same name takes its literal, then another word of its block, a number only for identical blocks', () => {
    const a = { p: proposeName(ctx('LAB_1', 'p->mode = 1; x();')), tail: tail('p->mode = 1; x();') };
    const b = { p: proposeName(ctx('LAB_2', 'p->mode = 29; y();')), tail: tail('p->mode = 29; y();') };
    const c = { p: proposeName(ctx('LAB_3', 'p->mode = nNext; z();')), tail: tail('p->mode = nNext; z();') };
    const d = { p: proposeName(ctx('LAB_4', 'Flush();')), tail: tail('Flush();') };
    const e = { p: proposeName(ctx('LAB_5', 'Flush();')), tail: tail('Flush();') };
    uniquify([a, b, c, d, e]);
    assert.deepEqual([a.p.name, b.p.name, c.p.name, d.p.name, e.p.name], ['set_mode', 'set_mode_29', 'set_mode_next', 'flush', 'flush2']);
  });
});

describe('label names are identifiers', () => {
  it('enumerator and negative case values', () => {
    assert.equal(proposeName(ctx('switchD_1_caseD_2', 'x = 1;', { caseValues: ['eD2PlayerAnimMode_ns::Sequence'] })).name, 'case_Sequence');
    assert.equal(proposeName(ctx('switchD_1_caseD_2', 'x = 1;', { caseValues: ['-1'] })).name, 'case_m1');
  });
  it('g_ globals lose their prefix', () => {
    assert.equal(snake('g_nCurrentInventoryPage', true), 'current_inventory_page');
  });
});

describe('label names: what a block does, through temporaries', () => {
  it('a temporary is named for what it loads; a CRT call for what it works on; a call through a pointer for the pointer', () => {
    assert.equal(proposeName(ctx('LAB_1', 'DVar1 = procEntry.th32ParentProcessID; x();')).name, 'get_th32_parent_process_id');
    assert.equal(proposeName(ctx('LAB_1', 'memset(aLineLayouts, 0, 4); x();')).name, 'memset_line_layouts');
    assert.equal(proposeName(ctx('LAB_1', 'iVar1 = (*pSrvDoFuncData)(pUnit, pGame); x();')).name, 'call_srv_do_func_data');
  });
  it('a test that names nothing ends the description; a loop is described by its body', () => {
    assert.equal(proposeName(ctx('LAB_1', 'if (sVar1 == 3) { pGame = q; }')).kind, 'residual');
    assert.equal(proposeName(ctx('LAB_1', 'do { if (!pszFlagsCursor) { return; } q(); } while (true);', { tailFalls: true })).name, 'scan_flags_cursor');
  });
});
