/**
 * MSVC EH3 __try/__except lowered onto D2SehScope.
 *
 * The bodies are Ghidra's own (v1310, the EH3 record typed `EH3_EXCEPTION_REGISTRATION
 * tSehFrame`), the frame facts are the extraction script's own output for the same
 * program, read-only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSehFrames, applySehFrames, SEH_FRAME_SCRIPT } from '../extract/seh-frames.js';
import { sehLoweringDecision, constantFilter, handlerResume } from '../codegen/seh-lowering-spec.js';
import { generateProject } from '../codegen/index.js';
import { generatePlatformHeader } from '../codegen/platform-types.js';
import { sehLoweringPlugin, parse, emit } from '@ghidra-mcp/cpp-parser';
import type { ExtractedFunction, ProgramInfo, ReconstructOptions } from '../types.js';

/** SEH_FRAME_SCRIPT's output at v1310 (8 frames; the funclet listings as printed). */
const SCRIPT_OUTPUT = [
  'F\t00401a70\teh4\t00702290\t__except_handler4',
  'L\t-2\t1',
  'E\t0\t-2\t00401adf\t00401ae3',
  'I\tfilter\t0\t00401adf\t0\tOR EAX,0xffffffff',
  'I\tfilter\t0\t00401ae2\t0\tRET',
  'I\thandler\t0\t00401ae3\t0\tMOV ESP,dword ptr [EBP + -0x18]',
  'I\thandler\t0\t00401ae6\t1\tMOV dword ptr [EBP + -0x4],0xfffffffe',
  'F\t004e0730\teh3\t007011a0\t_except_handler3',
  'L\t-1\t1',
  'L\t0\t1',
  'E\t0\t-1\t004e0977\t004e097d',
  'I\tfilter\t0\t004e0977\t0\tMOV EAX,0x1',
  'I\tfilter\t0\t004e097c\t0\tRET',
  'I\thandler\t0\t004e097d\t0\tMOV ESP,dword ptr [EBP + -0x18]',
  'I\thandler\t0\t004e0980\t1\tMOV dword ptr [EBP + -0x4],0xffffffff',
  'I\thandler\t0\t004e0987\t1\tMOV ESI,dword ptr [EBP + -0x3c]',
  // SOUNDUTIL_ReadVersionResource re-read on 2026-10-20 with the register-store and X rows.
  'F\t00516ac0\teh3\t007011b0\t_except_handler3',
  'L\t-1\t1',
  'L\treg\t1',
  'X\t00516af6\treg\t00516af9\t-\tPUSH EBX',
  'X\t00516af6\treg\t00516b06\tEXTERNAL:00000020\tCALL dword ptr [0x006cc19c]',
  'X\t00516bda\t-1\t00516be1\t00516c01\tCALL 0x00516c01',
  'X\t00516bda\t-1\t00516be6\t-\tMOV EAX,dword ptr [EBP + -0x2c]',
  'X\t00516bda\t-1\t00516be9\t-\tMOV ECX,dword ptr [EBP + -0x10]',
  'X\t00516bda\t-1\t00516bec\t-\tMOV dword ptr FS:[0x0],ECX',
  'E\t0\t-1\t-\t00516bfc',
  'I\thandler\t0\t00516bfc\t0\tXOR EBX,EBX',
  'I\thandler\t0\t00516bfe\t0\tMOV EDI,dword ptr [EBP + -0x1c]',
  'I\thandler\t0\t00516c01\t0\tCALL dword ptr [0x006cc1b4]',
  'I\thandler\t0\t00516c07\t0\tMOV ESI,EAX',
  'F\t00689870\teh4\t007017a0\t__except_handler4',
  'L\t-2\t2',
  'L\t0\t1',
  'E\t0\t-2\t006898f9\t0068990d',
  'I\tfilter\t0\t006898f9\t0\tMOV EAX,dword ptr [EBP + -0x14]',
  'I\tfilter\t0\t006898fc\t0\tMOV ECX,dword ptr [EAX]',
  '',
].join('\n');

/** WARDEN_DecryptModule (004e0730) as the decompiler prints it at v1310, comments trimmed. */
const WARDEN = `
uint32_t __fastcall
D2Client::WARDEN_DecryptModule
          (uint **ppInput,undefined4 nInputSize,uint **ppOutput,undefined4 nOutputSize)

{
  HMODULE hModule;
  FARPROC pProcAddress;
  HANDLE hProcess;
  uint nAlignedSize;
  int nIterCount;
  uint **ppuVar1;
  uint nHeaderSize;
  void *pImageWritePtr;
  uint *ppFVar7;
  uint **ppSectionDataCursor;
  byte bSehScratch;
  DWORD dwOldProtect;
  uint nSectionIdx;
  uint *pSectionData;
  void *pCopyDst;
  int bFailed;
  byte *pRelocationEntry;
  int nRelOffset;
  uint *pModuleBase;
  uint **ppSectionEntry;
  uint nImportIdx;
  uint nRelocationCount;
  uint **ppInputSaved;
  bool bCopyPass;
  undefined1 *pSavedEsp;
  EH3_EXCEPTION_REGISTRATION tSehFrame;
  LPVOID lpAddress;
  byte nRelocEntryByte;

  tSehFrame.ScopeTable = gaWardenDecryptModuleScopeTable;
  tSehFrame.ExceptionHandler = compiler::_except_handler3;
  tSehFrame.Next = ExceptionList;
  pSavedEsp = &bSehScratch;
  bFailed = 1;
  tSehFrame.TryLevel = 0;
  ppFVar7 = *ppOutput;
  ExceptionList = &tSehFrame;
  ppInput[1] = ppFVar7;
  ppInputSaved = ppInput;
  ppFVar7 = VirtualAlloc((LPVOID)0x0,(SIZE_T)ppFVar7,0x1000,4);
  *ppInput = ppFVar7;
  if (ppFVar7 != (uint *)0x0) {
    ppuVar1 = ppOutput;
    for (nIterCount = 10; nIterCount != 0; nIterCount = nIterCount + -1) {
      *ppFVar7 = (uint)*ppuVar1;
      ppuVar1 = ppuVar1 + 1;
      ppFVar7 = ppFVar7 + 1;
    }
    pModuleBase = *ppInputSaved;
    for (nImportIdx = 0; nImportIdx < pModuleBase[8]; nImportIdx = nImportIdx + 1) {
      hModule = LoadLibraryA((LPCSTR)(pModuleBase[nImportIdx * 2] + (int)pModuleBase));
      if (hModule == (HMODULE)0x0) goto LAB_004e0980;
    }
    bFailed = 0;
  }
LAB_004e0980:
  nIterCount = bFailed;
  tSehFrame.TryLevel = -1;
  if (bFailed != 0) {
    D2Client::Warden::WardenClient::WARDEN_FreeModuleLibraries(ppInputSaved);
  }
  ExceptionList = tSehFrame.Next;
  return (uint)(nIterCount == 0);
}
`;

describe('SEH frame extraction', () => {
  it('the script reads the scope table and the funclets', () => {
    assert.ok(SEH_FRAME_SCRIPT.includes('MOV EAX,FS:[0x0]'));
    assert.ok(SEH_FRAME_SCRIPT.includes('except_handler3'));
  });

  it('parses frames, entries, level stores and funclet code', () => {
    const frames = parseSehFrames(SCRIPT_OUTPUT);
    assert.deepStrictEqual([...frames.keys()], ['00401a70', '004e0730', '00516ac0', '00689870']);
    const w = frames.get('004e0730')!;
    assert.strictEqual(w.kind, 'eh3');
    assert.strictEqual(w.scopeTable, '007011a0');
    assert.deepStrictEqual(w.tryLevelStores, { '-1': 1, '0': 1 });
    assert.strictEqual(w.entries.length, 1);
    assert.strictEqual(w.entries[0].filter, '004e0977');
    assert.strictEqual(w.entries[0].handlerCode[1].inParent, true);
    assert.strictEqual(frames.get('00516ac0')!.entries[0].filter, undefined);
    const fns = [{ address: '004e0730' }, { address: '00401000' }] as ExtractedFunction[];
    assert.strictEqual(applySehFrames(frames, fns), 1);
    assert.strictEqual(fns[0].sehFrame, w);
  });
});

describe('sehLoweringDecision', () => {
  const frames = parseSehFrames(SCRIPT_OUTPUT);
  it('lowers WARDEN_DecryptModule: filter 1, handler resumes at the try exit', () => {
    const d = sehLoweringDecision({ sehFrame: frames.get('004e0730') });
    assert.deepStrictEqual(d, {
      lower: true,
      scopes: [{ level: 0, filter: 1, filterAddress: '004e0977', handlerAddress: '004e097d', resumeAddress: '004e0980', scopeTable: '007011a0' }],
    });
  });

  it('refuses EH4 frames', () => {
    assert.deepStrictEqual(sehLoweringDecision({ sehFrame: frames.get('00401a70') }), { lower: false, reason: 'eh4 frames are not lowered' });
    assert.strictEqual(sehLoweringDecision({}), undefined);
  });

  it('lowers SOUNDUTIL_ReadVersionResource\'s __finally: one CALL 00516c01 after the try, the handler falls into it', () => {
    assert.deepStrictEqual(frames.get('00516ac0')!.tryLevelStores, { '-1': 1, reg: 1 });
    assert.deepStrictEqual(sehLoweringDecision({ sehFrame: frames.get('00516ac0') }), {
      lower: true,
      scopes: [{ kind: 'finally', bodyAddress: '00516c01', level: 0, filter: 0, filterAddress: '-', handlerAddress: '00516bfc', resumeAddress: '-', scopeTable: '007011b0' }],
    });
  });

  it('refuses a __finally whose extent the instructions do not prove', () => {
    const frame = () => structuredClone(frames.get('00516ac0')!);
    const noRecord = frame(); delete noRecord.afterStores;
    assert.match((sehLoweringDecision({ sehFrame: noRecord }) as { reason: string }).reason, /no record of the code after the try/);
    const store = frame(); store.afterStores!['00516bda'].code.splice(1, 0, { address: '00516be5', text: 'MOV dword ptr [EBP + -0x2c],EAX' });
    assert.match((sehLoweringDecision({ sehFrame: store }) as { reason: string }).reason, /not one call/);
    const elsewhere = frame(); elsewhere.entries[0].handlerCode.splice(1, 0, { address: '00516bff', text: 'CALL 0x00401000', inParent: false });
    assert.match((sehLoweringDecision({ sehFrame: elsewhere }) as { reason: string }).reason, /does not reach 00516c01/);
    const twice = frame(); twice.tryLevelStores['0'] = 1;
    assert.match((sehLoweringDecision({ sehFrame: twice }) as { reason: string }).reason, /more than once/);
  });

  it('reads only the constant filters', () => {
    const at = (text: string) => ({ address: '0', text, inParent: false });
    assert.strictEqual(constantFilter([at('MOV EAX,0x1'), at('RET')]), 1);
    assert.strictEqual(constantFilter([at('OR EAX,0xffffffff'), at('RET')]), -1);
    assert.strictEqual(constantFilter([at('XOR EAX,EAX'), at('RET')]), 0);
    assert.strictEqual(constantFilter([at('MOV EAX,0x1'), at('POP EBP'), at('RET')]), undefined);
    assert.strictEqual(constantFilter([at('MOV EAX,dword ptr [EBP + -0x14]'), at('RET')]), undefined);
  });

  it('a handler with code of its own is not an empty __except', () => {
    const at = (text: string, inParent = false) => ({ address: '00405208', text, inParent });
    assert.strictEqual(handlerResume([at('MOV ESP,dword ptr [EBP + -0x18]'), at('MOV dword ptr [EBP + -0x4],0xffffffff', false)], -1), undefined);
    assert.strictEqual(handlerResume([at('MOV ESP,dword ptr [EBP + -0x18]'), at('MOV EBX,dword ptr [EBP + 0xfffffd08]', true)], -1), undefined);
    assert.strictEqual(handlerResume([at('MOV ESP,dword ptr [EBP + -0x18]'), at('JMP 0x00405208'), at('MOV dword ptr [EBP + -0x4],0xffffffff', true)], -1), '00405208');
  });
});

const scope = { level: 0, filter: 1, filterAddress: '004e0977', handlerAddress: '004e097d', resumeAddress: '004e0980', scopeTable: '007011a0' };

describe('seh-lowering', () => {
  const run = (code: string, refusals: string[] = []) =>
    emit(sehLoweringPlugin.createTransformer({ sehScopes: [scope], onRefusal: (r: string) => refusals.push(r) })(parse(code)) as never);

  const SMALL = `int f(int *p) {
  EH3_EXCEPTION_REGISTRATION tSehFrame;
  int bFailed;
  int r;
  tSehFrame.ScopeTable = gaTable;
  tSehFrame.ExceptionHandler = _except_handler3;
  tSehFrame.Next = ExceptionList;
  bFailed = 1;
  tSehFrame.TryLevel = 0;
  ExceptionList = &tSehFrame;
  r = *p;
  if (r == 3) goto LAB_004e0980;
  if (r == 4) { ExceptionList = tSehFrame.Next; return 4; }
  bFailed = 0;
LAB_004e0980:
  r = bFailed;
  tSehFrame.TryLevel = -1;
  ExceptionList = tSehFrame.Next;
  return r;
}`;

  it('wraps the region in a D2SehScope and drops the dummy registration', () => {
    const refusals: string[] = [];
    const out = run(SMALL, refusals);
    assert.deepStrictEqual(refusals, []);
    assert.ok(/D2SehScope __seh0\{1\};/.test(out), out);
    assert.ok(/if \(D2_SEH_SETJMP\(__seh0\) == 0\)/.test(out), out);
    assert.ok(/__seh0\.Enter\(\);\s*(D2_SEH_FENCE\(\);\s*)?r = \*p;/.test(out), out);
    assert.ok(!/ExceptionList/.test(out), out);
    assert.ok(!/TryLevel|ScopeTable|ExceptionHandler/.test(out), out);
    // The handler path and the normal path meet at the exit label, after the scope block.
    const scopeEnd = out.indexOf('LAB_004e0980:');
    assert.ok(scopeEnd > out.indexOf('else'), out);
    // An early return inside the region stays a return (the destructor deregisters).
    assert.ok(/return 4;/.test(out), out);
    // bFailed = 1 runs before the __try, bFailed = 0 inside it.
    assert.ok(out.indexOf('bFailed = 1') < out.indexOf('__seh0{1}'), out);
    assert.ok(out.indexOf('bFailed = 0') > out.indexOf('Enter()'), out);
  });

  it('reads through the cast assign-cast writes on the void* ExceptionList', () => {
    const refusals: string[] = [];
    const out = run(SMALL.replace('tSehFrame.Next = ExceptionList;', 'tSehFrame.Next = (EH3_EXCEPTION_REGISTRATION*)ExceptionList;'), refusals);
    assert.deepStrictEqual(refusals, []);
    assert.ok(/D2SehScope __seh0\{1\};/.test(out), out);
    assert.ok(!/ExceptionList/.test(out), out);
  });

  it('refuses a goto into the region', () => {
    const refusals: string[] = [];
    const code = SMALL.replace('bFailed = 1;\n', 'bFailed = 1;\n  if (bFailed) goto LAB_in;\n').replace('bFailed = 0;\n', 'LAB_in:\n  bFailed = 0;\n');
    const out = run(code, refusals);
    assert.deepStrictEqual(refusals, ['goto LAB_in enters the region']);
    assert.ok(/ExceptionList = &tSehFrame/.test(out), out);
  });

  it('refuses an unrecognised use of the record', () => {
    const refusals: string[] = [];
    run(SMALL.replace('r = *p;', 'r = *p + tSehFrame.TryLevel;'), refusals);
    assert.strictEqual(refusals.length, 1);
  });

  it('refuses a second try level store', () => {
    const refusals: string[] = [];
    run(SMALL.replace('bFailed = 0;', 'tSehFrame.TryLevel = -1;\n  bFailed = 0;'), refusals);
    assert.match(refusals[0], /try level stores/);
  });
});

describe('seh-lowering keeps what the try block wrote across the longjmp', () => {
  const run = (code: string, refusals: string[] = []) =>
    emit(sehLoweringPlugin.createTransformer({ sehScopes: [scope], onRefusal: (r: string) => refusals.push(r) })(parse(code)) as never);

  /** nStep and nSum change inside the __try and are read where the __except resumes. */
  const STEPS = `int f(int *p, int k) {
  EH3_EXCEPTION_REGISTRATION tSehFrame;
  int nStep;
  int nSum;
  int nUnrelated;
  int *pCursor;
  tSehFrame.ScopeTable = gaTable;
  tSehFrame.ExceptionHandler = _except_handler3;
  tSehFrame.Next = ExceptionList;
  nStep = 1;
  nSum = k;
  nUnrelated = 4;
  tSehFrame.TryLevel = 0;
  ExceptionList = &tSehFrame;
  nStep = 2;
  pCursor = p;
  nSum = nSum + *pCursor;
  nStep = 3;
LAB_004e0980:
  nSum = nStep * 1000 + nSum + nUnrelated - 4;
  tSehFrame.TryLevel = -1;
  ExceptionList = tSehFrame.Next;
  return nSum;
}`;

  it('volatile-qualifies exactly the locals the region writes and the receiver reads', () => {
    const refusals: string[] = [];
    const out = run(STEPS, refusals);
    assert.deepStrictEqual(refusals, []);
    assert.match(out, /volatile int nStep;/, out);
    assert.match(out, /volatile int nSum;/, out);
    // Written before the region only, or never read after it: left alone.
    assert.match(out, /\n\s*int nUnrelated;/, out);
    assert.match(out, /\n\s*int\* pCursor;/, out);
  });

  it('a pointer is qualified itself, and an address taken is cast back to the declared pointer', () => {
    const code = STEPS.replace('int *pCursor;', 'int *pCursor;\n  int nOut;')
      .replace('nStep = 3;', 'Fill(&nOut);\n  nStep = 3;')
      .replace('pCursor = p;', 'pCursor = p;\n  nSum = nSum + 0;')
      .replace('return nSum;', 'return nSum + nOut + *pCursor;');
    const out = run(code);
    assert.match(out, /int\* volatile pCursor;/, out);
    assert.match(out, /volatile int nOut;/, out);
    assert.match(out, /Fill\(\(int\*\)&nOut\)/, out);
  });

  it('refuses a parameter the region writes and the code after reads (the signature is not the body\'s)', () => {
    const refusals: string[] = [];
    run(STEPS.replace('nStep = 3;', 'k = 9;\n  nStep = 3;').replace('return nSum;', 'return nSum + k;'), refusals);
    assert.deepStrictEqual(refusals, ['parameter k is written in the region and read outside it']);
  });

  it('at -O2 the __except path sees the values the try block left (i686, a real fault)', { skip: !hasLinuxI686() }, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'seh-o2-'));
    try {
      // Linux stand-in for d2_platform.h's runtime: the same __builtin_setjmp buffer; the
      // fault is a real SIGSEGV whose handler does what D2SehDispatch does after
      // RtlUnwind - pop the scope and __builtin_longjmp into the frame that ran the setjmp.
      writeFileSync(join(dir, 'harness.h'), [
        '#include <signal.h>',
        'struct EH3_EXCEPTION_REGISTRATION { void* Next; void* ExceptionHandler; void* ScopeTable; int TryLevel; };',
        'struct D2SehScope;',
        'static D2SehScope* volatile g_pActive;',
        'struct D2SehScope {',
        '  long nFilter; void* jb[5];',
        '  explicit D2SehScope(long f) : nFilter(f) {}',
        '  __attribute__((noinline)) void Enter() { g_pActive = this; }',
        '  ~D2SehScope() { if (g_pActive == this) g_pActive = 0; }',
        '};',
        '#define D2_SEH_SETJMP(scope) __builtin_setjmp((scope).jb)',
        '#define D2_SEH_FENCE() __asm__ __volatile__("" ::: "memory")',
        'static void on_segv(int) { D2SehScope* s = g_pActive; g_pActive = 0; __builtin_longjmp(s->jb, 1); }',
      ].join('\n'));
      writeFileSync(join(dir, 'main.cpp'), [
        '#include <stdio.h>', '#include <string.h>', '#include "harness.h"', '#include "body.inc"',
        'int main() {',
        '  struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_handler = on_segv; sa.sa_flags = SA_NODEFER; sigaction(SIGSEGV, &sa, 0);',
        '  int x = 5;',
        '  printf("%d %d\\n", f(&x, 7), f((int*)0, 7));',
        '  return 0;',
        '}',
      ].join('\n'));
      const build = (body: string, tag: string): string => {
        writeFileSync(join(dir, 'body.inc'), body);
        const exe = join(dir, `t${tag}`);
        execFileSync('i686-linux-gnu-g++', ['-O2', '-w', '-static', '-o', exe, join(dir, 'main.cpp')], { stdio: 'pipe' });
        return execFileSync('qemu-i386', [exe], { encoding: 'utf8' }).trim();
      };
      const lowered = run(STEPS);
      // No fault: 3*1000 + 7 + 5. Fault on *pCursor: nStep is 2 and nSum still 7.
      assert.strictEqual(build(lowered, 'q'), '3012 2007');
      // The same code without the qualifier is what setjmp semantics forbid: GCC keeps
      // the values from before the setjmp (observed: '3012 1007').
      t.diagnostic(`without volatile at -O2: ${build(lowered.replace(/volatile /g, ''), 'u')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


/** SOUNDUTIL_ReadVersionResource (00516ac0) as the decompiler prints it on 2026-10-20, comments trimmed. */
const SOUNDUTIL = `
BOOL __fastcall
SOUNDUTIL_ReadVersionResource
          (LPCSTR szText,uint *pnBufferSize,D2QServerClientPacketStrc *pBuffer)

{
  int iVar1;
  HANDLE hFile;
  int *pPeHeader;
  DWORD dwErrCode;
  int bSuccess;
  HANDLE hMapping;
  LPVOID pView;
  uint *pnBufferSizeSaved;
  HANDLE hFileSaved;
  EH3_EXCEPTION_REGISTRATION tSehFrame;
  uint nResourceSize;
  
  tSehFrame.ScopeTable = gaSoundUtilReadVersionScopeTable;
  tSehFrame.ExceptionHandler = compiler::_except_handler3;
  tSehFrame.Next = ExceptionList;
  hMapping = (HANDLE)0x0;
  pView = (LPVOID)0x0;
  bSuccess = 0;
  tSehFrame.TryLevel = 0;
  ExceptionList = &tSehFrame;
  hFile = CreateFileA(szText,0x80000000,1,(LPSECURITY_ATTRIBUTES)0x0,3,0,(HANDLE)0x0);
  if (((hFile != (HANDLE)0xffffffff) &&
      (hMapping = CreateFileMappingA(hFile,(LPSECURITY_ATTRIBUTES)0x0,2,0,0,(LPCSTR)0x0),
      hMapping != (HANDLE)0x0)) && (pView = MapViewOfFile(hMapping,4,0,0,0), pView != (short *)0x0))
  {
    if ((*(short *)pView == 0x5a4d) &&
       (pPeHeader = (int *)(*(int *)((int)pView + 0x3c) + (int)pView), *pPeHeader == 0x454c)) {
      if (pPeHeader[0x2f] == 0) {
        *pnBufferSize = 0;
        SetLastError(0x714);
      }
      else {
        iVar1 = pPeHeader[0x2e];
        nResourceSize = *(uint *)((int)pView + iVar1 + 8);
        if ((pBuffer == (D2QServerClientPacketStrc *)0x0) || (*pnBufferSize < nResourceSize)) {
          *pnBufferSize = nResourceSize;
          SetLastError(0x7a);
        }
        else {
          compiler::memset(pBuffer,0,*pnBufferSize);
          compiler::_memcpy(pBuffer,(void *)((int)pView + iVar1 + 0xc),nResourceSize);
          *pnBufferSize = nResourceSize;
          SetLastError(0);
          bSuccess = 1;
        }
      }
    }
    else {
      SetLastError(0xb);
    }
  }
  tSehFrame.TryLevel = -1;
  dwErrCode = GetLastError();
  if (pView != (LPVOID)0x0) {
    UnmapViewOfFile(pView);
  }
  if (hMapping != (HANDLE)0x0) {
    CloseHandle(hMapping);
  }
  if (hFile != (HANDLE)0xffffffff) {
    CloseHandle(hFile);
  }
  SetLastError(dwErrCode);
  ExceptionList = tSehFrame.Next;
  return bSuccess;
}
`;

const FINALLY_SCOPE = { kind: 'finally' as const, bodyAddress: '00516c01', level: 0, filter: 0, filterAddress: '-', handlerAddress: '00516bfc', resumeAddress: '-', scopeTable: '007011b0' };

/** A __try/__finally the -O2 run exercises: nStep changes in the try, the block reads it. */
const FINALLY_STEPS = `void inner(short *p) {
  EH3_EXCEPTION_REGISTRATION tSehFrame;
  int nStep;
  tSehFrame.ScopeTable = gaTable;
  tSehFrame.ExceptionHandler = _except_handler3;
  tSehFrame.Next = ExceptionList;
  nStep = 1;
  tSehFrame.TryLevel = 0;
  ExceptionList = &tSehFrame;
  nStep = 2;
  gnLoaded = (int)*p;
  nStep = 3;
  tSehFrame.TryLevel = -1;
  gnSeen = nStep;
  ExceptionList = tSehFrame.Next;
}`;

describe('seh-lowering: __try/__finally', () => {
  const run = (code: string, refusals: string[] = []) =>
    emit(sehLoweringPlugin.createTransformer({ sehScopes: [FINALLY_SCOPE], onRefusal: (r: string) => refusals.push(r) })(parse(code)) as never);

  it('SOUNDUTIL_ReadVersionResource: the inlined block becomes the termination handler, run on both paths', () => {
    const refusals: string[] = [];
    const out = run(SOUNDUTIL, refusals);
    assert.deepStrictEqual(refusals, []);
    assert.match(out, /auto __finally0 = \[&\][^{]*\{\s*dwErrCode = GetLastError\(\);/, out);
    assert.match(out, /D2SehScope __seh0\{__finally0\};\s*__seh0\.Enter\(\);/, out);
    assert.match(out, /\}\s*\/\/ normal termination[^\n]*\n\s*__finally0\(\);\s*return bSuccess;/, out);
    assert.ok(!/ExceptionList|TryLevel|ScopeTable/.test(out), out);
    // The four the try writes and the block reads survive the unwind.
    for (const v of ['hFile', 'hMapping', 'pView', 'bSuccess']) assert.match(out, new RegExp(`volatile \\w+ ${v};`), out);
    assert.match(out, /\n\s*int\* pPeHeader;/, out);
    // The block's statements moved, once: SetLastError(dwErrCode) only in the lambda.
    assert.strictEqual(out.split('SetLastError(dwErrCode)').length, 2, out);
  });

  it('refuses a return out of the __try (an abnormal termination)', () => {
    const refusals: string[] = [];
    run(SOUNDUTIL.replace('SetLastError(0xb);', 'SetLastError(0xb);\n      return 0;'), refusals);
    assert.deepStrictEqual(refusals, ['a return leaves the __try (an abnormal termination)']);
  });

  it('at -O2 the termination handler sees what the try wrote when a fault unwinds the frame (i686)', { skip: !hasLinuxI686() }, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'seh-fin-'));
    try {
      // Linux stand-in: a chain of scopes; the SIGSEGV handler does what the dispatcher and
      // RtlUnwind do with D2SehDispatch: the first scope with a filter handles it, every
      // scope above it runs its __finally block, then the handler resumes its __except.
      writeFileSync(join(dir, 'harness.h'), [
        '#include <signal.h>', '#include <stdlib.h>',
        'struct EH3_EXCEPTION_REGISTRATION { void* Next; void* ExceptionHandler; void* ScopeTable; int TryLevel; };',
        'struct D2SehScope;',
        'static D2SehScope* volatile g_pTop;',
        'struct D2SehScope {',
        '  D2SehScope* Next; long nFilter; void* jb[5]; void (*pfnFinally)(void*); void* pFinallyCtx; int bRegistered;',
        '  explicit D2SehScope(long f) : Next(0), nFilter(f), pfnFinally(0), pFinallyCtx(0), bRegistered(0) {}',
        '  template <class F> explicit D2SehScope(F& fn) : Next(0), nFilter(0), pfnFinally([](void* p) { (*(F*)p)(); }), pFinallyCtx(&fn), bRegistered(0) {}',
        '  __attribute__((noinline)) void Enter() { Next = g_pTop; g_pTop = this; bRegistered = 1; }',
        '  ~D2SehScope() { if (bRegistered) { g_pTop = Next; bRegistered = 0; } }',
        '};',
        '#define D2_SEH_SETJMP(scope) __builtin_setjmp((scope).jb)',
        '#define D2_SEH_FENCE() __asm__ __volatile__("" ::: "memory")',
        'static void on_segv(int) {',
        '  D2SehScope* t = g_pTop; while (t && t->pfnFinally) t = t->Next; if (!t) abort();',
        '  for (D2SehScope* s = g_pTop; s != t; s = s->Next) { g_pTop = s->Next; s->bRegistered = 0; s->pfnFinally(s->pFinallyCtx); }',
        '  g_pTop = t->Next; t->bRegistered = 0; __builtin_longjmp(t->jb, 1);',
        '}',
      ].join('\n'));
      writeFileSync(join(dir, 'main.cpp'), [
        '#include <stdio.h>', '#include <string.h>', '#include "harness.h"',
        'int gnLoaded, gnSeen;', '#include "body.inc"',
        '__attribute__((noinline)) int outer(short* p) {',
        '  volatile int r = 0;',
        '  { D2SehScope s{1}; if (D2_SEH_SETJMP(s) == 0) { s.Enter(); inner(p); r = 1; } else { r = 2; } }',
        '  return r;',
        '}',
        'int main() {',
        '  struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_handler = on_segv; sa.sa_flags = SA_NODEFER; sigaction(SIGSEGV, &sa, 0);',
        '  short x = 5;',
        '  int a = outer(&x); int seenA = gnSeen;',
        '  int b = outer((short*)0); int seenB = gnSeen;',
        '  printf("%d %d %d %d\\n", a, seenA, b, seenB);',
        '  return 0;',
        '}',
      ].join('\n'));
      const build = (body: string, tag: string): string => {
        writeFileSync(join(dir, 'body.inc'), body);
        const exe = join(dir, `t${tag}`);
        execFileSync('i686-linux-gnu-g++', ['-O2', '-w', '-static', '-o', exe, join(dir, 'main.cpp')], { stdio: 'pipe' });
        return execFileSync('qemu-i386', [exe], { encoding: 'utf8' }).trim();
      };
      const lowered = run(FINALLY_STEPS);
      // No fault: the block runs on the normal path and sees 3. A fault in the load:
      // the outer __except handles it, the unwind runs the block, which sees 2.
      assert.strictEqual(build(lowered, 'q'), '1 3 2 2');
      // Without the fences GCC hoists the faulting load above `nStep = 2` (observed: 1 3 2 1).
      t.diagnostic(`without fences at -O2: ${build(lowered.replace(/^\s*D2_SEH_FENCE\(\);\n/gm, ''), 'u')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function hasLinuxI686(): boolean {
  try {
    execFileSync('i686-linux-gnu-g++', ['--version'], { stdio: 'pipe' });
    execFileSync('qemu-i386', ['--version'], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

describe('WARDEN_DecryptModule end to end', () => {
  const options: ReconstructOptions = {
    outputDir: './out', format: 'cpp', organization: 'namespace', generateCMake: false,
    generateSourceMaps: false, transformPreset: 'full', includeAddressComments: false, promoteStaticGlobals: false,
  };
  const programInfo: ProgramInfo = {
    name: 'Game.exe', path: '/tmp/Game.exe', format: 'PE', architecture: 'x86', compiler: 'msvc',
    imageBase: '0x400000', languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
  };

  it('comes out as a __try with the __except resuming at LAB_004e0980', () => {
    const fn = {
      name: 'WARDEN_DecryptModule', address: '004e0730',
      signature: 'uint32_t WARDEN_DecryptModule(uint * * ppInput, undefined4 nInputSize, uint * * ppOutput, undefined4 nOutputSize)',
      returnType: 'uint32_t',
      parameters: [
        { name: 'ppInput', dataType: 'uint * *', size: 4, ordinal: 0, storage: 'ECX:4' },
        { name: 'nInputSize', dataType: 'undefined4', size: 4, ordinal: 1, storage: 'EDX:4' },
        { name: 'ppOutput', dataType: 'uint * *', size: 4, ordinal: 2, storage: 'Stack[0x4]:4' },
        { name: 'nOutputSize', dataType: 'undefined4', size: 4, ordinal: 3, storage: 'Stack[0x8]:4' },
      ],
      localVariables: [], callingConvention: '__fastcall', size: 0x280, isThunk: false, isExternal: false,
      hasVarArgs: false, namespace: 'D2Client', decompiled: WARDEN, calledFunctions: [],
      sehFrame: parseSehFrames(SCRIPT_OUTPUT).get('004e0730'),
    } as unknown as ExtractedFunction;
    const project = generateProject('T', [fn], [], [], [], [], options, programInfo, []);
    const cpp = [...project.files.entries()].find(([p, f]) => p.endsWith('.cpp') && f.content.includes('WARDEN_DecryptModule('))![1].content;
    const body = cpp.slice(cpp.indexOf('WARDEN_DecryptModule('));
    if (process.env.SHOW_SEH) console.log(body);
    assert.ok(/D2SehScope __seh0\{1\};/.test(body), body);
    assert.ok(/if \(D2_SEH_SETJMP\(__seh0\) == 0\) \{\s*__seh0\.Enter\(\);/.test(body), body);
    assert.ok(!/ExceptionList|\.TryLevel|\.ScopeTable/.test(body), body);
    // The handler's continuation (the -1 store's label) follows the scope; bFailed is
    // still 1 there on the exception path, so the module is freed and 0 returned.
    const label = body.indexOf('LAB_004e0980:');
    assert.ok(label > body.indexOf('} else {'), body);
    assert.ok(body.indexOf('WARDEN_FreeModuleLibraries', label) > label, body);
    assert.ok(body.indexOf('bFailed = 1') < body.indexOf('D2SehScope __seh0'), body);
  });

  it('SOUNDUTIL_ReadVersionResource comes out as a __try/__finally', () => {
    const fn = {
      name: 'SOUNDUTIL_ReadVersionResource', address: '00516ac0',
      signature: 'BOOL SOUNDUTIL_ReadVersionResource(LPCSTR szText, uint * pnBufferSize, D2QServerClientPacketStrc * pBuffer)',
      returnType: 'BOOL',
      parameters: [
        { name: 'szText', dataType: 'LPCSTR', size: 4, ordinal: 0, storage: 'ECX:4' },
        { name: 'pnBufferSize', dataType: 'uint *', size: 4, ordinal: 1, storage: 'EDX:4' },
        { name: 'pBuffer', dataType: 'D2QServerClientPacketStrc *', size: 4, ordinal: 2, storage: 'Stack[0x4]:4' },
      ],
      localVariables: [], callingConvention: '__fastcall', size: 0x13c, isThunk: false, isExternal: false,
      hasVarArgs: false, namespace: 'D2Sound', decompiled: SOUNDUTIL, calledFunctions: [],
      sehFrame: parseSehFrames(SCRIPT_OUTPUT).get('00516ac0'),
    } as unknown as ExtractedFunction;
    const project = generateProject('T', [fn], [], [], [], [], options, programInfo, []);
    const cpp = [...project.files.entries()].find(([p, f]) => p.endsWith('.cpp') && f.content.includes('SOUNDUTIL_ReadVersionResource('))![1].content;
    const body = cpp.slice(cpp.indexOf('SOUNDUTIL_ReadVersionResource('));
    if (process.env.SHOW_SEH) console.log(body);
    assert.match(body, /auto __finally0 = \[&\]/, body);
    assert.match(body, /D2SehScope __seh0\{__finally0\};/, body);
    assert.match(body, /__finally0\(\);\s*return bSuccess;/, body);
    assert.ok(!/ExceptionList|\.TryLevel|\.ScopeTable/.test(body), body);
  });
});

const STEPS_FOR_MINGW = `void Fill(int *p);
int f2(int *p, int k) {
  EH3_EXCEPTION_REGISTRATION tSehFrame;
  int nStep;
  int nOut;
  tSehFrame.ScopeTable = 0;
  tSehFrame.ExceptionHandler = 0;
  tSehFrame.Next = ExceptionList;
  nStep = 1;
  tSehFrame.TryLevel = 0;
  ExceptionList = &tSehFrame;
  nStep = *p + k;
  Fill(&nOut);
LAB_004e0980:
  nStep = nStep + nOut;
  tSehFrame.TryLevel = -1;
  ExceptionList = tSehFrame.Next;
  return nStep;
}
void Fill(int *p) { *p = nFillValue; }`;

function hasMingw(): boolean {
  try { execFileSync('i686-w64-mingw32-g++', ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
}

describe('D2SehScope compiles and links for i686 mingw', { skip: !hasMingw() }, () => {
  it('the platform header runtime and a lowered scope build an executable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seh-'));
    try {
      writeFileSync(join(dir, 'd2_platform.h'), generatePlatformHeader());
      writeFileSync(join(dir, 'd2_enums.h'), '');
      writeFileSync(join(dir, 't.cpp'), [
        '#include "d2_platform.h"',
        'int g;',
        'int f(int *p) {',
        '  int bFailed = 1;',
        '  {',
        '    D2SehScope __seh0{1};',
        '    if (D2_SEH_SETJMP(__seh0) == 0) {',
        '      __seh0.Enter();',
        '      g = *p;',
        '      bFailed = 0;',
        '    } else {',
        '    }',
        '  }',
        '  return bFailed;',
        '}',
        'int main() { return f((int*)0) == 1 && f(&g) == 0 ? 0 : 1; }',
        // A lowered body with volatile-qualified locals, against the real runtime, -O2.
        'namespace lowered { int nFillValue = 1; }',
        'namespace lowered {',
        emit(sehLoweringPlugin.createTransformer({ sehScopes: [scope] })(parse(STEPS_FOR_MINGW)) as never),
        '}',
        // And a __try/__finally, whose scope takes the block (the template constructor).
        'namespace lowered_finally { int gnLoaded, gnSeen;',
        emit(sehLoweringPlugin.createTransformer({ sehScopes: [FINALLY_SCOPE] })(parse(FINALLY_STEPS)) as never),
        '}',
      ].join('\n'));
      execFileSync('i686-w64-mingw32-g++', ['-std=c++17', '-O2', '-w', '-fms-extensions', '-static', '-o', join(dir, 't.exe'), join(dir, 't.cpp')], { stdio: 'pipe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
