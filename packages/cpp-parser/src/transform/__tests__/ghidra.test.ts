import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isGhidraGeneratedName,
  extractAddressFromName,
  suggestBetterName,
  cleanGhidraNames,
  ghidraCleanup,
  ghidraQuickClean,
  ghidraFullClean,
} from '../builtins/ghidra.js';
import { parse } from '../../parser/parser.js';
import { emit } from '../../emit/emitter.js';
import type { FunctionDecl, Identifier, AnyNode } from '../../ast/nodes.js';

describe('Ghidra Transforms', () => {
  describe('isGhidraGeneratedName', () => {
    it('detects FUN_ names', () => {
      assert.ok(isGhidraGeneratedName('FUN_00401000'));
      assert.ok(isGhidraGeneratedName('FUN_12345678'));
      assert.ok(!isGhidraGeneratedName('FUN_'));
      assert.ok(!isGhidraGeneratedName('fun_00401000'));
    });

    it('detects DAT_ names', () => {
      assert.ok(isGhidraGeneratedName('DAT_00402000'));
      assert.ok(!isGhidraGeneratedName('DAT_'));
    });

    it('detects LAB_ names', () => {
      assert.ok(isGhidraGeneratedName('LAB_00403000'));
    });

    it('detects param_N names', () => {
      assert.ok(isGhidraGeneratedName('param_1'));
      assert.ok(isGhidraGeneratedName('param_10'));
      assert.ok(!isGhidraGeneratedName('param'));
      assert.ok(!isGhidraGeneratedName('param_'));
    });

    it('detects local_N names', () => {
      assert.ok(isGhidraGeneratedName('local_8'));
      assert.ok(isGhidraGeneratedName('local_10h'));
      assert.ok(isGhidraGeneratedName('local_c'));
    });

    it('detects xVar names', () => {
      assert.ok(isGhidraGeneratedName('uVar1'));
      assert.ok(isGhidraGeneratedName('iVar2'));
      assert.ok(isGhidraGeneratedName('lVar'));
      assert.ok(isGhidraGeneratedName('bVar3'));
    });

    it('detects pointer variant names', () => {
      assert.ok(isGhidraGeneratedName('puVar1'));
      assert.ok(isGhidraGeneratedName('piVar2'));
    });

    it('detects dunder names', () => {
      assert.ok(isGhidraGeneratedName('__return_storage_ptr__'));
      assert.ok(isGhidraGeneratedName('__thiscall__'));
    });

    it('does not flag regular names', () => {
      assert.ok(!isGhidraGeneratedName('main'));
      assert.ok(!isGhidraGeneratedName('printf'));
      assert.ok(!isGhidraGeneratedName('myFunction'));
      assert.ok(!isGhidraGeneratedName('counter'));
      assert.ok(!isGhidraGeneratedName('i'));
    });
  });

  describe('extractAddressFromName', () => {
    it('extracts address from FUN_ names', () => {
      assert.strictEqual(extractAddressFromName('FUN_00401000'), '0x00401000');
      assert.strictEqual(extractAddressFromName('FUN_12345678'), '0x12345678');
    });

    it('extracts address from DAT_ names', () => {
      assert.strictEqual(extractAddressFromName('DAT_00402000'), '0x00402000');
    });

    it('extracts address from LAB_ names', () => {
      assert.strictEqual(extractAddressFromName('LAB_00403000'), '0x00403000');
    });

    it('returns null for non-address names', () => {
      assert.strictEqual(extractAddressFromName('param_1'), null);
      assert.strictEqual(extractAddressFromName('local_8'), null);
      assert.strictEqual(extractAddressFromName('main'), null);
    });
  });

  describe('suggestBetterName', () => {
    it('returns null for names that should not be renamed', () => {
      // Ghidra address-bearing names
      assert.strictEqual(suggestBetterName('FUN_00401000'), null);
      assert.strictEqual(suggestBetterName('DAT_00402000'), null);
      assert.strictEqual(suggestBetterName('LAB_00403000'), null);
      // Ghidra parameter/local names — keep as-is (stack offsets are useful)
      assert.strictEqual(suggestBetterName('param_1'), null);
      assert.strictEqual(suggestBetterName('param_2'), null);
      assert.strictEqual(suggestBetterName('local_8'), null);
      assert.strictEqual(suggestBetterName('local_ch'), null);
      // Register/stack artifacts — keep as-is
      assert.strictEqual(suggestBetterName('in_stack_00000004'), null);
      assert.strictEqual(suggestBetterName('in_EAX'), null);
      assert.strictEqual(suggestBetterName('unaff_ESI'), null);
      assert.strictEqual(suggestBetterName('extraout_EAX'), null);
      // Regular names
      assert.strictEqual(suggestBetterName('main'), null);
      assert.strictEqual(suggestBetterName('counter'), null);
    });

    it('returns null for all Ghidra names (no renames)', () => {
      assert.strictEqual(suggestBetterName('uVar1'), null);
      assert.strictEqual(suggestBetterName('iVar2'), null);
      assert.strictEqual(suggestBetterName('bVar3'), null);
      assert.strictEqual(suggestBetterName('puVar1'), null);
    });

    it('detects in_/unaff_/extraout_ as Ghidra-generated', () => {
      assert.ok(isGhidraGeneratedName('in_stack_00000004'));
      assert.ok(isGhidraGeneratedName('in_stack_ffffffec'));
      assert.ok(isGhidraGeneratedName('in_EAX'));
      assert.ok(isGhidraGeneratedName('in_ECX'));
      assert.ok(isGhidraGeneratedName('unaff_ESI'));
      assert.ok(isGhidraGeneratedName('unaff_EBP'));
      assert.ok(isGhidraGeneratedName('extraout_EAX'));
      assert.ok(isGhidraGeneratedName('extraout_ECX_00'));
    });
  });

  describe('cleanGhidraNames transformer', () => {
    it('preserves all Ghidra names including xVar temporaries', () => {
      const code = 'void FUN_00401000(int param_1) { int local_8 = param_1; uint uVar1 = 0; }';
      const ast = parse(code);
      const transformed = cleanGhidraNames()(ast);
      const output = emit(transformed as AnyNode);

      // Everything preserved as-is
      assert.ok(output.includes('FUN_00401000'));
      assert.ok(output.includes('param_1'));
      assert.ok(output.includes('local_8'));
      assert.ok(output.includes('uVar1'));
    });

    it('preserves non-Ghidra names', () => {
      const code = 'void myFunc(int count) { int result = count; }';
      const ast = parse(code);
      const transformed = cleanGhidraNames()(ast);
      const output = emit(transformed as AnyNode);

      assert.ok(output.includes('myFunc'));
      assert.ok(output.includes('count'));
      assert.ok(output.includes('result'));
    });
  });

  describe('ghidraCleanup', () => {
    it('applies all default cleanups', () => {
      const code = 'void FUN_00401000(int param_1) { return; }';
      const ast = parse(code);
      const transformed = ghidraCleanup()(ast);
      const output = emit(transformed as AnyNode);

      // FUN_ and param_ names are preserved as-is
      assert.ok(output.includes('FUN_00401000'));
      assert.ok(output.includes('param_1'));
    });

    it('respects cleanNames option', () => {
      const code = 'void FUN_00401000(int param_1, uint uVar1) {}';
      const ast = parse(code);

      const withClean = ghidraCleanup({ cleanNames: true })(ast);
      const withoutClean = ghidraCleanup({ cleanNames: false })(ast);

      // All names preserved in both modes
      assert.ok(emit(withClean as AnyNode).includes('FUN_00401000'));
      assert.ok(emit(withClean as AnyNode).includes('uVar1'));
      assert.ok(emit(withoutClean as AnyNode).includes('FUN_00401000'));
      assert.ok(emit(withoutClean as AnyNode).includes('uVar1'));
    });
  });

  describe('ghidraQuickClean preset', () => {
    it('applies minimal safe transforms', () => {
      const code = 'void FUN_00401000(int param_1) { int local_8 = param_1; }';
      const ast = parse(code);
      const transformed = ghidraQuickClean(ast);
      const output = emit(transformed as AnyNode);

      // All Ghidra names preserved (only xVar would be shortened)
      assert.ok(output.includes('FUN_00401000'));
      assert.ok(output.includes('param_1'));
      assert.ok(output.includes('local_8'));
    });
  });

  describe('ghidraFullClean preset', () => {
    it('applies all transforms', () => {
      const code = 'void FUN_00401000(int param_1) { return; }';
      const ast = parse(code);
      const transformed = ghidraFullClean(ast);
      const output = emit(transformed as AnyNode);

      // FUN_ names are preserved as-is
      assert.ok(output.includes('FUN_00401000'));
    });
  });

  describe('integration with real Ghidra output', () => {
    it('handles typical Ghidra function', () => {
      const ghidraOutput = `
void FUN_00401000(int param_1, char *param_2)
{
  int local_8;
  int iVar1;

  local_8 = param_1;
  iVar1 = local_8 + 1;
  return;
}
`;
      const ast = parse(ghidraOutput);
      const transformed = ghidraFullClean(ast);
      const output = emit(transformed as AnyNode);

      // All Ghidra names preserved as-is
      assert.ok(output.includes('FUN_00401000'));
      assert.ok(output.includes('param_1'));
      assert.ok(output.includes('param_2'));
      assert.ok(output.includes('local_8'));
      assert.ok(output.includes('iVar1'));
    });

    it('handles nested function calls', () => {
      const ghidraOutput = `
int FUN_00401000(void)
{
  int iVar1;
  iVar1 = FUN_00401100();
  return iVar1;
}
`;
      const ast = parse(ghidraOutput);
      const transformed = ghidraFullClean(ast);
      const output = emit(transformed as AnyNode);

      assert.ok(output.includes('FUN_00401000'));
      assert.ok(output.includes('FUN_00401100'));
    });

    it('handles pointer parameters', () => {
      const ghidraOutput = `
void FUN_00401000(int *param_1)
{
  *param_1 = 0;
  return;
}
`;
      const ast = parse(ghidraOutput);
      const transformed = ghidraFullClean(ast);
      const output = emit(transformed as AnyNode);

      assert.ok(output.includes('FUN_00401000'));
      assert.ok(output.includes('param_1'));
    });

    it('handles complex expressions', () => {
      const ghidraOutput = `
int FUN_00401000(int param_1, int param_2)
{
  int local_c;
  local_c = param_1 + param_2 * 2;
  return local_c;
}
`;
      const ast = parse(ghidraOutput);
      const transformed = ghidraFullClean(ast);
      const output = emit(transformed as AnyNode);

      // Verify structure is preserved
      assert.ok(output.includes('+'));
      assert.ok(output.includes('*'));
      assert.ok(output.includes('2'));
    });
  });
});
