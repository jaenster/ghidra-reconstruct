import {it} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../../../parser/index.js';
import {emit} from '../../../emit/index.js';
import {NodeKind} from '../../../ast/kinds.js';
import type {TranslationUnit,FunctionDecl,DeclStmt,VariableDecl,DecltypeType} from '../../../ast/nodes.js';
import {applyVc8Forms,parseVc8Form,type Vc8FormSite} from '../builtins/vc8-form.js';
import {compileAndRun,hasNativeGpp} from '../../../testing/native-cpp.js';

function apply(code:string,tag:string,prepare?:(ast:TranslationUnit)=>void){
 const form=parseVc8Form(tag);assert.ok(form);const sites:Vc8FormSite[]=[];
 const ast=parse(code);prepare?.(ast);
 const before=emit(ast),after=emit(applyVc8Forms(ast,[{form,tag}],s=>sites.push(s)));
 assert.equal(sites.length,1);return{before,after,site:sites[0]};
}
const object='int f(unsigned x) { Frame frame; init(&frame,x); return frame.value; }';
const scalar='int f(unsigned x) { int value = make(x); return value + value; }';
// The emitter/AST support decltype even though the Ghidra-text parser does not.
// Supply that actual type node, then compile the emitted C++ to check its meaning.
const decltypeFrame=(ast:TranslationUnit)=>{
 const fn=ast.declarations[0] as FunctionDecl;
 const variables=fn.body!.statements.filter(s=>s.kind===NodeKind.DeclStmt).flatMap(s=>(s as DeclStmt).declarations) as VariableDecl[];
 const frame=variables.find(d=>d.name.name==='frame')!,copy=variables.find(d=>d.name.name==='copy')!;
 copy.type={kind:NodeKind.DecltypeType,location:copy.type.location,leadingTrivia:[],trailingTrivia:[],expression:{...frame.name}} as DecltypeType;
};
const typedObject='int f(unsigned x) { Frame frame; init(&frame,x); Frame copy; copy.value=frame.value; return copy.value+sizeof(frame); }';
it('keeps a local object declaration before caching its address',()=>{
 const r=apply(object,'cache(&frame,pFrame,Frame*)');assert.ok(r.site.applied,r.site.why);
 assert.match(r.after,/Frame frame;\s*Frame\* pFrame = &frame;/);assert.doesNotMatch(r.after,/operator\*/);
 assert.match(r.after,/return pFrame->value;/);
});
it('initializes a local before caching its value',()=>{
 const r=apply(scalar,'cache(value,cached,int)');assert.ok(r.site.applied,r.site.why);
 assert.match(r.after,/int value = make\(x\);\s*int cached = value;/);
 assert.match(r.after,/return cached \+ cached;/);
});
it('keeps member names and qualified name components separate from a local use',()=>{
 const r=apply('int f(int value) { Box b; b.value=2; return value+b.value+N::value; }','cache(value,cached,int)');
 assert.ok(r.site.applied,r.site.why);assert.match(r.after,/b\.value/);assert.match(r.after,/N::value/);assert.doesNotMatch(r.after,/N::cached|b\.cached/);
});
it('preserves decltype and sizeof while rewriting evaluated object uses',()=>{
 const r=apply(typedObject,'cache(&frame,pFrame,Frame*)',decltypeFrame);
 assert.ok(r.site.applied,r.site.why);assert.match(r.after,/decltype\(frame\) copy/);assert.match(r.after,/sizeof\(frame\)/);assert.match(r.after,/copy\.value = pFrame->value/);
});
it('keeps initializer reads but leaves a nested type alias unchanged',()=>{
 const r=apply('int f(int value) { { typedef int value; value other=3; } int copy=value; return copy; }','cache(value,cached,int)');
 assert.ok(r.site.applied,r.site.why);assert.match(r.after,/typedef int value/);assert.match(r.after,/value other = 3/);assert.match(r.after,/int copy = cached/);
});
it('can insert within a loop body after its initializer has declared the index',()=>{
 const r=apply('int f(int* a) { int result=0; for(int i=0;i<4;i++) { result+=a[i]; } return result; }','cache(a[i],cached,int)');
 assert.ok(r.site.applied,r.site.why);assert.match(r.after,/for \(int i = 0; i < 4; i\+\+\) \{\s*int cached = a\[i\]/);
});
const refusals:Array<[string,string,string]>=[
 ['anchor before local declaration','int f() { int marker; marker=1; int value=7; return value; }','cache(value,cached,int,@marker)'],
 ['same declaration statement dependency','int f() { int value=7,other=value; return other; }','cache(value,cached,int)'],
 ['shadowed local','int f(int value) { { int value=2; use(value); } return value; }','cache(value,cached,int)'],
 ['nested method','int f(int value) { struct Local { int g(int value) { return value; } }; return value; }','cache(value,cached,int)'],
 ['only unevaluated use','int f(int value) { return sizeof(value); }','cache(value,cached,int)'],
 ['constant case and size query','int f(int x) { switch(x) { case VALUE: return 7; } return sizeof(VALUE); }','cache(VALUE,cached,int)'],
 ['replacement captures global name','int f(int value) { return value+cached; }','cache(value,cached,int)'],
 ['increment of cached value','int f(int value) { return value++; }','cache(value,cached,int)'],
 ['dependency increment within first read','int f(int* p) { return (p++,*p); }','cache(*p,cached,int)'],
];
for(const[name,code,tag]of refusals)it('refuses '+name+' without mutation',()=>{
 const r=apply(code,tag);assert.equal(r.site.applied,false,r.after);assert.equal(r.after,r.before);
});
it('preserves values and initializer effects in optimized native code',{skip:!hasNativeGpp()},()=>{
 const cases:Array<[string,string,((ast:TranslationUnit)=>void)?]>=[
  [object,'cache(&frame,pFrame,Frame*)'],
  [scalar,'cache(value,cached,int)'],
  ['int f(unsigned value) { Box b; b.value=2; return value+b.value+N::value; }','cache(value,cached,unsigned)'],
  [typedObject,'cache(&frame,pFrame,Frame*)',decltypeFrame],
 ];
 let prelude='struct Frame { int value; }; struct Box { int value; }; namespace N { int value=5; } unsigned calls; int make(unsigned x) { ++calls; return (int)(x&0x7fff); } void init(Frame* p,unsigned x) { ++calls; p->value=make(x); }\n';
 for(const[i,[code,tag,prepare]]of cases.entries()){
  const r=apply(code,tag,prepare);assert.ok(r.site.applied,r.site.why);prelude+=`namespace reference${i} { ${r.before} } namespace candidate${i} { ${r.after} }\n`;
 }
 let body='unsigned cases=0;';
 for(let i=0;i<cases.length;i++)body+=`for(unsigned x=0;x<65536;++x) { calls=0; int a=reference${i}::f(x); unsigned ca=calls; calls=0; int b=candidate${i}::f(x); if(a!=b || ca!=calls) return ${i+1}; ++cases; }\n`;
 body+='printf("%u\\n",cases);';assert.equal(compileAndRun(prelude,body,{optimize:true}).trim(),'262144');
});
