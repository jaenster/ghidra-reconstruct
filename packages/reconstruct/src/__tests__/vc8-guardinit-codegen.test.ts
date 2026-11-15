import { it } from 'node:test';
import assert from 'node:assert/strict';
import { generateFunctionImplementation, getParseErrorCount } from '../codegen/impl.js';
import { vc8formBodyHash, vc8FormSpec } from '../codegen/vc8form-spec.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const decompiled = 'int GuardedCopy(Packet *packet, int src) { int result = 7; int value = src; for (int i=0; i<2; i++) { result += value; value++; } value = src; if (packet->count > 0) { result = value; value++; result += value; } Finish(result); return result; }';
const fn: ExtractedFunction = {
  name:'GuardedCopy',address:'00100000',signature:'int GuardedCopy(Packet *packet, int src)',returnType:'int',
  parameters:[['packet','Packet *'],['src','int']].map(([name,dataType],ordinal)=>({name,dataType,ordinal,size:4,storage:`Stack[0x${4+ordinal*4}]`})),
  localVariables:[],callingConvention:'__cdecl',size:64,isThunk:false,isExternal:false,hasVarArgs:false,decompiled,
};
const options: ReconstructOptions = {outputDir:'./out',format:'cpp',organization:'namespace',generateCMake:false,generateSourceMaps:false,transformPreset:'full',includeAddressComments:false,promoteStaticGlobals:false};
const facts = {paramFuncdefs:{},funcdefSignatures:{},functionSignatures:{},variableNames:[],voidPointerFunctions:[],rootQualifiedTypedefs:[],unionNames:[],structFields:{Packet:{count:'int'}} as Record<string,Record<string,string>>};
const tag = `guardinit(value);ev=0000000000;bh=64-00000000;dh=${vc8formBodyHash(decompiled)}`;
function source(tagged = true, tables = facts, stale = false) {
  return generateFunctionImplementation({...fn,tags:tagged?[{type:'vc8form',data:stale?tag.replace(/dh=\w+/, 'dh=00000000'):tag}]:[]},undefined,options,{funcPtrArgCasts:tables});
}
it('passes member facts through the full implementation pipeline', () => {
  const errors=getParseErrorCount(),before=source(false),after=source();
  assert.notEqual(after,before); assert.match(before,/value = src;\s*if/); assert.match(after,/if \(packet->count > 0\)\s*{\s*value = src;/); assert.equal(getParseErrorCount(),errors);
});
it('keeps missing-field and stale-tag cases unchanged', () => {
  assert.equal(source(true,{...facts,structFields:{}}),source(false,{...facts,structFields:{}}));
  assert.equal(source(true,facts,true),source(false));
});
it('orders the guarded initializer after duplication and before folding', () => {
  const tags=['fold(other)',tag,'dup(other)'].map(data=>({type:'vc8form',data:data.includes(';ev=')?data:`${data};ev=0000000000;bh=64-00000000;dh=${vc8formBodyHash(decompiled)}`}));
  assert.deepEqual(vc8FormSpec({...fn,tags})?.forms.map(x=>x.form.op),['dup','guardinit','fold']);
});
