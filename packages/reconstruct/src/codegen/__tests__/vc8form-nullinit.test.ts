import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generateFunctionImplementation,getParseErrorCount} from '../impl.js';

it('applies nullinit through production codegen before the lock, keeping the protected read after it',()=>{
  const f=JSON.parse(readFileSync(new URL('./fixtures/nullinit-client-count.json',import.meta.url),'utf8'));
  const context=()=>({targetPointerSize:4,targetLanguageId:'x86:LE:32:default',funcPtrArgCasts:f.tables});
  const errors=getParseErrorCount();
  const before=generateFunctionImplementation(f.fn,undefined,f.options,context());
  const after=generateFunctionImplementation({...f.fn,tags:[...(f.fn.tags??[]),{type:'vc8form',data:f.tag}]},undefined,f.options,context());
  assert.equal(getParseErrorCount(),errors);assert.equal(before,f.baseline);assert.equal(after,f.candidate);
  const init=after.indexOf('nToken ='),enter=after.indexOf('EnterCriticalSection('),read=after.indexOf('gaQServerGameByToken[');
  assert.ok(init>=0&&enter>init&&read>enter);assert.ok(before.indexOf('nToken =')>before.indexOf('EnterCriticalSection('));
});
