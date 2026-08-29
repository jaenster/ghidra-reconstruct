import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setAggregateTypeNames, isPointerTypedefName, castPointerInitializer } from '../codegen/platform-types.js';

// Exactly the records the snapshot carries for these names.
const DATA_TYPES = [
  { name: 'CHAR', kind: 'TYPEDEF', underlyingType: 'char' },
  { name: 'LPCSTR', kind: 'TYPEDEF', underlyingType: 'CHAR *' },
  { name: 'HANDLE', kind: 'TYPEDEF', underlyingType: 'void *' },
  { name: '_SERVICE_STATUS', kind: 'STRUCTURE' },
  { name: 'LPSERVICE_STATUS', kind: 'TYPEDEF', underlyingType: '_SERVICE_STATUS *' },
  { name: 'SOCKET', kind: 'TYPEDEF', underlyingType: 'uint' },
  { name: 'D2SeedStrc', kind: 'STRUCTURE' },
  { name: 'aName', kind: 'TYPEDEF', underlyingType: 'char[32]' },
];

describe('a pointer spelled through a typedef is still a pointer slot', () => {
  it('resolves the typedef chain rather than looking for a star', () => {
    setAggregateTypeNames(DATA_TYPES);
    assert.ok(isPointerTypedefName('LPCSTR'));
    assert.ok(isPointerTypedefName('HANDLE'));
    assert.ok(isPointerTypedefName('LPSERVICE_STATUS'));
    // An integer alias and an array alias are not pointer slots.
    assert.ok(!isPointerTypedefName('SOCKET'));
    assert.ok(!isPointerTypedefName('aName'));
    assert.ok(!isPointerTypedefName('CHAR'));
  });

  it('casts the word the machine stores into such a slot', () => {
    setAggregateTypeNames(DATA_TYPES);
    // The four bytes at 006cf34c ARE the format string "(%u)"; Ghidra types the
    // symbol LPCSTR because a caller passes it. Bare, it converts to nothing.
    assert.strictEqual(castPointerInitializer('LPCSTR', '0x29752528'), '(LPCSTR)0x29752528');
    assert.strictEqual(castPointerInitializer('HANDLE', '0x006deb80'), '(HANDLE)0x006deb80');
  });

  it('leaves a null pointer constant and a non-pointer slot alone', () => {
    setAggregateTypeNames(DATA_TYPES);
    assert.strictEqual(castPointerInitializer('LPCSTR', '0'), '0');
    assert.strictEqual(castPointerInitializer('LPCSTR', 'nullptr'), 'nullptr');
    assert.strictEqual(castPointerInitializer('SOCKET', '0x10'), '0x10');
    assert.strictEqual(castPointerInitializer('uint32_t', '0x10'), '0x10');
  });
});
