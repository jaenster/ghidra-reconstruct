import { test } from 'node:test';
import assert from 'node:assert';
import { splitDataTypeKey } from '../model.js';

const DT_SEP = '\0';

test('splits the name + NUL + category form', () => {
  assert.deepEqual(
    splitDataTypeKey(`D2CodecFrameBoundsStrc${DT_SEP}/D2CMP`),
    { name: 'D2CodecFrameBoundsStrc', category: '/D2CMP' },
  );
});

test('splits a category path, which is how the journal names a new type', () => {
  assert.deepEqual(
    splitDataTypeKey('/D2CMP/D2CodecFrameBoundsStrc'),
    { name: 'D2CodecFrameBoundsStrc', category: '/D2CMP' },
  );
});

test('a root-level path keeps the root category', () => {
  assert.deepEqual(splitDataTypeKey('/DWORD'), { name: 'DWORD', category: '/' });
});

test('a bare name stays a bare name', () => {
  assert.deepEqual(splitDataTypeKey('DWORD'), { name: 'DWORD' });
});

import { eventDataTypeTarget } from '../model.js';

test('a path-shaped newName is split, not passed through whole', () => {
  assert.deepEqual(
    eventDataTypeTarget(
      { key: '/D2CMP/D2CodecFrameBoundsStrc', newName: '/D2CMP/D2CodecFrameBoundsStrc' },
      { name: 'stale', category: '/old' },
    ),
    { name: 'D2CodecFrameBoundsStrc', category: '/D2CMP' },
  );
});

test('with no newName the fallback name is kept and the key supplies the category', () => {
  assert.deepEqual(
    eventDataTypeTarget(
      { key: '/D2CMP/D2CodecFrameBoundsStrc' },
      { name: 'D2CodecFrameBoundsStrc', category: '/D2CMP' },
    ),
    { name: 'D2CodecFrameBoundsStrc', category: '/D2CMP' },
  );
});
