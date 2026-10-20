/**
 * G9 at v1268: 006878a0 is compiler::_except_handler3 and the SEH3 frame types live in
 * Ghidra's /CRT/SEH, a category the run excludes with the CRT. Kept bodies still declare
 * registration and scope-table locals of those types, the scope tables are globals of
 * them, and they store &_except_handler3 into a pfnEHHandlerRoutine slot.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generatePlatformHeader, isPlatformOrBuiltinType, PLATFORM_FUNCDEF_NAMES, PLATFORM_STRUCT_FIELD_TYPES } from '../codegen/platform-types.js';
import { buildFuncPtrArgCastTables } from '../codegen/index.js';
import { emitDataValue, setGlobalInitializerTypes, setKnownFuncDefTypedefs } from '../codegen/globals-header.js';
import type { DataValue, ExtractedFunction } from '../types.js';

describe('MSVC SEH3 frame types in d2_platform.h', () => {
  it('defines the /CRT/SEH types with the EXSUP.INC layout, funcdefs as pointer typedefs', () => {
    const h = generatePlatformHeader({});
    assert.match(h, /typedef int32_t \(\*EH3_FILTER\)\(void\);/);
    assert.match(h, /typedef void \(\*EH3_HANDLER\)\(void\);/);
    assert.match(h, /struct EH3_SCOPETABLE_ENTRY \{\s*int32_t EnclosingLevel;[^}]*EH3_FILTER FilterFunc;[^}]*EH3_HANDLER HandlerFunc;/);
    assert.match(h, /struct EH3_EXCEPTION_REGISTRATION \{[^}]*Next;[^}]*ExceptionHandler;[^}]*ScopeTable;[^}]*TryLevel;/);
    assert.match(h, /extern "C" int _except_handler3\(struct _EXCEPTION_RECORD\* pExceptionRecord, EH3_EXCEPTION_REGISTRATION\* pRegistration, CONTEXT\* pContext, void\* pDispatcherContext\);/);
    for (const n of ['EH3_SCOPETABLE_ENTRY', 'EH3_EXCEPTION_REGISTRATION', 'EH3_FILTER', 'EH3_HANDLER']) {
      assert.ok(isPlatformOrBuiltinType(n), `${n} must never be emitted by the tree`);
    }
    assert.ok(PLATFORM_FUNCDEF_NAMES.includes('EH3_HANDLER'));
  });

  it('renders a scope table: -1 level, NULL filter, the funclet address through the funcdef', () => {
    setKnownFuncDefTypedefs([...PLATFORM_FUNCDEF_NAMES]);
    setGlobalInitializerTypes([]);
    assert.ok(PLATFORM_STRUCT_FIELD_TYPES.has('EH3_SCOPETABLE_ENTRY'));
    const out = emitDataValue({ kind: 'array', elements: [{ kind: 'struct', fields: [
      { name: 'EnclosingLevel', value: { kind: 'scalar', value: '0xffffffff' } },
      { name: 'FilterFunc', value: { kind: 'pointer', value: 'DAT_00000000' } },
      { name: 'HandlerFunc', value: { kind: 'pointer', value: 'LAB_00516bfc' } },
    ] }] } as DataValue, 0, 'EH3_SCOPETABLE_ENTRY[1]');
    assert.match(out, /\.EnclosingLevel = \*\/ -1,/);
    assert.match(out, /\.FilterFunc = \*\/ nullptr,/);
    assert.match(out, /\.HandlerFunc = \*\/ \(EH3_HANDLER\)0x00516bfc/);
  });

  it('knows the signature of a platform-declared function the model still has', () => {
    const handler = {
      name: '_except_handler3', address: '006878a0', namespace: 'compiler', callingConvention: '__cdecl',
      returnType: '_EXCEPTION_DISPOSITION', size: 254, isThunk: false, isExternal: false, localVariables: [],
      parameters: [
        { name: 'pExceptionRecord', dataType: '_EXCEPTION_RECORD *', ordinal: 0 },
        { name: 'pRegistration', dataType: 'EH3_EXCEPTION_REGISTRATION *', ordinal: 1 },
        { name: 'pContext', dataType: '_CONTEXT *', ordinal: 2 },
        { name: 'pDispatcherContext', dataType: 'void *', ordinal: 3 },
      ],
    } as unknown as ExtractedFunction;
    const t = buildFuncPtrArgCastTables([], [], [], [], [], [handler]);
    assert.ok(t.functionSignatures._except_handler3, 'bare spelling');
    assert.ok(t.functionSignatures['compiler::_except_handler3'], 'qualified spelling');
    assert.strictEqual(t.functionParamTypes?._except_handler3, undefined, 'its slots stay the header\'s');
  });
});
