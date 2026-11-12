import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CppEmitter, emit, DEFAULT_STYLE, GOOGLE_STYLE, createStyle } from '../index.js';
import { Type, Expr, Stmt, Decl } from '../../ast/factory.js';
import { NodeKind } from '../../ast/kinds.js';
import type { BinaryExpr, CharLiteralExpr, CompoundStmt, ConditionalExpr, ExprStmt, Expression, FunctionDecl, IfStmt, ParenExpr, PpConditionalStmt, ReturnStmt, Statement, UnaryExpr } from '../../ast/nodes.js';
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

    it('escapes character literals and reparses every byte value', () => {
      const examples: Array<[number, string]> = [
        [39, "'\\''"],
        [92, "'\\\\'"],
        [10, "'\\n'"],
        [0, "'\\000'"],
        [9, "'\\t'"],
        [65, "'A'"],
        [255, "'\\377'"],
      ];
      for (const [value, expected] of examples) {
        assert.strictEqual(emit(Expr.charLiteral(value)), expected);
      }
      assert.strictEqual(emit(Expr.charLiteral("'")), "'\\''");

      for (let value = 0; value <= 0xff; value++) {
        const emitted = emit(Expr.charLiteral(value));
        const fn = parse(`int f() { return ${emitted}; }`).declarations[0] as FunctionDecl;
        const parsed = (fn.body!.statements[0] as ReturnStmt).value as CharLiteralExpr;
        assert.strictEqual(parsed.kind, NodeKind.CharLiteral, emitted);
        assert.strictEqual(parsed.value, value, emitted);
      }
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
    it('separates compact binary operators from leading unary tokens', () => {
      const x = Expr.identifier('x');
      const y = Expr.identifier('y');
      const cases = [
        ['+', '+', 'x+ +y'],
        ['+', '++', 'x+ ++y'],
        ['-', '-', 'x- -y'],
        ['-', '--', 'x- --y'],
        ['&', '&', 'x& &y'],
        ['/', '*', 'x/ *y'],
        ['+', '-', 'x+-y'],
        ['-', '+', 'x-+y'],
        ['*', '*', 'x**y'],
        ['&&', '&', 'x&&&y'],
      ] as const;

      for (const [binaryOp, unaryOp, expected] of cases) {
        const expression = Expr.binary(x, binaryOp, Expr.unary(unaryOp, y));
        const emitted = emit(expression, { spaceAroundOperators: false });
        assert.strictEqual(emitted, expected);
        const fn = parse(`int f(int x, int y) { return ${emitted}; }`).declarations[0] as FunctionDecl;
        const result = (fn.body!.statements[0] as ReturnStmt).value as BinaryExpr;
        assert.strictEqual(result.kind, NodeKind.BinaryExpr);
        assert.strictEqual(result.operator, binaryOp);
        assert.strictEqual(result.right.kind, NodeKind.UnaryExpr);
        assert.strictEqual((result.right as UnaryExpr).operator, unaryOp);
      }

      for (const [binaryOp, unaryOp, expected] of [
        ['+', '+', 'x+ +y'],
        ['/', '*', 'x/ *y'],
      ] as const) {
        const parenthesized = Expr.binary(x, binaryOp, Expr.paren(Expr.unary(unaryOp, y)));
        const emitted = emit(parenthesized, { spaceAroundOperators: false });
        assert.strictEqual(emitted, expected);
        const fn = parse(`int f(int x, int *y) { return ${emitted}; }`).declarations[0] as FunctionDecl;
        const result = (fn.body!.statements[0] as ReturnStmt).value as BinaryExpr;
        assert.strictEqual(result.kind, NodeKind.BinaryExpr);
        assert.strictEqual(result.operator, binaryOp);
        assert.strictEqual(result.right.kind, NodeKind.UnaryExpr);
        assert.strictEqual((result.right as UnaryExpr).operator, unaryOp);
      }
    });

    it('separates compact subtraction from signed factory literals', () => {
      const x = Expr.identifier('x');
      const cases = [
        [Expr.intLiteral(-1), 'x- -1'],
        [Expr.intLiteral(-1, 16), 'x- -0x1'],
        [Expr.floatLiteral(-1.5), 'x- -1.5'],
      ] as const;

      for (const [literal, expected] of cases) {
        const emitted = emit(Expr.binary(x, '-', literal), { spaceAroundOperators: false });
        assert.strictEqual(emitted, expected);
        const fn = parse(`double f(double x) { return ${emitted}; }`).declarations[0] as FunctionDecl;
        const result = (fn.body!.statements[0] as ReturnStmt).value as BinaryExpr;
        assert.strictEqual(result.kind, NodeKind.BinaryExpr);
        assert.strictEqual(result.operator, '-');
        assert.strictEqual(result.right.kind, NodeKind.UnaryExpr);
        assert.strictEqual((result.right as UnaryExpr).operator, '-');
      }
    });

    it('follows the emitted left edge of a tighter right-hand expression', () => {
      const x = Expr.identifier('x');
      const y = Expr.identifier('y');
      const z = Expr.identifier('z');
      const p = Expr.identifier('p');
      const m = Expr.identifier('m');
      const plusProduct = Expr.binary(Expr.unary('+', y), '*', z);
      const cases = [
        [Expr.binary(x, '+', plusProduct), 'x+ +y*z', '+', '*', '+'],
        [Expr.binary(x, '+', Expr.binary(Expr.unary('++', y), '*', z)), 'x+ ++y*z', '+', '*', '++'],
        [Expr.binary(x, '-', Expr.binary(Expr.unary('-', y), '*', z)), 'x- -y*z', '-', '*', '-'],
        [Expr.binary(x, '-', Expr.binary(Expr.intLiteral(-1), '*', z)), 'x- -1*z', '-', '*', '-'],
        [Expr.binary(x, '&', Expr.binary(Expr.unary('&', y), '+', z)), 'x& &y+z', '&', '+', '&'],
        [Expr.binary(x, '/', Expr.binary(Expr.unary('*', p), '.*', m)), 'x/ *p.*m', '/', '.*', '*'],
        [Expr.binary(x, '+', Expr.paren(plusProduct)), 'x+ +y*z', '+', '*', '+'],
      ] as const;

      for (const [expression, expected, outerOp, innerOp, unaryOp] of cases) {
        const emitted = emit(expression, { spaceAroundOperators: false });
        assert.strictEqual(emitted, expected);
        const fn = parse(`int f(int x, int y, int z, int p, int m) { return ${emitted}; }`)
          .declarations[0] as FunctionDecl;
        const outer = (fn.body!.statements[0] as ReturnStmt).value as BinaryExpr;
        assert.strictEqual(outer.kind, NodeKind.BinaryExpr);
        assert.strictEqual(outer.operator, outerOp);
        const inner = outer.right as BinaryExpr;
        assert.strictEqual(inner.kind, NodeKind.BinaryExpr);
        assert.strictEqual(inner.operator, innerOp);
        assert.strictEqual(inner.left.kind, NodeKind.UnaryExpr);
        assert.strictEqual((inner.left as UnaryExpr).operator, unaryOp);
      }

      const sameAssociative = Expr.binary(x, '+', Expr.binary(Expr.unary('+', y), '+', z));
      const sameAssociativeOutput = emit(sameAssociative, { spaceAroundOperators: false });
      assert.ok(!sameAssociativeOutput.startsWith('x++'), sameAssociativeOutput);
      parse(`int f(int x, int y, int z) { return ${sameAssociativeOutput}; }`);

      const grouped = Expr.binary(x, '+', Expr.binary(Expr.unary('+', y), '-', z));
      assert.strictEqual(emit(grouped, { spaceAroundOperators: false }), 'x+(+y-z)');
    });

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
    function emittedPrefixOperandKind(source: string): { emitted: string; kind: NodeKind } {
      const emitted = emit(parse(source));
      const fn = parse(emitted).declarations[0] as FunctionDecl;
      const expression = (fn.body!.statements[0] as ExprStmt).expression;
      assert.strictEqual(expression.kind, NodeKind.UnaryExpr);
      let operand = (expression as UnaryExpr).operand;
      while (operand.kind === NodeKind.ParenExpr) operand = (operand as ParenExpr).expression;
      return { emitted, kind: operand.kind };
    }

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
      assert.strictEqual(emit(Expr.unary('++', Expr.deref(Expr.identifier('p')))), '++*p');
    });

    it('preserves a conditional lvalue as the target of prefix increment/decrement', () => {
      // With flag=0, a=5, b=10, ++(flag ? a : b) changes b to 11;
      // the flattened ++flag ? a : b changes flag instead.
      for (const op of ['++', '--'] as const) {
        const source = `int f(int flag, int a, int b) { ${op}(flag ? a : b); return a + b; }`;
        const { emitted, kind } = emittedPrefixOperandKind(source);
        assert.ok(emitted.includes(`${op}(flag ? a : b);`), emitted);
        assert.strictEqual(kind, NodeKind.ConditionalExpr);
        assert.strictEqual(
          emit(Expr.unary(op, Expr.conditional(Expr.identifier('flag'), Expr.identifier('a'), Expr.identifier('b')))),
          `${op}(flag ? a : b)`,
        );
      }
    });

    it('preserves an assignment lvalue as the target of prefix increment/decrement', () => {
      for (const op of ['++', '--'] as const) {
        const source = `int f(int a, int b) { ${op}(a = b); return a; }`;
        const { emitted, kind } = emittedPrefixOperandKind(source);
        assert.ok(emitted.includes(`${op}(a = b);`), emitted);
        assert.strictEqual(kind, NodeKind.AssignExpr);
        assert.strictEqual(
          emit(Expr.unary(op, Expr.assign(Expr.identifier('a'), Expr.identifier('b')))),
          `${op}(a = b)`,
        );
      }
    });

    it('keeps adjacent prefix operators as separate tokens through parse and emit', () => {
      const cases = [
        ['-(-x)', '- -x', '-', '-'],
        ['+(+x)', '+ +x', '+', '+'],
        ['&(&x)', '& &x', '&', '&'],
        ['+(++x)', '+ ++x', '+', '++'],
        ['-(--x)', '- --x', '-', '--'],
        ['-(-(+x))', '- -+x', '-', '-'],
        ['-+x', '-+x', '-', '+'],
        ['+-x', '+-x', '+', '-'],
        ['!(!x)', '!!x', '!', '!'],
        ['~(~x)', '~~x', '~', '~'],
        ['*(*x)', '**x', '*', '*'],
        ['++(+x)', '+++x', '++', '+'],
        ['--(-x)', '---x', '--', '-'],
      ] as const;
      const withoutParens = (value: Expression): Expression => {
        while (value.kind === NodeKind.ParenExpr) value = (value as ParenExpr).expression;
        return value;
      };

      for (const [source, expected, outerOp, innerOp] of cases) {
        const emitted = emit(parse(`int f(int x) { return ${source}; }`));
        assert.ok(emitted.includes(`return ${expected};`), emitted);
        const fn = parse(emitted).declarations[0] as FunctionDecl;
        const outer = withoutParens((fn.body!.statements[0] as ReturnStmt).value!);
        assert.strictEqual(outer.kind, NodeKind.UnaryExpr, emitted);
        assert.strictEqual((outer as UnaryExpr).operator, outerOp, emitted);
        const inner = withoutParens((outer as UnaryExpr).operand);
        assert.strictEqual(inner.kind, NodeKind.UnaryExpr, emitted);
        assert.strictEqual((inner as UnaryExpr).operator, innerOp, emitted);
      }
    });

    it('separates unary minus from a negative factory literal', () => {
      const cases = [
        [Expr.intLiteral(-1), '- -1'],
        [Expr.intLiteral(-1, 16), '- -0x1'],
        [Expr.intLiteral(-1, 2), '- -0b1'],
        [Expr.intLiteral(-1, 8), '- -01'],
        [Expr.floatLiteral(-1.5), '- -1.5'],
      ] as const;

      for (const [operand, expected] of cases) {
        const emitted = emit(Expr.unary('-', operand));
        assert.strictEqual(emitted, expected);
        const fn = parse(`double f() { return ${emitted}; }`).declarations[0] as FunctionDecl;
        const outer = (fn.body!.statements[0] as ReturnStmt).value!;
        assert.strictEqual(outer.kind, NodeKind.UnaryExpr, emitted);
        assert.strictEqual((outer as UnaryExpr).operator, '-', emitted);
        const inner = (outer as UnaryExpr).operand;
        assert.strictEqual(inner.kind, NodeKind.UnaryExpr, emitted);
        assert.strictEqual((inner as UnaryExpr).operator, '-', emitted);
      }
      assert.strictEqual(emit(Expr.unary('-', Expr.intLiteral(1))), '-1');
      assert.strictEqual(emit(Expr.unary('+', Expr.intLiteral(-1))), '+-1');
    });

    it('emits postfix increment/decrement', () => {
      const i = Expr.identifier('i');

      assert.strictEqual(emit(Expr.postfix(i, '++')), 'i++');
      assert.strictEqual(emit(Expr.postfix(i, '--')), 'i--');
    });

    it('parenthesizes a deref operand of postfix ++/--', () => {
      // (*(short *)p)++  — not  *(short *)p++  (which increments the cast/rvalue
      // → "lvalue required as increment operand").
      const deref = Expr.unary('*', Expr.cast(Type.pointer(Type.builtin('short')), Expr.identifier('p')));
      assert.strictEqual(emit(Expr.postfix(deref, '++')), '(*(short*)p)++');
      assert.strictEqual(emit(Expr.postfix(deref, '--')), '(*(short*)p)--');
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

    it('preserves a nested conditional in the condition across parse and emit', () => {
      const leftNested = 'int f(bool a, bool b, bool c, int d, int e) { return (a ? b : c) ? d : e; }';
      const rightNested = 'int f(bool a, bool b, bool c, int d, int e) { return a ? b : c ? d : e; }';

      const emittedLeft = emit(parse(leftNested));
      const emittedRight = emit(parse(rightNested));
      assert.match(emittedLeft, /return \(a \? b : c\) \? d : e;/);
      assert.match(emittedRight, /return a \? b : c \? d : e;/);
      assert.notStrictEqual(emittedLeft, emittedRight);

      const outer = (source: string): ConditionalExpr => {
        const fn = parse(source).declarations[0] as FunctionDecl;
        const ret = fn.body?.statements[0] as ReturnStmt;
        assert.strictEqual(ret.value?.kind, NodeKind.ConditionalExpr);
        return ret.value as ConditionalExpr;
      };
      const leftCondition = outer(emittedLeft).condition as ParenExpr;
      assert.strictEqual(leftCondition.kind, NodeKind.ParenExpr);
      assert.strictEqual(leftCondition.expression.kind, NodeKind.ConditionalExpr);
      const right = outer(emittedRight);
      assert.strictEqual(right.condition.kind, NodeKind.Identifier);
      assert.strictEqual(right.elseExpr.kind, NodeKind.ConditionalExpr);
    });

    it('retains the grouping that changes a concrete conditional result', () => {
      // (true ? false : true) ? 7 : 9 evaluates to 9; without the
      // condition parentheses, true ? false : true ? 7 : 9 evaluates to 0.
      const source = 'int f() { return (true ? false : true) ? 7 : 9; }';
      const emitted = emit(parse(source));
      assert.match(emitted, /return \(true \? false : true\) \? 7 : 9;/);
      const fn = parse(emitted).declarations[0] as FunctionDecl;
      const ret = fn.body?.statements[0] as ReturnStmt;
      const outer = ret.value as ConditionalExpr;
      assert.strictEqual((outer.condition as ParenExpr).expression.kind, NodeKind.ConditionalExpr);
    });

    it('parenthesizes lower-precedence conditions but leaves logical-or conditions bare', () => {
      const a = Expr.identifier('a');
      const b = Expr.identifier('b');
      const c = Expr.identifier('c');
      const d = Expr.identifier('d');
      const e = Expr.identifier('e');
      assert.strictEqual(emit(Expr.conditional(Expr.conditional(a, b, c), d, e)), '(a ? b : c) ? d : e');
      assert.strictEqual(emit(Expr.conditional(Expr.assign(a, b), d, e)), '(a = b) ? d : e');
      assert.strictEqual(emit(Expr.conditional(Expr.or(a, b), d, e)), 'a || b ? d : e');
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

      function reparseOuterIf(stmt: IfStmt): { emitted: string; outer: IfStmt } {
        const emitted = emit(stmt, createStyle({ alwaysUseBraces: false }));
        const reparsed = parse(`void f(bool a, bool b, bool c) { ${emitted} }`);
        const outer = (reparsed.declarations[0] as FunctionDecl).body!.statements[0] as IfStmt;
        return { emitted, outer };
      }

      it('keeps an outer else from attaching to an unbraced inner if', () => {
        const stmt = Stmt.if_(Expr.identifier('a'),
          Stmt.if_(Expr.identifier('b'), Stmt.expr(Expr.call('F', []))),
          Stmt.expr(Expr.call('G', [])));
        const { emitted, outer } = reparseOuterIf(stmt);
        assert.match(emitted, /if \(a\) \{/);
        assert.strictEqual(outer.elseBranch?.kind, NodeKind.ExprStmt);
        const inner = (outer.thenBranch as CompoundStmt).statements[0] as IfStmt;
        assert.strictEqual(inner.elseBranch, null);
      });

      it('keeps the outer else through a nested else-if tail', () => {
        const stmt = Stmt.if_(Expr.identifier('a'),
          Stmt.if_(Expr.identifier('b'), Stmt.expr(Expr.call('F', [])),
            Stmt.if_(Expr.identifier('c'), Stmt.expr(Expr.call('G', [])))),
          Stmt.expr(Expr.call('H', [])));
        const { emitted, outer } = reparseOuterIf(stmt);
        assert.match(emitted, /if \(a\) \{/);
        assert.match(emitted, /else if \(c\)/);
        assert.strictEqual(outer.elseBranch?.kind, NodeKind.ExprStmt);
        const inner = (outer.thenBranch as CompoundStmt).statements[0] as IfStmt;
        assert.strictEqual((inner.elseBranch as IfStmt).elseBranch, null);
      });

      it('keeps the outer else through unbraced loop and label bodies', () => {
        const innerIf = () => Stmt.if_(Expr.identifier('b'), Stmt.expr(Expr.call('F', [])));
        const wrapped: Statement[] = [
          Stmt.while_(Expr.identifier('c'), innerIf()),
          Stmt.for_(null, Expr.identifier('c'), null, innerIf()),
          Stmt.label('L', innerIf()),
        ];
        for (const thenBranch of wrapped) {
          const { emitted, outer } = reparseOuterIf(Stmt.if_(Expr.identifier('a'), thenBranch,
            Stmt.expr(Expr.call('G', []))));
          assert.match(emitted, /if \(a\) \{/);
          assert.strictEqual(outer.elseBranch?.kind, NodeKind.ExprStmt, emitted);
        }
      });

      it('keeps the outer else through an unbraced switch case or default', () => {
        for (const switchBody of [
          'switch (c) case 1: if (b) F();',
          'switch (c) default: if (b) F();',
        ]) {
          const source = parse(`void source(bool b, int c) { ${switchBody} }`);
          const thenBranch = (source.declarations[0] as FunctionDecl).body!.statements[0];
          const { emitted, outer } = reparseOuterIf(Stmt.if_(Expr.identifier('a'), thenBranch,
            Stmt.expr(Expr.call('G', []))));
          assert.match(emitted, /if \(a\) \{/);
          assert.strictEqual(outer.elseBranch?.kind, NodeKind.ExprStmt, emitted);
        }
      });

      it('leaves matched inner ifs and outer else-if chains unbraced', () => {
        const matched = Stmt.if_(Expr.identifier('a'),
          Stmt.if_(Expr.identifier('b'), Stmt.expr(Expr.call('F', [])), Stmt.expr(Expr.call('G', []))),
          Stmt.expr(Expr.call('H', [])));
        const first = reparseOuterIf(matched);
        assert.doesNotMatch(first.emitted, /if \(a\) \{/);
        assert.strictEqual(first.outer.elseBranch?.kind, NodeKind.ExprStmt);
        assert.strictEqual((first.outer.thenBranch as IfStmt).elseBranch?.kind, NodeKind.ExprStmt);

        const elseIf = Stmt.if_(Expr.identifier('a'), Stmt.expr(Expr.call('F', [])),
          Stmt.if_(Expr.identifier('b'), Stmt.expr(Expr.call('G', [])), Stmt.expr(Expr.call('H', []))));
        const second = reparseOuterIf(elseIf);
        assert.match(second.emitted, /else if \(b\)/);
        assert.strictEqual(second.outer.elseBranch?.kind, NodeKind.IfStmt);
      });

      it('does not brace a do-while body whose closing while protects the outer else', () => {
        const stmt = Stmt.if_(Expr.identifier('a'),
          Stmt.doWhile(Stmt.if_(Expr.identifier('b'), Stmt.expr(Expr.call('F', []))), Expr.identifier('c')),
          Stmt.expr(Expr.call('G', [])));
        const { emitted, outer } = reparseOuterIf(stmt);
        assert.doesNotMatch(emitted, /if \(a\) \{/);
        assert.strictEqual(outer.elseBranch?.kind, NodeKind.ExprStmt);
      });

      it('braces a preprocessor-selected then body before its outer else', () => {
        const ppBody = {
          kind: NodeKind.PpConditionalStmt,
          condition: 'defined(USE_NATIVE)',
          thenStatements: [Stmt.if_(Expr.identifier('b'), Stmt.expr(Expr.call('F', [])))],
          elseStatements: [Stmt.expr(Expr.call('H', []))],
          leadingTrivia: [],
          trailingTrivia: [],
        } as PpConditionalStmt;
        const emitted = emit(Stmt.if_(Expr.identifier('a'), ppBody,
          Stmt.expr(Expr.call('G', []))), createStyle({ alwaysUseBraces: false }));
        assert.match(emitted, /if \(a\) \{/);
        assert.match(emitted, /#endif\s*\} else\s+G\(\);/);
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

  describe('Pointer-to-array types', () => {
    const round = (s: string) => emit(parse(s)).replace(/\s+/g, ' ').trim();

    it('flattens a pointer-to-array PARAMETER to a plain pointer (type[N]* -> type *)', () => {
      assert.strictEqual(round('void f(D2UnitStrc[3]* p) { }'), 'void f(D2UnitStrc * p) {}');
    });

    it('keeps the extent in a pointer-to-array CAST', () => {
      // `elem (*)[N]` is a well-formed abstract declarator, and the extent is
      // real: `LVLTBLS_GetLvlTypeFilename` declares `char (*pFileSlot)[60]` and
      // assigns `(char (*)[60])(*pFileSlot + 1)` to it. Flattening the cast to
      // `char *` made it disagree with the very declarator it feeds.
      assert.ok(round('void f(void* x) { p = (int[5]*)x; }').includes('(int (*)[5])x'));
    });

    it('still flattens a pointer-to-array cast with no extent', () => {
      // `int (*)[]` is not a complete type in a cast; the flat pointer is.
      assert.ok(round('void f(void* x) { p = (int[]*)x; }').includes('(int *)x'));
    });

    it('keeps a NAMED local as a faithful pointer-to-array declarator', () => {
      assert.strictEqual(round('void f() { undefined1[16]* puVar1; }'), 'void f() { undefined1 (*puVar1)[16]; }');
    });

    it('never touches a subscript-multiply expression', () => {
      assert.ok(round('void f(int* a) { return a[2] * 6; }').includes('a[2] * 6'));
    });
  });
});
