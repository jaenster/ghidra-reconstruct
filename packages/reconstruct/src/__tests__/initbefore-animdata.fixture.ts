import {readFileSync} from 'node:fs';
import {generateFunctionImplementation} from '../codegen/impl.js';
import {buildFuncPtrArgCastTables} from '../codegen/index.js';
import type {ExtractedFunction,ReconstructOptions} from '../types.js';
export const fixture=JSON.parse(readFileSync(new URL('./fixtures/initbefore-animdata-v2109.json',import.meta.url),'utf8'));
export function generated(tag?:string){
  const fn=fixture.function as ExtractedFunction;
  const tables=buildFuncPtrArgCastTables([fn],[],[],[]);
  return generateFunctionImplementation({...fn,tags:[...(fn.tags??[]),...(tag?[{type:'vc8form',data:tag}]:[])]},undefined,fixture.options as ReconstructOptions,{targetPointerSize:4,targetLanguageId:'x86:LE:32:default',funcPtrArgCasts:tables});
}
