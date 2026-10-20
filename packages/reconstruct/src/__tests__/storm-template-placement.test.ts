/**
 * Storm template instantiations go under Storm/H/stpl/<template>/ (their templates are
 * all in storm/H/stpl.h), not one directory each at the output root, and the default
 * link-offset sentinel -572662307 (0xDDDDDDDD) is not part of a file name.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { getFilePath, stormTemplatePath } from '../codegen/namespace.js';
import type { ReconstructOptions } from '../types.js';

const options = { organization: 'namespace', format: 'cpp' } as ReconstructOptions;

describe('Storm template placement', () => {
  it('places each instantiation by template family', () => {
    assert.strictEqual(getFilePath('TSExplicitList_CELLIST_572662307', 'header', options), 'Storm/H/stpl/TSExplicitList/TSExplicitList_CELLIST.h');
    assert.strictEqual(getFilePath('TSExplicitList<CELLIST,-572662307>', 'impl', options), 'Storm/H/stpl/TSExplicitList/TSExplicitList_CELLIST.cpp');
    assert.strictEqual(getFilePath('TSGrowableArray_TSExplicitList_SGAMEDATA_572662307', 'header', options), 'Storm/H/stpl/TSGrowableArray/TSGrowableArray_TSExplicitList_SGAMEDATA.h');
    assert.strictEqual(getFilePath('TSHashTable_StringEntryNode_HASHKEY_STRI', 'impl', options), 'Storm/H/stpl/TSHashTable/TSHashTable_StringEntryNode_HASHKEY_STRI.cpp');
    assert.strictEqual(getFilePath('HASHKEY_STRI', 'header', options), 'Storm/H/stpl/HASHKEY_STRI.h');
  });
  it('keeps a real link offset, and leaves non-template units alone', () => {
    assert.strictEqual(stormTemplatePath('TSExplicitList_TSHashObjectChunk_CELLIST_HASHKEY_NONE_16', '.h'), 'Storm/H/stpl/TSExplicitList/TSExplicitList_TSHashObjectChunk_CELLIST_HASHKEY_NONE_16.h');
    assert.strictEqual(stormTemplatePath('CELLIST', '.h'), undefined);
    assert.strictEqual(getFilePath('TSHashTableEntry', 'header', options), 'TSHashTableEntry/TSHashTableEntry.h');
  });
});
