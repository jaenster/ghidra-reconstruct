import { it } from 'node:test';
import assert from 'node:assert/strict';
import { generateFunctionImplementation, getParseErrorCount } from '../codegen/impl.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const fn:ExtractedFunction={
  name:'ClearWords',address:'00100000',signature:'void ClearWords()',returnType:'void',parameters:[],
  localVariables:[{name:'words',dataType:'WCHAR[32]',size:64,storage:'Stack[-0x44]:64'}],
  callingConvention:'__cdecl',size:32,isThunk:false,isExternal:false,hasVarArgs:false,
  decompiled:'void ClearWords() { WCHAR words[32]; Fill(words); words._60_4_ = words._60_4_ & 0xffff; Use(words); }',
};
const options:ReconstructOptions={outputDir:'./out',format:'cpp',organization:'namespace',generateCMake:false,generateSourceMaps:false,transformPreset:'full',includeAddressComments:false,promoteStaticGlobals:false};
const source=(targetLanguageId?:string)=>generateFunctionImplementation(fn,undefined,options,{targetLanguageId});
it('wires the explicit little-endian fact through the implementation pipeline without a tag',()=>{
  const errors=getParseErrorCount(),out=source('x86:LE:32:default');
  assert.match(out,/words\[31\] = 0/);assert.doesNotMatch(out,/0xffff/);assert.match(out,/Fill\(words\)/);assert.match(out,/Use\(words\)/);assert.equal(getParseErrorCount(),errors);
});
it('preserves the existing representation for unknown and big-endian targets',()=>{
  assert.match(source(),/0xffff/);assert.match(source('PowerPC:BE:32:default'),/0xffff/);
});
