import { it } from 'node:test';
import assert from 'node:assert/strict';
import { generateFunctionImplementation, getParseErrorCount } from '../codegen/impl.js';
import { vc8formBodyHash, vc8FormSpec } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const decompiled = 'uint32_t GuardedStore(Game *game, uint32_t nSize, uint32_t code) { nSize = Check(game, code); if (nSize != OK) return nSize; Place(game, &nSize); return nSize; }';
const fn: ExtractedFunction = {
  name: 'GuardedStore', address: '00100000', signature: 'uint32_t GuardedStore(Game *game, uint32_t nSize, uint32_t code)',
  returnType: 'uint32_t', parameters: [['game','Game *'],['nSize','uint32_t'],['code','uint32_t']].map(([name,dataType],ordinal)=>({name,dataType,ordinal,size:4,storage:`Stack[0x${4+ordinal*4}]`})),
  localVariables: [], callingConvention: '__cdecl', size: 64, isThunk: false, isExternal: false, hasVarArgs: false, decompiled,
};
const options: ReconstructOptions = { outputDir:'./out', format:'cpp', organization:'namespace', generateCMake:false, generateSourceMaps:false, transformPreset:'full', includeAddressComments:false, promoteStaticGlobals:false };
const facts = {
  paramFuncdefs:{}, funcdefSignatures:{}, functionSignatures:{}, variableNames:[], voidPointerFunctions:[], rootQualifiedTypedefs:[], unionNames:[],
  enumTypes:['Status'], enumValues:{OK:0}, functionReturnTypes:{Check:'Status'}, functionParamTypes:{Check:['Game *','uint32_t']} as Record<string,string[]>,
};
const tag = `guardstore(nSize,status);ev=0000000000;bh=64-00000000;dh=${vc8formBodyHash(decompiled)}`;
function source(tagged = true, tables = facts, stale = false) {
  return generateFunctionImplementation({ ...fn, tags:tagged?[{type:'vc8form',data:stale?tag.replace(/dh=\w+/, 'dh=00000000'):tag}]:[] }, undefined, options, {funcPtrArgCasts:tables});
}
it('wires declared enum and callable facts through the full implementation pipeline', () => {
  const errors = getParseErrorCount(), before = source(false), after = source();
  assert.doesNotMatch(before,/uint32_t status/); assert.match(after,/uint32_t status = Check\(game, code\)/);
  assert.equal((after.match(/nSize = status/g)??[]).length,2); assert.match(after,/Place\(game, &nSize\)/);
  assert.equal(getParseErrorCount(),errors);
});
it('refuses absent enum or parameter facts and leaves stale tags unchanged', () => {
  assert.equal(source(true,{...facts,enumTypes:[]}),source(false,{...facts,enumTypes:[]}));
  assert.equal(source(true,{...facts,functionParamTypes:{}}),source(false,{...facts,functionParamTypes:{}}));
  assert.equal(source(true,facts,true),source(false));
});
it('orders the guarded store after declared-width choices and before folding', () => {
  const tags = ['fold(other)',tag,'width(nSize,uint32_t)'].map(data=>({type:'vc8form',data:data.includes(';ev=')?data:`${data};ev=0000000000;bh=64-00000000;dh=${vc8formBodyHash(decompiled)}`}));
  assert.deepEqual(vc8FormSpec({...fn,tags})?.forms.map(x=>x.form.op),['width','guardstore','fold']);
});
