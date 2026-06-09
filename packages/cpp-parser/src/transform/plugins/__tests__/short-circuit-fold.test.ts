/**
 * Tests for Short-Circuit Fold Plugin
 *
 * Every test verifies the exact output using assert.strictEqual.
 * Test cases derived from real Diablo 2 decompiled code patterns.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { shortCircuitFoldPlugin } from '../builtins/short-circuit-fold.js';

describe('shortCircuitFoldPlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = shortCircuitFoldPlugin.createTransformer({});
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  function expectTransform(input: string, expected: string) {
    const output = transformCode(input);
    assert.strictEqual(output, expected.trim(), `\nExpected:\n${expected.trim()}\n\nGot:\n${output}`);
  }

  it('should fold basic 2-level nullptr guard', () => {
    expectTransform(`
void foo(int * a, int * b) {
  if (a != nullptr) {
    if (b != nullptr) {
      process(a, b);
    }
  }
}
`, `
void foo(int* a, int* b) {
  if (a != nullptr && b != nullptr) {
    process(a, b);
  }
}
`);
  });

  it('should fold triple nested guard with member access', () => {
    expectTransform(`
void foo(Unit * owner, Unit * target) {
  if (owner != nullptr) {
    if (target != nullptr) {
      if (target->eType == 1) {
        doWork(target);
      }
    }
  }
}
`, `
void foo(Unit* owner, Unit* target) {
  if (owner != nullptr && target != nullptr && target->eType == 1) {
    doWork(target);
  }
}
`);
  });

  it('should fold and preserve multi-statement body', () => {
    expectTransform(`
void foo(int a, int b) {
  if (a) {
    if (b) {
      x();
      y();
      z();
    }
  }
}
`, `
void foo(int a, int b) {
  if (a && b) {
    x();
    y();
    z();
  }
}
`);
  });

  it('should NOT fold when outer has else', () => {
    expectTransform(`
void foo(int type) {
  if (type == 1) {
    if (game != nullptr) {
      process();
    }
  } else {
    error();
  }
}
`, `
void foo(int type) {
  if (type == 1) {
    if (game != nullptr) {
      process();
    }
  } else {
    error();
  }
}
`);
  });

  it('should NOT fold when inner has else', () => {
    expectTransform(`
void foo(int a) {
  if (a > 0) {
    if (a < 100) {
      inRange();
    } else {
      outOfRange();
    }
  }
}
`, `
void foo(int a) {
  if (a > 0) {
    if (a < 100) {
      inRange();
    } else {
      outOfRange();
    }
  }
}
`);
  });

  it('should NOT fold when outer has extra statements before inner if', () => {
    expectTransform(`
void foo(int * p) {
  if (p != nullptr) {
    setup();
    if (*p > 0) {
      process(*p);
    }
  }
}
`, `
void foo(int* p) {
  if (p != nullptr) {
    setup();
    if (*p > 0) {
      process(*p);
    }
  }
}
`);
  });

  it('should parenthesize || condition inside &&', () => {
    expectTransform(`
void foo(int a, int b, int c) {
  if (a || b) {
    if (c) {
      work();
    }
  }
}
`, `
void foo(int a, int b, int c) {
  if ((a || b) && c) {
    work();
  }
}
`);
  });

  it('should NOT fold when outer has code after inner if', () => {
    expectTransform(`
void foo(int* p, int* q) {
  if (p != nullptr) {
    if (q != nullptr) {
      process(p, q);
    }
    cleanup(p);
  }
}
`, `
void foo(int* p, int* q) {
  if (p != nullptr) {
    if (q != nullptr) {
      process(p, q);
    }
    cleanup(p);
  }
}
`);
  });

  it('should fold with comparison operators', () => {
    expectTransform(`
int foo(int x, int y) {
  if (x > 0) {
    if (y < 100) {
      return x + y;
    }
  }
  return -1;
}
`, `
int foo(int x, int y) {
  if (x > 0 && y < 100) {
    return x + y;
  }
  return -1;
}
`);
  });

  it('should NOT fold when inner is if constexpr', () => {
    expectTransform(`
void foo() {
  if (a) {
    if constexpr (sizeof(int) == 4) {
      work();
    }
  }
}
`, `
void foo() {
  if (a) {
    if constexpr (sizeof(int) == 4) {
      work();
    }
  }
}
`);
  });

  it('should fold bare inner if (no braces on outer)', () => {
    expectTransform(`
void foo() {
  if (a)
    if (b)
      work();
}
`, `
void foo() {
  if (a && b)
    work();
}
`);
  });

  it('should chain with existing && in outer condition', () => {
    expectTransform(`
void foo() {
  if (a && b) {
    if (c) {
      work();
    }
  }
}
`, `
void foo() {
  if (a && b && c) {
    work();
  }
}
`);
  });

  it('should parenthesize both || sides in &&', () => {
    expectTransform(`
void foo() {
  if (a || b) {
    if (c || d) {
      work();
    }
  }
}
`, `
void foo() {
  if ((a || b) && (c || d)) {
    work();
  }
}
`);
  });

  it('should chain 4 levels into single && expression', () => {
    expectTransform(`
void f() {
  if (a) {
    if (b) {
      if (c) {
        if (d) {
          work();
        }
      }
    }
  }
}
`, `
void f() {
  if (a && b && c && d) {
    work();
  }
}
`);
  });

  it('should auto-parenthesize assignment conditions inside &&', () => {
    expectTransform(`
void f() {
  if (x = foo()) {
    if (y = bar()) {
      use(x, y);
    }
  }
}
`, `
void f() {
  if ((x = foo()) && (y = bar())) {
    use(x, y);
  }
}
`);
  });

  it('should fold bare return as inner body', () => {
    expectTransform(`
int f() {
  if (a) {
    if (b)
      return 42;
  }
  return 0;
}
`, `
int f() {
  if (a && b)
    return 42;
  return 0;
}
`);
  });

  it('should fold nested ifs inside an else branch', () => {
    expectTransform(`
void f() {
  if (x) {
    skip();
  } else {
    if (a) {
      if (b) {
        work();
      }
    }
  }
}
`, `
void f() {
  if (x) {
    skip();
  } else {
    if (a && b) {
      work();
    }
  }
}
`);
  });

  it('should fold nested ifs inside a while body', () => {
    expectTransform(`
void f() {
  while (running) {
    if (a) {
      if (b) {
        work();
      }
    }
  }
}
`, `
void f() {
  while (running) {
    if (a && b) {
      work();
    }
  }
}
`);
  });

  it('should fold negated conditions', () => {
    expectTransform(`
void f() {
  if (!a) {
    if (!b) {
      work();
    }
  }
}
`, `
void f() {
  if (!a && !b) {
    work();
  }
}
`);
  });

  it('should parenthesize ternary condition inside &&', () => {
    expectTransform(`
void f() {
  if (a ? 1 : 0) {
    if (b) {
      work();
    }
  }
}
`, `
void f() {
  if ((a ? 1 : 0) && b) {
    work();
  }
}
`);
  });

  it('should NOT fold when outer compound has DeclStmt before inner if', () => {
    expectTransform(`
void f() {
  if (a) {
    int x = 1;
    if (b) {
      work();
    }
  }
}
`, `
void f() {
  if (a) {
    int x = 1;
    if (b) {
      work();
    }
  }
}
`);
  });

  it('should have correct metadata', () => {
    assert.strictEqual(shortCircuitFoldPlugin.id, 'short-circuit-fold');
    assert.strictEqual(shortCircuitFoldPlugin.priority, 57);
    assert.strictEqual(shortCircuitFoldPlugin.defaultEnabled, true);
    assert.ok(shortCircuitFoldPlugin.tags?.includes('cleanup'));
    assert.ok(shortCircuitFoldPlugin.tags?.includes('control-flow'));
  });
});
