import { describe, it } from 'node:test';
import assert from 'node:assert';
import { transformGhidraCode } from '../../../index.js';
import { memberCallPlugin, memberCalls } from '../builtins/member-call.js';
import { baseClassAccessPlugin } from '../builtins/base-class-access.js';
import { frameGroupLocalsPlugin } from '../builtins/frame-group-locals.js';

/**
 * Storm's hash table chain as the generator passes it: `TSExportTableSync :
 * TSExportTableSimple : TSHashTableReuse : TSHashTable`, the element `CELLIST :
 * TSHashObject<CELLIST, HASHKEY_NONE>`, and the list a table holds. Simple
 * declares a `Ptr` of its own and Sync a `Destructor`, as in the binary.
 */
const SYNC = 'TSExportTableSync<CELLIST, HCELLIST__*, HLOCKEDCELLIST__*, CCritSect, 0>';
const SIMPLE = 'TSExportTableSimple<CELLIST, HCELLIST__*, 0>';
const REUSE = 'TSHashTableReuse<CELLIST, HASHKEY_NONE, 0>';
const TABLE = 'TSHashTable<CELLIST, HASHKEY_NONE>';
const OBJECT = 'TSHashObject<CELLIST, HASHKEY_NONE>';
const LIST = 'TSExplicitList<CELLIST, -572662307>';

const MODEL = {
  instanceMembers: {
    [TABLE]: ['Ptr', 'Unlink', 'Destructor', 'InternalClear'],
    [REUSE]: ['Destructor'],
    [SIMPLE]: ['Ptr', 'GenerateUniqueHandle'],
    [SYNC]: ['Destructor', 'Lock'],
    [OBJECT]: ['Destructor'],
    [LIST]: ['UnlinkAll'],
    HASHKEY_STRI: ['Equals'],
  },
  declaredNames: {
    [TABLE]: ['Ptr', 'Unlink', 'Destructor', 'InternalClear', 'InternalDelete', 'pVtable'],
    [REUSE]: ['Destructor', 'InternalDelete'],
    [SIMPLE]: ['Ptr', 'GenerateUniqueHandle', 'nSequence'],
    [SYNC]: ['Destructor', 'Lock', 'tSync'],
    [OBJECT]: ['Destructor', 'm_hashval'],
    CELLIST: ['dwFlags', 'Destructor'],
  },
  bases: [[SYNC, SIMPLE], [SIMPLE, REUSE], [REUSE, TABLE], ['CELLIST', OBJECT]] as Array<[string, string]>,
};

const run = (src: string, extra: Record<string, unknown> = {}) => {
  const r = transformGhidraCode(src, {
    usePluginRegistry: true,
    preset: 'full',
    pluginOptions: {
      pluginOptions: {
        'member-call': { ...MODEL, globalTypes: { gCache: SYNC, gList: LIST }, ...extra },
      },
    } as never,
  });
  assert.ok(r.success, r.error);
  return r.code;
};

describe('member-call', () => {
  it('calls a member on the object a receiver points at', () => {
    const code = run(`void f(${TABLE} *pTable, CELLIST *pNode, HASHKEY_STRI *pKey, HASHKEY_STRI *pOther) {
      ${TABLE}::Unlink(pTable, pNode);
      ${LIST}::UnlinkAll(&gList);
      g(HASHKEY_STRI::Equals(pKey, pOther));
    }`);
    assert.ok(code.includes('pTable->Unlink(pNode);'), code);
    assert.ok(code.includes('gList.UnlinkAll();'), code);
    assert.ok(code.includes('g(pKey->Equals(pOther));'), code);
  });

  it('names the member in its class where a class from the receiver\'s up to it declares the name', () => {
    const code = run(`void f(${SYNC} *pSync, CELLIST *pNode, ${REUSE} *pReuse) {
      g(${TABLE}::Ptr(&gCache, 1, &gCache.tKey));
      ${TABLE}::Unlink(&gCache, pNode);
      ${REUSE}::Destructor(&gCache);
      ${TABLE}::Destructor(pReuse);
      ${OBJECT}::Destructor(pNode);
      g(${SIMPLE}::GenerateUniqueHandle(pSync));
    }`);
    // Simple's own Ptr hides the table's; nothing between Sync and the table declares Unlink.
    assert.ok(code.includes(`g(gCache.${TABLE}::Ptr(1, &gCache.tKey));`), code);
    assert.ok(code.includes('gCache.Unlink(pNode);'), code);
    // Sync declares a Destructor of its own; so does Reuse over the table's.
    assert.ok(code.includes(`gCache.${REUSE}::Destructor();`), code);
    assert.ok(code.includes(`pReuse->${TABLE}::Destructor();`), code);
    // The element declares one as well.
    assert.ok(code.includes(`pNode->${OBJECT}::Destructor();`), code);
    assert.ok(code.includes('g(pSync->GenerateUniqueHandle());'), code);
  });

  it('names the member in its class when the receiver\'s type is not known', () => {
    const code = run(`void f(void) { ${TABLE}::Unlink(pUnknown, 0); }`);
    assert.ok(code.includes(`pUnknown->${TABLE}::Unlink(0);`), code);
  });

  it('leaves a static member, an unregistered function and a null receiver alone', () => {
    const code = run(`void f(${TABLE} *pTable, CELLIST *pNode) {
      ${TABLE}::InternalDelete(pTable, pNode);
      Other::Unlink(pTable, pNode);
      ${TABLE}::Unlink((${TABLE} *)0x0, pNode);
    }`);
    assert.ok(code.includes(`${TABLE}::InternalDelete(pTable, pNode);`), code);
    assert.ok(code.includes('Other::Unlink(pTable, pNode);'), code);
    assert.match(code, /TSHashTable<CELLIST, HASHKEY_NONE>::Unlink\((nullptr|\(TSHashTable<CELLIST, HASHKEY_NONE>\*\)0x0), pNode\);/);
  });

  it('spells the receiver of a member\'s own body `this`, and its calls on it', () => {
    const code = run(`${REUSE} *f(${REUSE} *pThis, CELLIST *pNode) {
      pThis->nChunkSize = pNode->pThis;
      ${TABLE}::Destructor(pThis);
      ${TABLE}::InternalClear(pThis, 0);
      return pThis;
    }`, { receiver: 'pThis' });
    assert.ok(code.includes('this->nChunkSize = pNode->pThis;'), code);
    // Reuse declares its own Destructor, so the base's is named; InternalClear is not hidden.
    assert.ok(code.includes(`this->${TABLE}::Destructor();`), code);
    assert.ok(code.includes('this->InternalClear(0);'), code);
    assert.ok(code.includes('return this;'), code);
    // The member a struct names `pThis` is no reference to the receiver.
    const body = code.slice(code.indexOf('{'));
    assert.deepStrictEqual(body.match(/\bpThis\b/g), ['pThis'], code);
  });

  it('keeps a receiver the body reseats as a local copy of `this`', () => {
    const code = run(`void f(${TABLE} *pThis, ${TABLE} *pSaved) {
      pSaved = pThis;
      pThis->nSlotMask = 1;
      pThis = pSaved;
      ${TABLE}::InternalClear(pThis, 0);
    }`, { receiver: 'pThis' });
    assert.match(code, /\{\s*TSHashTable<CELLIST, HASHKEY_NONE>\s*\*\s*pThis = this;\s*pSaved = pThis;/);
    assert.ok(code.includes('pThis = pSaved;'), code);
    assert.ok(code.includes('pThis->InternalClear(0);'), code);
  });

  it('runs after the passes that read the receiver as a parameter and `&local` as an escape', () => {
    assert.ok(memberCallPlugin.priority! > baseClassAccessPlugin.priority!);
    assert.ok(memberCallPlugin.priority! > frameGroupLocalsPlugin.priority!);
  });

  it('touches nothing without a model', () => {
    const src = `void f(${TABLE} *pThis) { ${TABLE}::Unlink(pThis, 0); }`;
    const r = transformGhidraCode(src, { usePluginRegistry: true, preset: 'full' });
    assert.ok(r.code.includes(`${TABLE}::Unlink(pThis, 0);`), r.code);
  });
});

describe('memberCalls', () => {
  const calls = memberCalls(MODEL);
  const cls = (s: string) => calls.classOf(s)!;

  it('qualifies exactly where a class from the receiver\'s up to the declaring class declares the name', () => {
    assert.strictEqual(calls.needsQualifier(cls(TABLE), cls(TABLE), 'Ptr'), false);
    assert.strictEqual(calls.needsQualifier(cls(SYNC), cls(TABLE), 'Ptr'), true);
    assert.strictEqual(calls.needsQualifier(cls(REUSE), cls(TABLE), 'Ptr'), false);
    assert.strictEqual(calls.needsQualifier(cls(SYNC), cls(TABLE), 'Unlink'), false);
    assert.strictEqual(calls.needsQualifier(cls(SYNC), cls(SIMPLE), 'Ptr'), false);
    assert.strictEqual(calls.needsQualifier('CELLIST', cls(OBJECT), 'Destructor'), true);
    assert.strictEqual(calls.needsQualifier('CELLIST', cls(OBJECT), 'm_key'), false);
  });

  it('qualifies a receiver of unknown or unrelated class', () => {
    assert.strictEqual(calls.needsQualifier(undefined, cls(TABLE), 'Unlink'), true);
    assert.strictEqual(calls.needsQualifier(cls(LIST), cls(TABLE), 'Unlink'), true);
  });

  it('knows a member by the class spelled with or without root qualifiers', () => {
    assert.ok(calls.isInstanceMember(cls('TSHashTable<::CELLIST, HASHKEY_NONE>'), 'Unlink'));
    assert.ok(!calls.isInstanceMember(cls(TABLE), 'InternalDelete'));
  });
});
