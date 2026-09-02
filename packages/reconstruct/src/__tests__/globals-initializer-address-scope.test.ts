/**
 * A global's INITIALIZER is a reference site, and the scope analysis has to
 * count it.
 *
 * `gszExtDc6` is `char[5]` at 006e3590 whose two Ghidra xrefs both land in
 * SpriteCache.cpp, so `computeFileLocalGlobals` gave it file scope - and no
 * decompiled body spells its name, so the reconciler's body scan found nothing
 * to undo. But `gpszExtDc6` is a `pointer` global at 00741f04 whose Ghidra value
 * is `006e3590`: the globals unit initializes it with that symbol's address.
 *
 * The address resolver correctly declines to name a file-local from a globals
 * unit - that name is `static` in one .cpp and undefined everywhere else - so
 * the reference degraded to `void* gpszExtDc6 = (void*)0x006e3590;`, an absolute
 * address into an image that no longer exists at runtime.
 *
 * This is the class `scope: an address taken as a literal is still a reference`
 * fixed for function BODIES. A globals-unit initializer is the same reference
 * and was counted in neither place: the reference lives in `value` (a four-byte
 * pointer never carries `initializedData` at all) or in an initializer scalar,
 * and the existing name-based pass sees only a symbol NAME, never an address.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { reconcileStaticScopeWithBodyReferences } from '../codegen/index.js';
import type { AnalyzedDataSymbol, ExtractedFunction } from '../types.js';

const IMAGE_BASE = '00400000';

function makeFunc(name: string, decompiled: string): ExtractedFunction {
  return {
    name,
    address: '00400000',
    signature: `void ${name}()`,
    returnType: 'void',
    parameters: [],
    localVariables: [],
    callingConvention: '__cdecl',
    size: 64,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    decompiled,
  } as unknown as ExtractedFunction;
}

/** char[5] ".dc6" @006e3590, scoped to the one file its xrefs land in. */
function spriteCacheExtension(): AnalyzedDataSymbol {
  return {
    name: 'gszExtDc6', address: '006e3590', dataType: 'char[5]', suggestedType: 'char[5]',
    size: 5, isInitialized: true, value: '.dc6', xrefCount: 5,
    scope: 'file-local', ownerFile: 'D2CMP/SRC/SpriteCache.cpp',
  } as unknown as AnalyzedDataSymbol;
}

/** The pointer global at 00741f04 that holds that address. */
function extensionPointer(value: string): AnalyzedDataSymbol {
  return {
    name: 'gpszExtDc6', address: '00741f04', dataType: 'pointer', suggestedType: 'void*',
    size: 4, isInitialized: true, value, xrefCount: 2, scope: 'global',
  } as unknown as AnalyzedDataSymbol;
}

const bodies = [
  makeFunc('IMAGE_ReturnImageExtension', 'char* IMAGE_ReturnImageExtension(){ return (char*)gpszExtDc6; }'),
  makeFunc('SPRITECACHE_BuildPath', 'void SPRITECACHE_BuildPath(){ strcat(szPath, (char*)gpszExtDc6); }'),
];
const files = new Map([
  ['IMAGE_ReturnImageExtension', 'D2CMP/SRC/SpriteCache.cpp'],
  ['SPRITECACHE_BuildPath', 'D2CMP/SRC/SpriteCache.cpp'],
]);

describe('a symbol a globals-unit initializer references cannot stay static', () => {
  it('promotes the target of an address held in another global`s value', () => {
    const target = spriteCacheExtension();
    const holder = extensionPointer('006e3590');

    const r = reconcileStaticScopeWithBodyReferences(
      [target, holder], bodies, files, new Set(), IMAGE_BASE, []);

    assert.strictEqual(target.scope, 'global');
    assert.strictEqual(target.ownerFile, undefined);
    assert.strictEqual(r.promotedToGlobal, 1);
  });

  it('promotes the target of an address held in an initializer element', () => {
    const target = spriteCacheExtension();
    const table = {
      name: 'gaExtensionTable', address: '00741f10', dataType: 'char*[2]',
      suggestedType: 'char*[2]', size: 8, isInitialized: true, value: null,
      xrefCount: 1, scope: 'global',
      initializedData: {
        kind: 'array', value: null, fields: null,
        elements: [
          { kind: 'scalar', value: '006e3590', elements: null, fields: null },
          { kind: 'scalar', value: '0', elements: null, fields: null },
        ],
      },
    } as unknown as AnalyzedDataSymbol;

    reconcileStaticScopeWithBodyReferences(
      [target, table], bodies, files, new Set(), IMAGE_BASE, []);

    assert.strictEqual(target.scope, 'global');
  });

  it('counts an INTERIOR address, the same extent rule the resolver uses', () => {
    const target = spriteCacheExtension();
    // 006e3592 is `gszExtDc6 + 2`, inside the char[5] and owned by nothing else.
    const holder = extensionPointer('006e3592');

    reconcileStaticScopeWithBodyReferences(
      [target, holder], bodies, files, new Set(), IMAGE_BASE, []);

    assert.strictEqual(target.scope, 'global');
  });

  it('leaves a symbol nothing references where it is', () => {
    const target = spriteCacheExtension();
    // The pointer holds an address that belongs to no modelled global.
    const holder = extensionPointer('006e9999');

    const r = reconcileStaticScopeWithBodyReferences(
      [target, holder], bodies, files, new Set(), IMAGE_BASE, []);

    assert.strictEqual(target.scope, 'file-local');
    assert.strictEqual(target.ownerFile, 'D2CMP/SRC/SpriteCache.cpp');
    assert.strictEqual(r.promotedToGlobal, 0);
  });

  it('does not promote on a symbol`s reference to itself', () => {
    const target = spriteCacheExtension();
    // A record whose own value is its own address resolves to itself; that is
    // not a reference from anywhere it is not already visible.
    (target as { value?: string | null }).value = '006e3590';

    reconcileStaticScopeWithBodyReferences(
      [target], bodies, files, new Set(), IMAGE_BASE, []);

    assert.strictEqual(target.scope, 'file-local');
  });

  it('counts a holder that is itself file-local', () => {
    // No same-unit exemption: the holder`s own scope is not final yet - the body
    // scan in this very pass may promote it into the globals unit - so a
    // reference from one file-local to another is counted rather than reasoned
    // about. Over-promoting costs an extern; under-promoting costs the address.
    const target = spriteCacheExtension();
    const holder = extensionPointer('006e3590');
    (holder as { scope?: string; ownerFile?: string }).scope = 'file-local';
    (holder as { scope?: string; ownerFile?: string }).ownerFile = 'D2CMP/SRC/SpriteCache.cpp';

    reconcileStaticScopeWithBodyReferences(
      [target, holder], bodies, files, new Set(), IMAGE_BASE, []);

    assert.strictEqual(target.scope, 'global');
  });
});
