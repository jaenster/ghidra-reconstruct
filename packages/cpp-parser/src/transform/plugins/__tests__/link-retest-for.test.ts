import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { linkRetestForPlugin } from '../builtins/link-retest-for.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const test = (reg: string, at: number) => ({ op: '!=', mnemonic: 'TEST', reg, k: 0, size: 4, at });

function run(lines: string[], ev: Record<string, unknown>): string {
  const t = linkRetestForPlugin.createTransformer({ branchLayout: { lines: new Map(), ifs: new Map(), ...ev } as never } as never);
  return flat(emit(t(parse(lines.join('\n'))) as AnyNode));
}

// WALL2_InsertUnitDraw 004dd600.
const DO = [
  'struct N { N * pNext; };',
  'void f(N * p, N * q) {',
  '  N * pNextNode;',
  '  do {',
  '    pNextNode = p->pNext;',
  '    if (!pNextNode) {',
  '      break;',
  '    }',
  '    p = pNextNode;',
  '  } while (pNextNode);',
  '  p->pNext = q;',
  '}',
];

// D2WINTEXTBOX_GetLastLineIndex 004fbd20.
const WHILE = [
  'struct N { int a[7]; N * pNext; };',
  'int f(N * p) {',
  '  int n = 0;',
  '  while (p && (p = p->pNext)) {',
  '    n++;',
  '  }',
  '  return n;',
  '}',
];

describe('link-retest-for', () => {
  it('writes the do-while whose two tests read two registers as the for', () => {
    const out = run(DO, { tests: new Map([[6, [test('ECX', 195)]], [10, [test('EAX', 201)]]]) });
    assert.ok(out.includes('for (; p && p->pNext; p = p->pNext) {} p->pNext = q;'), out);
    assert.ok(!out.includes('pNextNode'), out);
  });

  it('leaves the do-while whose tests read one register', () => {
    const out = run(DO, { tests: new Map([[6, [test('ECX', 195)]], [10, [test('ECX', 201)]]]) });
    assert.ok(out.includes('do {'), out);
  });

  it('writes the while whose bottom falls into the return as the for', () => {
    const ev = {
      lines: new Map([[7, [70]]]),
      edges: [{ line: 4, ord: 0, keyword: 'while', jcc: 61, target: 70, fall: 63, fallLines: [5], takenLines: [7] }],
      returns: [{ start: 70, ret: 70, insns: ['RET'], fallsIn: true, jumpsIn: [54, 61] }],
    };
    const out = run(WHILE, ev);
    assert.ok(out.includes('for (; p && p->pNext; p = p->pNext) { n++; } return n;'), out);
  });

  it('leaves the while whose bottom jumps back', () => {
    const ev = {
      lines: new Map([[7, [70]]]),
      edges: [{ line: 4, ord: 0, keyword: 'while', jcc: 61, target: 70, fall: 63, fallLines: [5], takenLines: [7] }],
      returns: [{ start: 70, ret: 70, insns: ['RET'], fallsIn: false, jumpsIn: [54, 61] }],
    };
    assert.ok(run(WHILE, ev).includes('while (p && (p = p->pNext))'));
  });
});
