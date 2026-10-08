import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { haltSiteFoldPlugin } from '../builtins/halt-site-fold.js';

const HALT = 'Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt';
const IP = 'Fog::Src::ErrorManager::GetInstructionPointer';

function run(code: string): string {
  const ast = parse(code);
  const out = haltSiteFoldPlugin.createTransformer({})(ast);
  return emit(out as AnyNode).trim();
}

function count(s: string, needle: string): number {
  return s.split(needle).length - 1;
}

describe('haltSiteFoldPlugin - fold the temporaries into the call', () => {
  it('folds two initialised locals', () => {
    const out = run(`void f() {
  int32_t nLine = 0x1ef;
  int32_t nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    assert.strictEqual(out, `void f() {
  ${HALT}("", ${IP}(), 0x1ef);
  exit(-1);
}`);
  });

  it('folds assignments in either order and drops the dead declarations', () => {
    const a = run(`void f() {
  int32_t nAddress;
  int32_t nLine;
  nAddress = ${IP}();
  nLine = 7;
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    const b = run(`void f() {
  int32_t nAddress;
  int32_t nLine;
  nLine = 7;
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    const want = `void f() {
  ${HALT}("", ${IP}(), 7);
  exit(-1);
}`;
    assert.strictEqual(a, want);
    assert.strictEqual(b, want);
  });

  it('folds a side-effect-free expression for the line', () => {
    const out = run(`void f(int nBase) {
  int32_t nLine;
  int32_t nAddress;
  nLine = nBase + 4;
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    assert.ok(out.includes(`${HALT}("", ${IP}(), nBase + 4);`), out);
  });

  it('keeps the comment on the halt statement', () => {
    const out = run(`void f() {
  int32_t nLine = 5;
  int32_t nAddress = ${IP}();
  /* WARNING: Subroutine does not return */ ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    assert.ok(out.includes('/* WARNING: Subroutine does not return */'), out);
    assert.ok(out.includes(`${IP}(), 5)`), out);
  });

  it('folds every site of a function that shares its temporaries, then drops them', () => {
    const out = run(`void f(int c, int d) {
  int32_t nAddress;
  int32_t nLine;
  if (c) {
    nLine = 1;
    nAddress = ${IP}();
    ${HALT}("", nAddress, nLine);
    exit(-1);
  }
  if (d) {
    nLine = 2;
    nAddress = ${IP}();
    ${HALT}("", nAddress, nLine);
    exit(-1);
  }
}`);
    assert.strictEqual(count(out, `${IP}()`), 2);
    assert.ok(out.includes('0x1') === false && out.includes(', 1);') && out.includes(', 2);'), out);
    assert.ok(!out.includes('nLine') && !out.includes('nAddress'), out);
  });

  it('leaves a variable alone when something else still reads it', () => {
    const out = run(`void f(int c) {
  int32_t nLine;
  int32_t nAddress;
  nLine = 3;
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
  use(nLine);
}`);
    // The site still folds (nothing after the exit can run), but nLine stays declared for use().
    assert.ok(out.includes('int32_t nLine;'), out);
    assert.ok(!out.includes('int32_t nAddress;'), out);
  });

  it('does not fold a consumed declaration that is used elsewhere in its block', () => {
    const src = `void f() {
  int32_t nLine = 3;
  int32_t nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
  use(nLine);
}`;
    const out = run(src);
    assert.ok(out.includes('int32_t nLine = 3;'), out);
  });

  it('does not fold a line computed by a call', () => {
    const out = run(`void f() {
  int32_t nLine;
  int32_t nAddress;
  nLine = compute();
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    assert.ok(out.includes('nLine = compute();'), out);
    assert.ok(out.includes(`, nAddress, nLine)`), out);
  });

  it('does not fold when no terminator follows the halt', () => {
    const out = run(`int f() {
  int32_t nLine;
  int32_t nAddress;
  nLine = 3;
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  return nLine;
}`);
    assert.ok(out.includes('nLine = 3;'), out);
  });

  it('does not fold a definition separated from the halt', () => {
    const out = run(`void f() {
  int32_t nLine;
  int32_t nAddress;
  nLine = 3;
  log();
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    // nAddress is adjacent and folds; nLine is not, so it stays a variable argument.
    assert.ok(out.includes(`${HALT}("", ${IP}(), nLine);`), out);
    assert.ok(out.includes('nLine = 3;'), out);
  });

  it('does not fold when a comment would be lost', () => {
    const out = run(`void f() {
  int32_t nAddress;
  int32_t nLine;
  /* the line */ nLine = 3;
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    assert.ok(out.includes('/* the line */'), out);
    assert.ok(out.includes('nLine = 3;'), out);
  });

  it('does not fold into a halt that is itself a jump target', () => {
    const out = run(`void f(int c) {
  int32_t nLine;
  int32_t nAddress;
  nLine = 3;
  nAddress = ${IP}();
LAB:
  ${HALT}("", nAddress, nLine);
  exit(-1);
  if (c) goto LAB;
}`);
    assert.ok(out.includes('nLine = 3;'), out);
    assert.ok(out.includes('LAB:'), out);
  });

  it('moves a label from the first removed definition to the halt', () => {
    const out = run(`void f(int c) {
  int32_t nLine;
  int32_t nAddress;
  if (c) goto LAB;
  return;
LAB:
  nLine = 9;
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    // Both definitions sit behind the label, so jumping to it still reaches the same call.
    assert.ok(/LAB:\s*\n\s*Fog::Src::ErrorManager::ERROR_Unrecoverable/.test(out) || !out.includes('goto LAB'), out);
    assert.ok(!out.includes('nLine'), out);
  });

  it('does not fold when a label sits between the definitions', () => {
    const out = run(`void f(int c) {
  int32_t nLine;
  int32_t nAddress;
  nLine = 9;
MID:
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
  if (c) goto MID;
}`);
    assert.ok(out.includes('nLine = 9;'), out);
  });

  it('is idempotent', () => {
    const once = run(`void f() {
  int32_t nLine = 0x1ef;
  int32_t nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    assert.strictEqual(run(once), once);
  });

  it('ignores other calls named alike', () => {
    const src = `void f() {
  int32_t nLine = 3;
  int32_t nAddress = ${IP}();
  Other::Halt("", nAddress, nLine);
  exit(-1);
}`;
    const out = run(src);
    assert.ok(out.includes('int32_t nLine = 3;'), out);
  });
});

describe('haltSiteFoldPlugin - copy a shared halt tail to its jumps', () => {
  it('replaces each "nLine = C; goto LAB;" and removes the tail', () => {
    const out = run(`int f(int c, int d) {
  int32_t nAddress;
  int32_t nLine;
  if (c) {
    nLine = 0x4ca;
    goto LAB;
  }
  if (d) {
    nLine = 0x4d9;
    goto LAB;
  }
  return 1;
LAB:
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    assert.strictEqual(out, `int f(int c, int d) {
  if (c) {
    ${HALT}("", ${IP}(), 0x4ca);
    exit(-1);
  }
  if (d) {
    ${HALT}("", ${IP}(), 0x4d9);
    exit(-1);
  }
  return 1;
}`);
  });

  it('works when the jumps set both temporaries', () => {
    const out = run(`int f(int c) {
  int32_t nAddress;
  int32_t nLine;
  if (c) {
    nLine = 12;
    nAddress = ${IP}();
    goto LAB;
  }
  return 1;
LAB:
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    assert.ok(out.includes(`${HALT}("", ${IP}(), 12);`), out);
    assert.ok(!out.includes('goto') && !out.includes('LAB'), out);
  });

  it('takes the fall-in definitions into the tail', () => {
    const out = run(`void f(int c) {
  int32_t nLine;
  int32_t nAddress;
  if (c) {
    nLine = 1;
    goto LAB;
  }
  nLine = 2;
LAB:
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    assert.strictEqual(count(out, `${HALT}(`), 2, out);
    assert.ok(out.includes(', 1);') && out.includes(', 2);'), out);
    assert.ok(!out.includes('goto') && !out.includes('LAB'), out);
  });

  it('leaves everything when one jump has no definition in front of it', () => {
    const out = run(`int f(int c, int d) {
  int32_t nAddress;
  int32_t nLine;
  if (c) {
    nLine = 0x4ca;
    goto LAB;
  }
  if (d) {
    goto LAB;
  }
  return 1;
LAB:
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    assert.ok(out.includes('goto LAB;'), out);
    assert.strictEqual(count(out, 'goto LAB;'), 2, out);
    assert.ok(out.includes('LAB:'), out);
    assert.ok(out.includes('nLine = 0x4ca;'), out);
  });

  it('leaves everything when the definition is not adjacent to the jump', () => {
    const out = run(`int f(int c) {
  int32_t nAddress;
  int32_t nLine;
  if (c) {
    nLine = 0x4ca;
    log();
    goto LAB;
  }
  return 1;
LAB:
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    assert.ok(out.includes('goto LAB;'), out);
    assert.ok(out.includes('LAB:'), out);
  });

  it('leaves a tail that does more than halt', () => {
    const out = run(`int f(int c) {
  int32_t nAddress;
  int32_t nLine;
  if (c) {
    nLine = 0x4ca;
    goto LAB;
  }
  return 1;
LAB:
  cleanup();
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    assert.ok(out.includes('goto LAB;'), out);
    assert.ok(out.includes('cleanup();'), out);
  });

  it('leaves a tail the code above can fall into with unknown values', () => {
    const out = run(`int f(int c) {
  int32_t nAddress;
  int32_t nLine;
  if (c) {
    nLine = 0x4ca;
    goto LAB;
  }
  work();
LAB:
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    assert.ok(out.includes('LAB:'), out);
    assert.ok(out.includes('work();'), out);
  });

  it('replaces a bare "if (c) goto LAB;" only when the tail reads nothing', () => {
    const constant = run(`void f(int c) {
  if (c) goto LAB;
  return;
LAB:
  ${HALT}("", ${IP}(), 0x10);
  exit(-1);
}`);
    assert.ok(!constant.includes('goto'), constant);
    assert.strictEqual(count(constant, `${HALT}(`), 1, constant);

    const variable = run(`void f(int c) {
  int32_t nLine;
  nLine = 3;
  if (c) goto LAB;
  return;
LAB:
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`);
    assert.ok(variable.includes('goto LAB'), variable);
  });

  it('does not copy the tail to a goto that is itself a jump target', () => {
    const out = run(`void f(int c) {
  int32_t nLine;
  if (c) {
    nLine = 5;
  OTHER:
    goto LAB;
  }
  return;
LAB:
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
  if (c) goto OTHER;
}`);
    assert.ok(out.includes('goto LAB'), out);
  });

  it('is idempotent', () => {
    const once = run(`int f(int c, int d) {
  int32_t nAddress;
  int32_t nLine;
  if (c) {
    nLine = 0x4ca;
    goto LAB;
  }
  return 1;
LAB:
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    assert.strictEqual(run(once), once);
  });
});

describe('haltSiteFoldPlugin - arguments through casts and interleaved assignments', () => {
  it('folds an address held in a pointer-typed local and read through a cast', () => {
    const out = run(`void f(void* pRoom) {
  int32_t nLine;
  char* szSourceFile;
  nLine = 699;
  szSourceFile = (char*)${IP}();
  /* Result of ROOMEX is returned */ ${HALT}("", (int32_t)szSourceFile, nLine);
  /* WARNING: Subroutine does not return */ exit(-1);
}`);
    assert.ok(out.includes(`${HALT}("", (int32_t)(char*)${IP}(), 699);`), out);
    assert.ok(out.includes('/* Result of ROOMEX is returned */'), out);
    assert.ok(!out.includes('szSourceFile') && !out.includes('nLine'), out);
  });

  it('moves a constant line past an unrelated assignment', () => {
    const out = run(`void f(void* pThis) {
  int32_t nLine;
  void* pTemp;
  nLine = 0x146;
  pTemp = pThis;
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`);
    assert.ok(out.includes(`${HALT}("", ${IP}(), 0x146);`), out);
    assert.ok(out.includes('pTemp = pThis;'), out);
    assert.ok(!out.includes('nLine'), out);
  });

  it('does not move a non-constant past an assignment', () => {
    const out = run(`void f(int nBase) {
  int32_t nLine;
  int32_t nOther;
  nLine = nBase + 1;
  nOther = 4;
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`);
    assert.ok(out.includes('nLine = nBase + 1;'), out);
  });

  it('does not move a definition past a statement that reads the folded variable', () => {
    const out = run(`void f() {
  int32_t nLine;
  int32_t nOther;
  nLine = 7;
  nOther = nLine + 1;
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`);
    assert.ok(out.includes('nLine = 7;'), out);
  });

  it('does not move a definition past an assignment with a side effect', () => {
    const out = run(`void f() {
  int32_t nLine;
  int32_t nOther;
  nLine = 7;
  nOther = next();
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`);
    assert.ok(out.includes('nLine = 7;'), out);
  });

  it('does not move a definition past a labelled statement', () => {
    const out = run(`void f(int c) {
  int32_t nLine;
  int32_t nOther;
  nLine = 7;
HERE:
  nOther = 1;
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
  if (c) goto HERE;
}`);
    assert.ok(out.includes('nLine = 7;'), out);
  });
});

describe('haltSiteFoldPlugin - a line chosen per branch', () => {
  it('writes the halt into each branch of an if/else', () => {
    const out = run(`void f(int a, int b) {
  int32_t nLine;
  if (a) {
    work();
    nLine = 0x2e8;
  } else {
    nLine = 0x2e6;
  }
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`);
    assert.strictEqual(out, `void f(int a, int b) {
  if (a) {
    work();
    ${HALT}("", ${IP}(), 0x2e8);
    exit(-1);
  } else {
    ${HALT}("", ${IP}(), 0x2e6);
    exit(-1);
  }
}`);
  });

  it('follows else-if chains and nested blocks, skipping the branches that return', () => {
    const out = run(`int f(int a, int b, int c) {
  int32_t nLine;
  if (a) {
    if (b) {
      return 1;
    }
    nLine = 0x10;
  } else {
    if (c) {
      nLine = 0x20;
    } else {
      return 2;
    }
  }
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`);
    assert.strictEqual(count(out, `${HALT}(`), 2, out);
    assert.ok(out.includes('0x10') && out.includes('0x20'), out);
    assert.ok(!out.includes('nLine'), out);
    assert.ok(out.includes('return 1;') && out.includes('return 2;'), out);
  });

  it('works when the address was held in a local first', () => {
    const out = run(`void f(int a) {
  int32_t nLine;
  char* code;
  if (a) {
    nLine = 5;
  } else {
    nLine = 6;
  }
  code = (char*)${IP}();
  ${HALT}("", (int32_t)code, nLine);
  exit(-1);
}`);
    assert.strictEqual(count(out, `${HALT}(`), 2, out);
    assert.ok(!out.includes('code') && !out.includes('nLine'), out);
  });

  it('leaves a join when one path does not end in the line assignment', () => {
    const out = run(`void f(int a) {
  int32_t nLine;
  if (a) {
    nLine = 5;
  } else {
    work();
  }
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`);
    assert.strictEqual(count(out, `${HALT}(`), 1, out);
  });

  it('leaves a join with no else (the line is whatever it was before)', () => {
    const out = run(`void f(int a) {
  int32_t nLine = 1;
  if (a) {
    nLine = 5;
  }
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`);
    assert.strictEqual(count(out, `${HALT}(`), 1, out);
  });

  it('leaves a join whose branch computes the line with a call', () => {
    const out = run(`void f(int a) {
  int32_t nLine;
  if (a) {
    nLine = compute();
  } else {
    nLine = 6;
  }
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`);
    assert.strictEqual(count(out, `${HALT}(`), 1, out);
  });

  it('leaves a join that something follows or a halt that is a jump target', () => {
    const labelled = run(`void f(int a) {
  int32_t nLine;
  if (a) {
    nLine = 5;
  } else {
    nLine = 6;
  }
HALTHERE:
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`);
    assert.strictEqual(count(labelled, `${HALT}(`), 1, labelled);
    const trailing = run(`void f(int a) {
  int32_t nLine;
  if (a) {
    nLine = 5;
  } else {
    nLine = 6;
  }
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
  more();
}`);
    assert.strictEqual(count(trailing, `${HALT}(`), 1, trailing);
  });

  it('is idempotent', () => {
    const once = run(`void f(int a, int b) {
  int32_t nLine;
  if (a) {
    nLine = 0x2e8;
  } else {
    nLine = 0x2e6;
  }
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`);
    assert.strictEqual(run(once), once);
  });
});
