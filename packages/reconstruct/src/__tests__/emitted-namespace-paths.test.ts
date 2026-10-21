/**
 * Which namespaces can shadow a type or make a shortened qualifier ambiguous: only
 * the ones the emitted tree opens. Ghidra at v1666 keeps nine class namespaces that
 * hold nothing at all - `D2Common::D2UnitStrc`, `Fog::D2QServerStrc`, `AutoClass1`
 * and others left behind by edits - and once extraction read past the first page of
 * namespaces, counting them made `D2UnitStrc` a shadowed type across the whole tree.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { emittedNamespacePaths } from '../codegen/index.js';

describe('emittedNamespacePaths', () => {
  it('holds every prefix of a function or global namespace', () => {
    const paths = emittedNamespacePaths(
      [{ namespace: 'D2Common::PATH::DynamicPath' }, { namespace: undefined }],
      [{ namespace: 'D2Client::ButtonWrapper' }],
    );
    assert.deepEqual([...paths].sort(), [
      'D2Client', 'D2Client::ButtonWrapper', 'D2Common', 'D2Common::PATH', 'D2Common::PATH::DynamicPath',
    ]);
  });

  it('has no namespace that nothing is emitted into', () => {
    // D2Common::D2UnitStrc is a Ghidra class namespace with no function and no global.
    const paths = emittedNamespacePaths([{ namespace: 'D2Common::Units' }], []);
    assert.ok(!paths.has('D2Common::D2UnitStrc'));
    assert.ok(![...paths].some(p => p.split('::').includes('D2UnitStrc')));
  });
});
