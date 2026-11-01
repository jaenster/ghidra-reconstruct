import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parse, emit, frameGroupLocalsPlugin } from '@ghidra-mcp/cpp-parser';
import type { ExtractedFunction } from '../types.js';
import { createParamReachOracle, type ReachGlobal } from './param-reach.js';

/** A callee as the snapshot carries it: prototype, and the decompile with its signature. */
function fn(name: string, params: [string, string][], body: string, extra: Partial<ExtractedFunction> = {}): ExtractedFunction {
  const sig = params.map(([t, n]) => `${t} ${n}`).join(',');
  return {
    name,
    address: '00401000',
    signature: `void ${name}(${sig})`,
    returnType: 'void',
    parameters: params.map(([t, n], i) => ({ name: n, dataType: t, size: 4, ordinal: i })),
    localVariables: [],
    decompiled: `\nvoid __cdecl ${name}(${sig})\n\n{\n${body}\n}\n`,
    callingConvention: '__cdecl',
    size: 16,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    ...extra,
  };
}

function oracleOf(fns: ExtractedFunction[], globals: ReachGlobal[] = []) {
  return createParamReachOracle(new Map(fns.map(f => [f.name, f])), [], globals);
}

/** The caller from the classification: two adjacent ints, both addresses passed out. */
const slots = [
  { name: 'nX', offset: -12, size: 4 },
  { name: 'nY', offset: -8, size: 4 },
];
const caller = (call: string) => `void caller() {
  int nX;
  int nY;
  ${call}
  use(nX, nY);
}`;

function groupedIn(code: string, frame: typeof slots, fns: ExtractedFunction[], globals: ReachGlobal[] = []): boolean {
  const oracle = oracleOf(fns, globals);
  const t = frameGroupLocalsPlugin.createTransformer({
    slots: frame,
    argReach: (c: string, i: number, n: number) => oracle.argReach(c, i, n),
    computedArgReach: (c: never, i: number, n: number) => oracle.argReachThrough(c, i, n),
  } as never);
  const out = emit(t(parse(code)) as never);
  return /struct\s+__frame0_t/.test(out);
}

function grouped(call: string, fns: ExtractedFunction[], globals: ReachGlobal[] = []): boolean {
  return groupedIn(caller(call), slots, fns, globals);
}

describe('frame-group-locals with callee reach', () => {
  it('two out-parameters, one word each: no group', () => {
    const get = fn('GetPair', [['int *', 'pnX'], ['int *', 'pnY']], '  *pnX = 1;\n  *pnY = 2;');
    assert.strictEqual(grouped('GetPair(&nX, &nY);', [get]), false);
  });

  it('a callee that indexes [1] through an int *: group', () => {
    const line = fn('DrawLine', [['int *', 'pnStart']], '  gx = *pnStart;\n  gy = pnStart[1];');
    assert.strictEqual(grouped('DrawLine(&nX);', [line]), true);
  });

  it('a callee that memsets past the local: group', () => {
    const clear = fn('Clear', [['int *', 'p']], '  memset(p, 0, 8);');
    assert.strictEqual(grouped('Clear(&nX);', [clear]), true);
  });

  it('a callee that memsets exactly the local: no group', () => {
    const clear = fn('Clear', [['int *', 'p']], '  memset(p, 0, 4);');
    const other = fn('Other', [['int *', 'p']], '  *p = 0;');
    assert.strictEqual(grouped('Clear(&nX); Other(&nY);', [clear, other]), false);
  });

  it('a pass-through to a callee that reaches past: group', () => {
    const inner = fn('Inner', [['int *', 'p']], '  p[1] = 0;');
    const outer = fn('Outer', [['int *', 'p']], '  Inner(p);');
    assert.strictEqual(grouped('Outer(&nX);', [inner, outer]), true);
  });

  it('a pass-through to a callee that stays inside: no group', () => {
    const inner = fn('Inner', [['int *', 'p']], '  *p = 0;');
    const outer = fn('Outer', [['int *', 'p']], '  if (p != 0) Inner(p);');
    assert.strictEqual(grouped('Outer(&nX); Outer(&nY);', [inner, outer]), false);
  });

  it('an indirect call: group', () => {
    assert.strictEqual(grouped('(*gpfnHandler)(&nX);', []), true);
  });

  it('a callee the model does not know: group', () => {
    assert.strictEqual(grouped('GetSomething(&nX);', []), true);
  });

  it('a documented out-parameter larger than the local: group', () => {
    // GetCursorPos writes a POINT, eight bytes, through the address of a four-byte int.
    assert.strictEqual(grouped('GetCursorPos(&nX);', []), true);
  });

  it('documented one-word out-parameters: no group', () => {
    assert.strictEqual(grouped('GetDiskFreeSpaceA(0, &nX, &nY, 0, 0);', []), false);
  });

  it('a buffer whose count is not a literal: group', () => {
    assert.strictEqual(grouped('ReadFile(h, &nX, nLen, &nY, 0);', []), true);
  });

  it('a namespaced callee is not the platform call it is named after: group', () => {
    assert.strictEqual(grouped('Net::GetDiskFreeSpaceA(0, &nX, &nY, 0, 0);', []), true);
  });

  it('scanf conversions that store one word each: no group', () => {
    assert.strictEqual(grouped('sscanf(sz, "%d.%d", &nX, &nY);', []), false);
  });

  it('a scanf string conversion: group', () => {
    assert.strictEqual(grouped('sscanf(sz, "%s %d", &nX, &nY);', []), true);
  });

  it('a scanf conversion wider than the local: group', () => {
    assert.strictEqual(grouped('sscanf(sz, "%I64d", &nX);', []), true);
  });

  it('a callee passing the pointer to an indirect call: group', () => {
    const disp = fn('Dispatch', [['int *', 'p']], '  (*gpfnHandler)(p);');
    assert.strictEqual(grouped('Dispatch(&nX);', [disp]), true);
  });

  it('a recursive callee: group', () => {
    const rec = fn('Walk', [['int *', 'p'], ['int', 'n']], '  *p = n;\n  if (n != 0) Walk(p, n - 1);');
    assert.strictEqual(grouped('Walk(&nX, 3);', [rec]), true);
  });

  it('mutual recursion: group', () => {
    const a = fn('A', [['int *', 'p']], '  *p = 0;\n  B(p);');
    const b = fn('B', [['int *', 'p']], '  A(p);');
    assert.strictEqual(grouped('A(&nX);', [a, b]), true);
  });

  it('an argument count that disagrees with the prototype: group', () => {
    const get = fn('GetOne', [['int *', 'p']], '  *p = 1;');
    assert.strictEqual(grouped('GetOne(&nX, 1);', [get]), true);
  });

  it('a body reading arguments outside its prototype: group', () => {
    const odd = fn('Odd', [['int *', 'p']], '  *p = 1;\n  *in_stack_00000008 = 2;');
    assert.strictEqual(grouped('Odd(&nX);', [odd]), true);
  });

  it('an address stored, not passed: group', () => {
    assert.strictEqual(grouped('gpSaved = &nX;', []), true);
  });
});

/** A renderer function table in the image, its `nfpGetScreenSize` slot set to `impl`. */
function table(name: string, impl: string | null): ReachGlobal {
  return {
    name,
    dataType: 'D2RendererFunctionsStrc',
    initializedData: {
      kind: 'struct',
      fields: [
        { name: 'nfpInitialize', value: { kind: 'pointer', value: 'Glide::Initialize' } },
        { name: 'nfpGetScreenSize', value: { kind: 'pointer', value: impl ?? 'DAT_00000000' } },
      ],
    },
  };
}

const currentRenderer: ReachGlobal = { name: 'RENDERER_CurrentRenderedFunctions', dataType: 'D2RendererFunctionsStrc *' };

/** D2GFX_GetScreenSize @004f59b0: a forward through the current renderer's table. */
const getScreenSize = fn('D2GFX_GetScreenSize', [['int *', 'pWidth'], ['int *', 'pHeight']],
  '  int nResult;\n  nResult = (*RENDERER_CurrentRenderedFunctions->nfpGetScreenSize)(pWidth,pHeight);\n  return nResult;');
const storesBoth = (name: string) => fn(name, [['int *', 'pWidth'], ['int *', 'pHeight']],
  '  *pWidth = gnWidth;\n  *pHeight = gnHeight;');

const screenSlots = [
  { name: 'nScreenWidth', offset: -12, size: 4 },
  { name: 'nScreenHeight', offset: -8, size: 4 },
];

/** TakeScreenshot @004fa7a0 and D2WIN_TakeThrottledScreenshot @004fa0c0, as Ghidra prints them. */
const takeScreenshot = (guard: string, file: string) => `void f(LPCSTR szFileName) {
  int nScreenWidth;
  int nScreenHeight;
  DWORD dwTickCount = GetTickCount();
  if (!(${guard})) {
    return;
  }
  nScreenWidth = 0;
  nScreenHeight = 0;
  D2GFX_GetScreenSize(&nScreenWidth, &nScreenHeight);
  uint8_t *pBuffer = (uint8_t *)D2_ALLOC_AT(nScreenHeight * nScreenWidth * 3, ".\\Src\\D2WinMain.cpp", 0x6a7);
  if (D2gfx::D2GFX::D2GFX_GetBackBuffer(pBuffer)) {
    D2WIN_SaveScreenshotToFile(pBuffer, ${file}, nScreenWidth, nScreenHeight);
  }
  gdwLastScreenshotTick = dwTickCount;
}`;

describe('frame groups the original never had (msvc8 MATCH once separate)', () => {
  const renderers = [currentRenderer, table('GlideFunctionTable', 'Glide::GetScreenSize'),
    table('DirectDrawFunctionTable', 'DDraw::GetScreenSize')];
  const fns = () => [getScreenSize, storesBoth('Glide::GetScreenSize'), storesBoth('DDraw::GetScreenSize')];

  it('TakeScreenshot: GetScreenSize reaches one int through each pointer', () => {
    const code = takeScreenshot('dwTickCount - gdwLastScreenshotTick >= 1000', '(LPCSTR)0x0');
    assert.strictEqual(groupedIn(code, screenSlots, fns(), renderers), false);
  });

  it('D2WIN_TakeThrottledScreenshot: the same call', () => {
    const code = takeScreenshot('dwTickCount - gdwLastScreenshotTick >= 1000 || szFileName', 'szFileName');
    assert.strictEqual(groupedIn(code, screenSlots, fns(), renderers), false);
  });

  it('CreateRegedit: the RegEnumValueA length words', () => {
    const code = `void f(HKEY hKeySrc, HKEY hKeyDest) {
      DWORD dwValueNameLen;
      DWORD dwValueDataSize;
      DWORD dwIndex = 0;
      LONG nRegStatus;
      do {
        dwValueNameLen = 0x104;
        dwValueDataSize = 0x400;
        nRegStatus = RegEnumValueA(hKeySrc, dwIndex, szValueName, &dwValueNameLen, (LPDWORD)0x0, (LPDWORD)&dwValueInfo, dataBuf, &dwValueDataSize);
        if (nRegStatus == 0) {
          RegSetValueExA(hKeyDest, szValueName, 0, (DWORD)dwValueInfo, dataBuf, dwValueDataSize);
        }
        dwIndex = dwIndex + 1;
      } while (nRegStatus == 0);
    }`;
    const frame = [
      { name: 'dwValueNameLen', offset: -16, size: 4 },
      { name: 'dwValueDataSize', offset: -12, size: 4 },
    ];
    assert.strictEqual(groupedIn(code, frame, []), false);
  });

  it('one implementer that reaches past its pointer: group', () => {
    const wide = fn('DDraw::GetScreenSize', [['int *', 'pWidth'], ['int *', 'pHeight']],
      '  *pWidth = gnWidth;\n  pWidth[1] = gnHeight;');
    const code = takeScreenshot('dwTickCount != 0', '(LPCSTR)0x0');
    assert.strictEqual(groupedIn(code, screenSlots, [getScreenSize, storesBoth('Glide::GetScreenSize'), wide], renderers), true);
  });

  it('a table the image does not initialise: group', () => {
    const runtime: ReachGlobal = { name: 'gSoftwareFunctionTable', dataType: 'D2RendererFunctionsStrc' };
    const code = takeScreenshot('dwTickCount != 0', '(LPCSTR)0x0');
    assert.strictEqual(groupedIn(code, screenSlots, fns(), [...renderers, runtime]), true);
  });

  it('a slot holding something other than a function: group', () => {
    const odd: ReachGlobal = { ...table('gOddTable', null) };
    odd.initializedData!.fields![1].value = { kind: 'scalar', value: '0x4f59b0' };
    const code = takeScreenshot('dwTickCount != 0', '(LPCSTR)0x0');
    assert.strictEqual(groupedIn(code, screenSlots, fns(), [...renderers, odd]), true);
  });

  it('a slot naming a function the model does not have: group', () => {
    const code = takeScreenshot('dwTickCount != 0', '(LPCSTR)0x0');
    assert.strictEqual(groupedIn(code, screenSlots, fns(), [...renderers, table('gD3DTable', 'D3D::GetScreenSize')]), true);
  });

  it('a call through a handler array: every element is asked', () => {
    const handlers: ReachGlobal = {
      name: 'gpHandlers', dataType: 'pfnHandler *[3]',
      initializedData: { kind: 'array', elements: [
        { kind: 'pointer', value: 'DAT_00000000' },
        { kind: 'pointer', value: 'HandlerA' },
        { kind: 'pointer', value: 'HandlerB' },
      ] },
    };
    const a = fn('HandlerA', [['int *', 'p'], ['int *', 'q']], '  *p = 0;\n  *q = 0;');
    const narrow = fn('HandlerB', [['int *', 'p'], ['int *', 'q']], '  *p = 1;');
    const wide = fn('HandlerB', [['int *', 'p'], ['int *', 'q']], '  *p = 1;\n  p[1] = 2;');
    assert.strictEqual(grouped('(*gpHandlers[nIdx])(&nX, &nY);', [a, narrow], [handlers]), false);
    assert.strictEqual(grouped('(*gpHandlers[nIdx])(&nX, &nY);', [a, wide], [handlers]), true);
  });

  it('a call through a function pointer that is not a table: group', () => {
    const slot: ReachGlobal = { name: 'gpfnHandler', dataType: 'pfnHandler *', initializedData: { kind: 'pointer', value: 'HandlerA' } };
    const a = fn('HandlerA', [['int *', 'p']], '  *p = 0;');
    assert.strictEqual(grouped('(*gpfnHandler)(&nX);', [a], [slot]), true);
  });
});

describe('createParamReachOracle', () => {
  it('answers the same whichever function of a cycle is asked first', () => {
    // A and B call each other; C reaches [4, 8) and only A's second parameter flows there.
    const mk = () => [
      fn('A', [['int *', 'p'], ['int *', 'q']], '  *p = 0;\n  B(p, q);\n  C(q);'),
      fn('B', [['int *', 'p'], ['int *', 'q']], '  A(p, q);'),
      fn('C', [['int *', 'p']], '  p[1] = 0;'),
    ];
    const first = oracleOf(mk());
    const aFirst = [first.argReach('A', 0, 2), first.argReach('A', 1, 2), first.argReach('B', 0, 2), first.argReach('B', 1, 2)];
    const second = oracleOf(mk());
    const bFirst = [second.argReach('B', 0, 2), second.argReach('B', 1, 2), second.argReach('A', 0, 2), second.argReach('A', 1, 2)];
    assert.deepStrictEqual([aFirst[0], aFirst[1], aFirst[2], aFirst[3]], [bFirst[2], bFirst[3], bFirst[0], bFirst[1]]);
    // Every parameter that flows round the cycle is unknown.
    assert.strictEqual(aFirst[0], null);
    assert.strictEqual(aFirst[2], null);
  });

  it('settles a function outside any cycle', () => {
    const o = oracleOf([fn('C', [['int *', 'p']], '  p[1] = 0;')]);
    assert.deepStrictEqual(o.argReach('C', 0, 1), { lo: 4, hi: 8 });
    assert.deepStrictEqual(o.argReach('::C', 0, 1), { lo: 4, hi: 8 });
  });
});
