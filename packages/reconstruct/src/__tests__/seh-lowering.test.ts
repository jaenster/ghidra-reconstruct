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
  'F\t00516ac0\teh3\t007011b0\t_except_handler3',
  'L\t-1\t1',
  'E\t0\t-1\t-\t00516bfc',
  'I\thandler\t0\t00516bfc\t0\tXOR EBX,EBX',
  'I\thandler\t0\t00516bfe\t0\tMOV EDI,dword ptr [EBP + -0x1c]',
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

  it('refuses EH4, __finally and computed filters', () => {
    assert.deepStrictEqual(sehLoweringDecision({ sehFrame: frames.get('00401a70') }), { lower: false, reason: 'eh4 frames are not typed in Ghidra' });
    assert.deepStrictEqual(sehLoweringDecision({ sehFrame: frames.get('00516ac0') }), { lower: false, reason: 'a __finally scope' });
    assert.strictEqual(sehLoweringDecision({}), undefined);
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
    assert.ok(/__seh0\.Enter\(\);\s*r = \*p;/.test(out), out);
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
});

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
      ].join('\n'));
      execFileSync('i686-w64-mingw32-g++', ['-std=c++17', '-w', '-fms-extensions', '-static', '-o', join(dir, 't.exe'), join(dir, 't.cpp')], { stdio: 'pipe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
