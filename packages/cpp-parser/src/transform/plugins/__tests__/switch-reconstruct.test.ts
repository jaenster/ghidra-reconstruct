/**
 * Tests for Switch Reconstruction Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { switchReconstructPlugin } from '../builtins/switch-reconstruct.js';

describe('switchReconstructPlugin', () => {
  function transformCode(code: string, minCases = 3): string {
    const ast = parse(code);
    const transformer = switchReconstructPlugin.createTransformer({ minCases });
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  describe('basic switch reconstruction', () => {
    it('should reconstruct simple if-else-if chain to switch', () => {
      const input = `
void foo(int x) {
  if (x == 1) {
    a();
  } else if (x == 2) {
    b();
  } else if (x == 3) {
    c();
  }
}
`;
      const output = transformCode(input);
      assert.ok(output.includes('switch (x)'), `Expected switch statement in: ${output}`);
      assert.ok(output.includes('case 1:'), `Expected case 1 in: ${output}`);
      assert.ok(output.includes('case 2:'), `Expected case 2 in: ${output}`);
      assert.ok(output.includes('case 3:'), `Expected case 3 in: ${output}`);
      assert.ok(output.includes('break;'), `Expected break in: ${output}`);
    });

    it('should preserve default case from else', () => {
      const input = `
void foo(int x) {
  if (x == 1) {
    a();
  } else if (x == 2) {
    b();
  } else if (x == 3) {
    c();
  } else {
    d();
  }
}
`;
      const output = transformCode(input);
      assert.ok(output.includes('switch (x)'), `Expected switch in: ${output}`);
      assert.ok(output.includes('default:'), `Expected default case in: ${output}`);
    });

    it('should not add break after return', () => {
      const input = `
int foo(int x) {
  if (x == 1) {
    return 10;
  } else if (x == 2) {
    return 20;
  } else if (x == 3) {
    return 30;
  }
  return 0;
}
`;
      const output = transformCode(input);
      assert.ok(output.includes('switch (x)'), `Expected switch in: ${output}`);
      // Should not have break after return statements
      assert.ok(
        !/return \d+;\s*break;/.test(output),
        `Should not have break after return in: ${output}`
      );
    });
  });

  describe('different constant types', () => {
    it('should handle char constants', () => {
      const input = `
void foo(char c) {
  if (c == 'a') {
    a();
  } else if (c == 'b') {
    b();
  } else if (c == 'c') {
    c_func();
  }
}
`;
      const output = transformCode(input);
      assert.ok(output.includes('switch (c)'), `Expected switch in: ${output}`);
      assert.ok(output.includes("case 'a':"), `Expected case 'a' in: ${output}`);
    });

    it('should handle hex constants', () => {
      const input = `
void foo(int x) {
  if (x == 0x100) {
    a();
  } else if (x == 0x200) {
    b();
  } else if (x == 0x300) {
    c();
  }
}
`;
      const output = transformCode(input);
      assert.ok(output.includes('switch (x)'), `Expected switch in: ${output}`);
    });

    it('should handle reversed comparison (constant == variable)', () => {
      const input = `
void foo(int x) {
  if (1 == x) {
    a();
  } else if (2 == x) {
    b();
  } else if (3 == x) {
    c();
  }
}
`;
      const output = transformCode(input);
      assert.ok(output.includes('switch (x)'), `Expected switch in: ${output}`);
      assert.ok(output.includes('case 1:'), `Expected case 1 in: ${output}`);
    });
  });

  describe('switch variable types', () => {
    it('should handle member expression as switch variable', () => {
      const input = `
void foo(Data* d) {
  if (d->type == 1) {
    a();
  } else if (d->type == 2) {
    b();
  } else if (d->type == 3) {
    c();
  }
}
`;
      const output = transformCode(input);
      assert.ok(output.includes('switch (d->type)'), `Expected switch on d->type in: ${output}`);
    });
  });

  describe('non-convertible patterns', () => {
    it('should NOT convert if different variables are compared', () => {
      const input = `
void foo(int x, int y) {
  if (x == 1) {
    a();
  } else if (y == 2) {
    b();
  } else if (x == 3) {
    c();
  }
}
`;
      const output = transformCode(input);
      // Should remain as if-else chain
      assert.ok(!output.includes('switch'), `Should not contain switch in: ${output}`);
      assert.ok(output.includes('if (x == 1)'), `Should contain original if in: ${output}`);
    });

    it('should NOT convert if non-equality comparison is used', () => {
      const input = `
void foo(int x) {
  if (x == 1) {
    a();
  } else if (x > 2) {
    b();
  } else if (x == 3) {
    c();
  }
}
`;
      const output = transformCode(input);
      // Should remain as if-else chain
      assert.ok(!output.includes('switch'), `Should not contain switch in: ${output}`);
    });

    it('should NOT convert if fewer than minCases', () => {
      const input = `
void foo(int x) {
  if (x == 1) {
    a();
  } else if (x == 2) {
    b();
  }
}
`;
      const output = transformCode(input, 3); // minCases = 3
      // Should remain as if-else chain since only 2 cases
      assert.ok(!output.includes('switch'), `Should not contain switch in: ${output}`);
    });

    it('should convert with minCases = 2', () => {
      const input = `
void foo(int x) {
  if (x == 1) {
    a();
  } else if (x == 2) {
    b();
  }
}
`;
      const output = transformCode(input, 2); // minCases = 2
      assert.ok(output.includes('switch (x)'), `Expected switch with minCases=2 in: ${output}`);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(switchReconstructPlugin.id, 'switch-reconstruct');
      assert.strictEqual(switchReconstructPlugin.defaultEnabled, true);
      assert.ok(switchReconstructPlugin.tags?.includes('control-flow'));
    });
  });
});
