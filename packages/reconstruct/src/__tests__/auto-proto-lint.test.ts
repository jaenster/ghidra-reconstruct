import { describe, it } from 'node:test';
import assert from 'node:assert';

import { lintAutoProtoConventions, describeAutoProtoLint } from '../modules/auto-proto-lint.js';
import type { ExtractedDataType } from '../types.js';

function fd(name: string, category: string, callingConvention?: string): ExtractedDataType {
  return { name, category, kind: 'FUNCTION_DEFINITION', returnType: 'void', parameters: [], callingConvention } as unknown as ExtractedDataType;
}

describe('lintAutoProtoConventions', () => {
  it('names the overrides left at unknown', () => {
    const r = lintAutoProtoConventions([
      fd('dt_1', '/auto_proto', 'unknown'),
      fd('dt_2', '/auto_proto', '__cdecl'),
      fd('fpOther', '/Diablo2/FUNCTABLES', 'unknown'),
    ]);
    assert.deepEqual(r.unknownConvention, ['dt_1']);
    assert.equal(r.total, 2);
    assert.equal(r.conventionUnavailable, false);
    assert.match(describeAutoProtoLint(r)[0], /callingConvention=unknown/);
  });

  it('is clean when every override names a convention', () => {
    const r = lintAutoProtoConventions([fd('dt_1', '/auto_proto', '__cdecl')]);
    assert.deepEqual(r.unknownConvention, []);
    assert.deepEqual(describeAutoProtoLint(r), []);
  });

  it('reports that the guard cannot run when the field is absent entirely', () => {
    const r = lintAutoProtoConventions([fd('dt_1', '/auto_proto'), fd('dt_2', '/auto_proto')]);
    assert.equal(r.conventionUnavailable, true);
    assert.match(describeAutoProtoLint(r)[0], /cannot run/);
  });
});
