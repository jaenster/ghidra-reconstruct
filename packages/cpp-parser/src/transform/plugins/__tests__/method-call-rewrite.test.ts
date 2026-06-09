/**
 * Tests for Method Call Rewrite Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { methodCallRewritePlugin, type MethodCallRewriteOptions } from '../builtins/method-call-rewrite.js';

describe('methodCallRewritePlugin', () => {
  function transformCode(code: string, options: MethodCallRewriteOptions): string {
    const ast = parse(code);
    // Pass rootAST for Rule 5 pre-scanning
    const transformer = methodCallRewritePlugin.createTransformer({ ...options, rootAST: ast });
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  const baseMappings = {
    DRLG_Init: {
      className: 'D2DrlgStrc',
      methodName: 'Init',
      thisParam: 0,
      originalName: 'DRLG_Init',
    },
    DRLG_Alloc: {
      className: 'D2DrlgStrc',
      methodName: 'Alloc',
      thisParam: 0,
      originalName: 'DRLG_Alloc',
    },
    DRLG_Free: {
      className: 'D2DrlgStrc',
      methodName: 'Free',
      thisParam: 0,
      originalName: 'DRLG_Free',
    },
    OTHER_Func: {
      className: 'OtherClass',
      methodName: 'Func',
      thisParam: 0,
      originalName: 'OTHER_Func',
    },
  };

  describe('Rule 1: External call site rewriting', () => {
    it('should rewrite a flat call to a method call', () => {
      const input = `void foo() { DRLG_Init(pDrlg, nAct); }`;
      const output = transformCode(input, { methodMappings: baseMappings });
      assert.ok(output.includes('pDrlg->Init(nAct)'), `Expected pDrlg->Init(nAct) in: ${output}`);
    });

    it('should handle calls with no extra args', () => {
      const input = `void foo() { DRLG_Free(pDrlg); }`;
      const output = transformCode(input, { methodMappings: baseMappings });
      assert.ok(output.includes('pDrlg->Free()'), `Expected pDrlg->Free() in: ${output}`);
    });

    it('should handle calls with multiple args', () => {
      const input = `void foo() { DRLG_Alloc(pDrlg, x, y, z); }`;
      const output = transformCode(input, { methodMappings: baseMappings });
      assert.ok(output.includes('pDrlg->Alloc(x, y, z)'), `Expected pDrlg->Alloc(x, y, z) in: ${output}`);
    });

    it('should handle qualified names', () => {
      const input = `void foo() { D2::DRLG_Init(pDrlg, nAct); }`;
      const output = transformCode(input, { methodMappings: baseMappings });
      assert.ok(output.includes('pDrlg->Init(nAct)'), `Expected pDrlg->Init(nAct) in: ${output}`);
    });

    it('should convert address-of arg to dot call', () => {
      const input = `void foo() { DRLG_Init(&drlg, nAct); }`;
      const output = transformCode(input, { methodMappings: baseMappings });
      assert.ok(output.includes('drlg.Init(nAct)'), `Expected drlg.Init(nAct) in: ${output}`);
    });

    it('should not rewrite calls that are not in mappings', () => {
      const input = `void foo() { UnknownFunc(pDrlg, nAct); }`;
      const output = transformCode(input, { methodMappings: baseMappings });
      assert.ok(output.includes('UnknownFunc(pDrlg, nAct)'), `Expected unchanged call in: ${output}`);
    });

    it('should not rewrite if too few args for thisParam index', () => {
      const input = `void foo() { DRLG_Init(); }`;
      const output = transformCode(input, { methodMappings: baseMappings });
      assert.ok(output.includes('DRLG_Init()'), `Expected unchanged call in: ${output}`);
    });
  });

  describe('Rule 2: Body this-param rewriting', () => {
    it('should replace this-param name with "this" inside converted method', () => {
      const input = `void foo() { pDrlg->nAct = 5; }`;
      const output = transformCode(input, {
        methodMappings: baseMappings,
        currentFunction: { className: 'D2DrlgStrc', thisParamName: 'pDrlg' },
      });
      // Rule 2 renames pDrlg→this, Rule 5 then strips this->nAct→nAct
      assert.ok(output.includes('nAct = 5'), `Expected nAct = 5 in: ${output}`);
      assert.ok(!output.includes('pDrlg->nAct'), `Should not contain pDrlg->nAct in: ${output}`);
    });

    it('should replace standalone this-param references', () => {
      const input = `void foo() { doSomething(pDrlg); }`;
      const output = transformCode(input, {
        methodMappings: baseMappings,
        currentFunction: { className: 'D2DrlgStrc', thisParamName: 'pDrlg' },
      });
      assert.ok(output.includes('doSomething(this)'), `Expected doSomething(this) in: ${output}`);
    });

    it('should not replace other identifiers', () => {
      const input = `void foo() { nAct = 5; }`;
      const output = transformCode(input, {
        methodMappings: baseMappings,
        currentFunction: { className: 'D2DrlgStrc', thisParamName: 'pDrlg' },
      });
      assert.ok(output.includes('nAct = 5'), `Expected nAct unchanged in: ${output}`);
    });
  });

  describe('Rule 3: Same-class method call simplification', () => {
    it('should rewrite same-class call to this->Method()', () => {
      const input = `void foo() { DRLG_Alloc(pDrlg, x); }`;
      const output = transformCode(input, {
        methodMappings: baseMappings,
        currentFunction: { className: 'D2DrlgStrc', thisParamName: 'pDrlg' },
      });
      assert.ok(output.includes('this->Alloc(x)'), `Expected this->Alloc(x) in: ${output}`);
    });

    it('should NOT use this for different-class calls', () => {
      const input = `void foo() { OTHER_Func(pOther, x); }`;
      const output = transformCode(input, {
        methodMappings: baseMappings,
        currentFunction: { className: 'D2DrlgStrc', thisParamName: 'pDrlg' },
      });
      assert.ok(output.includes('pOther->Func(x)'), `Expected pOther->Func(x) in: ${output}`);
      assert.ok(!output.includes('this->Func'), `Should not use this for different class in: ${output}`);
    });
  });

  describe('No-op when empty', () => {
    it('should return identity when no mappings provided', () => {
      const input = `void foo() { DRLG_Init(pDrlg, nAct); }`;
      const output = transformCode(input, {});
      assert.ok(output.includes('DRLG_Init(pDrlg, nAct)'), `Expected unchanged in: ${output}`);
    });
  });

  describe('Rule 4: Null this-arg → static call', () => {
    it('should emit static call for nullptr this-arg', () => {
      const input = `void foo() { DRLG_Init(nullptr, nAct); }`;
      const output = transformCode(input, { methodMappings: baseMappings });
      assert.ok(output.includes('D2DrlgStrc::Init(nAct)'), `Expected D2DrlgStrc::Init(nAct) in: ${output}`);
    });

    it('should emit static call for NULL this-arg', () => {
      const input = `void foo() { DRLG_Init(NULL, nAct); }`;
      const output = transformCode(input, { methodMappings: baseMappings });
      assert.ok(output.includes('D2DrlgStrc::Init(nAct)'), `Expected D2DrlgStrc::Init(nAct) in: ${output}`);
    });

    it('should emit static call for 0 this-arg', () => {
      const input = `void foo() { DRLG_Init(0, nAct); }`;
      const output = transformCode(input, { methodMappings: baseMappings });
      assert.ok(output.includes('D2DrlgStrc::Init(nAct)'), `Expected D2DrlgStrc::Init(nAct) in: ${output}`);
    });

    it('should emit static call for cast-to-pointer null: (D2RoomExStrc*)0x0', () => {
      const input = `void foo() { DRLG_Init((D2DrlgStrc*)0x0, nAct); }`;
      const output = transformCode(input, { methodMappings: baseMappings });
      assert.ok(output.includes('D2DrlgStrc::Init(nAct)'), `Expected D2DrlgStrc::Init(nAct) in: ${output}`);
    });

    it('should emit static call for cast-to-pointer null with 0', () => {
      const input = `void foo() { DRLG_Init((D2DrlgStrc*)0, nAct); }`;
      const output = transformCode(input, { methodMappings: baseMappings });
      assert.ok(output.includes('D2DrlgStrc::Init(nAct)'), `Expected D2DrlgStrc::Init(nAct) in: ${output}`);
    });

    it('should still rewrite non-null this-args normally', () => {
      const input = `void foo() { DRLG_Init(pDrlg, nAct); }`;
      const output = transformCode(input, { methodMappings: baseMappings });
      assert.ok(output.includes('pDrlg->Init(nAct)'), `Expected pDrlg->Init(nAct) in: ${output}`);
    });
  });

  describe('thisParam index > 0', () => {
    it('should extract the correct arg when thisParam is not 0', () => {
      const mappings = {
        SomeFunc: {
          className: 'MyClass',
          methodName: 'DoThing',
          thisParam: 1,
          originalName: 'SomeFunc',
        },
      };
      const input = `void foo() { SomeFunc(flags, pObj, data); }`;
      const output = transformCode(input, { methodMappings: mappings });
      assert.ok(output.includes('pObj->DoThing(flags, data)'), `Expected pObj->DoThing(flags, data) in: ${output}`);
    });
  });

  describe('Rule 5: Strip unnecessary this->', () => {
    it('should strip this->member when no name collision', () => {
      const input = `void foo() { this->nAct = 5; }`;
      const output = transformCode(input, {
        currentFunction: { className: 'D2DrlgStrc', thisParamName: 'pDrlg' },
      });
      assert.ok(output.includes('nAct = 5'), `Expected nAct = 5 in: ${output}`);
      assert.ok(!output.includes('this->nAct'), `Should not contain this->nAct in: ${output}`);
    });

    it('should strip this->Method() call when no name collision', () => {
      const input = `void foo() { this->Init(x); }`;
      const output = transformCode(input, {
        currentFunction: { className: 'D2DrlgStrc', thisParamName: 'pDrlg' },
      });
      assert.ok(output.includes('Init(x)'), `Expected Init(x) in: ${output}`);
      assert.ok(!output.includes('this->Init'), `Should not contain this->Init in: ${output}`);
    });

    it('should NOT strip this->member when local variable shadows the name', () => {
      const input = `void foo() { int nAct = 0; this->nAct = 5; }`;
      const output = transformCode(input, {
        currentFunction: { className: 'D2DrlgStrc', thisParamName: 'pDrlg' },
      });
      assert.ok(output.includes('this->nAct = 5'), `Expected this->nAct preserved in: ${output}`);
    });

    it('should NOT strip this->member when parameter shadows the name', () => {
      const input = `void foo(int nAct) { this->nAct = nAct; }`;
      const output = transformCode(input, {
        currentFunction: { className: 'D2DrlgStrc', thisParamName: 'pDrlg' },
      });
      assert.ok(output.includes('this->nAct'), `Expected this->nAct preserved in: ${output}`);
    });

    it('should NOT strip when not inside a converted method', () => {
      const input = `void foo() { this->nAct = 5; }`;
      const output = transformCode(input, {});
      assert.ok(output.includes('this->nAct'), `Expected this->nAct preserved in: ${output}`);
    });

    it('should NOT strip this.member (dot access)', () => {
      const input = `void foo() { this.nAct = 5; }`;
      const output = transformCode(input, {
        currentFunction: { className: 'D2DrlgStrc', thisParamName: 'pDrlg' },
      });
      assert.ok(output.includes('this.nAct'), `Expected this.nAct preserved in: ${output}`);
    });

    it('should handle for-loop init variable shadowing', () => {
      const input = `void foo() { for (int i = 0; i < 10; i++) {} this->i = 5; }`;
      const output = transformCode(input, {
        currentFunction: { className: 'D2DrlgStrc', thisParamName: 'pDrlg' },
      });
      assert.ok(output.includes('this->i'), `Expected this->i preserved due to for-loop shadow in: ${output}`);
    });

    it('should strip multiple different this-> accesses', () => {
      const input = `void foo() { this->x = this->y + 1; }`;
      const output = transformCode(input, {
        currentFunction: { className: 'D2DrlgStrc', thisParamName: 'pDrlg' },
      });
      assert.ok(output.includes('x ='), `Expected x = in: ${output}`);
      assert.ok(output.includes('y + 1'), `Expected y + 1 in: ${output}`);
      assert.ok(!output.includes('this->'), `Should not contain any this-> in: ${output}`);
    });
  });
});
