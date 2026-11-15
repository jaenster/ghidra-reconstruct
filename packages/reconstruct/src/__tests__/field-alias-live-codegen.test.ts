import {readFileSync} from 'node:fs';
import {it} from 'node:test';
import assert from 'node:assert/strict';
import {generateFunctionImplementation,getParseErrorCount} from '../codegen/impl.js';
import {setAggregateTypeNames} from '../codegen/platform-types.js';
import {vc8formBodyHash} from '../codegen/vc8form-spec.js';
import type {ExtractedFunction} from '../types.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/field-alias-live-v2109.json',import.meta.url),'utf8'));
// Real v2109 bodies with narrow, header-attested field/callee context. The
// complete owning TU benchmark is separate; no native markup facts are supplied.
const functions:ExtractedFunction[]=fixture.functions;
function generate(fn:ExtractedFunction,tagged:boolean,tables=fixture.tables){
 setAggregateTypeNames(fixture.types);
 const before=getParseErrorCount();
 const tags=tagged?[...(fn.tags??[]),{type:'vc8form',data:`fieldalias(ppDrlgMap);ev=0000000000;bh=${fn.size}-00000000;dh=${vc8formBodyHash(fn.decompiled!)}`}]:fn.tags;
 const code=generateFunctionImplementation({...structuredClone(fn),tags},undefined,fixture.options,
  {targetPointerSize:4,targetLanguageId:'x86:LE:32:default',funcPtrArgCasts:structuredClone(tables)});
 assert.equal(getParseErrorCount(),before);return code;
}
it('restores one direct store, then retains the real Anya alias for TransferMapAI',()=>{
 const fn=functions[0],baseline=generate(fn,false),candidate=generate(fn,true);
 assert.notEqual(candidate,baseline);
 assert.match(candidate,/pQuestSpecificData->pDrlgMap = [^;]*DRLGPRESET_CopyMapAI\([^;]+;\s*D2MapAIStrc\*\* ppDrlgMap = &pQuestSpecificData->pDrlgMap;\s*if \(!pQuestSpecificData->bFrozenAnyaSpawned\)/);
 assert.equal(candidate.match(/pQuestSpecificData->pDrlgMap =/g)?.length,1);
 assert.doesNotMatch(candidate,/\*ppDrlgMap =|pCopiedPreset/);
 assert.match(candidate,/DRLGPRESET_TransferMapAI\(ppDrlgMap, ppMonsterMapAi\)/);
});
it('leaves the existing direct-store sibling unchanged',()=>{
 assert.equal(generate(functions[1],true),generate(functions[1],false));
});
it('leaves the live body unchanged without its field layout proof',()=>{
 const tables=structuredClone(fixture.tables);delete tables.structLayouts.D2QuestDataA5Q3Strc;
 assert.equal(generate(functions[0],true,tables),generate(functions[0],false,tables));
});
