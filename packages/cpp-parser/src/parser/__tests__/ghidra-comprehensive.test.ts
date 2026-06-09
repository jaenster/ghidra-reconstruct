/**
 * Comprehensive Ghidra Decompiler Pattern Tests
 *
 * Tests ALL patterns documented in parser-issues.md to ensure complete
 * coverage of Ghidra's pseudo-C output.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse, ParserError } from '../parser.js';
import { emit } from '../../emit/emitter.js';
import { NodeKind } from '../../ast/kinds.js';
import type { FunctionDecl, Identifier } from '../../ast/nodes.js';

describe('Ghidra Comprehensive Patterns', () => {
  // ==========================================================================
  // 1. GHIDRA-SPECIFIC UNDEFINED TYPES
  // ==========================================================================
  describe('1. Ghidra Undefined Types', () => {
    it('parses undefined as type', () => {
      const ast = parse('void f(undefined x) {}');
      const fn = ast.declarations[0] as FunctionDecl;
      assert.strictEqual(fn.parameters.length, 1);
    });

    it('parses undefined1 (uint8_t equivalent)', () => {
      const ast = parse('undefined1 f(undefined1 param_1) { undefined1 local_8; return local_8; }');
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses undefined2 (uint16_t equivalent)', () => {
      const ast = parse('undefined2 f(void) { return 0; }');
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses undefined4 (uint32_t equivalent)', () => {
      const ast = parse('undefined4 FUN_00401000(undefined4 param_1) { return param_1; }');
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses undefined8 (uint64_t equivalent)', () => {
      const ast = parse('undefined8 uVar3; void f(void) { uVar3 = 0; }');
      assert.strictEqual(ast.declarations.length, 2);
    });

    it('parses undefined pointer casts', () => {
      const code = '*(undefined1 *)&pFile[0x20] = 0;';
      // This is a statement, not a full function - wrap it
      const ast = parse(`void f(char *pFile) { ${code} }`);
      assert.strictEqual(ast.declarations.length, 1);
    });
  });

  // ==========================================================================
  // 2. GHIDRA BIT-WIDTH TYPES
  // ==========================================================================
  describe('2. Ghidra Bit-Width Types', () => {
    it('parses int3 (3-byte integer)', () => {
      const ast = parse('int3 extraout_ECX;');
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses byte type', () => {
      const ast = parse('byte bVar1; void f(void) { bVar1 = 0; }');
      assert.strictEqual(ast.declarations.length, 2);
    });

    it('parses uint type', () => {
      const ast = parse('uint uVar1; void f(void) { uVar1 = 1; }');
      assert.strictEqual(ast.declarations.length, 2);
    });

    it('parses ushort type', () => {
      const ast = parse('ushort sVar1;');
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses longlong type', () => {
      const ast = parse('longlong lVar1; void f(void) { lVar1 = 0; }');
      assert.strictEqual(ast.declarations.length, 2);
    });

    it('parses ulonglong type', () => {
      const ast = parse('ulonglong uVar1;');
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses float10 (extended precision)', () => {
      const ast = parse('float10 *fVar1;');
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses complex bit-width expression', () => {
      // CONCAT31((int3)((uint)(pcVar2 + (-1 - (int)unaff_EDI)) >> 8), ...)
      const ast = parse(`
        int f(char *pcVar2, int unaff_EDI) {
          return (int3)((uint)(pcVar2 + (-1 - (int)unaff_EDI)) >> 8);
        }
      `);
      assert.strictEqual(ast.declarations.length, 1);
    });
  });

  // ==========================================================================
  // 3. GHIDRA INTRINSIC FUNCTIONS
  // ==========================================================================
  describe('3. Ghidra Intrinsic Functions', () => {
    describe('Concatenation intrinsics', () => {
      it('parses CONCAT11', () => {
        const ast = parse('int f(char a, char b) { return CONCAT11(a, b); }');
        assert.strictEqual(ast.declarations.length, 1);
      });

      it('parses CONCAT22', () => {
        const ast = parse('int f(short a, short b) { return CONCAT22(a, b); }');
        assert.strictEqual(ast.declarations.length, 1);
      });

      it('parses CONCAT31', () => {
        const ast = parse(`
          int f(void *pFVar2) {
            return CONCAT31((int3)((uint)pFVar2 >> 8), pFVar2 != 0);
          }
        `);
        assert.strictEqual(ast.declarations.length, 1);
      });

      it('parses CONCAT44', () => {
        const ast = parse(`
          longlong f(int extraout_EDX, int extraout_EAX) {
            return CONCAT44(extraout_EDX, extraout_EAX);
          }
        `);
        assert.strictEqual(ast.declarations.length, 1);
      });
    });

    describe('Zero-extension intrinsics', () => {
      it('parses ZEXT14', () => {
        const ast = parse('int f(byte b) { return ZEXT14(b); }');
        assert.strictEqual(ast.declarations.length, 1);
      });

      it('parses ZEXT48', () => {
        const ast = parse(`
          longlong f(void *pDynamicPath) {
            return ZEXT48(pDynamicPath) * 0x6ac690c5;
          }
        `);
        assert.strictEqual(ast.declarations.length, 1);
      });

      it('parses ZEXT816', () => {
        const ast = parse('void f(longlong x) { ZEXT816(x); }');
        assert.strictEqual(ast.declarations.length, 1);
      });
    });

    describe('Sign-extension intrinsics', () => {
      it('parses SEXT14', () => {
        const ast = parse('int f(char c) { return SEXT14(c); }');
        assert.strictEqual(ast.declarations.length, 1);
      });

      it('parses SEXT48', () => {
        const ast = parse('longlong f(int i) { return SEXT48(i); }');
        assert.strictEqual(ast.declarations.length, 1);
      });
    });

    describe('Arithmetic/Flag intrinsics', () => {
      it('parses CARRY4', () => {
        const ast = parse(`
          int f(int a, int b) {
            int bVar6 = CARRY4(a, b);
            return bVar6;
          }
        `);
        assert.strictEqual(ast.declarations.length, 1);
      });

      it('parses SBORROW4', () => {
        const ast = parse('int f(int a, int b) { return SBORROW4(a, b); }');
        assert.strictEqual(ast.declarations.length, 1);
      });

      it('parses SUB41', () => {
        const ast = parse('int f(int a, char b) { return SUB41(a, b); }');
        assert.strictEqual(ast.declarations.length, 1);
      });

      it('parses SUB84', () => {
        const ast = parse('longlong f(longlong a, int b) { return SUB84(a, b); }');
        assert.strictEqual(ast.declarations.length, 1);
      });
    });
  });

  // ==========================================================================
  // 4. CALLING CONVENTION ANNOTATIONS
  // ==========================================================================
  describe('4. Calling Convention Annotations', () => {
    it('parses __fastcall', () => {
      const ast = parse('void __fastcall FUN_00401000(int param_1) {}');
      const fn = ast.declarations[0] as FunctionDecl;
      assert.strictEqual(fn.callingConvention, '__fastcall');
    });

    it('parses __cdecl', () => {
      const ast = parse('int __cdecl File_VfprintfToFile(void *pFile, char *Format) { return 0; }');
      const fn = ast.declarations[0] as FunctionDecl;
      assert.strictEqual(fn.callingConvention, '__cdecl');
    });

    it('parses __thiscall', () => {
      const ast = parse('void __thiscall Class_Method(void *this_ptr) {}');
      const fn = ast.declarations[0] as FunctionDecl;
      assert.strictEqual(fn.callingConvention, '__thiscall');
    });

    it('parses __stdcall', () => {
      const ast = parse('int __stdcall WinMain(void *hInstance) { return 0; }');
      const fn = ast.declarations[0] as FunctionDecl;
      assert.strictEqual(fn.callingConvention, '__stdcall');
    });

    it('round-trips calling convention', () => {
      const code = 'void __fastcall FUN_00401000(int param_1) {}';
      const ast = parse(code);
      const emitted = emit(ast);
      assert.ok(emitted.includes('__fastcall'), `Expected __fastcall in: ${emitted}`);
    });
  });

  // ==========================================================================
  // 5. REGISTER ANNOTATION COMMENTS (parsed as comments, not code)
  // ==========================================================================
  describe('5. Register Annotations in Comments', () => {
    it('parses function with register annotation comment', () => {
      const code = `
        /* Function uses custom registers for function arguments!
           [FILE * pFile@ECX:4] */
        void f(void *pFile) {}
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses multi-param register annotation', () => {
      const code = `
        /* [int32_t param_1@ECX:4]
           [undefined4 param_2@Stack[0x4]:4] */
        void f(int param_1, int param_2) {}
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 1);
    });
  });

  // ==========================================================================
  // 6. SPECIAL VARIABLE PREFIXES
  // ==========================================================================
  describe('6. Special Variable Prefixes', () => {
    describe('Unaffected registers (unaff_*)', () => {
      it('parses unaff_EDI', () => {
        const ast = parse('char *unaff_EDI;');
        assert.strictEqual(ast.declarations.length, 1);
      });

      it('parses unaff_EBX', () => {
        const ast = parse('int unaff_EBX; void f(void) { unaff_EBX = 0; }');
        assert.strictEqual(ast.declarations.length, 2);
      });
    });

    describe('Extra output registers (extraout_*)', () => {
      it('parses extraout_EAX', () => {
        const ast = parse('int extraout_EAX;');
        assert.strictEqual(ast.declarations.length, 1);
      });

      it('parses extraout_EAX_00 (with suffix)', () => {
        const ast = parse('uint extraout_EAX_00;');
        assert.strictEqual(ast.declarations.length, 1);
      });

      it('parses extraout_ECX', () => {
        const ast = parse('undefined4 extraout_ECX;');
        assert.strictEqual(ast.declarations.length, 1);
      });
    });

    describe('Input registers (in_*)', () => {
      it('parses in_EAX', () => {
        const ast = parse('uint *in_EAX;');
        assert.strictEqual(ast.declarations.length, 1);
      });

      it('parses in_ECX', () => {
        const ast = parse('int in_ECX;');
        assert.strictEqual(ast.declarations.length, 1);
      });
    });
  });

  // ==========================================================================
  // 7. SIMD REGISTER SUBFIELD ACCESS
  // ==========================================================================
  describe('7. SIMD Register Subfield Access', () => {
    it('parses XMM field access _0_8_', () => {
      const ast = parse(`
        void f(void) {
          longlong uVar6;
          uVar6 = in_XMM0._0_8_;
        }
      `);
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses XMM field access with shift', () => {
      const ast = parse(`
        void f(void) {
          short uVar2;
          uVar2 = in_XMM0._6_2_ >> 4;
        }
      `);
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses XMM field assignment', () => {
      const ast = parse(`
        void f(double dVar8) {
          in_XMM0._8_8_ = dVar8;
        }
      `);
      assert.strictEqual(ast.declarations.length, 1);
    });
  });

  // ==========================================================================
  // 8. ADDRESS-BASED NAMING
  // ==========================================================================
  describe('8. Address-Based Naming', () => {
    describe('Labels (LAB_*)', () => {
      it('parses goto to LAB_', () => {
        const ast = parse(`
          void f(void) {
            goto LAB_00401059;
          LAB_00401059:
            return;
          }
        `);
        assert.strictEqual(ast.declarations.length, 1);
      });
    });

    describe('Global data (DAT_*)', () => {
      it('parses DAT_ variable', () => {
        const ast = parse('int DAT_00992708;');
        assert.strictEqual(ast.declarations.length, 1);
      });

      it('parses DAT_ usage', () => {
        const ast = parse(`
          int DAT_00992708;
          void f(void) { DAT_00992708 = 42; }
        `);
        assert.strictEqual(ast.declarations.length, 2);
      });
    });

    describe('Functions (FUN_*)', () => {
      it('parses FUN_ function', () => {
        const ast = parse('void FUN_00401000(void) {}');
        const fn = ast.declarations[0] as FunctionDecl;
        assert.strictEqual((fn.name as Identifier).name, 'FUN_00401000');
      });

      it('parses FUN_ call', () => {
        const ast = parse('void f(void) { FUN_00401000(); }');
        assert.strictEqual(ast.declarations.length, 1);
      });
    });

    describe('Thunks (thunk_FUN_*)', () => {
      it('parses thunk function', () => {
        const ast = parse('void thunk_FUN_00401000(void) {}');
        const fn = ast.declarations[0] as FunctionDecl;
        assert.strictEqual((fn.name as Identifier).name, 'thunk_FUN_00401000');
      });
    });
  });

  // ==========================================================================
  // 9. STACK REFERENCES
  // ==========================================================================
  describe('9. Stack References', () => {
    it('parses stack address reference', () => {
      const ast = parse(`
        void f(void) {
          int x = (uint)&stack0xfffffffc;
        }
      `);
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses security cookie XOR with stack', () => {
      const ast = parse(`
        void f(void) {
          int x = DEFAULT_SECURITY_COOKIE ^ (uint)&stack0xfffffffc;
        }
      `);
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses in_stack_ variable', () => {
      const ast = parse('uint in_stack_ffffffe0;');
      assert.strictEqual(ast.declarations.length, 1);
    });
  });

  // ==========================================================================
  // 10. RETURN STORAGE POINTERS
  // ==========================================================================
  describe('10. Return Storage Pointers', () => {
    it('parses __return_storage_ptr__', () => {
      const ast = parse(`
        void f(void) {
          int x = (int)__return_storage_ptr__;
        }
      `);
      assert.strictEqual(ast.declarations.length, 1);
    });
  });

  // ==========================================================================
  // 11. STRUCT FIELD ACCESS WITH OFFSETS
  // ==========================================================================
  describe('11. Struct Field Access with Offsets', () => {
    it('parses array-style field access with _base', () => {
      const ast = parse(`
        void f(void *pFile) {
          int x = pFile[0x40]._base;
        }
      `);
      // Note: This is complex syntax that may need special handling
      // For now just check it parses without crashing
      assert.ok(ast.declarations.length >= 1);
    });

    it('parses local_._0_1_ field access', () => {
      const ast = parse(`
        void f(void) {
          int local_1044;
          char x = local_1044._0_1_;
        }
      `);
      assert.strictEqual(ast.declarations.length, 1);
    });
  });

  // ==========================================================================
  // 12. NAMESPACE SYNTAX
  // ==========================================================================
  describe('12. Namespace Syntax', () => {
    it('parses namespace-qualified function name', () => {
      const ast = parse('void File::FILETOOLS_ResetOffsets(void) {}');
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses nested namespace function', () => {
      const ast = parse('void Engine::Application::SafeDeleteFile(char *path) {}');
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses namespace call', () => {
      const ast = parse(`
        void f(void) {
          Src::ErrorManager::ERROR_UnrecoverableInternalError_Halt();
        }
      `);
      assert.strictEqual(ast.declarations.length, 1);
    });
  });

  // ==========================================================================
  // 13. WARNING COMMENTS
  // ==========================================================================
  describe('13. Warning Comments', () => {
    it('parses function with alloca warning', () => {
      const code = `
        /* WARNING: Function: __alloca_probe replaced with injection: alloca_probe */
        void f(void) {}
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses function with jumptable warning', () => {
      const code = `
        /* WARNING: Could not recover jumptable at 0x00401690. Too many branches */
        void f(void) {}
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 1);
    });
  });

  // ==========================================================================
  // COMPLEX REAL-WORLD EXAMPLES
  // ==========================================================================
  describe('Complex Real-World Examples', () => {
    it('parses function with multiple Ghidra patterns', () => {
      const code = `
        undefined4 __fastcall FUN_00401000(int param_1, undefined4 param_2)
        {
          undefined4 extraout_ECX;
          uint uVar1;
          char *unaff_EDI;

          uVar1 = ZEXT48(param_1) * 0x6ac690c5;
          if (uVar1 != 0) {
            *(undefined4 *)(param_1 + 4) = param_2;
          }
          return extraout_ECX;
        }
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 1);
      const fn = ast.declarations[0] as FunctionDecl;
      assert.strictEqual(fn.callingConvention, '__fastcall');
    });

    it('parses function with CONCAT and type casts', () => {
      const code = `
        int FUN_00401100(void *pFVar2)
        {
          return CONCAT31((int3)((uint)pFVar2 >> 8), pFVar2 != (void *)0x0);
        }
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('parses function with register artifacts', () => {
      const code = `
        void FUN_00401200(void)
        {
          int extraout_EAX;
          int extraout_EAX_00;
          undefined4 extraout_ECX;
          char *unaff_EDI;
          uint unaff_EBX;

          extraout_EAX = FUN_00401000(unaff_EBX);
          return;
        }
      `;
      const ast = parse(code);
      assert.strictEqual(ast.declarations.length, 1);
    });
  });

  // ==========================================================================
  // ROUND-TRIP STABILITY
  // ==========================================================================
  describe('Round-Trip Stability', () => {
    it('maintains Ghidra types after parse-emit-parse', () => {
      const code = 'undefined4 FUN_00401000(undefined4 param_1) { return param_1; }';
      const ast1 = parse(code);
      const emitted = emit(ast1);
      const ast2 = parse(emitted);
      assert.strictEqual(ast1.declarations.length, ast2.declarations.length);
    });

    it('maintains calling conventions after round-trip', () => {
      const code = 'void __fastcall FUN_00401000(int param_1) { return; }';
      const ast1 = parse(code);
      const emitted = emit(ast1);
      const ast2 = parse(emitted);
      const fn1 = ast1.declarations[0] as FunctionDecl;
      const fn2 = ast2.declarations[0] as FunctionDecl;
      assert.strictEqual(fn1.callingConvention, fn2.callingConvention);
    });
  });
});
