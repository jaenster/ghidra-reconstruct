/**
 * scalar-piece-arithmetic: a scalar local's SUBPIECE members as arithmetic on the local.
 *
 * Shapes from 1.14d: STATLIST_BinarySearchStatInfoArray 00624c10 (two halves, then read
 * whole), InitHighResTimer 004109d0 (constant halves of a longlong), DrawShadowTile
 * 006b86f0 and ButtonWrapper::Constructor 004bb0f0 (CONCAT31 over an initialised local).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { scalarPieceArithmeticPlugin } from '../builtins/scalar-piece-arithmetic.js';
import { subpieceAccessPlugin } from '../builtins/subpiece-access.js';
import { pseudoOpLowerPlugin } from '../builtins/pseudo-op-lower.js';
import { ARTIFACT_SUPPORT_LINES } from '../builtins/artifact-support.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';
import type { AccessOrderEvidence, StoreFact } from '../builtins/access-order-evidence.js';

function run(src: string): string {
  const ast = scalarPieceArithmeticPlugin.createTransformer({})(parse(src) as never);
  return emit(ast as AnyNode).replace(/\s+/g, ' ').trim();
}

/** The pass, then the passes that lower what it leaves, in pipeline order. */
function lowered(src: string, withPass: boolean): string {
  let ast = parse(src) as unknown as AnyNode;
  if (withPass) ast = scalarPieceArithmeticPlugin.createTransformer({})(ast as never) as unknown as AnyNode;
  ast = pseudoOpLowerPlugin.createTransformer({})(ast as never) as unknown as AnyNode;
  ast = subpieceAccessPlugin.createTransformer({})(ast as never) as unknown as AnyNode;
  return emit(ast);
}

describe('scalar-piece-arithmetic', () => {
  it('STATLIST_BinarySearchStatInfoArray: halves that cover the local are one store', () => {
    const out = run(`int f(int nParam, S *p, int nMid) { int nKey; nKey._0_2_ = p[nMid].wSubIndex; nKey._2_2_ = p[nMid].wStatIndex; if (nKey < nParam) return 1; return 0; }`);
    assert.match(out, /nKey = \(int\)\(\(uint32_t\)\(uint16_t\)p\[nMid\]\.wSubIndex \| \(uint32_t\)\(uint16_t\)p\[nMid\]\.wStatIndex << 16\);/);
    assert.doesNotMatch(out, /_0_2_|_2_2_/);
  });

  it('InitHighResTimer: constant halves fold to one constant, the address use stays', () => {
    const out = run(`void f(void) { longlong q; longlong r; q._0_4_ = 0; q._4_4_ = 0; r._0_4_ = -1; r._4_4_ = -1; Load(&r, &q); if (r._4_4_ == 0) g(); }`);
    assert.match(out, /q = 0;/);
    assert.match(out, /r = \(longlong\)0xffffffffffffffffull;/);
    // r's address is taken: its read keeps the memory form for subpiece-access.
    assert.match(out, /r\._4_4_ == 0/);
  });

  it('a covering run in byte order or not, and a three-piece one', () => {
    const out = run(`int f(R *p) { int h; h._2_2_ = p->pad; h._0_1_ = p->a; h._1_1_ = p->b; return h; }`);
    assert.match(out, /h = \(int\)\(\(uint32_t\)\(uint16_t\)p->pad << 16 \| \(uint32_t\)\(uint8_t\)p->a \| \(uint32_t\)\(uint8_t\)p->b << 8\);/);
  });

  it('no run when a value has an effect, reads the local, or the pieces overlap or leave a gap', () => {
    assert.match(run(`int f(void) { int h; h._0_2_ = g(); h._2_2_ = 1; return h; }`), /h\._0_2_ = g\(\);/);
    assert.match(run(`int f(int a) { int h; h = a; h._0_2_ = 1; h._2_2_ = h._0_2_; return h; }`), /h = a; h = \(int\)\(\(uint32_t\)h & 0xffff0000u \| 1u\); h = \(int\)\(\(uint32_t\)h & 0xffffu \| \(uint32_t\)\(uint16_t\)\(uint32_t\)h << 16\);/);
    assert.match(run(`int f(void) { int h; h._0_2_ = 1; h._1_2_ = 2; h._3_1_ = 0; return h; }`), /h\._0_2_ = 1;/);
    assert.match(run(`int f(void) { int h; h._0_2_ = 1; return h; }`), /h\._0_2_ = 1;/);
  });

  it('DrawShadowTile: a piece store and CONCAT31 over an initialised local are arithmetic on it', () => {
    const out = run(`int f(int pTile, int b) { undefined4 nAlpha; nAlpha = pTile; nAlpha._1_3_ = (undefined3)((uint)pTile >> 8); nAlpha = CONCAT31(nAlpha._1_3_,0xff); return Draw(nAlpha); }`);
    assert.match(out, /nAlpha = \(undefined4\)\(\(uint32_t\)nAlpha & 0xffu \| \(\(uint32_t\)\(\(uint\)pTile >> 8\) & 0xffffffu\) << 8\);/);
    assert.match(out, /CONCAT31\(\(uint32_t\)\(\(uint32_t\)nAlpha >> 8 & 0xffffffu\), 0xff\)/);
  });

  it('ButtonWrapper::Constructor: an initialiser counts; a compound store keeps the other bytes', () => {
    const out = run(`void f(void) { int32_t s = 0; s = CONCAT31(s._1_3_,1); s._0_1_ += 2; use(s); }`);
    assert.match(out, /CONCAT31\(\(uint32_t\)\(\(uint32_t\)s >> 8 & 0xffffffu\), 1\)/);
    assert.match(out, /s = \(int32_t\)\(\(uint32_t\)s & 0xffffff00u \| \(uint32_t\)\(uint8_t\)\(\(uint8_t\)\(uint32_t\)s \+ 2\)\);/);
  });

  it('nothing on a local that is not certainly initialised, or whose address is taken', () => {
    // Q19_Callback04_ItemPickedUp 005b8210: a byte written into an uninitialised int. Read
    // as a byte only, it is a whole store (the low-piece rule); read whole, it stays.
    assert.match(run(`void f(void) { int32_t n; n._0_1_ = 1; Send((uint8_t)n); }`), /n = 1;/);
    assert.match(run(`void f(void) { int32_t n; n._0_1_ = 1; Send(n); }`), /n\._0_1_ = 1;/);
    // Assigned only on one arm: not certain after the if.
    assert.match(run(`void f(int c) { int n; if (c) { n = 5; } n._0_1_ = 1; use(n); }`), /n\._0_1_ = 1;/);
    // A label between the store and the use: it can be entered without the store.
    assert.match(run(`void f(int c) { int n; n = 5; if (c) goto L; n = 6; L: n._0_1_ = 1; use(n); }`), /n\._0_1_ = 1;/);
    assert.match(run(`void f(void) { int n; n = 5; n._0_1_ = 1; g(&n); }`), /n\._0_1_ = 1;/);
    assert.match(run(`void f(void) { int n; n = 5; n._0_1_++; g(n); }`), /n\._0_1_\+\+/);
  });

  it('an assignment earlier in the block covers a loop and a branch after it', () => {
    const out = run(`void f(int c) { uint n; n = 0; while (c) { n._0_1_ = c; c--; } if (c) use(n._1_1_); }`);
    assert.match(out, /n = \(uint\)\(\(uint32_t\)n & 0xffffff00u \| \(uint32_t\)\(uint8_t\)c\);/);
    assert.match(out, /use\(\(uint8_t\)\(\(uint32_t\)n >> 8\)\)/);
  });

  it('parameters, globals, struct locals and pointer locals are left alone', () => {
    assert.match(run(`void f(int p) { p._0_2_ = 1; p._2_2_ = 2; use(p); }`), /p\._0_2_ = 1;/);
    assert.match(run(`void f(void) { S s; s._0_2_ = 1; s._2_2_ = 2; use(s); }`), /s\._0_2_ = 1;/);
    assert.match(run(`void f(void) { char *q; q._0_2_ = 1; q._2_2_ = 2; use(q); }`), /q\._0_2_ = 1;/);
  });
});

describe('scalar-piece-arithmetic, compiled and run', { skip: !hasNativeGpp() }, () => {
  const prelude = [
    'typedef unsigned int uint;', 'typedef uint8_t byte;', 'typedef uint32_t undefined4;', 'typedef uint8_t undefined3;',
    'typedef long long longlong;', ...ARTIFACT_SUPPORT_LINES,
    'struct R { uint8_t a; uint8_t b; uint16_t pad; };',
  ].join('\n');
  // Each function, with the pass and without it, must compute the same value.
  const fns = [
    'int halves(R *p) { int h; h._2_2_ = p->pad; h._0_1_ = p->a; h._1_1_ = p->b; return h; }',
    'longlong konst() { longlong r; r._0_4_ = -1; r._4_4_ = 0x7f; return r; }',
    'uint alpha(uint t, int on) { undefined4 n; n = t; n._1_3_ = (undefined3)(t >> 4); n = CONCAT31(n._1_3_, 0xff); if (on) n = CONCAT31(n._1_3_, 0xc0); return n; }',
    'int rmw(int v, int c) { int n; n = v; n._2_2_ = c; n._0_1_ += 3; n._1_1_ ^= n._3_1_; return n; }',
    'short sh(short v) { short n; n = v; n._1_1_ = 0x80; return n; }',
  ];
  const calls = [
    'R r = {0x81, 0x7f, 0xfedc}; printf("%08x\\n", (unsigned)halves(&r));',
    'printf("%016llx\\n", (unsigned long long)konst());',
    'printf("%08x %08x\\n", alpha(0x89abcdefu, 0), alpha(0x89abcdefu, 1));',
    'printf("%08x %08x\\n", (unsigned)rmw(0x7ffffffe, 0x8001), (unsigned)rmw(-2, -1));',
    'printf("%04x\\n", (unsigned)(uint16_t)sh(-1));',
  ].join('\n');
  it('the same values as the memory form', () => {
    const before = compileAndRun(`${prelude}\n${lowered(fns.join('\n'), false)}`, calls);
    const after = compileAndRun(`${prelude}\n${lowered(fns.join('\n'), true)}`, calls);
    assert.equal(after, before);
    assert.match(before, /^fedc7f81\n0000007fffffffff\n/);
  });
});

describe('Golden: a local only its low piece is read of', () => {
  // SCMD_0x3E_QuestItemPickup 0054bf60, the Game.exe decompile at program v2071. The
  // original keeps each coordinate whole in a register (`MOV EBX,[ECX+0xc]`, `XOR EBX,EBX`,
  // the call's EAX) and pushes it; only its low word is read, at the call.
  const QUEST = `eD2ServerIncomingStatus f(D2UnitStrc *pUnit, D2UnitStrc *pQuestItem) {
  uint32_t nPosX;
  eD2ServerIncomingStatus eVar1;
  eD2UnitType eUnitType;
  eUnitType = pQuestItem->eUnitType;
  if ((eUnitType == UNIT_OBJECT) || ((3 < (int)eUnitType && ((int)eUnitType < 6)))) {
    nPosX._0_2_ = (uint16_t)((pQuestItem->pPath).pStaticPath)->nPosX;
  }
  else if ((pQuestItem->pPath).pDynamicPath == (D2DynamicPathStrc *)0x0) {
    nPosX._0_2_ = 0;
  }
  else {
    nPosX = D2Common::PATH::DynamicPath::GetXPos((pQuestItem->pPath).pDynamicPath);
    nPosX._0_2_ = (uint16_t)nPosX;
  }
  eVar1 = CheckIfCoordsAreInRange(pUnit,10,(uint16_t)nPosX,0);
  return eVar1;
}`;

  it('SCMD_0x3E_QuestItemPickup 0054bf60: every store is whole, the read-back store goes', () => {
    const out = run(QUEST);
    assert.match(out, /nPosX = pQuestItem->pPath\.pStaticPath->nPosX;/, out);
    assert.match(out, /nPosX = 0;/, out);
    assert.match(out, /nPosX = D2Common::PATH::DynamicPath::GetXPos\(pQuestItem->pPath\.pDynamicPath\); \}/, out);
    assert.doesNotMatch(out, /_0_2_|0xffff0000/, out);
    assert.match(out, /\(uint16_t\)nPosX, 0\)/, out);
  });

  it('keeps the piece where a read sees more than the low piece, or the address is taken', () => {
    for (const read of ['(int)nPosX', 'nPosX', '(uint32_t)nPosX']) {
      const out = run(QUEST.replace('(uint16_t)nPosX,0)', `${read},0)`));
      assert.match(out, /nPosX\._0_2_ = 0|0xffff0000u/, `${read}: ${out}`);
    }
    const addr = run(QUEST.replace('eVar1 = Check', 'g(&nPosX); eVar1 = Check'));
    assert.match(addr, /_0_2_/, addr);
  });

  it('the whole stores give the same low word the piece stores did', () => {
    // CLIENT_PopulateVisibilityPacketBuffer 00537ee0: a byte flag stored as its low byte.
    const out = run(`void f(D2UnitStrc *p, uint8_t *pOut) {
  uint32_t byUnitType;
  byUnitType._0_1_ = 6;
  if (p != (D2UnitStrc *)0x0) {
    byUnitType._0_1_ = (uint8_t)p->eUnitType;
  }
  *pOut = (uint8_t)byUnitType;
}`);
    assert.match(out, /byUnitType = 6; if \(p != \(D2UnitStrc\*\)0x0\) \{ byUnitType = p->eUnitType; \} \*pOut = \(uint8_t\)byUnitType;/, out);
  });

  it('CLIENT_PopulateVisibilityPacketBuffer 00537ee0: Ghidra\'s (undefined2) goes as well', () => {
    const out = run(`void f(D2UnitStrc *pSlotUnit, uint16_t *pOut) {
  int32_t wCoord;
  if (pSlotUnit->pPath.pDynamicPath == 0) {
    wCoord._0_2_ = (undefined2)((pSlotUnit->pPath).pStaticPath)->nPosX;
  }
  else {
    wCoord = GetXPos((pSlotUnit->pPath).pDynamicPath);
    wCoord._0_2_ = (undefined2)wCoord;
  }
  *pOut = (undefined2)wCoord;
}`);
    assert.match(out, /\{ wCoord = pSlotUnit->pPath\.pStaticPath->nPosX; \} else \{ wCoord = GetXPos\(pSlotUnit->pPath\.pDynamicPath\); \}/, out);
  });
});

describe('Golden: the width the original wrote at each low store', () => {
  /**
   * The body one statement per line, as the facts key them; `[w]` before a statement gives
   * its line's one store an instruction width of w bytes.
   */
  function widths(lines: string[]): { text: string; ev: AccessOrderEvidence } {
    const stores = new Map<number, StoreFact[]>();
    const text = lines.map((l, i) => {
      const m = l.match(/^\s*\[(\d+)\]\s?(.*)$/);
      if (!m) return l;
      stores.set(i + 1, [{ ord: 0, at: 4 * i, size: 1, half: null, width: Number(m[1]) }]);
      return m[2];
    }).join('\n');
    return { text, ev: { args: new Map(), stores } };
  }
  const runWith = (lines: string[], enumTypes: string[] = []): string => {
    const { text, ev } = widths(lines);
    return emit(scalarPieceArithmeticPlugin.createTransformer({ accessOrder: ev, enumTypes } as never)(parse(text) as never) as AnyNode)
      .replace(/\s+/g, ' ').trim();
  };

  // SUNITNPC_ApplyScrollSkill 00576e40, the Game.exe decompile at v2083: `LEA EBX,[EDI+0x6]`
  // (EDI is pUnit, 0 on that arm) and `MOV EBX,dword ptr [EDI]` write all of EBX; the one
  // read is the call's (undefined1).
  const SCROLL = (w1: string, w2: string) => [
    'void f(D2UnitStrc *pUnit, eD2Skills eSkill) {',
    'int nUnitGUID;',
    'eD2UnitType eUnitType;',
    'if (pUnit == (D2UnitStrc *)0x0) {',
    'nUnitGUID = -1;',
    `${w1} eUnitType._0_1_ = UNIT_COUNT;`,
    '}',
    'else {',
    'nUnitGUID = pUnit->nUnitGUID;',
    `${w2} eUnitType._0_1_ = (undefined1)pUnit->eUnitType;`,
    '}',
    'Send_0x22_UpdateItemSkill(pClient,(undefined1)eUnitType,nUnitGUID,eSkill);',
    '}',
  ];

  it('SUNITNPC_ApplyScrollSkill 00576e40: an enum local written whole at both stores', () => {
    const out = runWith(SCROLL('[4]', '[4]'), ['eD2UnitType']);
    assert.match(out, /eUnitType = \(eD2UnitType\)UNIT_COUNT;/, out);
    assert.match(out, /eUnitType = \(eD2UnitType\)pUnit->eUnitType;/, out);
    assert.match(out, /\(undefined1\)eUnitType/, out);
    assert.doesNotMatch(out, /_0_1_/, out);
  });

  it('an enum local keeps its pieces without the facts, or where one store wrote a byte', () => {
    for (const [w1, w2] of [['', ''], ['[4]', ''], ['[4]', '[1]']]) {
      const out = runWith(SCROLL(w1, w2), ['eD2UnitType']);
      assert.match(out, /eUnitType\._0_1_ = UNIT_COUNT;.*eUnitType\._0_1_ = \(undefined1\)pUnit->eUnitType;/, `${w1}${w2}: ${out}`);
    }
    // Not an enum the program declares: nothing to cast to.
    assert.match(runWith(SCROLL('[4]', '[4]')), /eUnitType\._0_1_ = UNIT_COUNT;/);
  });

  // MONSTER_SpawnRoomMonsters 0054ec90: `MOV byte ptr [EBP-0x20],1` writes the byte only; the
  // other arm's loads are whole-register writes.
  it('MONSTER_SpawnRoomMonsters 0054ec90: a byte the original wrote stays a byte store', () => {
    const out = runWith([
      'void f(MonStatsTxt *p, int c) {',
      'int32_t nMinGrp;',
      'if (c == 0) {',
      '[1] nMinGrp._0_1_ = 1;',
      '}',
      'else {',
      '[4] nMinGrp._0_1_ = p->MinGrp;',
      '}',
      'g((uint8_t)nMinGrp);',
      '}',
    ]);
    assert.match(out, /nMinGrp\._0_1_ = 1;/, out);
    assert.match(out, /nMinGrp = p->MinGrp;/, out);
  });

  it('an unknown width keeps the whole store the shape alone gives', () => {
    const out = runWith(['void f(int c) {', 'int32_t n;', '[0] n._0_1_ = 1;', 'if (c) {', 'n._0_1_ = 2;', '}', 'g((uint8_t)n);', '}']);
    assert.match(out, /n = 1; if \(c\) \{ n = 2; \}/, out);
  });
});

describe('the width rule, compiled and run', { skip: !hasNativeGpp() }, () => {
  it('a kept byte store and a whole store give the low byte the pieces did', () => {
    const lines = [
      'int pick(int *p, int c) {',
      'int n;',
      'n = 0x12345678;',
      'if (c == 0) {',
      '[1] n._0_1_ = 0x81;',
      '}',
      'else {',
      '[4] n._0_1_ = *p;',
      '}',
      'return (uint8_t)n;',
      '}',
    ];
    const stores = new Map<number, StoreFact[]>();
    const text = lines.map((l, i) => {
      const m = l.match(/^\[(\d+)\] (.*)$/);
      if (!m) return l;
      stores.set(i + 1, [{ ord: 0, at: i, size: 1, half: null, width: Number(m[1]) }]);
      return m[2];
    }).join('\n');
    const lower = (withPass: boolean): string => {
      let ast = parse(text) as unknown as AnyNode;
      if (withPass) ast = scalarPieceArithmeticPlugin.createTransformer({ accessOrder: { args: new Map(), stores } } as never)(ast as never) as unknown as AnyNode;
      ast = subpieceAccessPlugin.createTransformer({})(ast as never) as unknown as AnyNode;
      return emit(ast);
    };
    const prelude = ARTIFACT_SUPPORT_LINES.join('\n');
    const calls = 'int v = 0x7fffff9a; printf("%x %x\\n", pick(&v, 0), pick(&v, 1));';
    const after = lower(true);
    assert.match(after, /\*\(uint8_t\*\)\(char\*\)&n = 0x81;/, after);
    assert.match(after, /n = \*p;/, after);
    assert.equal(compileAndRun(`${prelude}\n${after}`, calls), compileAndRun(`${prelude}\n${lower(false)}`, calls));
  });
});
