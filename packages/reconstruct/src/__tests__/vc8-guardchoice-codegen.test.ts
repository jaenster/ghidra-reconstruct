import {it} from 'node:test';
import assert from 'node:assert/strict';
import {generateFunctionImplementation,getParseErrorCount} from '../codegen/impl.js';
import {vc8formBodyHash,vc8FormSpec} from '../codegen/vc8form-spec.js';
import type {ExtractedFunction,ReconstructOptions} from '../types.js';
const decompiled='int Choice(int whole,int fraction){if(!whole){if(!fraction)return 0;}else if(!fraction){Integral();goto tail;}Decimal();tail:Append();return 1;}';
const fn:ExtractedFunction={name:'Choice',address:'00100000',signature:'int Choice(int whole,int fraction)',returnType:'int',parameters:['whole','fraction'].map((name,ordinal)=>({name,dataType:'int',ordinal,size:4,storage:`Stack[0x${4+4*ordinal}]`})),localVariables:[],callingConvention:'__cdecl',size:64,isThunk:false,isExternal:false,hasVarArgs:false,decompiled};
const options:ReconstructOptions={outputDir:'./out',format:'cpp',organization:'namespace',generateCMake:false,generateSourceMaps:false,transformPreset:'full',includeAddressComments:false,promoteStaticGlobals:false};
const facts={paramFuncdefs:{},funcdefSignatures:{},functionSignatures:{},variableNames:[],voidPointerFunctions:[],rootQualifiedTypedefs:[],unionNames:[],functionReturnTypes:{Integral:'void',Decimal:'void'},functionParamTypes:{Integral:[],Decimal:[]}as Record<string,string[]>};
const tag=`guardchoice(whole,fraction);ev=0000000000;bh=64-00000000;dh=${vc8formBodyHash(decompiled)}`;
function source(tagged=true,tables=facts,stale=false){return generateFunctionImplementation({...fn,tags:tagged?[{type:'vc8form',data:stale?tag.replace(/dh=\w+/,'dh=00000000'):tag}]:[]},undefined,options,{funcPtrArgCasts:tables});}
it('passes declared callable facts through full implementation generation',()=>{const errors=getParseErrorCount(),before=source(false),after=source();assert.notEqual(after,before);assert.match(after,/if \(!whole && !fraction\)/);assert.match(after,/if \(fraction\)\s*{\s*Decimal\(\);/);assert.equal(getParseErrorCount(),errors);});
it('refuses missing callable facts and stale tags',()=>{assert.equal(source(true,{...facts,functionParamTypes:{}}),source(false,{...facts,functionParamTypes:{}}));assert.equal(source(true,facts,true),source(false));});
it('orders the control shape after duplication and before folding',()=>{const tags=['fold(other)',tag,'dup(other)'].map(data=>({type:'vc8form',data:data.includes(';ev=')?data:`${data};ev=0000000000;bh=64-00000000;dh=${vc8formBodyHash(decompiled)}`}));assert.deepEqual(vc8FormSpec({...fn,tags})?.forms.map(x=>x.form.op),['dup','guardchoice','fold']);});
