import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AST, Type, Expr, Stmt, Decl, Attr } from '../factory.js';
import { NodeKind } from '../kinds.js';
import type { Identifier } from '../nodes.js';

describe('AST Factory', () => {
  describe('Type factory', () => {
    it('creates builtin types', () => {
      const intType = Type.int();
      assert.strictEqual(intType.kind, NodeKind.BuiltinType);
      assert.strictEqual(intType.name, 'int');
      assert.deepStrictEqual(intType.modifiers, []);
    });

    it('creates builtin types with modifiers', () => {
      const unsignedLong = Type.int(['unsigned', 'long']);
      assert.deepStrictEqual(unsignedLong.modifiers, ['unsigned', 'long']);
    });

    it('creates pointer types', () => {
      const intPtr = Type.pointer(Type.int());
      assert.strictEqual(intPtr.kind, NodeKind.PointerType);
      assert.strictEqual(intPtr.pointee.kind, NodeKind.BuiltinType);
    });

    it('creates const pointer types', () => {
      const constIntPtr = Type.pointer(Type.int(), ['const']);
      assert.deepStrictEqual(constIntPtr.qualifiers, ['const']);
    });

    it('creates reference types', () => {
      const intRef = Type.reference(Type.int());
      assert.strictEqual(intRef.kind, NodeKind.ReferenceType);
    });

    it('creates array types', () => {
      const intArray = Type.array(Type.int(), Expr.intLiteral(10));
      assert.strictEqual(intArray.kind, NodeKind.ArrayType);
      assert.notStrictEqual(intArray.size, null);
    });

    it('creates const qualified types', () => {
      const constInt = Type.const(Type.int());
      assert.strictEqual(constInt.kind, NodeKind.QualifiedType);
      assert.deepStrictEqual(constInt.qualifiers, ['const']);
    });

    it('creates template types', () => {
      const vectorInt = Type.template(
        Expr.qualifiedId(['std', 'vector']),
        [Type.int()]
      );
      assert.strictEqual(vectorInt.kind, NodeKind.TemplateType);
      assert.strictEqual(vectorInt.arguments.length, 1);
    });

    it('creates auto type', () => {
      const auto = Type.auto();
      assert.strictEqual(auto.kind, NodeKind.AutoType);
      assert.strictEqual(auto.isDecltypeAuto, false);
    });
  });

  describe('Expression factory', () => {
    it('creates identifiers', () => {
      const id = Expr.identifier('foo');
      assert.strictEqual(id.kind, NodeKind.Identifier);
      assert.strictEqual(id.name, 'foo');
    });

    it('creates qualified identifiers', () => {
      const qid = Expr.qualifiedId(['std', 'vector', 'iterator']);
      assert.strictEqual(qid.kind, NodeKind.QualifiedId);
      assert.strictEqual(qid.qualifier.length, 2);
      assert.strictEqual((qid.name as Identifier).name, 'iterator');
    });

    it('creates global qualified identifiers', () => {
      const global = Expr.qualifiedId(['Global'], true);
      assert.strictEqual(global.isGlobal, true);
    });

    it('creates integer literals', () => {
      const lit = Expr.intLiteral(42);
      assert.strictEqual(lit.kind, NodeKind.IntegerLiteral);
      assert.strictEqual(lit.value, 42n);
      assert.strictEqual(lit.base, 10);
    });

    it('creates hex integer literals', () => {
      const hex = Expr.intLiteral(255, 16);
      assert.strictEqual(hex.base, 16);
      assert.strictEqual(hex.raw, '0xff');
    });

    it('creates float literals', () => {
      const f = Expr.floatLiteral(3.14);
      assert.strictEqual(f.kind, NodeKind.FloatingLiteral);
      assert.strictEqual(f.value, 3.14);
    });

    it('creates string literals', () => {
      const str = Expr.stringLiteral('hello');
      assert.strictEqual(str.kind, NodeKind.StringLiteral);
      assert.strictEqual(str.value, 'hello');
    });

    it('creates char literals', () => {
      const ch = Expr.charLiteral('A');
      assert.strictEqual(ch.kind, NodeKind.CharLiteral);
      assert.strictEqual(ch.value, 65);
    });

    it('creates bool literals', () => {
      assert.strictEqual(Expr.boolLiteral(true).value, true);
      assert.strictEqual(Expr.boolLiteral(false).value, false);
    });

    it('creates nullptr literal', () => {
      const np = Expr.nullptr();
      assert.strictEqual(np.kind, NodeKind.NullptrLiteral);
    });

    it('creates this expression', () => {
      const thisExpr = Expr.this();
      assert.strictEqual(thisExpr.kind, NodeKind.ThisExpr);
    });

    it('creates binary expressions', () => {
      const add = Expr.binary(
        Expr.identifier('a'),
        '+',
        Expr.identifier('b')
      );
      assert.strictEqual(add.kind, NodeKind.BinaryExpr);
      assert.strictEqual(add.operator, '+');
    });

    it('creates convenience binary expressions', () => {
      const a = Expr.identifier('a');
      const b = Expr.identifier('b');

      assert.strictEqual(Expr.add(a, b).operator, '+');
      assert.strictEqual(Expr.sub(a, b).operator, '-');
      assert.strictEqual(Expr.mul(a, b).operator, '*');
      assert.strictEqual(Expr.div(a, b).operator, '/');
      assert.strictEqual(Expr.eq(a, b).operator, '==');
      assert.strictEqual(Expr.ne(a, b).operator, '!=');
      assert.strictEqual(Expr.lt(a, b).operator, '<');
      assert.strictEqual(Expr.gt(a, b).operator, '>');
      assert.strictEqual(Expr.and(a, b).operator, '&&');
      assert.strictEqual(Expr.or(a, b).operator, '||');
    });

    it('creates unary expressions', () => {
      const neg = Expr.unary('-', Expr.identifier('x'));
      assert.strictEqual(neg.kind, NodeKind.UnaryExpr);
      assert.strictEqual(neg.operator, '-');
    });

    it('creates convenience unary expressions', () => {
      const x = Expr.identifier('x');
      assert.strictEqual(Expr.not(x).operator, '!');
      assert.strictEqual(Expr.neg(x).operator, '-');
      assert.strictEqual(Expr.deref(x).operator, '*');
      assert.strictEqual(Expr.addressOf(x).operator, '&');
    });

    it('creates postfix expressions', () => {
      const inc = Expr.postfix(Expr.identifier('i'), '++');
      assert.strictEqual(inc.kind, NodeKind.PostfixExpr);
      assert.strictEqual(inc.operator, '++');
    });

    it('creates call expressions', () => {
      const call = Expr.call('printf', [Expr.stringLiteral('hello')]);
      assert.strictEqual(call.kind, NodeKind.CallExpr);
      assert.strictEqual(call.arguments.length, 1);
    });

    it('creates member expressions', () => {
      const dot = Expr.member(Expr.identifier('obj'), 'field');
      assert.strictEqual(dot.kind, NodeKind.MemberExpr);
      assert.strictEqual(dot.isArrow, false);

      const arrow = Expr.member(Expr.identifier('ptr'), 'field', true);
      assert.strictEqual(arrow.isArrow, true);
    });

    it('creates subscript expressions', () => {
      const sub = Expr.subscript(Expr.identifier('arr'), Expr.intLiteral(0));
      assert.strictEqual(sub.kind, NodeKind.SubscriptExpr);
    });

    it('creates assignment expressions', () => {
      const assign = Expr.assign(Expr.identifier('x'), Expr.intLiteral(10));
      assert.strictEqual(assign.kind, NodeKind.AssignExpr);
      assert.strictEqual(assign.operator, '=');
    });

    it('creates conditional expressions', () => {
      const cond = Expr.conditional(
        Expr.identifier('flag'),
        Expr.intLiteral(1),
        Expr.intLiteral(0)
      );
      assert.strictEqual(cond.kind, NodeKind.ConditionalExpr);
    });

    it('creates cast expressions', () => {
      const cast = Expr.cast(Type.int(), Expr.identifier('x'));
      assert.strictEqual(cast.kind, NodeKind.CStyleCastExpr);
    });

    it('creates sizeof expressions', () => {
      const sizeofExpr = Expr.sizeof(Expr.identifier('x'));
      assert.strictEqual(sizeofExpr.kind, NodeKind.SizeofExpr);
      assert.strictEqual(sizeofExpr.isType, false);

      const sizeofType = Expr.sizeof(Type.int(), true);
      assert.strictEqual(sizeofType.isType, true);
    });

    it('creates new expressions', () => {
      const newExpr = Expr.new_(Type.int());
      assert.strictEqual(newExpr.kind, NodeKind.NewExpr);
      assert.strictEqual(newExpr.isArray, false);
    });

    it('creates delete expressions', () => {
      const deleteExpr = Expr.delete_(Expr.identifier('ptr'));
      assert.strictEqual(deleteExpr.kind, NodeKind.DeleteExpr);
      assert.strictEqual(deleteExpr.isArray, false);
    });

    it('creates init list expressions', () => {
      const init = Expr.initList([
        Expr.intLiteral(1),
        Expr.intLiteral(2),
        Expr.intLiteral(3),
      ]);
      assert.strictEqual(init.kind, NodeKind.InitListExpr);
      assert.strictEqual(init.elements.length, 3);
    });

    it('creates parenthesized expressions', () => {
      const paren = Expr.paren(Expr.add(Expr.identifier('a'), Expr.identifier('b')));
      assert.strictEqual(paren.kind, NodeKind.ParenExpr);
    });
  });

  describe('Statement factory', () => {
    it('creates compound statements', () => {
      const block = Stmt.compound([
        Stmt.return_(Expr.intLiteral(0)),
      ]);
      assert.strictEqual(block.kind, NodeKind.CompoundStmt);
      assert.strictEqual(block.statements.length, 1);
    });

    it('creates expression statements', () => {
      const exprStmt = Stmt.expr(Expr.call('printf', []));
      assert.strictEqual(exprStmt.kind, NodeKind.ExprStmt);
    });

    it('creates if statements', () => {
      const ifStmt = Stmt.if_(
        Expr.identifier('cond'),
        Stmt.return_(Expr.intLiteral(1)),
        Stmt.return_(Expr.intLiteral(0))
      );
      assert.strictEqual(ifStmt.kind, NodeKind.IfStmt);
      assert.notStrictEqual(ifStmt.elseBranch, null);
    });

    it('creates for statements', () => {
      const forStmt = Stmt.for_(
        null,
        Expr.lt(Expr.identifier('i'), Expr.intLiteral(10)),
        Expr.postfix(Expr.identifier('i'), '++'),
        Stmt.compound([])
      );
      assert.strictEqual(forStmt.kind, NodeKind.ForStmt);
    });

    it('creates while statements', () => {
      const whileStmt = Stmt.while_(
        Expr.boolLiteral(true),
        Stmt.break_()
      );
      assert.strictEqual(whileStmt.kind, NodeKind.WhileStmt);
    });

    it('creates do-while statements', () => {
      const doWhile = Stmt.doWhile(
        Stmt.compound([]),
        Expr.boolLiteral(false)
      );
      assert.strictEqual(doWhile.kind, NodeKind.DoWhileStmt);
    });

    it('creates return statements', () => {
      const ret = Stmt.return_(Expr.intLiteral(42));
      assert.strictEqual(ret.kind, NodeKind.ReturnStmt);
      assert.notStrictEqual(ret.value, null);

      const retVoid = Stmt.return_();
      assert.strictEqual(retVoid.value, null);
    });

    it('creates break and continue statements', () => {
      assert.strictEqual(Stmt.break_().kind, NodeKind.BreakStmt);
      assert.strictEqual(Stmt.continue_().kind, NodeKind.ContinueStmt);
    });

    it('creates null statements', () => {
      assert.strictEqual(Stmt.null_().kind, NodeKind.NullStmt);
    });
  });

  describe('Declaration factory', () => {
    it('creates translation units', () => {
      const tu = Decl.translationUnit([]);
      assert.strictEqual(tu.kind, NodeKind.TranslationUnit);
      assert.strictEqual(tu.declarations.length, 0);
    });

    it('creates function declarations', () => {
      const fn = Decl.function_(
        'main',
        Type.int(),
        [],
        Stmt.compound([Stmt.return_(Expr.intLiteral(0))])
      );
      assert.strictEqual(fn.kind, NodeKind.FunctionDecl);
      assert.strictEqual((fn.name as Identifier).name, 'main');
    });

    it('creates function declarations with specifiers', () => {
      const fn = Decl.function_(
        'helper',
        Type.void(),
        [],
        null,
        ['static', 'inline']
      );
      assert.deepStrictEqual(fn.specifiers, ['static', 'inline']);
    });

    it('creates parameter declarations', () => {
      const param = Decl.parameter('x', Type.int());
      assert.strictEqual(param.kind, NodeKind.ParameterDecl);
      assert.strictEqual(param.name?.name, 'x');
    });

    it('creates unnamed parameters', () => {
      const param = Decl.parameter(null, Type.int());
      assert.strictEqual(param.name, null);
    });

    it('creates parameters with default values', () => {
      const param = Decl.parameter('x', Type.int(), Expr.intLiteral(0));
      assert.notStrictEqual(param.defaultValue, null);
    });

    it('creates variable declarations', () => {
      const varDecl = Decl.variable('count', Type.int(), Expr.intLiteral(0));
      assert.strictEqual(varDecl.kind, NodeKind.VariableDecl);
      assert.notStrictEqual(varDecl.initializer, null);
    });

    it('creates class declarations', () => {
      const cls = Decl.class_('MyClass', [
        Decl.field('value', Type.int()),
      ]);
      assert.strictEqual(cls.kind, NodeKind.ClassDecl);
      assert.strictEqual(cls.name?.name, 'MyClass');
      assert.strictEqual(cls.members.length, 1);
    });

    it('creates struct declarations', () => {
      const strct = Decl.struct_('Point', [
        Decl.field('x', Type.int()),
        Decl.field('y', Type.int()),
      ]);
      assert.strictEqual(strct.kind, NodeKind.StructDecl);
    });

    it('creates enum declarations', () => {
      const enm = Decl.enum_('Color', [
        Decl.enumerator('Red', Expr.intLiteral(0)),
        Decl.enumerator('Green', Expr.intLiteral(1)),
        Decl.enumerator('Blue', Expr.intLiteral(2)),
      ]);
      assert.strictEqual(enm.kind, NodeKind.EnumDecl);
      assert.strictEqual(enm.isScoped, false);
    });

    it('creates scoped enum declarations', () => {
      const enm = Decl.enum_('Status', [], true, Type.int());
      assert.strictEqual(enm.isScoped, true);
      assert.notStrictEqual(enm.underlyingType, null);
    });

    it('creates namespace declarations', () => {
      const ns = Decl.namespace_('MyNS', [
        Decl.function_('helper', Type.void(), [], null),
      ]);
      assert.strictEqual(ns.kind, NodeKind.NamespaceDecl);
      assert.strictEqual(ns.declarations.length, 1);
    });

    it('creates typedef declarations', () => {
      const td = Decl.typedef_('IntPtr', Type.pointer(Type.int()));
      assert.strictEqual(td.kind, NodeKind.TypedefDecl);
    });

    it('creates type alias declarations', () => {
      const ta = Decl.typeAlias('IntPtr', Type.pointer(Type.int()));
      assert.strictEqual(ta.kind, NodeKind.TypeAliasDecl);
    });
  });

  describe('Attribute factory', () => {
    it('creates simple attributes', () => {
      const attr = Attr.create('noreturn');
      assert.strictEqual(attr.kind, NodeKind.Attribute);
      assert.strictEqual(attr.name.name, 'noreturn');
    });

    it('creates namespaced attributes', () => {
      const attr = Attr.create('optimize', [], 'gnu');
      assert.strictEqual(attr.namespace?.name, 'gnu');
    });

    it('creates nodiscard attribute', () => {
      const attr = Attr.nodiscard();
      assert.strictEqual(attr.name.name, 'nodiscard');
    });

    it('creates nodiscard attribute with reason', () => {
      const attr = Attr.nodiscard('important value');
      assert.strictEqual(attr.arguments.length, 1);
    });

    it('creates deprecated attribute', () => {
      const attr = Attr.deprecated('use newFunction instead');
      assert.strictEqual(attr.name.name, 'deprecated');
    });

    it('creates common attributes', () => {
      assert.strictEqual(Attr.maybe_unused().name.name, 'maybe_unused');
      assert.strictEqual(Attr.noreturn().name.name, 'noreturn');
      assert.strictEqual(Attr.likely().name.name, 'likely');
      assert.strictEqual(Attr.unlikely().name.name, 'unlikely');
    });
  });

  describe('AST combined factory', () => {
    it('exports all sub-factories', () => {
      assert.strictEqual(AST.Type, Type);
      assert.strictEqual(AST.Expr, Expr);
      assert.strictEqual(AST.Stmt, Stmt);
      assert.strictEqual(AST.Decl, Decl);
      assert.strictEqual(AST.Attr, Attr);
    });
  });

  describe('Complex AST construction', () => {
    it('builds a complete function', () => {
      // int add(int a, int b) { return a + b; }
      const fn = Decl.function_(
        'add',
        Type.int(),
        [
          Decl.parameter('a', Type.int()),
          Decl.parameter('b', Type.int()),
        ],
        Stmt.compound([
          Stmt.return_(
            Expr.add(Expr.identifier('a'), Expr.identifier('b'))
          ),
        ])
      );

      assert.strictEqual((fn.name as Identifier).name, 'add');
      assert.strictEqual(fn.parameters.length, 2);
      assert.notStrictEqual(fn.body, null);
    });

    it('builds a class with methods', () => {
      // class Counter {
      //   int value;
      // };
      const cls = Decl.class_('Counter', [
        Decl.field('value', Type.int(), Expr.intLiteral(0)),
      ]);

      assert.strictEqual(cls.name?.name, 'Counter');
      assert.strictEqual(cls.members.length, 1);
    });

    it('builds nested namespaces', () => {
      // namespace outer { namespace inner { int x; } }
      const ns = Decl.namespace_('outer', [
        Decl.namespace_('inner', [
          Decl.variable('x', Type.int()),
        ]),
      ]);

      assert.strictEqual(ns.name?.name, 'outer');
      const inner = ns.declarations[0] as typeof ns;
      assert.strictEqual(inner.name?.name, 'inner');
    });
  });
});
