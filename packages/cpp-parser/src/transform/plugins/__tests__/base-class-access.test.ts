import { describe, it } from 'node:test';
import assert from 'node:assert';
import { transformGhidraCode } from '../../../index.js';

/**
 * Storm's hash table chain, as the generator passes it: `TSExportTableSync :
 * TSExportTableSimple : TSHashTableReuse : TSHashTable`, and the element `CELLIST :
 * TSHashObject<CELLIST, HASHKEY_NONE>`. `m_shadow` stands for a member a derived
 * class declares again.
 */
const SYNC = 'TSExportTableSync<CELLIST, HCELLIST__*, HLOCKEDCELLIST__*, CCritSect, 0>';
const SIMPLE = 'TSExportTableSimple<CELLIST, HCELLIST__*, 0>';
const REUSE = 'TSHashTableReuse<CELLIST, HASHKEY_NONE, 0>';
const TABLE = 'TSHashTable<CELLIST, HASHKEY_NONE>';
const OBJECT = 'TSHashObject<CELLIST, HASHKEY_NONE>';

const OPTS = {
  usePluginRegistry: true as const,
  preset: 'full' as const,
  pluginOptions: {
    pluginOptions: {
      'base-class-access': {
        baseComponents: ['super_TSExportTableSimple', 'super_TSHashObject', 'super_TSHashTable', 'super_TSHashTableReuse'],
        hiddenMembers: ['m_shadow'],
        bases: [[SYNC, SIMPLE], [SIMPLE, REUSE], [REUSE, TABLE], ['CELLIST', OBJECT]],
        globalTypes: { gCache: SYNC },
      },
    },
  },
};

const run = (src: string) => {
  const r = transformGhidraCode(src, OPTS);
  assert.ok(r.success, r.error);
  return r.code;
};

describe('base-class-access', () => {
  it('reads an inherited member through the derived object, through a whole chain', () => {
    const code = run(`void f(${SYNC} *pThis, CELLIST *pNode) {
      pThis->super_TSExportTableSimple.super_TSHashTableReuse.super_TSHashTable.pVtable = 0;
      gCache.super_TSExportTableSimple.nSequence = 1;
      g((pNode->super_TSHashObject).m_hashval);
    }`);
    assert.ok(code.includes('pThis->pVtable = 0;'), code);
    assert.ok(code.includes('gCache.nSequence = 1;'), code);
    assert.ok(code.includes('g(pNode->m_hashval);'), code);
    assert.ok(!code.includes('super_'), code);
  });

  it('keeps a member some derived class declares again', () => {
    const code = run(`void f(${SYNC} *pThis) { pThis->super_TSExportTableSimple.m_shadow = 0; }`);
    assert.ok(code.includes('pThis->super_TSExportTableSimple.m_shadow = 0;'), code);
  });

  it('passes the derived pointer where the base subobject\'s address is converted at once', () => {
    const code = run(`CELLIST *f(CELLIST *pNode, CELLIST *pArray, ${OBJECT} *pBase) {
      ${OBJECT}::Destructor(&pNode->super_TSHashObject);
      pBase = &pArray[2].super_TSHashObject;
      ${OBJECT} *pFirst = &pArray->super_TSHashObject;
      if (pBase == &gNode.super_TSHashObject) { return (CELLIST *)&pNode->super_TSHashObject; }
      return 0;
    }`);
    assert.ok(code.includes(`${OBJECT}::Destructor(pNode);`), code);
    assert.ok(code.includes('pBase = &pArray[2];'), code);
    assert.ok(code.includes(`${OBJECT}* pFirst = pArray;`), code);
    // (early-return turns the comparison around)
    assert.match(code, /pBase [=!]= &gNode\)/);
    assert.ok(code.includes('return (CELLIST*)pNode;'), code);
    const ret = run(`${OBJECT} *g(CELLIST *pNode) { return &pNode->super_TSHashObject; }`);
    assert.ok(ret.includes('return pNode;'), ret);
  });

  it('leaves a base subobject\'s address alone where the derived type would change its value', () => {
    const code = run(`void f(CELLIST *pNode) { g(&pNode->super_TSHashObject + 1); h((&pNode->super_TSHashObject)[1]); }`);
    assert.ok(code.includes('&pNode->super_TSHashObject + 1'), code);
    assert.ok(code.includes('(&pNode->super_TSHashObject)[1]'), code);
  });

  it('drops a cast to a base of the argument\'s own class', () => {
    const code = run(`void f(${SIMPLE} *pThis, CELLIST *pNode) {
      ${TABLE}::Ptr((${TABLE} *)&gCache, 1, &gCache.super_TSExportTableSimple.tKey);
      (*pThis->super_TSHashTableReuse.super_TSHashTable.pVtable->InternalDelete)((${TABLE} *)pThis, pNode);
      ${REUSE}::Destructor((${REUSE} *)pThis);
    }`);
    assert.ok(code.includes(`${TABLE}::Ptr(&gCache, 1, &gCache.tKey);`), code);
    assert.ok(code.includes('InternalDelete(pThis, pNode);'), code);
    assert.ok(code.includes(`${REUSE}::Destructor(pThis);`), code);
  });

  it('keeps a cast whose operand is not of a derived class, of an unknown type, or const', () => {
    const code = run(`void f(${TABLE} *pTable, void *pAny, ${SIMPLE} *pThis, const ${SIMPLE} *pConst) {
      ${TABLE}::Clear((${TABLE} *)pConst);
      ${SIMPLE}::Ptr((${SIMPLE} *)pTable, 1);
      ${TABLE}::Clear((${TABLE} *)pAny);
      ${TABLE}::Clear((${TABLE} *)pUnknown);
      ${TABLE}::Clear((${TABLE} *)pTable);
      int n = (int)(${TABLE} *)pThis;
    }`);
    assert.ok(code.includes(`(${SIMPLE}*)pTable`), code);
    assert.ok(code.includes(`(${TABLE}*)pAny`), code);
    assert.ok(code.includes(`(${TABLE}*)pUnknown`), code);
    assert.ok(code.includes(`(${TABLE}*)pTable`), code);
    assert.ok(code.includes(`(int)(${TABLE}*)pThis`), code);
    assert.ok(code.includes(`(${TABLE}*)pConst`), code);
  });

  it('does nothing without base components', () => {
    const r = transformGhidraCode(`void f(CELLIST *pNode) { g(&pNode->super_TSHashObject); }`, { usePluginRegistry: true, preset: 'full' });
    assert.ok(r.success, r.error);
    assert.ok(r.code.includes('&pNode->super_TSHashObject'), r.code);
  });
});
