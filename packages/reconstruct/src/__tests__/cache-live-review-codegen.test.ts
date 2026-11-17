import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generateProject} from '../codegen/index.js';
import {cacheFunctions,cacheProject} from './fixtures/cache-live-review.js';

for(const fn of cacheFunctions)it(`preserves main's production output for live cache ${fn.address}`,()=>{
 // Pin the entire small generated project: a raw-body fallback used to inject
 // typedefs into its header and change unrelated code in the owning TU.
 const expected=JSON.parse(readFileSync(new URL(`./fixtures/cache-live-main-${fn.address}.json`,import.meta.url),'utf8'));
 const actual=cacheProject(generateProject,fn);
 assert.deepEqual(actual,expected);
 const body=actual.filter(f=>f.type==='implementation').map(f=>f.content).join('\n');
 assert.doesNotMatch(body,/UNPARSED/);
 if(fn.address==='005019c0'){
  assert.match(body,/uint16_t t2_c0 = \*szBuffer;/);
  assert.match(body,/if \(t2_c0 == L'\\n'\)/);
  assert.match(body,/szBuffer\+\+;/);
 }
});
