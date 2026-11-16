import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {singles} from './candidates.js';
function forms(text:string){
  const [result]=singles([{id:'f',text}],4);assert.equal(result.error,undefined);
  return result.candidates.filter(c=>c.form.startsWith('initbefore('));
}
describe('private buffer initialization candidates',()=>{
  it('emits the exact tag/body for the measured adjacent ordering',()=>{
    const result=forms('void f(){ char buf[8]; memset(buf,0,8*sizeof(buf[0])); int32_t n=0; use(buf,&n); }');
    assert.deepEqual(result.map(r=>r.form),['initbefore(n,buf)']);
    assert.match(result[0].text,/int32_t n = 0;\s*memset/);
  });
  it('offers no constructor, volatile, partial-clear or escaped-buffer candidate',()=>{
    for(const text of[
      'void f(){char buf[8]; memset(buf,0,8); T n=0; use(buf,&n);}',
      'void f(){char buf[8]; memset(buf,0,8); volatile int n=0; use(buf,&n);}',
      'void f(){char buf[8]; memset(buf,0,7); int n=0; use(buf,&n);}',
      'void f(){char buf[8]; publish(buf); memset(buf,0,8); int n=0; use(buf,&n);}',
    ])assert.deepEqual(forms(text),[]);
  });
  it('does not offer an already ordered initialization',()=>{
    assert.deepEqual(forms('void f(){char buf[8]; int n=0; memset(buf,0,8); use(buf,&n); }'),[]);
  });
});
