import {readFileSync} from 'node:fs';
import type {generateProject} from '../../codegen/index.js';
import type {ExtractedFunction,ProgramInfo,ReconstructOptions} from '../../types.js';

// Live Windows bodies, metadata and tags captured at Ghidra v2109, 2026-11-15.
// This is a production-codegen regression fixture with minimal type/callee
// context; it is not a complete owning database extraction or native benchmark.
// Local resolved types use the normal extraction spelling. TEXT's branch and
// comparison rows are MANUAL native-attested facts: TEST ESI/JNZ at 005019c0/2,
// TEST EAX/JLE at 005019f0/4 and CMP [ECX],10/JNZ at 005019f6/a. They keep its
// measured guard and comparison spelling; no owning markup extraction is claimed.
// The complete generated-project snapshots were captured from main ad73d788.
export const cacheFunctions:ExtractedFunction[]=JSON.parse(readFileSync(new URL('./cache-live-review-v2109.json',import.meta.url),'utf8'));
const options:ReconstructOptions={outputDir:'./out',format:'cpp',organization:'namespace',
 generateCMake:false,generateSourceMaps:false,transformPreset:'full',includeAddressComments:false,promoteStaticGlobals:false};
const program:ProgramInfo={name:'Game.exe',path:'/Redivivus/Game.exe',format:'PE',architecture:'x86',compiler:'msvc',
 imageBase:'0x400000',languageId:'x86:LE:32:default',endianness:'little',pointerSize:4};
export function cacheProject(generate:typeof generateProject,fn:ExtractedFunction){
 const ns=fn.namespace!;
 const p=generate('cache-live-review',structuredClone([fn]),[],[],[],
  [{name:ns.split('::').at(-1)!,fullPath:ns,functionCount:1,isClass:false}],options,program);
 return [...p.files].map(([path,file])=>({path,type:file.type,content:file.content})).sort((a,b)=>a.path.localeCompare(b.path));
}
