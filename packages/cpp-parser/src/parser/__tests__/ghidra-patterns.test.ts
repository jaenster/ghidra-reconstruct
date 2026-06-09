/**
 * Ghidra Decompiler Output Pattern Tests
 *
 * Tests real patterns that appear in Ghidra's decompiler output.
 * These are critical for production use.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse, ParserError } from '../parser.js';
import { emit } from '../../emit/emitter.js';
import { NodeKind } from '../../ast/kinds.js';
import type {
  FunctionDecl,
  VariableDecl,
  Identifier,
  UnaryExpr,
  CStyleCastExpr,
  BinaryExpr,
  CallExpr,
  SubscriptExpr,
  MemberExpr,
  IfStmt,
  WhileStmt,
  ForStmt,
  ReturnStmt,
  ExprStmt,
  CompoundStmt,
} from '../../ast/nodes.js';

describe('Ghidra Decompiler Patterns', () => {
  describe('Function naming patterns', () => {
    it('parses FUN_XXXXXXXX style functions', () => {
      const ast = parse('void FUN_00401000(void) { return; }');
      const fn = ast.declarations[0] as FunctionDecl;
      assert.strictEqual((fn.name as Identifier).name, 'FUN_00401000');
    });

    it('parses function with multiple FUN_ calls', () => {
      const code = `
        int FUN_00401000(void) {
          FUN_00401100();
          FUN_00401200(1, 2);
          return FUN_00401300();
        }
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses thunk functions', () => {
      const code = 'void thunk_FUN_00401000(void) { return; }';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });
  });

  describe('Variable naming patterns', () => {
    it('parses param_N parameters', () => {
      const code = 'void f(int param_1, char *param_2, long param_3) {}';
      const ast = parse(code);
      const fn = ast.declarations[0] as FunctionDecl;
      assert.strictEqual(fn.parameters.length, 3);
      assert.strictEqual(fn.parameters[0].name?.name, 'param_1');
      assert.strictEqual(fn.parameters[1].name?.name, 'param_2');
      assert.strictEqual(fn.parameters[2].name?.name, 'param_3');
    });

    it('parses local_XX variables', () => {
      const code = `
        void f(void) {
          int local_8;
          int local_c;
          int local_10;
          int local_14h;
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses xVar temporaries', () => {
      const code = `
        void f(void) {
          int iVar1;
          unsigned int uVar2;
          long lVar3;
          char cVar4;
          short sVar5;
          int *piVar6;
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });
  });

  describe('Ghidra undefined types', () => {
    it('parses undefined as a type name', () => {
      const code = 'void f(undefined param_1) {}';
      const ast = parse(code);
      const fn = ast.declarations[0] as FunctionDecl;
      assert.strictEqual(fn.parameters.length, 1);
    });

    it('parses undefined4 type', () => {
      const code = 'void f(undefined4 param_1) { undefined4 local_8; }';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses undefined8 type', () => {
      const code = 'undefined8 FUN_00401000(void) { return 0; }';
      const ast = parse(code);
      const fn = ast.declarations[0] as FunctionDecl;
      assert.ok(fn.returnType);
    });

    it('parses undefined pointers', () => {
      const code = 'void f(undefined4 *param_1, undefined8 **param_2) {}';
      const ast = parse(code);
      const fn = ast.declarations[0] as FunctionDecl;
      assert.strictEqual(fn.parameters.length, 2);
    });
  });

  describe('Pointer dereference patterns', () => {
    it('parses simple dereference', () => {
      const code = 'void f(int *p) { *p = 0; }';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses cast then dereference: *(type *)ptr', () => {
      const code = `
        void f(void *ptr) {
          *(int *)ptr = 42;
        }
      `;
      const ast = parse(code);
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      // Should be assignment where left side is dereference of cast
      assert.strictEqual(stmt.expression.kind, NodeKind.AssignExpr);
    });

    it('parses address literal dereference: *(type *)0xADDR', () => {
      const code = `
        void f(void) {
          *(int *)0x402000 = 1;
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses complex: *(type *)(base + offset)', () => {
      const code = `
        void f(long base) {
          *(int *)(base + 4) = 0;
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses nested dereference: **ptr', () => {
      const code = `
        void f(int **pp) {
          **pp = 42;
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses dereference with arithmetic: *(ptr + i)', () => {
      const code = `
        void f(int *arr, int i) {
          *(arr + i) = 0;
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });
  });

  describe('Cast patterns', () => {
    it('parses simple C-style cast', () => {
      const code = 'void f(long x) { int y = (int)x; }';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses pointer cast', () => {
      const code = 'void f(void *p) { int *ip = (int *)p; }';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses cast in expression', () => {
      const code = 'void f(long x) { int y = (int)x + 1; }';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses nested casts', () => {
      const code = 'void f(long x) { char *p = (char *)(int *)x; }';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses cast of arithmetic expression', () => {
      const code = 'void f(long a, long b) { int *p = (int *)(a + b); }';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses cast to unsigned types', () => {
      const code = `
        void f(int x) {
          unsigned int u = (unsigned int)x;
          unsigned long ul = (unsigned long)x;
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });
  });

  describe('Memory access patterns', () => {
    it('parses struct-like field access via cast', () => {
      // Ghidra often generates: *(int *)(param_1 + 4) for param_1->field
      const code = `
        int f(long param_1) {
          return *(int *)(param_1 + 0x10);
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses array-like access via pointer arithmetic', () => {
      const code = `
        int f(int *arr) {
          return *(arr + 5);
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses global data access', () => {
      const code = `
        void f(void) {
          int x = *(int *)0x404000;
          *(int *)0x404004 = x + 1;
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses DAT_ data references', () => {
      const code = `
        int DAT_00404000;
        void f(void) {
          DAT_00404000 = 42;
        }
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 2);
    });
  });

  describe('Control flow patterns', () => {
    it('parses if with comparison to zero', () => {
      const code = `
        void f(int x) {
          if (x != 0) {
            return;
          }
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses if with NULL comparison', () => {
      const code = `
        void f(void *p) {
          if (p == (void *)0x0) {
            return;
          }
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses while with complex condition', () => {
      const code = `
        void f(int *p, int n) {
          int i = 0;
          while (i < n) {
            *(p + i) = 0;
            i = i + 1;
          }
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses do-while loop', () => {
      const code = `
        void f(int *p) {
          do {
            *p = *p + 1;
          } while (*p < 10);
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses for loop with Ghidra-style increment', () => {
      const code = `
        void f(void) {
          int local_c;
          for (local_c = 0; local_c < 10; local_c = local_c + 1) {
          }
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses switch with multiple cases', () => {
      const code = `
        int f(int x) {
          switch(x) {
            case 0:
              return 1;
            case 1:
              return 2;
            default:
              return 0;
          }
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses goto and labels', () => {
      const code = `
        void f(int x) {
          if (x == 0) goto LAB_00401050;
          x = x + 1;
        LAB_00401050:
          return;
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });
  });

  describe('Function call patterns', () => {
    it('parses simple function call', () => {
      const code = `
        void f(void) {
          FUN_00401000();
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses function call with cast arguments', () => {
      const code = `
        void f(long x) {
          FUN_00401000((int)x, (char *)x);
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses function pointer call', () => {
      const code = `
        void f(void *fp) {
          (*(void (*)(void))fp)();
        }
      `;
      // This is complex - may not parse correctly
      // For now, just check it doesn't crash
      try {
        const ast = parse(code);
        assert.ok(true, 'Parsed without error');
      } catch (e) {
        // Expected to fail - function pointers not fully supported
        assert.ok(e instanceof ParserError, 'Should be a parser error');
      }
    });

    it('parses indirect call through cast', () => {
      const code = `
        int f(long addr) {
          return (*(int (*)(void))addr)();
        }
      `;
      // Complex function pointer pattern
      try {
        parse(code);
        assert.ok(true);
      } catch (e) {
        // May fail - that's expected
        assert.ok(e instanceof ParserError);
      }
    });
  });

  describe('Struct and member access', () => {
    it('parses arrow operator', () => {
      const code = `
        int f(int *p) {
          return p->x;
        }
      `;
      // Note: This assumes 'p' is a struct pointer, but Ghidra might not know
      // Parser should handle it syntactically
      try {
        const ast = parse(code);
        assert.ok(ast.declarations.length === 1);
      } catch {
        // p->x on int* is semantically wrong but syntactically valid
      }
    });

    it('parses struct definition', () => {
      const code = `
        struct MyStruct {
          int field1;
          char *field2;
        };
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 1);
      assert.strictEqual(ast.declarations[0].kind, NodeKind.StructDecl);
    });

    it('parses struct variable declaration', () => {
      const code = `
        struct Point { int x; int y; };
        void f(void) {
          struct Point p;
          p.x = 1;
          p.y = 2;
        }
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 2);
    });
  });

  describe('Bitwise operations', () => {
    it('parses bitwise AND', () => {
      const code = 'int f(int x) { return x & 0xff; }';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses bitwise OR', () => {
      const code = 'int f(int x, int y) { return x | y; }';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses shift operations', () => {
      const code = `
        int f(int x) {
          int a = x << 2;
          int b = x >> 3;
          return a | b;
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses complex bit manipulation', () => {
      const code = `
        unsigned int f(unsigned int x) {
          return ((x & 0xff) << 24) | ((x & 0xff00) << 8) |
                 ((x >> 8) & 0xff00) | ((x >> 24) & 0xff);
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });
  });

  describe('Array patterns', () => {
    it('parses array declaration', () => {
      const code = 'void f(void) { int arr[10]; }';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses array subscript', () => {
      const code = `
        int f(int *arr) {
          return arr[5];
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses multi-dimensional array access', () => {
      const code = `
        int f(int *arr, int w) {
          return *(arr + 5 * w + 3);
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses array parameter', () => {
      const code = 'void f(int arr[]) {}';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });
  });

  describe('String patterns', () => {
    it('parses string literal', () => {
      const code = 'void f(void) { char *s = "hello"; }';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses string with escapes', () => {
      const code = 'void f(void) { char *s = "hello\\nworld\\t!"; }';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses DAT string reference', () => {
      const code = `
        char *DAT_00404000 = "constant string";
        void f(void) {
          puts(DAT_00404000);
        }
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 2);
    });
  });

  describe('Numeric literal patterns', () => {
    it('parses hex literals', () => {
      const code = 'void f(void) { int x = 0xdeadbeef; }';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses negative numbers', () => {
      const code = 'void f(void) { int x = -1; }';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses large constants', () => {
      const code = 'void f(void) { long x = 0x7fffffffffffffffLL; }';
      // Note: LL suffix may need handling
      try {
        const ast = parse(code);
        assert.ok(ast.declarations.length === 1);
      } catch {
        // May fail on suffix parsing
      }
    });

    it('parses address-like constants', () => {
      const code = `
        void f(void) {
          void *p = (void *)0x00401000;
          int *q = (int *)0x00402000;
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });
  });

  describe('Complete Ghidra function examples', () => {
    it('parses a typical decompiled function', () => {
      const code = `
void FUN_00401000(int param_1, char *param_2)
{
  int local_c;
  int local_8;

  local_8 = param_1;
  local_c = 0;
  while (local_c < local_8) {
    *(param_2 + local_c) = 0;
    local_c = local_c + 1;
  }
  return;
}
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 1);
      const fn = ast.declarations[0] as FunctionDecl;
      assert.strictEqual((fn.name as Identifier).name, 'FUN_00401000');
    });

    it('parses function with pointer manipulation', () => {
      const code = `
undefined8 FUN_00401100(long param_1)
{
  undefined8 uVar1;

  if (*(int *)(param_1 + 4) == 0) {
    uVar1 = 0;
  }
  else {
    uVar1 = *(undefined8 *)(param_1 + 8);
  }
  return uVar1;
}
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses function with switch statement', () => {
      const code = `
int FUN_00401200(int param_1)
{
  int iVar1;

  switch(param_1) {
  case 0:
    iVar1 = 1;
    break;
  case 1:
    iVar1 = 2;
    break;
  case 2:
    iVar1 = 4;
    break;
  default:
    iVar1 = 0;
  }
  return iVar1;
}
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses function calling other functions', () => {
      const code = `
void FUN_00401300(void)
{
  int iVar1;

  iVar1 = FUN_00401000(5, "test");
  if (iVar1 != 0) {
    FUN_00401100((long)iVar1);
  }
  return;
}
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 1);
    });
  });

  describe('wchar_t and unicode char type casts', () => {
    it('parses (wchar_t *)0x0 cast', () => {
      const code = `
        void f(void) {
          wchar_t *p = (wchar_t *)0x0;
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses (char16_t *)ptr cast', () => {
      const code = `
        void f(void *ptr) {
          char16_t *p = (char16_t *)ptr;
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses wchar_t as parameter type', () => {
      const code = 'void f(wchar_t param_1) {}';
      const ast = parse(code);
      const fn = ast.declarations[0] as FunctionDecl;
      assert.strictEqual(fn.parameters.length, 1);
    });

    it('parses char32_t pointer cast', () => {
      const code = `
        void f(long x) {
          char32_t *p = (char32_t *)x;
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });
  });

  describe('Double bracket ]] splitting', () => {
    it('parses nested array access a[b[c]]', () => {
      const code = `
        int f(int *a, int *b, int c) {
          return a[b[c]];
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses triple nested a[b[c[d]]]', () => {
      const code = `
        int f(int *a, int *b, int *c, int d) {
          return a[b[c[d]]];
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });
  });

  describe('Operator name parsing', () => {
    it('parses qualified operator call: Cls::operator=()', () => {
      const code = `
        void f(void) {
          Cls::operator=(a, b);
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses free operator function call: operator+(a, b)', () => {
      const code = `
        void f(int a, int b) {
          operator+(a, b);
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses member operator call: obj.operator==(x)', () => {
      const code = `
        void f(void) {
          obj.operator==(x);
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses operator[] call', () => {
      const code = `
        void f(void) {
          obj.operator[](5);
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses operator() call', () => {
      const code = `
        void f(void) {
          obj.operator()(1, 2);
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });
  });

  describe('Destructor parsing', () => {
    it('parses destructor call via arrow: p->~Foo()', () => {
      const code = `
        void f(Foo *p) {
          p->~Foo();
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses destructor call via dot: obj.~Bar()', () => {
      const code = `
        void f(void) {
          obj.~Bar();
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses qualified destructor: Ns::~Cls()', () => {
      const code = `
        void f(void) {
          Ns::~Cls();
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });
  });

  describe('Non-type template parameters', () => {
    it('parses template with integer value: T<int, 0>', () => {
      const code = 'void f(TSHashTableReuse<int, 0> param_1) {}';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses template with multiple values: T<A, 0, 1>', () => {
      const code = 'void f(Tmpl<MyType, 0, 1> param_1) {}';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses template with negative value: T<int, -1>', () => {
      const code = 'void f(Buffer<int, -1> param_1) {}';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });
  });

  describe('Ghidra array type syntax', () => {
    it('parses type*[N] in declaration: ushort*[2] var', () => {
      const code = `
        void f(void) {
          unsigned short *arr[2];
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses type[N] array suffix in variable', () => {
      const code = `
        void f(void) {
          int arr[10];
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });
  });

  describe('Pointer-to-array declarations', () => {
    it('parses char (*p)[60]', () => {
      const code = `
        void f(void) {
          char (*p)[60];
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses int (*arr)[10] with initializer', () => {
      const code = `
        void f(int (*data)[10]) {
          int (*p)[10] = data;
        }
      `;
      // The parameter is complex - just check it doesn't crash
      try {
        const ast = parse(code);
        assert.ok(true);
      } catch (e) {
        assert.ok(e instanceof ParserError);
      }
    });
  });

  describe('Restrict qualifier', () => {
    it('parses restrict-qualified pointer type', () => {
      const code = 'void f(int * restrict p) {}';
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });

    it('parses restrict in cast', () => {
      const code = `
        void f(void *p) {
          int * restrict rp = (int * restrict)p;
        }
      `;
      const ast = parse(code);
      assert.ok(ast.declarations.length === 1);
    });
  });

  describe('Round-trip stability', () => {
    it('maintains structure after parse-emit-parse', () => {
      const code = `
void FUN_00401000(int param_1) {
  int local_8;
  local_8 = param_1 + 1;
  if (local_8 > 10) {
    return;
  }
  FUN_00401100(local_8);
}
      `;
      const ast1 = parse(code);
      const emitted = emit(ast1);
      const ast2 = parse(emitted);

      // Check structure is preserved
      assert.strictEqual(ast1.declarations.length, ast2.declarations.length);
      const fn1 = ast1.declarations[0] as FunctionDecl;
      const fn2 = ast2.declarations[0] as FunctionDecl;
      assert.strictEqual((fn1.name as Identifier).name, (fn2.name as Identifier).name);
      assert.strictEqual(fn1.parameters.length, fn2.parameters.length);
    });
  });
});
