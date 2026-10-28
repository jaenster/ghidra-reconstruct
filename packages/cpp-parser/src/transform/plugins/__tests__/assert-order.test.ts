import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { assertOrderPlugin } from '../builtins/assert-order.js';
import { defaultRegistry } from '../index.js';

const HALT = 'Fog::Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt';
const IP = 'Fog::Src::ErrorManager::GetInstructionPointer';
const H = `${HALT}("", ${IP}(), 0x272);`;
/** An earlier assertion: the sites under test are then not the function's only halt. */
const G = `if (!q) { ${HALT}("", ${IP}(), 0x271); exit(-1); }`;

function run(code: string): string {
  const ast = parse(code);
  const out = assertOrderPlugin.createTransformer({})(ast);
  return emit(out as AnyNode).trim();
}

/** Whitespace-insensitive comparison: the pass decides structure, the emitter layout. */
function flat(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function same(code: string): void {
  assert.strictEqual(flat(run(code)), flat(code));
}

describe('assertOrderPlugin - puts the halt back in front', () => {
  it('reorders the ASYNCDATA_GetReadSize shape', () => {
    const out = run(`int f(int* q, int* p) {
  if (!q) {
    ${HALT}("", ${IP}(), 0x271);
    exit(-1);
  } else {
    if (p != nullptr) {
      return *p;
    }
    ${H}
    exit(-1);
  }
}`);
    assert.strictEqual(flat(out), flat(`int f(int* q, int* p) {
  if (!q) {
    ${HALT}("", ${IP}(), 0x271);
    exit(-1);
  } else {
    if (p == nullptr) {
      ${H}
      exit(-1);
    }
    return *p;
  }
}`));
  });

  it('drops a leading ! and keeps every guarded statement in order', () => {
    const out = run(`void f(int* q, int* p) {
  ${G}
  if (!g(p)) {
    h(1);
    h(2);
    return;
  }
  ${H}
  exit(-1);
}`);
    assert.strictEqual(flat(out), flat(`void f(int* q, int* p) {
  ${G}
  if (g(p)) {
    ${H}
    exit(-1);
  }
  h(1);
  h(2);
  return;
}`));
  });

  it('wraps a compound condition and does not flip relational operators', () => {
    const out = run(`int f(int* q, int a, int b) {
  ${G}
  if (a < b && b != 0) {
    return a;
  }
  ${H}
  exit(-1);
}`);
    assert.ok(flat(out).includes(flat(`if (!(a < b && b != 0)) {`)), out);
    const lt = run(`int f(int* q, float a, float b) {
  ${G}
  if (a < b) {
    return 1;
  }
  ${H}
  exit(-1);
}`);
    assert.ok(flat(lt).includes('if (!(a < b))'), lt);
  });

  it('accepts break, continue, goto, a halt and a nested if/else that both leave', () => {
    for (const tail of ['break;', 'continue;', 'goto out;', `${H}`, 'if (c) { return; } else { return; }']) {
      const out = run(`void f(int c) {
  while (c) {
    if (c == 3) {
      h(c);
      ${tail}
    }
    ${H}
    exit(-1);
  }
out:
  return;
}`);
      assert.ok(flat(out).includes(flat(`if (c != 3) { ${H} exit(-1); } h(c);`)), `${tail}\n${out}`);
    }
  });

  it('handles a then-branch without braces and the _exit spelling', () => {
    const out = run(`int f(int* q, int c) {
  ${G}
  if (c) return 1;
  ${H}
  _exit(-1);
}`);
    assert.strictEqual(flat(out), flat(`int f(int* q, int c) { ${G} if (!c) { ${H} _exit(-1); } return 1; }`));
  });

  it('keeps the braces when the guarded block declares a name', () => {
    const out = run(`int f(int* q, int c) {
  ${G}
  if (c) {
    int x = g(c);
    return x;
  }
  ${H}
  exit(-1);
}`);
    assert.strictEqual(flat(out), flat(`int f(int* q, int c) { ${G} if (!c) { ${H} exit(-1); } { int x = g(c); return x; } }`));
  });

  it('reorders a sole function-ending assert whose guarded block loops or switches (OOGUTIL_GetStringEnd)', () => {
    const out = run(`char* f(char* s) {
  if (s) {
    while (*s != 0) {
      s++;
    }
    return s + 1;
  }
  ${H}
  exit(-1);
}`);
    assert.strictEqual(flat(out), flat(`char* f(char* s) {
  if (!s) { ${H} exit(-1); }
  while (*s != 0) { s++; }
  return s + 1;
}`));
    const sw = run(`int f(int* t, int m) {
  if (t) {
    switch (m) { case 1: return 2; }
    return 0;
  }
  ${H}
  exit(-1);
}`);
    assert.ok(flat(sw).startsWith(flat(`int f(int* t, int m) { if (!t) {`)), sw);
  });

  it('reorders nested shapes and keeps what follows the exit', () => {
    const out = run(`int f(int a, int b) {
  if (a) {
    if (b) {
      return 2;
    }
    ${H}
    exit(-1);
  }
  ${H}
  exit(-1);
  return 0;
}`);
    assert.strictEqual(flat(out), flat(`int f(int a, int b) {
  if (!a) { ${H} exit(-1); }
  if (!b) { ${H} exit(-1); }
  return 2;
  return 0;
}`));
  });
});

describe('assertOrderPlugin - refuses what is not the same program', () => {
  it('a then-block that can fall through into the halt', () => {
    same(`void f(int c) {
  if (c) {
    h(c);
  }
  ${H}
  exit(-1);
}`);
    same(`void f(int c) {
  if (c) {
    if (c == 2) {
      return;
    }
  }
  ${H}
  exit(-1);
}`);
  });

  it('a function-ending assert that is the only halt and guards straight-line code', () => {
    // GetQuestControlSeed 005438b0
    same(`int* f(int* p) {
  if (p) {
    return p + 6;
  }
  ${H}
  exit(-1);
}`);
    // A1Q6::Objects_InitFn04 00595a00: an inner leaving if is still straight-line
    same(`void f(int* p) {
  int* d = g(p);
  if (d) {
    if (d[2]) {
      return;
    }
    h(3);
    return;
  }
  ${H}
  exit(-1);
}`);
  });

  it('an else branch', () => {
    same(`void f(int c) {
  if (c) {
    return;
  } else {
    h(c);
  }
  ${H}
  exit(-1);
}`);
  });

  it('a label inside the then-block that a goto outside targets', () => {
    same(`void f(int c) {
  if (c == 1) {
    goto inner;
  }
  if (c) {
inner:
    h(c);
    return;
  }
  ${H}
  exit(-1);
}`);
  });

  it('a halt that is not directly after the if, or a labelled halt', () => {
    same(`void f(int c) {
  if (c) {
    return;
  }
  h(c);
  ${H}
  exit(-1);
}`);
    same(`void f(int c) {
  if (c == 1) {
    goto halt;
  }
  if (c) {
    return;
  }
halt:
  ${H}
  exit(-1);
}`);
  });

  it('a halt without the exit after it', () => {
    same(`void f(int c) {
  if (c) {
    return;
  }
  ${H}
  h(c);
}`);
  });

  it('a case label of the enclosing switch inside the then-block', () => {
    same(`void f(int c) {
  switch (c) {
  case 1:
    if (c) {
  case 2:
      return;
    }
    ${H}
    exit(-1);
  }
}`);
  });
});

describe('assertOrderPlugin - in the default pipeline', () => {
  it('runs in the full preset, after halt-site-fold has folded the line temporaries', () => {
    const ids = defaultRegistry.getEnabledIds({ preset: 'full' });
    assert.ok(ids.indexOf('halt-site-fold') < ids.indexOf('assert-order'), ids.join(','));
    const ast = parse(`int f(int* q, int* p) {
  int32_t nAddress;
  int32_t nLine;
  ${G}
  if (p != nullptr) {
    return *p;
  }
  nLine = 0x272;
  nAddress = ${IP}();
  ${HALT}("", nAddress, nLine);
  exit(-1);
}`);
    const out = emit(defaultRegistry.createTransformer({ preset: 'full' })(ast) as AnyNode);
    assert.ok(flat(out).includes(flat(`if (!p) { ${H} exit(-1); } return *p;`)), out);
  });
});
