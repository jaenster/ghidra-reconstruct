import { describe, it } from 'node:test';
import assert from 'node:assert';
import { branchLayoutLines } from './branch-layout-spec.js';
import { parseBranchLayout, branchLayoutBatches, branchLayoutScript } from '../extract/branch-layout.js';

// SAVEFILE_FindAllSaveFiles (00430bc0) as the snapshot holds it, and the script's row for it.
const DECOMPILED = [
  '',
  '/* @function SAVEFILE_FindAllSaveFiles',
  '   @address Game.exe.ram:00430bc0 */',
  '',
  'BOOL SAVEFILE_FindAllSaveFiles(void)',
  '',
  '{',
  '  HANDLE hFindFile;',
  '  ',
  '  GetAndCreateSavePath(szSavePath,0x400);',
  '                    /* HANDLE hFindFile for FindClose */',
  '  hFindFile = FindFirstFileA(szSearchPattern,&findData);',
  '  if (hFindFile != (HANDLE)0xffffffff) {',
  '    FindClose(hFindFile);',
  '    return 1;',
  '  }',
  '  return 0;',
  '}',
  '',
  '',
].join('\n');
const ROW = '00430bc0\t19\t10:e,14;12:34,3b,42;13:48,4b;14:4e;15:54,5c;17:5d,62\t13:4b\n';

function split(decompiled: string): { brace: number; body: string } {
  const m = decompiled.match(/\)[\s\n]*\{([\s\S]*)\}[\s\S]*$/)!;
  return { brace: m.index! + m[0].indexOf('{'), body: m[1] };
}

describe('branch layout facts', () => {
  it('parses the script rows, signed offsets included', () => {
    const facts = parseBranchLayout(ROW + '00401000\t3\t2:-4,0\t2:0\n');
    assert.deepStrictEqual(facts.get('00430bc0')?.ifs, [[13, 0x4b]]);
    assert.deepStrictEqual(facts.get('00430bc0')?.lines[1], [12, [0x34, 0x3b, 0x42]]);
    assert.deepStrictEqual(facts.get('00401000')?.lines, [[2, [-4, 0]]]);
  });

  it('batches only functions that print an if', () => {
    const b = branchLayoutBatches([
      { address: '0x430bc0', decompiled: DECOMPILED },
      { address: '00401000', decompiled: 'void f(void)\n{\n  g();\n}\n' },
    ]);
    assert.deepStrictEqual(b, [['00430bc0']]);
    assert.ok(branchLayoutScript(b[0]).includes('String items = "00430bc0";'));
  });

  it('keys the facts by line of the parsed wrapper', () => {
    const { brace, body } = split(DECOMPILED);
    const lay = branchLayoutLines(parseBranchLayout(ROW).get('00430bc0'), DECOMPILED, brace, body, body, 'BOOL dummy() {');
    assert.ok(lay);
    // decompile line 13 (the if) is wrapper line 13 - 7 + 1 = 7
    assert.deepStrictEqual([...lay.ifs], [[7, 0x4b]]);
    assert.deepStrictEqual(lay.lines.get(8), [0x4e]);
    const wrapped = ('BOOL dummy() {' + body + '}').split('\n');
    assert.ok(wrapped[7 - 1].includes('if (hFindFile'));
    assert.ok(wrapped[8 - 1].includes('FindClose'));
  });

  it('drops facts from another text', () => {
    const { brace, body } = split(DECOMPILED);
    const facts = parseBranchLayout(ROW).get('00430bc0')!;
    assert.strictEqual(branchLayoutLines({ ...facts, lineCount: 20 }, DECOMPILED, brace, body, body, 'BOOL dummy() {'), undefined);
    assert.strictEqual(branchLayoutLines({ ...facts, ifs: [[12, 0x4b]] }, DECOMPILED, brace, body, body, 'BOOL dummy() {'), undefined);
    assert.strictEqual(branchLayoutLines({ ...facts, ifs: [] }, DECOMPILED, brace, body, body, 'BOOL dummy() {'), undefined);
    assert.strictEqual(branchLayoutLines(facts, DECOMPILED, brace, body, body + '\n', 'BOOL dummy() {'), undefined);
    assert.strictEqual(branchLayoutLines(facts, DECOMPILED, brace, body, body, 'BOOL\ndummy() {'), undefined);
    assert.strictEqual(branchLayoutLines(undefined, DECOMPILED, brace, body, body, 'BOOL dummy() {'), undefined);
  });
});
