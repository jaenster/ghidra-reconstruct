/**
 * Label names for kept gotos (design section 6): each rule on the shape it reads, the
 * names it must not produce (a decompiler temporary's name, a keyword, a counter where a
 * word tells two apart), and uniqueness. The second half pins the seven rule changes of the
 * step-11 check (goto-proposals-check.md section 3), each on the row that broke it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse, NodeKind } from '@ghidra-mcp/cpp-parser';
import { proposeName, uniquify, snake, caseWord, isEvidence, type LabelContext } from './label-names.js';

type Any = any;
function tail(code: string): Any[] {
  const tu: Any = parse(`void f() { ${code} }`);
  const fn = tu.declarations.find((d: Any) => d.kind === NodeKind.FunctionDecl);
  return fn.body.statements;
}
function body(code: string): Any {
  const tu: Any = parse(`int f() { ${code} }`);
  return tu.declarations.find((d: Any) => d.kind === NodeKind.FunctionDecl).body;
}
const NORET = new Set(['FOG_Halt']);
/** A label's context taken from inside a whole function body, as the generator sees it. */
function inBody(code: string, label: string, extra: Partial<LabelContext> = {}): LabelContext {
  const fb = body(code);
  const list = fb.statements;
  const k = list.findIndex((x: Any) => x.kind === NodeKind.LabelStmt && x.label.name === label);
  const t = [list[k].statement, ...list.slice(k + 1)];
  const src = t.map((x: Any) => x.kind).join(' ');
  return { label, tail: t, tailFalls: !/ReturnStmt/.test(src) && !extra.endsFunction ? true : !extra.endsFunction ? false : true, caseValues: [], noreturn: NORET, fnBody: fb, labelOffset: list[k].location.start.offset, ...extra };
}
const ctx = (label: string, code: string, extra: Partial<LabelContext> = {}): LabelContext =>
  ({ label, tail: tail(code), tailFalls: !/return|halt|Halt/.test(code), caseValues: [], noreturn: NORET, ...extra });
const name = (label: string, code: string, extra: Partial<LabelContext> = {}) => proposeName(ctx(label, code, extra)).name;
const kind = (label: string, code: string, extra: Partial<LabelContext> = {}) => proposeName(ctx(label, code, extra)).kind;

describe('label names', () => {
  it('library and user labels', () => {
    assert.equal(name('LAB_0042afba', 'x = 1; return;', { librarySourceLabel: 'inf_leave' }), 'inf_leave');
    assert.deepEqual(kind('returnFunctionAgain', 'x = 1;'), 'user');
  });
  it('structural: case, loop follow, continue point, entry', () => {
    assert.equal(name('switchD_1_caseD_2', 'x = 1;', { caseValues: ['0x1b'] }), 'case_0x1b');
    assert.equal(name('switchD_1_caseD_2', 'x = 1;', { caseValues: ['default'] }), 'default_case');
    assert.equal(name('LAB_1', 'x = 1;', { loopExitOf: 'nIndex' }), 'end_index_loop');
    // no variable, no loop name: the block is described (SocketThreadMain 006c3669)
    assert.equal(name('LAB_1', 'nFdIdx++; x();', { loopExitOf: null }), 'step_fd_idx');
    assert.equal(name('LAB_1', 'nFdIdx++; x();', { loopNextOf: null }), 'step_fd_idx');
    assert.equal(name('LAB_1', 'i++;', { loopNextOf: 'i' }), 'next_i');
    // resume_ is not proposed: the block is named by what it does
    assert.equal(name('LAB_1', 'pState->mode = 1;', { resumeOf: 'pNode' }), 'set_mode');
  });
  it('semantic: error, cleanup, done', () => {
    const fb = body('p = FOG_Alloc(4); if (!p) goto LAB_1; return 1; LAB_1: FOG_Free(p); return 0;');
    assert.equal(name('LAB_1', 'FOG_Free(p); return 0;', { fnBody: fb }), 'error');
    assert.equal(proposeName(inBody('EnterCriticalSection(&cs); n = 1; LAB_1: LeaveCriticalSection(&cs); return n;', 'LAB_1')).name, 'cleanup');
    assert.equal(name('LAB_1', '*pOut = n; p->x = 2; return n;'), 'done');
    // a call that releases nothing is not `done`: it is described
    assert.equal(name('LAB_1', 'D2Game::AI::PlanNextAiMove(pGame, pUnit, 0x14); return;'), 'plan_next_ai_move');
  });
  it('descriptive: the first call, store or test, never a decompiler temporary', () => {
    assert.equal(name('LAB_1', 'D2Client::Sound::SOUND_PlaySound(5, 0, 0, 0, 0); x = 1;'), 'play_sound');
    assert.equal(name('LAB_1', 'pState->mode = 0x1d; y = 2;'), 'set_mode');
    assert.equal(name('LAB_1', 'iVar1 = 3; nCount = 4; y();'), 'set_count');
    assert.equal(name('LAB_1', 'pGame_00 = p; nCount = 4;'), 'set_game');
    assert.equal(name('LAB_1', 'if (pUnit->dwType == 1) { x(); }'), 'check_type');
    assert.equal(kind('LAB_1', 'iVar1 = 3;'), 'residual');
  });
  it('module tags go; a lone word keeps its verb', () => {
    assert.equal(snake('NET_D2GS_ConnectToServer'), 'connect_to_server');
    assert.equal(snake('DRAW_text'), 'draw_text');
    assert.equal(snake('nRadiusSq', true), 'radius_sq');
    assert.equal(snake('pwszStr', true), 'str');
    assert.equal(snake('pWszLocale', true), 'locale');
    assert.equal(snake('fpOnPress', true), 'on_press');
  });
});

describe('label names are identifiers', () => {
  it('enumerator and negative case values', () => {
    assert.equal(name('switchD_1_caseD_2', 'x = 1;', { caseValues: ['eD2PlayerAnimMode_ns::Sequence'] }), 'case_Sequence');
    assert.equal(name('switchD_1_caseD_2', 'x = 1;', { caseValues: ['-1'] }), 'case_0xffffffff');
  });
  it('g_ globals lose their prefix', () => {
    assert.equal(snake('g_nCurrentInventoryPage', true), 'current_inventory_page');
  });
});

describe('label names: what a block does, through temporaries', () => {
  it('a temporary is named for what it loads; a CRT call for what it works on; a call through a pointer for the pointer', () => {
    assert.equal(name('LAB_1', 'DVar1 = procEntry.th32ParentProcessID; x();'), 'get_th32_parent_process_id');
    assert.equal(name('LAB_1', 'memset(aLineLayouts, 0, 4); x();'), 'memset_line_layouts');
    assert.equal(name('LAB_1', 'iVar1 = (*pSrvDoFuncData)(pUnit, pGame); x();'), 'call_srv_do_func_data');
  });
  it('a test that names nothing ends the description; a loop is described by its body', () => {
    assert.equal(kind('LAB_1', 'if (sVar1 == 3) { pGame = q; }'), 'residual');
    assert.equal(name('LAB_1', 'do { if (pState->pszFlagsCursor == 0) { return; } q(); } while (true);', { tailFalls: true }), 'scan_flags_cursor');
    // a loop whose body starts with a null guard on a variable names nothing
    assert.equal(kind('LAB_1', 'do { if (!pszFlagsCursor) { return; } q(); } while (true);', { tailFalls: true }), 'residual');
  });
});

// ---------------------------------------------------------------- the step-11 check's rules

describe('rule 1: semantic names are judged on the straight block to the return', () => {
  it('a release deep in a long tail does not make the block an error (SFileOpenArchive 0041bb3e)', () => {
    const fb = body('EnterCriticalSection(&cs); LAB_1: SFILE_CheckForCdRom(p); h = CreateFileA(p); if (!h) { LeaveCriticalSection(&cs); return 0; } LeaveCriticalSection(&cs); return 1;');
    const t = 'SFILE_CheckForCdRom(p); h = CreateFileA(p); if (!h) { LeaveCriticalSection(&cs); return 0; } LeaveCriticalSection(&cs); return 1;';
    assert.equal(name('LAB_1', t, { fnBody: fb, tailFalls: false }), 'check_for_cd_rom');
  });
  it('a UI verb is not a release (NPCMENU_CloseNpcInteraction), nor a release of what the function never acquired (FreeAi)', () => {
    const fb = body('if (a) goto LAB_1; return 1; LAB_1: NPCMENU_CloseNpcInteraction(pUnit); return 0;');
    assert.notEqual(name('LAB_1', 'NPCMENU_CloseNpcInteraction(pUnit); return 0;', { fnBody: fb }), 'error');
    const fb2 = body('if (a) goto LAB_1; return; LAB_1: MONSTERAI_CommandWalkToUnit(pGame, pUnit); FreeAi(pGame, pUnit); return;');
    assert.equal(name('LAB_1', 'MONSTERAI_CommandWalkToUnit(pGame, pUnit); FreeAi(pGame, pUnit); return;', { fnBody: fb2 }), 'command_walk_to_unit');
  });
  it('error needs the other paths to return something else: all-zero returns are cleanup (EnumerateModulesPsapi 0040bc25)', () => {
    // the fallthrough into the block can itself be a failure path (LoadModuleSymbols 0040250a): error
    const fb = body('EnterCriticalSection(&cs); if (!a) goto LAB_1; if (p) { n = p(); LeaveCriticalSection(&cs); return n; } LAB_1: LeaveCriticalSection(&cs); return 0;');
    assert.equal(name('LAB_1', 'LeaveCriticalSection(&cs); return 0;', { fnBody: fb, fallsInto: true }), 'error');
    assert.equal(proposeName(inBody('h = OpenProcess(1); if (!h) return 0; if (b) goto LAB_1; x(); LAB_1: CloseHandle(h); return 0;', 'LAB_1')).name, 'cleanup');
    // another exit makes the same release: this block is one outcome's exit, and void says nothing (SetSymbolSearchPath 0040234b)
    assert.notEqual(proposeName(inBody('EnterCriticalSection(&cs); if (!a) goto LAB_1; if (p) { p(); LeaveCriticalSection(&cs); return; } LAB_1: LeaveCriticalSection(&cs); return;', 'LAB_1')).name, 'cleanup');
  });
  it('a void function that falls off its end takes the same rule (CHAT_InitIME release)', () => {
    assert.equal(proposeName(inBody('hImc = ImmGetContext(hWnd); if (a) goto LAB_1; x(); LAB_1: ImmReleaseContext(hWnd, hImc);', 'LAB_1', { endsFunction: true, tailFalls: true })).name, 'cleanup');
  });
});

describe('rule 2: loop names only from the loop the source iterates', () => {
  it('an exit Ghidra laid inside a loop is not a resume point (IsTokenFirstGame, SMemFindNextBlock)', () => {
    assert.equal(proposeName(inBody('pGame = GetGameByToken(t); if (a) goto LAB_1; x(); LAB_1: Server::Unlock(pGame); return nResult;', 'LAB_1', { resumeOf: 'nIndex' })).name, 'cleanup');
    assert.equal(name('LAB_1', '*ppOutBlock = pBlock; return pBlock;', { resumeOf: 'pBlock' }), 'done');
    // a store and a failure return is not `done` (ITEMMODE_UseItemOnItem, SCMD_0x18 BAD_DATA)
    assert.notEqual(name('LAB_1', '*ppOutBlock = 0; return 0;'), 'done');
    assert.notEqual(name('LAB_1', '*pOut = 1; return SERVERSTATUS_BAD_DATA;'), 'done');
    assert.notEqual(name('LAB_1', 'return 1;'), 'done');
    // a constant result could mean anything (TestCollision returns TRUE = blocked)
    assert.notEqual(name('LAB_1', '*pBlock = p; return 1;'), 'done');
    // the stored value returned through the out-parameter is the failure 0 (0052bd20)
    assert.notEqual(name('LAB_1', '*pSize = 0; return *pSize;'), 'done');
    // fresh arithmetic stored is the function's work, not a write-back (DRLGOUTDOOR_AllocPresetFileTracker 006743a7)
    assert.notEqual(name('LAB_1', 'iVar1 = (pNode->dwData2 + 1) % pNode->dwData1; pNode->dwData2 = iVar1; return iVar1;'), 'done');
    assert.equal(name('LAB_1', 'pNext->nLink = 0; *pNextPtr = 0; return nLruHead;'), 'done');
  });
  it('resume_ claims nothing about the source loop: the descriptive rule names it', () => {
    assert.equal(name('LAB_1', 'pPath->aPathPoints[nWaypointCount] = p; nWaypointCount++; x();', { resumeOf: 'nWaypointCount' }), 'set_path_points');
  });
  it('the variable is spelled lower snake (next_item_index)', () => {
    assert.equal(name('LAB_1', 'nItemIndex++;', { loopNextOf: 'nItemIndex' }), 'next_item_index');
  });
});

describe('rule 3: names that are not evidence', () => {
  it('types, flag and compare temporaries, placeholders, positional and scratch names', () => {
    for (const n of ['uintptr_t', 'size_t', 'COLBIT_NONE', 'MAX_PATH', 'uint32_t', 'uint8_t', 'uint64_t', 'bSignedLessOrEqual', 'bSignedLess', 'nCmpSign', 'nCmpResult', 'nByteDiff', 'nMemcmpResult', 'unk0x14', 'unk14', 'field18', 'nParam2', 'dwArg0', 'pTmp', 'nCalcTmp', 'pBufCopy', 'nUnsetFlags0x20', '_base', '_flag'])
      assert.equal(isEvidence(n), false, n);
    for (const n of ['nItemIndex', 'pUnit', 'dwFlags', 'szText', 'nFace']) assert.equal(isEvidence(n), true, n);
  });
  it('a block that only writes such names is a ticket, not a name (00641c16, 0057a32f, 004a4b94)', () => {
    assert.equal(kind('LAB_1', 'bSignedLessOrEqual = a <= b;'), 'residual');
    assert.equal(kind('LAB_1', 'PStack_108.y = 3;'), 'residual');
    assert.equal(kind('LAB_1', 'uVar1 = (uint32_t)x;'), 'residual');
    assert.equal(kind('LAB_1', 'p->unk0x14 = 0;'), 'residual');
    assert.equal(kind('LAB_1', 'pFileReg->_base++;'), 'residual');
  });
  it('a function spelled like a global is not evidence (gnRecordingIndex)', () => {
    assert.equal(name('LAB_1', 'gnRecordingIndex(p); pUnit->dwSfxTicks = t;'), 'set_sfx_ticks');
  });
  it('Hungarian after a leading underscore goes (_bIsOpen -> set_is_open)', () => {
    assert.equal(name('LAB_1', 'p->_bIsOpen = 1;'), 'set_is_open');
  });
  it('a placeholder global or callee is not evidence (D2CLIENT_ExitVar3, SetUnsetFlags0x20, StubHook2, a tree macro)', () => {
    assert.equal(kind('LAB_1', 'ErrorManager::StubHook2();'), 'residual');
    assert.equal(kind('LAB_1', 'UnusedDebugFunction(p);'), 'residual');
    assert.equal(kind('LAB_1', 'D2_STORE24(p, 1);'), 'residual');
    assert.equal(kind('LAB_1', 'if (D2CLIENT_ExitVar3 == 0) { x(); }'), 'residual');
    assert.equal(kind('LAB_1', 'SetUnsetFlags0x20(p, 1);'), 'residual');
  });
  it("the stack-cookie check is not the block's work (GuardStack before a return is done)", () => {
    assert.equal(name('LAB_1', '*pOut = n; GuardStack(); return n;'), 'done');
  });
  it("Storm's S prefix is a tag (SStrCopy -> str_copy)", () => {
    assert.equal(snake('SStrCopy'), 'str_copy');
    assert.equal(snake('SFileReadFileEx2'), 'read_file_ex2');
  });
  it('a hex number in a name is one word', () => {
    assert.equal(snake('CLIENTMODE_ExtractPacketSizeFrom0xAE'), 'extract_packet_size_from_0xae');
  });
});

describe('rule 4: a getter that only feeds the next statement names nothing', () => {
  it('the consumer names the block (SUNIT_GetClient -> the send)', () => {
    assert.equal(name('LAB_1', 'pClient = SUNIT_GetClient(pUnit); D2GAME_SendTransactionResult(pClient, 0x2a); return;'), 'send_transaction_result');
  });
  it('a test names its first operand, not an inner call (check_get_room)', () => {
    assert.equal(name('LAB_1', 'if (pOwner->dwType == 0 && DUNGEON_IsRoomInTown(UNITS_GetRoom(pOwner))) { x(); }'), 'check_type');
    assert.equal(name('LAB_1', 'if (STATLIST_GetUnitStat(pUnit, 3) < 5) { x(); }'), 'check_unit_stat');
  });
});

describe('rule 5: uniqueness by a word or the suffix 2, never an incidental literal', () => {
  it('a second label of the same name takes another word of its block, then a number', () => {
    const mk = (l: string, code: string) => ({ p: proposeName(ctx(l, code)), tail: tail(code) });
    const a = mk('LAB_1', 'p->mode = 1; x();');
    const b = mk('LAB_2', 'p->mode = 29; y();');
    const c = mk('LAB_3', 'p->mode = nNext; z();');
    const d = mk('LAB_4', 'pBuf->Flush();');
    const e = mk('LAB_5', 'pBuf->Flush();');
    uniquify([a, b, c, d, e]);
    assert.deepEqual([a.p.name, b.p.name, c.p.name, d.p.name, e.p.name], ['set_mode', 'set_mode2', 'set_mode_next', 'flush_buf', 'flush_buf2']);
  });
  it('section-6 names take the suffix 2 (done2, default_case2)', () => {
    const a = { p: proposeName(ctx('LAB_1', '*pOut = 1; return n;')), tail: tail('*pOut = 1; return n;') };
    const b = { p: proposeName(ctx('LAB_2', 'aResult[0] = n; return n;')), tail: tail('aResult[0] = n; return n;') };
    uniquify([a, b]);
    assert.deepEqual([a.p.name, b.p.name], ['done', 'done2']);
    const c = { p: proposeName(ctx('LAB_3', 'if (nClass2 == 1) { x(); }')), tail: tail('if (nClass2 == 1) { x(); }') };
    const d = { p: proposeName(ctx('LAB_4', 'if (nClass2 == 1) { x(); }')), tail: tail('if (nClass2 == 1) { x(); }') };
    uniquify([c, d]);
    assert.deepEqual([c.p.name, d.p.name], ['check_class2', 'check_class2_2']);
  });
});

describe('rule 6: case values spell as identifiers', () => {
  it('chars as their letter or their code; negative and high values as unsigned hex', () => {
    assert.equal(caseWord("'z'").word, 'z');
    assert.equal(caseWord("'$'").word, '0x24');
    assert.equal(caseWord("'\\n'").word, '0xa');
    assert.equal(caseWord('-0x7ffffffa').word, '0x80000006');
    assert.equal(caseWord('0x80000006').word, '0x80000006');
    assert.equal(caseWord('7').word, '7');
    assert.equal(name('switchD_1_caseD_24', 'x = 1;', { caseValues: ["'$'"] }), 'case_0x24');
    assert.equal(name('switchD_1_caseD_7a', 'x = 1;', { caseValues: ["'z'"] }), 'case_z');
    // many values, one body: the lowest (STRING_CheckIfPlayerNameDoNotContainForbidenChars 0052c5eb)
    assert.equal(name('switchD_0052c5d2_caseD_41', 'x = 1;', { caseValues: ["'z'", "'A'", "'b'"] }), 'case_A');
    // Ghidra's caseD_<v> picks among the values (0x220 among 0x2c5, 0x220, 0x22f)
    assert.equal(name('switchD_1_caseD_220', 'x = 1;', { caseValues: ['0x2c5', '0x22f', '0x220'] }), 'case_0x220');
  });
  it('zlib inflate cases take the inflate_mode enumerator, by function address', () => {
    const p = proposeName(ctx('switchD_00429c46_caseD_42a61a', 'x = 1;', { caseValues: ['0x12'], fnAddress: '00429bb0' }));
    assert.deepEqual([p.name, p.kind], ['case_CODELENS', 'library']);
    assert.equal(name('switchD_1_caseD_2', 'x = 1;', { caseValues: ['2'], fnAddress: '00429bb0' }), 'case_TIME');
    assert.equal(name('switchD_1_caseD_2', 'x = 1;', { caseValues: ['2'], fnAddress: '00400000' }), 'case_2');
  });
  it('inflate_fast `dodist` by the block address, whatever the function is called', () => {
    assert.equal(name('LAB_0042de50', 'while (true) { x(); }', { address: '0042de50', fnAddress: '0042dca0' }), 'dodist');
  });
});

describe('rule 8: a verbatim one-word API takes what it works on, or names nothing', () => {
  it('socket / Sleep / Unlock', () => {
    assert.equal(name('LAB_1', 'Server::Unlock(pGame); x();'), 'unlock_game');
    assert.equal(kind('LAB_1', 'socket(2, 1, 0);'), 'residual');
    assert.equal(name('LAB_1', 'Sleep(100); nRetries++;'), 'step_retries');
  });
  it('an increment steps and a zero store clears', () => {
    assert.equal(name('LAB_1', 'pRoom->nRefCount += 1;'), 'step_ref_count');
    assert.equal(name('LAB_1', 'pSortedNext = nullptr; x();'), 'clear_sorted_next');
  });
});

describe('the second re-read: names from misnamed locals, joins, guards', () => {
  it("a local's name is not evidence; a field's is", () => {
    const locals = new Set(['nFreeSlots', 'nLinePixelWidth']);
    assert.equal(kind('LAB_1', 'nFreeSlots = a - b; x();', { locals }), 'residual');
    assert.equal(kind('LAB_1', 'while (nLinePixelWidth > 0) { nLinePixelWidth--; }', { locals, tailFalls: true }), 'residual');
    assert.equal(name('LAB_1', 'pGame->nFreeSlots = 0; x();', { locals }), 'clear_free_slots');
  });
  it('a null guard names nothing; a field test does', () => {
    assert.equal(kind('LAB_1', 'if (pUnit) { x(); }'), 'residual');
    assert.equal(kind('LAB_1', 'if (pUnit == 0) { x(); }'), 'residual');
    assert.equal(name('LAB_1', 'if (pUnit->bFlag) { x(); }'), 'check_flag');
  });
  it('a copy of a variable or a comparison into a temp is not a get (00593a46, 00641c16)', () => {
    assert.equal(kind('LAB_1', 'pDVar1 = pQuestData;'), 'residual');
    assert.equal(kind('LAB_1', 'bVar1 = nPosY <= 5;'), 'residual');
    assert.equal(name('LAB_1', 'iVar1 = pUnit->nMode; x();'), 'get_mode');
  });
  it('a release of what the function only acquires after the label is not a cleanup (004832cf)', () => {
    const fb2 = body('MPQ_LoadAllMediaMpqFiles(); if (a) goto LAB_1; return; LAB_1: MPQ_UnloadAllMediaMpqFiles(); MPQ_LoadAllMediaMpqFiles();');
    assert.notEqual(name('LAB_1', 'MPQ_UnloadAllMediaMpqFiles(); MPQ_LoadAllMediaMpqFiles();', { fnBody: fb2, endsFunction: true, tailFalls: true }), 'cleanup');
    const fb = body('if (a) goto LAB_1; return; LAB_1: MPQ_UnloadAllMediaMpqFiles(); MPQ_LoadAllMediaMpqFiles();');
    const t = 'MPQ_UnloadAllMediaMpqFiles(); MPQ_LoadAllMediaMpqFiles();';
    const off = fb.statements[2].location.start.offset;
    assert.notEqual(name('LAB_1', t, { fnBody: fb, endsFunction: true, tailFalls: true, labelOffset: off }), 'cleanup');
  });
});

describe('the second re-read: returned flags, frame groups, loads feeding a call', () => {
  it('a returned variable is judged by its last store (GetSymbolNameForAddress 00402099)', () => {
    const fb = body('EnterCriticalSection(&cs); if (!a) goto LAB_1; if (p) { LeaveCriticalSection(&cs); bVar1 = true; return bVar1; } LAB_1: LeaveCriticalSection(&cs); bVar1 = false; return bVar1;');
    assert.equal(name('LAB_1', 'LeaveCriticalSection(&cs); bVar1 = false; return bVar1;', { fnBody: fb }), 'error');
  });
  it('a frame-group member is a local', () => {
    assert.equal(kind('LAB_1', '__frame0.pEffectiveMode = 0;'), 'residual');
  });
  it('a field load that feeds the next statement is named by the consumer', () => {
    assert.equal(name('LAB_1', 'pDVar1 = pGame->pQuestData; QUESTS_AdvanceState(pDVar1, 4);'), 'advance_state');
  });
});
