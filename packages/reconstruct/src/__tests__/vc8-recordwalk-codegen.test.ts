import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateFunctionImplementation } from '../codegen/impl.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import { emittedMemberNames, resetEmittedMemberNames } from '../codegen/header.js';
import type { ExtractedFunction, ExtractedStruct, ReconstructOptions } from '../types.js';

// The fixture records live MCP reads and one manual, asm-attested comparison
// row. It is deliberately not described as an owning snapshot/extractor run.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/recordwalk-gfx.json', import.meta.url), 'utf8'));
const fn = fixture.function as ExtractedFunction;
const types = fixture.types as ExtractedStruct[];
const options: ReconstructOptions = {
  outputDir:'./out', format:'cpp', organization:'namespace', generateCMake:false,
  generateSourceMaps:false, transformPreset:'full', includeAddressComments:false, promoteStaticGlobals:false,
};
resetEmittedMemberNames();
const tables = {
  paramFuncdefs:{}, funcdefSignatures:{}, functionSignatures:{}, variableNames:[],
  voidPointerFunctions:[], rootQualifiedTypedefs:[], unionNames:[],
  typedefTargets:{byte:'unsigned char',uint:'unsigned int',uint8_t:'unsigned char',uint32_t:'unsigned int',int32_t:'int',intptr_t:'int'},
  structFields:Object.fromEntries(types.map(t=>[t.name,Object.fromEntries(t.fields.filter(f=>f.name).map(f=>[f.name,f.dataType]))])),
  structLayouts:Object.fromEntries(types.map(t=>[t.name,t.fields.map(f=>({name:f.name??'',offset:f.offset,size:f.size,type:f.dataType}))])),
  aggregateMembers:Object.fromEntries(types.map(t=>[t.name,[...emittedMemberNames(t)]])),
  functionReturnTypes:{'D2Hell::D2FILE_AllocAndLoadD2File':'void*'},
  globalTypes:{gbCofCacheLRUEnabled:'int32_t'},
};
function source(tagged:boolean, stale=false, facts=tables) {
  const data=`recordwalk(pEntry);ev=0000000000;bh=252-00000000;dh=${stale?'00000000':vc8formBodyHash(fn.decompiled!)}`;
  return generateFunctionImplementation({...fn,tags:[...(fn.tags??[]),...(tagged?[{type:'vc8form',data}]:[])]},undefined,options,{funcPtrArgCasts:facts});
}
it('full implementation pipeline applies only a current opt-in recordwalk tag',()=>{
  const before=source(false), after=source(true);
  assert.equal(source(true,true),before);
  assert.doesNotMatch(before,/pRecordCursor/);
  assert.match(after,/pEntry = \(D2CofTextureCacheEntryStrc\*\)pRecordCursor;/);
  assert.match(after,/pRecordCursor = &pEntry->field_0x18;\s*pEntry->pFileData = pRecordCursor;/);
  assert.match(after,/puVar1 = &pEntry->nFileSize;\s*pRecordCursor \+= \*puVar1;/);
  assert.match(after,/nRemaining \+= -0x18 - \*puVar1/,'existing logical byte count is retained');
  assert.match(after,/\) >= 8/,'the independently attested name-length comparison is retained');
});
it('full codegen refuses without layout or actual emitted placeholder members',()=>{
  const before=source(false);
  assert.equal(source(true,false,{...tables,structLayouts:{}}),before);
  assert.equal(source(true,false,{...tables,aggregateMembers:{}}),before);
});
