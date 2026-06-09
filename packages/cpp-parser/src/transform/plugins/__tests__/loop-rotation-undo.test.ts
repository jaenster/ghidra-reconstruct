/**
 * Tests for Loop Rotation Undo Plugin
 *
 * Every test verifies the exact output using assert.strictEqual.
 * Edge cases derived from real Diablo 2 decompiled code patterns.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { loopRotationUndoPlugin } from '../builtins/loop-rotation-undo.js';

describe('loopRotationUndoPlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = loopRotationUndoPlugin.createTransformer({});
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  function expectTransform(input: string, expected: string) {
    const output = transformCode(input);
    assert.strictEqual(output, expected.trim(), `\nExpected:\n${expected.trim()}\n\nGot:\n${output}`);
  }

  it('should convert if-guarded do-while to while (pointer loop)', () => {
    expectTransform(`
void foo(Node * p) {
  if (p != nullptr) {
    do {
      process(p);
      p = p->next;
    } while (p != nullptr);
  }
}
`, `
void foo(Node* p) {
  while (p != nullptr) {
    process(p);
    p = p->next;
  }
}
`);
  });

  it('should convert if-guarded do-while to while (truthy identifier)', () => {
    expectTransform(`
void foo(int n) {
  if (n) {
    do {
      work();
      n--;
    } while (n);
  }
}
`, `
void foo(int n) {
  while (n) {
    work();
    n--;
  }
}
`);
  });

  it('should NOT fold when conditions differ (D2 room traversal pattern)', () => {
    expectTransform(`
void foo(List * list) {
  Node * p = list->first;
  if (list->first != nullptr) {
    do {
      process(p);
      p = p->next;
    } while (p != nullptr);
  }
}
`, `
void foo(List* list) {
  Node* p = list->first;
  if (list->first != nullptr) {
    do {
      process(p);
      p = p->next;
    } while (p != nullptr);
  }
}
`);
  });

  it('should NOT fold when if has else branch', () => {
    expectTransform(`
void foo(int n) {
  if (n > 0) {
    do {
      n--;
    } while (n > 0);
  } else {
    error();
  }
}
`, `
void foo(int n) {
  if (n > 0) {
    do {
      n--;
    } while (n > 0);
  } else {
    error();
  }
}
`);
  });

  it('should NOT fold when compound has extra statements before do-while', () => {
    expectTransform(`
void foo(int n) {
  if (n > 0) {
    setup();
    do {
      n--;
    } while (n > 0);
  }
}
`, `
void foo(int n) {
  if (n > 0) {
    setup();
    do {
      n--;
    } while (n > 0);
  }
}
`);
  });

  it('should fold with complex bitwise condition', () => {
    expectTransform(`
void foo(int flags) {
  if ((flags & 0x10) != 0) {
    do {
      process(flags);
      flags = update(flags);
    } while ((flags & 0x10) != 0);
  }
}
`, `
void foo(int flags) {
  while ((flags & 0x10) != 0) {
    process(flags);
    flags = update(flags);
  }
}
`);
  });

  it('should NOT fold when guard and loop have different comparators (D2 table iteration)', () => {
    expectTransform(`
void foo(int size) {
  int i = 0;
  if (0 < size) {
    do {
      work(i);
      i++;
    } while (i < size);
  }
}
`, `
void foo(int size) {
  int i = 0;
  if (0 < size) {
    do {
      work(i);
      i++;
    } while (i < size);
  }
}
`);
  });

  it('should fold bare do-while (no braces on if)', () => {
    expectTransform(`
void foo(int n) {
  if (n > 0)
    do {
      n--;
    } while (n > 0);
}
`, `
void foo(int n) {
  while (n > 0) {
    n--;
  }
}
`);
  });

  it('should NOT fold when compound has statements after do-while', () => {
    expectTransform(`
void foo(int n) {
  if (n > 0) {
    do {
      n--;
    } while (n > 0);
    cleanup();
  }
}
`, `
void foo(int n) {
  if (n > 0) {
    do {
      n--;
    } while (n > 0);
    cleanup();
  }
}
`);
  });

  it('should fold when condition is assignment expression', () => {
    expectTransform(`
void foo() {
  if (x = bar()) {
    do {
      work();
    } while (x = bar());
  }
}
`, `
void foo() {
  while (x = bar()) {
    work();
  }
}
`);
  });

  it('should fold empty do-while body', () => {
    expectTransform(`
void f() {
  if (n > 0) {
    do {
    } while (n > 0);
  }
}
`, `
void f() {
  while (n > 0) {}
}
`);
  });

  it('should fold both inner and outer nested rotations via bottom-up', () => {
    expectTransform(`
void f(int a, int b) {
  if (a > 0) {
    do {
      if (b > 0) {
        do {
          b--;
        } while (b > 0);
      }
      a--;
    } while (a > 0);
  }
}
`, `
void f(int a, int b) {
  while (a > 0) {
    while (b > 0) {
      b--;
    }
    a--;
  }
}
`);
  });

  it('should fold with member access chain condition', () => {
    expectTransform(`
void f() {
  if (p->next->val != 0) {
    do {
      work();
    } while (p->next->val != 0);
  }
}
`, `
void f() {
  while (p->next->val != 0) {
    work();
  }
}
`);
  });

  it('should fold with function call condition', () => {
    expectTransform(`
void f() {
  if (hasMore()) {
    do {
      process();
    } while (hasMore());
  }
}
`, `
void f() {
  while (hasMore()) {
    process();
  }
}
`);
  });

  it('should fold with negated bitwise condition', () => {
    expectTransform(`
void f() {
  if (!(flags & 4)) {
    do {
      step();
    } while (!(flags & 4));
  }
}
`, `
void f() {
  while (!(flags & 4)) {
    step();
  }
}
`);
  });

  it('should have correct metadata', () => {
    assert.strictEqual(loopRotationUndoPlugin.id, 'loop-rotation-undo');
    assert.strictEqual(loopRotationUndoPlugin.priority, 56);
    assert.strictEqual(loopRotationUndoPlugin.defaultEnabled, true);
    assert.ok(loopRotationUndoPlugin.tags?.includes('cleanup'));
    assert.ok(loopRotationUndoPlugin.tags?.includes('control-flow'));
    assert.ok(loopRotationUndoPlugin.tags?.includes('loops'));
  });
});
