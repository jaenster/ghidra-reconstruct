import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CppEmitter, emit, DEFAULT_STYLE, GOOGLE_STYLE, createStyle } from '../index.js';
import { Type, Expr, Stmt, Decl } from '../../ast/factory.js';
import { NodeKind } from '../../ast/kinds.js';
import { parse } from '../../parser/index.js';

describe('CppEmitter', () => {
  describe('Literals', () => {
    it('emits integer literals', () => {
      assert.strictEqual(emit(Expr.intLiteral(42)), '42');
      assert.strictEqual(emit(Expr.intLiteral(255, 16)), '0xff');
      assert.strictEqual(emit(Expr.intLiteral(7, 8)), '07');
      assert.strictEqual(emit(Expr.intLiteral(5, 2)), '0b101');
    });

    it('emits float literals', () => {
      assert.strictEqual(emit(Expr.floatLiteral(3.14)), '3.14');
      assert.strictEqual(emit(Expr.floatLiteral(1.0)), '1');
    });

    it('emits string literals', () => {
      assert.strictEqual(emit(Expr.stringLiteral('hello')), '"hello"');
      assert.strictEqual(emit(Expr.stringLiteral('world', 'L')), 'L"world"');
    });

    it('emits char literals', () => {
      assert.strictEqual(emit(Expr.charLiteral('A')), "'A'");
    });

    it('emits bool literals', () => {
      assert.strictEqual(emit(Expr.boolLiteral(true)), 'true');
      assert.strictEqual(emit(Expr.boolLiteral(false)), 'false');
    });

    it('emits nullptr', () => {
      assert.strictEqual(emit(Expr.nullptr()), 'nullptr');
    });

    it('emits this', () => {
      assert.strictEqual(emit(Expr.this()), 'this');
    });
  });

  describe('Identifiers', () => {
    it('emits simple identifiers', () => {
      assert.strictEqual(emit(Expr.identifier('foo')), 'foo');
      assert.strictEqual(emit(Expr.identifier('_bar123')), '_bar123');
    });

    it('emits qualified identifiers', () => {
      assert.strictEqual(emit(Expr.qualifiedId(['std', 'vector'])), 'std::vector');
      assert.strictEqual(emit(Expr.qualifiedId(['a', 'b', 'c'])), 'a::b::c');
    });

    it('emits global qualified identifiers', () => {
      assert.strictEqual(emit(Expr.qualifiedId(['Global'], true)), '::Global');
    });
  });

  describe('Binary Expressions', () => {
    it('emits binary operations', () => {
      const a = Expr.identifier('a');
      const b = Expr.identifier('b');

      assert.strictEqual(emit(Expr.add(a, b)), 'a + b');
      assert.strictEqual(emit(Expr.sub(a, b)), 'a - b');
      assert.strictEqual(emit(Expr.mul(a, b)), 'a * b');
      assert.strictEqual(emit(Expr.div(a, b)), 'a / b');
    });

    it('emits comparison operations', () => {
      const x = Expr.identifier('x');
      const y = Expr.identifier('y');

      assert.strictEqual(emit(Expr.eq(x, y)), 'x == y');
      assert.strictEqual(emit(Expr.ne(x, y)), 'x != y');
      assert.strictEqual(emit(Expr.lt(x, y)), 'x < y');
      assert.strictEqual(emit(Expr.gt(x, y)), 'x > y');
    });

    it('emits logical operations', () => {
      const p = Expr.identifier('p');
      const q = Expr.identifier('q');

      assert.strictEqual(emit(Expr.and(p, q)), 'p && q');
      assert.strictEqual(emit(Expr.or(p, q)), 'p || q');
    });

    it('handles operator precedence with parentheses', () => {
      const a = Expr.identifier('a');
      const b = Expr.identifier('b');
      const c = Expr.identifier('c');

      // (a + b) * c should keep parens around lower precedence
      const addMul = Expr.mul(Expr.add(a, b), c);
      assert.strictEqual(emit(addMul), '(a + b) * c');

      // a + (b * c) should not need parens
      const mulAdd = Expr.add(a, Expr.mul(b, c));
      assert.strictEqual(emit(mulAdd), 'a + b * c');
    });
  });

  describe('Unary Expressions', () => {
    it('emits prefix unary operations', () => {
      const x = Expr.identifier('x');

      assert.strictEqual(emit(Expr.neg(x)), '-x');
      assert.strictEqual(emit(Expr.not(x)), '!x');
      assert.strictEqual(emit(Expr.deref(x)), '*x');
      assert.strictEqual(emit(Expr.addressOf(x)), '&x');
    });

    it('emits prefix increment/decrement', () => {
      const i = Expr.identifier('i');

      assert.strictEqual(emit(Expr.unary('++', i)), '++i');
      assert.strictEqual(emit(Expr.unary('--', i)), '--i');
    });

    it('emits postfix increment/decrement', () => {
      const i = Expr.identifier('i');

      assert.strictEqual(emit(Expr.postfix(i, '++')), 'i++');
      assert.strictEqual(emit(Expr.postfix(i, '--')), 'i--');
    });
  });

  describe('Member Access', () => {
    it('emits dot member access', () => {
      const obj = Expr.identifier('obj');
      const member = Expr.member(obj, 'field');
      assert.strictEqual(emit(member), 'obj.field');
    });

    it('emits arrow member access', () => {
      const ptr = Expr.identifier('ptr');
      const member = Expr.member(ptr, 'field', true);
      assert.strictEqual(emit(member), 'ptr->field');
    });
  });

  describe('Subscript Expressions', () => {
    it('emits array subscript', () => {
      const arr = Expr.identifier('arr');
      const sub = Expr.subscript(arr, Expr.intLiteral(0));
      assert.strictEqual(emit(sub), 'arr[0]');
    });

    it('emits nested subscripts', () => {
      const mat = Expr.identifier('mat');
      const inner = Expr.subscript(mat, Expr.identifier('i'));
      const outer = Expr.subscript(inner, Expr.identifier('j'));
      assert.strictEqual(emit(outer), 'mat[i][j]');
    });
  });

  describe('Call Expressions', () => {
    it('emits function calls', () => {
      const call = Expr.call('printf', [Expr.stringLiteral('hello')]);
      assert.strictEqual(emit(call), 'printf("hello")');
    });

    it('emits calls with multiple arguments', () => {
      const call = Expr.call('add', [Expr.intLiteral(1), Expr.intLiteral(2)]);
      assert.strictEqual(emit(call), 'add(1, 2)');
    });

    it('emits calls with no arguments', () => {
      const call = Expr.call('getTime', []);
      assert.strictEqual(emit(call), 'getTime()');
    });
  });

  describe('Assignment Expressions', () => {
    it('emits simple assignment', () => {
      const x = Expr.identifier('x');
      const assign = Expr.assign(x, Expr.intLiteral(10));
      assert.strictEqual(emit(assign), 'x = 10');
    });

    it('emits compound assignment', () => {
      const x = Expr.identifier('x');
      assert.strictEqual(emit(Expr.assign(x, Expr.intLiteral(5), '+=')), 'x += 5');
      assert.strictEqual(emit(Expr.assign(x, Expr.intLiteral(2), '*=')), 'x *= 2');
    });
  });

  describe('Conditional Expressions', () => {
    it('emits ternary operator', () => {
      const cond = Expr.conditional(
        Expr.identifier('flag'),
        Expr.intLiteral(1),
        Expr.intLiteral(0)
      );
      assert.strictEqual(emit(cond), 'flag ? 1 : 0');
    });
  });

  describe('Cast Expressions', () => {
    it('emits C-style casts', () => {
      const cast = Expr.cast(Type.int(), Expr.identifier('x'));
      assert.strictEqual(emit(cast), '(int)x');
    });

    it('emits sizeof expressions', () => {
      const sizeofExpr = Expr.sizeof(Expr.identifier('x'));
      assert.strictEqual(emit(sizeofExpr), 'sizeof(x)');

      const sizeofType = Expr.sizeof(Type.int(), true);
      assert.strictEqual(emit(sizeofType), 'sizeof(int)');
    });
  });

  describe('Init List Expressions', () => {
    it('emits initializer lists', () => {
      const init = Expr.initList([
        Expr.intLiteral(1),
        Expr.intLiteral(2),
        Expr.intLiteral(3),
      ]);
      assert.strictEqual(emit(init), '{1, 2, 3}');
    });

    it('emits empty initializer lists', () => {
      const init = Expr.initList([]);
      assert.strictEqual(emit(init), '{}');
    });
  });

  describe('Parenthesized Expressions', () => {
    it('emits parenthesized expressions', () => {
      const paren = Expr.paren(Expr.add(Expr.identifier('a'), Expr.identifier('b')));
      // ParenExpr is transparent in the emitter — precedence logic re-adds parens when needed
      assert.strictEqual(emit(paren), 'a + b');
    });
  });

  describe('Types', () => {
    it('emits builtin types', () => {
      assert.strictEqual(emit(Type.int()), 'int');
      assert.strictEqual(emit(Type.void()), 'void');
      assert.strictEqual(emit(Type.char()), 'char');
      assert.strictEqual(emit(Type.bool()), 'bool');
      assert.strictEqual(emit(Type.float()), 'float');
      assert.strictEqual(emit(Type.double()), 'double');
    });

    it('emits modified builtin types', () => {
      assert.strictEqual(emit(Type.int(['unsigned'])), 'unsigned int');
      assert.strictEqual(emit(Type.int(['long', 'long'])), 'long long int');
      assert.strictEqual(emit(Type.char(['unsigned'])), 'unsigned char');
    });

    it('emits pointer types', () => {
      const intPtr = Type.pointer(Type.int());
      assert.strictEqual(emit(intPtr), 'int*');
    });

    it('emits const pointer types', () => {
      const constPtr = Type.pointer(Type.int(), ['const']);
      assert.strictEqual(emit(constPtr), 'int* const');
    });

    it('emits reference types', () => {
      const intRef = Type.reference(Type.int());
      assert.strictEqual(emit(intRef), 'int&');
    });

    it('emits array types', () => {
      const arr = Type.array(Type.int(), Expr.intLiteral(10));
      assert.strictEqual(emit(arr), 'int[10]');

      const arrNoSize = Type.array(Type.int());
      assert.strictEqual(emit(arrNoSize), 'int[]');
    });

    it('emits const qualified types', () => {
      const constInt = Type.const(Type.int());
      assert.strictEqual(emit(constInt), 'const int');
    });

    it('emits template types', () => {
      const vecInt = Type.template(Expr.qualifiedId(['std', 'vector']), [Type.int()]);
      assert.strictEqual(emit(vecInt), 'std::vector<int>');
    });

    it('emits auto type', () => {
      const auto = Type.auto();
      assert.strictEqual(emit(auto), 'auto');

      const decltypeAuto = Type.auto(true);
      assert.strictEqual(emit(decltypeAuto), 'decltype(auto)');
    });
  });

  describe('Statements', () => {
    describe('Expression Statements', () => {
      it('emits expression statements in compound', () => {
        const block = Stmt.compound([
          Stmt.expr(Expr.call('foo', [])),
        ]);
        const result = emit(block);
        assert.ok(result.includes('foo();'));
      });
    });

    describe('Return Statements', () => {
      it('emits return with value', () => {
        const ret = Stmt.return_(Expr.intLiteral(42));
        assert.strictEqual(emit(ret), 'return 42');
      });

      it('emits return without value', () => {
        const ret = Stmt.return_();
        assert.strictEqual(emit(ret), 'return');
      });
    });

    describe('If Statements', () => {
      it('emits if statement', () => {
        const ifStmt = Stmt.if_(
          Expr.identifier('cond'),
          Stmt.return_(Expr.intLiteral(1))
        );
        const result = emit(ifStmt);
        assert.ok(result.includes('if (cond)'));
        assert.ok(result.includes('return 1'));
      });

      it('emits if-else statement', () => {
        const ifStmt = Stmt.if_(
          Expr.identifier('cond'),
          Stmt.return_(Expr.intLiteral(1)),
          Stmt.return_(Expr.intLiteral(0))
        );
        const result = emit(ifStmt);
        assert.ok(result.includes('if (cond)'));
        assert.ok(result.includes('else'));
      });

      it('emits if with compound body', () => {
        const ifStmt = Stmt.if_(
          Expr.identifier('x'),
          Stmt.compound([
            Stmt.expr(Expr.call('foo', [])),
            Stmt.return_(Expr.intLiteral(1)),
          ])
        );
        const result = emit(ifStmt);
        assert.ok(result.includes('{'));
        assert.ok(result.includes('}'));
      });
    });

    describe('Loop Statements', () => {
      it('emits while statement', () => {
        const whileStmt = Stmt.while_(
          Expr.lt(Expr.identifier('i'), Expr.intLiteral(10)),
          Stmt.compound([
            Stmt.expr(Expr.postfix(Expr.identifier('i'), '++')),
          ])
        );
        const result = emit(whileStmt);
        assert.ok(result.includes('while (i < 10)'));
      });

      it('emits do-while statement', () => {
        const doWhile = Stmt.doWhile(
          Stmt.compound([]),
          Expr.boolLiteral(false)
        );
        const result = emit(doWhile);
        assert.ok(result.includes('do'));
        assert.ok(result.includes('while (false)'));
      });

      it('emits for statement', () => {
        const forStmt = Stmt.for_(
          Stmt.expr(Expr.assign(Expr.identifier('i'), Expr.intLiteral(0))),
          Expr.lt(Expr.identifier('i'), Expr.intLiteral(10)),
          Expr.postfix(Expr.identifier('i'), '++'),
          Stmt.compound([])
        );
        const result = emit(forStmt);
        assert.ok(result.includes('for (i = 0; i < 10; i++)'));
      });

      it('emits for statement with null parts', () => {
        const forStmt = Stmt.for_(
          null,
          null,
          null,
          Stmt.compound([Stmt.break_()])
        );
        const result = emit(forStmt);
        assert.ok(result.includes('for (; ;)'));
      });
    });

    describe('Control Flow', () => {
      it('emits break statement', () => {
        const brk = Stmt.break_();
        assert.strictEqual(emit(brk), 'break');
      });

      it('emits continue statement', () => {
        const cont = Stmt.continue_();
        assert.strictEqual(emit(cont), 'continue');
      });
    });

    describe('Compound Statements', () => {
      it('emits empty compound statement', () => {
        const block = Stmt.compound([]);
        assert.strictEqual(emit(block), '{}');
      });

      it('emits compound with multiple statements', () => {
        const block = Stmt.compound([
          Stmt.expr(Expr.call('a', [])),
          Stmt.expr(Expr.call('b', [])),
          Stmt.return_(Expr.intLiteral(0)),
        ]);
        const result = emit(block);
        assert.ok(result.includes('a();'));
        assert.ok(result.includes('b();'));
        assert.ok(result.includes('return 0;'));
      });
    });
  });

  describe('Declarations', () => {
    describe('Variable Declarations', () => {
      it('emits variable declaration', () => {
        const varDecl = Decl.variable('x', Type.int());
        const result = emit(varDecl);
        assert.ok(result.includes('int x;'));
      });

      it('emits variable with initializer', () => {
        const varDecl = Decl.variable('count', Type.int(), Expr.intLiteral(0));
        const result = emit(varDecl);
        assert.ok(result.includes('int count = 0;'));
      });

      it('emits variable with specifiers', () => {
        const varDecl = Decl.variable('g_value', Type.int(), Expr.intLiteral(42), ['static']);
        const result = emit(varDecl);
        assert.ok(result.includes('static'));
        assert.ok(result.includes('int g_value = 42;'));
      });
    });

    describe('Function Declarations', () => {
      it('emits function declaration without body', () => {
        const fn = Decl.function_('foo', Type.void(), []);
        const result = emit(fn);
        assert.ok(result.includes('void foo();'));
      });

      it('emits function with parameters', () => {
        const fn = Decl.function_(
          'add',
          Type.int(),
          [
            Decl.parameter('a', Type.int()),
            Decl.parameter('b', Type.int()),
          ]
        );
        const result = emit(fn);
        assert.ok(result.includes('int add(int a, int b);'));
      });

      it('emits function with body', () => {
        const fn = Decl.function_(
          'getOne',
          Type.int(),
          [],
          Stmt.compound([Stmt.return_(Expr.intLiteral(1))])
        );
        const result = emit(fn);
        assert.ok(result.includes('int getOne()'));
        assert.ok(result.includes('{'));
        assert.ok(result.includes('return 1;'));
        assert.ok(result.includes('}'));
      });

      it('emits function with specifiers', () => {
        const fn = Decl.function_(
          'helper',
          Type.void(),
          [],
          null,
          ['static', 'inline']
        );
        const result = emit(fn);
        assert.ok(result.includes('static inline void helper();'));
      });

      it('emits function with default parameter', () => {
        const fn = Decl.function_(
          'greet',
          Type.void(),
          [Decl.parameter('name', Type.pointer(Type.char()), Expr.stringLiteral('World'))]
        );
        const result = emit(fn);
        assert.ok(result.includes('= "World"'));
      });
    });

    describe('Struct Declarations', () => {
      it('emits struct declaration', () => {
        const strct = Decl.struct_('Point', [
          Decl.field('x', Type.int()),
          Decl.field('y', Type.int()),
        ]);
        const result = emit(strct);
        assert.ok(result.includes('struct Point'));
        assert.ok(result.includes('int x;'));
        assert.ok(result.includes('int y;'));
        assert.ok(result.includes('};'));
      });

      it('emits anonymous struct', () => {
        const strct = Decl.struct_(null, [
          Decl.field('value', Type.int()),
        ]);
        const result = emit(strct);
        assert.ok(result.includes('struct {'));
      });
    });

    describe('Class Declarations', () => {
      it('emits class declaration', () => {
        const cls = Decl.class_('Counter', [
          Decl.field('count', Type.int(), Expr.intLiteral(0)),
        ]);
        const result = emit(cls);
        assert.ok(result.includes('class Counter'));
        assert.ok(result.includes('int count = 0;'));
      });
    });

    describe('Enum Declarations', () => {
      it('emits enum declaration', () => {
        const enm = Decl.enum_('Color', [
          Decl.enumerator('Red', Expr.intLiteral(0)),
          Decl.enumerator('Green', Expr.intLiteral(1)),
          Decl.enumerator('Blue', Expr.intLiteral(2)),
        ]);
        const result = emit(enm);
        assert.ok(result.includes('enum Color'));
        assert.ok(result.includes('Red = 0'));
        assert.ok(result.includes('Green = 1'));
        assert.ok(result.includes('Blue = 2'));
      });

      it('emits scoped enum', () => {
        const enm = Decl.enum_('Status', [
          Decl.enumerator('Ok'),
          Decl.enumerator('Error'),
        ], true);
        const result = emit(enm);
        assert.ok(result.includes('enum class Status'));
      });

      it('emits enum with underlying type', () => {
        const enm = Decl.enum_('Byte', [], true, Type.char(['unsigned']));
        const result = emit(enm);
        assert.ok(result.includes(': unsigned char'));
      });
    });

    describe('Namespace Declarations', () => {
      it('emits namespace declaration', () => {
        const ns = Decl.namespace_('myns', [
          Decl.variable('x', Type.int()),
        ]);
        const result = emit(ns);
        assert.ok(result.includes('namespace myns'));
        assert.ok(result.includes('{'));
        assert.ok(result.includes('int x;'));
        assert.ok(result.includes('}'));
      });

      it('emits inline namespace', () => {
        const ns = Decl.namespace_('v1', [], true);
        const result = emit(ns);
        assert.ok(result.includes('inline namespace v1'));
      });

      it('emits anonymous namespace', () => {
        const ns = Decl.namespace_(null, [
          Decl.function_('helper', Type.void(), []),
        ]);
        const result = emit(ns);
        assert.ok(result.includes('namespace {'));
      });
    });

    describe('Typedef and Type Alias', () => {
      it('emits typedef', () => {
        const td = Decl.typedef_('IntPtr', Type.pointer(Type.int()));
        const result = emit(td);
        assert.ok(result.includes('typedef int* IntPtr;'));
      });

      it('emits type alias', () => {
        const ta = Decl.typeAlias('Size', Type.int(['unsigned', 'long']));
        const result = emit(ta);
        assert.ok(result.includes('using Size = unsigned long int;'));
      });
    });

    describe('Translation Unit', () => {
      it('emits translation unit', () => {
        const tu = Decl.translationUnit([
          Decl.function_('main', Type.int(), [], Stmt.compound([
            Stmt.return_(Expr.intLiteral(0)),
          ])),
        ]);
        const result = emit(tu);
        assert.ok(result.includes('int main()'));
        assert.ok(result.includes('return 0;'));
      });
    });
  });

  describe('Style Options', () => {
    it('respects indentation width', () => {
      const fn = Decl.function_(
        'test',
        Type.void(),
        [],
        Stmt.compound([Stmt.return_()])
      );

      const result4 = emit(fn, { indentWidth: 4 });
      assert.ok(result4.includes('    return;'));

      const result2 = emit(fn, { indentWidth: 2 });
      assert.ok(result2.includes('  return;'));
    });

    it('respects useTabs', () => {
      const fn = Decl.function_(
        'test',
        Type.void(),
        [],
        Stmt.compound([Stmt.return_()])
      );

      const result = emit(fn, { useTabs: true });
      assert.ok(result.includes('\treturn;'));
    });

    it('respects spaceAroundOperators', () => {
      const expr = Expr.add(Expr.identifier('a'), Expr.identifier('b'));

      const withSpace = emit(expr, { spaceAroundOperators: true });
      assert.strictEqual(withSpace, 'a + b');

      const noSpace = emit(expr, { spaceAroundOperators: false });
      assert.strictEqual(noSpace, 'a+b');
    });

    it('respects spaceAfterComma', () => {
      const call = Expr.call('foo', [Expr.intLiteral(1), Expr.intLiteral(2)]);

      const withSpace = emit(call, { spaceAfterComma: true });
      assert.strictEqual(withSpace, 'foo(1, 2)');

      const noSpace = emit(call, { spaceAfterComma: false });
      assert.strictEqual(noSpace, 'foo(1,2)');
    });

    it('respects spaceAfterKeyword', () => {
      const ifStmt = Stmt.if_(
        Expr.identifier('x'),
        Stmt.return_(Expr.intLiteral(1))
      );

      const withSpace = emit(ifStmt, { spaceAfterKeyword: true });
      assert.ok(withSpace.includes('if ('));

      const noSpace = emit(ifStmt, { spaceAfterKeyword: false });
      assert.ok(noSpace.includes('if('));
    });

    it('respects pointer alignment left', () => {
      const ptr = Type.pointer(Type.int());
      const result = emit(ptr, { pointerAlignment: 'left' });
      assert.strictEqual(result, 'int*');
    });

    it('respects pointer alignment right', () => {
      const ptr = Type.pointer(Type.int());
      const result = emit(ptr, { pointerAlignment: 'right' });
      assert.strictEqual(result, 'int *');
    });

    it('respects allman brace style', () => {
      const fn = Decl.function_(
        'test',
        Type.void(),
        [],
        Stmt.compound([])
      );

      const result = emit(fn, { braceStyle: 'allman' });
      // In Allman style, the brace should be on a new line
      assert.ok(result.includes('void test()\n{'));
    });

    it('can use predefined styles', () => {
      const fn = Decl.function_(
        'test',
        Type.void(),
        [],
        Stmt.compound([Stmt.return_()])
      );

      // Just verify it doesn't throw
      const result = emit(fn, GOOGLE_STYLE);
      assert.ok(result.includes('void test()'));
    });

    it('can create custom styles', () => {
      const style = createStyle({ indentWidth: 4, useTabs: false });
      assert.strictEqual(style.indentWidth, 4);
      assert.strictEqual(style.useTabs, false);
      assert.strictEqual(style.braceStyle, DEFAULT_STYLE.braceStyle);
    });
  });

  describe('Complex Examples', () => {
    it('emits a complete function with control flow', () => {
      const fn = Decl.function_(
        'factorial',
        Type.int(),
        [Decl.parameter('n', Type.int())],
        Stmt.compound([
          Stmt.if_(
            Expr.binary(Expr.identifier('n'), '<=', Expr.intLiteral(1)),
            Stmt.return_(Expr.intLiteral(1))
          ),
          Stmt.return_(
            Expr.mul(
              Expr.identifier('n'),
              Expr.call('factorial', [
                Expr.sub(Expr.identifier('n'), Expr.intLiteral(1))
              ])
            )
          ),
        ])
      );

      const result = emit(fn);
      assert.ok(result.includes('int factorial(int n)'));
      assert.ok(result.includes('if (n <= 1)'));
      assert.ok(result.includes('return 1;'));
      assert.ok(result.includes('return n * factorial(n - 1);'));
    });

    it('emits nested expressions correctly', () => {
      // (a + b) * (c - d) / e
      const expr = Expr.div(
        Expr.mul(
          Expr.add(Expr.identifier('a'), Expr.identifier('b')),
          Expr.sub(Expr.identifier('c'), Expr.identifier('d'))
        ),
        Expr.identifier('e')
      );

      const result = emit(expr);
      assert.strictEqual(result, '(a + b) * (c - d) / e');
    });

    it('emits chained member access', () => {
      // a.b.c->d
      const chain = Expr.member(
        Expr.member(
          Expr.member(Expr.identifier('a'), 'b'),
          'c'
        ),
        'd',
        true
      );
      assert.strictEqual(emit(chain), 'a.b.c->d');
    });

    it('emits method chaining', () => {
      // builder.setX(1).setY(2).build()
      const chain = Expr.call(
        Expr.member(
          Expr.call(
            Expr.member(
              Expr.call(
                Expr.member(Expr.identifier('builder'), 'setX'),
                [Expr.intLiteral(1)]
              ),
              'setY'
            ),
            [Expr.intLiteral(2)]
          ),
          'build'
        ),
        []
      );
      assert.strictEqual(emit(chain), 'builder.setX(1).setY(2).build()');
    });
  });

  describe('CppEmitter class', () => {
    it('can be instantiated with custom style', () => {
      const emitter = new CppEmitter({ indentWidth: 8 });
      const result = emitter.emit(Decl.function_(
        'test',
        Type.void(),
        [],
        Stmt.compound([Stmt.return_()])
      ));
      assert.ok(result.includes('        return;'));
    });

    it('can emit multiple nodes', () => {
      const emitter = new CppEmitter();
      const expr1 = emitter.emit(Expr.intLiteral(42));
      const expr2 = emitter.emit(Expr.stringLiteral('hello'));

      assert.strictEqual(expr1, '42');
      assert.strictEqual(expr2, '"hello"');
    });
  });

  describe('Control-flow blank lines + braces', () => {
    const src = `int f(int* p, int n) {
  int s = 0;
  if (!p) return -1;
  if (n <= 0) return 0;
  for (int i = 0; i < n; i++) { s += p[i]; }
  done();
  return s;
}`;

    it('braces single-statement bodies, spaces blocks, keeps guard ifs tight', () => {
      const out = emit(parse(src) as any, {
        alwaysUseBraces: true,
        blankLineAroundControlFlow: true,
      }).trim();
      assert.strictEqual(out, `int f(int* p, int n) {
  int s = 0;
  if (!p) {
    return -1;
  }
  if (n <= 0) {
    return 0;
  }

  for (int i = 0; i < n; i++) {
    s += p[i];
  }

  done();
  return s;
}`);
    });

    it('is off by default (no forced braces, no blank lines)', () => {
      const out = emit(parse(src) as any).trim();
      assert.strictEqual(out, `int f(int* p, int n) {
  int s = 0;
  if (!p)
    return -1;
  if (n <= 0)
    return 0;
  for (int i = 0; i < n; i++) {
    s += p[i];
  }
  done();
  return s;
}`);
    });
  });
});
