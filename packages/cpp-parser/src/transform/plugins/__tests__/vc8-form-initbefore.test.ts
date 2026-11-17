import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../../../parser/index.js';
import {emit} from '../../../emit/index.js';
import type {AnyNode,TranslationUnit} from '../../../ast/nodes.js';
import {applyVc8Forms,parseVc8Form,type Vc8FormSite,type Vc8FormTables} from '../builtins/vc8-form.js';
const flat=(s:string)=>s.replace(/\s+/g,' ').trim();
function run(source:string,tables?:Vc8FormTables){
  const form=parseVc8Form('initbefore(n,buf)');assert.ok(form);
  const tree=parse(source) as TranslationUnit,sites:Vc8FormSite[]=[];
  const before=flat(emit(tree as AnyNode));
  const out=flat(emit(applyVc8Forms(tree,[{form}],s=>sites.push(s),tables) as AnyNode));
  return {before,out,site:sites[0]};
}
const source=(body:string)=>`void f(){ ${body} use(buf,&n); }`;
describe('private zero initialization before an adjacent buffer clear',()=>{
  it('parses two distinct local identifiers only',()=>{
    assert.deepEqual(parseVc8Form('initbefore(n,buf)'),{op:'initbefore',name:'n',array:'buf'});
    for(const s of ['initbefore()','initbefore(n)','initbefore(n,n)','initbefore(n,p->buf)','initbefore(n,buf,@1)','initbefore(return,buf)'])assert.equal(parseVc8Form(s),undefined);
  });
  for(const count of ['8','0x8','sizeof(buf)','8 * sizeof(buf[0])'])it(`moves a private zero before a whole clear: ${count}`,()=>{
    const r=run(source(`char buf[8]; memset(buf,0,${count}); int32_t n=0;`));
    assert.equal(r.site.applied,true);assert.match(r.out,/char buf\[8\]; int32_t n = 0; memset/);
  });
  for(const type of ['int','unsigned int','signed int','uint32_t'])it(`accepts primitive zero type ${type}`,()=>{
    assert.equal(run(source(`char buf[8]; memset(buf,0,8); ${type} n=0;`)).site.applied,true);
  });
  const refusals:[string,string][]=[
    ['nonzero','char buf[8]; memset(buf,0,8); int n=1;'],
    ['effectful initializer','char buf[8]; memset(buf,0,8); int n=next();'],
    ['unknown type','char buf[8]; memset(buf,0,8); Widget n=0;'],
    ['volatile scalar','char buf[8]; memset(buf,0,8); volatile int n=0;'],
    ['const scalar','char buf[8]; memset(buf,0,8); const int n=0;'],
    ['static scalar','char buf[8]; memset(buf,0,8); static int n=0;'],
    ['reference','char buf[8]; memset(buf,0,8); int &n=zero;'],
    ['pointer','char buf[8]; memset(buf,0,8); int *n=0;'],
    ['nonzero clear','char buf[8]; memset(buf,1,8); int n=0;'],
    ['short clear','char buf[8]; memset(buf,0,7); int n=0;'],
    ['oversize clear','char buf[8]; memset(buf,0,9); int n=0;'],
    ['partial pointer','char buf[8]; memset(buf+1,0,7); int n=0;'],
    ['nonbyte array','int buf[8]; memset(buf,0,8); int n=0;'],
    ['volatile array','volatile char buf[8]; memset(buf,0,8); int n=0;'],
    ['static array','static char buf[8]; memset(buf,0,8); int n=0;'],
    ['initialized array','char buf[8]={0}; memset(buf,0,8); int n=0;'],
    ['dynamic extent','char buf[size]; memset(buf,0,8); int n=0;'],
    ['earlier escape','char buf[8]; publish(buf); memset(buf,0,8); int n=0;'],
    ['crossed statement','char buf[8]; memset(buf,0,8); observe(); int n=0;'],
    ['multideclaration','char buf[8]; memset(buf,0,8); int n=0,m=0;'],
    ['local alias','typedef Widget int32_t; char buf[8]; memset(buf,0,8); int32_t n=0;'],
    ['local class','struct Widget{}; char buf[8]; memset(buf,0,8); int n=0;'],
    ['goto','goto done; char buf[8]; memset(buf,0,8); int n=0; done:;'],
    ['label','char buf[8]; here: memset(buf,0,8); int n=0;'],
  ];
  for(const [name,body]of refusals)it(`refuses ${name} atomically`,()=>{
    const r=run(source(body));assert.equal(r.site.applied,false);assert.equal(r.out,r.before);
  });
  it('rejects an aggregate hidden behind an integer spelling',()=>{
    const r=run(source('char buf[8]; memset(buf,0,8); int32_t n=0;'),{structFields:{int32_t:{value:'int'}}});
    assert.equal(r.site.applied,false);assert.equal(r.out,r.before);
  });
  it('rejects an alias with a volatile binding',()=>{
    const r=run(source('char buf[8]; memset(buf,0,8); int32_t n=0;'),{typedefTargets:{int32_t:'volatile int'}});
    assert.equal(r.site.applied,false);assert.equal(r.out,r.before);
  });
  it('rejects a shadowed scalar name',()=>{
    const r=run('void f(){ char buf[8]; memset(buf,0,8); int n=0; {int n=1;} use(buf,&n); }');
    assert.equal(r.site.applied,false);assert.equal(r.out,r.before);
  });
  it('does not move the initializer on a second application',()=>{
    const a=run(source('char buf[8]; memset(buf,0,8); int n=0;'));assert.equal(a.site.applied,true);
    const b=run(a.out);assert.equal(b.site.applied,false);assert.equal(b.out,a.out);
  });
  for(const prefix of ['struct int32_t{int32_t(int);};','typedef Widget int32_t;','template<class int32_t>'])
    it(`refuses an unproved outer type binding: ${prefix}`,()=>{
      const r=run(prefix+' '+source('char buf[8]; memset(buf,0,8); int32_t n=0;'));
      assert.equal(r.site.applied,false);assert.equal(r.out,r.before);
    });
});
