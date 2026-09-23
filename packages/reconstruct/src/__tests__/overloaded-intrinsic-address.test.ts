/**
 * `pfnInterlocked = InterlockedCompareExchange;` (Bnclient/BnSend.cpp, six
 * sites) takes the address of a name mingw's headers make an overload set. The
 * exact type in `WIN32_OVERLOADED_INTRINSICS` reduces the set, but `assign-cast`
 * only applies it to a right-hand side it knows denotes a FUNCTION.
 *
 * Ghidra holds no `Function` for an import thunk, so the Windows model never
 * names it. The Mac build's own import stub of the same name used to supply it
 * through the merge; with the Mac build out of the tree the cast vanished and
 * the six sites stopped compiling. The table has to stand on its own.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildFuncPtrArgCastTables } from '../codegen/index.js';
import { WIN32_OVERLOADED_INTRINSICS } from '../codegen/crt-mapping.js';

describe('overloaded Win32 intrinsics with no model record', () => {
  const tables = buildFuncPtrArgCastTables([], [], [], []);

  for (const name of Object.keys(WIN32_OVERLOADED_INTRINSICS)) {
    it(`${name} is a function designator without any model function`, () => {
      assert.ok(tables.functionNames.includes(name), `${name} missing from functionNames`);
      assert.ok(tables.overloadedFunctionNames.includes(name));
      assert.deepEqual(tables.functionParamTypes[name], WIN32_OVERLOADED_INTRINSICS[name].paramTypes);
    });
  }
});
