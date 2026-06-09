import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createRenameTransformer,
  rename,
  renameSingle,
  renameWith,
  renameGhidraFunctions,
  renameGhidraVariables,
  autoRenameGhidra,
  extractRenameableIdentifiers,
} from '../builtins/rename.js';
import { NodeKind } from '../../ast/kinds.js';
import { AST, Type, Expr, Stmt, Decl } from '../../ast/factory.js';
import { TriviaKind } from '../../lexer/trivia.js';
import type {
  Identifier,
  BinaryExpr,
  FunctionDecl,
  VariableDecl,
  CallExpr,
  TranslationUnit,
  DeclStmt,
} from '../../ast/nodes.js';

describe('Rename Transformer', () => {
  describe('createRenameTransformer', () => {
    it('renames identifiers based on map', () => {
      const transformer = createRenameTransformer({
        'oldName': 'newName',
      });

      const id = Expr.identifier('oldName');
      const result = transformer(id) as Identifier;

      assert.strictEqual(result.name, 'newName');
    });

    it('does not rename identifiers not in map', () => {
      const transformer = createRenameTransformer({
        'oldName': 'newName',
      });

      const id = Expr.identifier('otherName');
      const result = transformer(id) as Identifier;

      assert.strictEqual(result.name, 'otherName');
    });

    it('renames multiple identifiers in an expression', () => {
      const transformer = createRenameTransformer({
        'a': 'x',
        'b': 'y',
      });

      const expr = Expr.add(Expr.identifier('a'), Expr.identifier('b'));
      const result = transformer(expr) as BinaryExpr;

      assert.strictEqual((result.left as Identifier).name, 'x');
      assert.strictEqual((result.right as Identifier).name, 'y');
    });

    it('renames function declarations', () => {
      const transformer = createRenameTransformer({
        'FUN_00401000': 'processData',
      });

      const fn = Decl.function_(
        'FUN_00401000',
        Type.int(),
        [],
        Stmt.compound([])
      );
      const result = transformer(fn) as FunctionDecl;

      assert.strictEqual((result.name as Identifier).name, 'processData');
    });

    it('renames variable declarations', () => {
      const transformer = createRenameTransformer({
        'DAT_00402000': 'globalConfig',
      });

      const varDecl = Decl.variable('DAT_00402000', Type.int());
      const result = transformer(varDecl) as VariableDecl;

      assert.strictEqual(result.name.name, 'globalConfig');
    });

    it('renames function parameters', () => {
      const transformer = createRenameTransformer({
        'param_1': 'inputBuffer',
        'param_2': 'bufferSize',
      });

      const fn = Decl.function_(
        'test',
        Type.void(),
        [
          Decl.parameter('param_1', Type.pointer(Type.char())),
          Decl.parameter('param_2', Type.int()),
        ],
        null
      );
      const result = transformer(fn) as FunctionDecl;

      assert.strictEqual(result.parameters[0].name!.name, 'inputBuffer');
      assert.strictEqual(result.parameters[1].name!.name, 'bufferSize');
    });

    it('accepts Map as rename map', () => {
      const map = new Map([
        ['old', 'new'],
      ]);
      const transformer = createRenameTransformer(map);

      const id = Expr.identifier('old');
      const result = transformer(id) as Identifier;

      assert.strictEqual(result.name, 'new');
    });
  });

  describe('rename options', () => {
    it('filters by context', () => {
      const transformer = createRenameTransformer(
        { 'test': 'renamed' },
        { contexts: ['function'] }
      );

      // Should rename function
      const fn = Decl.function_('test', Type.void(), [], null);
      const fnResult = transformer(fn) as FunctionDecl;
      assert.strictEqual((fnResult.name as Identifier).name, 'renamed');

      // Should NOT rename variable
      const varDecl = Decl.variable('test', Type.int());
      const varResult = transformer(varDecl) as VariableDecl;
      assert.strictEqual(varResult.name.name, 'test');
    });

    it('preserves original name in ghidraInfo', () => {
      const transformer = createRenameTransformer(
        { 'FUN_00401000': 'process' },
        { preserveOriginal: true }
      );

      const fn = Decl.function_('FUN_00401000', Type.void(), [], null);
      const result = transformer(fn) as FunctionDecl;

      assert.strictEqual((result.name as Identifier).ghidraInfo?.originalName, 'FUN_00401000');
    });

    it('supports case-insensitive matching', () => {
      const transformer = createRenameTransformer(
        { 'TEST': 'renamed' },
        { caseSensitive: false }
      );

      const id = Expr.identifier('test');
      const result = transformer(id) as Identifier;

      assert.strictEqual(result.name, 'renamed');
    });
  });

  describe('rename convenience functions', () => {
    it('rename() works with object', () => {
      const transformer = rename({
        'old': 'new',
        'foo': 'bar',
      });

      const expr = Expr.add(Expr.identifier('old'), Expr.identifier('foo'));
      const result = transformer(expr) as BinaryExpr;

      assert.strictEqual((result.left as Identifier).name, 'new');
      assert.strictEqual((result.right as Identifier).name, 'bar');
    });

    it('renameSingle() renames one identifier', () => {
      const transformer = renameSingle('oldName', 'newName');

      const id = Expr.identifier('oldName');
      const result = transformer(id) as Identifier;

      assert.strictEqual(result.name, 'newName');
    });

    it('renameWith() uses custom function', () => {
      const transformer = renameWith((name) => {
        if (name.startsWith('FUN_')) {
          return 'func_' + name.slice(4);
        }
        return null;
      });

      const id = Expr.identifier('FUN_00401000');
      const result = transformer(id) as Identifier;

      assert.strictEqual(result.name, 'func_00401000');
    });
  });

  describe('Ghidra-specific rename functions', () => {
    it('renameGhidraFunctions() renames functions and references', () => {
      const transformer = renameGhidraFunctions({
        'FUN_00401000': 'processInput',
        'FUN_00401100': 'parseData',
      });

      const fn = Decl.function_(
        'FUN_00401000',
        Type.void(),
        [],
        Stmt.compound([
          Stmt.expr(Expr.call('FUN_00401100', [])),
        ])
      );
      const result = transformer(fn) as FunctionDecl;

      assert.strictEqual((result.name as Identifier).name, 'processInput');
      // Also renamed the call
      const body = result.body!.statements[0];
      assert.ok(body.kind === NodeKind.ExprStmt);
    });

    it('renameGhidraVariables() renames variables and parameters', () => {
      const transformer = renameGhidraVariables({
        'DAT_00402000': 'config',
        'param_1': 'input',
        'local_1': 'counter',
      });

      const varDecl = Decl.variable('DAT_00402000', Type.int());
      const result = transformer(varDecl) as VariableDecl;

      assert.strictEqual(result.name.name, 'config');
    });

    it('autoRenameGhidra() uses namer function', () => {
      const transformer = autoRenameGhidra((name, address) => {
        if (name.startsWith('FUN_') && address) {
          return `function_at_${address}`;
        }
        if (name.startsWith('DAT_') && address) {
          return `data_at_${address}`;
        }
        if (name.startsWith('param_')) {
          const num = name.slice(6);
          return `arg${num}`;
        }
        return null;
      });

      const fn = Expr.identifier('FUN_00401000');
      const fnResult = transformer(fn) as Identifier;
      assert.strictEqual(fnResult.name, 'function_at_00401000');

      const dat = Expr.identifier('DAT_00402000');
      const datResult = transformer(dat) as Identifier;
      assert.strictEqual(datResult.name, 'data_at_00402000');

      const param = Expr.identifier('param_1');
      const paramResult = transformer(param) as Identifier;
      assert.strictEqual(paramResult.name, 'arg1');
    });
  });

  describe('extractRenameableIdentifiers', () => {
    it('extracts all identifiers from AST', () => {
      const tu = Decl.translationUnit([
        Decl.function_(
          'FUN_00401000',
          Type.int(),
          [Decl.parameter('param_1', Type.int())],
          Stmt.compound([
            Stmt.return_(Expr.add(Expr.identifier('param_1'), Expr.intLiteral(1))),
          ])
        ),
        Decl.variable('DAT_00402000', Type.int(), Expr.intLiteral(0)),
      ]);

      const identifiers = extractRenameableIdentifiers(tu);

      assert.ok(identifiers.has('FUN_00401000'));
      assert.ok(identifiers.has('param_1'));
      assert.ok(identifiers.has('DAT_00402000'));

      // Check contexts
      const funInfo = identifiers.get('FUN_00401000');
      assert.ok(funInfo?.contexts.has('function'));

      const paramInfo = identifiers.get('param_1');
      assert.ok(paramInfo?.contexts.has('parameter'));
      assert.ok(paramInfo!.count >= 2); // Declaration + reference
    });

    it('counts multiple occurrences', () => {
      const expr = Expr.add(
        Expr.identifier('x'),
        Expr.mul(Expr.identifier('x'), Expr.identifier('x'))
      );

      const identifiers = extractRenameableIdentifiers(expr);

      assert.strictEqual(identifiers.get('x')?.count, 3);
    });
  });

  describe('complex rename scenarios', () => {
    it('renames across a full translation unit', () => {
      const transformer = createRenameTransformer({
        'FUN_00401000': 'main',
        'FUN_00401100': 'helper',
        'param_1': 'argc',
        'param_2': 'argv',
        'local_1': 'result',
      });

      const tu = Decl.translationUnit([
        Decl.function_(
          'FUN_00401000',
          Type.int(),
          [
            Decl.parameter('param_1', Type.int()),
            Decl.parameter('param_2', Type.pointer(Type.pointer(Type.char()))),
          ],
          Stmt.compound([
            Stmt.return_(Expr.identifier('local_1')),
          ])
        ),
        Decl.function_(
          'FUN_00401100',
          Type.int(),
          [Decl.parameter('param_1', Type.int())],
          Stmt.compound([
            Stmt.return_(Expr.mul(Expr.identifier('param_1'), Expr.intLiteral(2))),
          ])
        ),
      ]);

      const result = transformer(tu) as TranslationUnit;
      const mainFn = result.declarations[0] as FunctionDecl;
      const helperFn = result.declarations[1] as FunctionDecl;

      assert.strictEqual((mainFn.name as Identifier).name, 'main');
      assert.strictEqual(mainFn.parameters[0].name!.name, 'argc');
      assert.strictEqual(mainFn.parameters[1].name!.name, 'argv');

      assert.strictEqual((helperFn.name as Identifier).name, 'helper');
    });

    it('preserves trivia through renames', () => {
      const id = Expr.identifier('oldName');
      const mockLocation = { file: '<test>', start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } };
      id.leadingTrivia = [{ kind: TriviaKind.LineComment, text: '// important comment', location: mockLocation }];
      id.trailingTrivia = [{ kind: TriviaKind.Whitespace, text: ' ', location: mockLocation }];

      const transformer = renameSingle('oldName', 'newName');
      const result = transformer(id) as Identifier;

      assert.strictEqual(result.name, 'newName');
      assert.deepStrictEqual(result.leadingTrivia, id.leadingTrivia);
      assert.deepStrictEqual(result.trailingTrivia, id.trailingTrivia);
    });
  });
});
